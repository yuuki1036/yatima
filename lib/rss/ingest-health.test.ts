import { describe, it, expect } from "vitest";
import {
  findStaleFeeds,
  formatStale,
  isDeckStarved,
  isEmbedDead,
  isEmbedStalled,
  isEmbedGateStuck,
  isEmbedSelectStalled,
  isSelectionDead,
  isQuarantineSurging,
  QUARANTINE_SURGE_LIMIT,
  DECK_STARVED_FLOOR,
  STALE_ALERT_HOURS,
} from "@/lib/rss/ingest-health";
import type { IngestResult } from "@/lib/rss/ingest";

// YAT-68: 「1 本だけ恒常的に落ちている feed」を CI で拾えることを固定する。
// 起票の実例は Import AI（15 日間 HTTP 403）で、全 feed 失敗ではなかったため exit(1) にならず
// 誰も気付かなかった。以下は境界と除外条件の記述であり、閾値の妥当性の保証ではない。

const NOW = Date.parse("2026-08-13T12:00:00Z");
const HOUR_MS = 3_600_000;
const hoursAgo = (h: number) => new Date(NOW - h * HOUR_MS).toISOString();

// 失敗した feed。各テストは必要な列だけ上書きする。
const failed = (over: Partial<IngestResult> = {}): IngestResult => ({
  feedId: "feed-1",
  feedUrl: "https://example.com/feed.xml",
  title: "テストフィード",
  inserted: 0,
  error: "feed を取得できません（HTTP 403）",
  lastFetchedAt: hoursAgo(24),
  createdAt: hoursAgo(24 * 30),
  ...over,
});

describe("findStaleFeeds", () => {
  it("恒常的に失敗している feed を拾う", () => {
    const stale = findStaleFeeds([failed()], NOW);
    expect(stale).toHaveLength(1);
    expect(stale[0].feedId).toBe("feed-1");
    expect(stale[0].error).toContain("403");
  });

  it("成功した feed は last_fetched_at が古くても対象外", () => {
    // ingestAllFeeds が読む行は last_fetched_at を更新する前のスナップショットなので、
    // 今回成功した feed も古い値を持つ。error で先に絞らないとここで誤検知する。
    const ok = failed({ error: undefined, lastFetchedAt: hoursAgo(24 * 15) });
    expect(findStaleFeeds([ok], NOW)).toEqual([]);
  });

  it("失敗しても閾値未満なら鳴らない（単発の瞬断を無視する）", () => {
    const blip = failed({ lastFetchedAt: hoursAgo(STALE_ALERT_HOURS - 1) });
    expect(findStaleFeeds([blip], NOW)).toEqual([]);
  });

  it("閾値ちょうどで鳴る（境界は inclusive）", () => {
    const exact = failed({ lastFetchedAt: hoursAgo(STALE_ALERT_HOURS) });
    expect(findStaleFeeds([exact], NOW)).toHaveLength(1);
  });

  it("一度も成功していない feed は created_at を起点にする", () => {
    const neverOk = failed({
      lastFetchedAt: null,
      createdAt: hoursAgo(STALE_ALERT_HOURS + 1),
    });
    expect(findStaleFeeds([neverOk], NOW)).toHaveLength(1);
  });

  it("追加直後で一度も成功していない feed は初回失敗で鳴らない", () => {
    // 専用の猶予定数を持たず、created_at を起点にすることで新規 feed を守っている。
    const justAdded = failed({ lastFetchedAt: null, createdAt: hoursAgo(1) });
    expect(findStaleFeeds([justAdded], NOW)).toEqual([]);
  });

  it("起点が両方 null の feed は判定を見送る（誤検知で本物を埋めない）", () => {
    const noAnchor = failed({ lastFetchedAt: null, createdAt: null });
    expect(findStaleFeeds([noAnchor], NOW)).toEqual([]);
  });

  it("日付がパースできない feed も見送る", () => {
    const broken = failed({ lastFetchedAt: "not-a-date", createdAt: null });
    expect(findStaleFeeds([broken], NOW)).toEqual([]);
  });

  it("stale が長い順に並ぶ", () => {
    const results = [
      failed({ feedId: "short", lastFetchedAt: hoursAgo(7) }),
      failed({ feedId: "longest", lastFetchedAt: hoursAgo(24 * 15) }),
      failed({ feedId: "mid", lastFetchedAt: hoursAgo(48) }),
    ];
    expect(findStaleFeeds(results, NOW).map((s) => s.feedId)).toEqual([
      "longest",
      "mid",
      "short",
    ]);
  });

  it("成功と失敗が混在しても失敗分だけ拾う", () => {
    const results = [
      failed({ feedId: "ok-1", error: undefined }),
      failed({ feedId: "broken", lastFetchedAt: hoursAgo(24 * 15) }),
      failed({ feedId: "ok-2", error: undefined }),
    ];
    expect(findStaleFeeds(results, NOW).map((s) => s.feedId)).toEqual([
      "broken",
    ]);
  });

  it("閾値は 6 時間（変更時はこのテストを仕様変更として書き換える）", () => {
    expect(STALE_ALERT_HOURS).toBe(6);
  });
});

describe("formatStale", () => {
  it("48 時間未満は時間で出す", () => {
    expect(formatStale(6 * HOUR_MS)).toBe("6.0時間");
    expect(formatStale(47 * HOUR_MS)).toBe("47.0時間");
  });

  it("48 時間以上は日で出す", () => {
    expect(formatStale(48 * HOUR_MS)).toBe("2.0日");
    expect(formatStale(24 * 15 * HOUR_MS)).toBe("15.0日");
  });
});

// ── YAT-76: embed / デッキ供給の静かな死 ─────────────────────────────────────
// 「どの条件の組で赤くなるか」の関係を固定する。閾値の妥当性ではなく、carve-out
// （skip 理由・対象ゼロ・判定不能 -1）が赤に変換されないことが本題。

describe("isEmbedDead", () => {
  it("試みたのに成功 0 なら dead", () => {
    expect(isEmbedDead({ skipped: false, attempted: 16, succeeded: 0 })).toBe(true);
  });

  it("1 件でも成功していれば dead ではない（部分失敗は fail-soft の想定内）", () => {
    expect(isEmbedDead({ skipped: false, attempted: 16, succeeded: 1 })).toBe(false);
  });

  it("対象ゼロは正常（発火しない）", () => {
    expect(isEmbedDead({ skipped: false, attempted: 0, succeeded: 0 })).toBe(false);
  });

  it("締切持ち越しだけで着手ゼロなら dead ではない（YAT-77）", () => {
    // picked=120 でも壁時計で全件 deferred（attempted=0）なら「拾ったのに成功 0」の偽陽性にしない。
    expect(isEmbedDead({ skipped: false, attempted: 0, succeeded: 0 })).toBe(false);
  });

  it("skip した run は判定しない（キー未設定は embedStalled 側が 26h で拾う）", () => {
    expect(isEmbedDead({ skipped: true, attempted: 0, succeeded: 0 })).toBe(false);
  });
});

describe("isEmbedGateStuck", () => {
  it("候補はあるのに選抜 0 件なら stuck（ゲート全閉・day-0 回帰の署名）", () => {
    expect(isEmbedGateStuck({ pending: 500, eligible: 0 })).toBe(true);
  });

  it("ディスク天井 skip は除外（exit 1 にしない設計）", () => {
    expect(
      isEmbedGateStuck({ skipReason: "disk_ceiling", pending: 500, eligible: 0 }),
    ).toBe(false);
  });

  it("キー未設定 skip は除外しない（ゲート判定は API キーと独立）", () => {
    expect(
      isEmbedGateStuck({ skipReason: "no_api_key", pending: 500, eligible: 0 }),
    ).toBe(true);
  });

  it("選抜が 1 件でもあれば stuck ではない", () => {
    expect(isEmbedGateStuck({ pending: 500, eligible: 10 })).toBe(false);
  });

  it("候補ゼロは正常（対象が無いだけ）", () => {
    expect(isEmbedGateStuck({ pending: 0, eligible: 0 })).toBe(false);
  });

  it("取得失敗（-1）は判定不能として不活性", () => {
    expect(isEmbedGateStuck({ pending: -1, eligible: -1 })).toBe(false);
  });
});

describe("isEmbedSelectStalled", () => {
  it("選抜 RPC 失敗 × 26h 実績ゼロなら stalled", () => {
    expect(
      isEmbedSelectStalled({ selectError: "boom" }, { embeddedLast26h: 0 }),
    ).toBe(true);
  });

  it("選抜 RPC 失敗でも 26h に 1 件でも進んでいれば生存", () => {
    expect(
      isEmbedSelectStalled({ selectError: "boom" }, { embeddedLast26h: 3 }),
    ).toBe(false);
  });

  it("RPC が正常（selectError=null）なら発火しない", () => {
    expect(
      isEmbedSelectStalled({ selectError: null }, { embeddedLast26h: 0 }),
    ).toBe(false);
  });

  it("26h 実績が -1（取得失敗）なら判定不能として不活性", () => {
    // 姉妹ガードと同じく -1 は「進んでいない(0)」と区別する。=== 0 を <= 0 に変異させるとここで落ちる。
    expect(
      isEmbedSelectStalled({ selectError: "boom" }, { embeddedLast26h: -1 }),
    ).toBe(false);
  });
});

describe("isEmbedStalled", () => {
  const idle = { embeddedLast26h: 0, candidatesAvailable: 30 };

  it("候補があるのに 26h 実績ゼロなら stalled", () => {
    expect(isEmbedStalled({}, idle)).toBe(true);
  });

  it("ディスク天井による意図的な skip は除外する（天井は exit 1 にしない設計）", () => {
    expect(isEmbedStalled({ skipReason: "disk_ceiling" }, idle)).toBe(false);
  });

  it("キー未設定の skip は除外しない（キー喪失は 26h 経過で本物の障害として赤くする）", () => {
    expect(isEmbedStalled({ skipReason: "no_api_key" }, idle)).toBe(true);
  });

  it("候補ゼロなら不活性（観測対象が無いのに赤くならない）", () => {
    expect(
      isEmbedStalled({}, { embeddedLast26h: 0, candidatesAvailable: 0 }),
    ).toBe(false);
  });

  it("26h に 1 件でも進んでいれば生存", () => {
    expect(
      isEmbedStalled({}, { embeddedLast26h: 1, candidatesAvailable: 100 }),
    ).toBe(false);
  });

  it("カウント取得失敗（-1）は判定不能として不活性", () => {
    expect(
      isEmbedStalled({}, { embeddedLast26h: -1, candidatesAvailable: 30 }),
    ).toBe(false);
    expect(
      isEmbedStalled({}, { embeddedLast26h: 0, candidatesAvailable: -1 }),
    ).toBe(false);
  });
});

describe("isDeckStarved", () => {
  it("床を割ったら starved", () => {
    expect(isDeckStarved(DECK_STARVED_FLOOR - 1)).toBe(true);
    expect(isDeckStarved(0)).toBe(true);
  });

  it("床ちょうどは starved ではない", () => {
    expect(isDeckStarved(DECK_STARVED_FLOOR)).toBe(false);
  });

  it("カウント取得失敗（-1）は判定不能として不活性", () => {
    expect(isDeckStarved(-1)).toBe(false);
  });
});

describe("isSelectionDead", () => {
  const base = { skipped: false, pool: 20, selected: 10, poolError: null as string | null };

  it("正常な選抜（pool>0 ∧ selected>0）は dead ではない", () => {
    expect(isSelectionDead(base)).toBe(false);
  });

  it("poolError があれば dead（claim RPC / 対象 select の失敗）", () => {
    expect(isSelectionDead({ ...base, poolError: "rpc failed" })).toBe(true);
  });

  it("候補はあるのに 1 件も予約できない（pool>0 ∧ selected=0）は dead", () => {
    expect(isSelectionDead({ ...base, selected: 0 })).toBe(true);
  });

  it("正常な抑制（daily_capped / no_api_key）は skipped で除外", () => {
    // skipped=true のときは pool=0/selected=0 でも発火しない
    expect(isSelectionDead({ skipped: true, pool: 0, selected: 0, poolError: null })).toBe(false);
  });

  it("対象ゼロ（pool=0 ∧ selected=0）は正常＝dead ではない", () => {
    expect(isSelectionDead({ ...base, pool: 0, selected: 0 })).toBe(false);
  });

  it("capUnavailable（pool=-1）は発火しない", () => {
    expect(isSelectionDead({ ...base, pool: -1, selected: 0 })).toBe(false);
  });
});

describe("isQuarantineSurging", () => {
  it("閾値ちょうどは surge ではない", () => {
    expect(isQuarantineSurging({ quarantinedLast24h: QUARANTINE_SURGE_LIMIT })).toBe(false);
  });

  it("閾値超過で surge", () => {
    expect(isQuarantineSurging({ quarantinedLast24h: QUARANTINE_SURGE_LIMIT + 1 })).toBe(true);
  });

  it("カウント取得失敗（-1）は不活性", () => {
    expect(isQuarantineSurging({ quarantinedLast24h: -1 })).toBe(false);
  });
});
