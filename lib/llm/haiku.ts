import Anthropic from "@anthropic-ai/sdk";
import type { Summarizer, SummarizeInput } from "./types";

// Claude Haiku 4.5 による日本語要約。
// API キーは ANTHROPIC_API_KEY（NEXT_PUBLIC_ は付けない＝クライアントに鍵を漏らさない）。
// 呼び出し元はサーバーのみ: cron スクリプトと Server Action。

const MODEL = "claude-haiku-4-5";

const SYSTEM_PROMPT = [
  "あなたは技術記事の要約者です。",
  "与えられた記事を日本語で1〜2文・80〜120字程度に要約してください。",
  "要点のみを簡潔に述べ、「この記事は」などの前置きや感想は書かないこと。",
  "体言止めも可。マークダウンや箇条書きは使わず、プレーンな文章で返すこと。",
].join("\n");

class HaikuSummarizer implements Summarizer {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async summarize(input: SummarizeInput): Promise<string> {
    const userText = [
      input.title ? `タイトル: ${input.title}` : null,
      `本文: ${input.text}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const res = await this.client.messages.create({
      model: MODEL,
      max_tokens: 300,
      // 要約に思考は不要。Haiku は effort パラメータ非対応のため付けない。
      thinking: { type: "disabled" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userText }],
    });

    // text ブロックのみ連結（将来 thinking 等が混在しても弾く）
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }
}

// ANTHROPIC_API_KEY が無ければ null を返し、要約スキップ判定をバッチ側に委ねる（fail-soft）。
export function createHaikuSummarizer(): Summarizer | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new HaikuSummarizer(apiKey);
}
