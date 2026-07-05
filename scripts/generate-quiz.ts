import { config } from "dotenv";

// ローカル実行用に .env.local を読む。
// GitHub Actions では secrets が既に process.env にあるため、ここは実質 no-op。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import { runQuizPool } from "../lib/learn/quiz-pool";

// 適応クイズのコアプール生成 cron（YAT-29）。週次 cron（learn.yml）と手動実行から呼ぶ。
// 旧カード生成（generate-cards）を差し替えたエントリ。カテゴリ別 active プールの不足分を生成し、
// その場 embed → dedup（近重複は skip）→ quiz_questions(active) に積む。オンデマンド由来の
// embedding=null 行は先頭でバックフィルしてから dedup 母集団に載せる。
async function main() {
  const supabase = createAdminClient();

  const r = await runQuizPool(supabase);
  if (r.skipped) {
    console.log("ANTHROPIC_API_KEY 未設定のためクイズ生成をスキップしました");
    return;
  }

  console.log(
    `不足カテゴリ ${r.deficitCategories} / 生成 ${r.generated} / grounding通過 ${r.passed}\n` +
      `dup skip ${r.dupSkipped} / embed失敗 ${r.embedFailed} / 登録 ${r.inserted}\n` +
      `embed 補完 ${r.backfill.succeeded}/${r.backfill.picked}` +
      `${r.backfill.skipped ? "（VOYAGE_API_KEY 未設定でスキップ）" : ""}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
