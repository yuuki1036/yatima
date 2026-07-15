"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { isPubliclyRoutableHttpUrl } from "@/lib/net/ssrf";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordFeedback } from "@/lib/ranking/feedback";
import { FEEDBACK_WEIGHT } from "@/lib/ranking/preferences";
import { ingestAllFeeds } from "@/lib/rss/ingest";
import { enrichMissingBodies } from "@/lib/rss/enrich";
import { annotateMissing } from "@/lib/llm/summarize-batch";
import { curateToday } from "@/lib/ranking/curate";
import { generateQuizForCategory } from "@/lib/learn/quiz-gate";
import { quizPoolDeficit } from "@/lib/learn/quiz-pool";
import { hasApprovedLearnSources } from "@/lib/learn/learn-sources";
import { discoverLearnSources } from "@/lib/learn/source-discovery";
import {
  recordQuizAttempt,
  selectSessionQuestions,
  markConceptsServed,
} from "@/lib/learn/mastery";
import { isTagSlug, type TagSlug } from "@/lib/tags/vocabulary";
import type { FeedbackAction, QuizQuestion, QuizSessionResult } from "@/lib/types";

// 書き込みはすべて service role（RLS バイパス）で行う。

// 手動「更新」の結果（useActionState で UI に返す）。
export type RefreshState = { ok: boolean; message: string } | null;

// 各種 mutation（fire-and-forget な楽観 UI 系＋破壊的操作）の結果。client は成否で toast を出す
// （YAT-41）。throw は error boundary 行きで楽観 UI を壊すため、失敗は戻り値で伝える。
export type MutationResult = { ok: boolean };

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

// フィード追加の結果（useActionState で UI に返す）。url 入力があるため message 付き。
export type AddFeedState = { ok: boolean; message: string } | null;

export async function addFeed(
  _prev: AddFeedState,
  formData: FormData,
): Promise<AddFeedState> {
  await requireSession();
  const raw = String(formData.get("url") ?? "").trim();
  if (!raw) return { ok: false, message: "URL を入力してください。" };
  // client の type="url" は直 POST で迂回できるため server 側でも検証する（YAT-50）。ingest が
  // 取得時に通すのと同じガードを使い、パース不能・非 http(s)・内部レンジを入口で弾く。
  // 保存するのは WHATWG 正規化後の href（scheme/host の小文字化・既定ポート除去まで。www や
  // 末尾スラッシュは畳まないので、normalize-url.ts の normalizeUrl ほど強い正規化ではない）。
  const parsed = isPubliclyRoutableHttpUrl(raw);
  if (!parsed) {
    return { ok: false, message: "http(s) の公開 URL を入力してください。" };
  }
  const url = parsed.href;
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("feeds")
    .upsert({ url }, { onConflict: "url", ignoreDuplicates: true });
  if (error) {
    console.warn("addFeed 失敗:", error);
    return { ok: false, message: "追加に失敗しました。" };
  }
  revalidatePath("/feeds");
  return { ok: true, message: "フィードを追加しました。" };
}

export async function deleteFeed(formData: FormData): Promise<MutationResult> {
  await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false };
  const supabase = createAdminClient();
  const { error } = await supabase.from("feeds").delete().eq("id", id);
  if (error) {
    console.warn(`deleteFeed 失敗 id=${id}:`, error);
    return { ok: false };
  }
  revalidatePath("/feeds");
  revalidatePath("/");
  revalidatePath("/saved");
  return { ok: true };
}

// 削除推奨（YAT-20）の確定アクション: 物理削除せず active=false に倒して取得対象から外す。
// 記事は残すので「後で読む」や既存デッキは保全され、reactivateFeed で復活できる。
// ingestAllFeeds が .eq("active", true) で絞るため、次回 ingest 以降は取得が止まる。既存記事は
// curate の 72h ウィンドウから自然に外れるので、デッキ側の追加フィルタは不要（/ は revalidate しない）。
export async function deactivateFeed(
  formData: FormData,
): Promise<MutationResult> {
  await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false };
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("feeds")
    .update({ active: false })
    .eq("id", id);
  if (error) {
    console.warn(`deactivateFeed 失敗 id=${id}:`, error);
    return { ok: false };
  }
  revalidatePath("/feeds");
  return { ok: true };
}

// 非活性化した feed を取得対象へ戻す（deactivateFeed の対称操作）。
export async function reactivateFeed(
  formData: FormData,
): Promise<MutationResult> {
  await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false };
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("feeds")
    .update({ active: true })
    .eq("id", id);
  if (error) {
    console.warn(`reactivateFeed 失敗 id=${id}:`, error);
    return { ok: false };
  }
  revalidatePath("/feeds");
  return { ok: true };
}

// 自動発見の承認待ち候補（feed_candidates）を feeds へ昇格する（YAT-16）。誤検出を本番取得に
// 混ぜないための承認制の出口。候補の低い初期 credibility をそのまま引き継ぎ、運用で手当てする。
export async function approveFeedCandidate(
  formData: FormData,
): Promise<MutationResult> {
  await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false };
  const supabase = createAdminClient();
  const { data: cand } = await supabase
    .from("feed_candidates")
    .select("url, title, site_url, credibility")
    .eq("id", id)
    .maybeSingle();
  if (!cand) return { ok: false };
  // url unique 衝突は無視（既に手動追加済みの URL を二重承認した場合の保険）。
  const { error: upsertErr } = await supabase.from("feeds").upsert(
    {
      url: cand.url,
      title: cand.title,
      site_url: cand.site_url,
      credibility: cand.credibility,
    },
    { onConflict: "url", ignoreDuplicates: true },
  );
  if (upsertErr) {
    console.warn(`approveFeedCandidate 昇格に失敗 id=${id}:`, upsertErr);
    return { ok: false };
  }
  await supabase
    .from("feed_candidates")
    .update({ status: "approved" })
    .eq("id", id);
  revalidatePath("/feeds");
  return { ok: true };
}

// 候補を却下する。source_domain は status 不問で重複排除に使うため、行は消さず rejected に倒す
// （同じドメインが次回発見で再び候補に挙がるのを防ぐ）。
export async function rejectFeedCandidate(
  formData: FormData,
): Promise<MutationResult> {
  await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false };
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("feed_candidates")
    .update({ status: "rejected" })
    .eq("id", id);
  if (error) {
    console.warn(`rejectFeedCandidate 失敗 id=${id}:`, error);
    return { ok: false };
  }
  revalidatePath("/feeds");
  return { ok: true };
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

export async function toggleRead(formData: FormData): Promise<MutationResult> {
  await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false };
  const next = formData.get("is_read") !== "true"; // 現在値の反転
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("articles")
    .update({ is_read: next })
    .eq("id", id);
  if (error) {
    console.warn(`toggleRead: 更新に失敗 id=${id}:`, error);
    return { ok: false };
  }
  revalidatePath("/saved");
  return { ok: true };
}

export async function toggleStar(formData: FormData): Promise<MutationResult> {
  await requireSession();
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false };
  const next = formData.get("is_starred") !== "true";
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("articles")
    .update({ is_starred: next })
    .eq("id", id);
  if (error) {
    console.warn(`toggleStar: 更新に失敗 id=${id}:`, error);
    return { ok: false };
  }
  revalidatePath("/saved");
  return { ok: true };
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
    let failed = 0;
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
      // 失敗理由は捨てず server ログに残す（cron の scripts/ingest.ts と揃える）。捨てると、
      // 全 feed が落ちても curate が既存プールから補充して ok:true になり、無言で沈む。
      // YAT-49 で取得の失敗モード（ガード不通過・リダイレクト超過・サイズ超過）が増えた分ここが効く。
      for (const r of results) {
        if (r.error) {
          failed += 1;
          console.warn(`[refreshNow] 取得失敗 ${r.feedUrl}: ${r.error}`);
        }
      }
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
    // 失敗は 0 件のとき黙る（「失敗 0」は常時ノイズ）。出た時だけ件数を見せ、理由は server ログへ。
    return {
      ok: true,
      message: `取得 +${inserted}${failed ? `（失敗 ${failed}）` : ""} / 要約 ${annotated} / ${deck}`,
    };
  } catch (e) {
    console.warn("refreshNow 失敗:", e);
    return { ok: false, message: "取得に失敗しました。時間をおいて再試行してください" };
  }
}

// Tinder カードのフィードバック（開く/役立った/不要）。タグ嗜好を更新し、当日の一覧を再取得させる。
export async function submitFeedback(
  formData: FormData,
): Promise<MutationResult> {
  await requireSession();
  const id = String(formData.get("id") ?? "");
  const action = String(formData.get("action") ?? "");
  // 直 POST 防御: 既知の action 値のみ受け付ける。
  // `in` は prototype チェーンも見て "toString" 等を通すため Object.hasOwn を使う
  // （通すと delta=NaN になり preferences.weight(NOT NULL) を壊す）。
  if (!id || !Object.hasOwn(FEEDBACK_WEIGHT, action)) {
    // 楽観 UI は結果を見ず進むため、無痕跡だと不正 POST に気づけない。痕跡だけ残す。
    console.warn(`submitFeedback: 不正な入力を棄却 id=${id} action=${action}`);
    return { ok: false };
  }
  const supabase = createAdminClient();
  // クライアントは結果を await せず楽観的にカードを進める（fire-and-forget）。
  // throw は error boundary 行きで楽観 UI を壊すため、失敗は戻り値で返し client の toast に繋ぐ。
  try {
    await recordFeedback(supabase, id, action as FeedbackAction);
  } catch (e) {
    console.warn(`submitFeedback: 記録に失敗 id=${id} action=${action}:`, e);
    return { ok: false };
  }
  // "/" は revalidate しない: デッキはクライアント側で1枚ずつ進むため、ここで再取得して
  // 判定済みカードを配列から除外すると、楽観的に進めた index と二重にズレてカードが飛ぶ。
  // リロード時はサーバクエリが判定済みを除外し、続きから再開する。
  revalidatePath("/saved"); // 「開く」で立てた既読を /saved に反映
  return { ok: true };
}

// ── YAT-27: 適応クイズ ─────────────────────────────────────

// 1 セッションの出題数（design doc の 5〜10 問の下限）。
const QUIZ_SESSION_SIZE = 5;

// 裏補充（after）で 1 回に使う素材ソースの上限。同期生成を撤去した代わりに、プールで満たせなかった
// セッションの後で軽く生成してプールを温める。after は route の maxDuration(60s) を共有するため
// ソース数を絞って確実に収める（1 ソースあたり LLM 1 呼び出し・直列）。YAT-31。
const QUIZ_REFILL_MAX_SOURCES = 3;

// クイズ入力（category）を許可値のみに正規化する。picker は tech/* leaf のみ提示するため、それ以外は
// 「おまかせ」(null) に倒す（直 POST の未知値も null 扱いで安全側）。
function parseQuizCategory(raw: string): TagSlug | null {
  if (isTagSlug(raw) && raw.startsWith("tech/")) return raw;
  return null; // "" / 未知値 = おまかせ
}

// クイズセッションを開始する: 既存 active プールから適応選定（弱点度×間隔×レベル一致）で最大
// QUIZ_SESSION_SIZE 問を出題する。同期 LLM 生成はしない（＝ユーザーの待ち時間から生成を外し、
// Vercel maxDuration 超過によるタイムアウトを断つ。YAT-31）。プールで満たせない分はレスポンス送出
// 後の裏補充（after）に回し、次回以降のセッションに効かせる。出題確定後に last_served_at を更新
// する（YAT-28）。client の picker から event handler で呼ぶ。
export async function startQuizSession(
  categoryRaw: string,
): Promise<QuizSessionResult> {
  await requireSession();
  const supabase = createAdminClient();
  const category = parseQuizCategory(categoryRaw);

  try {
    // 適応選定（eligibility フィルタ＋スコアリング＋concept 重複回避）で既存プールから組む。
    const questions = await selectSessionQuestions(supabase, {
      category,
      size: QUIZ_SESSION_SIZE,
    });

    // 出題した concept の last_served_at を更新（間隔ボーナス用）。失敗しても出題は成立させる。
    if (questions.length > 0) {
      try {
        await markConceptsServed(
          supabase,
          questions.map((q) => q.concept_key),
        );
      } catch (e) {
        console.warn("last_served_at の更新に失敗:", e);
      }
    }

    // セッションをプールで満たせなかったとき、その場生成ではなくレスポンス送出後の裏補充に回す
    // （after）。ユーザーは待たされず、生成分は次回以降のセッションに効く。ただし「短いセッション」の
    // 原因は SRS クールダウン（正解済みが eligible から外れる）とプール枯渇の両方があり、前者では
    // 生成すべきでない。そこで発火判定はセッションの不足数ではなくプール目標に対する deficit で行い、
    // cron と同じ「target 未満なら補充」に揃える（目標超えの青天井増殖を防ぐ。YAT-31）。deficit は
    // 軽量 count なので同期で先に測り、note の出し分け（枯渇=準備中／クールダウン=間隔案内）にも使う。
    let note: string | null = null;
    if (questions.length < QUIZ_SESSION_SIZE) {
      const deficit = await quizPoolDeficit(supabase, category);
      // プール目標に未達なら補充候補。ただし承認済み learn_sources が無いカテゴリは生成しても素材が
      // 無いので after を発火させない（毎セッション空振り＋過疎ソースの反復生成を防ぐ。YAT-32 F-G）。
      const canRefill =
        deficit > 0 && (await hasApprovedLearnSources(supabase, category));
      if (canRefill) {
        // after は maxDuration を共有するためソース数と 1 回の生成数を絞る。失敗は握りつぶす。
        const count = Math.min(deficit, QUIZ_SESSION_SIZE);
        after(async () => {
          try {
            await generateQuizForCategory(supabase, {
              category,
              count,
              maxSources: QUIZ_REFILL_MAX_SOURCES,
            });
          } catch (e) {
            console.warn("クイズの裏補充に失敗:", e);
          }
        });
      }
      if (questions.length === 0) {
        // 0 問の理由で案内を出し分ける: 準備中（補充が走る）／ソース未登録（探す導線へ）／
        // クールダウン（プールは足りるが最近解いた問題ばかり eligible から外れた）。
        note = canRefill
          ? "このカテゴリの出題を準備中です。少し時間をおいてから、もう一度お試しください。"
          : deficit > 0
            ? "このカテゴリはまだ学習ソースが未登録です。「ソースを探す」から追加してください。"
            : "このカテゴリは最近解いた問題が続いています。少し間隔をあけると再出題されます。別カテゴリもどうぞ。";
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
): Promise<MutationResult> {
  await requireSession();
  // chosenIndex は client 直送値。選択肢は4件なので 0..3 の範囲外は不正入力として弾く
  // （chosen_index 列には DB chk が無く、範囲外がそのまま記録されるのを防ぐ）。
  if (!questionId || !Number.isInteger(chosenIndex) || chosenIndex < 0 || chosenIndex > 3)
    return { ok: false };
  const supabase = createAdminClient();
  try {
    const { data: q } = await supabase
      .from("quiz_questions")
      .select("answer_index, concept_key, concept_label, category, difficulty")
      .eq("id", questionId)
      .maybeSingle();
    if (!q) return { ok: false };
    await recordQuizAttempt(supabase, {
      questionId,
      conceptKey: q.concept_key as string,
      conceptLabel: q.concept_label as string,
      category: q.category as string,
      difficulty: q.difficulty as QuizQuestion["difficulty"],
      isCorrect: chosenIndex === (q.answer_index as number),
      chosenIndex,
    });
    return { ok: true };
  } catch (e) {
    console.warn(`answerQuizQuestion: 記録に失敗 id=${questionId}:`, e);
    return { ok: false };
  }
}

// ── YAT-32: 学習ソースの発見・承認 ─────────────────────────────

// 提案結果を UI に返す（useActionState 用）。承認待ちの新規件数を伝える。
export type ProposeSourcesState = { ok: boolean; message: string } | null;

// カテゴリを指定して学習ソースを発見する（LLM 提案 → 検証ゲート → learn_sources(pending)）。
// /learn の「ソースを探す」フォームから呼ぶ。おまかせ(null)は提案テーマが曖昧なので不可＝tech/* 必須。
export async function proposeLearnSources(
  _prev: ProposeSourcesState,
  formData: FormData,
): Promise<ProposeSourcesState> {
  await requireSession();
  const category = parseQuizCategory(String(formData.get("category") ?? ""));
  if (!category) {
    return { ok: false, message: "カテゴリを選んでください（おまかせは不可）。" };
  }
  // 任意の絞り込みヒント（粗いカテゴリを sub-topic へ steer）。自分専用だが LLM 入力なので長さは抑える。
  const hint = String(formData.get("hint") ?? "").trim().slice(0, 100) || undefined;
  const supabase = createAdminClient();
  try {
    const r = await discoverLearnSources(supabase, { category, hint });
    revalidatePath("/learn");
    if (r.skipped) {
      return { ok: false, message: "提案できません（ANTHROPIC_API_KEY 未設定）。" };
    }
    return {
      ok: true,
      message: `候補 ${r.proposed} 件・検証通過 ${r.validated} 件・承認待ちに ${r.inserted} 件追加しました。`,
    };
  } catch (e) {
    console.warn("proposeLearnSources 失敗:", e);
    return { ok: false, message: "ソースの発見に失敗しました。時間をおいて再試行してください。" };
  }
}

// 承認待ちソースを承認/却下する（learn_sources.status を倒す）。承認で生成素材になる。
// form の hidden id ＋ formAction で「承認」「却下」ボタンを分ける（feeds の候補承認と同作法）。
export async function reviewLearnSource(
  formData: FormData,
): Promise<MutationResult> {
  await requireSession();
  const id = String(formData.get("id") ?? "");
  const decision = String(formData.get("decision") ?? "");
  if (!id || (decision !== "approve" && decision !== "reject"))
    return { ok: false };
  const supabase = createAdminClient();
  try {
    const { error } = await supabase
      .from("learn_sources")
      .update({
        status: decision === "approve" ? "approved" : "rejected",
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) throw error;
    revalidatePath("/learn");
    return { ok: true };
  } catch (e) {
    console.warn(`reviewLearnSource 失敗 id=${id}:`, e);
    return { ok: false };
  }
}
