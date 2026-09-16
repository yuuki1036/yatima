// Voyage AI による埋め込み生成（Anthropic 推奨の embedding プロバイダ。Claude は embedding 非提供）。
// API キーは VOYAGE_API_KEY（NEXT_PUBLIC_ は付けない＝サーバー専用）。呼び出し元は cron スクリプトのみ。
// 用途は記事の重複排除（dedup）。title＋本文冒頭を embed し pgvector に保存する（YAT-77 で
// 要約から切り離した。テキストの作り方は lib/rss/embed.ts の articleEmbedText を参照）。
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
// 1 リクエスト（fetch＋レスポンス）の実測余裕（YAT-77）。締切判定で「次のチャンクを着手すると
// リクエストが締切を跨ぐか」を見積もるために間隔に足す。実測 ~2s に保守側マージンを乗せる。
const EXPECTED_REQUEST_MS = 3_000;

export interface Embedder {
  // 複数テキストをまとめて埋め込む。返り値は入力と同順・同長で、各要素はベクトル、
  // または最終的に失敗したチャンクの要素は null（部分成功を許容）。
  // 内部でレート制限に合わせて分割・待機・再試行する。
  // opts.deadlineMs（epoch ms）を渡すと、締切を跨ぎそうなチャンクは着手せず未着手のまま
  // null を返す（次 run で拾う）。未指定なら締切なし＝従来の挙動（YAT-77 の壁時計予算）。
  embed(texts: string[], opts?: { deadlineMs?: number }): Promise<(number[] | null)[]>;
  // この Embedder が今までに消費した実トークンの累計（Voyage の usage.total_tokens）。
  // TPM 台帳（YAT-76）用。テスト用のモック実装では省略できるよう optional にする。
  usedTokens?(): number;
  // 直近の embed() で「締切に間に合わず着手しなかった」入力数（YAT-77）。usedTokens と同じ
  // アクセサ方式にするのは返り値の配列契約（入力と同順・同長）を壊さないため。呼び出し側は
  // attempted = picked - lastDeferred() で「失敗」と「未着手」を分ける（前者は Voyage 障害、
  // 後者は単に次 run で拾うだけ）。モックでは省略可。
  lastDeferred?(): number;
}

type VoyageResponse = {
  data: { embedding: number[]; index: number }[];
  usage?: { total_tokens: number };
};

class RateLimitError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 締切まで needMs 以上残っているか（YAT-77 の壁時計予算）。deadlineMs 未指定なら常に true
// （締切なし＝従来の挙動）。境界（残りちょうど needMs）は「間に合わない側」に倒す。
// 純関数として export しテストで固定する（VoyageEmbedder は非 export のため）。
export function hasTimeBudget(
  deadlineMs: number | undefined,
  needMs: number,
  now: number = Date.now(),
): boolean {
  return deadlineMs === undefined || now + needMs < deadlineMs;
}

// 粗いトークン見積り。正確なトークナイザは持たないので「実トークン数の上限」になるよう
// 保守的に見積もる（これにより TOKEN_BUDGET 遵守 → TPM 遵守が保証される）。
//
// 旧実装は一律 2.0 倍で、英語主体のテキスト（実際は 1 文字 ≒ 0.25 トークン）を最大 8 倍に
// 過大見積もりしていた。10K TPM の無料枠では見積もりがそのまま予算消費になるため、
// 過大なぶんだけ 1 リクエストに詰められる件数が減り、embed の消化が遅くなる（YAT-76）。
// 文字種で分けて上限を締める: ASCII は 0.4 倍（実測 ~0.25 の上限）、それ以外（CJK・
// アクセント付き・キリル等）は 1.5 倍（日本語の実測 ~1.0 前後の上限。希少漢字も覆う）。
// どちらも実数を下回らない側に倒してあるので TPM 遵守の保証は変わらない。
// 実測（usage.total_tokens）との突き合わせは ingest の TPM 台帳ログで行う。
export function estimateTokens(text: string): number {
  let ascii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) <= 0x7f) ascii += 1;
  }
  const nonAscii = text.length - ascii;
  return Math.ceil(ascii * 0.4 + nonAscii * 1.5);
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
  // 実消費トークンの累計（usage.total_tokens の合算）。10K TPM の無料枠で「1 run が
  // いくら使ったか」を台帳としてログに出すため（YAT-76）。失敗チャンクは usage が
  // 返らないので加算されない＝台帳は「実際に課金対象になった消費」を表す。
  private tokensUsed = 0;
  // 直近の embed() で締切により未着手のまま残した入力数（YAT-77）。
  private deferred = 0;

  usedTokens(): number {
    return this.tokensUsed;
  }

  lastDeferred(): number {
    return this.deferred;
  }

  constructor(private apiKey: string) {}

  async embed(
    texts: string[],
    opts: { deadlineMs?: number } = {},
  ): Promise<(number[] | null)[]> {
    this.deferred = 0;
    if (texts.length === 0) return [];

    // 既定 null。成功したチャンクの要素だけ上書きする（部分成功を許容＝後半チャンク失敗で
    // 前半の成功を捨てない）。失敗チャンクは null のまま返り、呼び出し側で failed に数える。
    const out: (number[] | null)[] = new Array(texts.length).fill(null);
    const chunks = chunkByTokens(texts);

    for (let i = 0; i < chunks.length; i++) {
      const wait = i > 0 ? MIN_INTERVAL_MS : 0;
      // 締切を跨ぎそうなら、以降のチャンクは着手せず未着手（deferred）として残す。null のまま
      // 返るが「失敗」ではない——次 run で拾う。deferred と failed を分けるのは、締切の持ち越しを
      // Voyage の恒常障害（isEmbedDead）と取り違えないため。
      if (!hasTimeBudget(opts.deadlineMs, wait + EXPECTED_REQUEST_MS)) {
        this.deferred = chunks.slice(i).reduce((s, c) => s + c.length, 0);
        console.log(`embed 締切到達: 残り ${this.deferred} 件は次回 run に送る`);
        break;
      }
      if (wait > 0) await sleep(wait); // 3 RPM 遵守
      const chunk = chunks[i];
      try {
        const vecs = await this.embedChunkWithRetry(
          chunk.map((c) => c.text),
          0,
          opts.deadlineMs,
        );
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
  // deadlineMs を渡すと、次のバックオフ待機で締切を跨ぐ場合は再試行せず throw する（YAT-77）。
  // この経路は「実際に 429 を食ったチャンク」なので deferred ではなく failed に数える
  // ——静かに握り潰すと Voyage 側のレート張り付きが見えなくなる。
  private async embedChunkWithRetry(
    texts: string[],
    attempt = 0,
    deadlineMs?: number,
  ): Promise<number[][]> {
    try {
      return await this.embedChunk(texts);
    } catch (e) {
      if (e instanceof RateLimitError && attempt < MAX_RETRIES) {
        const backoff = BACKOFF_BASE_MS * 2 ** attempt;
        if (!hasTimeBudget(deadlineMs, backoff)) throw e;
        await sleep(backoff);
        return this.embedChunkWithRetry(texts, attempt + 1, deadlineMs);
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
    this.tokensUsed += json.usage?.total_tokens ?? 0;
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
