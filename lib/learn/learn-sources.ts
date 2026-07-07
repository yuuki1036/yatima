import type { SupabaseClient } from "@supabase/supabase-js";
import type { TagSlug } from "@/lib/tags/vocabulary";

// YAT-32: 学習クイズの生成素材＝承認済み learn_sources を引く層。生成コア（quiz-gate）は
// この行型だけに依存し、記事プール（articles）には依存しない（evergreen 専用切替）。

// 生成素材の共通行型（id/title/content_html だけ）。記事の feeds.credibility に依存しない。
export type QuizSourceRow = {
  id: string;
  title: string | null;
  content_html: string | null;
};

// 承認済みソースを LRU（last_generated_at 昇順・null 最優先）で limit 件取り、選定分の
// last_generated_at を now に更新して返す。選定時点で更新することで、生成が空振りしても同じソース
// を続けて食わず、ローテーションが進む（同一ソース反復による near-dup を構造的に抑える）。
// category=null は「おまかせ」＝全カテゴリの承認済みから LRU 順。
export async function loadLearnSources(
  supabase: SupabaseClient,
  category: TagSlug | null,
  limit: number,
): Promise<QuizSourceRow[]> {
  let query = supabase
    .from("learn_sources")
    .select("id, title, content_html")
    .eq("status", "approved")
    .not("content_html", "is", null)
    .order("last_generated_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (category) query = query.eq("category", category);

  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as QuizSourceRow[];

  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const { error: upErr } = await supabase
      .from("learn_sources")
      .update({ last_generated_at: new Date().toISOString() })
      .in("id", ids);
    // 更新失敗は致命でない（次回も同じ順に出るだけ）。生成は続行する。
    if (upErr) console.warn("learn_sources の last_generated_at 更新に失敗:", upErr);
  }
  return rows;
}

// 該当カテゴリに承認済みソースが在庫としてあるか（在庫ゲート）。cron の deficit ループと after 裏補充の
// 発火判定に使い、ソース未登録カテゴリでの空振り生成・空振り発火を防ぐ（review F-F / F-G）。
// 取得失敗は true（生成側へ倒す）: cron は deficit で頭打ち、after はローダー空返しで実害が無い。
export async function hasApprovedLearnSources(
  supabase: SupabaseClient,
  category: TagSlug | null,
): Promise<boolean> {
  let query = supabase
    .from("learn_sources")
    .select("id", { count: "exact", head: true })
    .eq("status", "approved")
    .not("content_html", "is", null);
  if (category) query = query.eq("category", category);

  const { count, error } = await query;
  if (error) {
    console.warn(`承認済み learn_sources の在庫確認に失敗 [${category ?? "all"}]:`, error);
    return true;
  }
  return (count ?? 0) > 0;
}
