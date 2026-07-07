import { config } from "dotenv";

// ローカル実行用に .env.local を読む（GitHub Actions では secrets が process.env にある）。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";

// YAT-32: 学習ソースを evergreen へ切り替える移行の一度きり script。既存の「時事記事由来」の
// active クイズを retire（status→retired・行は消さない）し、/learn を evergreen 生成分だけにする。
//
// 安全ガード（design review F-J）:
// - 既定は dry-run（対象件数の表示のみ）。実際に更新するには `--apply` を付ける。
// - 対象は「記事由来 = source_ref が learn_sources.id に一致しない active」に限定する。evergreen 生成後
//   に誤って再実行しても、learn_sources 由来の問題は source_ref が一致するため retire されない（冪等）。
// - mastery / quiz_attempts は concept_key 基準で保全される（retire は status 更新で行を消さない）。
// - 実行順序: 生成切替のデプロイ後・ソース承認前に一度だけ実行するのが基本（retire 直後は /learn が
//   「準備中」note になり、ソース承認→生成でプールが再充填される）。
//
// 巻き戻し（誤実行時）: この script が retire した ids を戻すには、直前の実行ログの対象 ids に対して
//   update quiz_questions set status='active' where id in (...) and status='retired';
// を実行する（source_ref 条件は retire 時と同じなので、evergreen 問題を誤って active に戻すことはない）。

const APPLY = process.argv.includes("--apply");

async function main() {
  const supabase = createAdminClient();

  // 承認済みに限らず全 learn_sources の id を集める（source_ref が learn_source を指すなら evergreen 由来）。
  const { data: srcRows, error: srcErr } = await supabase
    .from("learn_sources")
    .select("id");
  if (srcErr) throw srcErr;
  const learnSourceIds = new Set((srcRows ?? []).map((r) => r.id as string));

  // active の quiz_questions を全件（id, source_ref）取得する。プールは目標深度で頭打ち（≈100）。
  const { data: qRows, error: qErr } = await supabase
    .from("quiz_questions")
    .select("id, source_ref")
    .eq("status", "active")
    .limit(10_000);
  if (qErr) throw qErr;

  const active = qRows ?? [];
  // 記事由来 = source_ref が learn_sources.id 集合に無い（null 含む）。evergreen 由来は除外して保全する。
  const targetIds = active
    .filter((r) => {
      const ref = r.source_ref as string | null;
      return !ref || !learnSourceIds.has(ref);
    })
    .map((r) => r.id as string);

  console.log(
    `active 合計 ${active.length} / retire 対象（記事由来）${targetIds.length} / ` +
      `保全（evergreen 由来）${active.length - targetIds.length}`,
  );

  if (targetIds.length === 0) {
    console.log("対象なし。終了します。");
    return;
  }

  if (!APPLY) {
    console.log("dry-run（--apply 未指定）。更新は行いません。対象 ids:");
    console.log(targetIds.join(","));
    console.log("実行するには `npm run retire-news-quiz -- --apply` を付けてください。");
    return;
  }

  const { error: upErr } = await supabase
    .from("quiz_questions")
    .update({ status: "retired" })
    .in("id", targetIds);
  if (upErr) throw upErr;

  console.log(`retire 完了: ${targetIds.length} 件を status='retired' に更新しました。`);
  console.log("巻き戻しが必要な場合は上記 ids を controlled に active へ戻してください。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
