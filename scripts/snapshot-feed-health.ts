import { config } from "dotenv";

// ローカル実行用に .env.local を読む。GitHub Actions では secrets が process.env にあり no-op。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import {
  collectFeedHealthObservation,
  describeWindow,
  DAY_MS,
  FEEDS_WITH_RATE_FLOOR,
} from "../lib/ranking/feed-health-observation";
import { FEED_HEALTH_THRESHOLDS } from "../lib/ranking/feed-health";
import {
  MIN_OWN_ARTICLES,
  PER_FEED_LIMIT,
  WINDOW_DAYS,
} from "../lib/ranking/near-dup-window";
import {
  nearDupFreshness,
  RECIPE_MAJORITY_SHARE,
  RECIPE_MIXED_GRACE_DAYS,
  EMBED_RECIPE_EPOCH,
} from "../lib/ranking/embed-recipe";
import { DISK_CEILING_BYTES, EMBED_MIN_BODY_LEN } from "../lib/rss/embed";

// YAT-55: 退役スコアリングの観測を feed_health_snapshots に貯める（週次 cron）。
//
// なぜ要るのか: 較正の材料になるはずの値がどこにも残っていなかった。feeds.near_dup_rate は
// 上書き列で、週次 cron が毎回踏み潰す。diagnose-feed-health は手動実行で標準出力に出すだけ。
// 結果、起票から 6 週間で観測が 1 点も残らず、系列は 3 回リセットされた
// （母集団バグ / Import AI 非活性化 / 要約全滅）。とくに 3 回目では、有向 near_dup で唯一
// クリーンだった 2026-08-17 の cron 結果が 08-24 の汚染値に上書きされて失われている。
//
// 収集は diagnose-feed-health と同じ module を使う（feed-health-observation）。
// 「診断で見た値」と「較正に貯める値」がズレたら較正が成立しないため。
//
// 書き込みは insert のみ（既存行は更新しない）。系列が目的なので上書きは自己矛盾になる。
//
// near_dup_rate は「撮影時点で DB にある値」であって「撮影時点で算出した値」ではない。
// 書き手は週次の compute-dedup-rate だけなので、cron（直後に置いてある）では両者が一致するが、
// **手動実行では最大 1 週間ぶん古い値を撮る**。手で撮った点を較正に使うときは captured_at でなく
// 直前の compute-dedup-rate がいつ走ったかで判断すること。
// LLM 呼び出しは無いので課金は発生しない。

async function main() {
  const supabase = createAdminClient();
  const now = Date.now();
  const capturedAt = new Date(now).toISOString();

  // compute-dedup-rate の成否（learn.yml が steps.<id>.outcome を env で渡す・必要条件）。
  // 未設定＝手動実行とみなして false に倒す。
  const computeOk = process.env.NEAR_DUP_FRESH === "true";
  const runKind = process.env.GITHUB_ACTIONS === "true" ? "cron" : "manual";

  const obs = await collectFeedHealthObservation(supabase, now);

  // near_dup_fresh は「compute が exit 0 で回った（必要条件）」AND「多数派 share が 0.8 以上＝
  // compute が実際に値を入れた（十分条件）」で合成する（YAT-77）。混在期は compute が exit 0 でも
  // 全 feed を null 化するので、env だけ見ると「fresh なのに feedsWithRate=0」になる。share は
  // ここで snapshot 自身が数えた窓から判定するので、learn.yml に 2 本目の暗黙契約を足さない。
  const share = obs.window.majority.share;
  const { fresh: nearDupFresh, reason: nearDupFreshReason } = nearDupFreshness(
    computeOk,
    share,
  );

  // ディスク天井（YAT-77）。取れなくても行は必ず記録する（観測が取れないことは観測を捨てる
  // 理由にならない）。天井に当たっていた期間を後から系列で判別するための耐久記録。
  const { data: dbSizeData, error: dbSizeErr } = await supabase.rpc("db_size_bytes");
  if (dbSizeErr) console.warn("db_size_bytes の取得に失敗（null で記録して続行）:", dbSizeErr);
  const dbSize = dbSizeErr ? null : Number(dbSizeData);

  console.log("=== feed health snapshot（YAT-55）===");
  console.log(`captured_at: ${capturedAt}`);
  console.log(
    `active ${obs.active.length} feed / 推奨 ${obs.rows.filter((r) => r.result.recommend).length} 件`,
  );
  console.log(describeWindow(obs.window));
  if (obs.window.truncated) {
    console.warn(
      "⚠ 窓が安全弁に達して古い側を切り捨てた。window_embedded だけが頭打ちになるため網羅率は実態より低く出る",
    );
  }
  console.log(
    `near_dup 算出済み ${obs.feedsWithRate} / active ${obs.active.length} feed（構造上限 21・床 ${FEEDS_WITH_RATE_FLOOR}）`,
  );
  if (!nearDupFresh) {
    console.warn(
      nearDupFreshReason === "compute_failed"
        ? "⚠ この run で compute-dedup-rate が成功していない。near_dup_rate は最大 1 週間古い値なので near_dup_fresh=false で記録する"
        : `⚠ レシピ混在中（多数派 share ${share.toFixed(2)} < ${RECIPE_MAJORITY_SHARE}）。compute は全 feed を null にしている＝既知の空白であって障害ではない。near_dup_fresh=false で記録する`,
    );
  }

  // preferences が取れていない観測は pref シグナルが全て 0 になり、low_pref 判定が無意味になる。
  // それを黙って貯めると「嗜好シグナルが健全だった週」として後から誤読されるので、記録しない。
  if (obs.prefsError) {
    console.error(
      "✗ preferences の取得に失敗した。pref が全て 0 の観測は較正に使えないので記録しない:",
      obs.prefsError,
    );
    process.exit(1);
  }

  // active feed が 0 件なら insert する行が無い。compute-dedup-rate と同じく明示的に抜ける
  // （`✓ 0 行を記録した` は成功に見えてしまう）。
  if (obs.rows.length === 0) {
    console.log("active feed が無いため記録するものが無い");
    return;
  }

  // 撮影時に効いていた閾値一式。較正で閾値を動かした後、系列の前後を比較するのに要る。
  // 段階 10 の引き直し対象は MIN_OWN_ARTICLES / NEAR_DUP_RATE 系のみ。RECIPE_* / EMBED_RECIPE_EPOCH /
  // EMBED_MIN_BODY_LEN / feeds_with_rate 系は移行の進行を測る値で、指標の閾値ではない（YAT-77）。
  const thresholds = {
    ...FEED_HEALTH_THRESHOLDS,
    MIN_OWN_ARTICLES,
    PER_FEED_LIMIT,
    WINDOW_DAYS,
    // レシピ移行（YAT-77）
    RECIPE_MAJORITY_SHARE,
    RECIPE_MIXED_GRACE_DAYS,
    EMBED_RECIPE_EPOCH,
    EMBED_MIN_BODY_LEN,
    feeds_with_rate: obs.feedsWithRate,
    feeds_with_rate_floor: FEEDS_WITH_RATE_FLOOR,
    recipe: {
      legacy: obs.window.byRecipe.legacy,
      lead: obs.window.byRecipe.lead,
      share,
      majority: obs.window.majority.recipe,
    },
    coverage_by_recipe: obs.window.coverageByRecipe,
    window_eligible: obs.window.eligible,
    near_dup_fresh_reason: nearDupFreshReason,
    // ディスク天井（YAT-77）。天井 skip 状態を後から系列で判別するための耐久記録。
    DISK_CEILING_BYTES,
    db_size_bytes: dbSize,
    db_size_ratio: dbSize === null ? null : dbSize / DISK_CEILING_BYTES,
  };

  const rows = obs.rows.map((r) => ({
    captured_at: capturedAt,
    feed_id: r.input.id,
    feed_title: r.input.title,
    score: r.result.score,
    reasons: r.result.reasons,
    recommended: r.result.recommend,
    thresholds,
    // Infinity は JSON にできないので null に倒す（＝記事が 1 件も無い＝未発信）。
    // null と「沈黙 0 日」は別物なので、読み出し側は null を除外して集計すること。
    silence_days: Number.isFinite(r.quietMs) ? r.quietMs / DAY_MS : null,
    dead_threshold_days: Number.isFinite(r.deadMs) ? r.deadMs / DAY_MS : null,
    feed_age_days: r.ageMs / DAY_MS,
    credibility: r.input.credibility,
    source_pref: r.input.sourcePref,
    near_dup_rate: r.input.near_dup_rate,
    near_dup_fresh: nearDupFresh,
    own_articles: r.ownArticles,
    window_own_embedded: r.windowOwnEmbedded,
    window_own_articles: r.windowOwnArticles,
    window_own_eligible: r.windowOwnEligible,
    window_articles: obs.window.articles,
    window_embedded: obs.window.embedded,
    window_truncated: obs.window.truncated,
    run_kind: runKind,
  }));

  const { error } = await supabase.from("feed_health_snapshots").insert(rows);
  if (error) {
    console.error(
      "✗ feed_health_snapshots への書き込みに失敗（migration 0015 未適用の可能性）:",
      error.message,
    );
    process.exit(1);
  }

  console.log(`✓ ${rows.length} 行を記録した`);

  // 系列が実際に伸びているかを毎回示す。1 のままなら cron が 1 度しか走っていない＝
  // 「貯めているつもりで貯まっていない」状態で、これは今回直した不具合そのもの。
  const { count, error: cErr } = await supabase
    .from("feed_health_snapshots")
    .select("id", { count: "exact", head: true });
  if (cErr) {
    console.warn("  累計行数の取得に失敗（記録自体は成功している）:", cErr.message);
  } else if (count === null) {
    console.warn("  累計行数が取れなかった（記録自体は成功している）");
  } else {
    console.log(`  累計 ${count} 行（今回 ${rows.length} 行）`);
  }

  // 週次ガード（YAT-77）: near_dup を算出できた feed 数が床を割ったら赤くする。母集団が痩せた
  // 観測はその事実こそ記録すべき値なので、**行を insert してから**判定する（doc [local]）。
  // ただし near_dup_fresh=false（混在期・compute 失敗）のときは feedsWithRate=0 が設計どおりの
  // 正常なので、ガードは fresh のときだけ有効にする——さもないと空白期に毎週赤が出続けて
  // 「うるさいガードを外す → 静かな死」を踏む（doc open 12 と同型）。
  if (nearDupFresh && obs.feedsWithRate < FEEDS_WITH_RATE_FLOOR) {
    console.error(
      `\n✗ near_dup を算出できた active feed が ${obs.feedsWithRate} 本しかない（床 ${FEEDS_WITH_RATE_FLOOR} / 構造上限 21）`,
    );
    console.error(
      `  母集団が痩せている。embed 経路（ingest の embedStalled / embedGateStuck）と feed の本文長を確認`,
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
