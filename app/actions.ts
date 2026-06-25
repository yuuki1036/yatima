"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordFeedback } from "@/lib/ranking/feedback";
import { FEEDBACK_WEIGHT } from "@/lib/ranking/preferences";
import type { FeedbackAction } from "@/lib/types";

// 書き込みはすべて service role（RLS バイパス）で行う。

export async function addFeed(formData: FormData) {
  const url = String(formData.get("url") ?? "").trim();
  if (!url) return;
  const supabase = createAdminClient();
  await supabase
    .from("feeds")
    .upsert({ url }, { onConflict: "url", ignoreDuplicates: true });
  revalidatePath("/feeds");
}

export async function deleteFeed(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createAdminClient();
  await supabase.from("feeds").delete().eq("id", id);
  revalidatePath("/feeds");
  revalidatePath("/");
  revalidatePath("/list");
}

export async function toggleRead(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const next = formData.get("is_read") !== "true"; // 現在値の反転
  const supabase = createAdminClient();
  await supabase.from("articles").update({ is_read: next }).eq("id", id);
  revalidatePath("/list");
}

export async function toggleStar(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const next = formData.get("is_starred") !== "true";
  const supabase = createAdminClient();
  await supabase.from("articles").update({ is_starred: next }).eq("id", id);
  revalidatePath("/list");
}

// Tinder カードのフィードバック（開く/役立った/不要）。タグ嗜好を更新し、当日の一覧を再取得させる。
export async function submitFeedback(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const action = String(formData.get("action") ?? "");
  // 直 POST 防御: 既知の action 値のみ受け付ける。
  // `in` は prototype チェーンも見て "toString" 等を通すため Object.hasOwn を使う
  // （通すと delta=NaN になり preferences.weight(NOT NULL) を壊す）。
  if (!id || !Object.hasOwn(FEEDBACK_WEIGHT, action)) {
    // 楽観 UI は結果を見ず進むため、無痕跡だと不正 POST に気づけない。痕跡だけ残す。
    console.warn(`submitFeedback: 不正な入力を棄却 id=${id} action=${action}`);
    return;
  }
  const supabase = createAdminClient();
  // クライアントは結果を await せず楽観的にカードを進める（fire-and-forget）。
  // ここで throw しても UI に伝わらないため、失敗理由をログに残して握り潰す。
  try {
    await recordFeedback(supabase, id, action as FeedbackAction);
  } catch (e) {
    console.warn(`submitFeedback: 記録に失敗 id=${id} action=${action}:`, e);
    return;
  }
  // "/" は revalidate しない: デッキはクライアント側で1枚ずつ進むため、ここで再取得して
  // 判定済みカードを配列から除外すると、楽観的に進めた index と二重にズレてカードが飛ぶ。
  // リロード時はサーバクエリが判定済みを除外し、続きから再開する。
  revalidatePath("/list"); // 「開く」で立てた既読を /list に反映
}
