// 要約プロバイダの最小抽象。実装は Haiku のみだが、
// 将来 Gemini / GPT へ差し替えられるようインターフェースだけ切っておく。

export type SummarizeInput = {
  title: string | null;
  text: string; // タグ除去・切り詰め済みの本文
};

export interface Summarizer {
  // 1〜2文・80〜120字の日本語要約を返す。
  // 空文字列は返さないこと（要約不能なときは例外を投げる）。失敗時の例外はバッチ側で握る。
  summarize(input: SummarizeInput): Promise<string>;
}
