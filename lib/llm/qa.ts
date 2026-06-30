import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { createAdminClient } from "@/lib/supabase/admin";
import { embedQuery } from "@/lib/llm/embed";
import { vecToPg } from "@/lib/rss/embed";

// Phase5 横断 Q&A（RAG）の中核（YAT-22）。
// 流れ: クエリを embed（query 非対称）→ pgvector RPC で記事を ANN retrieval → 類似度足切り →
//       ヒット記事を Anthropic Citations の custom content document（記事=1ブロック）で Haiku に
//       渡し、出典付きの回答を得る。retrieval 0 件や embed 不能なら LLM を呼ばず棄権する。
// 呼び出し元はサーバーのみ（Server Action）。API キーは ANTHROPIC_API_KEY / VOYAGE_API_KEY。

const MODEL = "claude-haiku-4-5";

// retrieval パラメータ（YAT-21 調査の初期値。運用で調整する tunable）。
// match_count: Haiku に渡す記事数。要約は 1 件あたり数百トークンで 200K context に余裕がある。
// match_threshold: cosine 類似度の下限。低すぎると無関係記事が混じり grounding と abstain を弱める。
const MATCH_COUNT = 8;
const MATCH_THRESHOLD = 0.4;

const SYSTEM_PROMPT = [
  "あなたは技術記事データベースの横断 Q&A アシスタントです。",
  "与えられた記事（タイトルと要約）だけを根拠に、日本語で簡潔に回答してください。",
  "提供された記事に答えが無い場合は、推測で補わず「提供された記事からは分かりません」と述べること。",
  "事実ベースで答え、どの記事に基づくかは引用で示すこと（引用は自動で付与されます）。",
  "マークダウンの見出しや過剰な箇条書きは使わず、プレーンな文章で書くこと。",
].join("\n");

// retrieval した記事のうち、回答の根拠として UI に出す最小情報。
export type QaSource = {
  id: string;
  title: string | null;
  url: string | null;
  feedId: string;
  publishedAt: string | null;
  similarity: number;
};

export type QaResult =
  | { type: "answer"; text: string; sources: QaSource[] }
  | { type: "abstain"; reason: "no_match" | "no_embedder" | "no_answer" }
  | { type: "error"; message: string };

// match_articles RPC の返却行（supabase-js は型未生成なので明示する）。
type MatchRow = {
  id: string;
  title: string | null;
  summary: string | null;
  url: string | null;
  published_at: string | null;
  feed_id: string;
  similarity: number;
};

export async function answerQuestion(question: string): Promise<QaResult> {
  const q = question.trim();
  if (!q) return { type: "error", message: "質問が空です" };

  // 1. クエリを embed（input_type: "query" の非対称最適化）。
  // キー未設定や embed 失敗は retrieval 不能なので棄権に倒す（決定的 abstain）。
  const queryVec = await embedQuery(q);
  if (!queryVec) return { type: "abstain", reason: "no_embedder" };

  // 2. pgvector ANN retrieval。全記事横断で読むため RLS をバイパスする admin クライアントを使う。
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("match_articles", {
    query_embedding: vecToPg(queryVec),
    match_threshold: MATCH_THRESHOLD,
    match_count: MATCH_COUNT,
  });
  if (error) {
    return { type: "error", message: `検索に失敗しました: ${error.message}` };
  }
  const rows = (data ?? []) as MatchRow[];
  // しきい値は RPC 側で適用済み。ここで 0 件なら関連記事なし＝決定的 abstain。
  if (rows.length === 0) return { type: "abstain", reason: "no_match" };

  // 3. Citations 用の document を組み立てて生成する。記事=1 ブロックにすることで、引用が
  // 記事単位（document_index）に正確に対応する。
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { type: "error", message: "ANTHROPIC_API_KEY が未設定です" };
  }
  const client = new Anthropic({ apiKey });

  const documents: Anthropic.DocumentBlockParam[] = rows.map((r) => ({
    type: "document",
    title: r.title ?? "(無題)",
    citations: { enabled: true },
    source: {
      type: "content",
      content: [
        { type: "text", text: [r.title, r.summary].filter(Boolean).join("\n") },
      ],
    },
  }));

  let res: Anthropic.Message;
  try {
    res = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: "disabled" }, // Haiku は思考非対応
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: [...documents, { type: "text", text: `質問: ${q}` }] },
      ],
    });
  } catch (e) {
    return {
      type: "error",
      message: `回答生成に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const textBlocks = res.content.filter(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  // retrieval はヒットしたが生成が空（稀）。「関連記事なし」とは区別して診断性を保つ。
  const answer = textBlocks.map((b) => b.text).join("").trim();
  if (!answer) return { type: "abstain", reason: "no_answer" };

  // 4. 実際に引用された記事（document_index）を逆引きして根拠記事にする。
  // モデルが引用を付けなかった場合は retrieval 上位をそのまま参照記事として返す（出典常時表示）。
  const citedIdx = new Set<number>();
  for (const b of textBlocks) {
    for (const c of b.citations ?? []) {
      if (c.type === "content_block_location") citedIdx.add(c.document_index);
    }
  }
  const picked = citedIdx.size > 0 ? rows.filter((_, i) => citedIdx.has(i)) : rows;
  const sources: QaSource[] = picked.map((r) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    feedId: r.feed_id,
    publishedAt: r.published_at,
    similarity: r.similarity,
  }));

  return { type: "answer", text: answer, sources };
}
