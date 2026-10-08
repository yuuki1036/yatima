import { describe, expect, it } from "vitest";
import {
  BATCH_LEASE_HOURS,
  BATCH_STUCK_HOURS,
  DAILY_SUMMARIZE_CAP,
  MAX_INFLIGHT_BATCHES,
  PER_RUN_MAX,
  STALE_LEDGER_HOURS,
  SYNC_LEASE_HOURS,
  parseBatchEnv,
  planBatchSubmit,
  planSyncRun,
  syncLimitAfterSubmit,
  utcDayStartIso,
} from "./summarize-policy";

// YAT-79: Batches と同期の配分。値はシンボルでなくリテラルで固定する（定数が動いてもテストが
// 追従して通る、を避ける）。

describe("定数", () => {
  it("値を固定する", () => {
    expect(DAILY_SUMMARIZE_CAP).toBe(120);
    expect(PER_RUN_MAX).toBe(20);
    expect(SYNC_LEASE_HOURS).toBe(30);
    expect(BATCH_LEASE_HOURS).toBe(36);
    expect(MAX_INFLIGHT_BATCHES).toBe(12);
  });

  it("Batches の予約・停滞判定・掃除は同じ長さ（予約が停滞判定より先に切れない）", () => {
    expect(BATCH_STUCK_HOURS).toBe(BATCH_LEASE_HOURS);
    expect(STALE_LEDGER_HOURS).toBe(BATCH_LEASE_HOURS);
  });
});

describe("parseBatchEnv", () => {
  it("未設定・空・空白は 0（全件同期）で、不正扱いにしない", () => {
    for (const v of [undefined, "", "  "]) {
      expect(parseBatchEnv({ SUMMARIZE_BATCH_CAP: v })).toMatchObject({ cap: 0, capInvalid: false });
    }
  });

  it("数として読めない値は 0 に倒し、不正として印を付ける", () => {
    for (const v of ["abc", "-5", "20.5", "1e2"]) {
      expect(parseBatchEnv({ SUMMARIZE_BATCH_CAP: v })).toMatchObject({ cap: 0, capInvalid: true });
    }
  });

  it("0 以上の整数はそのまま、日次上限を超える値は 120 で頭打ち", () => {
    expect(parseBatchEnv({ SUMMARIZE_BATCH_CAP: "0" }).cap).toBe(0);
    expect(parseBatchEnv({ SUMMARIZE_BATCH_CAP: " 20 " }).cap).toBe(20);
    expect(parseBatchEnv({ SUMMARIZE_BATCH_CAP: "120" }).cap).toBe(120);
    expect(parseBatchEnv({ SUMMARIZE_BATCH_CAP: "500" }).cap).toBe(120);
  });

  it('回収は "0" のときだけ止める', () => {
    expect(parseBatchEnv({}).collectEnabled).toBe(true);
    expect(parseBatchEnv({ SUMMARIZE_BATCH_COLLECT: "" }).collectEnabled).toBe(true);
    expect(parseBatchEnv({ SUMMARIZE_BATCH_COLLECT: "1" }).collectEnabled).toBe(true);
    expect(parseBatchEnv({ SUMMARIZE_BATCH_COLLECT: " 0 " }).collectEnabled).toBe(false);
  });
});

describe("utcDayStartIso", () => {
  it("UTC の 0 時に切る（JST の日付ではない）", () => {
    expect(utcDayStartIso(Date.parse("2026-10-09T23:30:00+09:00"))).toBe(
      "2026-10-09T00:00:00.000Z",
    );
    expect(utcDayStartIso(Date.parse("2026-10-10T08:59:00+09:00"))).toBe(
      "2026-10-09T00:00:00.000Z",
    );
  });
});

describe("planBatchSubmit", () => {
  const plan = (cap: number, total: number, batch: number, inflight = 0) =>
    planBatchSubmit({ cap, usage: { total, batch }, inflight });

  it("Batches の当日枠・日次の残り・1 run の上限の小さい方を投入する", () => {
    expect(plan(20, 0, 0)).toEqual({ submit: true, maxRows: 20 });
    expect(plan(20, 15, 15)).toEqual({ submit: true, maxRows: 5 });
    expect(plan(120, 110, 0)).toEqual({ submit: true, maxRows: 10 });
    expect(plan(60, 40, 40)).toEqual({ submit: true, maxRows: 20 });
  });

  it("Batches の当日枠を使い切ったら batch_capped", () => {
    expect(plan(20, 20, 20)).toEqual({ submit: false, reason: "batch_capped" });
  });

  it("日次上限に達したら daily_capped（Batches の枠が残っていても）", () => {
    expect(plan(120, 120, 0)).toEqual({ submit: false, reason: "daily_capped" });
  });

  it("未回収が 12 本に達したら inflight_cap（他の理由より優先）", () => {
    expect(plan(20, 0, 0, 11)).toEqual({ submit: true, maxRows: 20 });
    expect(plan(20, 0, 0, 12)).toEqual({ submit: false, reason: "inflight_cap" });
    expect(plan(120, 120, 0, 12)).toEqual({ submit: false, reason: "inflight_cap" });
  });
});

describe("syncLimitAfterSubmit / planSyncRun", () => {
  it("同期は 1 run の残り枠だけ使う", () => {
    expect(syncLimitAfterSubmit(0)).toBe(20);
    expect(syncLimitAfterSubmit(15)).toBe(5);
    expect(syncLimitAfterSubmit(20)).toBe(0);
    expect(syncLimitAfterSubmit(25)).toBe(0);
  });

  it("残り枠 0 は no_run_budget、日次上限は daily_capped、それ以外は小さい方", () => {
    expect(planSyncRun(0, 0)).toEqual({ run: false, reason: "no_run_budget" });
    expect(planSyncRun(20, 120)).toEqual({ run: false, reason: "daily_capped" });
    expect(planSyncRun(20, 110)).toEqual({ run: true, maxRows: 10 });
    expect(planSyncRun(5, 0)).toEqual({ run: true, maxRows: 5 });
  });
});

// 1 日を run 単位で模擬する（候補は常に足りる前提）。YAT-78 の申し送り「CAP=20 段階で daily_capped
// が発火する」は成り立たないことをここで固定する: CAP は Batches の内数なので 1 日の合計は変わらず、
// daily_capped は 1 日 7 run 以上ある日にしか起きない（実測の発火は 4〜5 回/日）。
function simulateDay(cap: number, runs: number) {
  const usage = { total: 0, batch: 0 };
  const out: { batch: number | string; sync: number | string }[] = [];
  for (let i = 0; i < runs; i++) {
    const p = cap <= 0 ? null : planBatchSubmit({ cap, usage, inflight: 0 });
    const reserved = p && p.submit ? p.maxRows : 0;
    usage.total += reserved;
    usage.batch += reserved;
    const s = planSyncRun(syncLimitAfterSubmit(reserved), usage.total);
    if (s.run) usage.total += s.maxRows;
    out.push({
      batch: p === null ? "disabled" : p.submit ? p.maxRows : p.reason,
      sync: s.run ? s.maxRows : s.reason,
    });
  }
  return { out, usage };
}

describe("1 日の配分（模擬）", () => {
  it("CAP=0 は全件同期で、7 run 目に daily_capped", () => {
    const { out, usage } = simulateDay(0, 7);
    expect(out.map((r) => r.sync)).toEqual([20, 20, 20, 20, 20, 20, "daily_capped"]);
    expect(usage).toEqual({ total: 120, batch: 0 });
  });

  it("CAP=20 は最初の run だけ Batches、合計は変わらず 7 run 目に daily_capped", () => {
    const { out, usage } = simulateDay(20, 7);
    expect(out).toEqual([
      { batch: 20, sync: "no_run_budget" },
      { batch: "batch_capped", sync: 20 },
      { batch: "batch_capped", sync: 20 },
      { batch: "batch_capped", sync: 20 },
      { batch: "batch_capped", sync: 20 },
      { batch: "batch_capped", sync: 20 },
      { batch: "daily_capped", sync: "daily_capped" },
    ]);
    expect(usage).toEqual({ total: 120, batch: 20 });
  });

  it("CAP=20 でも 1 日 5 run なら daily_capped は起きない（合計 100）", () => {
    const { out, usage } = simulateDay(20, 5);
    expect(out.some((r) => r.batch === "daily_capped" || r.sync === "daily_capped")).toBe(false);
    expect(usage.total).toBe(100);
  });

  it("CAP=120 は全件 Batches で、同期は毎 run no_run_budget", () => {
    const { out, usage } = simulateDay(120, 7);
    expect(out.slice(0, 6)).toEqual(Array(6).fill({ batch: 20, sync: "no_run_budget" }));
    expect(out[6]).toEqual({ batch: "daily_capped", sync: "daily_capped" });
    expect(usage).toEqual({ total: 120, batch: 120 });
  });
});
