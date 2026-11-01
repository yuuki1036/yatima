import { describe, expect, it } from "vitest";
import {
  applyAnnotation,
  buildClosePatch,
  buildSelection,
  findSummarized,
  listOpenBatchRounds,
  openSummaryRound,
  parseRoundSelection,
  readBatchBacklog,
  recordBatchCreate,
  resolveStaleLedger,
  tallyUsage,
} from "./summary-ledger";
import { argOf, callName, createRecorder, isFrom, isRpc } from "./supabase-recorder.testkit";
import type { Annotation } from "./types";

// 台帳（llm_batches）に書く形と読む形の契約（YAT-79）。同期の行の形は YAT-78 から変えない。

describe("tallyUsage", () => {
  it("selection.mode が batch の行だけを Batches に数え、mode の無い行は同期として数える", () => {
    expect(
      tallyUsage([
        { request_count: 20, selection: { mode: "batch" } },
        { request_count: 5, selection: { pool: 1 } },
        { request_count: null, selection: null },
        { request_count: 3, selection: { mode: "sync" } },
      ]),
    ).toEqual({ total: 28, batch: 20 });
  });
});

describe("buildSelection", () => {
  const claim = {
    pool: 9,
    poolCapped: true,
    maxRows: 20,
    ids: ["a", "b"],
    leaseDeadline: "2026-10-10T12:00:00.000Z",
  };

  it("同期は YAT-78 の 5 キーのまま", () => {
    expect(buildSelection("sync", claim, 30)).toEqual({
      pool: 9,
      pool_capped: true,
      per_feed: 4,
      max_rows: 20,
      picked: 2,
    });
  });

  it("Batches は collect が予約を解くための lease_deadline と ids を持つ", () => {
    expect(buildSelection("batch", claim, 36)).toEqual({
      pool: 9,
      pool_capped: true,
      per_feed: 4,
      max_rows: 20,
      picked: 2,
      mode: "batch",
      lease_hours: 36,
      lease_deadline: "2026-10-10T12:00:00.000Z",
      ids: ["a", "b"],
    });
  });
});

describe("buildClosePatch", () => {
  const NOW = "2026-10-09T03:00:00.000Z";

  it("同期は YAT-78 の 7 キーのまま（ended_at は今）", () => {
    expect(
      buildClosePatch({ succeeded: 1, errored: 2, applied: 1, lastError: null }, NOW),
    ).toEqual({
      status: "collected",
      succeeded: 1,
      errored: 2,
      applied: 1,
      ended_at: NOW,
      collected_at: NOW,
      last_error: null,
    });
  });

  it("Batches はバッチの ended_at・期限切れ・取消・トークン数も書く", () => {
    expect(
      buildClosePatch(
        {
          succeeded: 18,
          errored: 1,
          applied: 17,
          lastError: null,
          expired: 1,
          canceled: 0,
          inputTokens: 40000,
          outputTokens: 9000,
          endedAt: "2026-10-09T01:10:00.000Z",
        },
        NOW,
      ),
    ).toEqual({
      status: "collected",
      succeeded: 18,
      errored: 1,
      applied: 17,
      ended_at: "2026-10-09T01:10:00.000Z",
      collected_at: NOW,
      last_error: null,
      expired: 1,
      canceled: 0,
      input_tokens: 40000,
      output_tokens: 9000,
    });
  });
});

describe("parseRoundSelection", () => {
  const sel = {
    mode: "batch",
    lease_hours: 36,
    lease_deadline: "2026-10-10T12:00:00.000Z",
    ids: ["a", "b"],
  };

  it("buildSelection が書いた Batches の selection を読み戻せる", () => {
    const written = buildSelection(
      "batch",
      { pool: 1, poolCapped: false, maxRows: 2, ids: ["a", "b"], leaseDeadline: sel.lease_deadline },
      36,
    );
    expect(parseRoundSelection(written)).toEqual({
      ok: true,
      ids: ["a", "b"],
      leaseDeadline: "2026-10-10T12:00:00.000Z",
    });
  });

  it("同期の selection・ids や lease_deadline を欠いたものは読めない", () => {
    expect(parseRoundSelection({ pool: 1, picked: 1 }).ok).toBe(false);
    expect(parseRoundSelection(null).ok).toBe(false);
    expect(parseRoundSelection({ ...sel, ids: [] }).ok).toBe(false);
    expect(parseRoundSelection({ ...sel, ids: "a" }).ok).toBe(false);
    expect(parseRoundSelection({ ...sel, lease_deadline: undefined }).ok).toBe(false);
    expect(parseRoundSelection({ ...sel, lease_deadline: "" }).ok).toBe(false);
  });
});

describe("openSummaryRound", () => {
  it("claim の応答に lease_deadline が無ければ claim_failed で返し、台帳にも進まない", async () => {
    const w = createRecorder((c) =>
      isRpc(c, "claim_summary_candidates") ? { data: { pool: 3, ids: ["a"] } } : {},
    );
    const r = await openSummaryRound(w.client, {
      mode: "batch",
      runKind: "cron",
      maxRows: 20,
      leaseHours: 36,
    });
    expect(r).toEqual({ kind: "claim_failed", error: "claim の応答に lease_deadline が無い" });
    expect(w.calls.map(callName)).toEqual(["rpc:claim_summary_candidates"]);
  });
});

describe("applyAnnotation", () => {
  const a: Annotation = { summary: "要点", tags: ["tech/ai"] };

  it("既定（同期）は id だけで書く", async () => {
    const w = createRecorder(() => ({}));
    expect(await applyAnnotation(w.client, "a", a)).toBe(true);
    const up = w.calls.find((c) => isFrom(c, "articles", "update"))!;
    expect(argOf(up, "is")).toBeUndefined();
  });

  it("ifUnsummarized は summary IS NULL のときだけ書き、別の書き手が先に書いていれば false", async () => {
    const hit = createRecorder((c) => (isFrom(c, "articles", "update") ? { data: [{ id: "a" }] } : {}));
    expect(await applyAnnotation(hit.client, "a", a, { ifUnsummarized: true })).toBe(true);
    const up = hit.calls.find((c) => isFrom(c, "articles", "update"))!;
    expect(argOf(up, "is")).toEqual(["summary", null]);
    expect(argOf(up, "select")).toEqual(["id"]);

    const lost = createRecorder((c) => (isFrom(c, "articles", "update") ? { data: [] } : {}));
    expect(await applyAnnotation(lost.client, "a", a, { ifUnsummarized: true })).toBe(false);
  });
});

const round = { ledgerId: "L1", ids: ["a", "b"], leaseDeadline: "2026-10-10T12:00:00.000Z" };

describe("recordBatchCreate", () => {
  it("成功なら claimed の行にだけ batch_id と submitted を書く", async () => {
    const w = createRecorder(() => ({}));
    const r = await recordBatchCreate(w.client, round, { ok: true, batchId: "msgbatch_1" });
    expect(r).toEqual({ ledgerWriteError: null });
    expect(w.calls.map(callName)).toEqual(["llm_batches.update"]);
    expect(argOf(w.calls[0], "update")).toEqual([{ batch_id: "msgbatch_1", status: "submitted" }]);
    const c = w.calls[0] as { chain: { method: string; args: unknown[] }[] };
    expect(c.chain.filter((s) => s.method === "eq").map((s) => s.args)).toEqual([
      ["id", "L1"],
      ["status", "claimed"],
    ]);
  });

  it("batch_id を書けなければ ledgerWriteError（孤児）", async () => {
    const w = createRecorder(() => ({ error: { message: "denied" } }));
    expect(await recordBatchCreate(w.client, round, { ok: true, batchId: "msgbatch_1" })).toEqual({
      ledgerWriteError: "denied",
    });
  });

  it("作成に失敗したらその場で予約を解放し、台帳を expired_unknown で終端する", async () => {
    const w = createRecorder((c) =>
      isRpc(c, "settle_summary_attempts") ? { data: { charged: 0, released: 2 } } : {},
    );
    await recordBatchCreate(w.client, round, { ok: false, error: "timeout" });
    expect(w.calls.map(callName)).toEqual(["rpc:settle_summary_attempts", "llm_batches.update"]);
    expect(w.calls[0]).toEqual({
      kind: "rpc",
      fn: "settle_summary_attempts",
      args: {
        charged: [],
        released: [
          { id: "a", error: "batch_create_failed: timeout" },
          { id: "b", error: "batch_create_failed: timeout" },
        ],
        lease_deadline: "2026-10-10T12:00:00.000Z",
      },
    });
    expect(argOf(w.calls[1], "update")).toEqual([
      { status: "expired_unknown", resolved_at: expect.any(String), last_error: "create_failed: timeout" },
    ]);
  });
});

describe("resolveStaleLedger", () => {
  const NOW = Date.parse("2026-10-09T12:00:00Z");

  it("36h を超えた claimed だけを対象にし、Batches の行は予約を解放してから終端する", async () => {
    const w = createRecorder((c) => {
      if (isFrom(c, "llm_batches", "update")) return {};
      if (isFrom(c, "llm_batches", "select"))
        return {
          data: [
            { id: "B1", selection: { mode: "batch", ids: ["a"], lease_deadline: "LD" } },
            { id: "S1", selection: { pool: 1 } },
          ],
        };
      if (isRpc(c, "settle_summary_attempts")) return { data: { charged: 0, released: 1 } };
      return {};
    });
    const r = await resolveStaleLedger(w.client, NOW);
    expect(r).toEqual({
      resolved: [
        { ledgerId: "B1", isBatch: true },
        { ledgerId: "S1", isBatch: false },
      ],
      error: null,
    });
    expect(w.calls.map(callName)).toEqual([
      "llm_batches.select",
      "rpc:settle_summary_attempts",
      "llm_batches.update",
    ]);
    expect(argOf(w.calls[0], "eq")).toEqual(["purpose", "summarize"]);
    expect(argOf(w.calls[0], "lt")).toEqual(["submitted_at", "2026-10-08T00:00:00.000Z"]);
    const statusEq = (w.calls[0] as { chain: { method: string; args: unknown[] }[] }).chain.filter(
      (s) => s.method === "eq",
    );
    expect(statusEq.map((s) => s.args)).toContainEqual(["status", "claimed"]);
    expect(argOf(w.calls[2], "in")).toEqual(["id", ["B1", "S1"]]);
    // Batches の行は selection の lease_deadline で予約の痕跡を書いて解放する
    expect(w.calls[1]).toEqual({
      kind: "rpc",
      fn: "settle_summary_attempts",
      args: { charged: [], released: [{ id: "a", error: "stale_claimed" }], lease_deadline: "LD" },
    });
    // 終端は expired_unknown。update 側でも claimed に限る（他経路で既に動いた行を巻き戻さない）
    expect(argOf(w.calls[2], "update")).toEqual([
      { status: "expired_unknown", resolved_at: "2026-10-09T12:00:00.000Z", last_error: "stale_claimed" },
    ]);
    const updEq = (w.calls[2] as { chain: { method: string; args: unknown[] }[] }).chain.filter(
      (s) => s.method === "eq",
    );
    expect(updEq.map((s) => s.args)).toEqual([["status", "claimed"]]);
  });

  it("対象が無ければ何も書かない", async () => {
    const w = createRecorder(() => ({ data: [] }));
    expect(await resolveStaleLedger(w.client, NOW)).toEqual({ resolved: [], error: null });
    expect(w.calls.map(callName)).toEqual(["llm_batches.select"]);
  });
});

describe("readBatchBacklog", () => {
  const chainOf = (c: unknown) =>
    (c as { chain: { method: string; args: unknown[] }[] }).chain.map((s) => [s.method, ...s.args]);

  it("未回収（submitted / unresolved）の Batches 行を古い順に 1 件だけ引き、件数は count で数える", async () => {
    const w = createRecorder(() => ({ data: [{ submitted_at: "2026-10-08T01:00:00Z" }], count: 3 }));
    expect(await readBatchBacklog(w.client)).toEqual({
      ok: true,
      open: 3,
      oldestSubmittedAt: "2026-10-08T01:00:00Z",
    });
    // unresolved を外すと回収が恒常的に失敗している行が batchStuck と inflight_cap から消える
    expect(chainOf(w.calls[0])).toEqual([
      ["select", "submitted_at", { count: "exact" }],
      ["eq", "purpose", "summarize"],
      ["is", "collected_at", null],
      ["in", "status", ["submitted", "unresolved"]],
      ["order", "submitted_at", { ascending: true }],
      ["limit", 1],
    ]);
  });

  it("未回収が無ければ 0 本・最古なし", async () => {
    const w = createRecorder(() => ({ data: [], count: 0 }));
    expect(await readBatchBacklog(w.client)).toEqual({ ok: true, open: 0, oldestSubmittedAt: null });
  });

  it("count が返らなければ取得した行数に倒す", async () => {
    const w = createRecorder(() => ({ data: [{ submitted_at: "x" }], count: null }));
    expect(await readBatchBacklog(w.client)).toMatchObject({ ok: true, open: 1 });
  });

  it("読めなければ ok:false（batchStuck は判定不能として不活性）", async () => {
    const w = createRecorder(() => ({ error: { message: "boom" } }));
    expect(await readBatchBacklog(w.client)).toEqual({ ok: false, error: "boom" });
  });
});

describe("listOpenBatchRounds", () => {
  const chainOf = (c: unknown) =>
    (c as { chain: { method: string; args: unknown[] }[] }).chain.map((s) => [s.method, ...s.args]);
  const sel = { mode: "batch", lease_hours: 36, lease_deadline: "LD", ids: ["a", "b"] };

  it("回収待ち（submitted / unresolved）の Batches 行を古い順に上限 24 本引く", async () => {
    const w = createRecorder(() => ({
      data: [{ id: "L1", batch_id: "msgbatch_1", submitted_at: "2026-10-08T01:00:00Z", selection: sel }],
    }));
    expect(await listOpenBatchRounds(w.client)).toEqual({
      ok: true,
      rounds: [
        {
          round: { ledgerId: "L1", ids: ["a", "b"], leaseDeadline: "LD" },
          batchId: "msgbatch_1",
          submittedAt: "2026-10-08T01:00:00Z",
        },
      ],
      malformed: [],
    });
    // unresolved を外すと、一過性の失敗を 1 回踏んだラウンドが二度と回収されない（課金済みの結果を捨て、
    // 36h 後に同じ記事を取り直して二重課金になる）
    expect(chainOf(w.calls[0])).toEqual([
      ["select", "id, batch_id, submitted_at, selection"],
      ["eq", "purpose", "summarize"],
      ["is", "collected_at", null],
      ["in", "status", ["submitted", "unresolved"]],
      ["order", "submitted_at", { ascending: true }],
      ["limit", 24],
    ]);
  });

  it("batch_id が無い行・selection が読めない行は malformed に分ける", async () => {
    const w = createRecorder(() => ({
      data: [
        { id: "L1", batch_id: null, submitted_at: "x", selection: sel },
        { id: "L2", batch_id: "msgbatch_2", submitted_at: "x", selection: { pool: 1 } },
      ],
    }));
    expect(await listOpenBatchRounds(w.client)).toEqual({
      ok: true,
      rounds: [],
      malformed: [
        { ledgerId: "L1", error: "batch_id が無い" },
        { ledgerId: "L2", error: "Batches の行ではない" },
      ],
    });
  });

  it("読めなければ ok:false", async () => {
    const w = createRecorder(() => ({ error: { message: "boom" } }));
    expect(await listOpenBatchRounds(w.client)).toEqual({ ok: false, error: "boom" });
  });
});

describe("findSummarized", () => {
  const OWN = "2026-10-10T12:00:00.000Z";
  const NOW = Date.parse("2026-10-10T00:00:00.000Z");

  it("要約が埋まっている記事と、自分以外の生きた予約を持つ記事を返す（自分の予約は外す）", async () => {
    const w = createRecorder((c) =>
      argOf(c, "not")
        ? { data: [{ id: "a" }] } // 要約済み（書いた側が予約を外した）
        : {
            data: [
              { id: "b", summary_reserved_until: "2026-10-11T03:00:00+00:00" }, // 取り直した別ラウンド
              { id: "c", summary_reserved_until: "2026-10-10T12:00:00+00:00" }, // 自分の予約（書式違い）
            ],
          },
    );
    const r = await findSummarized(w.client, ["a", "b", "c", "d"], OWN, NOW);
    expect(r).toEqual({ ok: true, ids: new Set(["a", "b"]) });
    expect(argOf(w.calls[0], "in")).toEqual(["id", ["a", "b", "c", "d"]]);
    expect(argOf(w.calls[0], "not")).toEqual(["summary", "is", null]);
    expect(argOf(w.calls[1], "gt")).toEqual(["summary_reserved_until", "2026-10-10T00:00:00.000Z"]);
  });

  it("対象が無ければ DB を引かない", async () => {
    const w = createRecorder(() => ({}));
    expect(await findSummarized(w.client, [], OWN, NOW)).toEqual({ ok: true, ids: new Set() });
    expect(w.calls).toEqual([]);
  });

  it("読めなければ ok:false", async () => {
    const w = createRecorder(() => ({ error: { message: "boom" } }));
    expect(await findSummarized(w.client, ["a"], OWN, NOW)).toEqual({ ok: false, error: "boom" });
  });
});
