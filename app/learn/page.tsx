import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadCategoryMastery } from "@/lib/learn/mastery";
import { TAG_LEAVES } from "@/lib/tags/vocabulary";
import type { CategoryMastery } from "@/lib/types";
import { startQuizSession, answerQuizQuestion } from "../actions";
import { QuizDeck } from "../_components/quiz-deck";
import { MasteryMap } from "../_components/mastery-map";

// YAT-27: 学習 Module 再起動。旧カード承認キューを廃し、エンジニア知識の適応クイズ（選択式）へ
// 入口を差し替える（design doc 20260702-adaptive-quiz-learn-mode）。旧 card_candidates 系（0007・
// generate-cards・approveCard/rejectCard）は撤去せず凍結（データ保全）。
// YAT-28: picker 下に弱点マップ（tech/* 集約の習熟バー）を表示する。
export const dynamic = "force-dynamic";
// startQuizSession はプール供給のみで即返すが、不足時にレスポンス送出後の裏補充（after）で LLM
// 生成を回す。after はこの maxDuration を共有するため、裏補充が収まるよう延ばしておく（YAT-31）。
export const maxDuration = 60;

// カテゴリピッカーの選択肢: tech/* leaf（学習は技術知識に寄せる）＋末尾に「おまかせ」。
const QUIZ_CATEGORIES = [
  ...TAG_LEAVES.filter((t) => t.parent === "tech").map((t) => ({
    slug: t.slug,
    label: t.label,
  })),
  { slug: "", label: "おまかせ" },
];

export default async function LearnPage() {
  // 弱点マップは失敗してもデッキは出す（fail-soft）。topic_mastery は anon SELECT で通る。
  let mastery: CategoryMastery[] = [];
  try {
    const supabase = await createSupabaseServerClient();
    mastery = await loadCategoryMastery(supabase);
  } catch (e) {
    console.warn("弱点マップの取得に失敗:", e);
  }

  return (
    <QuizDeck
      categories={QUIZ_CATEGORIES}
      startAction={startQuizSession}
      answerAction={answerQuizQuestion}
      masterySlot={<MasteryMap categories={mastery} />}
    />
  );
}
