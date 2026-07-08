import { config } from "dotenv";

// ローカル実行用に .env.local を読む（本番 Supabase + ANTHROPIC_API_KEY を参照）。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import {
  findUntaggedSummarized,
  annotateUntagged,
} from "../lib/llm/summarize-batch";
import { curateToday } from "../lib/ranking/curate";
import { todayJst } from "../lib/format";

// YAT-13: 要約はあるがタグが空の記事をピンポイントに再アノテートする保守スクリプト。
//
// 背景: annotate の JSON パース失敗で「要約のみ・タグ空」に落ちた記事は annotateMissing
// （summary IS NULL のみ対象）では拾えず残る。タグが無いと興味順スコアに乗らないため、
// ここで対象を抽出 → 本文補完（薄い記事のみ）→ 再アノテートでタグを補う。
//
// 使い方:
//   npm run retag                    … dry-run（対象件数のみ表示・書き込みなし）
//   npm run retag -- --apply         … 再アノテートを実行（タグを付与・LLM 呼び出しが走る）
//   npm run retag -- --apply --no-enrich        … 本文補完をスキップして既存本文だけで再アノテート
//   npm run retag -- --apply --recurate-today   … 再アノテート後、今日のデッキを作り直してタグ嗜好を即反映
//
// --recurate-today の注意: 当日（JST）ピック済みの picked_date / score を NULL に戻して
// curateToday を再実行する。フィードバック済みのカードも候補から外れて入れ替わるため、
// 「タグ語彙を大きく変えた直後だけ」使う想定（通常は翌日 cron の自然反映に任せる）。

async function main() {
  const apply = process.argv.includes("--apply");
  const enrich = !process.argv.includes("--no-enrich");
  const recurate = process.argv.includes("--recurate-today");
  const supabase = createAdminClient();

  console.log(`接続先: ${process.env.NEXT_PUBLIC_SUPABASE_URL ?? "(未設定)"}`);

  const rows = await findUntaggedSummarized(supabase);
  console.log(`タグ空（要約済み）の記事: ${rows.length} 件`);
  for (const r of rows.slice(0, 20)) {
    console.log(`  - [${r.id}] ${r.title ?? "(無題)"}`);
  }
  if (rows.length > 20) console.log(`  …ほか ${rows.length - 20} 件`);

  if (rows.length === 0) {
    console.log("対象なし。終了します。");
    return;
  }

  if (!apply) {
    console.log(
      "\ndry-run（既定）。実際に再アノテートするには --apply を付けて再実行してください:\n" +
        "  npm run retag -- --apply",
    );
    return;
  }

  console.log(
    `\n再アノテート実行${enrich ? "（薄い本文はリンク先から補完）" : "（--no-enrich: 本文補完なし）"} …`,
  );
  const r = await annotateUntagged(supabase, { enrich });
  if (r.skipped) {
    console.warn("ANTHROPIC_API_KEY 未設定でスキップしました。");
    return;
  }
  console.log(
    `完了: 対象 ${r.targeted} / タグ付与 ${r.tagged} / タグ0のまま ${r.stillEmpty} / ` +
      `失敗 ${r.failed}（本文補完 ${r.enriched} 件）`,
  );
  if (r.stillEmpty > 0) {
    console.warn(
      `※ ${r.stillEmpty} 件は再アノテートしてもタグが付きませんでした（本文不足や "other" 該当なし）。`,
    );
  }

  if (recurate) {
    const today = todayJst();
    console.log(`\n--recurate-today: ${today} のデッキを作り直します …`);
    // reset と curate は別トランザクションのため、reset 後に curate が失敗すると当日デッキが
    // 「全 picked_date/score 喪失」のまま残る。先に当日ピックを控えておき、失敗時に書き戻す。
    const { data: snapshot, error: snapErr } = await supabase
      .from("articles")
      .select("id, picked_date, score")
      .eq("picked_date", today);
    if (snapErr) throw snapErr;
    // 当日ピックを未ピックに戻す（picked_date / score を NULL）。判定済みカードも候補へ
    // 戻るため、再 curate でデッキが入れ替わりうる点に留意（運用上は稀用）。
    const { error: resetErr } = await supabase
      .from("articles")
      .update({ picked_date: null, score: null })
      .eq("picked_date", today);
    if (resetErr) throw resetErr;
    try {
      const c = await curateToday(supabase);
      console.log(
        c.skipped
          ? "キュレーション: デッキ充足のため補充なし"
          : `キュレーション: デッキに ${c.picked}件 を補充${c.explored ? `（探索枠 ${c.explored}件）` : ""}${c.deduped ? `（近重複 ${c.deduped}件を除外）` : ""}`,
      );
    } catch (e) {
      console.error(
        `再 curate に失敗。reset 前の当日デッキ（${snapshot?.length ?? 0}件）を復元します:`,
        e,
      );
      for (const r of snapshot ?? []) {
        await supabase
          .from("articles")
          .update({ picked_date: r.picked_date, score: r.score })
          .eq("id", r.id);
      }
      throw e;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
