import { describe, it, expect } from "vitest";
import {
  evaluateFeedHealth,
  deadThresholdMs,
  computeRetireSuggestions,
  FEED_HEALTH_THRESHOLDS,
  RETIRE_SIGNAL_WEIGHTS,
  type FeedHealthInput,
} from "@/lib/ranking/feed-health";
import {
  MIN_OWN_ARTICLES,
  PER_FEED_LIMIT,
} from "@/lib/ranking/near-dup-window";

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
  // 既定は日刊ペース（間隔の中央値 1d）で沈黙 0d ＝ 健全。
  recentPublishedAt: [daysAgo(0), daysAgo(1), daysAgo(2), daysAgo(3)],
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
      DEAD_STALL_MULTIPLIER: 2.5,
      CADENCE_SAMPLE: 15,
      NEW_FEED_GRACE_DAYS: 3,
      LOW_CREDIBILITY: -0.4,
      LOW_PREF: -2.0,
      NEAR_DUP_RATE: 0.2,
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
      healthy({ created_at: daysAgo(10), recentPublishedAt: [] }),
      NOW,
    );
    expect(r.reasons).toEqual(["dead"]);
  });

  it("新規 feed（追加から猶予未満）は記事ゼロでも dead にしない", () => {
    const r = evaluateFeedHealth(
      healthy({
        created_at: daysAgo(FEED_HEALTH_THRESHOLDS.NEW_FEED_GRACE_DAYS - 1),
        recentPublishedAt: [],
      }),
      NOW,
    );
    expect(r.reasons).toEqual([]);
  });

  it("猶予をちょうど過ぎた feed は記事ゼロで dead", () => {
    const r = evaluateFeedHealth(
      healthy({
        created_at: daysAgo(FEED_HEALTH_THRESHOLDS.NEW_FEED_GRACE_DAYS),
        recentPublishedAt: [],
      }),
      NOW,
    );
    expect(r.reasons).toEqual(["dead"]);
  });

  it("発信境界: ちょうど DEAD_DAYS では dead にしない（strict 比較）", () => {
    const r = evaluateFeedHealth(
      healthy({ recentPublishedAt: [daysAgo(FEED_HEALTH_THRESHOLDS.DEAD_DAYS)] }),
      NOW,
    );
    expect(r.reasons).toEqual([]);
  });

  it("発信境界: DEAD_DAYS を 1ms でも超えたら dead", () => {
    const quiet = new Date(
      NOW - FEED_HEALTH_THRESHOLDS.DEAD_DAYS * DAY_MS - 1,
    ).toISOString();
    const r = evaluateFeedHealth(healthy({ recentPublishedAt: [quiet] }), NOW);
    expect(r.reasons).toEqual(["dead"]);
  });

  it("取得が止まっていても発信が新しければ dead にしない（旧定義との違い）", () => {
    // 旧定義ではここが dead になっていた。取得失敗は YAT-68 の findStaleFeeds が別途検知する。
    const r = evaluateFeedHealth(healthy({ recentPublishedAt: [daysAgo(1)] }), NOW);
    expect(r.reasons).toEqual([]);
  });

  it("recentPublishedAt が undefined（取得できなかった）なら dead 判定を見送る", () => {
    // null に畳むと migration 未適用や RPC 障害で全 feed が一斉に dead へ倒れる。
    const r = evaluateFeedHealth(
      healthy({ created_at: daysAgo(100), recentPublishedAt: undefined }),
      NOW,
    );
    expect(r.reasons).toEqual([]);
  });

  it("undefined は他シグナルの判定までは止めない", () => {
    const r = evaluateFeedHealth(
      healthy({ recentPublishedAt: undefined, credibility: -0.9 }),
      NOW,
    );
    expect(r.reasons).toEqual(["low_credibility"]);
  });

  it("パースできない日付では dead を立てない（安全側）", () => {
    const r = evaluateFeedHealth(healthy({ recentPublishedAt: ["not-a-date"] }), NOW);
    expect(r.reasons).toEqual([]);
  });
});

describe("evaluateFeedHealth: low_credibility シグナル", () => {
  // 判定は credibility < LOW_CREDIBILITY の strict 比較。YAT-55 指摘 F は「シード値 -0.3 が
  // 閾値 -0.3 とちょうど一致して 6 feed が判定を漏れる」問題だったが、閾値を -0.4（シード値の
  // 段 -0.5 と -0.3 の間・feed が 1 つも無い区間）へ寄せて決着させた。挙動は変わらない
  // （-0.5 / -0.8 は立つ、-0.3 は立たない）が、等号ひとつで結果が反転する状態ではなくなった。
  it("境界: ちょうど LOW_CREDIBILITY ではフラグが立たない（strict 比較）", () => {
    const r = evaluateFeedHealth(
      healthy({ credibility: FEED_HEALTH_THRESHOLDS.LOW_CREDIBILITY }),
      NOW,
    );
    expect(r.reasons).toEqual([]);
  });

  it("LOW_CREDIBILITY を下回ればフラグが立つ", () => {
    const r = evaluateFeedHealth(
      healthy({ credibility: FEED_HEALTH_THRESHOLDS.LOW_CREDIBILITY - 0.01 }),
      NOW,
    );
    expect(r.reasons).toEqual(["low_credibility"]);
  });

  // 閾値を -0.4 に寄せた狙いそのもの: シード値の段が閾値と重ならないこと。
  // 閾値をシード値ちょうど（-0.3 や -0.5）へ戻すとこのテストが落ちる。
  it.each([-0.5, -0.3])(
    "シード値の段 %s は閾値と一致しない（境界の曖昧さが無い）",
    (seed) => {
      expect(seed).not.toBe(FEED_HEALTH_THRESHOLDS.LOW_CREDIBILITY);
    },
  );
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

  it("境界: ちょうど NEAR_DUP_RATE でフラグが立つ（>= の inclusive 比較。credibility/pref と非対称）", () => {
    const r = evaluateFeedHealth(
      healthy({ near_dup_rate: FEED_HEALTH_THRESHOLDS.NEAR_DUP_RATE }),
      NOW,
    );
    expect(r.reasons).toEqual(["near_dup"]);
  });

  it("NEAR_DUP_RATE 未満はフラグが立たない", () => {
    const r = evaluateFeedHealth(
      healthy({ near_dup_rate: FEED_HEALTH_THRESHOLDS.NEAR_DUP_RATE - 0.01 }),
      NOW,
    );
    expect(r.reasons).toEqual([]);
  });

  // YAT-70 で near_dup を有向化した際、決定 4-C（閾値を有向スケールへ下げる）が実装から落ち、
  // 無向時代の 0.5 が残って 12 日間シグナルが沈黙していた（YAT-55 観測 ⑥）。
  // 有向 near_dup の実測レンジは 0.00〜0.21 なので、閾値がこの範囲の外に出たら再発とみなす。
  it("閾値が有向 near_dup の実測レンジ（0.00〜0.21）の内側にある", () => {
    expect(FEED_HEALTH_THRESHOLDS.NEAR_DUP_RATE).toBeGreaterThan(0);
    expect(FEED_HEALTH_THRESHOLDS.NEAR_DUP_RATE).toBeLessThanOrEqual(0.21);
  });

  // NEAR_DUP_RATE と MIN_OWN_ARTICLES は独立に決められない（YAT-55 決定 4-C / 4-D）。
  // own = MIN_OWN_ARTICLES の feed では 1 記事が率を 1/MIN_OWN 動かす。これが閾値以上だと
  // **たった 1 記事でフラグが立つ**＝率として意味を成さない。実際 MIN_OWN=5 / 閾値 0.2 の
  // 組み合わせがちょうどそれで、Google DeepMind News は own=7 で 0.67 を叩き出していた。
  it("MIN_OWN_ARTICLES は 1 記事で閾値をまたげない粒度になっている", () => {
    const perArticle = 1 / MIN_OWN_ARTICLES;
    expect(perArticle).toBeLessThan(FEED_HEALTH_THRESHOLDS.NEAR_DUP_RATE);
  });

  // 率の実分母は min(窓内件数, PER_FEED_LIMIT)。最小母数がこの上限を超えると、どの feed も
  // 母数条件を満たせず near_dup_rate が全件 null になる（シグナルが別の理由で死ぬ）。
  it("MIN_OWN_ARTICLES は実分母の上限 PER_FEED_LIMIT を超えない", () => {
    expect(MIN_OWN_ARTICLES).toBeLessThanOrEqual(PER_FEED_LIMIT);
  });
});

describe("evaluateFeedHealth: score と加重", () => {
  it("単一シグナルの score はそのシグナルの加重に一致する", () => {
    const r = evaluateFeedHealth(
      healthy({ created_at: daysAgo(10), recentPublishedAt: [] }),
      NOW,
    );
    expect(r.score).toBe(RETIRE_SIGNAL_WEIGHTS.dead);
  });

  it("複数シグナルの score は加重の合計（全 4 シグナル同時 = 9.0）", () => {
    const r = evaluateFeedHealth(
      healthy({
        created_at: daysAgo(10),
        recentPublishedAt: [], // dead
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
      healthy({ id: "dead-and-dup", created_at: daysAgo(10), recentPublishedAt: [], near_dup_rate: 0.9 }), // score 5.5
    ];
    const r = computeRetireSuggestions(inputs, NOW);
    expect(r.map((s) => s.id)).toEqual(["dead-and-dup", "pref-only"]);
  });

  it("全 feed 健全なら空配列", () => {
    expect(computeRetireSuggestions([healthy()], NOW)).toEqual([]);
  });
});

describe("deadThresholdMs: 投稿間隔ベースの適応閾値（YAT-70）", () => {
  const DEAD_FLOOR_MS = FEED_HEALTH_THRESHOLDS.DEAD_DAYS * DAY_MS;
  // 間隔が gapDays 一定の feed を、新しい順の公開日リストとして作る。
  const cadence = (gapDays: number, count = 6) =>
    Array.from({ length: count }, (_, i) => daysAgo(i * gapDays));

  it("高頻度 feed では DEAD_DAYS が下限として効く", () => {
    // 中央値 1d × 2.5 = 2.5d だが、1 回の休載で dead にしないよう 14d まで引き上げる。
    expect(deadThresholdMs(cadence(1))).toBe(DEAD_FLOOR_MS);
  });

  it("低頻度 feed では中央値 × 倍率まで閾値が伸びる", () => {
    // 中央値 25d × 2.5 = 62.5d（Ahead of AI 相当）。
    expect(deadThresholdMs(cadence(25))).toBe(25 * 2.5 * DAY_MS);
  });

  it("サンプルが 1 件だけなら間隔が取れないので DEAD_DAYS だけで判定する", () => {
    expect(deadThresholdMs([daysAgo(0)])).toBe(DEAD_FLOOR_MS);
  });

  it("記事ゼロでも DEAD_DAYS を返す（呼び出し側が Infinity と比較して dead にする）", () => {
    expect(deadThresholdMs([])).toBe(DEAD_FLOOR_MS);
  });

  it("外れ値の休載 1 回では閾値が引きずられない（平均でなく中央値を使う）", () => {
    // 間隔は [7, 7, 200, 7]。中央値は 7d なので閾値は 17.5d。
    // 平均（55.25d）を使っていたら 138d まで伸び、その後の停滞を 4 ヶ月見逃すことになる。
    const recent = [daysAgo(0), daysAgo(7), daysAgo(14), daysAgo(214), daysAgo(221)];
    expect(deadThresholdMs(recent)).toBe(7 * 2.5 * DAY_MS);
    expect(deadThresholdMs(recent)).toBeGreaterThan(DEAD_FLOOR_MS);
  });

  it("パースできない日付は間隔の算出から除く", () => {
    const recent = ["not-a-date", daysAgo(0), daysAgo(25), daysAgo(50)];
    expect(deadThresholdMs(recent)).toBe(25 * 2.5 * DAY_MS);
  });

  it("CADENCE_SAMPLE を超える分は見ない（過去の刊行ペースを引きずらない）", () => {
    // 直近 15 件は日刊、その先は月刊。中央値は日刊側で決まる → 下限 14d。
    const recent = [
      ...Array.from({ length: 15 }, (_, i) => daysAgo(i)),
      ...Array.from({ length: 5 }, (_, i) => daysAgo(100 + i * 30)),
    ];
    expect(deadThresholdMs(recent)).toBe(DEAD_FLOOR_MS);
  });
});

describe("dead 判定: 実測 4 feed の回帰（YAT-70。固定 14d では 2 件が誤検知だった）", () => {
  // 2026-08-13 の実測値。適応閾値がこの 4 件を分離することを固定する。
  const cases = [
    { name: "Berkeley BAIR", gap: 38.0, quiet: 15.2, dead: false },
    { name: "Ahead of AI", gap: 25.0, quiet: 26.1, dead: false },
    { name: "VentureBeat AI", gap: 3.0, quiet: 27.8, dead: true },
    { name: "PFN Tech Blog", gap: 7.9, quiet: 27.6, dead: true },
  ];

  for (const c of cases) {
    it(`${c.name}（中央値 ${c.gap}d / 沈黙 ${c.quiet}d）→ ${c.dead ? "dead" : "健全"}`, () => {
      // 沈黙 quiet 日の時点から、それ以前は gap 日間隔で発信していた feed を組み立てる。
      const recent = Array.from({ length: 6 }, (_, i) =>
        daysAgo(c.quiet + i * c.gap),
      );
      const r = evaluateFeedHealth(healthy({ recentPublishedAt: recent }), NOW);
      expect(r.reasons.includes("dead")).toBe(c.dead);
    });
  }
});
