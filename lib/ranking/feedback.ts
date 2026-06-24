import type { SupabaseClient } from "@supabase/supabase-js";
import type { FeedbackAction } from "@/lib/types";
import { FEEDBACK_WEIGHT, bumpTagPrefs } from "./preferences";

// フィードバック（開く/役立った/不要）を記録し、その記事のタグ嗜好を更新する。
// article_feedback は1記事1行の元帳。再判定（2回目）も「新重み-旧重み」の差分加算で整合させる。
export async function recordFeedback(
  supabase: SupabaseClient,
  articleId: string,
  action: FeedbackAction,
): Promise<void> {
  // 記事のタグと既存フィードバックを取得
  const [tagRes, prevRes] = await Promise.all([
    supabase.from("article_tags").select("tag_slug").eq("article_id", articleId),
    supabase
      .from("article_feedback")
      .select("action")
      .eq("article_id", articleId)
      .maybeSingle(),
  ]);
  if (tagRes.error) throw tagRes.error;
  // prevRes のエラーを無視すると prevAction=null に縮退し、再判定が新規扱いで二重加算される。
  if (prevRes.error) throw prevRes.error;

  const tags = (tagRes.data ?? []).map((r) => r.tag_slug as string);
  const prevAction = (prevRes.data?.action ?? null) as FeedbackAction | null;

  if (prevAction !== action) {
    // 差分 = 新重み - 旧重み（旧なしは 0）。2 重加算や判定変更を正しく反映する。
    const delta =
      FEEDBACK_WEIGHT[action] - (prevAction ? FEEDBACK_WEIGHT[prevAction] : 0);
    await bumpTagPrefs(supabase, tags, delta);
    const { error } = await supabase.from("article_feedback").upsert(
      { article_id: articleId, action, created_at: new Date().toISOString() },
      { onConflict: "article_id" },
    );
    if (error) throw error;
  }

  // 「開く」は /list と意味整合させるため既読にする（不要/役立っただけでは既読化しない）。
  if (action === "open") {
    await supabase
      .from("articles")
      .update({ is_read: true })
      .eq("id", articleId);
  }
}
