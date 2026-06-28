import { config } from "dotenv";

// ローカル実行用に .env.local を読む。
// GitHub Actions では secrets が既に process.env にあるため、ここは実質 no-op。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import {
  collectCandidatesFromArticles,
  discoverFromArticles,
} from "../lib/rss/discover-articles";

// 情報源の自動発見（YAT-16）方式①の実行スクリプト。週次 cron（discover.yml）と手動実行から呼ぶ。
// ingest（毎時）とは分離した低頻度・重いジョブ。--dry-run では候補抽出までで止め、feed の探索も
// feed_candidates への登録もしない（フィルタの当たりを目視確認するため）。
async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const supabase = createAdminClient();

  if (dryRun) {
    const { inputs, scannedArticles } =
      await collectCandidatesFromArticles(supabase);
    console.log(`走査記事: ${scannedArticles} 件 / 候補ドメイン: ${inputs.length} 件\n`);
    for (const i of inputs) {
      console.log(`  ${i.siteUrl}  (${i.discoveredFrom})`);
    }
    console.log("\n[dry-run] 探索・登録はスキップしました");
    return;
  }

  const r = await discoverFromArticles(supabase);
  console.log(
    `走査記事 ${r.scannedArticles} / 候補 ${r.candidateDomains} / 検査 ${r.examined}\n` +
      `feed 検出 ${r.discovered} / 新規登録 ${r.inserted} / ` +
      `既存feedで除外 ${r.skippedExisting} / 既存候補で除外 ${r.skippedCandidate}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
