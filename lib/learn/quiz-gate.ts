import type { SupabaseClient } from "@supabase/supabase-js";
import { htmlToInputText } from "@/lib/llm/extract-text";
import { norm, isQuoteGrounded, GROUND_BODY_MAX_CHARS } from "@/lib/learn/grounding";
import { conceptSlug, coerceCategory } from "@/lib/learn/concept";
import {
  createQuizGenerator,
  MAX_MCQ_PER_ARTICLE,
  type QuizGenerator,
  type GeneratedMCQ,
} from "@/lib/llm/generate-quiz";
import { tagLabel, type TagSlug } from "@/lib/tags/vocabulary";
import { loadLearnSources } from "@/lib/learn/learn-sources";
import type { QuizDifficulty, QuizQuestion } from "@/lib/types";

// quiz_questions への insert 行（gateMCQs が積み、cron/オンデマンドが insert する）。名前付き型に
// することで、キー改名や欠落をコンパイルで検出する（card-gate が GeneratedCard を持ち回って得ていた
// 型保証を、Record<string, unknown> の引き回しで手放さないため）。embedding は cron のみ付与する。
export type QuizInsertRow = {
  concept_key: string;
  concept_label: string;
  category: string;
  difficulty: QuizDifficulty;
  stem: string;
  choices: string[];
  answer_index: number;
  explanation: string;
  source_quote: string | null;
  grounded: boolean;
  source_ref: string | null;
  status: "active";
  embedding?: string | null; // vecToPg 済み文字列。オンデマンドは未設定（null 混入なし）
};

// YAT-27: 適応クイズの生成ゲート。素材から MCQ を生成し、決定的に検証（形式 → concept 正規化 →
// 逐語 grounding）してから quiz_questions(active) へ積む。card-gate.ts の「母集団取得 → 生成 → 形式
// → grounding → insert」構造を選択式に写した MVP 版。dedup（embedding/cosine）はここでは行わず
// cron に委ねる（Server Action の maxDuration=60 内に収めるため）。照合失敗の問題は捨てる。
// YAT-32: 素材は RSS 記事プールから承認制 evergreen ソース（learn_sources）へ切替（時事偏重の是正）。

const CANDIDATE_SOURCES = 8; // 1 セッションで素材にする候補ソースの上限（LLM 呼び出し数の上限に効く）
const GROUND_BODY_FALLBACK = "other" satisfies TagSlug; // おまかせ時などの category 矯正の最終フォールバック
// ④語彙重なりを無効化する（YAT-30）。英語記事の逐語引用×日本語設問で固有トークンが言語違いにより
// ほぼ重ならず④が通過率の支配的な棄却要因になっていた（計測: low_overlap が棄却の 7 割超）。②逐語＋
// ③固有性が「引用は実在の記事固有テキスト」を担保するため、MCQ は④に依拠しない。
// 副作用: ④が担っていた「quote と設問の関連性」チェックが外れ、実在だが設問と無関係な文が quote に
// 選ばれる余地が残る（design doc F2 の担保集合が「設問と語彙が重なる」を失う方向に一段狭まる）。ただし
// 正誤の真偽は元々④では検証しておらず（F2 は別軸）、quote は出典表示の補足なので許容する。
const QUIZ_MIN_OVERLAP = 0;

export type QuizGenResult = {
  requested: number; // 目標生成数
  generated: number; // LLM が返した候補総数
  passed: number; // 形式＋grounding を通過した数
  inserted: QuizQuestion[]; // quiz_questions へ積んだ問題
  skipped: boolean; // ANTHROPIC_API_KEY 未設定でスキップ
};

// 既存 concept_label の候補一覧（生成時に LLM へ提示して表記の再利用を促す・F3）。
async function loadExistingConcepts(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase
    .from("topic_mastery")
    .select("concept_label")
    .order("updated_at", { ascending: false })
    .limit(40);
  if (error) return []; // 候補提示は任意（失敗しても新規 slug で続行）
  return (data ?? []).map((r) => r.concept_label as string).filter(Boolean);
}

// 生成 MCQ を決定的に検証して insert 行へ変換する（1 ソースぶん）。form → concept → grounding の順。
function gateMCQs(
  mcqs: GeneratedMCQ[],
  groundBodyNorm: string,
  sourceId: string,
  fallbackCategory: TagSlug,
  limit: number,
): QuizInsertRow[] {
  const rows: QuizInsertRow[] = [];
  for (const q of mcqs) {
    if (rows.length >= limit) break;

    // ① concept 正規化（空 slug＝正規化不能は捨てる）。
    const conceptKey = conceptSlug(q.concept_label);
    if (!conceptKey) continue;

    // ② grounding 逐語照合。④語彙重なりは MCQ では無効化（QUIZ_MIN_OVERLAP=0）し、②逐語＋③固有性で担保する。
    const target = `${q.stem} ${q.choices.join(" ")}`;
    if (!isQuoteGrounded(q.source_quote, groundBodyNorm, target, QUIZ_MIN_OVERLAP)) continue;

    const category = coerceCategory(q.category, fallbackCategory);
    rows.push({
      concept_key: conceptKey,
      concept_label: q.concept_label,
      category,
      difficulty: q.difficulty,
      stem: q.stem,
      choices: q.choices,
      answer_index: q.answer_index,
      explanation: q.explanation,
      source_quote: q.source_quote,
      grounded: true,
      source_ref: sourceId, // learn_sources.id（YAT-32。旧: article_id）
      // embedding / dup_flag は MVP 未設定（YAT-29 の cron が dedup で埋める）。
      status: "active",
    });
  }
  return rows;
}

// insert 後に serving 形（QuizQuestion）へ返す列。cron・オンデマンド双方の insert で共有する。
const QUIZ_INSERT_SELECT =
  "id, concept_key, concept_label, category, difficulty, stem, choices, answer_index, explanation, source_quote, grounded, source_ref";

// 生成コアの結果。insert 前の候補行（embedding 未設定）と集計を返す。
export type QuizGenCoreResult = {
  requested: number; // 目標生成数
  generated: number; // LLM が返した候補総数
  passed: number; // 形式＋grounding を通過した数
  rows: QuizInsertRow[]; // quiz_questions へ insert 可能な行（embedding は未設定＝cron が付与）
  skipped: boolean; // ANTHROPIC_API_KEY 未設定でスキップ
};

// 生成コア: 素材取得（承認済み learn_sources）→ LLM 生成 → 形式検証 → concept 正規化 → grounding
// 逐語照合まで。DB 書き込みはしない（候補行の生産に専念）。オンデマンド（generateQuizForCategory）と
// cron（quiz-pool）が共有し、insert / embed / dedup の組み立ては呼び側に委ねる（両経路で embedding
// 付与の有無が非対称なため）。素材が 0 件（ソース未登録カテゴリ）なら生成せず空で返る。
export async function generateGatedQuizRows(
  supabase: SupabaseClient,
  opts: {
    category: TagSlug | null; // null = おまかせ
    count: number; // 目標生成数
    generator?: QuizGenerator | null;
    maxSources?: number; // 素材ソースの上限（cron は絞って LLM 呼び出し数を抑える）
  },
): Promise<QuizGenCoreResult> {
  const generator =
    opts.generator !== undefined ? opts.generator : createQuizGenerator();
  const result: QuizGenCoreResult = {
    requested: opts.count,
    generated: 0,
    passed: 0,
    rows: [],
    skipped: false,
  };
  if (opts.count <= 0) return result;

  // API キー未設定 → 生成スキップ（既存プールだけで出題する。呼び出し側が判断）。
  if (!generator) {
    result.skipped = true;
    return result;
  }

  const fallbackCategory: TagSlug = opts.category ?? GROUND_BODY_FALLBACK;
  const categoryLabel = opts.category ? tagLabel(opts.category) : "エンジニア技術全般";
  const maxSources = opts.maxSources ?? CANDIDATE_SOURCES;

  let sources: Awaited<ReturnType<typeof loadLearnSources>>;
  let existingConcepts: string[];
  try {
    sources = await loadLearnSources(supabase, opts.category, maxSources);
    existingConcepts = await loadExistingConcepts(supabase);
  } catch (e) {
    console.warn("クイズ生成の素材取得に失敗:", e);
    return result;
  }
  if (sources.length === 0) return result; // 承認済みソース無し＝生成しない

  // ソース単位の fail-soft ループ（直列）。必要数に達したら打ち切る。
  for (const source of sources) {
    if (result.rows.length >= opts.count) break;
    try {
      const rawBody = htmlToInputText(source.content_html, GROUND_BODY_MAX_CHARS);
      if (!rawBody) continue;
      const groundBody = norm(rawBody);

      const remaining = opts.count - result.rows.length;
      const mcqs = await generator.generate({
        title: source.title,
        articleText: rawBody,
        categoryLabel,
        count: Math.min(remaining, MAX_MCQ_PER_ARTICLE),
        existingConcepts,
      });
      result.generated += mcqs.length;

      const passed = gateMCQs(mcqs, groundBody, source.id, fallbackCategory, remaining);
      result.passed += passed.length;
      result.rows.push(...passed);
    } catch (e) {
      console.warn(`クイズ生成に失敗 [${source.id}]:`, e);
    }
  }

  return result;
}

// 候補行を quiz_questions へ bulk insert し、serving 形で返す。失敗は fail-soft（warn して []）。
// bulk insert は 1 行でも制約違反すると全体が rollback される（部分成功しない）。
export async function insertQuizRows(
  supabase: SupabaseClient,
  rows: QuizInsertRow[],
): Promise<QuizQuestion[]> {
  if (rows.length === 0) return [];
  const { data, error } = await supabase
    .from("quiz_questions")
    .insert(rows)
    .select(QUIZ_INSERT_SELECT);
  if (error) {
    // 件数を添えて「積む行が 0 だった」と「N 行あったが insert 失敗」を切り分け可能にする。
    console.warn(`quiz_questions への登録に失敗（${rows.length} 件）:`, error);
    return [];
  }
  return (data ?? []) as unknown as QuizQuestion[];
}

// カテゴリの記事から count 問を目標に生成し、通過分を quiz_questions へ積んで返す。生成コアの薄い
// ラッパ（embedding 付与・dedup はしない＝embed/dedup は cron が backfill。YAT-27 の判断）。
// セッション開始の裏補充（after）から呼ぶため maxSources で LLM 呼び出し数を絞れる（YAT-31）。
export async function generateQuizForCategory(
  supabase: SupabaseClient,
  opts: {
    category: TagSlug | null; // null = おまかせ
    count: number; // 目標生成数（不足分の必要数）
    generator?: QuizGenerator | null;
    maxSources?: number; // 素材ソースの上限（裏補充は絞って maxDuration 内に確実に収める）
  },
): Promise<QuizGenResult> {
  const core = await generateGatedQuizRows(supabase, opts);
  const inserted = await insertQuizRows(supabase, core.rows);
  return {
    requested: core.requested,
    generated: core.generated,
    passed: core.passed,
    inserted,
    skipped: core.skipped,
  };
}
