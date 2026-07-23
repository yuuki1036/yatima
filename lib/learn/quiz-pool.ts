import type { SupabaseClient } from "@supabase/supabase-js";
import { createEmbedder, type Embedder } from "@/lib/llm/embed";
import { embedMissingQuizQuestions } from "@/lib/rss/embed";
import { createQuizGenerator } from "@/lib/llm/generate-quiz";
import { TAG_LEAVES, type TagSlug } from "@/lib/tags/vocabulary";
import {
  embedAndDedupQuizRows,
  generateGatedQuizRows,
  insertQuizRows,
  type QuizInsertRow,
} from "@/lib/learn/quiz-gate";
import { hasApprovedLearnSources } from "@/lib/learn/learn-sources";

// YAT-29: 適応クイズのコアプール生成 cron。カテゴリ別の active プール深度を目標値まで満たすよう
// 不足分（deficit）だけ生成し、その場 embed → 既存 active プール＋バッチ内既採用との cosine dedup
// を通してから quiz_questions(active) へ積む。オンデマンド（quiz-gate の generateQuizForCategory）
// はプール不足時のトップアップに縮退する。card-gate.ts の runCardGate（母集団照合→その場 embed→
// dedup→bulk insert）を雛形に、生成コアと dedup は quiz-gate と共有する。
// YAT-61: dedup は skip 方式（近重複を insert しない）から dup_flag 方式（insert してフラグを立て、
// 出題プールから外す）へ変更。skip では弾いた候補が DB に残らず閾値を較正できなかったため
// （0011_quiz.sql の「cron が dup_flag を立てる」という当初想定に戻した形）。
// これに伴い deficit の充足数え（countActive）と出題プール取得（selectSessionQuestions）の双方が
// dup_flag=false で絞る。

// 保守的な起点値（tunable）。予算根拠は下記コメント参照。Voyage 無料枠 3 RPM / 10K TPM・cron の
// timeout 20 分に収める。支払い登録でレート緩和されたら上げてよい。
const POOL_TARGET_PER_CATEGORY = 12; // カテゴリ別 active プールの目標深度（QUIZ_SESSION_SIZE×約2.4セッション分）
const MAX_NEW_PER_CATEGORY = 6; // 1 run のカテゴリ別生成上限（LLM 呼び出し数を抑える）
const MAX_NEW_PER_RUN = 24; // 1 run の総候補上限（Voyage の embed 量と timeout に効く）
const CRON_CANDIDATE_SOURCES = 4; // cron の素材ソース上限（オンデマンドの 8 より絞る＝呼び出し数上限）
const BACKFILL_EMBED_LIMIT = 12; // オンデマンド由来の embedding=null 行の後追い補完件数
// バックフィルが実際に Voyage を叩いた回のみ、候補 embed との間に挟む保険（embed() 呼び出し"間"は
// レート制御外のため）。succeeded ではなく「叩いたか」で判定する（全チャンク失敗でもリクエストは飛ぶ）。
const INTER_EMBED_SLEEP_MS = 21_000;

// cron の対象カテゴリ = tech/* leaf（オンデマンドの parseQuizCategory が tech/* のみ許すため、
// おまかせも tech プールで賄える）。
const CRON_CATEGORIES: TagSlug[] = TAG_LEAVES.filter(
  (t) => t.parent === "tech",
).map((t) => t.slug);

export type QuizPoolResult = {
  deficitCategories: number; // 不足があり生成対象にしたカテゴリ数
  generated: number; // LLM が返した候補総数
  passed: number; // 形式＋grounding を通過した候補数
  dupFlagged: number; // dedup で近重複として dup_flag を立てた数（insert はされるが出題しない）
  inserted: number; // quiz_questions へ insert した数
  embedFailed: number; // その場 embed に失敗し embedding=null で積んだ数
  backfill: { picked: number; succeeded: number; skipped: boolean }; // 補完 embed の結果
  skipped: boolean; // ANTHROPIC_API_KEY 未設定で生成スキップ
};

// 出題可能な active 件数を数える（head:true で行本体は取らない軽量 count）。category=null は全カテゴリ合算。
// YAT-61: dup_flag=true を除く。selectSessionQuestions が出題しない行を deficit の充足に数えると、
// 近重複が積まれるほどプールが満ちたと誤認して補充が止まり、出題可能な問題が枯れる。
// 「数える母集団」と「出題する母集団」は同じ条件で引くこと。
// 失敗は 0 扱い＝deficit を大きく見積もって生成側に倒す（プールが空に見えても生成上限で頭打ちに
// なるため安全）。
async function countActive(
  supabase: SupabaseClient,
  category: TagSlug | null,
): Promise<number> {
  let query = supabase
    .from("quiz_questions")
    .select("id", { count: "exact", head: true })
    .eq("status", "active")
    .eq("dup_flag", false);
  if (category) query = query.eq("category", category);
  const { count, error } = await query;
  if (error) {
    console.warn(`active 件数の取得に失敗 [${category ?? "all"}]:`, error);
    return 0;
  }
  return count ?? 0;
}

// プール目標に対する不足数を返す（0 以上）。セッション開始の裏補充（after）が目標を超えて生成しない
// よう gate する用途（YAT-31）。カテゴリ指定はそのカテゴリの目標、おまかせ(null)は cron 対象カテゴリ
// 合算の目標で測る。cron の deficit と同義（active < target なら補充）。これにより「短いセッション」の
// 原因が SRS クールダウン（正解済みが eligible から外れる）のときは deficit=0 で補充が発火せず、
// プールが POOL_TARGET を超えて青天井に増殖するのを防ぐ。
export async function quizPoolDeficit(
  supabase: SupabaseClient,
  category: TagSlug | null,
): Promise<number> {
  const target = category
    ? POOL_TARGET_PER_CATEGORY
    : POOL_TARGET_PER_CATEGORY * CRON_CATEGORIES.length;
  const active = await countActive(supabase, category);
  return Math.max(0, target - active);
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
    dupFlagged: 0,
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
    // 在庫ゲート（YAT-32）: 承認済みソースが無いカテゴリは生成しても素材が無く空振りなので skip。
    // deficit にも数えない（埋めようがない不足なので cron ログを汚さない。/learn がソース登録を促す）。
    if (!(await hasApprovedLearnSources(supabase, category))) continue;
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
      maxSources: CRON_CANDIDATE_SOURCES,
    });
    result.generated += core.generated;
    result.passed += core.passed;
    candidates.push(...core.rows);
  }

  if (candidates.length === 0) return result;

  // ③④⑤ embed → dedup（quiz-gate の共有ヘルパ。オンデマンド経路と同一実装を通す）。
  // 直前のバックフィルが実際に Voyage を叩いた回だけ、候補 embed との間に保険の sleep を挟む
  // （embed() 呼び出し"間"はレート制御外のため）。succeeded ではなく「叩いたか」で判定する。
  const deduped = await embedAndDedupQuizRows(supabase, candidates, {
    embedder,
    sleepBeforeEmbedMs:
      backfill.picked > 0 && !backfill.skipped ? INTER_EMBED_SLEEP_MS : 0,
  });
  result.dupFlagged = deduped.dupFlagged;
  result.embedFailed = deduped.embedFailed;
  const rows = deduped.rows;

  // ⑥ 一括 insert（全行に embedding キーを付与済み＝PostgREST の bulk insert のキー整合を満たす）。
  const inserted = await insertQuizRows(supabase, rows);
  result.inserted = inserted.length;

  return result;
}
