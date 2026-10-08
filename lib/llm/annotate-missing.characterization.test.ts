import { describe, expect, it } from "vitest";
import { BadRequestError, RateLimitError } from "@anthropic-ai/sdk";
import type { Summarizer } from "./types";
import { annotateMissing } from "./summarize-batch";
import {
  argOf,
  callName,
  createRecorder,
  isFrom,
  isRpc,
  type RecordedCall,
  type StubResponse,
} from "./supabase-recorder.testkit";

// 同期経路 annotateMissing の特性テスト（YAT-79）。
// Batches 移行で台帳・予約・書き込みを共有モジュールへ移すとき、同期経路（SUMMARIZE_BATCH_CAP=0 の
// ロールバック先）の戻り値と I/O の順序が変わらないことを固定する。期待値は移行前のコードの実際の
// 振る舞いから取った（ADR-20260906205226「annotateMissing の挙動は変えない」）。

const LEASE = "2026-10-10T12:00:00.000Z";
const H = () => new Headers();

// タイトルで振る舞いを決める Summarizer。
const summarizer: Summarizer = {
  summarize: async () => "unused",
  annotate: async ({ title }) => {
    if (title === "bad")
      throw new BadRequestError(400, { type: "invalid_request_error" }, "invalid_request_error", H());
    if (title === "rate") throw new RateLimitError(429, undefined, "rate_limited", H());
    return { summary: `要約-${title}`, tags: ["tech/ai"] };
  },
};

const row = (id: string, title: string) => ({ id, title, content_html: `<p>${title} の本文</p>` });

type World = {
  usage?: StubResponse;
  claim?: StubResponse;
  insert?: StubResponse;
  fetch?: StubResponse;
  settle?: StubResponse;
};

function world(w: World = {}) {
  return createRecorder((c: RecordedCall) => {
    if (isFrom(c, "llm_batches", "insert")) return w.insert ?? { data: { id: "L1" } };
    if (isFrom(c, "llm_batches", "update")) return {};
    if (isFrom(c, "llm_batches", "select")) return w.usage ?? { data: [{ request_count: 40 }] };
    if (isRpc(c, "claim_summary_candidates"))
      return (
        w.claim ?? {
          data: { pool: 9, pool_capped: true, ids: ["a", "b", "c"], lease_deadline: LEASE },
        }
      );
    if (isFrom(c, "articles", "select"))
      return w.fetch ?? { data: [row("a", "ok"), row("b", "bad"), row("c", "rate")] };
    if (isRpc(c, "settle_summary_attempts")) {
      if (w.settle) return w.settle;
      const a = (c as { args: { charged: unknown[]; released: unknown[] } }).args;
      return { data: { charged: a.charged.length, released: a.released.length } };
    }
    return {};
  });
}

const run = (client: ReturnType<typeof world>["client"], limit?: number) =>
  annotateMissing(client, { summarizer, runKind: "cron", ...(limit === undefined ? {} : { limit }) });

const BASE = {
  pool: 0,
  poolCapped: false,
  selected: 0,
  succeeded: 0,
  failed: 0,
  charged: 0,
  released: 0,
  dailyUsed: 0,
  dailyCap: 120,
  poolError: null,
  ledgerError: null,
  settleError: null,
  capUnavailable: false,
};

describe("annotateMissing（特性テスト）", () => {
  it("API キーが無ければ DB に触らず no_api_key で見送る", async () => {
    const w = world();
    const r = await annotateMissing(w.client, { summarizer: null });
    expect(r).toEqual({ ...BASE, skipped: true, skipReason: "no_api_key" });
    expect(w.calls).toEqual([]);
  });

  it("台帳 read の失敗は capUnavailable（pool=-1）で見送り、claim しない", async () => {
    const w = world({ usage: { error: { message: "boom" } } });
    const r = await run(w.client);
    expect(r).toEqual({ ...BASE, skipped: false, pool: -1, capUnavailable: true });
    expect(w.calls.map(callName)).toEqual(["llm_batches.select"]);
  });

  it("当日合計が 120 なら daily_capped で見送る（YAT-78 の日次上限）", async () => {
    const w = world({ usage: { data: [{ request_count: 100 }, { request_count: 20 }] } });
    const r = await run(w.client);
    expect(r).toEqual({ ...BASE, skipped: true, skipReason: "daily_capped", dailyUsed: 120 });
    expect(w.calls.map(callName)).toEqual(["llm_batches.select"]);
  });

  it("当日の台帳は purpose=summarize ∧ UTC 0 時以降で数え、max_rows は日次残枠で切る", async () => {
    const w = world({
      usage: { data: [{ request_count: 110 }, { request_count: null }] },
      claim: { data: { pool: 0, pool_capped: false, ids: [], lease_deadline: LEASE } },
    });
    await run(w.client);
    const sel = w.calls[0];
    // YAT-79 で宣言した差分 (a): Batches の行を見分けるため selection も読む（合計の値は同じ）。
    expect(argOf(sel, "select")).toEqual(["request_count, selection"]);
    expect(argOf(sel, "eq")).toEqual(["purpose", "summarize"]);
    const gte = argOf(sel, "gte") as [string, string];
    expect(gte[0]).toBe("submitted_at");
    expect(gte[1]).toMatch(/T00:00:00\.000Z$/);
    expect(w.calls[1]).toEqual({
      kind: "rpc",
      fn: "claim_summary_candidates",
      // YAT-79 で宣言した差分 (b): lease_hours を明示して渡す（0017 の既定 30 と同じ値）。
      args: { per_feed: 4, max_rows: 10, lease_hours: 30 },
    });
  });

  it("Batches の行も当日合計に数える（同じ run で Batches が先に投入した分を二重に引かない）", async () => {
    const w = world({
      usage: { data: [{ request_count: 20, selection: { mode: "batch" } }, { request_count: 95 }] },
      claim: { data: { pool: 0, pool_capped: false, ids: [], lease_deadline: LEASE } },
    });
    const r = await run(w.client);
    expect(r.dailyUsed).toBe(115);
    expect((w.calls[1] as { args: { max_rows: number } }).args.max_rows).toBe(5);
  });

  it("この run の枠が 0 なら台帳も読まずに no_run_budget で見送る（YAT-79）", async () => {
    const w = world();
    const r = await run(w.client, 0);
    expect(r).toEqual({ ...BASE, skipped: true, skipReason: "no_run_budget" });
    expect(w.calls).toEqual([]);
  });

  it("claim の失敗は poolError（pool=-1）", async () => {
    const w = world({ claim: { error: { message: "timeout" } } });
    const r = await run(w.client);
    expect(r).toEqual({ ...BASE, skipped: false, pool: -1, poolError: "timeout", dailyUsed: 40 });
    expect(w.calls.map(callName)).toEqual(["llm_batches.select", "rpc:claim_summary_candidates"]);
  });

  it("予約 0 件なら台帳を作らず pool をそのまま返す", async () => {
    const w = world({ claim: { data: { pool: 5, pool_capped: false, ids: [], lease_deadline: LEASE } } });
    const r = await run(w.client);
    expect(r).toEqual({ ...BASE, skipped: false, pool: 5, dailyUsed: 40 });
    expect(w.calls.map(callName)).toEqual(["llm_batches.select", "rpc:claim_summary_candidates"]);
  });

  it("台帳 insert の失敗は LLM を呼ばずに全件 released で解放し ledgerError", async () => {
    const w = world({ insert: { error: { message: "denied" } } });
    const r = await run(w.client);
    expect(r).toEqual({
      ...BASE,
      skipped: false,
      pool: 9,
      poolCapped: true,
      selected: 3,
      released: 3,
      ledgerError: "denied",
      dailyUsed: 40,
    });
    expect(w.calls.map(callName)).toEqual([
      "llm_batches.select",
      "rpc:claim_summary_candidates",
      "llm_batches.insert",
      "rpc:settle_summary_attempts",
    ]);
    expect(w.calls[3]).toEqual({
      kind: "rpc",
      fn: "settle_summary_attempts",
      args: {
        charged: [],
        released: ["a", "b", "c"].map((id) => ({ id, error: "ledger_insert_failed" })),
        lease_deadline: LEASE,
      },
    });
  });

  it("対象 select の失敗は予約を解放して台帳を終端し、poolError で返す", async () => {
    const w = world({ fetch: { error: { message: "fetch boom" } } });
    const r = await run(w.client);
    expect(r).toEqual({
      ...BASE,
      skipped: false,
      pool: 9,
      poolCapped: true,
      selected: 3,
      released: 3,
      poolError: "fetch boom",
      dailyUsed: 40,
    });
    expect(w.calls.map(callName)).toEqual([
      "llm_batches.select",
      "rpc:claim_summary_candidates",
      "llm_batches.insert",
      "articles.select",
      "rpc:settle_summary_attempts",
      "llm_batches.update",
    ]);
    expect((w.calls[4] as { args: { released: unknown } }).args.released).toEqual(
      ["a", "b", "c"].map((id) => ({ id, error: "fetch_failed" })),
    );
    expect(argOf(w.calls[5], "update")).toEqual([
      {
        status: "collected",
        succeeded: 0,
        errored: 0,
        applied: 0,
        ended_at: expect.any(String),
        collected_at: expect.any(String),
        last_error: "fetch boom",
      },
    ]);
    expect(argOf(w.calls[5], "eq")).toEqual(["id", "L1"]);
  });

  it("成功・400・429 の混在: タグ→要約の順で書き、証人ありなので 400 だけ課金する", async () => {
    const w = world();
    const r = await run(w.client);
    expect(r).toEqual({
      ...BASE,
      skipped: false,
      pool: 9,
      poolCapped: true,
      selected: 3,
      succeeded: 1,
      failed: 2,
      charged: 1,
      released: 1,
      dailyUsed: 40,
    });
    expect(w.calls.map(callName)).toEqual([
      "llm_batches.select",
      "rpc:claim_summary_candidates",
      "llm_batches.insert",
      "articles.select",
      "article_tags.upsert",
      "articles.update",
      "rpc:settle_summary_attempts",
      "llm_batches.update",
    ]);
    expect(argOf(w.calls[2], "insert")).toEqual([
      {
        purpose: "summarize",
        batch_id: null,
        status: "claimed",
        model: "claude-haiku-4-5",
        request_count: 3,
        run_kind: "cron",
        selection: { pool: 9, pool_capped: true, per_feed: 4, max_rows: 20, picked: 3 },
      },
    ]);
    expect(argOf(w.calls[3], "in")).toEqual(["id", ["a", "b", "c"]]);
    expect(argOf(w.calls[4], "upsert")).toEqual([
      [{ article_id: "a", tag_slug: "tech/ai", source: "llm" }],
      { onConflict: "article_id,tag_slug", ignoreDuplicates: true },
    ]);
    expect(argOf(w.calls[5], "update")).toEqual([
      {
        summary: "要約-ok",
        summarized_at: expect.any(String),
        summary_reserved_until: null,
        summary_batch_id: null,
      },
    ]);
    expect(argOf(w.calls[5], "eq")).toEqual(["id", "a"]);
    expect(w.calls[6]).toEqual({
      kind: "rpc",
      fn: "settle_summary_attempts",
      args: {
        charged: [{ id: "b", error: '400 {"type":"invalid_request_error"}' }],
        released: [{ id: "c", error: "429 rate_limited" }],
        lease_deadline: LEASE,
      },
    });
    expect(argOf(w.calls[7], "update")).toEqual([
      {
        status: "collected",
        succeeded: 1,
        errored: 2,
        applied: 1,
        ended_at: expect.any(String),
        collected_at: expect.any(String),
        last_error: null,
      },
    ]);
  });

  it("全滅ラウンドは証人がいないので誰も課金しない", async () => {
    const w = world({ fetch: { data: [row("b", "bad"), row("c", "rate")] } });
    const r = await run(w.client);
    expect(r).toMatchObject({ succeeded: 0, failed: 2, charged: 0, released: 2 });
    const settle = w.calls.find((c) => isRpc(c, "settle_summary_attempts")) as {
      args: { charged: unknown[]; released: { id: string }[] };
    };
    expect(settle.args.charged).toEqual([]);
    expect(settle.args.released.map((e) => e.id)).toEqual(["b", "c"]);
  });

  it("settle の失敗は settleError に残し、台帳の last_error にも書く", async () => {
    const w = world({ settle: { error: { message: "settle boom" } } });
    const r = await run(w.client);
    expect(r).toMatchObject({ settleError: "settle boom", charged: 1, released: 1 });
    const close = w.calls[w.calls.length - 1];
    expect(callName(close)).toBe("llm_batches.update");
    expect((argOf(close, "update") as [{ last_error: string }])[0].last_error).toBe("settle boom");
  });
});
