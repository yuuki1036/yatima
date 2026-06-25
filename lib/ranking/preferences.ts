import type { SupabaseClient } from "@supabase/supabase-js";
import type { FeedbackAction } from "@/lib/types";

// フィードバック重み（mkj 実証値）。開く > 役立った > 0 > 不要（負シグナルを最重視）。
// 加算のみ・減衰なし（v1）。減衰は将来 article_feedback 元帳からの再計算で導入できる。
export const FEEDBACK_WEIGHT: Record<FeedbackAction, number> = {
  open: 1.0,
  useful: 0.65,
  dismiss: -1.1,
};

// 指定 kind の嗜好を一括 read して Map<key, weight> にする（スコア計算用）。
async function loadPrefs(
  supabase: SupabaseClient,
  kind: string,
): Promise<Map<string, number>> {
  const { data, error } = await supabase
    .from("preferences")
    .select("key, weight")
    .eq("kind", kind);
  if (error) throw error;
  return new Map(
    (data ?? []).map((p) => [p.key as string, p.weight as number]),
  );
}

// kind='tag' の嗜好（スコアのタグ項用）。
export function loadTagPrefs(
  supabase: SupabaseClient,
): Promise<Map<string, number>> {
  return loadPrefs(supabase, "tag");
}

// kind='source' の嗜好（スコアのソース項用。キーは feed_id）。
export function loadSourcePrefs(
  supabase: SupabaseClient,
): Promise<Map<string, number>> {
  return loadPrefs(supabase, "source");
}

// 指定 kind の key 群の嗜好に delta を加算（read → +delta → upsert）。
// delta は重みの差分（新規=その重み / 再判定=新重み-旧重み）。
async function bumpPrefs(
  supabase: SupabaseClient,
  kind: string,
  keys: string[],
  delta: number,
): Promise<void> {
  if (keys.length === 0 || delta === 0) return;
  const { data: cur, error: selErr } = await supabase
    .from("preferences")
    .select("key, weight")
    .eq("kind", kind)
    .in("key", keys);
  if (selErr) throw selErr;
  const curMap = new Map(
    (cur ?? []).map((p) => [p.key as string, p.weight as number]),
  );
  const rows = keys.map((k) => ({
    kind,
    key: k,
    weight: (curMap.get(k) ?? 0) + delta,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase
    .from("preferences")
    .upsert(rows, { onConflict: "kind,key" });
  if (error) throw error;
}

// 指定タグ群の tag_pref に delta を加算。
export function bumpTagPrefs(
  supabase: SupabaseClient,
  tags: string[],
  delta: number,
): Promise<void> {
  return bumpPrefs(supabase, "tag", tags, delta);
}

// 1 フィードの source_pref に delta を加算（キーは feed_id）。
export function bumpSourcePref(
  supabase: SupabaseClient,
  feedId: string,
  delta: number,
): Promise<void> {
  return bumpPrefs(supabase, "source", [feedId], delta);
}
