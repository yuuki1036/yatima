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

  // ── LLM 全滅の検知（YAT-73）─────────────────────────────────────────────
  // 「補充対象があるのに 1 問も生成できなかった」は fail-soft で流してよい状態ではない。
  // カテゴリ単位の LLM 失敗は generateGatedQuizRows が握るため、放置すると 0 問のまま緑で流れる。
  // 実際 2026-08-22 に Anthropic のクレジット切れで生成 0 になったが run は success だった
  // （気付けたのは手動実行してログを見たからで、cron 任せなら何週も気付かなかった）。
  //
  // deficitCategories は在庫ゲート（承認済み learn_sources の有無）を通過した後にインクリメント
  // される。したがって素材待ちで skip したカテゴリはこの判定に入らず、
  // **作れるはずなのに作れなかった**場合だけが残る。
  //
  // passed（grounding 通過）は見ない。生成はできたが全部落ちたのは素材の質の問題でありうるので、
  // 同列に扱うと誤検知が増える。まず generated === 0 だけを見る。
  if (r.deficitCategories > 0 && r.generated === 0) {
    console.error(
      `\n⚠ 補充対象が ${r.deficitCategories} カテゴリあるのに 1 問も生成できていない`,
    );
    console.error(
      `  LLM 呼び出しが全滅している可能性が高い（API キー・クレジット残高・レート制限を確認）`,
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
