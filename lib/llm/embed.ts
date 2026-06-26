// Voyage AI による埋め込み生成（Anthropic 推奨の embedding プロバイダ。Claude は embedding 非提供）。
// API キーは VOYAGE_API_KEY（NEXT_PUBLIC_ は付けない＝サーバー専用）。呼び出し元は cron スクリプトのみ。
// 用途は記事の重複排除（dedup）。title+summary を embed し pgvector に保存する。
//
// 無料枠（支払い方法未登録）は 3 RPM / 10K TPM に絞られる。これを踏まえ embed() 内部で
// トークン量に応じてリクエストを分割し、リクエスト間隔を空け、429 は指数バックオフで再試行する。

const MODEL = "voyage-3.5-lite";
const DIMENSION = 1024; // 0003_embeddings.sql の vector(1024) と一致させること
const ENDPOINT = "https://api.voyageai.com/v1/embeddings";

// 無料枠（支払い方法未登録）= 3 RPM / 10K TPM。これを下回るよう保守的に設定する。
const TOKEN_BUDGET = 6000; // 1 リクエストあたりの推定トークン上限（10K TPM の余裕を見て）
const MAX_PER_REQUEST = 128; // Voyage の 1 リクエスト最大入力数
const MIN_INTERVAL_MS = 21_000; // リクエスト間隔（3 RPM ≒ 20s/req。余裕を見て 21s）
const MAX_RETRIES = 4; // 429 リトライ回数
const BACKOFF_BASE_MS = 25_000; // バックオフ初期待機（25s, 50s, ...）

export interface Embedder {
  // 複数テキストをまとめて埋め込む。返り値は入力と同順の 1024 次元ベクトル配列。
  // 内部でレート制限に合わせて分割・待機・再試行する。最終的に失敗したら例外を投げる。
  embed(texts: string[]): Promise<number[][]>;
}

type VoyageResponse = {
  data: { embedding: number[]; index: number }[];
};

class RateLimitError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 粗いトークン見積り（日本語混在を考慮して 1 文字 ≒ 1.3 トークンの保守見積り）。
// 正確なトークナイザは持たないが、上限割れを避けるための安全側の概算で足りる。
function estimateTokens(text: string): number {
  return Math.ceil(text.length * 1.3);
}

// トークン上限と件数上限でリクエスト単位に分割する。単独で上限超のテキストは単体チャンクにする。
function chunkByTokens(texts: string[]): { text: string; index: number }[][] {
  const chunks: { text: string; index: number }[][] = [];
  let cur: { text: string; index: number }[] = [];
  let curTok = 0;
  texts.forEach((text, index) => {
    const tok = estimateTokens(text);
    if (
      cur.length > 0 &&
      (curTok + tok > TOKEN_BUDGET || cur.length >= MAX_PER_REQUEST)
    ) {
      chunks.push(cur);
      cur = [];
      curTok = 0;
    }
    cur.push({ text, index });
    curTok += tok;
  });
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

class VoyageEmbedder implements Embedder {
  constructor(private apiKey: string) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const out: number[][] = new Array(texts.length);
    const chunks = chunkByTokens(texts);

    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await sleep(MIN_INTERVAL_MS); // 3 RPM 遵守
      const chunk = chunks[i];
      const vecs = await this.embedChunkWithRetry(chunk.map((c) => c.text));
      // チャンク内の入力順 → 元の index に書き戻す。
      chunk.forEach((c, j) => {
        out[c.index] = vecs[j];
      });
    }
    return out;
  }

  // 429 を指数バックオフで再試行する。それ以外のエラーは即時 throw。
  private async embedChunkWithRetry(
    texts: string[],
    attempt = 0,
  ): Promise<number[][]> {
    try {
      return await this.embedChunk(texts);
    } catch (e) {
      if (e instanceof RateLimitError && attempt < MAX_RETRIES) {
        await sleep(BACKOFF_BASE_MS * 2 ** attempt);
        return this.embedChunkWithRetry(texts, attempt + 1);
      }
      throw e;
    }
  }

  private async embedChunk(texts: string[]): Promise<number[][]> {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: texts,
        model: MODEL,
        input_type: "document",
        output_dimension: DIMENSION,
      }),
    });

    if (res.status === 429) {
      const body = await res.text().catch(() => "");
      throw new RateLimitError(`Voyage 429: ${body.slice(0, 160)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Voyage API ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = (await res.json()) as VoyageResponse;
    // index 順に並べ直して入力順を保証する（API は index 付きで返す）。
    const out: number[][] = new Array(texts.length);
    for (const d of json.data) out[d.index] = d.embedding;
    for (let i = 0; i < texts.length; i++) {
      if (!out[i] || out[i].length !== DIMENSION) {
        throw new Error(`Voyage の返却ベクトルが不正（index ${i}）`);
      }
    }
    return out;
  }
}

// VOYAGE_API_KEY が無ければ null を返し、embed スキップ判定をバッチ側に委ねる（fail-soft）。
export function createEmbedder(): Embedder | null {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return null;
  return new VoyageEmbedder(apiKey);
}

export const EMBEDDING_DIMENSION = DIMENSION;
