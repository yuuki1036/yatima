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

// 1 回の実行で埋め込む上限。無料枠（3 RPM / 10K TPM）だと throughput が ~8.5K tokens/分に
// 制限され、実測で 24 件 embed に約 4 分・ingest 全体で約 6 分かかった。cron の 10 分 timeout に
// 余裕を持たせるため 16 件に抑える（残りは次回消化。newest-first で候補窓 72h は先に埋まる）。
// 支払い方法を登録してレート制限が緩んだら上げてよい。
const DEFAULT_LIMIT = 16;

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

  // まとめて埋め込む（Voyage はバッチ入力可）。embed は内部で分割・レート制御し、
  // 失敗チャンクの要素は null で返す（部分成功を許容）。
  let vectors: (number[] | null)[];
  try {
    vectors = await embedder.embed(rows.map(embedText));
  } catch (e) {
    // embed 全体が throw するのは想定外（チャンク失敗は null 化される）。保険で全件 failed に。
    console.warn("embed API 呼び出しに失敗:", e);
    return { picked: rows.length, succeeded: 0, failed: rows.length, skipped: false };
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
        .from("articles")
        .update({ embedding: vecToPg(vec) })
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
