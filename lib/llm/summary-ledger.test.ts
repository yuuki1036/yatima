import { describe, expect, it } from "vitest";
import { buildClosePatch, buildSelection, tallyUsage } from "./summary-ledger";

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
