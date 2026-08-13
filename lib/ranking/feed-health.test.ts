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
  latestPublishedAt: daysAgo(0),
  credibility: 0,
  near_dup_rate: null,
  sourcePref: 0,
  ...over,
});

describe("閾値・加重の現在値", () => {
  // 較正前の「現在の挙動」固定は判定ロジックだけでは完成しない。テスト本体は定数をシンボリック
  // 参照するため、値が変わってもアサーションが追従して通ってしまう。値そのものをここで固定し、
  // 較正で動かすときはこのスナップショットを仕様変更として書き換える。
  it("FEED_HEALTH_THRESHOLDS の現在値を固定する", () => {
    expect(FEED_HEALTH_THRESHOLDS).toEqual({
      DEAD_DAYS: 14,
      NEW_FEED_GRACE_DAYS: 3,
      LOW_CREDIBILITY: -0.3,
      LOW_PREF: -2.0,
      NEAR_DUP_RATE: 0.5,
    });
  });

  it("RETIRE_SIGNAL_WEIGHTS の現在値を固定する", () => {
    expect(RETIRE_SIGNAL_WEIGHTS).toEqual({
      dead: 3.0,
      near_dup: 2.5,
      low_pref: 2.0,
      low_credibility: 1.5,
    });
  });
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

describe("evaluateFeedHealth: dead シグナル（YAT-70 で発信停滞へ再定義）", () => {
  // 旧定義は last_fetched_at（＝こちらが取得できているか）だった。取得失敗の検知は YAT-68 で
  // ingest 側へ移り、ここは「発信元が止まったか」だけを見る。仕様変更なのでテストも書き換えた。

  it("記事が 1 件も無い feed は猶予明けなら dead", () => {
    const r = evaluateFeedHealth(
      healthy({ created_at: daysAgo(10), latestPublishedAt: null }),
      NOW,
    );
    expect(r.reasons).toEqual(["dead"]);
  });

  it("新規 feed（追加から猶予未満）は記事ゼロでも dead にしない", () => {
    const r = evaluateFeedHealth(
      healthy({
        created_at: daysAgo(FEED_HEALTH_THRESHOLDS.NEW_FEED_GRACE_DAYS - 1),
        latestPublishedAt: null,
      }),
      NOW,
    );
    expect(r.reasons).toEqual([]);
  });

  it("猶予をちょうど過ぎた feed は記事ゼロで dead", () => {
    const r = evaluateFeedHealth(
      healthy({
        created_at: daysAgo(FEED_HEALTH_THRESHOLDS.NEW_FEED_GRACE_DAYS),
        latestPublishedAt: null,
      }),
      NOW,
    );
    expect(r.reasons).toEqual(["dead"]);
  });

  it("発信境界: ちょうど DEAD_DAYS では dead にしない（strict 比較）", () => {
    const r = evaluateFeedHealth(
      healthy({ latestPublishedAt: daysAgo(FEED_HEALTH_THRESHOLDS.DEAD_DAYS) }),
      NOW,
    );
    expect(r.reasons).toEqual([]);
  });

  it("発信境界: DEAD_DAYS を 1ms でも超えたら dead", () => {
    const quiet = new Date(
      NOW - FEED_HEALTH_THRESHOLDS.DEAD_DAYS * DAY_MS - 1,
    ).toISOString();
    const r = evaluateFeedHealth(healthy({ latestPublishedAt: quiet }), NOW);
    expect(r.reasons).toEqual(["dead"]);
  });

  it("取得が止まっていても発信が新しければ dead にしない（旧定義との違い）", () => {
    // 旧定義ではここが dead になっていた。取得失敗は YAT-68 の findStaleFeeds が別途検知する。
    const r = evaluateFeedHealth(healthy({ latestPublishedAt: daysAgo(1) }), NOW);
    expect(r.reasons).toEqual([]);
  });

  it("latestPublishedAt が undefined（取得できなかった）なら dead 判定を見送る", () => {
    // null に畳むと migration 未適用や RPC 障害で全 feed が一斉に dead へ倒れる。
    const r = evaluateFeedHealth(
      healthy({ created_at: daysAgo(100), latestPublishedAt: undefined }),
      NOW,
    );
    expect(r.reasons).toEqual([]);
  });

  it("undefined は他シグナルの判定までは止めない", () => {
    const r = evaluateFeedHealth(
      healthy({ latestPublishedAt: undefined, credibility: -0.9 }),
      NOW,
    );
    expect(r.reasons).toEqual(["low_credibility"]);
  });

  it("パースできない日付では dead を立てない（安全側）", () => {
    const r = evaluateFeedHealth(healthy({ latestPublishedAt: "not-a-date" }), NOW);
    expect(r.reasons).toEqual([]);
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
      healthy({ created_at: daysAgo(10), latestPublishedAt: null }),
      NOW,
    );
    expect(r.score).toBe(RETIRE_SIGNAL_WEIGHTS.dead);
  });

  it("複数シグナルの score は加重の合計（全 4 シグナル同時 = 9.0）", () => {
    const r = evaluateFeedHealth(
      healthy({
        created_at: daysAgo(10),
        latestPublishedAt: null, // dead
        credibility: -0.5, // low_credibility
        sourcePref: -3, // low_pref
        near_dup_rate: 0.8, // near_dup
      }),
      NOW,
    );
    // reasons の並び順は実装の push 順（UI の理由タグ表示にそのまま使われる）ごと固定する。
    expect(r.reasons).toEqual(["dead", "low_credibility", "low_pref", "near_dup"]);
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
      healthy({ id: "dead-and-dup", created_at: daysAgo(10), latestPublishedAt: null, near_dup_rate: 0.9 }), // score 5.5
    ];
    const r = computeRetireSuggestions(inputs, NOW);
    expect(r.map((s) => s.id)).toEqual(["dead-and-dup", "pref-only"]);
  });

  it("全 feed 健全なら空配列", () => {
    expect(computeRetireSuggestions([healthy()], NOW)).toEqual([]);
  });
});
