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
// 出題プールから外す）へ変更。skip では弾いた候補が DB に残らず閾値を較正できなかったため。
// 0011_quiz.sql が予約したまま使われていなかった dup_flag 列をここで使い始める（当初想定は
// 「cron が後追いで立てる」だったが、実際は cron / オンデマンドの両経路が insert 時に立てる）。
// これに伴い deficit の充足数え（countActive）と出題プール取得（selectSessionQuestions）の双方が
// dup_flag=false で絞る。

// 保守的な起点値（tunable）。予算根拠は下記コメント参照。Voyage 無料枠 3 RPM / 10K TPM・cron の
// timeout 20 分に収める。支払い登録でレート緩和されたら上げてよい。
// YAT-72: 目標は「持っている数」ではなく「まだ解いていない数」で測る（countUnseen 参照）。
// 6 = QUIZ_SESSION_SIZE(5) をやや上回る＝解き切っても常に 1 セッション分は新作が残る、が狙い。
// 旧 POOL_TARGET_PER_CATEGORY=12 は active 総数の目標で、回答済みが在庫を占めて生成が止まっていた。
const UNSEEN_TARGET_PER_CATEGORY = 6;
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
  // YAT-63: VOYAGE_API_KEY 未設定で embed を呼ばなかった（embedFailed の全件がこれ）。backfill 側は
  // 元から skipped でこれを判別していたのに、候補 embed 側は判別がなく embed失敗=N に潰れていた。
  embedSkipped: boolean;
  backfill: { picked: number; succeeded: number; skipped: boolean }; // 補完 embed の結果
  skipped: boolean; // ANTHROPIC_API_KEY 未設定で生成スキップ
};

// PostgREST の db-max-rows（既定 1000）は .limit() を上書きするため、全件走査は必ず .range() で
// ページングする（knowledge supabase-range-pagination-needs-unique-sort / YAT-67 で実際に踏んだ罠）。
const PAGE = 1000;
const FETCH_CAP = 50_000; // 安全弁。到達時のみ警告（1 ページ上限より十分大きい実値で判定する）

// id 昇順で全件を取り切る。id は PK＝ユニークなので全順序が確定し、境界での取りこぼしが無い。
async function fetchAllIds(
  build: (from: number, to: number) => PromiseLike<{
    data: { id: string }[] | null;
    error: unknown;
  }>,
  label: string,
): Promise<string[] | null> {
  const ids: string[] = [];
  for (let from = 0; from < FETCH_CAP; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) {
      console.warn(`${label} の取得に失敗:`, error);
      return null;
    }
    const batch = data ?? [];
    ids.push(...batch.map((r) => r.id));
    if (batch.length < PAGE) return ids;
  }
  console.warn(`${label} が FETCH_CAP(${FETCH_CAP}) に到達。以降を切り詰めた`);
  return ids;
}

// 一度でも回答された question_id の集合。
async function loadAnsweredQuestionIds(
  supabase: SupabaseClient,
): Promise<Set<string> | null> {
  const ids = await fetchAllIds(
    (from, to) =>
      supabase
        .from("quiz_attempts")
        .select("id:question_id")
        .not("question_id", "is", null)
        .order("question_id", { ascending: true })
        .range(from, to),
    "quiz_attempts",
  );
  return ids ? new Set(ids) : null;
}

// 「まだ一度も回答していない」出題可能設問の件数。category=null は全カテゴリ合算。
//
// YAT-72: 以前は active 件数（回答済みを含む）で充足を測っていた。設問は退役しないため、
// 一度そのカテゴリを解き切ると **回答済みだけで在庫が満ち、生成が永久に止まる**。
// 実際 tech/web は 12 問すべて回答済みで不足 0 と判定され、9 問がクールダウン中のため
// 出題可能な concept が 2 しか残らず、同じ設問が出続けていた。
// 在庫（持っている数）ではなく流量（まだ解いていない数）で測る。
//
// 失敗は 0 扱い＝deficit を大きく見積もって生成側に倒す（生成上限で頭打ちになるため安全）。
async function countUnseen(
  supabase: SupabaseClient,
  category: TagSlug | null,
): Promise<number> {
  const answered = await loadAnsweredQuestionIds(supabase);
  if (!answered) return 0;

  const ids = await fetchAllIds((from, to) => {
    let q = supabase
      .from("quiz_questions")
      .select("id")
      .eq("status", "active")
      // YAT-61: dup_flag=true を除く。selectSessionQuestions が出題しない行を充足に数えると、
      // 近重複が積まれるほど満ちたと誤認して補充が止まる。
      // 「数える母集団」と「出題する母集団」は同じ条件で引くこと。
      .eq("dup_flag", false);
    if (category) q = q.eq("category", category);
    return q.order("id", { ascending: true }).range(from, to);
  }, `quiz_questions[${category ?? "all"}]`);
  if (!ids) return 0;

  return ids.filter((id) => !answered.has(id)).length;
}

// 未回答バッファの目標に対する不足数を返す（0 以上）。セッション開始の裏補充（after）が目標を超えて
// 生成しないよう gate する用途（YAT-31）。カテゴリ指定はそのカテゴリの目標、おまかせ(null)は cron
// 対象カテゴリ合算の目標で測る。cron の deficit と同義（未回答 < target なら補充）。
//
// YAT-72 でこの gate の意味が変わった点に注意。以前は「短いセッションの原因が SRS クールダウンなら
// 補充しない」ためのものだったが、その判定は active 総数で行われており、**解き切った状態と
// クールダウン中の状態を区別できていなかった**。未回答で測れば両者が分かれる:
// 未回答が残っているのに短い＝クールダウンが原因（補充しない）／未回答ゼロで短い＝素材切れ（補充する）。
export async function quizPoolDeficit(
  supabase: SupabaseClient,
  category: TagSlug | null,
): Promise<number> {
  const target = category
    ? UNSEEN_TARGET_PER_CATEGORY
    : UNSEEN_TARGET_PER_CATEGORY * CRON_CATEGORIES.length;
  const unseen = await countUnseen(supabase, category);
  return Math.max(0, target - unseen);
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
    embedSkipped: false,
    backfill: { picked: 0, succeeded: 0, skipped: false },
    skipped: false,
  };

  // API キー未設定 → 生成スキップ（cron は成功扱い）。
  if (!generator) {
    result.skipped = true;
    return result;
  }

  // ① バックフィル: その場 embed に失敗して embedding=null で積まれた行を先に埋め、今回の dedup
  // 母集団に載せる（Voyage 呼び出し 1 回目）。active のみ対象。YAT-56 以降は両経路が insert 前に
  // embed するので、ここに残るのは embed 失敗分だけ（オンデマンド由来という帰属はもう成立しない）。
  // なお backfill は embedding を埋めるだけで dup 判定はやり直さないため、これらの行は
  // dup_flag=false のまま出題プールに残る（安全側）。
  const backfill = await embedMissingQuizQuestions(supabase, {
    limit: BACKFILL_EMBED_LIMIT,
    embedder,
  });
  result.backfill = {
    picked: backfill.picked,
    succeeded: backfill.succeeded,
    skipped: backfill.skipped,
  };

  // ② deficit ベース生成: カテゴリ別の**未回答**件数を数え、目標への不足分だけ生成する（YAT-72）。
  // 未回答バッファが満ちたカテゴリは生成ゼロ（cron が無作業に収束）。解き進めた分だけ不足が開くので、
  // 使えば使うほど補充される＝在庫でなく流量になる。総候補は MAX_NEW_PER_RUN で頭打ち。
  const candidates: QuizInsertRow[] = [];
  for (const category of CRON_CATEGORIES) {
    if (candidates.length >= MAX_NEW_PER_RUN) break;
    const unseen = await countUnseen(supabase, category);
    const deficit = UNSEEN_TARGET_PER_CATEGORY - unseen;
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
  result.embedSkipped = deduped.embedSkipped;
  const rows = deduped.rows;

  // ⑥ 一括 insert（全行に embedding キーを付与済み＝PostgREST の bulk insert のキー整合を満たす）。
  const inserted = await insertQuizRows(supabase, rows);
  result.inserted = inserted.length;

  return result;
}
