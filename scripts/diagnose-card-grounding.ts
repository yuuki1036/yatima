import { config } from "dotenv";

// ローカル実行用に .env.local を読む。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import { createCardGenerator } from "../lib/llm/generate-cards";
import { htmlToInputText } from "../lib/llm/extract-text";
import { cardTarget, isValidFormat } from "../lib/learn/card-gate";
import { MAX_CARDS_PER_ARTICLE } from "../lib/llm/generate-cards";
import {
  norm,
  groundingReason,
  jaccardSpecific,
  MIN_OVERLAP,
  GROUND_BODY_MAX_CHARS,
  type GroundingReason,
} from "../lib/learn/grounding";

// YAT-58: qa/cloze カード経路の grounding 棄却内訳を測る診断スクリプト。
// diagnose-grounding.ts（MCQ 専用・YAT-30）の card 経路版。本番 cron の runCardGate と同じ
// 順序（①形式 →②grounding）・同じ照合母体（本文 + summary）を再現し、④語彙重なりが MCQ と
// 同様に言語ミスマッチで支配的な棄却要因になっているかを数字で確かめる。
// 初回計測（サンプル 6 記事 / 生成 25 件）で④棄却 68%・通過率 12.0% を確認し、MCQ（YAT-30）と
// 同じ判断を card 経路へ転記した（card-gate の CARD_MIN_OVERLAP=0）。以降は④再有効化の是非や
// ②③の棄却率を継続観測するために使う。
// LLM 生成を回すため Anthropic API 課金あり（サンプル記事数を絞って抑える）。
// 再較正に再利用できるよう committed utility として残す。

const SAMPLE_ARTICLES = 6; // 課金を抑える計測サンプル数（tunable。MCQ 版と揃える）
const EXAMPLES = 5; // ダンプする実例の上限

type ArticleRow = {
  id: string;
  title: string | null;
  content_html: string | null;
  summary: string | null;
};

async function main() {
  const supabase = createAdminClient();
  const generator = createCardGenerator();
  if (!generator) {
    console.log("ANTHROPIC_API_KEY 未設定のため診断をスキップしました");
    return;
  }

  // 本番 runCardGate（loadTargetArticles）の母集団は「useful フィードバック済み × summary 有り ×
  // 未カード化」。ここは棄却理由の分布を見るのが目的なので素の新着を取り、MCQ 版と条件を揃えて
  // 経路間で比較できるようにする。ただし summary は照合母体の一部なので本番と同じく必須にする
  // （summary=null が混ざると母体が短くなり②の棄却が本番より出やすくなる）。
  // 既知の限界: published_at 降順の新着は投稿量の多い英語フィードに偏るため、日本語記事×日本語
  // カードの層は事実上サンプルされない。④の言語ミスマッチはこのサンプルでしか確認していない。
  const { data, error } = await supabase
    .from("articles")
    .select("id, title, content_html, summary")
    .not("content_html", "is", null)
    .not("summary", "is", null)
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(SAMPLE_ARTICLES);
  if (error) {
    console.error("記事の取得に失敗:", error);
    process.exit(1);
  }
  const articles = (data ?? []) as unknown as ArticleRow[];
  if (articles.length === 0) {
    console.log("content_html 付きの記事がありません");
    return;
  }

  // 集計カウンタ。
  let generated = 0; // LLM が返した候補総数
  let invalidFormat = 0; // ①形式検証で落ちた数（grounding 以前）
  const reasonCounts: Record<GroundingReason, number> = {
    pass: 0,
    too_short: 0,
    not_verbatim: 0,
    not_specific: 0,
    low_overlap: 0,
  };
  const byType: Record<"qa" | "cloze", { total: number; lowOverlap: number }> = {
    qa: { total: 0, lowOverlap: 0 },
    cloze: { total: 0, lowOverlap: 0 },
  };
  const lowOverlapExamples: {
    type: string;
    quote: string;
    target: string;
    jac: number;
  }[] = [];
  // 本番は grounding 通過後に MAX_CARDS_PER_ARTICLE で切る（runCardGate の slice）。この診断は
  // 棄却理由の分布を見るのが目的なので cap を掛けずに数えるが、④無効化で survivors が増えると
  // cap が binding しやすくなり通過率が実効値より上振れする。差分を可視化するため別途数える。
  let cappedByMaxCards = 0; // cap 適用なら捨てられていた枚数（④無効時の survivors 基準）

  for (const article of articles) {
    // 本番 runCardGate と同じ照合母体の組み方（本文 + summary）。
    const rawBody = [
      htmlToInputText(article.content_html, GROUND_BODY_MAX_CHARS),
      article.summary ?? "",
    ]
      .filter(Boolean)
      .join("\n");
    if (!rawBody) continue;
    const groundBody = norm(rawBody);

    let cards;
    try {
      cards = await generator.generate({
        title: article.title,
        articleText: rawBody,
      });
    } catch (e) {
      console.warn(`生成に失敗 [${article.id}]:`, e);
      continue;
    }
    generated += cards.length;

    // ④無効（＝現行本番）で grounding を通る枚数。cap がこの記事で binding するかを測る。
    const survivorsNoOverlap = cards.filter(
      (c) =>
        isValidFormat(c) &&
        groundingReason(c.source_quote, groundBody, cardTarget(c), 0) === "pass",
    ).length;
    cappedByMaxCards += Math.max(0, survivorsNoOverlap - MAX_CARDS_PER_ARTICLE);

    for (const card of cards) {
      // runCardGate と同じ順: ①形式 → ②grounding。
      if (!isValidFormat(card)) {
        invalidFormat += 1;
        continue;
      }
      // target は本番と同じ組み方（card-gate の cardTarget を共有）。
      // ここは④を有効にした場合の棄却内訳を測るのが目的なので、既定値を明示的に渡す
      // （grounding.ts の注記どおり、省略せず意図を残す）。
      const target = cardTarget(card);
      const reason = groundingReason(card.source_quote, groundBody, target, MIN_OVERLAP);
      reasonCounts[reason] += 1;
      byType[card.type].total += 1;

      if (reason === "low_overlap") {
        byType[card.type].lowOverlap += 1;
        if (lowOverlapExamples.length < EXAMPLES) {
          // 実 jaccard 値と設問を並べ、言語ミスマッチ（英語 quote × 日本語カード）かを目視できるようにする。
          lowOverlapExamples.push({
            type: card.type,
            quote: card.source_quote,
            target,
            jac: jaccardSpecific(norm(card.source_quote), norm(target)),
          });
        }
      }
    }
  }

  const gated = reasonCounts.pass; // ④を有効にした場合（YAT-58 以前の挙動）に通った数
  const afterFormat = generated - invalidFormat;
  const passRate = generated > 0 ? ((gated / generated) * 100).toFixed(1) : "0.0";
  // ④無効（CARD_MIN_OVERLAP=0）の現行本番の通過率。
  const noOverlapPass = reasonCounts.pass + reasonCounts.low_overlap;
  const noOverlapRate =
    generated > 0 ? ((noOverlapPass / generated) * 100).toFixed(1) : "0.0";

  console.log("=== card 経路 grounding 診断（YAT-58） ===");
  console.log(
    `サンプル記事 ${articles.length} / 生成 ${generated} / 形式棄却 ${invalidFormat}`,
  );
  console.log(`grounding 対象 ${afterFormat} 件の内訳:`);
  console.log(`  pass          ${reasonCounts.pass}`);
  console.log(`  too_short(①)  ${reasonCounts.too_short}`);
  console.log(`  not_verbatim(②) ${reasonCounts.not_verbatim}`);
  console.log(`  not_specific(③) ${reasonCounts.not_specific}`);
  console.log(`  low_overlap(④)  ${reasonCounts.low_overlap}`);
  console.log(`  └ ④棄却は生成の ${((reasonCounts.low_overlap / Math.max(1, generated)) * 100).toFixed(1)}%`);
  console.log(`④有効（=${MIN_OVERLAP}）とした場合の grounding 通過率（pass / 生成）= ${passRate}%`);
  console.log(`現行本番の grounding 通過率（④無効: pass+low_overlap / 生成）= ${noOverlapRate}%`);
  console.log(
    `  ※ 上記は枚数上限（MAX_CARDS_PER_ARTICLE=${MAX_CARDS_PER_ARTICLE}）適用前。` +
      `cap で落ちる枚数: ${cappedByMaxCards}`,
  );

  console.log("\n--- type 別の④棄却 ---");
  for (const t of ["qa", "cloze"] as const) {
    const { total, lowOverlap } = byType[t];
    const rate = total > 0 ? ((lowOverlap / total) * 100).toFixed(1) : "0.0";
    console.log(`  ${t.padEnd(5)} grounding対象 ${total} / low_overlap ${lowOverlap}（${rate}%）`);
  }

  if (lowOverlapExamples.length > 0) {
    console.log("\n--- low_overlap 実例（jaccard 値 / quote / カード本体） ---");
    for (const ex of lowOverlapExamples) {
      console.log(`  [${ex.type} jac=${ex.jac.toFixed(3)}]`);
      console.log(`    quote : ${ex.quote.slice(0, 100)}`);
      console.log(`    target: ${ex.target.slice(0, 100)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
