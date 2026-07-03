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
import type { QuizQuestion } from "@/lib/types";

// YAT-27: 適応クイズのオンデマンド生成ゲート。カテゴリ選択→記事駆動で MCQ を生成し、決定的に
// 検証（形式 → concept 正規化 → 逐語 grounding）してから quiz_questions(active) へ積む。card-gate.ts
// の「母集団取得 → 生成 → 形式 → grounding → insert」構造を選択式に写した MVP 版。
// dedup（embedding/cosine）は MVP では行わず YAT-29 の cron に委ねる（Server Action の maxDuration=60
// 内に収めるため。grounding 照合は文字列演算のみで安い）。照合失敗の問題は捨てる（grounded=true のみ積む）。

const CANDIDATE_ARTICLES = 8; // 1 セッションで素材にする候補記事の上限（LLM 呼び出し数の上限に効く）
const GROUND_BODY_FALLBACK = "other" satisfies TagSlug; // おまかせ時などの category 矯正の最終フォールバック

type ArticleRow = {
  id: string;
  title: string | null;
  content_html: string | null;
  feeds: { credibility: number | null } | null;
};

export type QuizGenResult = {
  requested: number; // 目標生成数
  generated: number; // LLM が返した候補総数
  passed: number; // 形式＋grounding を通過した数
  inserted: QuizQuestion[]; // quiz_questions へ積んだ問題
  skipped: boolean; // ANTHROPIC_API_KEY 未設定でスキップ
};

// カテゴリに属する記事を content_html 付きで取得する（照合母体・出題素材）。credibility 降順を
// 優先し、粗く多めに取ってから JS で並べ替える（埋め込み列 feeds.credibility は order で直接使え
// ないため）。category=null は「おまかせ」で、tag で絞らず新着から取る。
async function loadCategoryArticles(
  supabase: SupabaseClient,
  category: TagSlug | null,
  limit: number,
): Promise<ArticleRow[]> {
  // select は変数連結で非リテラルにする（埋め込み join の select 文字列リテラルを TS に深くパース
  // させると TS2589「型のインスタンス化が深すぎる」になるため）。
  const cols = "id, title, content_html, feeds(credibility)";
  // category 指定と「おまかせ」で別クエリにする（builder の union を避けて型を単純化）。
  const { data, error } = category
    ? await supabase
        .from("articles")
        // article_tags を inner join して該当カテゴリの記事だけに絞る。
        .select(`${cols}, article_tags!inner(tag_slug)`)
        .eq("article_tags.tag_slug", category)
        .not("content_html", "is", null)
        .limit(limit * 3)
    : await supabase
        .from("articles")
        .select(cols)
        .not("content_html", "is", null)
        .order("published_at", { ascending: false, nullsFirst: false })
        .limit(limit * 2);

  if (error) throw error;
  const rows = (data ?? []) as unknown as ArticleRow[];

  // credibility 降順（null は最低扱い）→ 上限件数へ。信頼度の高い記事から素材にする。
  rows.sort((a, b) => (b.feeds?.credibility ?? 0) - (a.feeds?.credibility ?? 0));
  return rows.slice(0, limit);
}

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

// 生成 MCQ を決定的に検証して insert 行へ変換する（1 記事ぶん）。form → concept → grounding の順。
function gateMCQs(
  mcqs: GeneratedMCQ[],
  groundBodyNorm: string,
  articleId: string,
  fallbackCategory: TagSlug,
  limit: number,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const q of mcqs) {
    if (rows.length >= limit) break;

    // ① concept 正規化（空 slug＝正規化不能は捨てる）。
    const conceptKey = conceptSlug(q.concept_label);
    if (!conceptKey) continue;

    // ② grounding 逐語照合（設問本体＝stem＋選択肢との関連も見る）。失敗は捨てる。
    const target = `${q.stem} ${q.choices.join(" ")}`;
    if (!isQuoteGrounded(q.source_quote, groundBodyNorm, target)) continue;

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
      source_ref: articleId,
      // embedding / dup_flag は MVP 未設定（YAT-29 の cron が dedup で埋める）。
      status: "active",
    });
  }
  return rows;
}

// カテゴリの記事から count 問を目標にオンデマンド生成し、通過分を quiz_questions へ積んで返す。
export async function generateQuizForCategory(
  supabase: SupabaseClient,
  opts: {
    category: TagSlug | null; // null = おまかせ
    count: number; // 目標生成数（不足分トップアップの必要数）
    generator?: QuizGenerator | null;
  },
): Promise<QuizGenResult> {
  const generator =
    opts.generator !== undefined ? opts.generator : createQuizGenerator();
  const result: QuizGenResult = {
    requested: opts.count,
    generated: 0,
    passed: 0,
    inserted: [],
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

  let articles: ArticleRow[];
  let existingConcepts: string[];
  try {
    articles = await loadCategoryArticles(supabase, opts.category, CANDIDATE_ARTICLES);
    existingConcepts = await loadExistingConcepts(supabase);
  } catch (e) {
    console.warn("クイズ生成の素材取得に失敗:", e);
    return result;
  }
  if (articles.length === 0) return result;

  const rows: Record<string, unknown>[] = [];
  // 記事単位の fail-soft ループ（直列）。必要数に達したら打ち切る。
  for (const article of articles) {
    if (rows.length >= opts.count) break;
    try {
      const rawBody = htmlToInputText(article.content_html, GROUND_BODY_MAX_CHARS);
      if (!rawBody) continue;
      const groundBody = norm(rawBody);

      const remaining = opts.count - rows.length;
      const mcqs = await generator.generate({
        title: article.title,
        articleText: rawBody,
        categoryLabel,
        count: Math.min(remaining, MAX_MCQ_PER_ARTICLE),
        existingConcepts,
      });
      result.generated += mcqs.length;

      const passed = gateMCQs(mcqs, groundBody, article.id, fallbackCategory, remaining);
      result.passed += passed.length;
      rows.push(...passed);
    } catch (e) {
      console.warn(`クイズ生成に失敗 [${article.id}]:`, e);
    }
  }

  if (rows.length === 0) return result;

  const { data, error } = await supabase
    .from("quiz_questions")
    .insert(rows)
    .select(
      "id, concept_key, concept_label, category, difficulty, stem, choices, answer_index, explanation, source_quote, grounded, source_ref",
    );
  if (error) {
    console.warn("quiz_questions への登録に失敗:", error);
    return result;
  }
  result.inserted = (data ?? []) as unknown as QuizQuestion[];
  return result;
}
