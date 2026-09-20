import type { SupabaseClient } from "@supabase/supabase-js";
import type { Summarizer } from "./types";
import { createHaikuSummarizer, MODEL } from "./haiku";
import { htmlToInputText } from "./extract-text";
import { enrichArticleBody, isThinBody } from "@/lib/rss/enrich";
import {
  splitSettle,
  errorText,
  type SettleFailure,
  type SettleEntry,
} from "./failure-attribution";

// 取得→保存の後に呼ぶバッチ要約。ingestAllFeeds と同じく SupabaseClient を注入して使う。
// summary IS NULL の記事を拾って要約し、articles.summary を埋める。
// 設計方針: fail-soft。例外は一切外へ漏らさず集計に畳む（要約由来で ingest を止めない）。

export type SummarizeBatchResult = {
  picked: number; // summary IS NULL から取得した件数
  succeeded: number;
  failed: number;
  skipped: boolean; // API キー未設定でスキップした場合 true
};

type Row = { id: string; title: string | null; content_html: string | null };

const DEFAULT_LIMIT = 20; // 1 回の実行で要約する上限（コスト暴走を防ぐ。残りは次回消化）

// 1 UTC 日あたりの要約上限（YAT-74 → YAT-78）。**run をまたぐ唯一の支出天井。**
//
// DEFAULT_LIMIT は 1 run の上限でしかなく、日次の消費は cron の発火回数に比例する。
// その発火回数は GitHub Actions の best-effort スケジューリングで実測 2〜23 回/日 と
// 10 倍振れるため、日次消費は制御できていなかった（2026-08-19 のクレジット枯渇の直接原因）。
//
// YAT-78 で 300 → 120 に絞る（月 $20 → 約 $8）。**率でなく実数で置く**（率だと絞り込みの
// ノブを回すたびに閾値も動く）。下流の必要量から引く: デッキ 10 件/日 × 72h 窓 = 360 件が
// 常時候補にいればよく、feed RR で 120 件/日 でも流入 3.75/日 未満の feed は実質 100% 要約される。
// 判定は articles.summarized_at（着地）でなく llm_batches の当日 request_count 合計（投入基準）。
// 非同期化（YAT-79）で投入と着地が正当に乖離するため、上限は投入で数える（着地を待つと
// submit を止められない）。summarized_at は着地の観測として残し、乖離＝未回収量として監視する。
export const DAILY_SUMMARIZE_CAP = 120;

// claim_summary_candidates の per_feed。1 run で 1 feed から取る上限（rn 昇順の RR の粒度）。
// 120 ÷ 32 feed ≒ 3.75 の切り上げ。バックログを持つ feed が 5 本未満のときだけ run 枠が余るが、
// それはバックログがほぼ捌けた状態。dev.to（流入の 35%）を日次 4 件/日 に抑える効果もここ。
export const SUMMARIZE_PER_FEED = 4;

// 記事固有の失敗の隔離閾値（0017 の claim RPC 既定 max_attempts と同値）。unquarantine と
// 隔離増加ガードが読む。**claim 時には増やさない**（証人ゲート・ADR-20260906205227）。
export const SUMMARY_MAX_ATTEMPTS = 3;

// 隔離増加ガードの観測窓（YAT-78）。summary_attempts が閾値に達した時刻 = 最後の失敗時刻。
export const QUARANTINE_WINDOW_HOURS = 24;

const DEFAULT_CONCURRENCY = 5; // 同時並列数（レート制限に配慮）

export async function summarizeMissing(
  supabase: SupabaseClient,
  opts: {
    limit?: number;
    concurrency?: number;
    summarizer?: Summarizer | null;
  } = {},
): Promise<SummarizeBatchResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  // opts.summarizer を明示指定（null 含む）した場合はそれを尊重。未指定なら Haiku を生成。
  const summarizer =
    opts.summarizer !== undefined ? opts.summarizer : createHaikuSummarizer();

  // API キー未設定 → 要約スキップ（ingest は成功扱い）
  if (!summarizer) {
    return { picked: 0, succeeded: 0, failed: 0, skipped: true };
  }

  let rows: Row[] = [];
  try {
    const { data, error } = await supabase
      .from("articles")
      .select("id, title, content_html")
      .is("summary", null)
      .not("content_html", "is", null)
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    rows = (data ?? []) as Row[];
  } catch (e) {
    // select 失敗も握りつぶす（fail-soft）。原因だけは残して調査可能にする。
    console.warn("要約対象の取得に失敗:", e);
    return { picked: 0, succeeded: 0, failed: 0, skipped: false };
  }

  let succeeded = 0;
  let failed = 0;

  // limit 件を concurrency ずつ Promise.allSettled で回す軽量プール
  for (let i = 0; i < rows.length; i += concurrency) {
    const chunk = rows.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map(async (row) => {
        const text = htmlToInputText(row.content_html);
        // 本文がタグのみ等で整形後に空でも、タイトルがあれば要約する。
        // 両方空の記事を failed で NULL のまま残すと、毎回 published_at 降順の
        // 先頭枠に再ピックされ後続が処理されなくなるため、ここで救済する。
        if (!text && !row.title) throw new Error("本文・タイトルとも空");
        const summary = await summarizer.summarize({ title: row.title, text });
        if (!summary) throw new Error("要約が空"); // 空要約は保存せず NULL のまま再試行に回す
        const { error } = await supabase
          .from("articles")
          .update({ summary })
          .eq("id", row.id);
        if (error) throw error;
      }),
    );
    results.forEach((r, idx) => {
      if (r.status === "fulfilled") {
        succeeded += 1;
      } else {
        failed += 1;
        // fail-soft は維持しつつ失敗理由を残す（API エラー / 空 / DB エラーの切り分け用）
        console.warn(`要約失敗 [${chunk[idx].id}]:`, r.reason);
      }
    });
  }

  return { picked: rows.length, succeeded, failed, skipped: false };
}

// YAT-13: 要約はあるがタグが空の記事を拾って再アノテートする保守用ロジック。
// annotateMissing は summary IS NULL のみ拾うため、過去に annotate の JSON パース失敗で
// 「要約のみ・タグ空」に落ちた記事（YAT-5 の取りこぼし）はそのまま残る。タグが無い記事は
// 興味順スコアに乗らないので、ここでピンポイントに再アノテートしてタグを補う。
//
// **台帳・日次上限の対象外（YAT-78・design doc open 8 の (b)）。** annotateUntagged は手動
// `npm run retag` からのみ呼ばれ（cron からは呼ばれない）、summary IS NOT NULL が対象で
// claim_summary_candidates（summary IS NULL 前提）も通らない別経路。annotate() で課金は
// 発生するが、手動・低頻度で月額寄与はほぼゼロなので llm_batches には記録せず DAILY_SUMMARIZE_CAP
// も消費しない。「llm_batches が唯一の支出台帳」の唯一の例外＝retag の再アノテート。
export type UntaggedRow = {
  id: string;
  title: string | null;
  url: string | null;
  content_html: string | null;
};

const SCAN_PAGE = 1000; // 要約済み記事をページ走査する 1 ページのサイズ（PostgREST 既定上限）

// 要約済み（summary IS NOT NULL）かつタグが 1 件も無い記事を返す。article_tags を埋め込み
// select し JS 側で「子が空」の行に絞る。要約済みは数千件規模になりうるため .range() で全件を
// ページ走査する（単一 limit だと古いタグ空記事を取り逃す）。
export async function findUntaggedSummarized(
  supabase: SupabaseClient,
): Promise<UntaggedRow[]> {
  const out: UntaggedRow[] = [];
  for (let from = 0; ; from += SCAN_PAGE) {
    const { data, error } = await supabase
      .from("articles")
      .select("id, title, url, content_html, article_tags(tag_slug)")
      .not("summary", "is", null)
      .order("published_at", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true }) // 同 published_at の全順序を確定しページ境界の取りこぼし/重複を防ぐ
      .range(from, from + SCAN_PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as (UntaggedRow & {
      article_tags: { tag_slug: string }[] | null;
    })[];
    for (const r of batch) {
      if ((r.article_tags ?? []).length === 0) {
        out.push({
          id: r.id,
          title: r.title,
          url: r.url,
          content_html: r.content_html,
        });
      }
    }
    if (batch.length < SCAN_PAGE) break; // 最終ページ
  }
  return out;
}

export type RetagResult = {
  targeted: number; // タグ空で再アノテート対象になった件数
  enriched: number; // 本文補完できた件数
  tagged: number; // 再アノテートでタグを付与できた件数
  stillEmpty: number; // 再アノテートしてもタグ 0 のままだった件数
  failed: number; // 例外で落ちた件数（fail-soft）
  skipped: boolean; // API キー未設定でスキップした場合 true
};

export async function annotateUntagged(
  supabase: SupabaseClient,
  opts: {
    concurrency?: number;
    summarizer?: Summarizer | null;
    enrich?: boolean; // 本文が薄い記事をリンク先から補完してからアノテートする（既定 true）
  } = {},
): Promise<RetagResult> {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const enrich = opts.enrich ?? true;
  const summarizer =
    opts.summarizer !== undefined ? opts.summarizer : createHaikuSummarizer();

  if (!summarizer) {
    return {
      targeted: 0,
      enriched: 0,
      tagged: 0,
      stillEmpty: 0,
      failed: 0,
      skipped: true,
    };
  }

  let targets: UntaggedRow[];
  try {
    targets = await findUntaggedSummarized(supabase);
  } catch (e) {
    console.warn("再アノテート対象の取得に失敗:", e);
    return {
      targeted: 0,
      enriched: 0,
      tagged: 0,
      stillEmpty: 0,
      failed: 0,
      skipped: false,
    };
  }

  let enriched = 0;
  let tagged = 0;
  let stillEmpty = 0;
  let failed = 0;

  // 1 度きりの単一パス（内部で対象を再取得しない）。タグ 0 のまま残る記事を再ピックすると
  // 無限ループになるため、再アノテートしてもタグが付かなかった記事は stillEmpty として残置する。
  for (let i = 0; i < targets.length; i += concurrency) {
    const chunk = targets.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map(async (row) => {
        let content = row.content_html;
        // 本文が薄ければ先にリンク先から補完してタグ精度を上げる（fail-soft）。
        // パターン1（本文がタイトルのみ）由来のタグ空は YAT-7 の本文 fetch で救える。
        if (enrich && row.url && isThinBody(content)) {
          try {
            const r = await enrichArticleBody(supabase, {
              id: row.id,
              url: row.url,
              content_html: content,
            });
            // 差し替えなかった理由は捨てる: ここは要約バッチの一括処理で件数が読めず、
            // 薄いままの記事も要約は継続できるため（enrich 側と違いログに出すと溢れる）。
            if (r.ok) {
              content = r.content;
              enriched += 1;
            }
          } catch (e) {
            console.warn(
              `本文補完失敗 [${row.id}]:`,
              e instanceof Error ? e.message : e,
            );
          }
        }

        const text = htmlToInputText(content);
        if (!text && !row.title) throw new Error("本文・タイトルとも空");
        const { summary, tags } = await summarizer.annotate({
          title: row.title,
          text,
        });
        if (!summary) throw new Error("要約が空");

        // 本文を補完したときだけ要約も作り直す（薄い本文由来の古い要約を更新）。補完していなければ
        // 既存要約は温存しタグだけ付ける（既読の要約を不用意に書き換えない）。
        // 順序は要約 → タグ。findUntaggedSummarized は「タグ有り = 処理済み」とみなすため、
        // タグ付与で部分失敗（要約だけ更新）しても未タグのまま残り、次回再収束する（自己回復）。
        if (content !== row.content_html) {
          const { error: upErr } = await supabase
            .from("articles")
            .update({ summary })
            .eq("id", row.id);
          if (upErr) throw upErr;
        }
        if (tags.length) {
          const tagRows = tags.map((t) => ({
            article_id: row.id,
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
        return tags.length;
      }),
    );
    results.forEach((r, idx) => {
      if (r.status === "fulfilled") {
        if (r.value > 0) tagged += 1;
        else stillEmpty += 1;
      } else {
        failed += 1;
        console.warn(
          `再アノテート失敗 [${chunk[idx].id}] ${chunk[idx].url ?? ""}:`,
          r.reason,
        );
      }
    });
  }

  return {
    targeted: targets.length,
    enriched,
    tagged,
    stillEmpty,
    failed,
    skipped: false,
  };
}


// ── 要約の選抜・帰責を台帳経由に（YAT-78・段階 6）───────────────────────────────
//
// design doc `.claude/designs/20260906-llm-cost-batches-embed-decoupling.md`「要約の選抜規則（②）」
// 「失敗の帰責」、ADR-20260906205224（支出天井）/ 20260906205227（証人ゲート）に沿う。
// 変更点: (1) 選抜を credibility 順から feed ラウンドロビン（claim_summary_candidates RPC）へ
// (2) 日次上限を articles.summarized_at から llm_batches の当日 request_count 合計へ（投入基準）
// (3) 失敗の帰責を「同ラウンドの証人」で分け settle_summary_attempts で反映する。

/** 正常な抑制で要約を見送った理由。**障害はここに入れない**（capUnavailable / *Error は別フィールド）。 */
export type SummarizeSkipReason = "no_api_key" | "daily_capped";

type AnnotateBatchCounts = {
  /** claim が返した絞り込み前の母数。-1 は取得不能（判定不能・isSelectionDead を発火させない）。 */
  pool: number;
  /** claim で予約できた件数（= この run の llm_batches.request_count）。 */
  selected: number;
  succeeded: number;
  failed: number;
  /** 証人ゲートを通って summary_attempts +1 した件数。 */
  charged: number;
  /** 予約解除のみ（attempts 据え置き）の件数。 */
  released: number;
  /** 実行開始時点の当日投入数（台帳 request_count 合計。この run を含まない）。 */
  dailyUsed: number;
  dailyCap: number;
  /** claim RPC / 対象 select の失敗理由。null なら正常。isSelectionDead が読む。 */
  poolError: string | null;
  /** 台帳 insert の失敗（LLM 未実行・予約は解放済み）。呼び出し側は exit 1。 */
  ledgerError: string | null;
  /** settle RPC の失敗（予約が残る）。呼び出し側は exit 1。 */
  settleError: string | null;
  /** 台帳 read 自体の失敗（上限不明で見送り）。skip ではなく障害。呼び出し側は exit 1。 */
  capUnavailable: boolean;
};

// skip したなら理由が必ず要る（embed の EmbedBatchResult と同じ判別可能ユニオン）。
// daily_capped は毎日正常に起きるので、skipped で isSelectionDead から自動除外するのが要点。
export type AnnotateBatchResult =
  | (AnnotateBatchCounts & { skipped: true; skipReason: SummarizeSkipReason })
  | (AnnotateBatchCounts & { skipped: false; skipReason?: never });

// 全フィールド 0/null のベース。各 return はここから必要な列だけ上書きする。
const EMPTY_ANNOTATE_COUNTS: AnnotateBatchCounts = {
  pool: 0,
  selected: 0,
  succeeded: 0,
  failed: 0,
  charged: 0,
  released: 0,
  dailyUsed: 0,
  dailyCap: DAILY_SUMMARIZE_CAP,
  poolError: null,
  ledgerError: null,
  settleError: null,
  capUnavailable: false,
};

// 予約解除／帰責を settle_summary_attempts に投げる（fail-closed パスと本線で共用）。
// 失敗しても 30h の lease 満了で自然復帰する。本線（[7]）は戻り値の settleError を呼び出し側へ
// 返して exit 1 させる。fail-closed パス（台帳 insert 失敗 [3] / 対象取得失敗 [4]）は戻り値を
// **捨てる**（settle の成否は見ない）——それらの経路は既に ledgerError / poolError で赤くなり、
// 予約は lease 失効で解放されるため、ここでの失敗を二重に鳴らす必要がない。この関数自体は
// warn を出さない（本線は settleError で可視化、fail-closed は上流の障害フラグで可視化される）。
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

// 台帳行を終端する（fail-soft・warn のみ）。回収の成否は run を落とさない。
async function collectLedger(
  supabase: SupabaseClient,
  id: string,
  r: { succeeded: number; errored: number; applied: number; lastError: string | null },
): Promise<void> {
  try {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("llm_batches")
      .update({
        status: "collected",
        succeeded: r.succeeded,
        errored: r.errored,
        applied: r.applied,
        ended_at: now,
        collected_at: now,
        last_error: r.lastError,
      })
      .eq("id", id);
    if (error) throw error;
  } catch (e) {
    console.warn("要約台帳（llm_batches）の終端に失敗:", errorText(e));
  }
}

// Phase3 → YAT-78: 取得→保存の後に呼ぶバッチ「アノテート」。要約とタグを同時生成して保存する。
// summarizeMissing の上位互換（要約も埋める）。cron / refreshNow / resummarize から呼ぶ。
export async function annotateMissing(
  supabase: SupabaseClient,
  opts: {
    limit?: number;
    concurrency?: number;
    summarizer?: Summarizer | null;
    runKind?: "cron" | "manual";
  } = {},
): Promise<AnnotateBatchResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const runKind = opts.runKind ?? "cron";
  const summarizer =
    opts.summarizer !== undefined ? opts.summarizer : createHaikuSummarizer();

  // [0] API キー未設定 → 要約スキップ（ingest は成功扱い）。pool=0 だが skipped=true なので
  // isSelectionDead は自動的に不活性。
  if (!summarizer) {
    return { ...EMPTY_ANNOTATE_COUNTS, skipped: true, skipReason: "no_api_key" };
  }

  // [1] 日次の支出天井（YAT-74 → YAT-78）。判定を llm_batches の当日 request_count 合計に移す
  // （投入基準）。起点は UTC 0 時（cron が UTC 基準なので、ローカル時刻で切ると日境界が run の
  // 途中に来る）。台帳 read の失敗は「上限到達」ではなく障害。capUnavailable で返し、pool=-1 に
  // することで isSelectionDead の pool>0 を偽にする（0 に潰すと「絞り込み 0 件」と誤検知する）。
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  let dailyUsed = 0;
  try {
    const { data, error } = await supabase
      .from("llm_batches")
      .select("request_count")
      .eq("purpose", "summarize")
      .gte("submitted_at", dayStart.toISOString());
    if (error) throw error;
    dailyUsed = ((data ?? []) as { request_count: number | null }[]).reduce(
      (n, r) => n + (r.request_count ?? 0),
      0,
    );
  } catch (e) {
    console.warn(
      "日次要約数（llm_batches）の取得に失敗。上限が確認できないので要約を見送る:",
      e,
    );
    return { ...EMPTY_ANNOTATE_COUNTS, skipped: false, pool: -1, capUnavailable: true };
  }
  const remaining = Math.max(0, DAILY_SUMMARIZE_CAP - dailyUsed);
  if (remaining === 0) {
    return {
      ...EMPTY_ANNOTATE_COUNTS,
      skipped: true,
      skipReason: "daily_capped",
      dailyUsed,
    };
  }
  const effectiveLimit = Math.min(limit, remaining);

  // [2] claim（選抜と予約の原子実行・feed ラウンドロビン）。credibility はタイブレークで、
  // 並べ替えは RPC 側が担う（JS の credibility リランクは廃止）。claim 失敗は poolError に残し、
  // pool=-1 を返して isSelectionDead で赤くする（embed 側 selectError / isEmbedSelectStalled と同型）。
  let pool = 0;
  let ids: string[] = [];
  let leaseDeadline: string;
  try {
    const { data, error } = await supabase.rpc("claim_summary_candidates", {
      per_feed: SUMMARIZE_PER_FEED,
      max_rows: effectiveLimit,
    });
    if (error) throw error;
    const claim = (data ?? {}) as {
      pool?: number;
      ids?: string[];
      lease_deadline?: string;
    };
    pool = claim.pool ?? 0;
    ids = claim.ids ?? [];
    leaseDeadline = claim.lease_deadline ?? "";
  } catch (e) {
    const msg = errorText(e);
    console.warn("要約候補の claim に失敗:", msg);
    return {
      ...EMPTY_ANNOTATE_COUNTS,
      skipped: false,
      pool: -1,
      poolError: msg,
      dailyUsed,
    };
  }
  if (ids.length === 0) {
    // pool>0 ∧ selected=0 は選抜の全閉（isSelectionDead が拾う）。pool=0 は対象ゼロ＝正常。
    return { ...EMPTY_ANNOTATE_COUNTS, skipped: false, pool, dailyUsed };
  }

  // [3] 台帳 insert（**LLM を呼ぶ前・fail-closed の要**）。ここを LLM の後に置くと insert 失敗時に
  // 「課金したのに request_count が残らない」→ 翌 run が同枠を使い日次上限が実質無効化される。
  // insert が落ちたら LLM を 1 回も呼ばず、全 ids を released で解放して ledgerError で赤くする。
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
        run_kind: runKind,
        selection: {
          pool,
          per_feed: SUMMARIZE_PER_FEED,
          max_rows: effectiveLimit,
          picked: ids.length,
        },
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
    const released: SettleEntry[] = ids.map((id) => ({
      id,
      error: "ledger_insert_failed",
    }));
    await settleAttempts(supabase, [], released, leaseDeadline);
    return {
      ...EMPTY_ANNOTATE_COUNTS,
      skipped: false,
      pool,
      selected: ids.length,
      released: ids.length,
      ledgerError: msg,
      dailyUsed,
    };
  }

  // [4] 対象行の取得（ids <= effectiveLimit(<=20) なので .in() の URL 長は安全）。
  let rows: Row[] = [];
  try {
    const { data, error } = await supabase
      .from("articles")
      .select("id, title, content_html")
      .in("id", ids);
    if (error) throw error;
    rows = (data ?? []) as Row[];
  } catch (e) {
    const msg = errorText(e);
    console.warn("要約対象の取得に失敗（予約を解放）:", msg);
    const released: SettleEntry[] = ids.map((id) => ({ id, error: "fetch_failed" }));
    await settleAttempts(supabase, [], released, leaseDeadline);
    await collectLedger(supabase, ledgerId, {
      succeeded: 0,
      errored: 0,
      applied: 0,
      lastError: msg,
    });
    // 選抜は成功したが対象を読めない＝静かな死。poolError に載せて isSelectionDead で赤くする。
    return {
      ...EMPTY_ANNOTATE_COUNTS,
      skipped: false,
      pool,
      selected: ids.length,
      released: ids.length,
      poolError: msg,
      dailyUsed,
    };
  }

  // [5] LLM チャンクループ（concurrency ずつ Promise.allSettled）。
  let succeeded = 0;
  const failures: SettleFailure[] = [];
  for (let i = 0; i < rows.length; i += concurrency) {
    const chunk = rows.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map(async (row) => {
        const text = htmlToInputText(row.content_html);
        if (!text && !row.title) throw new Error("本文・タイトルとも空");
        const { summary, tags } = await summarizer.annotate({
          title: row.title,
          text,
        });
        if (!summary) throw new Error("要約が空");
        // タグ upsert（先）→ summary 更新（後）。要約が埋まった記事は必ずタグも持つ
        // （途中失敗時は summary NULL のまま予約解放され、次 run 再収束）。
        if (tags.length) {
          const tagRows = tags.map((t) => ({
            article_id: row.id,
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
        // 成功記事の予約解除は summary と同じ 1 回の update で行う（settle には渡さない）。
        // settle に回すと summary_reserved_until=null を書いた後の行に所有者チェックが効かず
        // 0 件更新になる。summarized_at は着地の観測台帳（YAT-74）。
        const { error: upErr } = await supabase
          .from("articles")
          .update({
            summary,
            summarized_at: new Date().toISOString(),
            summary_reserved_until: null,
            summary_batch_id: null,
          })
          .eq("id", row.id);
        if (upErr) throw upErr;
      }),
    );
    results.forEach((r, idx) => {
      if (r.status === "fulfilled") {
        succeeded += 1;
      } else {
        failures.push({ id: chunk[idx].id, reason: r.reason });
        console.warn(`アノテート失敗 [${chunk[idx].id}]:`, r.reason);
      }
    });
  }

  // [6] 帰責の分割（run 単位の証人ゲート・ADR-20260906205227）。1 件でも成功していれば
  // witness=true で、chargeable な失敗だけ summary_attempts +1。全滅ラウンドは誰の責任にもしない。
  const witness = succeeded > 0;
  const { charged, released } = splitSettle(failures, witness);

  // [7] settle RPC。失敗は settleError に残して呼び出し側が exit 1（settle が黙って落ちると
  // 予約が残る＝別の静かな死）。反映件数が要求と違えば予約失効を warn。
  let settleError: string | null = null;
  const settled = await settleAttempts(supabase, charged, released, leaseDeadline);
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

  // [8] 台帳 update（fail-soft・warn のみ）。
  await collectLedger(supabase, ledgerId, {
    succeeded,
    errored: failures.length,
    applied: succeeded,
    lastError: settleError,
  });

  return {
    skipped: false,
    pool,
    selected: ids.length,
    succeeded,
    failed: failures.length,
    charged: charged.length,
    released: released.length,
    dailyUsed,
    dailyCap: DAILY_SUMMARIZE_CAP,
    poolError: null,
    ledgerError: null,
    settleError,
    capUnavailable: false,
  };
}

// ── 隔離（summary_attempts >= 3）の 24h 増加の観測（YAT-78・ADR-20260906205227）───────
//
// 環境起因の失敗を chargeable に誤分類すると健全期の backlog 上位が 3 run で全滅する。
// isQuarantineSurging（ingest-health）が読む件数と、ログ用の先頭サンプルを 1 クエリで返す。
// summary_attempts が閾値に達した時刻 = 最後の失敗時刻なので summary_last_failed_at で窓を切る。
// 取得失敗は -1 に倒す（0 だと偽陰性で沈黙する）。
export const QUARANTINE_SAMPLE_LIMIT = 10;

export type SummaryQuarantineCounts = {
  /** summary_attempts >= 閾値 ∧ summary_last_failed_at >= now-24h の件数。-1 は取得失敗。 */
  quarantinedLast24h: number;
  /** ログ用の先頭 10 件（id / title / summary_last_error）。 */
  samples: { id: string; title: string | null; lastError: string | null }[];
};

export async function summaryQuarantineCounts(
  supabase: SupabaseClient,
  now: number = Date.now(),
): Promise<SummaryQuarantineCounts> {
  const cutoff = new Date(
    now - QUARANTINE_WINDOW_HOURS * 3_600_000,
  ).toISOString();
  const { data, error, count } = await supabase
    .from("articles")
    .select("id, title, summary_last_error", { count: "exact" })
    .gte("summary_attempts", SUMMARY_MAX_ATTEMPTS)
    .gte("summary_last_failed_at", cutoff)
    .limit(QUARANTINE_SAMPLE_LIMIT);
  if (error) {
    console.warn("隔離件数の取得に失敗:", error);
    return { quarantinedLast24h: -1, samples: [] };
  }
  const samples = (
    (data ?? []) as {
      id: string;
      title: string | null;
      summary_last_error: string | null;
    }[]
  ).map((r) => ({ id: r.id, title: r.title, lastError: r.summary_last_error }));
  return { quarantinedLast24h: count ?? -1, samples };
}
