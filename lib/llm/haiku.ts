import Anthropic from "@anthropic-ai/sdk";
import type { Summarizer, SummarizeInput, Annotation } from "./types";
import { sanitizeSummary } from "./sanitize";
import { parseAnnotation } from "./parse-annotation";
import { coerceTags, TAG_VOCAB_PROMPT } from "@/lib/tags/vocabulary";

// Claude Haiku 4.5 による日本語要約。
// API キーは ANTHROPIC_API_KEY（NEXT_PUBLIC_ は付けない＝クライアントに鍵を漏らさない）。
// 呼び出し元はサーバーのみ: cron スクリプトと Server Action。

const MODEL = "claude-haiku-4-5";

const SYSTEM_PROMPT = [
  "あなたは技術記事の要約者です。",
  "与えられた記事を日本語で1〜2文・80〜120字程度に要約してください。",
  "要点のみを簡潔に述べ、「この記事は」などの前置きや感想は書かないこと。",
  "体言止めも可。マークダウンや箇条書きは使わず、プレーンな文章で返すこと。",
  "見出し（# 記号）やラベル（「要約:」「記事の要約」など）は一切付けず、要約本文だけを返すこと。",
].join("\n");

// Phase3: 要約 + 固定語彙タグを JSON で同時生成するためのプロンプト。
const ANNOTATE_SYSTEM_PROMPT = [
  "あなたは技術記事の分類・要約者です。",
  "与えられた記事について、日本語の要約とタグを JSON で返してください。",
  "出力は次の形式の JSON オブジェクトのみ。前置き・コードフェンス・説明文は一切付けないこと:",
  '{"summary": "...", "tags": ["...", "..."]}',
  "summary: 日本語で1〜2文・80〜120字程度。要点のみ簡潔に。「この記事は」等の前置きや感想は書かず、体言止めも可。マークダウンやラベルは付けない。",
  'tags: 次の固定リストから関連する slug を1〜3個選ぶ。リスト外の語は禁止。該当が薄ければ "other" を使う。',
  `タグ候補: ${TAG_VOCAB_PROMPT}`,
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
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    // プロンプト指示を無視して付く見出し/ラベルを後処理で除去
    return sanitizeSummary(text);
  }

  async annotate(input: SummarizeInput): Promise<Annotation> {
    const userText = [
      input.title ? `タイトル: ${input.title}` : null,
      `本文: ${input.text}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const res = await this.client.messages.create({
      model: MODEL,
      max_tokens: 500, // 要約 + tags の JSON 分のマージン（要約のみの 300 から増量）
      thinking: { type: "disabled" },
      system: ANNOTATE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userText }],
    });

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const parsed = parseAnnotation(text);
    if (!parsed) {
      // JSON 化失敗 → 生テキストを要約として救済し、タグは諦める（fail-soft）。
      const summary = sanitizeSummary(text);
      if (!summary) throw new Error("要約が空");
      return { summary, tags: [] };
    }
    // tags は coerceTags で語彙外/重複を捨て最大3件に。summary は二重保険で sanitize。
    const summary = sanitizeSummary(parsed.summary);
    if (!summary) throw new Error("要約が空");
    return { summary, tags: coerceTags(parsed.tags) };
  }
}

// ANTHROPIC_API_KEY が無ければ null を返し、要約スキップ判定をバッチ側に委ねる（fail-soft）。
export function createHaikuSummarizer(): Summarizer | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new HaikuSummarizer(apiKey);
}
