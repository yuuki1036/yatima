import type { SupabaseClient } from "@supabase/supabase-js";
import { createEmbedder, estimateTokens, type Embedder } from "@/lib/llm/embed";
import { htmlToInputText } from "@/lib/llm/extract-text";

// 取得→要約の後に呼ぶバッチ埋め込み。embedding 未生成の行を拾い、対象テキストを Voyage で embed
// して `<table>.embedding`（pgvector）に保存する。articles（YAT-3）とカード候補（YAT-17）が共有する。
// 設計方針: fail-soft。例外は外へ漏らさず集計に畳む（embedding 由来でジョブを止めない）。
// 既存の embedding NULL 行は次回実行で自然にバックフィルされる。

// skip の理由。ガード側（ingest-health）の carve-out 判定に使う。no_api_key（キー未設定）と
// disk_ceiling（DB が 450MB 超・YAT-77）。後者は exit 1 にしない設計なので、生存系ガード
// （isEmbedStalled / isEmbedGateStuck）はこの値を明示的に除外する。
export type EmbedSkipReason = "no_api_key" | "disk_ceiling";

type EmbedBatchCounts = {
  picked: number; // 選抜で取得した件数（embedding NULL の候補）
  // 実際に embed を試みた件数（= picked - deferred）。isEmbedDead の分母。
  attempted: number;
  // 壁時計締切で未着手のまま次 run に送った件数（YAT-77）。picked = attempted + deferred。
  // 「失敗」ではないので isEmbedDead の分子分母に混ぜない。
  deferred: number;
  succeeded: number;
  failed: number; // = attempted - succeeded
  // この run の Voyage 実消費（usage.total_tokens の合算）と、estimateTokens による見積もり合計。
  // TPM 台帳（YAT-76）: 実測と見積もりを並べてログに出し、見積もり係数のずれを観測する。
  // embedder が消費を報告しない（モック等）場合は tokensUsed を持たない。
  tokensUsed?: number;
  tokensEstimated?: number;
};

// skipped と skipReason を判別可能ユニオンで結ぶ。skip したなら理由が必ず要る——
// 天井 skip（YAT-77）を足すとき skipped だけ立てて skipReason を付け忘れると、
// isEmbedStalled の carve-out（skipReason !== 'disk_ceiling'）が効かず、意図的に止めた run が
// 永久赤になる。この付け忘れをコンパイルエラーにするのが目的。skipReason?: never で
// 非 skip 側への理由の混入も塞ぐ。件数・トークンは skip 有無に関わらず読むので共通に残す。
export type EmbedBatchResult =
  | (EmbedBatchCounts & { skipped: true; skipReason: EmbedSkipReason })
  | (EmbedBatchCounts & { skipped: false; skipReason?: never });

// articles 経路（embedMissing）専用の上乗せ（YAT-77）。交差型はユニオンに分配されるので
// skipped/skipReason の判別可能性は保たれる。card/quiz 経路の EmbedBatchResult には付かない。
export type ArticleEmbedResult = EmbedBatchResult & {
  // ゲート前の候補数（select_embed_candidates.pending）。-1 は取得不能（判定不能）。
  pending: number;
  // ゲート後＝実際に選ばれうる件数（.eligible）。-1 は取得不能。embedHealthCounts の分母に運ぶ。
  eligible: number;
  // 選抜 RPC（または天井 RPC）が落ちたときの理由。null なら正常。isEmbedSelectStalled が読む。
  selectError: string | null;
};

// 1 回の実行で埋め込む上限（card/quiz 経路の DEFAULT。articles は EMBED_MAX_ROWS）。
// 無料枠（3 RPM / 10K TPM）だと throughput が ~8.5K tokens/分に制限され、実測で 24 件 embed に
// 約 4 分かかった。残りは次回消化。支払い方法を登録してレート制限が緩んだら上げてよい。
const DEFAULT_LIMIT = 16;

// ディスク天井（YAT-77・design doc open 11。ユーザー確定 450MB）。base-2 で数える
// （Supabase の表示に合わせる）。db_size_bytes() がこれ以上なら embed を skip する（exit 1 はしない）。
export const DISK_CEILING_BYTES = 450 * 1024 * 1024;

// embed の壁時計予算（YAT-77）。3 分 = 8 リクエスト ≒ 130〜175 件/run（design doc「壁時計予算」）。
export const EMBED_WALL_CLOCK_MS = 180_000;

// embed ゲートの本文長下限（YAT-77）。分布の谷（240-249: 144 件 / 250-259: 104 件 /
// 290-299: 1,907 件）。⚠ この値を変えるときは migration 0017 の idx_articles_embed_pending の
// 述語（250 が焼き込まれている・design doc open 6）も張り直すこと。動かさず閾値だけ変えると
// index が効かず seq scan に落ちる（静かな劣化）。
export const EMBED_MIN_BODY_LEN = 250;

// 新レシピ（YAT-77）の本文冒頭の長さ。800 件実測で title+summary と有向 maxSim 分布がほぼ一致
// （p50 0.741/0.741・p90 0.801/0.800）した値。DEDUP_THRESHOLD=0.86 を流用できる根拠。
export const EMBED_LEAD_CHARS = 250;

// articles 1 run の選抜上限（YAT-77）。3 分の壁時計で消化できる件数から決める:
//   消化側: チャンク間隔 21s ＋ リクエスト実測 ~2s ≒ 23s。3 分なら 1 + floor((180-3)/23) ≈ 8 チャンク。
//   1 チャンクの件数 = TOKEN_BUDGET 3000 / estimateTokens(title 60 字 + 本文 250 字):
//     全 ASCII ≈ 124 tok → 24 件 / 全 CJK ≈ 465 tok → 6 件 / 混在（本番の実勢）≈ 280 tok → 10 件。
//   → 1 run の実消化は 48（CJK 最悪）/ 80（混在）/ 192（ASCII 最良）。
//   フェッチ側: RPC の content_head は先頭 8,000 字 ≒ 8KB/行。120 なら 0.96MB/run・23MB/日 で、
//   混在ケースの取りこぼしは 40 行ぶん（0.3MB/run）に収まる。max_rows=200 だと egress 1.1GB/月
//   （無料枠 5GB の 23%）で半分以上は締切で未着手のまま捨てる。「混在ケースの実消化＋余裕」で置く。
// per_day 導入（YAT-80）で再検証する。
export const EMBED_MAX_ROWS = 120;

// per_day（feed 別日次キャップ）は YAT-80 まで実質無効。RPC の room = per_day - used を常に
// 十分大きくする番兵値を渡す。
const EMBED_PER_DAY_DISABLED = 100_000;

// pgvector へは文字列リテラル '[v1,v2,...]' で書き込む（PostgREST が text→vector にキャスト）。
// card-gate のその場 embed→insert でも使うため export する。
export function vecToPg(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

// embedding を補完する汎用バッチ。テーブル名・select 列・埋め込みテキストの作り方・並びを注入で
// 受け、PostgREST ビルダの操作は本関数内に閉じ込める（呼び出し側にビルダ型を漏らさない）。
type EmbedTableOpts = {
  table: string;
  selectColumns: string;
  embedTextOf: (row: Record<string, unknown>) => string;
  // 必須でない行を除外する列（カード候補は指定なし）。articles は select_embed_candidates 経由に
  // 移行したので使わなくなった（YAT-77）が、card/quiz 経路のため option としては残す。
  requireColumn?: string;
  // 特定の列値だけに絞る等値フィルタ（quiz は active のみ補完＝retired に embed 予算を使わない）。
  eqFilter?: { column: string; value: string };
  // この時刻以降の行だけを候補にする下限（列は orderBy と同じ想定）。articles は RPC の 30 日窓に
  // 移ったので現在の呼び出し側では未使用（YAT-77）。card/quiz 経路のため残す。
  minTimestamp?: { column: string; value: string };
  // 成功時に embedding と同時に now() を打つ列。embedStalled の「直近 26h で 1 件も進んでいない」
  // 判定の分子になる。
  stampColumn?: string;
  orderBy: { column: string; ascending: boolean; nullsFirst?: boolean };
  limit?: number;
  embedder?: Embedder | null;
};

// 空の counts（skip / 対象ゼロ用）。attempted/deferred を required にしているので、
// 早期 return がこれらを付け忘れるとコンパイルエラーになる（YAT-77）。
const EMPTY_COUNTS: EmbedBatchCounts = {
  picked: 0,
  attempted: 0,
  deferred: 0,
  succeeded: 0,
  failed: 0,
};

type EmbedRowsOpts = {
  table: string;
  embedTextOf: (row: Record<string, unknown>) => string;
  stampColumn?: string;
  embedder: Embedder; // null 判定は呼び出し側で済ませる
  deadlineMs?: number; // 壁時計締切（YAT-77・articles のみ渡す）
};

// 取得済みの行配列を embed して保存し、件数に畳む（YAT-77 で embedMissingFromTable から切り出し。
// articles 経路は候補取得を RPC に移したためこの下半分だけを共有する）。rows は 1 件以上を前提。
async function embedRows(
  supabase: SupabaseClient,
  rows: Record<string, unknown>[],
  opts: EmbedRowsOpts,
): Promise<EmbedBatchCounts & { skipped: false }> {
  // まとめて埋め込む（Voyage はバッチ入力可）。embed は内部で分割・レート制御し、失敗チャンクの
  // 要素は null で返す（部分成功を許容）。deadlineMs 到達で未着手になった末尾も null で返る。
  const texts = rows.map(opts.embedTextOf);
  const tokensEstimated = texts.reduce((s, t) => s + estimateTokens(t), 0);
  const tokensBefore = opts.embedder.usedTokens?.();
  let vectors: (number[] | null)[];
  try {
    vectors = await opts.embedder.embed(texts, { deadlineMs: opts.deadlineMs });
  } catch (e) {
    // embed 全体が throw するのは想定外（チャンク失敗は null 化される）。保険で全件 failed に。
    console.warn(`embed API 呼び出しに失敗（${opts.table}）:`, e);
    return {
      picked: rows.length,
      attempted: rows.length,
      deferred: 0,
      succeeded: 0,
      failed: rows.length,
      skipped: false,
    };
  }

  // 締切で未着手のまま残った件数。deferred は必ず末尾のチャンク（embed が順に処理し break する）
  // なので、attempted は先頭 (picked - deferred) 件になる。failed は attempted - succeeded で出す
  // ——deferred の null を failed に混ぜない（次 run で拾うだけなので障害ではない）。
  const deferred = opts.embedder.lastDeferred?.() ?? 0;
  const attempted = rows.length - deferred;

  let succeeded = 0;
  // 保存は1件ずつ（embedding 値が行ごとに異なるため bulk update できない）。fail-soft。
  for (let i = 0; i < rows.length; i++) {
    const vec = vectors[i];
    // null は「チャンク失敗」か「締切未着手」。どちらも embedding NULL のまま次回再試行で収束する。
    if (!vec) continue;
    try {
      const patch: Record<string, unknown> = { embedding: vecToPg(vec) };
      if (opts.stampColumn) patch[opts.stampColumn] = new Date().toISOString();
      const { error } = await supabase
        .from(opts.table)
        .update(patch)
        .eq("id", rows[i].id as string);
      if (error) throw error;
      succeeded += 1;
    } catch (e) {
      console.warn(`embedding 保存失敗 [${opts.table}/${rows[i].id}]:`, e);
    }
  }

  const tokensAfter = opts.embedder.usedTokens?.();
  return {
    picked: rows.length,
    attempted,
    deferred,
    succeeded,
    failed: attempted - succeeded,
    skipped: false,
    tokensEstimated,
    // usedTokens は Embedder 累計なので run 分は差分で出す（同一 embedder の使い回しに耐える）。
    tokensUsed:
      tokensAfter !== undefined && tokensBefore !== undefined
        ? tokensAfter - tokensBefore
        : undefined,
  };
}

async function embedMissingFromTable(
  supabase: SupabaseClient,
  opts: EmbedTableOpts,
): Promise<EmbedBatchResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const embedder =
    opts.embedder !== undefined ? opts.embedder : createEmbedder();

  // API キー未設定 → embed スキップ（呼び出し元のジョブは成功扱い）
  if (!embedder) {
    return { ...EMPTY_COUNTS, skipped: true, skipReason: "no_api_key" };
  }

  let rows: Record<string, unknown>[] = [];
  try {
    let query = supabase
      .from(opts.table)
      .select(opts.selectColumns)
      .is("embedding", null);
    if (opts.requireColumn) {
      query = query.not(opts.requireColumn, "is", null);
    }
    if (opts.eqFilter) {
      query = query.eq(opts.eqFilter.column, opts.eqFilter.value);
    }
    if (opts.minTimestamp) {
      query = query.gte(opts.minTimestamp.column, opts.minTimestamp.value);
    }
    const { data, error } = await query
      .order(opts.orderBy.column, {
        ascending: opts.orderBy.ascending,
        nullsFirst: opts.orderBy.nullsFirst ?? false,
      })
      .limit(limit);
    if (error) throw error;
    // 動的テーブル名の select は PostgREST 型が解決できず GenericStringError 化するため unknown 経由で
    // キャストする（行の実体は注入した selectColumns どおりのレコード）。
    rows = (data ?? []) as unknown as Record<string, unknown>[];
  } catch (e) {
    console.warn(`embed 対象の取得に失敗（${opts.table}）:`, e);
    return { ...EMPTY_COUNTS, skipped: false };
  }

  if (rows.length === 0) {
    return { ...EMPTY_COUNTS, skipped: false };
  }

  return embedRows(supabase, rows, {
    table: opts.table,
    embedTextOf: opts.embedTextOf,
    stampColumn: opts.stampColumn,
    embedder,
  });
}

// 新レシピ（YAT-77）の embedding テキスト。title＋本文冒頭 250 字。要約に依存しない
// （切り離しの本体）。content_head は select_embed_candidates が返す先頭 8,000 字の生 HTML なので、
// ここで htmlToInputText してから 250 字に切る（body_text_len は SQL 側の trigger 値で、ゲート
// 判定にのみ使う。テキスト整形は JS 側の htmlToInputText に揃える）。
// title だけは棄却済み（p90 が 0.836 に上振れし英日クロス言語の転載ペアを取りこぼす）。
export function articleEmbedText(row: {
  title?: unknown;
  content_head?: unknown;
}): string {
  const lead = htmlToInputText(
    typeof row.content_head === "string" ? row.content_head : null,
  ).slice(0, EMBED_LEAD_CHARS);
  return [row.title, lead].filter(Boolean).join("\n");
}

// 記事の embedding 補完（YAT-3 / 要約から切り離した YAT-77）。embedding 未生成 ∧ feeds.active ∧
// body_text_len >= 250 ∧ 直近 30 日 の articles を select_embed_candidates（migration 0017）で選ぶ。
// 要約の有無は問わない（near_dup の母集団を要約予算から独立させるのが本 Issue の核心）。
//
// 処理順が肝: ①ディスク天井 → ②選抜 RPC（キー未設定でも呼ぶ）→ ③embed。
// ①天井（db_size_bytes >= 450MB）は embed を skipReason='disk_ceiling' で見送る（exit 1 にしない）。
// ②キー未設定でも RPC を呼ぶのは、eligible を取らないと embedHealthCounts の分母が欠けて
//   isEmbedStalled が不活性化するため（「キー喪失を 26h で赤くする」既存の意図を守る）。
export async function embedMissing(
  supabase: SupabaseClient,
  opts: {
    maxRows?: number;
    embedder?: Embedder | null;
    now?: number;
    budgetMs?: number;
  } = {},
): Promise<ArticleEmbedResult> {
  const now = opts.now ?? Date.now();

  // ① ディスク天井。取得失敗は skip しない（判定不能で止めると天井を装った静かな死になる）。
  const { data: sizeData, error: sizeErr } = await supabase.rpc("db_size_bytes");
  if (sizeErr) {
    console.warn("db_size_bytes の取得に失敗（天井判定を見送って続行）:", sizeErr);
  } else if (Number(sizeData) >= DISK_CEILING_BYTES) {
    console.warn(
      `DB が ${DISK_CEILING_BYTES} bytes を超えた（${sizeData}）ため embed を見送る（disk_ceiling）`,
    );
    // 選抜 RPC も呼ばない（天井時に content_head を引くのは無駄）。pending/eligible は判定不能に倒す。
    return {
      ...EMPTY_COUNTS,
      skipped: true,
      skipReason: "disk_ceiling",
      pending: -1,
      eligible: -1,
      selectError: null,
    };
  }

  const embedder =
    opts.embedder !== undefined ? opts.embedder : createEmbedder();

  // ② 選抜 RPC。キー未設定でも呼ぶ（eligible が embedHealthCounts の分母に要る）。
  let pending = -1;
  let eligible = -1;
  let selectError: string | null = null;
  let rows: Record<string, unknown>[] = [];
  try {
    const { data, error } = await supabase.rpc("select_embed_candidates", {
      per_day: EMBED_PER_DAY_DISABLED,
      max_rows: opts.maxRows ?? EMBED_MAX_ROWS,
      min_len: EMBED_MIN_BODY_LEN,
    });
    if (error) throw error;
    // jsonb を 1 個返す RPC。動的 RPC の型は解決できないので unknown 経由でキャストする
    // （match_articles / feed_recent_published と同じ作法）。
    const res = (data ?? {}) as unknown as {
      pending?: number;
      eligible?: number;
      rows?: Record<string, unknown>[];
    };
    pending = res.pending ?? -1;
    eligible = res.eligible ?? -1;
    rows = res.rows ?? [];
  } catch (e) {
    // 取得失敗は -1（判定不能）に倒す。0 に潰すとガードが偽陰性で沈黙する
    // （knowledge fail-soft-return-breaks-ratio-logs）。isEmbedSelectStalled が selectError を読む。
    selectError = e instanceof Error ? e.message : String(e);
    console.warn("select_embed_candidates の取得に失敗:", e);
  }

  // ③ キー未設定 → skip（pending/eligible は取れているので付けて返す）。
  if (!embedder) {
    return {
      ...EMPTY_COUNTS,
      skipped: true,
      skipReason: "no_api_key",
      pending,
      eligible,
      selectError,
    };
  }

  if (rows.length === 0) {
    return { ...EMPTY_COUNTS, skipped: false, pending, eligible, selectError };
  }

  const counts = await embedRows(supabase, rows, {
    table: "articles",
    embedTextOf: (r) => articleEmbedText(r),
    stampColumn: "embedded_at", // embedStalled（ingest-health）の分子・レシピマーカー（YAT-77）
    embedder,
    deadlineMs: now + (opts.budgetMs ?? EMBED_WALL_CLOCK_MS),
  });
  return { ...counts, pending, eligible, selectError };
}

// カード候補の embedding 補完（YAT-17）。card-gate のその場 embed が embedder 無し/失敗で取り
// こぼした候補を後追いで埋める。dedup テキストは設問本体（front/back or cloze）＋ source_quote。
export async function embedMissingCardCandidates(
  supabase: SupabaseClient,
  opts: { limit?: number; embedder?: Embedder | null } = {},
): Promise<EmbedBatchResult> {
  return embedMissingFromTable(supabase, {
    table: "card_candidates",
    selectColumns: "id, type, front, back, cloze_text, source_quote",
    embedTextOf: (r) => cardCandidateEmbedText(r as unknown as CardEmbedFields),
    orderBy: { column: "created_at", ascending: false },
    limit: opts.limit,
    embedder: opts.embedder,
  });
}

// クイズ問題の embedding 補完（YAT-29）。quiz-pool のその場 embed が embedder 無し/失敗で取り
// こぼした問題、およびオンデマンド生成（embedding=null）分を後追いで埋める。active のみ対象＝
// retired に embed 予算を使わない。dedup テキストは quizQuestionEmbedText と同一（母集団と一貫）。
export async function embedMissingQuizQuestions(
  supabase: SupabaseClient,
  opts: { limit?: number; embedder?: Embedder | null } = {},
): Promise<EmbedBatchResult> {
  return embedMissingFromTable(supabase, {
    table: "quiz_questions",
    selectColumns: "id, stem, choices, source_quote",
    embedTextOf: (r) => quizQuestionEmbedText(r as unknown as QuizEmbedFields),
    eqFilter: { column: "status", value: "active" },
    orderBy: { column: "created_at", ascending: false },
    limit: opts.limit,
    embedder: opts.embedder,
  });
}

// dedup 用埋め込みテキストの素材。生成カード（GeneratedCard）と DB 行（card_candidates）の共通部分を
// 構造的型で受けることで、card-gate からはキャストなしで GeneratedCard を渡せ、フィールド改名は
// コンパイルエラーで検出される（DB 行経路だけが境界キャストを要する）。
export type CardEmbedFields = {
  type: string;
  front?: string | null;
  back?: string | null;
  cloze_text?: string | null;
  source_quote: string;
};

// クイズ問題の dedup 用埋め込みテキストの素材。choices は DB 由来だと jsonb 配列で返るため
// Array.isArray でガードする。quiz-pool のその場 embed と補完バッチで同一テキストを使う。
export type QuizEmbedFields = {
  stem: string;
  choices: unknown;
  source_quote?: string | null;
};

// dedup テキストの source_quote 上限。長い記事引用がそのまま入ると 1 問の embed トークンが膨らみ、
// Voyage のチャンク詰めが 2 問/req から 1 問/req に落ちて cron 時間が伸びる。設問の識別には冒頭で
// 足りるため truncate して 2 問/チャンクを担保する（dedup 判定の安定にも効く）。
const QUIZ_EMBED_QUOTE_MAX = 200;

// クイズ問題の dedup 用埋め込みテキスト。設問＋選択肢＋出典抜粋（truncate 済み）を連結する。
export function quizQuestionEmbedText(row: QuizEmbedFields): string {
  const choices = Array.isArray(row.choices) ? row.choices.join(" ") : "";
  const quote = row.source_quote
    ? row.source_quote.slice(0, QUIZ_EMBED_QUOTE_MAX)
    : null;
  return [`${row.stem} ${choices}`.trim(), quote].filter(Boolean).join("\n");
}

// カード候補の dedup 用埋め込みテキスト。type に応じ設問本体を取り、source_quote を添える。
// card-gate のその場 embed と同一テキストを使うため共有 export する（補完と母集団で一貫させる）。
export function cardCandidateEmbedText(row: CardEmbedFields): string {
  const body =
    row.type === "cloze"
      ? (row.cloze_text ?? null)
      : [row.front, row.back].filter(Boolean).join(" ");
  return [body, row.source_quote].filter(Boolean).join("\n");
}

// ── embedding の保持窓（YAT-74）─────────────────────────────────────────────
//
// embedding は「貯めるもの」ではなく **30 日窓の生き物** として扱う。
//
// 理由はディスク。Supabase 無料枠は 500MB で、実測 417MB を使っており残り 83MB しかない。
// 内訳は articles 399MB のうち embedding の TOAST 197MB ＋ HNSW index 126MB ＝ 323MB で、
// **DB の 77% が embedding**。1 件あたり実効 12.2KB なので、現状の 165 件/日 でも
// 約 40 日で無料枠が尽きる。
//
// 一方 embedding の用途は 2 つとも短期窓しか見ていない:
//   - near_dup（YAT-55）: 30 日窓（lib/ranking/near-dup-window.ts の WINDOW_DAYS）
//   - TODAY デッキの近重複除外: 72h
// 長期の embedding を要求していたのは横断 Q&A（/ask）だけで、**RAG を 30 日窓に縮める判断**を
// したのでこの制約は外れた。実測では 16,133 件中 11,189 件（69%）が 30 日窓の外にあった。
//
// 35 日なのは near_dup の 30 日窓に余裕を持たせるため。ちょうど 30 日で切ると、
// prune と compute-dedup-rate の実行順によって窓の端の記事が embedding を失い、
// 母集団が静かに欠ける。
export const EMBED_RETENTION_DAYS = 35;

// 保持窓の下限時刻。候補選抜（embedMissing）と prune が同じ式を使うことで、
// 「候補に入るのに翌 run で prune される」帯が生まれない。
export function embedWindowCutoff(now: number): string {
  return new Date(now - EMBED_RETENTION_DAYS * 86_400_000).toISOString();
}

// embedStalled（生存判定）が「26h」なのは、毎時 cron の 1 日ぶん＋余裕 2h。
// 24h ちょうどだと夏時間や cron の遅延で日次パターンの端がまたぎ、偽陽性が出る。
export const EMBED_STALL_WINDOW_HOURS = 26;

export type EmbedHealthCounts = {
  /** 直近 26h に embed が成功した記事数（embedded_at ベース）。-1 は取得失敗（判定不能）。 */
  embeddedLast26h: number;
  /** いま embed 待ちの候補数。選抜 RPC の eligible をそのまま運ぶ。-1 は取得失敗。 */
  candidatesAvailable: number;
};

// embedStalled 判定の材料（YAT-76 / YAT-77）。embedMissing の後（＝この run の成功が embedded_at に
// 反映された後）に呼ぶこと。
//
// candidatesAvailable は embedMissing が返した eligible（選抜 RPC のゲート後件数）を**そのまま**使う。
// 述語をここに書き写して同期させようとしない: 述語のコピーこそがドリフトの発生源で、切り離し後に
// 「summary is not null」を残すと分母が実際の 1/3 に潰れて isEmbedStalled が静かに不活性化する
// （「うるさいガードを外して静かな死」の再来）。RPC が返した値を運ぶのが唯一ドリフトしない解。
// eligible が -1（RPC 取得失敗）ならそのまま判定不能として伝播する。
// embeddedLast26h の取得失敗は -1 に倒す（0 だと偽陽性で赤くなる。fail-soft-return-breaks-ratio-logs）。
export async function embedHealthCounts(
  supabase: SupabaseClient,
  em: Pick<ArticleEmbedResult, "eligible">,
  now: number = Date.now(),
): Promise<EmbedHealthCounts> {
  const stallCutoff = new Date(
    now - EMBED_STALL_WINDOW_HOURS * 3_600_000,
  ).toISOString();

  const recent = await supabase
    .from("articles")
    .select("id", { count: "exact", head: true })
    .gte("embedded_at", stallCutoff);

  if (recent.error) console.warn("embed 健全性: 26h 実績の取得に失敗:", recent.error);
  return {
    embeddedLast26h: recent.error ? -1 : (recent.count ?? -1),
    candidatesAvailable: em.eligible,
  };
}

export type PruneResult = {
  /** この run で embedding を NULL にした件数。 */
  pruned: number;
  /** prune 後に窓外へ残っている件数（次 run 以降で消える分）。 */
  remaining: number;
};

/**
 * 保持窓より古い記事の embedding を NULL にする。
 *
 * **行は消さない。** 記事本体・要約・タグは残り、消えるのはベクタだけ。
 * NULL 化で HNSW の部分 index（where embedding is not null）からも外れる。
 *
 * TOAST の領域は VACUUM で「再利用可能な空き」になるだけで OS には返らない。
 * それでよい——目的はディスクを取り返すことではなく **増え続けるのを止める** ことで、
 * 空いた領域は次の embedding が埋める。index の実サイズを縮めたいときだけ REINDEX する。
 */
export async function pruneStaleEmbeddings(
  supabase: SupabaseClient,
): Promise<PruneResult> {
  const cutoff = embedWindowCutoff(Date.now());

  // 「窓外」= 保持窓より古い、または published_at 不明。後者を含めるのは、published_at NULL の
  // 記事は near_dup 窓（published_at ベース）にも RAG（30 日窓）にも乗らず、embedding を持っても
  // 使い道が無いため。ISO タイムスタンプにカンマは含まれないので or フィルタの区切りと衝突しない。
  const staleFilter = <T extends { or: (f: string) => T; not: (c: string, op: string, v: unknown) => T }>(
    q: T,
  ): T => q.not("embedding", "is", null).or(`published_at.lt.${cutoff},published_at.is.null`);

  // ID を列挙して .in() で更新すると URL 長超過で 400 になる（PostgREST の既知の落とし穴。
  // 本プロジェクトは 755 件で実際に踏んでいる: knowledge supabase-in-filter-url-length-limit）。
  // prune は WHERE 条件で書けるので ID 列挙は不要。UPDATE の WHERE 対象行数には max-rows 制限が
  // かからないため、窓外がいくつあっても 1 リクエストで済む（embedding を NULL にするだけなので軽い）。
  //
  // 件数は「更新前の窓外数 − 更新後の窓外数」で出す。update に .select() を付けて全行を返させると
  // 大量時に重いので、head+count の差分で数える。
  const { count: before, error: beforeErr } = await staleFilter(
    supabase.from("articles").select("id", { count: "exact", head: true }),
  );
  if (beforeErr) {
    console.warn("embedding prune の対象件数取得に失敗:", beforeErr);
    return { pruned: 0, remaining: -1 };
  }
  if ((before ?? 0) === 0) return { pruned: 0, remaining: 0 };

  const { error: upErr } = await staleFilter(
    supabase.from("articles").update({ embedding: null }),
  );
  if (upErr) {
    console.warn("embedding prune の更新に失敗:", upErr);
    return { pruned: 0, remaining: -1 };
  }

  // 再カウントの失敗は remaining:0（全クリア）でなく -1（判定不能）に倒す。0 を返すと
  // ingest 側の pruneStalled 検知をすり抜け、実際は残っているのに「排出完了」と誤報告する
  // （knowledge fail-soft-return-breaks-ratio-logs）。update は成功しているので pruned は before。
  const { count: after, error: afterErr } = await staleFilter(
    supabase.from("articles").select("id", { count: "exact", head: true }),
  );
  if (afterErr) {
    console.warn("embedding prune 後の残数取得に失敗:", afterErr);
    return { pruned: before ?? 0, remaining: -1 };
  }
  return { pruned: (before ?? 0) - (after ?? 0), remaining: after ?? 0 };
}
