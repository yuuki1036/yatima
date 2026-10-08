import type { SupabaseClient } from "@supabase/supabase-js";
import type { Annotation } from "./types";
import { MODEL } from "./haiku";
import {
  errorText,
  splitSettle,
  type SettleEntry,
  type SettleFailure,
} from "./failure-attribution";
import {
  STALE_LEDGER_HOURS,
  SUMMARIZE_PER_FEED,
  utcDayStartIso,
  type SummaryUsage,
} from "./summarize-policy";

// 要約の台帳（llm_batches）・予約（articles.summary_reserved_until）・記事への書き込みの持ち主（YAT-79）。
//
// 同期の annotateMissing と Batches の submit / collect は、どちらも「ラウンド」を開いて閉じる:
//   open:  claim（選抜と予約）→ 台帳 insert（LLM / create の前・fail-closed）→ 対象行の取得
//   apply: 成功した記事にタグ → 要約の順で書き、同じ update で予約を外す
//   close: 失敗を証人ゲートで分けて settle し、台帳を終端する
// 違いは「同じ run で閉じるか（同期）、後の run の collect で閉じるか（Batches）」だけなので、
// 台帳の状態・selection の中身・lease の所有者チェック・書き込み順はこのファイルの外に出さない。

export type RoundRow = { id: string; title: string | null; content_html: string | null };

export type LedgerMode = "sync" | "batch";

/** 開いたラウンド。leaseDeadline は claim RPC が返した文字列のまま持つ（settle の所有者チェックに使う）。 */
export type SummaryRound = { ledgerId: string; ids: string[]; leaseDeadline: string };

// settle_summary_attempts に予約解除／帰責を投げる。失敗しても lease 満了で自然復帰する。
// この関数自体は warn を出さない（本線は closeSummaryRound が settleError で可視化し、open の
// 失敗経路は上流の障害フラグで可視化されるので、ここで二重に鳴らさない）。
async function settleAttempts(
  supabase: SupabaseClient,
  charged: SettleEntry[],
  released: SettleEntry[],
  leaseDeadline: string,
): Promise<{ ok: true; charged: number; released: number } | { ok: false; error: string }> {
  if (charged.length + released.length === 0) {
    return { ok: true, charged: 0, released: 0 };
  }
  try {
    const { data, error } = await supabase.rpc("settle_summary_attempts", {
      charged,
      released,
      lease_deadline: leaseDeadline,
    });
    if (error) throw error;
    const settled = (data ?? { charged: 0, released: 0 }) as {
      charged: number;
      released: number;
    };
    return { ok: true, charged: settled.charged, released: settled.released };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

// ── 当日の消費 ─────────────────────────────────────────────────────────────

// 台帳の行を同期と Batches に分けて数える。selection.mode === "batch" の行だけが Batches。
// mode を持たない行（同期・YAT-79 以前の行）は同期として数える。status は問わない（投入基準）。
export function tallyUsage(
  rows: { request_count: number | null; selection: unknown }[],
): SummaryUsage {
  let total = 0;
  let batch = 0;
  for (const r of rows) {
    const n = r.request_count ?? 0;
    total += n;
    const sel = r.selection as { mode?: unknown } | null;
    if (sel && sel.mode === "batch") batch += n;
  }
  return { total, batch };
}

export async function readSummaryUsage(
  supabase: SupabaseClient,
  now: number = Date.now(),
): Promise<{ ok: true; usage: SummaryUsage } | { ok: false; error: unknown }> {
  try {
    const { data, error } = await supabase
      .from("llm_batches")
      .select("request_count, selection")
      .eq("purpose", "summarize")
      .gte("submitted_at", utcDayStartIso(now));
    if (error) throw error;
    return {
      ok: true,
      usage: tallyUsage(
        (data ?? []) as { request_count: number | null; selection: unknown }[],
      ),
    };
  } catch (e) {
    return { ok: false, error: e };
  }
}

// ── ラウンドを開く ─────────────────────────────────────────────────────────

// 台帳の selection。同期は YAT-78 の 5 キーのまま。Batches は collect（別 run）が予約を解くために
// lease_deadline と ids を持つ（summary_batch_id は index が無く引けないので、真実は selection に置く）。
export function buildSelection(
  mode: LedgerMode,
  claim: { pool: number; poolCapped: boolean; maxRows: number; ids: string[]; leaseDeadline: string },
  leaseHours: number,
): Record<string, unknown> {
  const base = {
    pool: claim.pool,
    pool_capped: claim.poolCapped,
    per_feed: SUMMARIZE_PER_FEED,
    max_rows: claim.maxRows,
    picked: claim.ids.length,
  };
  if (mode === "sync") return base;
  return {
    ...base,
    mode: "batch",
    lease_hours: leaseHours,
    lease_deadline: claim.leaseDeadline,
    ids: claim.ids,
  };
}

export type OpenRoundSpec = {
  mode: LedgerMode;
  runKind: "cron" | "manual";
  maxRows: number;
  leaseHours: number;
};

export type OpenRoundResult =
  | { kind: "opened"; pool: number; poolCapped: boolean; round: SummaryRound; rows: RoundRow[] }
  /** 予約 0 件。pool > 0 なら選抜の全閉（isSelectionDead が拾う）、pool = 0 は対象ゼロ＝正常。 */
  | { kind: "empty"; pool: number; poolCapped: boolean }
  | { kind: "claim_failed"; error: string }
  /** 台帳 insert の失敗。予約は解放済み、LLM / create は呼んでいない。 */
  | { kind: "ledger_failed"; pool: number; poolCapped: boolean; selected: number; error: string }
  /** 対象行の取得失敗。予約は解放済み、台帳も終端済み。 */
  | { kind: "fetch_failed"; pool: number; poolCapped: boolean; selected: number; error: string };

export async function openSummaryRound(
  supabase: SupabaseClient,
  spec: OpenRoundSpec,
): Promise<OpenRoundResult> {
  // [1] claim（選抜と予約の原子実行・feed ラウンドロビン）。credibility はタイブレークで、
  // 並べ替えは RPC 側が担う。lease_hours は同期 30h（0017 の既定と同じ値）・Batches 36h。
  let pool = 0;
  let poolCapped = false;
  let ids: string[] = [];
  let leaseDeadline: string;
  try {
    const { data, error } = await supabase.rpc("claim_summary_candidates", {
      per_feed: SUMMARIZE_PER_FEED,
      max_rows: spec.maxRows,
      lease_hours: spec.leaseHours,
    });
    if (error) throw error;
    const claim = (data ?? {}) as {
      pool?: number;
      pool_capped?: boolean;
      ids?: string[];
      lease_deadline?: string;
    };
    pool = claim.pool ?? 0;
    poolCapped = claim.pool_capped === true;
    ids = claim.ids ?? [];
    leaseDeadline = claim.lease_deadline ?? "";
  } catch (e) {
    const msg = errorText(e);
    console.warn("要約候補の claim に失敗:", msg);
    return { kind: "claim_failed", error: msg };
  }
  if (ids.length === 0) return { kind: "empty", pool, poolCapped };

  // [2] 台帳 insert（**LLM / create を呼ぶ前・fail-closed の要**）。後に置くと insert 失敗時に
  // 「課金したのに request_count が残らない」→ 翌 run が同枠を使い日次上限が実質無効化される。
  // insert が落ちたら全 ids を released で解放して返す（呼び出し側が赤くする）。
  let ledgerId: string;
  try {
    const { data, error } = await supabase
      .from("llm_batches")
      .insert({
        purpose: "summarize",
        batch_id: null,
        status: "claimed",
        model: MODEL,
        request_count: ids.length,
        run_kind: spec.runKind,
        selection: buildSelection(
          spec.mode,
          { pool, poolCapped, maxRows: spec.maxRows, ids, leaseDeadline },
          spec.leaseHours,
        ),
      })
      .select("id")
      .single();
    if (error) throw error;
    ledgerId = (data as { id: string }).id;
  } catch (e) {
    const msg = errorText(e);
    console.error(
      "要約台帳（llm_batches）の記録に失敗。LLM を呼ばず予約を解放して赤くする:",
      msg,
    );
    const released = ids.map((id) => ({ id, error: "ledger_insert_failed" }));
    await settleAttempts(supabase, [], released, leaseDeadline);
    return { kind: "ledger_failed", pool, poolCapped, selected: ids.length, error: msg };
  }

  // [3] 対象行の取得（ids <= 20 なので .in() の URL 長は安全）。
  try {
    const { data, error } = await supabase
      .from("articles")
      .select("id, title, content_html")
      .in("id", ids);
    if (error) throw error;
    return {
      kind: "opened",
      pool,
      poolCapped,
      round: { ledgerId, ids, leaseDeadline },
      rows: (data ?? []) as RoundRow[],
    };
  } catch (e) {
    const msg = errorText(e);
    console.warn("要約対象の取得に失敗（予約を解放）:", msg);
    const released = ids.map((id) => ({ id, error: "fetch_failed" }));
    await settleAttempts(supabase, [], released, leaseDeadline);
    await closeLedger(supabase, ledgerId, {
      succeeded: 0,
      errored: 0,
      applied: 0,
      lastError: msg,
    });
    return { kind: "fetch_failed", pool, poolCapped, selected: ids.length, error: msg };
  }
}

// ── 記事への書き込み ─────────────────────────────────────────────────────────

// タグ upsert（先）→ summary 更新（後）。要約が埋まった記事は必ずタグも持つ（途中失敗時は
// summary NULL のまま予約が解放され、次のラウンドで再収束する）。逆順だと要約だけ書けた記事が
// findUntaggedSummarized の母集団に流れ込む。成功記事の予約解除は summary と同じ 1 回の update で
// 行う（settle に回すと summary_reserved_until=null を書いた後の行に所有者チェックが効かず 0 件更新に
// なる）。summarized_at は着地の観測台帳（YAT-74）。失敗は throw（呼び出し側が帰責する）。
export async function applyAnnotation(
  supabase: SupabaseClient,
  articleId: string,
  a: Annotation,
): Promise<void> {
  if (a.tags.length) {
    const tagRows = a.tags.map((t) => ({
      article_id: articleId,
      tag_slug: t,
      source: "llm",
    }));
    const { error: tagErr } = await supabase
      .from("article_tags")
      .upsert(tagRows, {
        onConflict: "article_id,tag_slug",
        ignoreDuplicates: true,
      });
    if (tagErr) throw tagErr;
  }
  const { error: upErr } = await supabase
    .from("articles")
    .update({
      summary: a.summary,
      summarized_at: new Date().toISOString(),
      summary_reserved_until: null,
      summary_batch_id: null,
    })
    .eq("id", articleId);
  if (upErr) throw upErr;
}

// ── ラウンドを閉じる ─────────────────────────────────────────────────────────

export type LedgerTally = {
  succeeded: number;
  errored: number;
  applied: number;
  lastError: string | null;
  /** 以下は Batches の結果だけが持つ。省略した列は update に載せない。 */
  expired?: number;
  canceled?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** バッチの ended_at。省略時は今。 */
  endedAt?: string | null;
};

// 台帳を collected に終端する update。同期は YAT-78 の 7 キーのまま。
export function buildClosePatch(t: LedgerTally, nowIso: string): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    status: "collected",
    succeeded: t.succeeded,
    errored: t.errored,
    applied: t.applied,
    ended_at: t.endedAt ?? nowIso,
    collected_at: nowIso,
    last_error: t.lastError,
  };
  if (t.expired !== undefined) patch.expired = t.expired;
  if (t.canceled !== undefined) patch.canceled = t.canceled;
  if (t.inputTokens !== undefined) patch.input_tokens = t.inputTokens;
  if (t.outputTokens !== undefined) patch.output_tokens = t.outputTokens;
  return patch;
}

// 台帳行を終端する（fail-soft・warn のみ）。成功を返すのは、Batches の collect が「終端できなかった
// 行は次 run で回収し直す」と判断するため（同期は戻り値を見ない）。
async function closeLedger(
  supabase: SupabaseClient,
  id: string,
  t: LedgerTally,
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from("llm_batches")
      .update(buildClosePatch(t, new Date().toISOString()))
      .eq("id", id);
    if (error) throw error;
    return true;
  } catch (e) {
    console.warn("要約台帳（llm_batches）の終端に失敗:", errorText(e));
    return false;
  }
}

export type RoundOutcome = {
  /** 記事に書けた件数（証人の数）。 */
  applied: number;
  /** 帰責の対象（LLM・DB のどちらで落ちたかは問わない）。 */
  failures: SettleFailure[];
  /** 証人に関係なく予約を外すだけのもの（Batches の expired / canceled / archived）。 */
  releases?: SettleEntry[];
  /** 台帳に書く集計。lastError は settle が失敗すればそちらで上書きする。 */
  ledger: LedgerTally;
};

export type CloseRoundResult = {
  /** 課金・解放を要求した件数（反映件数ではない）。 */
  charged: number;
  released: number;
  settleError: string | null;
  ledgerClosed: boolean;
};

export async function closeSummaryRound(
  supabase: SupabaseClient,
  round: SummaryRound,
  o: RoundOutcome,
): Promise<CloseRoundResult> {
  // 帰責の分割（ラウンド単位の証人ゲート・ADR-20260906205227）。1 件でも書けていれば witness=true で、
  // chargeable な失敗だけ summary_attempts +1。全滅ラウンドは誰の責任にもしない。
  const split = splitSettle(o.failures, o.applied > 0);
  const charged = split.charged;
  const released = [...split.released, ...(o.releases ?? [])];

  // settle の失敗は settleError に残して呼び出し側が exit 1（黙って落ちると予約が残る＝別の静かな死）。
  // 反映件数が要求と違えば予約失効を warn。
  let settleError: string | null = null;
  const settled = await settleAttempts(supabase, charged, released, round.leaseDeadline);
  if (!settled.ok) {
    settleError = settled.error;
    console.error("settle_summary_attempts に失敗（予約が残る）:", settleError);
  } else if (
    settled.charged !== charged.length ||
    settled.released !== released.length
  ) {
    console.warn(
      `settle の反映件数が要求と不一致（予約が失効し他 run に取られた可能性）: ` +
        `要求 charged ${charged.length}/released ${released.length}、` +
        `反映 charged ${settled.charged}/released ${settled.released}`,
    );
  }

  const ledgerClosed = await closeLedger(supabase, round.ledgerId, {
    ...o.ledger,
    lastError: settleError ?? o.ledger.lastError,
  });
  return { charged: charged.length, released: released.length, settleError, ledgerClosed };
}

// ── Batches のラウンド（YAT-79）─────────────────────────────────────────────
//
// 台帳の status 遷移（Batches の行）:
//   claimed ─create 成功→ submitted ─回収→ collected
//      │                    └─retrieve/results 失敗→ unresolved ─回収→ collected
//      ├─create 失敗→ expired_unknown（予約はその場で解放）
//      └─batch_id の記録失敗（孤児）─36h→ expired_unknown（resolveStaleLedger）
// submitted / unresolved が 36h を超えて回収されないのは batchStuck の担当（自動では諦めない）。

/** Batches の未回収ラウンド（collect が 1 run で見る上限）。未回収は inflight_cap で 12 本に抑える。 */
export const OPEN_ROUNDS_LIMIT = 24;

// collect（別 run）がラウンドを閉じるのに要る情報を selection から読む。
export function parseRoundSelection(
  sel: unknown,
): { ok: true; ids: string[]; leaseDeadline: string } | { ok: false; error: string } {
  if (!sel || typeof sel !== "object") return { ok: false, error: "selection が無い" };
  const s = sel as { mode?: unknown; ids?: unknown; lease_deadline?: unknown };
  if (s.mode !== "batch") return { ok: false, error: "Batches の行ではない" };
  if (!Array.isArray(s.ids) || s.ids.length === 0 || !s.ids.every((x) => typeof x === "string")) {
    return { ok: false, error: "selection.ids が読めない" };
  }
  if (typeof s.lease_deadline !== "string" || s.lease_deadline === "") {
    return { ok: false, error: "selection.lease_deadline が読めない" };
  }
  return { ok: true, ids: s.ids as string[], leaseDeadline: s.lease_deadline };
}

// batches.create の結果を台帳に書く。
// 成功: batch_id と submitted。書けなければ孤児（batch_id を知っているのはこの run のメモリだけ）。
// 失敗: batch_id が分からない以上、裏でバッチができていても結果は回収できない。予約を持っていても
//   記事が遅れるだけなので、その場で解放して expired_unknown で終端する（二重課金 1 回分は受容・
//   design doc open 13）。この失敗経路自身の失敗は warn のみ（呼び出し側が submitDead で赤くする）。
export async function recordBatchCreate(
  supabase: SupabaseClient,
  round: SummaryRound,
  created: { ok: true; batchId: string } | { ok: false; error: string },
): Promise<{ ledgerWriteError: string | null }> {
  if (created.ok) {
    try {
      const { error } = await supabase
        .from("llm_batches")
        .update({ batch_id: created.batchId, status: "submitted" })
        .eq("id", round.ledgerId)
        .eq("status", "claimed");
      if (error) throw error;
      return { ledgerWriteError: null };
    } catch (e) {
      return { ledgerWriteError: errorText(e) };
    }
  }

  const released = round.ids.map((id) => ({
    id,
    error: `batch_create_failed: ${created.error}`,
  }));
  const settled = await settleAttempts(supabase, [], released, round.leaseDeadline);
  if (!settled.ok) {
    console.warn("バッチ作成失敗後の予約解放に失敗（36h で失効する）:", settled.error);
  }
  try {
    const { error } = await supabase
      .from("llm_batches")
      .update({
        status: "expired_unknown",
        resolved_at: new Date().toISOString(),
        last_error: `create_failed: ${created.error}`,
      })
      .eq("id", round.ledgerId);
    if (error) throw error;
  } catch (e) {
    console.warn("バッチ作成失敗の台帳終端に失敗（36h 後に掃除される）:", errorText(e));
  }
  return { ledgerWriteError: null };
}

export type OpenBatchRound = { round: SummaryRound; batchId: string; submittedAt: string };

// 回収を待っている Batches のラウンド（submitted / unresolved）。古い順。selection が読めない行は
// malformed として返す（呼び出し側が unresolved にして、36h で batchStuck が赤くする）。
export async function listOpenBatchRounds(
  supabase: SupabaseClient,
): Promise<
  | { ok: true; rounds: OpenBatchRound[]; malformed: { ledgerId: string; error: string }[] }
  | { ok: false; error: string }
> {
  try {
    const { data, error } = await supabase
      .from("llm_batches")
      .select("id, batch_id, submitted_at, selection")
      .eq("purpose", "summarize")
      .is("collected_at", null)
      .in("status", ["submitted", "unresolved"])
      .order("submitted_at", { ascending: true })
      .limit(OPEN_ROUNDS_LIMIT);
    if (error) throw error;
    const rounds: OpenBatchRound[] = [];
    const malformed: { ledgerId: string; error: string }[] = [];
    for (const r of (data ?? []) as {
      id: string;
      batch_id: string | null;
      submitted_at: string;
      selection: unknown;
    }[]) {
      const sel = parseRoundSelection(r.selection);
      if (!r.batch_id) {
        malformed.push({ ledgerId: r.id, error: "batch_id が無い" });
      } else if (!sel.ok) {
        malformed.push({ ledgerId: r.id, error: sel.error });
      } else {
        rounds.push({
          round: { ledgerId: r.id, ids: sel.ids, leaseDeadline: sel.leaseDeadline },
          batchId: r.batch_id,
          submittedAt: r.submitted_at,
        });
      }
    }
    return { ok: true, rounds, malformed };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

// 回収を試みたが閉じられなかった（retrieve / results の失敗・selection 不正）。次 run で再試行する。
// 書けなくても submitted のまま残って次 run で再試行されるので warn のみ。
export async function markRoundUnresolved(
  supabase: SupabaseClient,
  ledgerId: string,
  error: string,
): Promise<void> {
  try {
    const { error: upErr } = await supabase
      .from("llm_batches")
      .update({ status: "unresolved", last_error: error })
      .eq("id", ledgerId);
    if (upErr) throw upErr;
  } catch (e) {
    console.warn(`要約台帳を unresolved にできなかった [${ledgerId}]:`, errorText(e));
  }
}

// 未回収の Batches ラウンドの本数と最古の submitted_at（inflight_cap と batchStuck の材料）。
export async function readBatchBacklog(
  supabase: SupabaseClient,
): Promise<{ ok: true; open: number; oldestSubmittedAt: string | null } | { ok: false; error: string }> {
  try {
    const { data, error, count } = await supabase
      .from("llm_batches")
      .select("submitted_at", { count: "exact" })
      .eq("purpose", "summarize")
      .is("collected_at", null)
      .in("status", ["submitted", "unresolved"])
      .order("submitted_at", { ascending: true })
      .limit(1);
    if (error) throw error;
    const rows = (data ?? []) as { submitted_at: string }[];
    return { ok: true, open: count ?? rows.length, oldestSubmittedAt: rows[0]?.submitted_at ?? null };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

/** resolveStaleLedger が 1 run で終端する上限。 */
const STALE_RESOLVE_LIMIT = 50;

// claimed のまま 36h を超えた行を expired_unknown で終端する（YAT-79）。対象は、create の手前で
// 落ちた run・batch_id の記録に失敗した孤児・途中で落ちた同期 run。予約は lease で既に失効しているが、
// selection に ids があれば痕跡（summary_last_error）を書いて解放する（所有者チェックで他 run の
// 予約は触らない）。unresolved は対象外: batch_id を持つ回収待ちで、batchStuck の担当。
export async function resolveStaleLedger(
  supabase: SupabaseClient,
  now: number = Date.now(),
): Promise<{ resolved: { ledgerId: string; isBatch: boolean }[]; error: string | null }> {
  const cutoff = new Date(now - STALE_LEDGER_HOURS * 3_600_000).toISOString();
  let rows: { id: string; selection: unknown }[];
  try {
    const { data, error } = await supabase
      .from("llm_batches")
      .select("id, selection")
      .eq("purpose", "summarize")
      .eq("status", "claimed")
      .is("collected_at", null)
      .lt("submitted_at", cutoff)
      .order("submitted_at", { ascending: true })
      .limit(STALE_RESOLVE_LIMIT);
    if (error) throw error;
    rows = (data ?? []) as { id: string; selection: unknown }[];
  } catch (e) {
    return { resolved: [], error: errorText(e) };
  }
  if (rows.length === 0) return { resolved: [], error: null };

  const resolved: { ledgerId: string; isBatch: boolean }[] = [];
  for (const r of rows) {
    const sel = parseRoundSelection(r.selection);
    if (sel.ok) {
      const released = sel.ids.map((id) => ({ id, error: "stale_claimed" }));
      const settled = await settleAttempts(supabase, [], released, sel.leaseDeadline);
      if (!settled.ok) console.warn(`孤児の予約解放に失敗 [${r.id}]:`, settled.error);
    }
    resolved.push({ ledgerId: r.id, isBatch: sel.ok });
  }
  try {
    const { error } = await supabase
      .from("llm_batches")
      .update({
        status: "expired_unknown",
        resolved_at: new Date(now).toISOString(),
        last_error: "stale_claimed",
      })
      .in(
        "id",
        rows.map((r) => r.id),
      )
      .eq("status", "claimed");
    if (error) throw error;
  } catch (e) {
    return { resolved, error: errorText(e) };
  }
  return { resolved, error: null };
}
