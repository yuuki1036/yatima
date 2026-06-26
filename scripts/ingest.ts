import { config } from "dotenv";

// ローカル実行用に .env.local を読む。
// GitHub Actions では secrets が既に process.env にあるため、ここは実質 no-op。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import { ingestAllFeeds } from "../lib/rss/ingest";
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

  // 今日の10件を確定（日次ガードで冪等。毎時 cron でも当日1回だけ確定される）。
  // キュレーション失敗は ingest 全体を落とさない（fail-soft）。
  try {
    const c = await curateToday(supabase);
    console.log(
      c.skipped
        ? `キュレーション: 本日分は確定済み (${c.picked}件)`
        : `キュレーション: 今日の ${c.picked}件 を確定${c.deduped ? `（近重複 ${c.deduped}件を除外）` : ""}`,
    );
  } catch (e) {
    console.warn("キュレーション失敗:", e);
  }

  // 全フィード失敗時は CI を赤くする
  if (results.length > 0 && failed === results.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
