import { config } from "dotenv";

// ローカル実行用に .env.local を読む。
// GitHub Actions では secrets が既に process.env にあるため、ここは実質 no-op。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import { runQuizPool } from "../lib/learn/quiz-pool";

// 適応クイズのコアプール生成 cron（YAT-29）。週次 cron（learn.yml）と手動実行から呼ぶ。
// 旧カード生成（generate-cards）を差し替えたエントリ。カテゴリ別の未回答バッファの不足分を生成し、
// その場 embed → dedup（近重複は dup_flag=true で積む。YAT-61）→ quiz_questions(active) に積む。
// その場 embed に失敗して embedding=null で残った行は、先頭でバックフィルしてから dedup 母集団に載せる。
async function main() {
  const supabase = createAdminClient();

  const r = await runQuizPool(supabase);
  if (r.skipped) {
    console.log("ANTHROPIC_API_KEY 未設定のためクイズ生成をスキップしました");
    return;
  }

  // insert が失敗すると inserted=0 のまま dupFlagged だけ残るため、内訳は insert 成功時のみ出す
  // （素直に引くと「登録 0（うち出題可 -5）」になり、障害時に最も見たいログが壊れる）。
  const breakdown =
    r.inserted > 0 ? `（うち出題可 ${r.inserted - r.dupFlagged}）` : "";
  // YAT-63: 候補 embed 側も backfill 側と同じくキー未設定を判別する。区別が無いと「Voyage の障害で
  // 失敗した」と「キーが無くて一度も呼んでいない」がどちらも embed失敗=N に潰れ、設定漏れを
  // API 障害として調べ始めることになる。
  const embedNote = r.embedSkipped ? "（VOYAGE_API_KEY 未設定でスキップ）" : "";
  console.log(
    `不足カテゴリ ${r.deficitCategories} / 生成 ${r.generated} / grounding通過 ${r.passed}\n` +
      `dup flag ${r.dupFlagged} / embed失敗 ${r.embedFailed}${embedNote} / 登録 ${r.inserted}${breakdown}\n` +
      `embed 補完 ${r.backfill.succeeded}/${r.backfill.picked}` +
      `${r.backfill.skipped ? "（VOYAGE_API_KEY 未設定でスキップ）" : ""}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
