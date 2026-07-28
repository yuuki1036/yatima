import { describe, it, expect } from "vitest";
import {
  evaluateFeedHealth,
  computeRetireSuggestions,
  FEED_HEALTH_THRESHOLDS,
  RETIRE_SIGNAL_WEIGHTS,
  type FeedHealthInput,
} from "@/lib/ranking/feed-health";

// YAT-55: 閾値・加重の較正前に「現在の判定挙動」を境界値で固定する安全網。
// ここでのアサーションは現状の仕様の記述であって妥当性の保証ではない。特に比較演算子の
// 開閉（strict / inclusive）はシグナルごとに非対称なので、較正で閾値や境界の扱いを変える
// 際はこのテストを仕様変更として明示的に書き換えること。

const NOW = Date.parse("2026-07-28T00:00:00Z");
const DAY_MS = 86_400_000;
const daysAgo = (d: number) => new Date(NOW - d * DAY_MS).toISOString();

// 全シグナルが閾値に触れない健全 feed。各テストは 1 シグナルだけ上書きして独立に検証する。
const healthy = (over: Partial<FeedHealthInput> = {}): FeedHealthInput => ({
  id: "feed-1",
  title: "健全フィード",
  url: "https://example.com/feed.xml",
  created_at: daysAgo(30),
  last_fetched_at: daysAgo(0),
  credibility: 0,
  near_dup_rate: null,
  sourcePref: 0,
  ...over,
});

describe("evaluateFeedHealth: 健全側", () => {
  it("全シグナルが閾値内なら推奨しない（score 0・理由なし）", () => {
    const r = evaluateFeedHealth(healthy(), NOW);
    expect(r.recommend).toBe(false);
    expect(r.reasons).toEqual([]);
    expect(r.score).toBe(0);
  });

  it("入力の id/title/url をそのまま返す（UI 描画用の素通し）", () => {
    const r = evaluateFeedHealth(healthy(), NOW);
    expect(r.id).toBe("feed-1");
    expect(r.title).toBe("健全フィード");
    expect(r.url).toBe("https://example.com/feed.xml");
  });
});

describe("evaluateFeedHealth: dead シグナル", () => {
  it("last_fetched_at=null は猶予明けなら dead（一度も取得成功していない）", () => {
    const r = evaluateFeedHealth(
      healthy({ created_at: daysAgo(10), last_fetched_at: null }),
      NOW,
    );
    expect(r.reasons).toEqual(["dead"]);
  });

  it("新規 feed（追加から猶予未満）は last_fetched_at=null でも dead にしない", () => {
    const r = evaluateFeedHealth(
      healthy({
        created_at: daysAgo(FEED_HEALTH_THRESHOLDS.NEW_FEED_GRACE_DAYS - 1),
        last_fetched_at: null,
      }),
      NOW,
    );
    expect(r.reasons).toEqual([]);
  });

  it("猶予境界: 追加からちょうど NEW_FEED_GRACE_DAYS で猶予が切れる（age < grace の strict 比較）", () => {
    const r = evaluateFeedHealth(
      healthy({
        created_at: daysAgo(FEED_HEALTH_THRESHOLDS.NEW_FEED_GRACE_DAYS),
        last_fetched_at: null,
      }),
      NOW,
    );
    expect(r.reasons).toEqual(["dead"]);
  });

  it("停止境界: ちょうど DEAD_DAYS では dead にしない（stale > DEAD_DAYS の strict 比較）", () => {
    const r = evaluateFeedHealth(
      healthy({ last_fetched_at: daysAgo(FEED_HEALTH_THRESHOLDS.DEAD_DAYS) }),
      NOW,
    );
    expect(r.reasons).toEqual([]);
  });

  it("停止境界: DEAD_DAYS を 1ms でも超えたら dead", () => {
    const stale = new Date(
      NOW - (FEED_HEALTH_THRESHOLDS.DEAD_DAYS * DAY_MS + 1),
    ).toISOString();
    const r = evaluateFeedHealth(healthy({ last_fetched_at: stale }), NOW);
    expect(r.reasons).toEqual(["dead"]);
  });
});

describe("evaluateFeedHealth: low_credibility シグナル", () => {
  // 【既知の問題・YAT-55 指摘 F】判定は credibility < LOW_CREDIBILITY の strict 比較で、
  // シード値がちょうど -0.3 の feed（実データで 3 件確認: vLLM Blog / タグ「AI」を検索 /
  // VentureBeat AI）はフラグが立たない。境界を含めるかどうかは較正時の決定事項。
  // このテストは現在の「立たない」挙動を固定している（較正で変えるなら仕様変更として書き換える）。
  it("境界: ちょうど LOW_CREDIBILITY(-0.3) ではフラグが立たない（strict 比較）", () => {
    const r = evaluateFeedHealth(
      healthy({ credibility: FEED_HEALTH_THRESHOLDS.LOW_CREDIBILITY }),
      NOW,
    );
    expect(r.reasons).toEqual([]);
  });

  it("LOW_CREDIBILITY を下回ればフラグが立つ", () => {
    const r = evaluateFeedHealth(healthy({ credibility: -0.31 }), NOW);
    expect(r.reasons).toEqual(["low_credibility"]);
  });
});

describe("evaluateFeedHealth: low_pref シグナル", () => {
  it("境界: ちょうど LOW_PREF(-2.0) ではフラグが立たない（strict 比較）", () => {
    const r = evaluateFeedHealth(
      healthy({ sourcePref: FEED_HEALTH_THRESHOLDS.LOW_PREF }),
      NOW,
    );
    expect(r.reasons).toEqual([]);
  });

  it("LOW_PREF を下回ればフラグが立つ（dismiss -1.1 × 2 回の累積 -2.2 で超える設計）", () => {
    const r = evaluateFeedHealth(healthy({ sourcePref: -2.2 }), NOW);
    expect(r.reasons).toEqual(["low_pref"]);
  });
});

describe("evaluateFeedHealth: near_dup シグナル", () => {
  it("near_dup_rate=null（未算出）はフラグ無効。「算出して 0」と区別されない点は較正時の課題", () => {
    const r = evaluateFeedHealth(healthy({ near_dup_rate: null }), NOW);
    expect(r.reasons).toEqual([]);
  });

  it("境界: ちょうど NEAR_DUP_RATE(0.5) でフラグが立つ（>= の inclusive 比較。credibility/pref と非対称）", () => {
    const r = evaluateFeedHealth(
      healthy({ near_dup_rate: FEED_HEALTH_THRESHOLDS.NEAR_DUP_RATE }),
      NOW,
    );
    expect(r.reasons).toEqual(["near_dup"]);
  });

  it("NEAR_DUP_RATE 未満はフラグが立たない", () => {
    const r = evaluateFeedHealth(healthy({ near_dup_rate: 0.49 }), NOW);
    expect(r.reasons).toEqual([]);
  });
});

describe("evaluateFeedHealth: score と加重", () => {
  it("単一シグナルの score はそのシグナルの加重に一致する", () => {
    const r = evaluateFeedHealth(
      healthy({ created_at: daysAgo(10), last_fetched_at: null }),
      NOW,
    );
    expect(r.score).toBe(RETIRE_SIGNAL_WEIGHTS.dead);
  });

  it("複数シグナルの score は加重の合計（全 4 シグナル同時 = 9.0）", () => {
    const r = evaluateFeedHealth(
      healthy({
        created_at: daysAgo(10),
        last_fetched_at: null, // dead
        credibility: -0.5, // low_credibility
        sourcePref: -3, // low_pref
        near_dup_rate: 0.8, // near_dup
      }),
      NOW,
    );
    expect(r.reasons).toHaveLength(4);
    expect(r.score).toBe(
      RETIRE_SIGNAL_WEIGHTS.dead +
        RETIRE_SIGNAL_WEIGHTS.low_credibility +
        RETIRE_SIGNAL_WEIGHTS.low_pref +
        RETIRE_SIGNAL_WEIGHTS.near_dup,
    );
    expect(r.recommend).toBe(true);
  });
});

describe("computeRetireSuggestions", () => {
  it("推奨のみ残し、score 降順で返す", () => {
    const inputs: FeedHealthInput[] = [
      healthy({ id: "ok" }),
      healthy({ id: "pref-only", sourcePref: -3 }), // score 2.0
      healthy({ id: "dead-and-dup", created_at: daysAgo(10), last_fetched_at: null, near_dup_rate: 0.9 }), // score 5.5
    ];
    const r = computeRetireSuggestions(inputs, NOW);
    expect(r.map((s) => s.id)).toEqual(["dead-and-dup", "pref-only"]);
  });

  it("全 feed 健全なら空配列", () => {
    expect(computeRetireSuggestions([healthy()], NOW)).toEqual([]);
  });
});
