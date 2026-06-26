import type { SupabaseClient } from "@supabase/supabase-js";
import { createEmbedder, type Embedder } from "@/lib/llm/embed";

// 取得→要約の後に呼ぶバッチ埋め込み。summary 済みかつ embedding 未生成の記事を拾い、
// title+summary を Voyage で embed して articles.embedding（pgvector）に保存する。
// 設計方針: fail-soft。例外は外へ漏らさず集計に畳む（embedding 由来で ingest を止めない）。
// 既存の要約済み記事も embedding NULL なら対象になるため、初回実行で自然にバックフィルされる。

export type EmbedBatchResult = {
  picked: number; // embedding NULL かつ summary 済みから取得した件数
  succeeded: number;
  failed: number;
  skipped: boolean; // VOYAGE_API_KEY 未設定でスキップした場合 true
};

type Row = { id: string; title: string | null; summary: string | null };

const DEFAULT_LIMIT = 50; // 1 回の実行で埋め込む上限（残りは次回消化）

// pgvector へは文字列リテラル '[v1,v2,...]' で書き込む（PostgREST が text→vector にキャスト）。
function vecToPg(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

// embed 入力テキスト。dedup 用途なので本文は不要、title+summary で足りる（YAT-3 結論）。
function embedText(row: Row): string {
  return [row.title, row.summary].filter(Boolean).join("\n");
}

export async function embedMissing(
  supabase: SupabaseClient,
  opts: { limit?: number; embedder?: Embedder | null } = {},
): Promise<EmbedBatchResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const embedder =
    opts.embedder !== undefined ? opts.embedder : createEmbedder();

  // API キー未設定 → embed スキップ（ingest は成功扱い）
  if (!embedder) {
    return { picked: 0, succeeded: 0, failed: 0, skipped: true };
  }

  let rows: Row[] = [];
  try {
    const { data, error } = await supabase
      .from("articles")
      .select("id, title, summary")
      .is("embedding", null)
      .not("summary", "is", null)
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    rows = (data ?? []) as Row[];
  } catch (e) {
    console.warn("embed 対象の取得に失敗:", e);
    return { picked: 0, succeeded: 0, failed: 0, skipped: false };
  }

  if (rows.length === 0) {
    return { picked: 0, succeeded: 0, failed: 0, skipped: false };
  }

  // 1 回の API 呼び出しでまとめて埋め込む（Voyage はバッチ入力可）。
  let vectors: number[][];
  try {
    vectors = await embedder.embed(rows.map(embedText));
  } catch (e) {
    // 埋め込み呼び出し自体の失敗は全件 failed に畳む（次回再試行で収束）。
    console.warn("embed API 呼び出しに失敗:", e);
    return { picked: rows.length, succeeded: 0, failed: rows.length, skipped: false };
  }

  let succeeded = 0;
  let failed = 0;
  // 保存は1件ずつ（embedding 値が行ごとに異なるため bulk update できない）。fail-soft。
  for (let i = 0; i < rows.length; i++) {
    try {
      const { error } = await supabase
        .from("articles")
        .update({ embedding: vecToPg(vectors[i]) })
        .eq("id", rows[i].id);
      if (error) throw error;
      succeeded += 1;
    } catch (e) {
      failed += 1;
      console.warn(`embedding 保存失敗 [${rows[i].id}]:`, e);
    }
  }

  return { picked: rows.length, succeeded, failed, skipped: false };
}
