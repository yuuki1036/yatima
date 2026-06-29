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

// カード候補の dedup 用埋め込みテキスト。type に応じ設問本体を取り、source_quote を添える。
// card-gate のその場 embed と同一テキストを使うため共有 export する（補完と母集団で一貫させる）。
export function cardCandidateEmbedText(row: CardEmbedFields): string {
  const body =
    row.type === "cloze"
      ? (row.cloze_text ?? null)
      : [row.front, row.back].filter(Boolean).join(" ");
  return [body, row.source_quote].filter(Boolean).join("\n");
}
