import Anthropic from "@anthropic-ai/sdk";

// YAT-32: 学習クイズの知識ソース（公式 docs・定番解説）の URL を LLM に提案させる。
// 責務は「候補 URL を出す」だけ。出力は一切信頼せず、URL は必ず fetch＋本文抽出の検証ゲート
// （lib/learn/source-discovery.ts）を通し、幻覚 URL・リンク切れ・薄いページは捨てる。
// ※ URL を LLM に直接生成させるのは情報源発見（YAT-16）が避けた方式で、本設計の新規リスクテイク。
// だからこそ「出力を信じない」を検証ゲートで担保する（design 20260707・review F-C）。

const MODEL = "claude-haiku-4-5";

// 1 回の提案で出させる候補数（検証で減るので気持ち多めに出させる）。
export const PROPOSE_COUNT = 5;

export type ProposedSource = {
  url: string;
  title: string; // 推定タイトル（表示用。検証 fetch で上書きしうる）
  rationale: string; // なぜ定番/公式か（承認の判断材料）
};

export type ProposeSourcesInput = {
  categoryLabel: string; // 提案テーマ（tech/* の表示名）
  existingUrls: string[]; // 既存 learn_sources の URL（重複提案を避けさせる）
  count: number;
  hint?: string; // 任意の絞り込みヒント（例「TypeScript, React, Next.js」）。カテゴリが粗いときに sub-topic へ steer する
};

export interface SourceProposer {
  propose(input: ProposeSourcesInput): Promise<ProposedSource[]>;
}

function buildSystemPrompt(input: ProposeSourcesInput): string {
  const avoid =
    input.existingUrls.length > 0
      ? `次の URL は既に登録済みなので提案しないこと:\n${input.existingUrls.join("\n")}`
      : "";
  const hint = input.hint
    ? `特に次のトピックを優先して絞り込むこと: ${input.hint}。`
    : "";
  return [
    "あなたはエンジニアの学習教材キュレーターです。",
    `テーマ「${input.categoryLabel}」について、腰を据えた学習に向く「息の長い（evergreen）」情報源の URL を提案してください。`,
    hint,
    "優先するもの: 公式ドキュメント、公式ガイド/チュートリアル、定番の解説記事・仕様。",
    "避けるもの: ニュース記事、リリース告知、○○が発表した系の時事、まとめ・ランキング、SNS 投稿、動画。",
    `候補は ${input.count} 件。実在が確実で安定した URL（トップページでなく該当解説の具体ページが望ましい）にすること。`,
    "各候補に、なぜそれが定番/公式で学習に向くかの理由（rationale）を1文で付けること。",
    avoid,
    "出力は次の形式の JSON 配列のみ。前置き・コードフェンス・説明文は一切付けないこと:",
    '[{"url":"https://...","title":"ページ名","rationale":"なぜ定番/公式か"}]',
    "確信の持てる候補が無ければ空配列 [] を返すこと（存在しない URL を創作しないこと）。",
  ]
    .filter(Boolean)
    .join("\n");
}

// LLM 出力（JSON 配列）を頑健にパースする。フェンス除去 → [ から ] を抽出 → JSON.parse →
// 要素ごとに url/title/rationale を検証。url が http(s) でない・空要素は捨てる（fail-soft）。
// ※ ここは形式チェックのみ。URL の実在性は検証ゲート（fetch）が担う。
export function parseProposedSources(raw: string): ProposedSource[] {
  if (!raw) return [];
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];

  let arr: unknown;
  try {
    arr = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const out: ProposedSource[] = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const url = typeof rec.url === "string" ? rec.url.trim() : "";
    if (!/^https?:\/\//i.test(url)) continue; // http(s) 以外は形式段で捨てる
    const title = typeof rec.title === "string" ? rec.title.trim() : "";
    const rationale =
      typeof rec.rationale === "string" ? rec.rationale.trim() : "";
    out.push({ url, title, rationale });
  }
  return out;
}

class HaikuSourceProposer implements SourceProposer {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async propose(input: ProposeSourcesInput): Promise<ProposedSource[]> {
    const res = await this.client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      thinking: { type: "disabled" },
      system: buildSystemPrompt(input),
      messages: [
        { role: "user", content: `テーマ: ${input.categoryLabel}` },
      ],
    });
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return parseProposedSources(text);
  }
}

// ANTHROPIC_API_KEY が無ければ null（呼び出し側が提案スキップを判定）。
export function createSourceProposer(): SourceProposer | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new HaikuSourceProposer(apiKey);
}
