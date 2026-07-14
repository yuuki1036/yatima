import { describe, it, expect } from "vitest";
import { recencyDecay, preferenceScore, score } from "@/lib/ranking/score";

const NOW = Date.parse("2026-01-02T00:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe("recencyDecay", () => {
  it("null の published_at は 0", () => {
    expect(recencyDecay(null, NOW)).toBe(0);
  });

  it("現在時刻ちょうどは 1（減衰なし）", () => {
    expect(recencyDecay(hoursAgo(0), NOW)).toBeCloseTo(1);
  });

  it("半減期 24h で 0.5、48h で 0.25", () => {
    expect(recencyDecay(hoursAgo(24), NOW)).toBeCloseTo(0.5);
    expect(recencyDecay(hoursAgo(48), NOW)).toBeCloseTo(0.25);
  });

  it("未来日付（時計ズレ）は最新扱いで 1", () => {
    expect(recencyDecay(hoursAgo(-5), NOW)).toBe(1);
  });

  it("パース不能な日付は 0", () => {
    expect(recencyDecay("not-a-date", NOW)).toBe(0);
  });
});

describe("preferenceScore", () => {
  it("記事タグの tag_pref を合算する", () => {
    const tagPrefs = new Map([
      ["ai", 2],
      ["rust", -1],
    ]);
    expect(preferenceScore({ tags: ["ai", "rust"], tagPrefs })).toBe(1);
  });

  it("未知タグ（prefs 不在）は 0 加点", () => {
    const tagPrefs = new Map([["ai", 2]]);
    expect(preferenceScore({ tags: ["ai", "unknown"], tagPrefs })).toBe(2);
  });

  it("source_pref を加算する", () => {
    const r = preferenceScore({
      tags: [],
      tagPrefs: new Map(),
      sourceId: "feed-1",
      sourcePrefs: new Map([["feed-1", 3]]),
    });
    expect(r).toBe(3);
  });

  it("sourcePrefs 未指定なら source 成分は 0", () => {
    const r = preferenceScore({
      tags: ["ai"],
      tagPrefs: new Map([["ai", 1]]),
      sourceId: "feed-1",
    });
    expect(r).toBe(1);
  });
});

describe("score", () => {
  it("recency + pref + credibility の和", () => {
    const r = score({
      publishedAt: hoursAgo(24), // recency 0.5
      tags: ["ai"],
      tagPrefs: new Map([["ai", 2]]),
      credibility: 0.3,
      now: NOW,
    });
    expect(r).toBeCloseTo(0.5 + 2 + 0.3);
  });

  it("コールドスタート（pref 全 0）は recency + credibility に縮退", () => {
    const r = score({
      publishedAt: hoursAgo(0), // recency 1
      tags: [],
      tagPrefs: new Map(),
      credibility: 0.5,
      now: NOW,
    });
    expect(r).toBeCloseTo(1.5);
  });

  it("credibility 未指定は 0 扱い", () => {
    const r = score({
      publishedAt: hoursAgo(0),
      tags: [],
      tagPrefs: new Map(),
      now: NOW,
    });
    expect(r).toBeCloseTo(1);
  });
});
