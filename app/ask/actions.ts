"use server";

import { requireSession } from "@/lib/auth/session";
import { answerQuestion, type QaSource } from "@/lib/llm/qa";

// /ask の横断 Q&A Server Action（YAT-22）。useActionState から FormData で質問を受け、
// retrieval + 生成（lib/llm/qa）を実行して結果を返す。
// proxy.ts が全ルートをゲートしているが、公式 DAL ガイドに従い直 POST 対策で冒頭に
// requireSession を入れる（既存 mutation と同じ二段防御。app/actions.ts と同方針）。

export type AskState =
  | { status: "answer"; question: string; answer: string; sources: QaSource[] }
  | { status: "abstain"; question: string; message: string }
  | { status: "error"; message: string }
  | null;

export async function askQuery(
  _prev: AskState,
  formData: FormData,
): Promise<AskState> {
  await requireSession();

  const question = String(formData.get("q") ?? "").trim();
  if (!question) return { status: "error", message: "質問を入力してください。" };

  const result = await answerQuestion(question);
  switch (result.type) {
    case "answer":
      return {
        status: "answer",
        question,
        answer: result.text,
        sources: result.sources,
      };
    case "abstain": {
      const message =
        result.reason === "no_embedder"
          ? "検索用の埋め込みが利用できません（VOYAGE_API_KEY を確認してください）。"
          : result.reason === "no_answer"
            ? "回答を生成できませんでした。別の言い回しで試してみてください。"
            : "関連する記事が見つかりませんでした。別の言い回しで試してみてください。";
      return { status: "abstain", question, message };
    }
    case "error":
      return { status: "error", message: result.message };
  }
}
