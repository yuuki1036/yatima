import { config } from "dotenv";

// ローカル実行用に .env.local を読む。
// GitHub Actions では secrets が既に process.env にあるため、ここは実質 no-op。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import { ingestAllFeeds } from "../lib/rss/ingest";
import {
  findStaleFeeds,
  formatStale,
  STALE_ALERT_HOURS,
} from "../lib/rss/ingest-health";
import { enrichMissingBodies } from "../lib/rss/enrich";
import { annotateMissing } from "../lib/llm/summarize-batch";
import { embedMissing } from "../lib/rss/embed";
import { curateToday } from "../lib/ranking/curate";

async function main() {
  const supabase = createAdminClient();
  const results = await ingestAllFeeds(supabase);

  let total = 0;
  let failed = 0;
  for (const r of results) {
    if (r.error) {
      failed += 1;
      console.error(`✗ ${r.feedUrl}: ${r.error}`);
    } else {
      total += r.inserted;
      console.log(`✓ ${r.feedUrl}: +${r.inserted}`);
    }
  }
  console.log(
    `\n完了: ${results.length} フィード / 新規 ${total} 記事 / 失敗 ${failed} 件`,
  );

  // 要約前に、本文が薄い記事（HN 等）の本文をリンク先から取得して補完する（fail-soft）。
  const en = await enrichMissingBodies(supabase);
  console.log(
    `本文補完: 取得 ${en.enriched} / 失敗 ${en.failed}（対象 ${en.thin} 件）`,
  );

  // 取得後にバッチ要約+タグ付け（summary IS NULL を埋める）。fail-soft なのでここで CI は赤くしない。
  const s = await annotateMissing(supabase);
  console.log(
    `要約+タグ: 成功 ${s.succeeded} / 失敗 ${s.failed}${s.skipped ? " (ANTHROPIC_API_KEY 未設定でスキップ)" : ""}`,
  );

  // 要約済み記事を embed（重複排除用。summary 済み×embedding NULL が対象。fail-soft）。
  const em = await embedMissing(supabase);
  console.log(
    `embedding: 成功 ${em.succeeded} / 失敗 ${em.failed}${em.skipped ? " (VOYAGE_API_KEY 未設定でスキップ)" : ""}`,
  );

  // デッキを未判定10件へ補充（連続トップアップ。未判定が10件あれば skip で冪等）。
  // キュレーション失敗は ingest 全体を落とさない（fail-soft）。
  try {
    const c = await curateToday(supabase);
    console.log(
      c.skipped
        ? `キュレーション: デッキ充足のため補充なし`
        : `キュレーション: デッキに ${c.picked}件 を補充${c.explored ? `（探索枠 ${c.explored}件）` : ""}${c.deduped ? `（近重複 ${c.deduped}件を除外）` : ""}`,
    );
  } catch (e) {
    console.warn("キュレーション失敗:", e);
  }

  // ── 失敗の可視化（YAT-68）─────────────────────────────────────────────
  // 単発の失敗は上の console.error に出るだけで、毎時 24 回のログに埋もれる。恒常的に
  // 落ちている feed は exit(1) で CI を赤くして気付けるようにする（Import AI が 15 日間
  // 403 で落ち続けたのを退役推奨で知る、という遅すぎる検知が起票の理由）。
  const stale = findStaleFeeds(results);
  if (stale.length > 0) {
    console.error(
      `\n⚠ ${STALE_ALERT_HOURS} 時間以上ずっと取得に失敗している feed が ${stale.length} 件:`,
    );
    for (const s of stale) {
      console.error(
        `  - ${s.title ?? s.feedUrl}（最後の成功から ${formatStale(s.staleMs)}）: ${s.error}`,
      );
      console.error(`    ${s.feedUrl}`);
    }
    console.error(
      `  feed 側が死んだのか、取得元の環境が弾かれているのかはローカルからの取得と見比べること`,
    );
  }

  // 全フィード失敗は「6 時間待たずに今すぐ赤くすべき」別の障害モードなので併存させる。
  const allFailed = results.length > 0 && failed === results.length;
  if (allFailed || stale.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
