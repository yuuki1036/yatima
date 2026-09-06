import type { SupabaseClient } from "@supabase/supabase-js";
import { createEmbedder, type Embedder } from "@/lib/llm/embed";

// 取得→要約の後に呼ぶバッチ埋め込み。embedding 未生成の行を拾い、対象テキストを Voyage で embed
// して `<table>.embedding`（pgvector）に保存する。articles（YAT-3）とカード候補（YAT-17）が共有する。
// 設計方針: fail-soft。例外は外へ漏らさず集計に畳む（embedding 由来でジョブを止めない）。
// 既存の embedding NULL 行は次回実行で自然にバックフィルされる。

export type EmbedBatchResult = {
  picked: number; // embedding NULL から取得した件数
  succeeded: number;
  failed: number;
  skipped: boolean; // VOYAGE_API_KEY 未設定でスキップした場合 true
};

// 1 回の実行で埋め込む上限。無料枠（3 RPM / 10K TPM）だと throughput が ~8.5K tokens/分に
// 制限され、実測で 24 件 embed に約 4 分・ingest 全体で約 6 分かかった。cron の 10 分 timeout に
// 余裕を持たせるため 16 件に抑える（残りは次回消化。newest-first で候補窓 72h は先に埋まる）。
// 支払い方法を登録してレート制限が緩んだら上げてよい。
const DEFAULT_LIMIT = 16;

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
  // 必須でない行を除外する列（articles は要約済みのみ対象＝"summary"。カード候補は指定なし）。
  requireColumn?: string;
  // 特定の列値だけに絞る等値フィルタ（quiz は active のみ補完＝retired に embed 予算を使わない）。
  eqFilter?: { column: string; value: string };
  orderBy: { column: string; ascending: boolean; nullsFirst?: boolean };
  limit?: number;
  embedder?: Embedder | null;
};

async function embedMissingFromTable(
  supabase: SupabaseClient,
  opts: EmbedTableOpts,
): Promise<EmbedBatchResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const embedder =
    opts.embedder !== undefined ? opts.embedder : createEmbedder();

  // API キー未設定 → embed スキップ（呼び出し元のジョブは成功扱い）
  if (!embedder) {
    return { picked: 0, succeeded: 0, failed: 0, skipped: true };
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
    return { picked: 0, succeeded: 0, failed: 0, skipped: false };
  }

  if (rows.length === 0) {
    return { picked: 0, succeeded: 0, failed: 0, skipped: false };
  }

  // まとめて埋め込む（Voyage はバッチ入力可）。embed は内部で分割・レート制御し、
  // 失敗チャンクの要素は null で返す（部分成功を許容）。
  let vectors: (number[] | null)[];
  try {
    vectors = await embedder.embed(rows.map(opts.embedTextOf));
  } catch (e) {
    // embed 全体が throw するのは想定外（チャンク失敗は null 化される）。保険で全件 failed に。
    console.warn(`embed API 呼び出しに失敗（${opts.table}）:`, e);
    return {
      picked: rows.length,
      succeeded: 0,
      failed: rows.length,
      skipped: false,
    };
  }

  let succeeded = 0;
  let failed = 0;
  // 保存は1件ずつ（embedding 値が行ごとに異なるため bulk update できない）。fail-soft。
  for (let i = 0; i < rows.length; i++) {
    const vec = vectors[i];
    if (!vec) {
      // 埋め込み失敗（チャンク失敗）。embedding は NULL のまま残り次回再試行で収束する。
      failed += 1;
      continue;
    }
    try {
      const { error } = await supabase
        .from(opts.table)
        .update({ embedding: vecToPg(vec) })
        .eq("id", rows[i].id as string);
      if (error) throw error;
      succeeded += 1;
    } catch (e) {
      failed += 1;
      console.warn(`embedding 保存失敗 [${opts.table}/${rows[i].id}]:`, e);
    }
  }

  return { picked: rows.length, succeeded, failed, skipped: false };
}

// 記事の embedding 補完（YAT-3）。summary 済みかつ embedding 未生成の articles を拾う。
// dedup 用途なので本文は不要、title+summary で足りる。
export async function embedMissing(
  supabase: SupabaseClient,
  opts: { limit?: number; embedder?: Embedder | null } = {},
): Promise<EmbedBatchResult> {
  return embedMissingFromTable(supabase, {
    table: "articles",
    selectColumns: "id, title, summary",
    embedTextOf: (r) =>
      [r.title, r.summary].filter(Boolean).join("\n"),
    requireColumn: "summary", // 要約済みのみ embed（未要約は対象外）
    orderBy: { column: "published_at", ascending: false, nullsFirst: false },
    limit: opts.limit,
    embedder: opts.embedder,
  });
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
  const cutoff = new Date(
    Date.now() - EMBED_RETENTION_DAYS * 86_400_000,
  ).toISOString();

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
