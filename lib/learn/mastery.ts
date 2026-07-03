import type { SupabaseClient } from "@supabase/supabase-js";
import type { QuizDifficulty } from "@/lib/types";

// YAT-27: 回答の記録と mastery 更新（MVP は素の正答率のみ）。quiz_attempts に 1 行積み、
// topic_mastery を concept 単位の running 正答率で upsert する。難易度加重・間隔ボーナス・
// selectSessionQuestions の適応選定は YAT-28 で本モジュールを拡張する（ここはその土台）。
// is_correct は呼び出し側（Server Action）が DB の answer_index と突き合わせて確定する（client 値を
// 信用しない）。

export type RecordAttemptParams = {
  questionId: string;
  conceptKey: string;
  conceptLabel: string;
  category: string;
  difficulty: QuizDifficulty;
  isCorrect: boolean;
  chosenIndex: number;
};

// 回答を quiz_attempts へ記録し、topic_mastery を running 正答率で更新する。
// 失敗は握り潰さず throw する（呼び出し側の Server Action が fire-and-forget で warn する）。
export async function recordQuizAttempt(
  supabase: SupabaseClient,
  p: RecordAttemptParams,
): Promise<void> {
  await supabase.from("quiz_attempts").insert({
    question_id: p.questionId,
    concept_key: p.conceptKey,
    difficulty: p.difficulty,
    is_correct: p.isCorrect,
    chosen_index: p.chosenIndex,
  });

  // 現在の mastery を読んで running 平均を更新する（単一ユーザーなので read-modify-write で十分）。
  const { data: cur } = await supabase
    .from("topic_mastery")
    .select("mastery, attempts")
    .eq("concept_key", p.conceptKey)
    .maybeSingle();

  const prevAttempts = cur?.attempts ?? 0;
  const prevMastery = cur?.mastery ?? 0;
  const attempts = prevAttempts + 1;
  // 素の正答率: (これまでの正答数 + 今回) / 総回答数。難易度加重は YAT-28。
  const mastery = (prevMastery * prevAttempts + (p.isCorrect ? 1 : 0)) / attempts;

  await supabase.from("topic_mastery").upsert(
    {
      concept_key: p.conceptKey,
      concept_label: p.conceptLabel,
      category: p.category,
      mastery,
      attempts,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "concept_key" },
  );
}
