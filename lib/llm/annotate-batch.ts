import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildAnnotateParams, interpretAnnotateMessage } from "./haiku";
import { htmlToInputText } from "./extract-text";
import { errorText, type SettleEntry, type SettleFailure } from "./failure-attribution";
import {
  BATCH_LEASE_HOURS,
  DAILY_SUMMARIZE_CAP,
  planBatchSubmit,
} from "./summarize-policy";
import {
  applyAnnotation,
  closeSummaryRound,
  listOpenBatchRounds,
  markRoundUnresolved,
  openSummaryRound,
  readBatchBacklog,
  readSummaryUsage,
  recordBatchCreate,
  type RoundRow,
} from "./summary-ledger";

// cron の要約経路を Message Batches API（単価 50% 減）に載せる（YAT-79・ADR-20260906205226）。
//
// 同期の HaikuSummarizer / annotateMissing は触らず、ここに投入（submit）と回収（collect）を並置する。
// 1 run の流れは ingest.ts: 前 run までのバッチを回収 → … → 日次枠のうち SUMMARIZE_BATCH_CAP 分を
// 投入 → 残りを同期。台帳・予約・書き込みは summary-ledger.ts と共有する。
// 投入は fail-soft にしない（create の失敗は submitDead で赤くする）。

type MessageBatch = Anthropic.Messages.MessageBatch;
type MessageBatchIndividualResponse = Anthropic.Messages.MessageBatchIndividualResponse;
type BatchRequest = Anthropic.Messages.BatchCreateParams.Request;

// SDK の client.messages.batches がそのまま満たす最小の口（テストでは fake を渡す）。
// create の maxRetries は型で 0 に固定する: SDK 0.102.0 は idempotencyKey を黙って捨てるので、
// 既定の maxRetries 2 だと応答を取り損ねた再送で 1 回の create が最大 3 バッチになる。
export type BatchesPort = {
  create(
    body: { requests: BatchRequest[] },
    options: { maxRetries: 0 },
  ): Promise<MessageBatch>;
  retrieve(id: string): Promise<MessageBatch>;
  results(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<AsyncIterable<MessageBatchIndividualResponse>>;
};

// SDK の既定は timeout 10 分・再試行 2 回。collect は run の先頭にあるので、詰まると後段（取得・
// キュレーション・embed）を巻き添えにする。1 リクエストは 1 分で打ち切り、再試行もしない
// （回収の失敗は unresolved にして次 run で再試行するので、run 内で粘る理由が無い）。
// timeout が効くのは応答ヘッダまでなので、results の本文の読み出しは collect 側の signal で打ち切る。
const BATCH_API_TIMEOUT_MS = 60_000;

// ANTHROPIC_API_KEY が無ければ null（submit / collect は no_api_key で見送る）。
export function createBatchesPort(): BatchesPort | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new Anthropic({ apiKey, timeout: BATCH_API_TIMEOUT_MS, maxRetries: 0 }).messages
    .batches;
}

// ── 純関数 ─────────────────────────────────────────────────────────────────

// custom_id は記事 id（UUID は ^[a-zA-Z0-9_-]{1,64}$ に収まる）。本文もタイトルも空の記事は送れないので
// 外す（collect で「結果に無い id」として帰責する）。params は同期と同じ buildAnnotateParams。
export function buildBatchRequests(rows: RoundRow[]): {
  requests: BatchRequest[];
  unsendable: string[];
} {
  const requests: BatchRequest[] = [];
  const unsendable: string[] = [];
  for (const r of rows) {
    const text = htmlToInputText(r.content_html);
    if (!text && !r.title) {
      unsendable.push(r.id);
      continue;
    }
    requests.push({ custom_id: r.id, params: buildAnnotateParams({ title: r.title, text }) });
  }
  return { requests, unsendable };
}

// archived（結果が消えた）を先に見る。results() を呼ぶと throw するので、呼ぶ前に分ける。
export function decideCollectAction(
  b: Pick<MessageBatch, "processing_status" | "archived_at">,
): "pending" | "archived" | "drain" {
  if (b.archived_at) return "archived";
  if (b.processing_status !== "ended") return "pending";
  return "drain";
}

export type ClassifiedResults = {
  succeeded: { id: string; message: Anthropic.Messages.Message }[];
  /** 証人ゲートで帰責するもの（errored・結果に無い id）。 */
  failures: SettleFailure[];
  /** 証人に関係なく予約を外すだけのもの（expired / canceled）。 */
  releases: SettleEntry[];
  /** ラウンドに無い custom_id（無視する）。 */
  unknownIds: string[];
  counts: { succeeded: number; errored: number; expired: number; canceled: number };
  tokens: { input: number; output: number };
};

// 結果は投入順と一致しないので custom_id で突き合わせる。
export function classifyBatchResults(
  ids: string[],
  results: MessageBatchIndividualResponse[],
): ClassifiedResults {
  const expected = new Set(ids);
  const seen = new Set<string>();
  const out: ClassifiedResults = {
    succeeded: [],
    failures: [],
    releases: [],
    unknownIds: [],
    counts: { succeeded: 0, errored: 0, expired: 0, canceled: 0 },
    tokens: { input: 0, output: 0 },
  };
  for (const r of results) {
    const id = r.custom_id;
    if (!expected.has(id) || seen.has(id)) {
      out.unknownIds.push(id);
      continue;
    }
    seen.add(id);
    switch (r.result.type) {
      case "succeeded":
        out.counts.succeeded += 1;
        out.succeeded.push({ id, message: r.result.message });
        out.tokens.input += r.result.message.usage.input_tokens;
        out.tokens.output += r.result.message.usage.output_tokens;
        break;
      case "errored":
        out.counts.errored += 1;
        // error は素の ErrorResponse。chargeable() が error.type で帰責する（failure-attribution）。
        out.failures.push({ id, reason: r.result.error });
        break;
      case "expired":
        out.counts.expired += 1;
        out.releases.push({ id, error: "batch_expired" });
        break;
      case "canceled":
        out.counts.canceled += 1;
        out.releases.push({ id, error: "batch_canceled" });
        break;
    }
  }
  for (const id of ids) {
    if (!seen.has(id)) {
      // 送らなかった記事（本文・タイトルとも空）か、対象取得で消えていた記事。記事固有の失敗として
      // 証人ゲートに通し、送れない記事が予約枠を毎回占め続けるのを attempts で隔離する。
      out.failures.push({ id, reason: new Error("バッチの結果に無い（送れなかった記事）") });
    }
  }
  return out;
}

// ── 投入 ───────────────────────────────────────────────────────────────────

/** 正常な抑制で投入を見送った理由。障害はここに入れない（capUnavailable / *Error は別フィールド）。 */
export type SubmitSkipReason =
  | "batch_disabled"
  | "no_api_key"
  | "inflight_cap"
  | "daily_capped"
  | "batch_capped";

type SubmitCounts = {
  /** claim が返した母数（下界）。-1 は取得不能（isSelectionDead を発火させない）。 */
  pool: number;
  poolCapped: boolean;
  /** claim で予約できた件数（= 台帳の request_count）。 */
  selected: number;
  /** 台帳に載せた件数。同期の残り枠はここから引く（create が失敗しても数える＝fail-closed）。 */
  ledgerCounted: number;
  /** create に渡したリクエスト数。0 なら create を呼んでいない。submitDead が読む。 */
  reserved: number;
  batchId: string | null;
  ledgerId: string | null;
  /** 実行開始時点の当日の投入数（同期 + Batches）と、そのうち Batches の分。 */
  dailyUsed: number;
  batchUsed: number;
  dailyCap: number;
  batchCap: number;
  /** 未回収のバッチ数。-1 は不明。 */
  inflight: number;
  poolError: string | null;
  ledgerError: string | null;
  createError: string | null;
  /** create は成功したが batch_id を台帳に書けなかった（孤児）。 */
  batchIdWriteError: string | null;
  capUnavailable: boolean;
};

export type BatchSubmitResult =
  | (SubmitCounts & { skipped: true; skipReason: SubmitSkipReason })
  | (SubmitCounts & { skipped: false; skipReason?: never });

const EMPTY_SUBMIT: SubmitCounts = {
  pool: 0,
  poolCapped: false,
  selected: 0,
  ledgerCounted: 0,
  reserved: 0,
  batchId: null,
  ledgerId: null,
  dailyUsed: 0,
  batchUsed: 0,
  dailyCap: DAILY_SUMMARIZE_CAP,
  batchCap: 0,
  inflight: -1,
  poolError: null,
  ledgerError: null,
  createError: null,
  batchIdWriteError: null,
  capUnavailable: false,
};

export async function submitAnnotateBatch(
  supabase: SupabaseClient,
  opts: { cap: number; port?: BatchesPort | null; runKind?: "cron" | "manual" },
): Promise<BatchSubmitResult> {
  const base: SubmitCounts = { ...EMPTY_SUBMIT, batchCap: Math.max(0, opts.cap) };
  // [0] CAP=0 はロールバック（全件同期）。台帳も読まない。
  if (opts.cap <= 0) return { ...base, skipped: true, skipReason: "batch_disabled" };
  const port = opts.port !== undefined ? opts.port : createBatchesPort();
  if (!port) return { ...base, skipped: true, skipReason: "no_api_key" };

  // [1] 当日の消費と未回収の本数。読めなければ上限が確かめられないので障害として見送る。
  const [usage, backlog] = await Promise.all([
    readSummaryUsage(supabase),
    readBatchBacklog(supabase),
  ]);
  if (!usage.ok || !backlog.ok) {
    console.warn(
      "要約の当日消費・未回収バッチ数の取得に失敗。上限が確認できないので投入を見送る:",
      !usage.ok ? usage.error : !backlog.ok ? backlog.error : "",
    );
    return { ...base, skipped: false, pool: -1, capUnavailable: true };
  }
  const known = {
    ...base,
    dailyUsed: usage.usage.total,
    batchUsed: usage.usage.batch,
    inflight: backlog.open,
  };

  // [2] 投入件数を決める（inflight_cap → daily_capped → batch_capped の順で見送る）。
  const plan = planBatchSubmit({ cap: opts.cap, usage: usage.usage, inflight: backlog.open });
  if (!plan.submit) return { ...known, skipped: true, skipReason: plan.reason };

  // [3] claim → 台帳 insert（create の前・fail-closed）→ 対象行の取得。予約は 36h。
  const opened = await openSummaryRound(supabase, {
    mode: "batch",
    runKind: opts.runKind ?? "cron",
    maxRows: plan.maxRows,
    leaseHours: BATCH_LEASE_HOURS,
  });
  switch (opened.kind) {
    case "claim_failed":
      return { ...known, skipped: false, pool: -1, poolError: opened.error };
    case "empty":
      return { ...known, skipped: false, pool: opened.pool, poolCapped: opened.poolCapped };
    case "ledger_failed":
      return {
        ...known,
        skipped: false,
        pool: opened.pool,
        poolCapped: opened.poolCapped,
        selected: opened.selected,
        ledgerError: opened.error,
      };
    case "fetch_failed":
      return {
        ...known,
        skipped: false,
        pool: opened.pool,
        poolCapped: opened.poolCapped,
        selected: opened.selected,
        ledgerCounted: opened.selected,
        poolError: opened.error,
      };
  }

  const { round, rows } = opened;
  const roundCounts = {
    ...known,
    skipped: false as const,
    pool: opened.pool,
    poolCapped: opened.poolCapped,
    selected: round.ids.length,
    ledgerCounted: round.ids.length,
    ledgerId: round.ledgerId,
  };

  // [4] リクエストを組む。送れるものが無ければ create を呼ばずにラウンドを閉じる。
  const { requests, unsendable } = buildBatchRequests(rows);
  if (requests.length === 0) {
    const unsent = round.ids.map((id) => ({
      id,
      reason: new Error(unsendable.includes(id) ? "本文・タイトルとも空" : "対象行が無い"),
    }));
    await closeSummaryRound(supabase, round, {
      applied: 0,
      failures: unsent,
      ledger: { succeeded: 0, errored: 0, applied: 0, lastError: "no_sendable_rows" },
    });
    return roundCounts;
  }

  // [5] create（maxRetries 0）。例外は握らず submitDead で赤くする。
  let batch: MessageBatch;
  try {
    batch = await port.create({ requests }, { maxRetries: 0 });
  } catch (e) {
    const msg = errorText(e);
    console.error("要約バッチの作成に失敗（予約を解放して台帳を終端する）:", msg);
    await recordBatchCreate(supabase, round, { ok: false, error: msg });
    return { ...roundCounts, reserved: requests.length, createError: msg };
  }

  // [6] batch_id を台帳へ。書けなければ孤児（この run のメモリにしか batch_id が無い）。
  const written = await recordBatchCreate(supabase, round, { ok: true, batchId: batch.id });
  return {
    ...roundCounts,
    reserved: requests.length,
    batchId: batch.id,
    batchIdWriteError: written.ledgerWriteError,
  };
}

// ── 回収 ───────────────────────────────────────────────────────────────────

/**
 * 1 run で回収に使う時間。ラウンドの境界と結果の取得の前で見て、超えたら残りは次 run に持ち越す。
 * 結果の本文の読み出しはこの残り時間で打ち切る（途中で切れたら unresolved にして次 run で読み直す）。
 */
export const COLLECT_BUDGET_MS = 120_000;

export type CollectSkipReason = "collect_disabled" | "no_api_key";

type CollectCounts = {
  /** 回収待ちだったラウンド数（submitted / unresolved）。 */
  open: number;
  /** 終端できたラウンド数（archived を含む）。 */
  returned: number;
  archived: number;
  /** まだ処理中のバッチ数。 */
  pending: number;
  /** 回収できず unresolved にしたラウンド数（retrieve / results の失敗・selection 不正）。 */
  unresolved: number;
  /** 時間予算を超えて次 run に回したラウンド数。 */
  deferred: number;
  /**
   * 書き込みか帰責の対象になった件数（succeeded ＋ errored ＋ 結果に無い id）。collectDead が読む。
   * expired / canceled は含めない（予約を外すだけで、書き込みも帰責もしない）。
   */
  attempted: number;
  succeeded: number;
  errored: number;
  expired: number;
  canceled: number;
  /** 記事に書けた件数。 */
  applied: number;
  charged: number;
  released: number;
  inputTokens: number;
  outputTokens: number;
  listError: string | null;
  settleError: string | null;
};

export type BatchCollectResult =
  | (CollectCounts & { skipped: true; skipReason: CollectSkipReason })
  | (CollectCounts & { skipped: false; skipReason?: never });

const EMPTY_COLLECT: CollectCounts = {
  open: 0,
  returned: 0,
  archived: 0,
  pending: 0,
  unresolved: 0,
  deferred: 0,
  attempted: 0,
  succeeded: 0,
  errored: 0,
  expired: 0,
  canceled: 0,
  applied: 0,
  charged: 0,
  released: 0,
  inputTokens: 0,
  outputTokens: 0,
  listError: null,
  settleError: null,
};

export async function collectAnnotateBatches(
  supabase: SupabaseClient,
  opts: {
    enabled: boolean;
    port?: BatchesPort | null;
    budgetMs?: number;
    now?: () => number;
  },
): Promise<BatchCollectResult> {
  if (!opts.enabled) return { ...EMPTY_COLLECT, skipped: true, skipReason: "collect_disabled" };
  const port = opts.port !== undefined ? opts.port : createBatchesPort();
  if (!port) return { ...EMPTY_COLLECT, skipped: true, skipReason: "no_api_key" };
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? COLLECT_BUDGET_MS);

  const c: CollectCounts = { ...EMPTY_COLLECT };
  const list = await listOpenBatchRounds(supabase);
  if (!list.ok) {
    console.warn("回収待ちの要約バッチの取得に失敗:", list.error);
    return { ...c, skipped: false, listError: list.error };
  }
  c.open = list.rounds.length + list.malformed.length;
  for (const m of list.malformed) {
    console.warn(`要約バッチの台帳が読めない [${m.ledgerId}]: ${m.error}`);
    await markRoundUnresolved(supabase, m.ledgerId, `malformed: ${m.error}`);
    c.unresolved += 1;
  }

  for (const { round, batchId } of list.rounds) {
    if (now() > deadline) {
      c.deferred += 1;
      continue;
    }

    let batch: MessageBatch;
    try {
      batch = await port.retrieve(batchId);
    } catch (e) {
      const msg = errorText(e);
      console.warn(`要約バッチの状態取得に失敗 [${batchId}]:`, msg);
      await markRoundUnresolved(supabase, round.ledgerId, `retrieve: ${msg}`);
      c.unresolved += 1;
      continue;
    }

    const action = decideCollectAction(batch);
    if (action === "pending") {
      c.pending += 1;
      continue;
    }
    const rc = batch.request_counts;

    if (action === "archived") {
      // 結果が消えている。予約を全件外して終端する（永久に赤くしない）。
      const closed = await closeSummaryRound(supabase, round, {
        applied: 0,
        failures: [],
        releases: round.ids.map((id) => ({ id, error: "batch_archived" })),
        ledger: {
          succeeded: rc.succeeded,
          errored: rc.errored,
          applied: 0,
          lastError: "archived",
          expired: rc.expired,
          canceled: rc.canceled,
          endedAt: batch.ended_at,
        },
      });
      c.released += closed.released;
      c.settleError ??= closed.settleError;
      if (closed.ledgerClosed) {
        c.returned += 1;
        c.archived += 1;
      }
      continue;
    }

    // retrieve に時間を使って予算を超えていたら、結果の取得は次 run に回す（台帳は触らない）。
    if (now() > deadline) {
      c.deferred += 1;
      continue;
    }

    // 結果は書く前に全部読み切る。途中で落ちても記事は 1 件も書かず、次 run で読み直す。
    const items: MessageBatchIndividualResponse[] = [];
    try {
      const signal = AbortSignal.timeout(Math.max(1_000, deadline - now()));
      for await (const it of await port.results(batchId, { signal })) items.push(it);
    } catch (e) {
      const msg = errorText(e);
      console.warn(`要約バッチの結果取得に失敗 [${batchId}]:`, msg);
      await markRoundUnresolved(supabase, round.ledgerId, `results: ${msg}`);
      c.unresolved += 1;
      continue;
    }

    const cls = classifyBatchResults(round.ids, items);
    if (cls.unknownIds.length > 0) {
      console.warn(
        `要約バッチにラウンド外の custom_id が ${cls.unknownIds.length} 件 [${batchId}]（無視する）`,
      );
    }

    // タグ → 要約の順で書く（applyAnnotation）。同じ結果を 2 回書いても同じ状態になるので、
    // 台帳を閉じる前に落ちても次 run の再回収で収束する（settle は所有者チェックで 2 回目は 0 件）。
    let applied = 0;
    const writeFailures: SettleFailure[] = [];
    for (const s of cls.succeeded) {
      try {
        await applyAnnotation(supabase, s.id, interpretAnnotateMessage(s.message));
        applied += 1;
      } catch (e) {
        writeFailures.push({ id: s.id, reason: e });
        console.warn(`アノテート失敗（Batches）[${s.id}]:`, e);
      }
    }

    const closed = await closeSummaryRound(supabase, round, {
      applied,
      failures: [...cls.failures, ...writeFailures],
      releases: cls.releases,
      ledger: {
        succeeded: cls.counts.succeeded,
        errored: cls.counts.errored,
        applied,
        lastError: null,
        expired: cls.counts.expired,
        canceled: cls.counts.canceled,
        inputTokens: cls.tokens.input,
        outputTokens: cls.tokens.output,
        endedAt: batch.ended_at,
      },
    });

    c.attempted += cls.succeeded.length + cls.failures.length;
    c.succeeded += cls.counts.succeeded;
    c.errored += cls.counts.errored;
    c.expired += cls.counts.expired;
    c.canceled += cls.counts.canceled;
    c.applied += applied;
    c.charged += closed.charged;
    c.released += closed.released;
    c.inputTokens += cls.tokens.input;
    c.outputTokens += cls.tokens.output;
    c.settleError ??= closed.settleError;
    if (closed.ledgerClosed) c.returned += 1;
  }

  return { ...c, skipped: false };
}
