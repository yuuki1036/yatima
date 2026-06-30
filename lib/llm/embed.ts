// Voyage AI による埋め込み生成（Anthropic 推奨の embedding プロバイダ。Claude は embedding 非提供）。
// API キーは VOYAGE_API_KEY（NEXT_PUBLIC_ は付けない＝サーバー専用）。呼び出し元は cron スクリプトのみ。
// 用途は記事の重複排除（dedup）。title+summary を embed し pgvector に保存する。
//
// 無料枠（支払い方法未登録）は 3 RPM / 10K TPM に絞られる。これを踏まえ embed() 内部で
// トークン量に応じてリクエストを分割し、リクエスト間隔を空け、429 は指数バックオフで再試行する。

const MODEL = "voyage-3.5-lite";
const DIMENSION = 1024; // 0003_embeddings.sql の vector(1024) と一致させること
const ENDPOINT = "https://api.voyageai.com/v1/embeddings";

// 無料枠（支払い方法未登録）= 3 RPM / 10K TPM。TPM は分あたりの累積なので、
// 「1 リクエストの上限」だけでなく「3 RPM × 上限」が 10K を超えないことが要件。
// TOKEN_BUDGET=3000 × 3 RPM = 9000 < 10K TPM で両制限を満たす。
// （支払い方法を登録すると 2000 RPM / 3M TPM に緩和されるので、その場合はここを上げてよい）
const TOKEN_BUDGET = 3000; // 1 リクエストあたりの推定トークン上限
const MAX_PER_REQUEST = 128; // Voyage の 1 リクエスト最大入力数
const MIN_INTERVAL_MS = 21_000; // リクエスト間隔（3 RPM ≒ 20s/req。余裕を見て 21s）
const MAX_RETRIES = 4; // 429 リトライ回数
const BACKOFF_BASE_MS = 25_000; // バックオフ初期待機（25s, 50s, ...）

export interface Embedder {
  // 複数テキストをまとめて埋め込む。返り値は入力と同順・同長で、各要素はベクトル、
  // または最終的に失敗したチャンクの要素は null（部分成功を許容）。
  // 内部でレート制限に合わせて分割・待機・再試行する。
  embed(texts: string[]): Promise<(number[] | null)[]>;
}

type VoyageResponse = {
  data: { embedding: number[]; index: number }[];
};

class RateLimitError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 粗いトークン見積り。正確なトークナイザは持たないので「実トークン数の上限」になるよう
// 保守的に見積もる（これにより TOKEN_BUDGET 遵守 → TPM 遵守が保証される）。
// 日本語は Voyage の BPE で概ね 1 文字 ≒ 1 トークン前後になるため、安全側で 2.0 倍を使う
// （英語は 1 文字 ≒ 0.25 トークンなので、混在でも 2.0 倍なら実数を下回らない）。
function estimateTokens(text: string): number {
  return Math.ceil(text.length * 2.0);
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

  async embed(texts: string[]): Promise<(number[] | null)[]> {
    if (texts.length === 0) return [];

    // 既定 null。成功したチャンクの要素だけ上書きする（部分成功を許容＝後半チャンク失敗で
    // 前半の成功を捨てない）。失敗チャンクは null のまま返り、呼び出し側で failed に数える。
    const out: (number[] | null)[] = new Array(texts.length).fill(null);
    const chunks = chunkByTokens(texts);

    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) await sleep(MIN_INTERVAL_MS); // 3 RPM 遵守
      const chunk = chunks[i];
      try {
        const vecs = await this.embedChunkWithRetry(chunk.map((c) => c.text));
        // チャンク内の入力順 → 元の index に書き戻す。
        chunk.forEach((c, j) => {
          out[c.index] = vecs[j];
        });
      } catch (e) {
        // このチャンクは諦めて次へ（該当要素は null のまま）。次回 ingest で再試行され収束する。
        console.warn(
          `embed チャンク失敗（${chunk.length}件スキップ）:`,
          e instanceof Error ? e.message : e,
        );
      }
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

// RAG（YAT-22）の検索クエリ用に、1 本のテキストを input_type: "query" で埋め込む単発関数。
// 保存側（embedMissing）は document で埋めているので、検索側は query を指定して Voyage の
// 非対称最適化（保存=document / 検索=query で別 prefix）を効かせる。保存済みベクトルとは同一
// モデル・同一次元なので再生成は不要。
// バッチ用 Embedder と別口にするのは、Embedder が「document バッチ＋レート分割」前提の設計で、
// 単発クエリには分割も 21s sleep も不要だから（3 RPM に 1 本は余裕で収まる）。
// 失敗（キー未設定 / 429 / API エラー）は null を返す fail-soft。呼び出し側で abstain 判断する。
export async function embedQuery(text: string): Promise<number[] | null> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: [trimmed],
        model: MODEL,
        input_type: "query",
        output_dimension: DIMENSION,
      }),
    });
    if (!res.ok) {
      console.warn(`embedQuery 失敗: Voyage ${res.status}`);
      return null;
    }
    const json = (await res.json()) as VoyageResponse;
    const vec = json.data[0]?.embedding;
    if (!vec || vec.length !== DIMENSION) return null;
    return vec;
  } catch (e) {
    console.warn("embedQuery 例外:", e instanceof Error ? e.message : e);
    return null;
  }
}

export const EMBEDDING_DIMENSION = DIMENSION;
