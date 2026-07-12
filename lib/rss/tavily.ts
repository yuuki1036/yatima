// 情報源の自動発見（YAT-38）方式②の検索層。嗜好テーマを起点に Tavily で候補サイトを引く。
// 責務は「実在する検索結果（URL・タイトル・抜粋）を返す」ことだけ。ここで得た URL は LLM 選別
// （select-sources.ts）と検証ゲート（discover.ts）を必ず通す。LLM に URL を生成させないための
// 「実在 URL の供給源」であり、feed の実在確認はしない（それはゲートの役割）。
// Tavily 無料枠は 1000 クレジット/月（YAT-15 調査）。週次で数〜十数クエリなら十分収まる。

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const FETCH_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RESULTS = 5;

export type TavilyResult = {
  url: string;
  title: string;
  content: string; // 検索スニペット（外部由来テキスト。LLM に渡す前に必ず sanitize する）
};

export type TavilySearchOptions = {
  maxResults?: number;
};

export interface TavilyClient {
  search(query: string, opts?: TavilySearchOptions): Promise<TavilyResult[]>;
}

class HttpTavilyClient implements TavilyClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async search(
    query: string,
    opts: TavilySearchOptions = {},
  ): Promise<TavilyResult[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(TAVILY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: this.apiKey,
          query,
          // basic で十分（サイトの実在 URL が取れればよく、本文抽出はゲートに任せる）。無料枠節約も兼ねる。
          search_depth: "basic",
          max_results: opts.maxResults ?? DEFAULT_MAX_RESULTS,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new Error(`Tavily search 失敗: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as unknown;
    return parseTavilyResults(json);
  }
}

// Tavily レスポンス（{ results: [{ url, title, content }, ...] }）を頑健にパースする。
// 想定外フィールド・欠損は捨てる（fail-soft）。url が http(s) でない要素も落とす。
export function parseTavilyResults(json: unknown): TavilyResult[] {
  if (typeof json !== "object" || json === null) return [];
  const results = (json as Record<string, unknown>).results;
  if (!Array.isArray(results)) return [];

  const out: TavilyResult[] = [];
  for (const item of results) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const url = typeof rec.url === "string" ? rec.url.trim() : "";
    if (!/^https?:\/\//i.test(url)) continue;
    // URL は選別キーとして LLM プロンプトにそのまま埋め込む（sanitize すると照合キーが変わり
    // 包含ガードで落ちる）。だが url は外部由来なので、内部に空白・制御文字を含むものは
    // プロンプト構造を偽造する injection ベクタになりうる。正当な URL は含まないため parse 段で弾く。
    if (/[\s\u0000-\u001F\u007F]/.test(url)) continue;
    const title = typeof rec.title === "string" ? rec.title.trim() : "";
    const content = typeof rec.content === "string" ? rec.content.trim() : "";
    out.push({ url, title, content });
  }
  return out;
}

// TAVILY_API_KEY が無ければ null（呼び出し側が方式②のスキップを判定・fail-soft）。
// 鍵はサーバー専用（NEXT_PUBLIC_ を付けない）。呼び出し元は cron スクリプトのみ。
export function createTavilyClient(): TavilyClient | null {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return null;
  return new HttpTavilyClient(apiKey);
}
