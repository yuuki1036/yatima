import { config } from "dotenv";

// ローカル実行用に .env.local を読む。
// GitHub Actions では secrets が既に process.env にあるため、ここは実質 no-op。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import { runCardGate } from "../lib/learn/card-gate";
import { embedMissingCardCandidates } from "../lib/rss/embed";

// 学習カード生成 cron（YAT-17）の実行スクリプト。週次 cron（learn.yml）と手動実行から呼ぶ。
// ingest（毎時）/ discover（週次）とは分離した低頻度・重いジョブ。
// read 済み・useful な記事から候補を生成 → 機械フィルタ → card_candidates(pending) に積む。
// その場 embed を取りこぼした候補は後追いで補完してから終える（次回 dedup 母集団に乗せる）。
async function main() {
  const supabase = createAdminClient();

  const r = await runCardGate(supabase);
  if (r.skipped) {
    console.log("ANTHROPIC_API_KEY 未設定のためカード生成をスキップしました");
    return;
  }

  const e = await embedMissingCardCandidates(supabase);

  console.log(
    `対象記事 ${r.scannedArticles} / 生成 ${r.generated} / grounding通過 ${r.groundingPassed}\n` +
      `dup ${r.dupFlagged} / 登録 ${r.inserted} / 失敗 ${r.failed}\n` +
      `embed 補完 ${e.succeeded}/${e.picked}${e.skipped ? "（VOYAGE_API_KEY 未設定でスキップ）" : ""}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
