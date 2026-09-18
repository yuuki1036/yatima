import { config } from "dotenv";

// ローカル実行用に .env.local を読む（本番 Supabase を参照）。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import { SUMMARY_MAX_ATTEMPTS } from "../lib/llm/summarize-batch";

// 隔離（summary_attempts >= 3）から記事を戻す保守スクリプト（YAT-78・ADR-20260906205227）。
//
// 帰責は「同ラウンドの証人」で分けるが、run の後半だけ壊れる部分障害では前半の証人により
// 後半の失敗が誤って課金されうる（ADR「悪い影響」）。クレジット切れ・レート制限の張り付きで
// 記事固有でない失敗が 3 回積もると候補から永久に外れるため、原因を直したあとにここで戻す。
//
// summary_attempts=0 に戻すだけ（summary_last_error / summary_last_failed_at の痕跡は残す
// ——「同じ記事が何度も落ちている」を後から読めるようにするため）。
// 破壊的なので dry-run を既定にし、--apply 明示時のみ書き換える（resummarize / retag と同じ作法）。

type QuarantinedRow = {
  id: string;
  title: string | null;
  summary_last_error: string | null;
  summary_last_failed_at: string | null;
};

async function main() {
  const apply = process.argv.includes("--apply");
  const supabase = createAdminClient();

  console.log(`接続先: ${process.env.NEXT_PUBLIC_SUPABASE_URL ?? "(未設定)"}`);

  // 隔離中（attempts >= 閾値）の記事を列挙する。件数が多くなりうるのでページ走査せず、
  // 表示は先頭 50 件に留める（全件戻すのが目的なので個別確認より件数の把握が主眼）。
  const PREVIEW = 50;
  const { data, error, count } = await supabase
    .from("articles")
    .select("id, title, summary_last_error, summary_last_failed_at", {
      count: "exact",
    })
    .gte("summary_attempts", SUMMARY_MAX_ATTEMPTS)
    .order("summary_last_failed_at", { ascending: false, nullsFirst: false })
    .limit(PREVIEW);
  if (error) throw error;

  const total = count ?? 0;
  const rows = (data ?? []) as QuarantinedRow[];
  console.log(
    `隔離中（summary_attempts >= ${SUMMARY_MAX_ATTEMPTS}）の記事: ${total} 件`,
  );
  if (total === 0) {
    console.log("対象なし。終了します。");
    return;
  }
  for (const r of rows) {
    console.log(
      `  - [${r.id}] ${r.title ?? "(無題)"}${r.summary_last_error ? `: ${r.summary_last_error}` : ""}`,
    );
  }
  if (total > PREVIEW) console.log(`  …ほか ${total - PREVIEW} 件`);

  if (!apply) {
    console.log(
      "\ndry-run（既定）。実際に隔離を解除するには --apply を付けて再実行してください:\n" +
        "  npm run unquarantine -- --apply",
    );
    return;
  }

  // 絞り込み条件で一括更新（ID 列挙による URL 長超過を避ける）。痕跡列は温存する。
  const { error: updErr } = await supabase
    .from("articles")
    .update({ summary_attempts: 0 })
    .gte("summary_attempts", SUMMARY_MAX_ATTEMPTS);
  if (updErr) throw updErr;

  console.log(`\n完了: ${total} 件の summary_attempts を 0 に戻しました（痕跡は温存）。`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
