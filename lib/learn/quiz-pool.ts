import type { SupabaseClient } from "@supabase/supabase-js";
import { createEmbedder, type Embedder } from "@/lib/llm/embed";
import {
  vecToPg,
  quizQuestionEmbedText,
  embedMissingQuizQuestions,
} from "@/lib/rss/embed";
import { cosineSim, parseEmbedding, QUIZ_DEDUP_THRESHOLD } from "@/lib/ranking/dedup";
import { createQuizGenerator } from "@/lib/llm/generate-quiz";
import { TAG_LEAVES, type TagSlug } from "@/lib/tags/vocabulary";
import {
  generateGatedQuizRows,
  insertQuizRows,
  type QuizInsertRow,
} from "@/lib/learn/quiz-gate";

// YAT-29: 適応クイズのコアプール生成 cron。カテゴリ別の active プール深度を目標値まで満たすよう
// 不足分（deficit）だけ生成し、その場 embed → 既存 active プール＋バッチ内既採用との cosine dedup
// を通してから quiz_questions(active) へ積む。オンデマンド（quiz-gate の generateQuizForCategory）
// はプール不足時のトップアップに縮退する。card-gate.ts の runCardGate（母集団照合→その場 embed→
// dedup→bulk insert）を雛形に、生成コアは quiz-gate と共有する（decision: skip 方式。dup_flag では
// なく近重複を insert しない＝selectSessionQuestions が dup_flag を見ないため。
// supabase/migrations/0011_quiz.sql の「cron が dup_flag を立てる」コメントとは方式が異なる）。

// 保守的な起点値（tunable）。予算根拠は下記コメント参照。Voyage 無料枠 3 RPM / 10K TPM・cron の
// timeout 20 分に収める。支払い登録でレート緩和されたら上げてよい。
const POOL_TARGET_PER_CATEGORY = 12; // カテゴリ別 active プールの目標深度（QUIZ_SESSION_SIZE×約2.4セッション分）
const MAX_NEW_PER_CATEGORY = 6; // 1 run のカテゴリ別生成上限（LLM 呼び出し数を抑える）
const MAX_NEW_PER_RUN = 24; // 1 run の総候補上限（Voyage の embed 量と timeout に効く）
const CRON_CANDIDATE_ARTICLES = 4; // cron の素材記事上限（オンデマンドの 8 より絞る＝呼び出し数上限）
const BACKFILL_EMBED_LIMIT = 12; // オンデマンド由来の embedding=null 行の後追い補完件数
// バックフィルが実際に Voyage を叩いた回のみ、候補 embed との間に挟む保険（embed() 呼び出し"間"は
// レート制御外のため）。succeeded ではなく「叩いたか」で判定する（全チャンク失敗でもリクエストは飛ぶ）。
const INTER_EMBED_SLEEP_MS = 21_000;

// dedup 母集団の全件ページ取得の 1 ページ上限（PostgREST 既定。card-gate と同値）。
const SELECT_PAGE = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// cron の対象カテゴリ = tech/* leaf（オンデマンドの parseQuizCategory が tech/* のみ許すため、
// おまかせも tech プールで賄える）。
const CRON_CATEGORIES: TagSlug[] = TAG_LEAVES.filter(
  (t) => t.parent === "tech",
).map((t) => t.slug);

export type QuizPoolResult = {
  deficitCategories: number; // 不足があり生成対象にしたカテゴリ数
  generated: number; // LLM が返した候補総数
  passed: number; // 形式＋grounding を通過した候補数
  dupSkipped: number; // dedup で近重複として捨てた数
  inserted: number; // quiz_questions へ insert した数
  embedFailed: number; // その場 embed に失敗し embedding=null で積んだ数
  backfill: { picked: number; succeeded: number; skipped: boolean }; // 補完 embed の結果
  skipped: boolean; // ANTHROPIC_API_KEY 未設定で生成スキップ
};

// active かつ embedding 持ちの quiz_questions の embedding 列を全件ページ取得して dedup 母集団にする。
// 取得失敗は fail-soft で空母集団に倒す（＝この回は dedup が効かないだけ）。
// deficit 収束により active プールは POOL_TARGET_PER_CATEGORY×カテゴリ数（≈100 問）に頭打ちするため
// 全件で足りる。POOL_TARGET を大幅に上げる／retire 運用を止める場合は母集団を窓（直近 N 件）で切ること。
async function loadQuizDedupPopulation(
  supabase: SupabaseClient,
): Promise<number[][]> {
  const vecs: number[][] = [];
  try {
    for (let from = 0; ; from += SELECT_PAGE) {
      const { data, error } = await supabase
        .from("quiz_questions")
        .select("embedding")
        .eq("status", "active")
        .not("embedding", "is", null)
        // id を二次キーにしてページ境界の取りこぼし/重複を防ぐ（card-gate と同じ作法）。
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, from + SELECT_PAGE - 1);
      if (error) throw error;
      const batch = (data ?? []) as unknown as Record<string, unknown>[];
      for (const r of batch) {
        const v = parseEmbedding(r.embedding);
        if (v) vecs.push(v);
      }
      if (batch.length < SELECT_PAGE) break;
    }
  } catch (e) {
    console.warn("クイズ dedup 母集団の取得に失敗（空母集団で続行）:", e);
    return [];
  }
  return vecs;
}

// カテゴリの active 件数を数える（head:true で行本体は取らない軽量 count）。失敗は 0 扱い＝
// deficit を大きく見積もって生成側に倒す（プールが空に見えても生成上限で頭打ちになるため安全）。
async function countActive(
  supabase: SupabaseClient,
  category: TagSlug,
): Promise<number> {
  const { count, error } = await supabase
    .from("quiz_questions")
    .select("id", { count: "exact", head: true })
    .eq("status", "active")
    .eq("category", category);
  if (error) {
    console.warn(`active 件数の取得に失敗 [${category}]:`, error);
    return 0;
  }
  return count ?? 0;
}

// コアプール生成の本体。
export async function runQuizPool(
  supabase: SupabaseClient,
  opts: {
    generator?: ReturnType<typeof createQuizGenerator>;
    embedder?: Embedder | null;
  } = {},
): Promise<QuizPoolResult> {
  const generator =
    opts.generator !== undefined ? opts.generator : createQuizGenerator();
  const embedder =
    opts.embedder !== undefined ? opts.embedder : createEmbedder();

  const result: QuizPoolResult = {
    deficitCategories: 0,
    generated: 0,
    passed: 0,
    dupSkipped: 0,
    inserted: 0,
    embedFailed: 0,
    backfill: { picked: 0, succeeded: 0, skipped: false },
    skipped: false,
  };

  // API キー未設定 → 生成スキップ（cron は成功扱い）。
  if (!generator) {
    result.skipped = true;
    return result;
  }

  // ① バックフィル: 先週以降のオンデマンド生成分（embedding=null）を先に埋め、今回の dedup 母集団に
  // 載せる（Voyage 呼び出し 1 回目）。active のみ対象。
  const backfill = await embedMissingQuizQuestions(supabase, {
    limit: BACKFILL_EMBED_LIMIT,
    embedder,
  });
  result.backfill = {
    picked: backfill.picked,
    succeeded: backfill.succeeded,
    skipped: backfill.skipped,
  };

  // ② deficit ベース生成: カテゴリ別 active 件数を数え、目標深度への不足分だけ生成する。
  // プールが満ちたカテゴリは生成ゼロ（cron が無作業に収束）。総候補は MAX_NEW_PER_RUN で頭打ち。
  const candidates: QuizInsertRow[] = [];
  for (const category of CRON_CATEGORIES) {
    if (candidates.length >= MAX_NEW_PER_RUN) break;
    const active = await countActive(supabase, category);
    const deficit = POOL_TARGET_PER_CATEGORY - active;
    if (deficit <= 0) continue;
    result.deficitCategories += 1;

    const count = Math.min(
      deficit,
      MAX_NEW_PER_CATEGORY,
      MAX_NEW_PER_RUN - candidates.length,
    );
    const core = await generateGatedQuizRows(supabase, {
      category,
      count,
      generator,
      maxArticles: CRON_CANDIDATE_ARTICLES,
    });
    result.generated += core.generated;
    result.passed += core.passed;
    candidates.push(...core.rows);
  }

  if (candidates.length === 0) return result;

  // ③ dedup 母集団を読み込む（②のバックフィル分も DB に反映済みなので拾える）。
  const population = await loadQuizDedupPopulation(supabase);

  // ④ 候補を 1 回の embed() でまとめて埋める（Voyage 呼び出し 2 回目）。呼び出し"間"は 21s 保険。
  let vectors: (number[] | null)[] = candidates.map(() => null);
  if (embedder) {
    if (backfill.picked > 0 && !backfill.skipped) await sleep(INTER_EMBED_SLEEP_MS);
    try {
      // row は QuizInsertRow 型なのでキャストなしで embed テキストを組める（quizQuestionEmbedText の
      // 構造的型を満たす）。フィールド改名は gateMCQs 側でコンパイルエラーになり静かに壊れない。
      vectors = await embedder.embed(
        candidates.map((row) => quizQuestionEmbedText(row)),
      );
    } catch (e) {
      console.warn("候補クイズの embed に失敗（embedding=null で積む）:", e);
    }
  }

  // ⑤ dedup: 既存母集団＋バッチ内既採用と cosine 照合。閾値超えは skip（insert しない）。
  // embed 失敗（null）は embedding=null で積み、次回バックフィルが埋めて以降の母集団に乗せる。
  const rows: QuizInsertRow[] = [];
  candidates.forEach((row, i) => {
    const vec = vectors[i];
    if (vec) {
      let maxSim = 0;
      for (const p of population) {
        const sim = cosineSim(vec, p);
        if (sim > maxSim) maxSim = sim;
      }
      if (maxSim >= QUIZ_DEDUP_THRESHOLD) {
        result.dupSkipped += 1;
        return;
      }
      population.push(vec); // 同一 run の後続候補ともダブらせない
      rows.push({ ...row, embedding: vecToPg(vec) });
    } else {
      result.embedFailed += 1;
      rows.push({ ...row, embedding: null });
    }
  });

  // ⑥ 一括 insert（全行に embedding キーを付与済み＝PostgREST の bulk insert のキー整合を満たす）。
  const inserted = await insertQuizRows(supabase, rows);
  result.inserted = inserted.length;

  return result;
}
