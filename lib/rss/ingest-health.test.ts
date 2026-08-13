import { describe, it, expect } from "vitest";
import {
  findStaleFeeds,
  formatStale,
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
