import { config } from "dotenv";

// ローカル実行用に .env.local を読む。GitHub Actions では secrets が process.env にあり no-op。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import {
  collectFeedHealthObservation,
  describeWindow,
} from "../lib/ranking/feed-health-observation";

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

const DAY_MS = 86_400_000;

async function main() {
  const supabase = createAdminClient();
  const now = Date.now();
  const capturedAt = new Date(now).toISOString();

  const obs = await collectFeedHealthObservation(supabase, now);

  console.log("=== feed health snapshot（YAT-55）===");
  console.log(`captured_at: ${capturedAt}`);
  console.log(
    `active ${obs.active.length} feed / 推奨 ${obs.rows.filter((r) => r.result.recommend).length} 件`,
  );
  console.log(describeWindow(obs.window));

  // preferences が取れていない観測は pref シグナルが全て 0 になり、low_pref 判定が無意味になる。
  // それを黙って貯めると「嗜好シグナルが健全だった週」として後から誤読されるので、記録しない。
  if (obs.prefsFailed) {
    console.error(
      "✗ preferences の取得に失敗した。pref が全て 0 の観測は較正に使えないので記録しない",
    );
    process.exit(1);
  }

  const rows = obs.rows.map((r) => ({
    captured_at: capturedAt,
    feed_id: r.input.id,
    feed_title: r.input.title,
    score: r.result.score,
    reasons: r.result.reasons,
    recommended: r.result.recommend,
    // Infinity は JSON にできないので null に倒す（＝記事が 1 件も無い＝未発信）。
    // null と「沈黙 0 日」は別物なので、読み出し側は null を除外して集計すること。
    silence_days: Number.isFinite(r.quietMs) ? r.quietMs / DAY_MS : null,
    dead_threshold_days: Number.isFinite(r.deadMs) ? r.deadMs / DAY_MS : null,
    credibility: r.input.credibility,
    source_pref: r.input.sourcePref,
    near_dup_rate: r.input.near_dup_rate,
    own_articles: r.withEmbedding,
    window_articles: obs.window.articles,
    window_embedded: obs.window.embedded,
    window_truncated: obs.window.truncated,
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
    .select("captured_at", { count: "exact", head: true });
  if (!cErr && count !== null) {
    console.log(`  累計 ${count} 行（${obs.active.length} 行/回）`);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
