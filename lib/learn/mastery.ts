import type { SupabaseClient } from "@supabase/supabase-js";
import { tagLabel, TAG_LEAVES, type TagSlug } from "@/lib/tags/vocabulary";
import type { CategoryMastery, ConceptMastery, QuizDifficulty, QuizQuestion } from "@/lib/types";

// YAT-28: 適応クイズの mastery 更新・出題選定・弱点マップ集計。
// 役割分担: quiz_attempts が回答の元帳、topic_mastery が concept 単位の EWMA キャッシュ。
// 書き込みは回答ごと O(1)（topic_mastery 1 行の read-modify-write）を保ち、較正・再計算の退路は
// 元帳（quiz_attempts）から nextMastery を replay することで残す（YAT-27 の素正答率もこの式へ連続）。
// is_correct は呼び出し側（Server Action）が DB の answer_index と突き合わせて確定する（client 値を
// 信用しない）。dedup・embedding・cron コアプールは YAT-29。

const QUIZ_SELECT =
  "id, concept_key, concept_label, category, difficulty, stem, choices, answer_index, explanation, source_quote, grounded, source_ref";

// ── 適応パラメータ（PoC 較正前提。design doc open「mastery 更新式のパラメータ」対応）──────
// 未回答 concept の事前 mastery。低め＝新規 concept を「やや弱点」として出題側へ倒す。
const MASTERY_PRIOR = 0.3;
// EWMA 学習率。難問正解は大きく上げ、易問不正解は大きく下げる非対称設計。
// medium の 0.25 は実効窓 ≈ 直近 7 回（2/α − 1）に相当する。
const MASTERY_ALPHA = {
  easy: { correct: 0.15, wrong: 0.4 },
  medium: { correct: 0.25, wrong: 0.25 },
  hard: { correct: 0.4, wrong: 0.15 },
} as const satisfies Record<QuizDifficulty, { correct: number; wrong: number }>;

// 再出題の間隔（日）。最終回答が正解の問題は長く伏せ、不正解は短く戻す（ただし 2 日は短すぎて
// 「間違えた問題がすぐ戻る」体感になるため 4 日に延長。YAT-43）。
const RETRY_CORRECT_DAYS = 14;
const RETRY_WRONG_DAYS = 4;

// 選定スコアの係数。
const WEAKNESS_FLOOR = 0.1; // 習熟済み concept も細く候補に残す（弱点度の下駄）
// concept 単位のハード除外は無く、間隔抑止はこのソフト減衰のみ。下駄を小さくして直近出題 concept を
// 実質最下位まで沈め、同一 concept の翌セッション再登場を抑える（YAT-43）。弱点度は温存するので
// クールダウン明け後は弱点 concept が正しく優先される（適応性は壊さない）。
const SERVE_BONUS_FLOOR = 0.05; // 直近出題でも 0 にはせず細く候補に残す（間隔ボーナスの下駄）
const SERVE_SATURATION_DAYS = 14; // 経過日数がこの値で間隔ボーナスが最大化（上位に戻るまでの日数）
const LEVEL_MATCH = [1.0, 0.5, 0.15] as const; // 難易度帯の段差 0 / ±1 / ±2 の重み
const SCORE_JITTER = 0.1; // 同点の決定的固着を崩す揺らぎ幅
const POOL_FETCH_LIMIT = 500; // JS スコアリングの母集団安全弁（超過分は古い順に候補外。YAT-29 で再検討）
const WEAK_CONCEPTS_PER_CATEGORY = 3; // 弱点マップで各カテゴリに出す弱点 concept 数

const MS_PER_DAY = 86_400_000;

// 難易度未知値（列は text なので将来値変更等を防御）は medium に倒す。
function safeDifficulty(d: string): QuizDifficulty {
  return d === "easy" || d === "hard" ? d : "medium";
}

// EWMA による mastery 更新（pure。テスト・replay backfill が再利用する）。
export function nextMastery(
  prev: number,
  difficulty: QuizDifficulty,
  isCorrect: boolean,
): number {
  const a = MASTERY_ALPHA[difficulty][isCorrect ? "correct" : "wrong"];
  const target = isCorrect ? 1 : 0;
  return Math.min(1, Math.max(0, prev + a * (target - prev)));
}

export type RecordAttemptParams = {
  questionId: string;
  conceptKey: string;
  conceptLabel: string;
  category: string;
  difficulty: QuizDifficulty;
  isCorrect: boolean;
  chosenIndex: number;
};

// 回答を quiz_attempts へ記録し、topic_mastery を EWMA で更新する。
// 失敗は握り潰さず throw する（呼び出し側の Server Action が fire-and-forget で warn する）。
export async function recordQuizAttempt(
  supabase: SupabaseClient,
  p: RecordAttemptParams,
): Promise<void> {
  await supabase.from("quiz_attempts").insert({
    question_id: p.questionId,
    concept_key: p.conceptKey,
    difficulty: p.difficulty,
    is_correct: p.isCorrect,
    chosen_index: p.chosenIndex,
  });

  // 現在の mastery を読んで EWMA を進める（単一ユーザーなので read-modify-write で十分）。
  // 行なし / attempts=0 は事前値 MASTERY_PRIOR をシードにする（YAT-27 の素正答率もそのまま prev）。
  const { data: cur } = await supabase
    .from("topic_mastery")
    .select("mastery, attempts")
    .eq("concept_key", p.conceptKey)
    .maybeSingle();

  const prevAttempts = cur?.attempts ?? 0;
  const prev = prevAttempts === 0 ? MASTERY_PRIOR : (cur?.mastery ?? MASTERY_PRIOR);
  const mastery = nextMastery(prev, p.difficulty, p.isCorrect);

  await supabase.from("topic_mastery").upsert(
    {
      concept_key: p.conceptKey,
      concept_label: p.conceptLabel,
      category: p.category,
      mastery,
      attempts: prevAttempts + 1,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "concept_key" },
  );
}

// ── 出題選定 ─────────────────────────────────────────────

type MasteryRow = { mastery: number; last_served_at: string | null };
type LastAttempt = { isCorrect: boolean; at: number };

const clampDays = (ms: number) => ms / MS_PER_DAY;

// mastery → 目標難易度帯（レベル適応の中心）。
function masteryBand(mastery: number): QuizDifficulty {
  if (mastery < 0.4) return "easy";
  if (mastery < 0.7) return "medium";
  return "hard";
}

const BAND_INDEX: Record<QuizDifficulty, number> = { easy: 0, medium: 1, hard: 2 };

// 最終回答から再出題可能か（question 単位）。未回答は常に可。
function isEligible(last: LastAttempt | undefined, nowMs: number): boolean {
  if (!last) return true;
  const days = clampDays(nowMs - last.at);
  return days >= (last.isCorrect ? RETRY_CORRECT_DAYS : RETRY_WRONG_DAYS);
}

// 1 問のスコア = 弱点度 × 間隔ボーナス × レベル一致 × jitter。rng は注入で pure 性を保つ
// （export は YAT-53 のユニットテスト用。選定本体は selectSessionQuestions が唯一の呼び出し元）。
export function scoreQuestion(
  q: QuizQuestion,
  masteryMap: Map<string, MasteryRow>,
  nowMs: number,
  rng: () => number,
): number {
  const row = masteryMap.get(q.concept_key);
  const mastery = row?.mastery ?? MASTERY_PRIOR;

  const weakness = Math.max(1 - mastery, WEAKNESS_FLOOR);

  let interval: number;
  if (!row?.last_served_at) {
    interval = 1; // 未出題 concept は最大（確定前提）
  } else {
    const days = clampDays(nowMs - new Date(row.last_served_at).getTime());
    interval =
      SERVE_BONUS_FLOOR +
      (1 - SERVE_BONUS_FLOOR) * Math.min(1, days / SERVE_SATURATION_DAYS);
  }

  const gap = Math.abs(
    BAND_INDEX[masteryBand(mastery)] - BAND_INDEX[safeDifficulty(q.difficulty)],
  );
  const level = LEVEL_MATCH[gap] ?? LEVEL_MATCH[LEVEL_MATCH.length - 1];

  const jitter = 1 + SCORE_JITTER * (rng() - 0.5);
  return weakness * interval * level * jitter;
}

// 適応選定でセッションの出題を組む。プール取得 → eligibility → スコア → concept 重複回避で size 件。
// last_served_at の更新は行わない（最終リスト確定後に markConceptsServed を呼ぶ）。
export async function selectSessionQuestions(
  supabase: SupabaseClient,
  opts: { category: TagSlug | null; size: number; rng?: () => number },
): Promise<QuizQuestion[]> {
  const rng = opts.rng ?? Math.random;
  const nowMs = Date.now();

  // ブロックし得るのは「正解リトライ間隔より新しい attempt」だけなので、その窓に絞って引く。
  const retryCutoff = new Date(nowMs - RETRY_CORRECT_DAYS * MS_PER_DAY).toISOString();
  let poolQuery = supabase
    .from("quiz_questions")
    .select(QUIZ_SELECT)
    .eq("status", "active")
    // YAT-61: 近重複は insert されるが出題しない（dedup が skip 方式から dup_flag 方式へ変わり、
    // 弾いた候補も行として残るようになったため。除外しないと重複問題がそのまま出題される）。
    .eq("dup_flag", false)
    .order("created_at", { ascending: false })
    .limit(POOL_FETCH_LIMIT);
  if (opts.category) poolQuery = poolQuery.eq("category", opts.category);

  const [poolRes, masteryRes, attemptRes] = await Promise.all([
    poolQuery,
    supabase.from("topic_mastery").select("concept_key, mastery, last_served_at"),
    supabase
      .from("quiz_attempts")
      .select("question_id, is_correct, created_at")
      .gte("created_at", retryCutoff)
      .order("created_at", { ascending: false }),
  ]);

  // プールと attempt は安全側に倒す（throw して呼び出し側の try/catch でセッション準備失敗に落とす）。
  // 特に attempt の取得失敗を空フォールバックすると全問 eligible 扱いになり、回答直後の問題が
  // 即再出題される（再出題抑止が静かに無効化する）。mastery は失敗しても PRIOR 相当の劣化に留まる
  // ため warn で継続する。
  if (poolRes.error) throw poolRes.error;
  if (attemptRes.error) throw attemptRes.error;
  if (masteryRes.error) console.warn("mastery の取得に失敗（PRIOR で継続）:", masteryRes.error);

  const pool = (poolRes.data ?? []) as unknown as QuizQuestion[];
  if (pool.length === 0) return [];

  const masteryMap = new Map<string, MasteryRow>();
  for (const r of masteryRes.data ?? []) {
    masteryMap.set(r.concept_key as string, {
      mastery: r.mastery as number,
      last_served_at: r.last_served_at as string | null,
    });
  }

  // desc 順で question_id ごと最初に見た行＝最新 attempt（窓外の古い attempt は eligible 扱い）。
  const lastAttempt = new Map<string, LastAttempt>();
  for (const a of attemptRes.data ?? []) {
    const id = a.question_id as string;
    if (!id || lastAttempt.has(id)) continue;
    lastAttempt.set(id, {
      isCorrect: a.is_correct as boolean,
      at: new Date(a.created_at as string).getTime(),
    });
  }

  const scored = pool
    .filter((q) => isEligible(lastAttempt.get(q.id), nowMs))
    .map((q) => ({ q, score: scoreQuestion(q, masteryMap, nowMs, rng) }))
    .sort((a, b) => b.score - a.score);

  // 第1パス: concept 重複を避けて貪欲選定。第2パスで不足を重複許容で補充（プール薄対策）。
  const picked: QuizQuestion[] = [];
  const usedConcepts = new Set<string>();
  const usedIds = new Set<string>();
  for (const { q } of scored) {
    if (picked.length >= opts.size) break;
    if (usedConcepts.has(q.concept_key)) continue;
    picked.push(q);
    usedConcepts.add(q.concept_key);
    usedIds.add(q.id);
  }
  if (picked.length < opts.size) {
    for (const { q } of scored) {
      if (picked.length >= opts.size) break;
      if (usedIds.has(q.id)) continue;
      picked.push(q);
      usedIds.add(q.id);
    }
  }
  return picked;
}

// 出題を確定した concept の last_served_at を now に更新する（既存 row のみ。空 row は作らない）。
// 失敗は握り潰さず throw（呼び出し側が fail-soft で warn する）。
export async function markConceptsServed(
  supabase: SupabaseClient,
  conceptKeys: string[],
): Promise<void> {
  const keys = [...new Set(conceptKeys)];
  if (keys.length === 0) return;
  // Supabase の update はクエリ失敗を throw せず error に入れるため明示的に throw する
  // （呼び出し側は throw を前提に fail-soft で warn する）。
  const { error } = await supabase
    .from("topic_mastery")
    .update({ last_served_at: new Date().toISOString() })
    .in("concept_key", keys);
  if (error) throw error;
}

// ── 弱点マップ集計 ────────────────────────────────────────

type MasteryConceptRow = {
  concept_key: string;
  concept_label: string;
  category: string;
  mastery: number;
  attempts: number;
};

// tech/* leaf の表示順（picker と揃える）。マップ表示のグルーピング順の SSoT。
const TECH_LEAF_ORDER: string[] = TAG_LEAVES.filter((t) => t.parent === "tech").map(
  (t) => t.slug,
);

// topic_mastery 行を tech/* カテゴリ単位へ集約する（pure）。row の無いカテゴリは出さない。
export function buildCategoryMastery(rows: MasteryConceptRow[]): CategoryMastery[] {
  const byCategory = new Map<string, ConceptMastery[]>();
  for (const r of rows) {
    if (!r.category.startsWith("tech/")) continue; // 学習は tech に寄せる（弱点マップは tech のみ）
    const list = byCategory.get(r.category) ?? [];
    list.push({
      concept_key: r.concept_key,
      concept_label: r.concept_label,
      mastery: r.mastery,
      attempts: r.attempts,
    });
    byCategory.set(r.category, list);
  }

  const orderIndex = (slug: string) => {
    const i = TECH_LEAF_ORDER.indexOf(slug);
    return i === -1 ? TECH_LEAF_ORDER.length : i;
  };

  return [...byCategory.entries()]
    .map(([slug, concepts]) => {
      const mastery =
        concepts.reduce((s, c) => s + c.mastery, 0) / concepts.length;
      const weakest = [...concepts]
        .sort((a, b) => a.mastery - b.mastery)
        .slice(0, WEAK_CONCEPTS_PER_CATEGORY);
      return {
        slug,
        label: tagLabel(slug),
        mastery,
        conceptCount: concepts.length,
        weakest,
      };
    })
    .sort((a, b) => orderIndex(a.slug) - orderIndex(b.slug));
}

// 弱点マップのデータを取得して集約する（Server Component から呼ぶ。anon SELECT で通る）。
export async function loadCategoryMastery(
  supabase: SupabaseClient,
): Promise<CategoryMastery[]> {
  const { data, error } = await supabase
    .from("topic_mastery")
    .select("concept_key, concept_label, category, mastery, attempts")
    .like("category", "tech/%");
  if (error) throw error;
  return buildCategoryMastery((data ?? []) as unknown as MasteryConceptRow[]);
}
