import { config } from "dotenv";

// ローカル実行用に .env.local を読む。
// GitHub Actions では secrets が既に process.env にあるため、ここは実質 no-op。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import { ingestAllFeeds } from "../lib/rss/ingest";
import { summarizeMissing } from "../lib/llm/summarize-batch";

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

  // 取得後にバッチ要約（summary IS NULL を埋める）。fail-soft なのでここで CI は赤くしない。
  const s = await summarizeMissing(supabase);
  console.log(
    `要約: 成功 ${s.succeeded} / 失敗 ${s.failed}${s.skipped ? " (ANTHROPIC_API_KEY 未設定でスキップ)" : ""}`,
  );

  // 全フィード失敗時は CI を赤くする
  if (results.length > 0 && failed === results.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
