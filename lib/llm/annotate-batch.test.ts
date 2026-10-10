import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import {
  buildBatchRequests,
  classifyBatchResults,
  collectAnnotateBatches,
  decideCollectAction,
  submitAnnotateBatch,
  type BatchesPort,
} from "./annotate-batch";
import { buildAnnotateParams } from "./haiku";
import { isCollectDead } from "@/lib/rss/ingest-health";
import {
  argOf,
  callName,
  createRecorder,
  isFrom,
  isRpc,
  type RecordedCall,
  type StubResponse,
} from "./supabase-recorder.testkit";

// YAT-79: Message Batches の投入と回収。判断は純関数で、I/O の順序（台帳 → create → batch_id、
// 結果を読み切ってからタグ → 要約）は記録スタブと fake の port で固定する。

type MessageBatch = Anthropic.Messages.MessageBatch;
type Item = Anthropic.Messages.MessageBatchIndividualResponse;

const LEASE = "2026-10-10T12:00:00.000Z";

const batchOf = (over: Partial<MessageBatch> = {}): MessageBatch => ({
  id: "msgbatch_1",
  type: "message_batch",
  processing_status: "ended",
  request_counts: { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
  created_at: "2026-10-09T00:00:00Z",
  expires_at: "2026-10-10T00:00:00Z",
  ended_at: "2026-10-09T00:20:00Z",
  cancel_initiated_at: null,
  archived_at: null,
  results_url: "https://example.com/results",
  ...over,
});

const message = (summary: string, input = 100, output = 50) =>
  ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text: JSON.stringify({ summary, tags: ["tech/ai"] }), citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: input, output_tokens: output },
  }) as unknown as Anthropic.Messages.Message;

// "summary" キーを含む壊れた JSON（interpretAnnotateMessage が throw する）を返した成功結果。
const okBroken = (id: string): Item => ({
  custom_id: id,
  result: {
    type: "succeeded",
    message: {
      ...message("x"),
      content: [{ type: "text", text: '{"summary": "途中で切れ', citations: null }],
    } as unknown as Anthropic.Messages.Message,
  },
});
const ok = (id: string, summary = `要点-${id}`, input = 100, output = 50): Item => ({
  custom_id: id,
  result: { type: "succeeded", message: message(summary, input, output) },
});
const errored = (id: string, type: string): Item =>
  ({
    custom_id: id,
    result: { type: "errored", error: { type: "error", error: { type, message: "m" }, request_id: null } },
  }) as Item;
const expired = (id: string): Item => ({ custom_id: id, result: { type: "expired" } });
const canceled = (id: string): Item => ({ custom_id: id, result: { type: "canceled" } });

// ── 純関数 ────────────────────────────────────────────────────────────────

describe("buildBatchRequests", () => {
  it("custom_id は記事 id、params は同期と同じ。本文もタイトルも空の記事は送らない", () => {
    const id = "0b9f6a1e-3c2d-4e5f-8a7b-1c2d3e4f5a6b";
    const r = buildBatchRequests([
      { id, title: "T", content_html: "<p>B</p>" },
      { id: "empty", title: null, content_html: "<p></p>" },
    ]);
    expect(r.unsendable).toEqual(["empty"]);
    expect(r.requests).toEqual([{ custom_id: id, params: buildAnnotateParams({ title: "T", text: "B" }) }]);
    expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});

describe("decideCollectAction", () => {
  it("archived を最優先、終わっていなければ pending、終わっていれば drain", () => {
    expect(decideCollectAction({ processing_status: "ended", archived_at: "x" })).toBe("archived");
    expect(decideCollectAction({ processing_status: "in_progress", archived_at: null })).toBe("pending");
    expect(decideCollectAction({ processing_status: "canceling", archived_at: null })).toBe("pending");
    expect(decideCollectAction({ processing_status: "ended", archived_at: null })).toBe("drain");
  });
});

describe("classifyBatchResults", () => {
  it("4 種類の結果・結果に無い id・ラウンド外の custom_id を振り分け、トークンを合計する", () => {
    const r = classifyBatchResults(
      ["a", "b", "c", "d", "e", "f"],
      [ok("a", "要点", 100, 40), errored("b", "rate_limit_error"), errored("c", "invalid_request_error"), expired("d"), canceled("e"), ok("x")],
    );
    expect(r.succeeded.map((s) => s.id)).toEqual(["a"]);
    expect(r.failures.map((f) => f.id)).toEqual(["b", "c", "f"]);
    expect(r.releases).toEqual([
      { id: "d", error: "batch_expired" },
      { id: "e", error: "batch_canceled" },
    ]);
    expect(r.unknownIds).toEqual(["x"]);
    expect(r.counts).toEqual({ succeeded: 1, errored: 2, expired: 1, canceled: 1 });
    expect(r.tokens).toEqual({ input: 100, output: 40 });
  });
});

// ── 投入 ──────────────────────────────────────────────────────────────────

type SubmitWorld = {
  usage?: StubResponse;
  backlog?: StubResponse;
  claim?: StubResponse;
  rows?: { id: string; title: string | null; content_html: string | null }[];
  batchUpdate?: StubResponse;
  insert?: StubResponse;
  fetch?: StubResponse;
};

function submitWorld(w: SubmitWorld = {}) {
  return createRecorder((c: RecordedCall) => {
    if (isFrom(c, "llm_batches", "insert")) return w.insert ?? { data: { id: "L1" } };
    if (isFrom(c, "llm_batches", "update")) return w.batchUpdate ?? {};
    if (isFrom(c, "llm_batches", "select")) {
      const cols = argOf(c, "select")?.[0];
      if (cols === "submitted_at") return w.backlog ?? { data: [], count: 0 };
      return w.usage ?? { data: [{ request_count: 40, selection: null }] };
    }
    if (isRpc(c, "claim_summary_candidates"))
      return w.claim ?? { data: { pool: 9, pool_capped: false, ids: ["a", "b"], lease_deadline: LEASE } };
    if (isFrom(c, "articles", "select"))
      return w.fetch ?? {
        data: w.rows ?? [
          { id: "a", title: "A", content_html: "<p>本文A</p>" },
          { id: "b", title: "B", content_html: "<p>本文B</p>" },
        ],
      };
    if (isRpc(c, "settle_summary_attempts")) return { data: { charged: 0, released: 2 } };
    return {};
  });
}

function fakePort(over: Partial<BatchesPort> = {}) {
  const log: { op: string; args: unknown[] }[] = [];
  const port: BatchesPort = {
    create: async (body, options) => {
      log.push({ op: "create", args: [body, options] });
      if (over.create) return over.create(body, options);
      return batchOf({ processing_status: "in_progress", ended_at: null, results_url: null });
    },
    retrieve: async (id) => {
      log.push({ op: "retrieve", args: [id] });
      if (over.retrieve) return over.retrieve(id);
      return batchOf();
    },
    results: async (id, options) => {
      log.push({ op: "results", args: [id, options] });
      if (over.results) return over.results(id, options);
      return (async function* () {})();
    },
  };
  return { port, log };
}

describe("submitAnnotateBatch", () => {
  it("CAP=0 は DB も SDK も触らずに batch_disabled", async () => {
    const w = submitWorld();
    const { port, log } = fakePort();
    const r = await submitAnnotateBatch(w.client, { cap: 0, port });
    expect(r).toMatchObject({ skipped: true, skipReason: "batch_disabled", reserved: 0 });
    expect(w.calls).toEqual([]);
    expect(log).toEqual([]);
  });

  it("claim（36h）→ 台帳 insert（mode batch）→ 取得 → create（maxRetries 0）→ batch_id の順", async () => {
    const w = submitWorld();
    const { port, log } = fakePort();
    const r = await submitAnnotateBatch(w.client, { cap: 20, port });
    expect(r).toMatchObject({
      skipped: false,
      pool: 9,
      selected: 2,
      ledgerCounted: 2,
      reserved: 2,
      batchId: "msgbatch_1",
      ledgerId: "L1",
      dailyUsed: 40,
      batchUsed: 0,
      inflight: 0,
      createError: null,
      batchIdWriteError: null,
    });
    const order = w.calls.map(callName).filter((n) => n !== "llm_batches.select");
    expect(order).toEqual([
      "rpc:claim_summary_candidates",
      "llm_batches.insert",
      "articles.select",
      "llm_batches.update",
    ]);
    const claim = w.calls.find((c) => isRpc(c, "claim_summary_candidates")) as { args: unknown };
    expect(claim.args).toEqual({ per_feed: 4, max_rows: 20, lease_hours: 36 });
    const insert = w.calls.find((c) => isFrom(c, "llm_batches", "insert"))!;
    expect((argOf(insert, "insert") as [{ selection: unknown }])[0].selection).toMatchObject({
      mode: "batch",
      lease_hours: 36,
      lease_deadline: LEASE,
      ids: ["a", "b"],
    });
    expect(log.map((l) => l.op)).toEqual(["create"]);
    expect(log[0].args[1]).toEqual({ maxRetries: 0 });
    const body = log[0].args[0] as { requests: { custom_id: string }[] };
    expect(body.requests.map((q) => q.custom_id)).toEqual(["a", "b"]);
  });

  it("Batches の当日枠を使い切っていれば claim せずに batch_capped", async () => {
    const w = submitWorld({ usage: { data: [{ request_count: 20, selection: { mode: "batch" } }] } });
    const { port, log } = fakePort();
    const r = await submitAnnotateBatch(w.client, { cap: 20, port });
    expect(r).toMatchObject({ skipped: true, skipReason: "batch_capped", batchUsed: 20, dailyUsed: 20 });
    expect(w.calls.some((c) => isRpc(c, "claim_summary_candidates"))).toBe(false);
    expect(log).toEqual([]);
  });

  it("未回収が 12 本なら inflight_cap", async () => {
    const w = submitWorld({ backlog: { data: [{ submitted_at: "x" }], count: 12 } });
    const r = await submitAnnotateBatch(w.client, { cap: 20, port: fakePort().port });
    expect(r).toMatchObject({ skipped: true, skipReason: "inflight_cap", inflight: 12 });
  });

  it("台帳が読めなければ capUnavailable（pool=-1）", async () => {
    const w = submitWorld({ usage: { error: { message: "boom" } } });
    const r = await submitAnnotateBatch(w.client, { cap: 20, port: fakePort().port });
    expect(r).toMatchObject({ skipped: false, capUnavailable: true, pool: -1 });
  });

  it("create の失敗は予約を解放して台帳を終端し、reserved を残して batchId は null（submitDead）", async () => {
    const w = submitWorld();
    const { port } = fakePort({
      create: async () => {
        throw new Error("connection reset");
      },
    });
    const r = await submitAnnotateBatch(w.client, { cap: 20, port });
    expect(r).toMatchObject({
      reserved: 2,
      batchId: null,
      createError: "connection reset",
      ledgerCounted: 2,
    });
    const tail = w.calls.slice(-2);
    expect(tail.map(callName)).toEqual(["rpc:settle_summary_attempts", "llm_batches.update"]);
    expect((argOf(tail[1], "update") as [{ status: string }])[0].status).toBe("expired_unknown");
  });

  it("claim の失敗は poolError（pool=-1）で返し、台帳も create も触らない", async () => {
    const w = submitWorld({ claim: { error: { message: "timeout" } } });
    const { port, log } = fakePort();
    const r = await submitAnnotateBatch(w.client, { cap: 20, port });
    expect(r).toMatchObject({ skipped: false, pool: -1, poolError: "timeout", ledgerCounted: 0, reserved: 0 });
    expect(w.calls.some((c) => isFrom(c, "llm_batches", "insert"))).toBe(false);
    expect(log).toEqual([]);
  });

  it("台帳 insert の失敗は ledgerError で返し、台帳に載っていないので同期の枠は減らさない", async () => {
    const w = submitWorld({ insert: { error: { message: "denied" } } });
    const { port, log } = fakePort();
    const r = await submitAnnotateBatch(w.client, { cap: 20, port });
    expect(r).toMatchObject({ ledgerError: "denied", selected: 2, ledgerCounted: 0, reserved: 0, batchId: null });
    expect(log).toEqual([]);
  });

  it("対象行の取得の失敗は poolError で返し、台帳に載った件数は同期の枠から引く", async () => {
    const w = submitWorld({ fetch: { error: { message: "fetch boom" } } });
    const { port, log } = fakePort();
    const r = await submitAnnotateBatch(w.client, { cap: 20, port });
    expect(r).toMatchObject({ poolError: "fetch boom", selected: 2, ledgerCounted: 2, reserved: 0 });
    expect(log).toEqual([]);
  });

  it("batch_id を台帳に書けなければ batchIdWriteError（孤児）", async () => {
    const w = submitWorld({ batchUpdate: { error: { message: "denied" } } });
    const r = await submitAnnotateBatch(w.client, { cap: 20, port: fakePort().port });
    expect(r).toMatchObject({ batchId: "msgbatch_1", batchIdWriteError: "denied" });
  });
});

// ── 回収 ──────────────────────────────────────────────────────────────────

const openRow = (over: Record<string, unknown> = {}) => ({
  id: "L1",
  batch_id: "msgbatch_1",
  submitted_at: "2026-10-09T00:00:00Z",
  selection: { mode: "batch", lease_hours: 36, lease_deadline: LEASE, ids: ["a", "b", "c", "d"] },
  ...over,
});

type CollectKnobs = {
  /** 回収待ちの一覧の取得を失敗させる。 */
  listError?: boolean;
  /** settle_summary_attempts の応答（既定は要求どおりの件数を反映）。 */
  settle?: StubResponse;
  /** 台帳（llm_batches）の update の応答。 */
  ledgerUpdate?: StubResponse;
  /** この記事 id の articles.update を失敗させる。 */
  failArticle?: string;
  /** 要約が既に埋まっている記事 id（findSummarized の応答）。 */
  summarized?: string[];
  /** findSummarized を失敗させる。 */
  summarizedError?: boolean;
};

function collectWorld(rows: unknown[] = [openRow()], k: CollectKnobs = {}) {
  return createRecorder((c: RecordedCall) => {
    if (isFrom(c, "llm_batches", "update")) return k.ledgerUpdate ?? {};
    if (isFrom(c, "llm_batches", "select"))
      return k.listError ? { error: { message: "list boom" } } : { data: rows };
    if (isFrom(c, "articles", "update"))
      return argOf(c, "eq")?.[1] === k.failArticle ? { error: { message: "update boom" } } : {};
    if (isFrom(c, "articles", "select"))
      return k.summarizedError
        ? { error: { message: "summarized boom" } }
        : { data: (k.summarized ?? []).map((id) => ({ id })) };
    if (isRpc(c, "settle_summary_attempts")) {
      if (k.settle) return k.settle;
      const a = (c as { args: { charged: unknown[]; released: unknown[] } }).args;
      return { data: { charged: a.charged.length, released: a.released.length } };
    }
    return {};
  });
}

const resultsOf = (items: Item[]) => async () =>
  (async function* () {
    for (const it of items) yield it;
  })();

describe("collectAnnotateBatches", () => {
  it("停止スイッチが入っていれば何も触らない", async () => {
    const w = collectWorld();
    const { port, log } = fakePort();
    const r = await collectAnnotateBatches(w.client, { enabled: false, port });
    expect(r).toMatchObject({ skipped: true, skipReason: "collect_disabled" });
    expect(w.calls).toEqual([]);
    expect(log).toEqual([]);
  });

  it("終わったバッチ: 成功はタグ→要約で書き、証人ゲートで帰責し、トークン数を台帳に書いて閉じる", async () => {
    const w = collectWorld();
    const { port } = fakePort({
      retrieve: async () =>
        batchOf({ request_counts: { processing: 0, succeeded: 1, errored: 2, canceled: 0, expired: 1 } }),
      results: resultsOf([
        ok("a", "新モデルの発表", 120, 30),
        errored("b", "invalid_request_error"),
        errored("c", "overloaded_error"),
        expired("d"),
      ]),
    });
    const r = await collectAnnotateBatches(w.client, { enabled: true, port });
    expect(r).toMatchObject({
      skipped: false,
      open: 1,
      returned: 1,
      attempted: 3,
      succeeded: 1,
      errored: 2,
      expired: 1,
      applied: 1,
      charged: 1,
      released: 2,
      inputTokens: 120,
      outputTokens: 30,
      settleError: null,
    });
    expect(w.calls.map(callName)).toEqual([
      "llm_batches.select",
      "articles.select",
      "article_tags.upsert",
      "articles.update",
      "rpc:settle_summary_attempts",
      "llm_batches.update",
    ]);
    // 要約済みの確認は成功した記事だけを、要約が埋まっているかで引く
    expect(argOf(w.calls[1], "in")).toEqual(["id", ["a"]]);
    expect(argOf(w.calls[1], "not")).toEqual(["summary", "is", null]);
    expect((argOf(w.calls[3], "update") as [{ summary: string }])[0].summary).toBe("新モデルの発表");
    expect(w.calls[4]).toEqual({
      kind: "rpc",
      fn: "settle_summary_attempts",
      args: {
        charged: [{ id: "b", error: "invalid_request_error: m" }],
        released: [
          { id: "c", error: "overloaded_error: m" },
          { id: "d", error: "batch_expired" },
        ],
        lease_deadline: LEASE,
      },
    });
    expect(argOf(w.calls[5], "update")).toEqual([
      {
        status: "collected",
        succeeded: 1,
        errored: 2,
        applied: 1,
        ended_at: "2026-10-09T00:20:00Z",
        collected_at: expect.any(String),
        last_error: null,
        expired: 1,
        canceled: 0,
        input_tokens: 120,
        output_tokens: 30,
      },
    ]);
  });

  it("処理中のバッチは何も書かない", async () => {
    const w = collectWorld();
    const { port, log } = fakePort({
      retrieve: async () => batchOf({ processing_status: "in_progress", ended_at: null }),
    });
    const r = await collectAnnotateBatches(w.client, { enabled: true, port });
    expect(r).toMatchObject({ pending: 1, returned: 0 });
    expect(w.calls.map(callName)).toEqual(["llm_batches.select"]);
    expect(log.map((l) => l.op)).toEqual(["retrieve"]);
  });

  it("archived は results を呼ばず、予約を全件外して終端する", async () => {
    const w = collectWorld();
    const { port, log } = fakePort({ retrieve: async () => batchOf({ archived_at: "2026-11-07T00:00:00Z" }) });
    const r = await collectAnnotateBatches(w.client, { enabled: true, port });
    expect(r).toMatchObject({ returned: 1, archived: 1, released: 4, applied: 0 });
    expect(log.map((l) => l.op)).toEqual(["retrieve"]);
    const close = w.calls[w.calls.length - 1];
    expect((argOf(close, "update") as [{ last_error: string; applied: number }])[0]).toMatchObject({
      last_error: "archived",
      applied: 0,
    });
  });

  it("結果の読み込みが途中で落ちたら記事は 1 件も書かずに unresolved にする", async () => {
    const w = collectWorld();
    const { port } = fakePort({
      results: async () =>
        (async function* () {
          yield ok("a");
          throw new Error("stream reset");
        })(),
    });
    const r = await collectAnnotateBatches(w.client, { enabled: true, port });
    expect(r).toMatchObject({ unresolved: 1, applied: 0, returned: 0 });
    expect(w.calls.map(callName)).toEqual(["llm_batches.select", "llm_batches.update"]);
    expect(argOf(w.calls[1], "update")).toEqual([
      { status: "unresolved", last_error: "results: stream reset" },
    ]);
  });

  it("retrieve の失敗も unresolved にして次 run で再試行する", async () => {
    const w = collectWorld();
    const { port } = fakePort({
      retrieve: async () => {
        throw new Error("timeout");
      },
    });
    const r = await collectAnnotateBatches(w.client, { enabled: true, port });
    expect(r).toMatchObject({ unresolved: 1, returned: 0 });
    expect(w.calls.map(callName)).toEqual(["llm_batches.select", "llm_batches.update"]);
    expect(argOf(w.calls[1], "update")).toEqual([
      { status: "unresolved", last_error: "retrieve: timeout" },
    ]);
    expect(argOf(w.calls[1], "eq")).toEqual(["id", "L1"]);
  });

  it("selection が読めない行は unresolved にする", async () => {
    const w = collectWorld([openRow({ selection: { pool: 1 } })]);
    const r = await collectAnnotateBatches(w.client, { enabled: true, port: fakePort().port });
    expect(r).toMatchObject({ open: 1, unresolved: 1 });
  });

  it("時間予算を超えた行は次 run に持ち越す（ラウンドの先頭）", async () => {
    const w = collectWorld([openRow(), openRow({ id: "L2", batch_id: "msgbatch_2" })]);
    let t = 0;
    const { port, log } = fakePort({
      // 1 本目の結果の取得で予算 100 を使い切る
      results: async () => {
        t = 150;
        return (async function* () {})();
      },
    });
    const r = await collectAnnotateBatches(w.client, { enabled: true, port, budgetMs: 100, now: () => t });
    expect(r).toMatchObject({ open: 2, returned: 1, deferred: 1 });
    expect(log.map((l) => l.op)).toEqual(["retrieve", "results"]);
  });

  it("retrieve で予算を超えたら結果を取りに行かず、台帳も触らずに持ち越す", async () => {
    const w = collectWorld();
    let t = 0;
    const { port, log } = fakePort({
      retrieve: async () => {
        t = 200;
        return batchOf();
      },
    });
    const r = await collectAnnotateBatches(w.client, { enabled: true, port, budgetMs: 100, now: () => t });
    expect(r).toMatchObject({ open: 1, deferred: 1, returned: 0, unresolved: 0 });
    expect(log.map((l) => l.op)).toEqual(["retrieve"]);
    expect(w.calls.map(callName)).toEqual(["llm_batches.select"]);
  });

  it("結果の取得には残り時間で切れる signal を渡す（本文の読み出しは SDK の timeout が効かないため）", async () => {
    const w = collectWorld();
    const { port, log } = fakePort({ results: resultsOf([]) });
    await collectAnnotateBatches(w.client, { enabled: true, port });
    const results = log.find((l) => l.op === "results")!;
    expect((results.args[1] as { signal: unknown }).signal).toBeInstanceOf(AbortSignal);
  });

  it("応答が壊れて書けなかった記事は、証人がいれば課金して数える", async () => {
    const w = collectWorld([
      openRow({ selection: { mode: "batch", lease_deadline: LEASE, ids: ["a", "b"] } }),
    ]);
    const r = await collectAnnotateBatches(w.client, {
      enabled: true,
      port: fakePort({ results: resultsOf([okBroken("a"), ok("b")]) }).port,
    });
    expect(r).toMatchObject({ attempted: 2, applied: 1, succeeded: 2, charged: 1, released: 0 });
    const settle = w.calls.find((c) => isRpc(c, "settle_summary_attempts")) as {
      args: { charged: { id: string; error: string }[] };
    };
    expect(settle.args.charged).toEqual([{ id: "a", error: "annotate の JSON が壊れている" }]);
    expect(isCollectDead(r)).toBe(false);
  });

  it("全件の応答が壊れていれば 1 件も着地せず collectDead になり、証人がいないので誰も課金しない", async () => {
    const w = collectWorld([
      openRow({ selection: { mode: "batch", lease_deadline: LEASE, ids: ["a", "b"] } }),
    ]);
    const r = await collectAnnotateBatches(w.client, {
      enabled: true,
      port: fakePort({ results: resultsOf([okBroken("a"), okBroken("b")]) }).port,
    });
    expect(r).toMatchObject({ attempted: 2, applied: 0, charged: 0, released: 2 });
    expect(isCollectDead(r)).toBe(true);
  });

  it("DB の書き込みに失敗した記事も帰責の対象にする（要約は書かれない）", async () => {
    const w = collectWorld(
      [openRow({ selection: { mode: "batch", lease_deadline: LEASE, ids: ["a", "b"] } })],
      { failArticle: "a" },
    );
    const r = await collectAnnotateBatches(w.client, {
      enabled: true,
      port: fakePort({ results: resultsOf([ok("a"), ok("b")]) }).port,
    });
    expect(r).toMatchObject({ attempted: 2, applied: 1, charged: 1 });
    const settle = w.calls.find((c) => isRpc(c, "settle_summary_attempts")) as {
      args: { charged: { id: string; error: string }[] };
    };
    expect(settle.args.charged).toEqual([{ id: "a", error: "update boom" }]);
  });

  it("回収待ちの一覧を読めなければ listError で返す", async () => {
    const w = collectWorld([], { listError: true });
    const r = await collectAnnotateBatches(w.client, { enabled: true, port: fakePort().port });
    expect(r).toMatchObject({ skipped: false, listError: "list boom", open: 0 });
  });

  it("settle の失敗は settleError に残し、台帳の last_error にも書く", async () => {
    const w = collectWorld(
      [openRow({ selection: { mode: "batch", lease_deadline: LEASE, ids: ["a", "b"] } })],
      { settle: { error: { message: "settle boom" } } },
    );
    const r = await collectAnnotateBatches(w.client, {
      enabled: true,
      port: fakePort({ results: resultsOf([ok("a"), errored("b", "invalid_request_error")]) }).port,
    });
    expect(r).toMatchObject({ settleError: "settle boom", returned: 1 });
    const close = w.calls[w.calls.length - 1];
    expect((argOf(close, "update") as [{ last_error: string }])[0].last_error).toBe("settle boom");
  });

  it("台帳を閉じられなかった回は回収済みに数えず、次 run の再回収で閉じる（2 回目の settle は 0 件反映でも障害にしない）", async () => {
    const row = openRow({ selection: { mode: "batch", lease_deadline: LEASE, ids: ["a", "b"] } });
    const items = [ok("a"), errored("b", "invalid_request_error")];

    // 1 回目: 記事は書けたが、台帳の終端（llm_batches.update）に失敗した
    const w1 = collectWorld([row], { ledgerUpdate: { error: { message: "close boom" } } });
    const r1 = await collectAnnotateBatches(w1.client, {
      enabled: true,
      port: fakePort({ results: resultsOf(items) }).port,
    });
    expect(r1).toMatchObject({ applied: 1, returned: 0, settleError: null });

    // 2 回目: 同じラウンドを読み直す。a は 1 回目で書けているので書き直さずに見送る。
    // 予約は 1 回目の settle で外れているので、所有者チェックで 0 件反映になる
    const w2 = collectWorld([row], {
      settle: { data: { charged: 0, released: 0 } },
      summarized: ["a"],
    });
    const r2 = await collectAnnotateBatches(w2.client, {
      enabled: true,
      port: fakePort({ results: resultsOf(items) }).port,
    });
    expect(r2).toMatchObject({ applied: 0, superseded: 1, returned: 1, settleError: null });
    expect(w2.calls.map(callName)).not.toContain("articles.update");
    expect(isCollectDead(r2)).toBe(false);
    const settle = w2.calls.find((c) => isRpc(c, "settle_summary_attempts")) as {
      args: { lease_deadline: string };
    };
    expect(settle.args.lease_deadline).toBe(LEASE);
  });

  it("予約が切れた後の回収は、別のラウンドが先に要約した記事を上書きせず、タグも足さない", async () => {
    const w = collectWorld(
      [openRow({ selection: { mode: "batch", lease_deadline: LEASE, ids: ["a", "b"] } })],
      { summarized: ["a"] },
    );
    const r = await collectAnnotateBatches(w.client, {
      enabled: true,
      port: fakePort({ results: resultsOf([ok("a"), ok("b")]) }).port,
    });
    expect(r).toMatchObject({ attempted: 2, applied: 1, superseded: 1, charged: 0, released: 1 });
    // b だけを書く（a にはタグの upsert も要約の update も出さない）
    const tagged = w.calls
      .filter((c) => isFrom(c, "article_tags", "upsert"))
      .flatMap((c) => (argOf(c, "upsert")![0] as { article_id: string }[]).map((t) => t.article_id));
    expect(tagged).toEqual(["b"]);
    const updated = w.calls.filter((c) => isFrom(c, "articles", "update")).map((c) => argOf(c, "eq"));
    expect(updated).toEqual([["id", "b"]]);
    const settle = w.calls.find((c) => isRpc(c, "settle_summary_attempts")) as {
      args: { charged: unknown[]; released: unknown[] };
    };
    expect(settle.args).toMatchObject({ charged: [], released: [{ id: "a", error: "already_summarized" }] });
    const close = w.calls[w.calls.length - 1];
    expect((argOf(close, "update") as [{ applied: number; last_error: string }])[0]).toMatchObject({
      applied: 1,
      last_error: "already_summarized: 1",
    });
  });

  it("要約済みかを確かめられなければ 1 件も書かずに unresolved にする", async () => {
    const w = collectWorld([openRow()], { summarizedError: true });
    const r = await collectAnnotateBatches(w.client, {
      enabled: true,
      port: fakePort({ results: resultsOf([ok("a"), ok("b")]) }).port,
    });
    expect(r).toMatchObject({ unresolved: 1, applied: 0, returned: 0, attempted: 0 });
    expect(w.calls.map(callName)).toEqual([
      "llm_batches.select",
      "articles.select",
      "llm_batches.update",
    ]);
    expect(argOf(w.calls[2], "update")).toEqual([
      { status: "unresolved", last_error: "summarized: summarized boom" },
    ]);
  });
});
