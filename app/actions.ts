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
import { generateQuizForCategory } from "@/lib/learn/quiz-gate";
import { recordQuizAttempt } from "@/lib/learn/mastery";
import { isTagSlug, type TagSlug } from "@/lib/tags/vocabulary";
import type { FeedbackAction, QuizQuestion, QuizSessionResult } from "@/lib/types";

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
  revalidatePath("/saved");
}

// 削除推奨（YAT-20）の確定アクション: 物理削除せず active=false に倒して取得対象から外す。
// 記事は残すので「後で読む」や既存デッキは保全され、reactivateFeed で復活できる。
// ingestAllFeeds が .eq("active", true) で絞るため、次回 ingest 以降は取得が止まる。既存記事は
// curate の 72h ウィンドウから自然に外れるので、デッキ側の追加フィルタは不要（/ は revalidate しない）。
export async function deactivateFeed(formData: FormData) {
  await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createAdminClient();
  await supabase.from("feeds").update({ active: false }).eq("id", id);
  revalidatePath("/feeds");
}

// 非活性化した feed を取得対象へ戻す（deactivateFeed の対称操作）。
export async function reactivateFeed(formData: FormData) {
  await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const supabase = createAdminClient();
  await supabase.from("feeds").update({ active: true }).eq("id", id);
  revalidatePath("/feeds");
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
  revalidatePath("/saved");
}

export async function toggleStar(formData: FormData) {
  await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const next = formData.get("is_starred") !== "true";
  const supabase = createAdminClient();
  await supabase.from("articles").update({ is_starred: next }).eq("id", id);
  revalidatePath("/saved");
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
    revalidatePath("/saved");
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
  revalidatePath("/saved"); // 「開く」で立てた既読を /saved に反映
}

// ── YAT-27: 適応クイズ ─────────────────────────────────────

// 1 セッションの出題数。オンデマンド生成を Vercel maxDuration(60s) 内に収める控えめな下限
// （design doc の 5〜10 問の下限）。
const QUIZ_SESSION_SIZE = 5;
// serving 用に client へ渡す列（answer_index / explanation を含む＝即時採点のため）。
const QUIZ_SELECT =
  "id, concept_key, concept_label, category, difficulty, stem, choices, answer_index, explanation, source_quote, grounded, source_ref";

// クイズ入力（category）を許可値のみに正規化する。picker は tech/* leaf のみ提示するため、それ以外は
// 「おまかせ」(null) に倒す（直 POST の未知値も null 扱いで安全側）。
function parseQuizCategory(raw: string): TagSlug | null {
  if (isTagSlug(raw) && raw.startsWith("tech/")) return raw;
  return null; // "" / 未知値 = おまかせ
}

// クイズセッションを開始する: 既存 active プール（未回答）を優先し、不足分をオンデマンド生成で
// トップアップして最大 QUIZ_SESSION_SIZE 問返す。client の picker から event handler で呼ぶ。
export async function startQuizSession(
  categoryRaw: string,
): Promise<QuizSessionResult> {
  await requireSession();
  const supabase = createAdminClient();
  const category = parseQuizCategory(categoryRaw);

  try {
    // 回答済み問題は除外して再出題を避ける（単一ユーザーなので全件突き合わせで足りる）。
    const { data: answered } = await supabase
      .from("quiz_attempts")
      .select("question_id");
    const answeredIds = new Set(
      (answered ?? []).map((r) => r.question_id as string),
    );

    // 既存プールから未回答を集める（category 指定時は絞る）。多めに取って回答済みを差し引く。
    let poolQuery = supabase
      .from("quiz_questions")
      .select(QUIZ_SELECT)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(QUIZ_SESSION_SIZE * 4);
    if (category) poolQuery = poolQuery.eq("category", category);
    const { data: poolData } = await poolQuery;

    const questions: QuizQuestion[] = [];
    const seen = new Set<string>();
    for (const q of (poolData ?? []) as unknown as QuizQuestion[]) {
      if (answeredIds.has(q.id) || seen.has(q.id)) continue;
      seen.add(q.id);
      questions.push(q);
      if (questions.length >= QUIZ_SESSION_SIZE) break;
    }

    // 不足分はオンデマンド生成でトップアップ。
    let note: string | null = null;
    if (questions.length < QUIZ_SESSION_SIZE) {
      const gen = await generateQuizForCategory(supabase, {
        category,
        count: QUIZ_SESSION_SIZE - questions.length,
      });
      for (const q of gen.inserted) {
        if (seen.has(q.id)) continue;
        seen.add(q.id);
        questions.push(q);
        if (questions.length >= QUIZ_SESSION_SIZE) break;
      }
      if (questions.length === 0) {
        note = gen.skipped
          ? "問題を生成できません（ANTHROPIC_API_KEY 未設定）。"
          : "このカテゴリの出題を作れませんでした。記事の蓄積を待つか別カテゴリを試してください。";
      }
    }

    return { questions, note };
  } catch (e) {
    console.warn("startQuizSession 失敗:", e);
    return {
      questions: [],
      note: "クイズの準備に失敗しました。時間をおいて再試行してください。",
    };
  }
}

// クイズの回答を記録する（fire-and-forget）。正誤は DB の answer_index で確定し、client 値を信用
// しない（幻覚正解の刷り込みとは別軸で、採点の真偽をサーバ側で担保する）。デッキは client で1枚ずつ
// 進むため /learn は revalidate しない（submitFeedback と同じ index ズレ回避）。
export async function answerQuizQuestion(
  questionId: string,
  chosenIndex: number,
): Promise<void> {
  await requireSession();
  // chosenIndex は client 直送値。選択肢は4件なので 0..3 の範囲外は不正入力として弾く
  // （chosen_index 列には DB chk が無く、範囲外がそのまま記録されるのを防ぐ）。
  if (!questionId || !Number.isInteger(chosenIndex) || chosenIndex < 0 || chosenIndex > 3)
    return;
  const supabase = createAdminClient();
  try {
    const { data: q } = await supabase
      .from("quiz_questions")
      .select("answer_index, concept_key, concept_label, category, difficulty")
      .eq("id", questionId)
      .maybeSingle();
    if (!q) return;
    await recordQuizAttempt(supabase, {
      questionId,
      conceptKey: q.concept_key as string,
      conceptLabel: q.concept_label as string,
      category: q.category as string,
      difficulty: q.difficulty as QuizQuestion["difficulty"],
      isCorrect: chosenIndex === (q.answer_index as number),
      chosenIndex,
    });
  } catch (e) {
    console.warn(`answerQuizQuestion: 記録に失敗 id=${questionId}:`, e);
  }
}
