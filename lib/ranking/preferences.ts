import type { SupabaseClient } from "@supabase/supabase-js";
import type { FeedbackAction } from "@/lib/types";

// フィードバック重み（mkj 実証値）。開く > 役立った > 0 > 不要（負シグナルを最重視）。
// 加算のみ・減衰なし（v1）。減衰は将来 article_feedback 元帳からの再計算で導入できる。
export const FEEDBACK_WEIGHT: Record<FeedbackAction, number> = {
  open: 1.0,
  useful: 0.65,
  dismiss: -1.1,
};

// kind='tag' の嗜好を一括 read して Map<tag, weight> にする（スコア計算用）。
export async function loadTagPrefs(
  supabase: SupabaseClient,
): Promise<Map<string, number>> {
  const { data, error } = await supabase
    .from("preferences")
    .select("key, weight")
    .eq("kind", "tag");
  if (error) throw error;
  return new Map(
    (data ?? []).map((p) => [p.key as string, p.weight as number]),
  );
}

// 指定タグ群の tag_pref に delta を加算（read → +delta → upsert）。
// delta は重みの差分（新規=その重み / 再判定=新重み-旧重み）。
export async function bumpTagPrefs(
  supabase: SupabaseClient,
  tags: string[],
  delta: number,
): Promise<void> {
  if (tags.length === 0 || delta === 0) return;
  const { data: cur, error: selErr } = await supabase
    .from("preferences")
    .select("key, weight")
    .eq("kind", "tag")
    .in("key", tags);
  if (selErr) throw selErr;
  const curMap = new Map(
    (cur ?? []).map((p) => [p.key as string, p.weight as number]),
  );
  const rows = tags.map((t) => ({
    kind: "tag",
    key: t,
    weight: (curMap.get(t) ?? 0) + delta,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase
    .from("preferences")
    .upsert(rows, { onConflict: "kind,key" });
  if (error) throw error;
}
