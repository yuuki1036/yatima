"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth/session";
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

// 各 mutation は proxy で全ルートをゲート済みだが、公式認証ガイドが「proxy だけを
// 防御線にするな・Server Action でも検証せよ」と明記しているため、直 POST 対策の
// 二段目として冒頭で requireSession() を呼ぶ（YAT-12 / [[20260608-server-action-auth]]）。

export async function addFeed(formData: FormData) {
  await requireSession();
  const url = String(formData.get("url") ?? "").trim();
  if (!url) return;
  const supabase = createAdminClient();
  await supabase
    .from("feeds")
    .upsert({ url }, { onConflict: "url", ignoreDuplicates: true });
  revalidatePath("/feeds");
}

export async function deleteFeed(formData: FormData) {
  await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createAdminClient();
  await supabase.from("feeds").delete().eq("id", id);
  revalidatePath("/feeds");
  revalidatePath("/");
  revalidatePath("/list");
}

// 自動発見の承認待ち候補（feed_candidates）を feeds へ昇格する（YAT-16）。誤検出を本番取得に
// 混ぜないための承認制の出口。候補の低い初期 credibility をそのまま引き継ぎ、運用で手当てする。
export async function approveFeedCandidate(formData: FormData) {
  await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createAdminClient();
  const { data: cand } = await supabase
    .from("feed_candidates")
    .select("url, title, site_url, credibility")
    .eq("id", id)
    .maybeSingle();
  if (!cand) return;
  // url unique 衝突は無視（既に手動追加済みの URL を二重承認した場合の保険）。
  await supabase.from("feeds").upsert(
    {
      url: cand.url,
      title: cand.title,
      site_url: cand.site_url,
      credibility: cand.credibility,
    },
    { onConflict: "url", ignoreDuplicates: true },
  );
  await supabase
    .from("feed_candidates")
    .update({ status: "approved" })
    .eq("id", id);
  revalidatePath("/feeds");
}

// 候補を却下する。source_domain は status 不問で重複排除に使うため、行は消さず rejected に倒す
// （同じドメインが次回発見で再び候補に挙がるのを防ぐ）。
export async function rejectFeedCandidate(formData: FormData) {
  await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createAdminClient();
  await supabase
    .from("feed_candidates")
    .update({ status: "rejected" })
    .eq("id", id);
  revalidatePath("/feeds");
}

// 学習カード候補（card_candidates）を承認する（YAT-17）。誤生成を本番に混ぜないための承認制の
// 出口。YAT-17 スコープでは status を approved に倒すだけで、cards への昇格（FSRS createEmptyCard）
// は YAT-18 で行う。承認済み行は永続するので YAT-18 で一括昇格できる。
export async function approveCard(formData: FormData) {
  await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createAdminClient();
  await supabase
    .from("card_candidates")
    .update({ status: "approved" })
    .eq("id", id);
  revalidatePath("/learn");
}

// カード候補を却下する。embedding は status 不問で dedup 母集団に使うため、行は消さず rejected に
// 倒す（同じ記事/概念が次回生成で再び候補に挙がるのを防ぐ。rejectFeedCandidate と同方針）。
export async function rejectCard(formData: FormData) {
  await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createAdminClient();
  await supabase
    .from("card_candidates")
    .update({ status: "rejected" })
    .eq("id", id);
  revalidatePath("/learn");
}

export async function toggleRead(formData: FormData) {
  await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const next = formData.get("is_read") !== "true"; // 現在値の反転
  const supabase = createAdminClient();
  await supabase.from("articles").update({ is_read: next }).eq("id", id);
  revalidatePath("/list");
}

export async function toggleStar(formData: FormData) {
  await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const next = formData.get("is_starred") !== "true";
  const supabase = createAdminClient();
  await supabase.from("articles").update({ is_starred: next }).eq("id", id);
  revalidatePath("/list");
}

// 手動「更新」: 全 active フィードを取得→本文補完→未要約を要約+タグ→デッキを未判定 10 件へ補充。
// embed は含めない（無料枠レート制限で ~2分かかり maxDuration を超えるため cron 専任）。
// 連打対策の cooldown guard は「取得・要約」だけに掛け、デッキ補充（curate）は常に走らせる。
// こうすると判定し切った直後にクールダウン中でも更新を押せば、既存の要約済みプールから次の
// 候補が補充されて必ず最大 10 件が並ぶ（「更新で10件」「1日10件で打ち止めにしない」を満たす）。
// useActionState から呼ぶため結果を返す（prevState/formData は未使用なので引数なしでよい）。
export async function refreshNow(): Promise<RefreshState> {
  await requireSession();
  const supabase = createAdminClient();

  // ── cooldown 判定: 専用マーカーの更新時刻が COOLDOWN 内なら「取得・要約」はスキップする。
  const { data: marker } = await supabase
    .from("preferences")
    .select("updated_at")
    .eq("kind", REFRESH_MARKER.kind)
    .eq("key", REFRESH_MARKER.key)
    .maybeSingle();
  const lastMs = marker?.updated_at ? new Date(marker.updated_at).getTime() : 0;
  const elapsed = Date.now() - lastMs;
  const onCooldown = lastMs > 0 && elapsed < REFRESH_COOLDOWN_MS;

  try {
    let inserted = 0;
    let annotated = 0;
    if (!onCooldown) {
      // ── 取得・要約パイプライン（fail-soft の各段はそのまま流す。embed は除外）。
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
      inserted = results.reduce((n, r) => n + (r.error ? 0 : r.inserted), 0);
      await enrichMissingBodies(supabase);
      const a = await annotateMissing(supabase, {
        limit: MANUAL_ANNOTATE_LIMIT,
      });
      annotated = a.succeeded;
    }

    // ── デッキ補充は取得の有無に関わらず常に実行（クールダウン中でも既存プールから補充できる）。
    const c = await curateToday(supabase);
    revalidatePath("/");
    revalidatePath("/list");
    revalidatePath("/feeds");

    const deck = c.skipped ? "デッキは充足（追加なし）" : `デッキに+${c.picked}`;
    if (onCooldown) {
      const mins = Math.ceil((REFRESH_COOLDOWN_MS - elapsed) / 60_000);
      return { ok: true, message: `${deck}（新規取得は約${mins}分後）` };
    }
    return {
      ok: true,
      message: `取得 +${inserted} / 要約 ${annotated} / ${deck}`,
    };
  } catch (e) {
    console.warn("refreshNow 失敗:", e);
    return { ok: false, message: "取得に失敗しました。時間をおいて再試行してください" };
  }
}

// Tinder カードのフィードバック（開く/役立った/不要）。タグ嗜好を更新し、当日の一覧を再取得させる。
export async function submitFeedback(formData: FormData) {
  await requireSession();
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
