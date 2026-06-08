"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { ingestAllFeeds } from "@/lib/rss/ingest";
import { summarizeMissing } from "@/lib/llm/summarize-batch";

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
}

export async function toggleRead(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const next = formData.get("is_read") !== "true"; // 現在値の反転
  const supabase = createAdminClient();
  await supabase.from("articles").update({ is_read: next }).eq("id", id);
  revalidatePath("/");
}

export async function toggleStar(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const next = formData.get("is_starred") !== "true";
  const supabase = createAdminClient();
  await supabase.from("articles").update({ is_starred: next }).eq("id", id);
  revalidatePath("/");
}

// 「今すぐ取得」: 全 active フィードを取得して保存し、続けて未要約記事を要約する。
// 要約は同期実行（fail-soft）。完了後に revalidate するため、要約付き一覧が即反映される。
export async function refreshNow() {
  const supabase = createAdminClient();
  await ingestAllFeeds(supabase);
  await summarizeMissing(supabase);
  revalidatePath("/");
  revalidatePath("/feeds");
}
