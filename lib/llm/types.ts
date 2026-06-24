// 要約プロバイダの最小抽象。実装は Haiku のみだが、
// 将来 Gemini / GPT へ差し替えられるようインターフェースだけ切っておく。

import type { TagSlug } from "@/lib/tags/vocabulary";

export type SummarizeInput = {
  title: string | null;
  text: string; // タグ除去・切り詰め済みの本文
};

// Phase3: 要約 + 固定語彙タグを1回の LLM 呼び出しで返す。
export type Annotation = {
  summary: string;
  tags: TagSlug[]; // 固定語彙内 leaf のみ（呼び出し側で coerce 済み）
};

export interface Summarizer {
  // 1〜2文・80〜120字の日本語要約を返す。
  // 空文字列は返さないこと（要約不能なときは例外を投げる）。失敗時の例外はバッチ側で握る。
  summarize(input: SummarizeInput): Promise<string>;

  // 要約とタグを同時生成する（LLM 呼び出しを増やさないため要約と同梱）。
  // 失敗時の例外はバッチ側で握る。タグ取得に失敗しても要約は救済する（実装側 fail-soft）。
  annotate(input: SummarizeInput): Promise<Annotation>;
}
