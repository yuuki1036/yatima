import { TAG_LEAVES } from "@/lib/tags/vocabulary";
import { startQuizSession, answerQuizQuestion } from "../actions";
import { QuizDeck } from "../_components/quiz-deck";

// YAT-27: 学習 Module 再起動。旧カード承認キューを廃し、エンジニア知識の適応クイズ（選択式）へ
// 入口を差し替える（design doc 20260702-adaptive-quiz-learn-mode）。旧 card_candidates 系（0007・
// generate-cards・approveCard/rejectCard）は撤去せず凍結（データ保全）。
export const dynamic = "force-dynamic";
// startQuizSession がオンデマンドで LLM 生成を同期実行するため関数時間を延ばす（"/" と同方針）。
export const maxDuration = 60;

// カテゴリピッカーの選択肢: tech/* leaf（学習は技術知識に寄せる）＋末尾に「おまかせ」。
const QUIZ_CATEGORIES = [
  ...TAG_LEAVES.filter((t) => t.parent === "tech").map((t) => ({
    slug: t.slug,
    label: t.label,
  })),
  { slug: "", label: "おまかせ" },
];

export default function LearnPage() {
  return (
    <QuizDeck
      categories={QUIZ_CATEGORIES}
      startAction={startQuizSession}
      answerAction={answerQuizQuestion}
    />
  );
}
