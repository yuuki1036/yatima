import { config } from "dotenv";

// ローカル実行用に .env.local を読む（本番 Supabase + ANTHROPIC_API_KEY を参照）。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import {
  findBrokenAnnotations,
  annotateRows,
} from "../lib/llm/summarize-batch";

// YAT-81: annotate の JSON パース失敗で「生テキスト（JSON 断片やモデルの注記）が要約に漏れた」
// 記事をピンポイントに直す保守スクリプト。
//
// なぜ retag / ingest では直らないか:
//   - npm run retag …… 対象は「タグ空」だが、要約の上書きは本文を補完したときだけ。要約自体が
//     壊れている行はタグが付くだけで要約は壊れたまま残る。
//   - npm run ingest … summary を手で NULL に戻せば対象にはなるが、annotateMissing が見るのは
//     「published_at が新しい順に limit × POOL_FACTOR 件」の母集団（cron 経路は 20 × 8 = 160 件。
//     ANNOTATE_POOL_CAP=300 には現状どの経路も届かない）から credibility + recency で選んだ
//     上位 20 件/run。新着が毎時入り続けるため、古い記事を NULL に戻しても母集団から押し出されて
//     いつまでも拾われないことがある（静かな取りこぼし）。
//   - このスクリプトは対象 ID を直接アノテートするので、母集団にも日次上限にも依存しない。
//
// 使い方:
//   npm run fix-annotations                 … dry-run（対象の一覧だけ表示・書き込みなし）
//   npm run fix-annotations -- --apply      … 再アノテートを実行（LLM 呼び出しが対象件数ぶん走る）
//   npm run fix-annotations -- --apply --no-enrich … 本文補完をスキップ（既存本文だけで作り直す）
//
// 前提: annotate のパーサ修正（extractJsonObject + "summary" キー検出時は救済しない）が
// 入ったコードで実行すること。修正前のコードで作り直しても同じ壊れ方を繰り返す。

const PREVIEW = 20;

async function main() {
  const apply = process.argv.includes("--apply");
  const enrich = !process.argv.includes("--no-enrich");
  const supabase = createAdminClient();

  console.log(`接続先: ${process.env.NEXT_PUBLIC_SUPABASE_URL ?? "(未設定)"}`);

  const rows = await findBrokenAnnotations(supabase);
  console.log(`要約が壊れている記事: ${rows.length} 件`);
  for (const r of rows.slice(0, PREVIEW)) {
    const summary = (r as { summary?: string }).summary ?? "";
    console.log(`  - [${r.id}] ${r.title ?? "(無題)"}`);
    console.log(`      ${summary.slice(0, 120)}…`);
  }
  if (rows.length > PREVIEW) console.log(`  …ほか ${rows.length - PREVIEW} 件`);

  if (rows.length === 0) {
    console.log("対象なし。終了します。");
    return;
  }

  if (!apply) {
    console.log(
      "\ndry-run（既定）。上の一覧に壊れていない記事が混ざっていないか目視してから、\n" +
        "--apply を付けて再実行してください:\n" +
        "  npm run fix-annotations -- --apply",
    );
    return;
  }

  console.log(
    `\n再アノテート実行${enrich ? "（薄い本文はリンク先から補完）" : "（--no-enrich: 本文補完なし）"} …`,
  );
  // forceSummary: 本文が同じでも要約を上書きする。壊れているのは要約そのものなので、
  // retag の既定（既読の要約を温存）では直らない。
  const r = await annotateRows(supabase, rows, { enrich, forceSummary: true });
  if (r.skipped) {
    console.warn("ANTHROPIC_API_KEY 未設定でスキップしました。");
    return;
  }
  console.log(
    `完了: 対象 ${r.targeted} / タグ付与 ${r.tagged} / タグ0のまま ${r.stillEmpty} / ` +
      `失敗 ${r.failed}（本文補完 ${r.enriched} 件）`,
  );
  if (r.failed > 0) {
    console.warn(
      `※ ${r.failed} 件は失敗しました。要約は壊れたまま残っています（再実行で再試行できます）。`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
