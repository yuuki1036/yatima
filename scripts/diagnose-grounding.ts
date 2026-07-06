import { config } from "dotenv";

// ローカル実行用に .env.local を読む。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import { createQuizGenerator, MAX_MCQ_PER_ARTICLE } from "../lib/llm/generate-quiz";
import { htmlToInputText } from "../lib/llm/extract-text";
import {
  norm,
  groundingReason,
  jaccardSpecific,
  GROUND_BODY_MAX_CHARS,
  type GroundingReason,
} from "../lib/learn/grounding";
import { conceptSlug } from "../lib/learn/concept";

// YAT-30: 適応クイズの grounding 通過率ボトルネックの診断スクリプト。
// 本番 cron 経路（quiz-gate の gateMCQs）を再現し、生成 MCQ が①長さ/②逐語/③固有性/④overlap の
// どの段で落ちるかを集計する。当てずっぽうでプロンプト/閾値を触らず、支配的な棄却段を数字で特定する。
// LLM 生成を回すため Anthropic API 課金あり（サンプル記事数を絞って抑える）。
// 再較正（閾値変更・正規化追加の効果確認）に再利用できるよう committed utility として残す。

const SAMPLE_ARTICLES = 6; // 課金を抑える計測サンプル数（tunable）
const NOT_VERBATIM_EXAMPLES = 5; // ダンプする not_verbatim 実例の上限

type ArticleRow = { id: string; title: string | null; content_html: string | null };

// 約物・全角/半角の揺れを追加正規化した版（②逐語失敗が「約物揺れ由来か」を切り分ける仮説検証用）。
// 本番 norm には入れない（診断専用）。全角英数→半角、代表的な引用符/ダッシュ/省略記号を統一する。
function normPunct(s: string): string {
  return norm(s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    )
    .replace(/[“”„‟＂]/g, '"')
    .replace(/[‘’‚‛＇]/g, "'")
    .replace(/[—–―ー─]/g, "-")
    .replace(/[…‥]/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  const supabase = createAdminClient();
  const generator = createQuizGenerator();
  if (!generator) {
    console.log("ANTHROPIC_API_KEY 未設定のため診断をスキップしました");
    return;
  }

  // content_html 付きの新着記事をサンプルとして取る（tech 絞りはせず素の新着＝生成の素材分布に近い）。
  const { data, error } = await supabase
    .from("articles")
    .select("id, title, content_html")
    .not("content_html", "is", null)
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
  let conceptDropped = 0; // concept 正規化で空 slug になり捨てた数
  const reasonCounts: Record<GroundingReason, number> = {
    pass: 0,
    too_short: 0,
    not_verbatim: 0,
    not_specific: 0,
    low_overlap: 0,
  };
  let notVerbatimFixableByPunct = 0; // not_verbatim のうち normPunct なら通る数（約物揺れ仮説）
  const notVerbatimExamples: { quote: string; punctFix: boolean }[] = [];
  const lowOverlapExamples: { quote: string; stem: string; jac: number }[] = [];

  for (const article of articles) {
    const rawBody = htmlToInputText(article.content_html, GROUND_BODY_MAX_CHARS);
    if (!rawBody) continue;
    const groundBody = norm(rawBody);
    const groundBodyPunct = normPunct(rawBody);

    let mcqs;
    try {
      mcqs = await generator.generate({
        title: article.title,
        articleText: rawBody,
        categoryLabel: "エンジニア技術全般",
        count: MAX_MCQ_PER_ARTICLE,
        existingConcepts: [],
      });
    } catch (e) {
      console.warn(`生成に失敗 [${article.id}]:`, e);
      continue;
    }
    generated += mcqs.length;

    for (const q of mcqs) {
      // gateMCQs と同じ順: concept 正規化 → grounding。
      if (!conceptSlug(q.concept_label)) {
        conceptDropped += 1;
        continue;
      }
      const target = `${q.stem} ${q.choices.join(" ")}`;
      const reason = groundingReason(q.source_quote, groundBody, target);
      reasonCounts[reason] += 1;

      if (reason === "not_verbatim") {
        const punctFix = groundBodyPunct.includes(normPunct(q.source_quote));
        if (punctFix) notVerbatimFixableByPunct += 1;
        if (notVerbatimExamples.length < NOT_VERBATIM_EXAMPLES) {
          notVerbatimExamples.push({ quote: q.source_quote, punctFix });
        }
      }
      if (reason === "low_overlap" && lowOverlapExamples.length < NOT_VERBATIM_EXAMPLES) {
        // 実 jaccard 値と設問を並べ、言語ミスマッチ（英語 quote × 日本語設問）かを目視できるようにする。
        lowOverlapExamples.push({
          quote: q.source_quote,
          stem: q.stem,
          jac: jaccardSpecific(norm(q.source_quote), norm(target)),
        });
      }
    }
  }

  const gated = reasonCounts.pass; // 既定閾値（④=0.12）で grounding を通った数
  const afterConcept = generated - conceptDropped;
  const passRate = generated > 0 ? ((gated / generated) * 100).toFixed(1) : "0.0";
  // 本番 quiz は④無効（QUIZ_MIN_OVERLAP=0）なので、low_overlap も実質 pass になる。
  const quizPass = reasonCounts.pass + reasonCounts.low_overlap;
  const quizPassRate = generated > 0 ? ((quizPass / generated) * 100).toFixed(1) : "0.0";

  console.log("=== grounding 診断（YAT-30） ===");
  console.log(`サンプル記事 ${articles.length} / 生成 ${generated} / concept 棄却 ${conceptDropped}`);
  console.log(`grounding 対象 ${afterConcept} 件の内訳:`);
  console.log(`  pass          ${reasonCounts.pass}`);
  console.log(`  too_short(①)  ${reasonCounts.too_short}`);
  console.log(`  not_verbatim(②) ${reasonCounts.not_verbatim}（うち約物正規化で通る: ${notVerbatimFixableByPunct}）`);
  console.log(`  not_specific(③) ${reasonCounts.not_specific}`);
  console.log(`  low_overlap(④)  ${reasonCounts.low_overlap}`);
  console.log(`通過率（既定閾値④=0.12: pass / 生成）= ${passRate}%`);
  console.log(`本番 quiz 実効通過率（④無効: pass+low_overlap / 生成）= ${quizPassRate}%`);

  if (notVerbatimExamples.length > 0) {
    console.log("\n--- not_verbatim 実例（source_quote と約物正規化可否） ---");
    for (const ex of notVerbatimExamples) {
      console.log(`  [punctFix=${ex.punctFix}] ${ex.quote.slice(0, 120)}`);
    }
  }

  if (lowOverlapExamples.length > 0) {
    console.log("\n--- low_overlap 実例（jaccard 値 / quote / 設問） ---");
    for (const ex of lowOverlapExamples) {
      console.log(`  [jac=${ex.jac.toFixed(3)}]`);
      console.log(`    quote: ${ex.quote.slice(0, 100)}`);
      console.log(`    stem : ${ex.stem.slice(0, 100)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
