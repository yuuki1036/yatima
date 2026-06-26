"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordFeedback } from "@/lib/ranking/feedback";
import { FEEDBACK_WEIGHT } from "@/lib/ranking/preferences";
import { ingestAllFeeds } from "@/lib/rss/ingest";
import { enrichMissingBodies } from "@/lib/rss/enrich";
import { annotateMissing } from "@/lib/llm/summarize-batch";
import { curateToday } from "@/lib/ranking/curate";
import type { FeedbackAction } from "@/lib/types";

// 書き込みはすべて service role（RLS バイパス）で行う。

// 手動「更新」の結果（useActionState で UI に返す）。
export type RefreshState = { ok: boolean; message: string } | null;

// 直近実行からこの時間内は再実行しない（無認証公開のため連打での API 課金を抑える緩和策。
// 本筋の対策は認証 = follow-up 20260608-server-action-auth）。
// cron が毎時取得するので、それより短い手動取得は実質重複。cron と同じ 60 分に揃える。
const REFRESH_COOLDOWN_MS = 60 * 60_000;
// 手動実行の annotate 件数。Vercel の maxDuration(60s) 内に収めるため cron(20) より控えめにする。
const MANUAL_ANNOTATE_LIMIT = 12;
// cooldown 判定用の専用マーカー（preferences を汎用 KV として流用）。
// feeds.last_fetched_at は取得成功時しか進まず失敗連打/0件取得をすり抜けるため、専用マーカーで判定する。
const REFRESH_MARKER = { kind: "meta", key: "last_manual_refresh" } as const;

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

// 手動「更新」: 全 active フィードを取得→本文補完→未要約を要約+タグ→今日の10件を確定。
// embed は含めない（無料枠レート制限で ~2分かかり maxDuration を超えるため cron 専任）。
// 連打対策に cooldown guard を入れる。useActionState から呼ぶため結果を返す。
// useActionState のアクション型は引数の少ない関数も受け入れる（prevState/formData は未使用）。
export async function refreshNow(): Promise<RefreshState> {
  const supabase = createAdminClient();

  // ── cooldown: 専用マーカーの更新時刻が COOLDOWN 内ならパイプラインを回さず案内だけ返す。
  const { data: marker } = await supabase
    .from("preferences")
    .select("updated_at")
    .eq("kind", REFRESH_MARKER.kind)
    .eq("key", REFRESH_MARKER.key)
    .maybeSingle();
  const lastMs = marker?.updated_at ? new Date(marker.updated_at).getTime() : 0;
  const elapsed = Date.now() - lastMs;
  if (lastMs && elapsed < REFRESH_COOLDOWN_MS) {
    const mins = Math.ceil((REFRESH_COOLDOWN_MS - elapsed) / 60_000);
    revalidatePath("/");
    revalidatePath("/list");
    return { ok: true, message: `直近に更新済み。約${mins}分後に再実行できます` };
  }

  // ── パイプライン（fail-soft の各段はそのまま流す。embed は除外）。
  try {
    // ガードを先に前進させる（成否・0件取得に関わらず cooldown を消費し、失敗連打のすり抜けを塞ぐ。
    // read→upsert の窓は残るが、~10秒のパイプライン実行中の窓を ~ms に縮める。完全遮断は認証が本筋）。
    await supabase.from("preferences").upsert(
      {
        kind: REFRESH_MARKER.kind,
        key: REFRESH_MARKER.key,
        weight: 0,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "kind,key" },
    );
    const results = await ingestAllFeeds(supabase);
    const inserted = results.reduce((n, r) => n + (r.error ? 0 : r.inserted), 0);
    await enrichMissingBodies(supabase);
    const a = await annotateMissing(supabase, { limit: MANUAL_ANNOTATE_LIMIT });
    const c = await curateToday(supabase);
    revalidatePath("/");
    revalidatePath("/list");
    revalidatePath("/feeds");
    const curation = c.skipped
      ? "今日の分は確定済み"
      : `今日の${c.picked}件を生成`;
    return {
      ok: true,
      message: `取得 +${inserted} / 要約 ${a.succeeded} / ${curation}`,
    };
  } catch (e) {
    console.warn("refreshNow 失敗:", e);
    return { ok: false, message: "取得に失敗しました。時間をおいて再試行してください" };
  }
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
