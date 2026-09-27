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
import { cosineSim, parseEmbedding, QUIZ_DEDUP_THRESHOLD } from "@/lib/ranking/dedup";
import { vecToPg, quizQuestionEmbedText } from "@/lib/rss/embed";
import { createEmbedder, type Embedder } from "@/lib/llm/embed";
import type { QuizDifficulty, QuizQuestion } from "@/lib/types";

// quiz_questions への insert 行（gateMCQs が積み、cron/オンデマンドが insert する）。名前付き型に
// することで、キー改名や欠落をコンパイルで検出する（card-gate が GeneratedCard を持ち回って得ていた
// 型保証を、Record<string, unknown> の引き回しで手放さないため）。
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
  embedding?: string | null; // vecToPg 済み文字列。embedAndDedupQuizRows が付与する
  dup_flag?: boolean; // 近重複か（YAT-61。出題プールからは外れるが行は残る）
  dup_similarity?: number | null; // 最も近い既存問題との cosine。閾値較正の標本
};

// YAT-27: 適応クイズの生成ゲート。素材から MCQ を生成し、決定的に検証（形式 → concept 正規化 →
// 逐語 grounding）してから quiz_questions(active) へ積む。card-gate.ts の「母集団取得 → 生成 → 形式
// → grounding → dedup → insert」構造を選択式に写したもの。照合失敗の問題は捨てる。
// YAT-56: dedup は cron 専属をやめ、オンデマンドも同じ embedAndDedupQuizRows を通す（after() の
// 中で走るためユーザーは待たない）。YAT-61: その dedup は skip から dup_flag 方式へ。
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
  inserted: QuizQuestion[]; // quiz_questions へ積んだ問題（dup_flag=true の行も含む）
  dupFlagged: number; // うち近重複として dup_flag を立てた数（出題プールには乗らない）
  // YAT-63: embed に失敗し embedding=null で積んだ数。この行は dup 判定を受けないまま出題プールに入り、
  // 次の cron で backfill が embedding を埋めた後に rejudgeUnjudgedQuizRows が判定する（YAT-82 までは
  // 判定をやり直さず、近重複でも残り続けた）。embed 失敗そのものは quiz-gate:embedAndDedupQuizRows と llm/embed の
  // チャンク失敗が元から warn を出していたので、ここで新たに得られるのは**件数**（何問が dup 未判定で
  // プールに入ったか）であって、失敗の検知自体ではない。cron は QuizPoolResult.embedFailed で
  // 持っていたが、オンデマンドは受け取っておきながら捨てていたため揃える。
  embedFailed: number;
  embedSkipped: boolean; // VOYAGE_API_KEY 未設定で embed を呼ばなかった（embedFailed の全件がこれ）
  skipped: boolean; // ANTHROPIC_API_KEY 未設定でスキップ
};

// ── 同一ソースからの再生成を避ける（YAT-82）───────────────────────
// 生成はソースごとに同じ本文を LLM に渡すので、既出を知らせないと毎回ほぼ同じ設問が返り、dedup で
// dup_flag が立つだけで未回答が増えない（09-21 の cron は 9 問中 8 問が dup）。既出の設問を渡して
// 別の論点へ向かわせる。件数と長さはプロンプト長の上限（1 ソース ≈ 30 × 120 字）。
const AVOID_STEMS_PER_SOURCE = 30;
const AVOID_STEM_MAX_CHARS = 120;

// ソースから作成済みの設問（新しい順）。dup 行も含める＝「既に作った」事実は dup でも変わらない。
// 失敗は空で続行（既出提示は再生成を減らすための補助で、無くても生成自体は成立する）。
async function loadSourceStems(
  supabase: SupabaseClient,
  sourceId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("quiz_questions")
    .select("stem")
    .eq("source_ref", sourceId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(AVOID_STEMS_PER_SOURCE);
  if (error) {
    console.warn(`既出設問の取得に失敗 [${sourceId}]（既出提示なしで続行）:`, error);
    return [];
  }
  return (data ?? []).map((r) => (r.stem as string).slice(0, AVOID_STEM_MAX_CHARS));
}

// 本文が照合母体の上限より長いとき、どこを読ませるかを選ぶ（pure。rng 注入でテスト可能）。
// 以前は常に先頭 GROUND_BODY_MAX_CHARS 字だけを渡しており、9.3 万字ある CUDA ガイドでも
// 冒頭 2 万字（スレッド階層の章）からしか出題されず、同じ設問の再生成が続いた。
// 開始位置をランダムにずらし、長いソースの後半も素材にする。語の途中から始めないよう直後の空白へ寄せる
// （窓の先頭の断片語は逐語照合の母体に残っても害は無いが、LLM に渡す文として不自然なため）。
export function pickBodyWindow(
  text: string,
  maxChars: number,
  rng: () => number,
): string {
  if (text.length <= maxChars) return text;
  let start = Math.floor(rng() * (text.length - maxChars + 1));
  if (start > 0) {
    const sp = text.indexOf(" ", start);
    if (sp !== -1 && sp - start < 200) start = sp + 1;
  }
  return text.slice(start, start + maxChars).trim();
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

// ── 選択肢の決定的シャッフル（YAT-43）─────────────────────────────
// LLM は正解を先頭付近の選択肢に置きがち（few-shot のアンカーや先頭選好で index が偏る）。生成後に
// 決定的に並べ替えて answer_index の偏りを消す。seed を concept_key+stem
// から導くので「同一問題は常に同一配置」＝再現可能・テスト可能。grounding 照合（順序非依存）の後・
// insert 前に一度だけ適用する（[[llm-card-grounding-deterministic-filter]] の決定的後処理パターン）。

// FNV-1a で文字列 → 32bit seed。
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32: seed から決定的な [0,1) 乱数列を生成する軽量 PRNG。
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// シャッフル seed。concept_key と stem を区切って連結する。区切りは U+0000（両者の境界が
// 本文に現れないようにするため）だが、**エスケープ表記で書くこと**。実バイトの NUL を
// ソースに置くと file(1) がこのファイルをバイナリ判定し、grep -r が黙ってスキップする
// （実際に踏んだ: 使用箇所の全 grep で quiz-gate.ts だけ取りこぼした）。
// 移行 script（reshuffle-quiz-choices）と同じ seed を使うため export する。
export function choiceShuffleSeed(conceptKey: string, stem: string): number {
  return hashSeed(`${conceptKey}\u0000${stem}`);
}

// choices を決定的にシャッフルし、正解の新しい位置を返す。インデックス配列を Fisher–Yates で
// 並べ替えて写像を作るため、重複選択肢があっても正解位置が一意に決まる（indexOf の最初一致に倒れない）。
// 既存問題の再シャッフル（YAT-62 の移行 script）が同じ実装を使えるよう export する。
export function shuffleChoices(
  choices: string[],
  answerIndex: number,
  seed: number,
): { choices: string[]; answerIndex: number } {
  const rng = mulberry32(seed);
  const order = choices.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return {
    choices: order.map((oi) => choices[oi]),
    answerIndex: order.indexOf(answerIndex),
  };
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
    // 選択肢を決定的にシャッフルして answer_index の偏りを消す（LLM は正解を先頭に置きがち）。
    const shuffled = shuffleChoices(
      q.choices,
      q.answer_index,
      choiceShuffleSeed(conceptKey, q.stem),
    );
    rows.push({
      concept_key: conceptKey,
      concept_label: q.concept_label,
      category,
      difficulty: q.difficulty,
      stem: q.stem,
      choices: shuffled.choices,
      answer_index: shuffled.answerIndex,
      explanation: q.explanation,
      source_quote: q.source_quote,
      grounded: true,
      source_ref: sourceId, // learn_sources.id（YAT-32。旧: article_id）
      // embedding / dup_flag / dup_similarity は embedAndDedupQuizRows が付与する（両経路が通る）。
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
  rows: QuizInsertRow[]; // 候補行（embedding / dup_flag は未設定＝embedAndDedupQuizRows が付与する）
  skipped: boolean; // ANTHROPIC_API_KEY 未設定でスキップ
};

// 生成コア: 素材取得（承認済み learn_sources）→ LLM 生成 → 形式検証 → concept 正規化 → grounding
// 逐語照合まで。DB 書き込みはしない（候補行の生産に専念）。オンデマンド（generateQuizForCategory）と
// cron（quiz-pool）が共有する。embed / dedup / insert の組み立ては呼び側に委ねる（cron だけが
// バックフィルと sleep 制御を前段に挟むため。dedup 自体は YAT-56 以降どちらも同じ実装を通る）。
// 素材が 0 件（ソース未登録カテゴリ）なら生成せず空で返る。
export async function generateGatedQuizRows(
  supabase: SupabaseClient,
  opts: {
    category: TagSlug | null; // null = おまかせ
    count: number; // 目標生成数
    generator?: QuizGenerator | null;
    maxSources?: number; // 素材ソースの上限（cron は絞って LLM 呼び出し数を抑える）
    rng?: () => number; // 本文窓の選択（pickBodyWindow）。テストで固定する用
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
      // 照合母体（groundBody）は LLM に渡した窓そのものから作る（窓の外の文を quote しても落ちる）。
      const rawBody = pickBodyWindow(
        htmlToInputText(source.content_html, Number.POSITIVE_INFINITY),
        GROUND_BODY_MAX_CHARS,
        opts.rng ?? Math.random,
      );
      if (!rawBody) continue;
      const groundBody = norm(rawBody);

      const remaining = opts.count - result.rows.length;
      const mcqs = await generator.generate({
        title: source.title,
        articleText: rawBody,
        categoryLabel,
        count: Math.min(remaining, MAX_MCQ_PER_ARTICLE),
        existingConcepts,
        avoidStems: await loadSourceStems(supabase, source.id),
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

// dedup 母集団の全件ページ取得の 1 ページ上限（PostgREST 既定。card-gate と同値）。
const SELECT_PAGE = 1000;

// active プールの embedding を全件ロードして dedup 母集団にする。
// dup_flag=true の行も母集団に含める（keep-all。出題には出ないが「既に似た問題を持っている」事実は
// 変わらないので、除くと同じ近重複を何度も積む）。card-gate が dup_flag で絞らないのと同じ作法
// （quiz は retired を出題母集団から外すため status だけは絞る点が card と違う）。
// 取得失敗は fail-soft で空母集団に倒す（＝この回は dedup が効かないだけ）。
//
// **YAT-61 で母集団の有界性が失われた。** 旧 skip 方式では近重複が insert されず、active 行数＝
// 出題可能数だったため「deficit 収束により目標深度×カテゴリ数（≈100 問）で頭打ち」が成立し、
// それが全件ロードの根拠だった。dup_flag 方式では dup 行も active として残る一方、充足数え
// （YAT-72 以降は countUnseen）はそれを数えない（＝deficit を埋めない）ので、行数は頭打ちしない。
// **YAT-72 でこの傾向はさらに強まった**: 充足を未回答数で測るようになり、解いた分だけ deficit が
// 開くため、行数は使用量に比例して伸び続ける（在庫でなく流量。意図した挙動）。
// 増加ペースは週次 cron の MAX_NEW_PER_RUN=24 とセッション補充が上限なので緩やかだが、単調に増える。
// 較正が済んで dup_similarity の標本が不要になったら、dup 行の retire か母集団の窓（直近 N 件）
// 切りを入れること。全件ロードのまま放置すると O(候補数×母集団) の cosine が効いてくる。
export async function loadQuizDedupPopulation(
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

export type QuizDedupResult = {
  rows: QuizInsertRow[]; // insert する行（全候補。dup も dup_flag=true で含む）
  dupFlagged: number; // 近重複として dup_flag を立てた数
  embedFailed: number; // embed できず embedding=null で積む数
  // YAT-63: VOYAGE_API_KEY 未設定で embed を一度も呼ばなかった場合 true（このとき embedFailed は
  // 候補全件になる）。これが無いと「API 障害で失敗した」と「キーが無くて呼んでいない」が同じ
  // embedFailed=N に潰れ、ログの読み手が Voyage の障害を疑って設定漏れを見落とす。
  // EmbedBatchResult.skipped と同じ役割（cron の backfill 側は元からこれを判別していた）。
  embedSkipped: boolean;
};

// 候補行を母集団と cosine 照合し、dup_flag / dup_similarity / embedding を付与する。
// DB にも外部 API にも触らないので、この関数だけを直接ユニットテストできる（判定ロジックを
// embedAndDedupQuizRows から切り出した理由）。ただし population は書き換える（下記）。
// YAT-61: 閾値超えを **捨てず**に flag を立てて insert する（card-gate と同じ非破壊方式）。skip 方式は
// 弾いた候補が DB に一切残らず、閾値が厳しすぎて正当な設問を捨てていないかを判定する標本が原理的に
// 手に入らなかった（survivorship bias。YAT-56 の較正がこれに阻まれて差し戻し）。
//
// dup 判定された vec も population に積む（card と同じ keep-all）。積まないと母集団が閾値に依存して
// カスケードで変わり、閾値スイープを閾値ごとに回し直さないと件数が狂う
// （[[generated-sibling-dedup-threshold]]「skip 方式は閾値スイープの計算方法まで変える」）。
// keep-all にすることで各行の dup_similarity が閾値非依存の値になり、後から任意の閾値で数え直せる。
//
// population は破壊的に伸ばす（同一 run の後続候補ともダブらせるため）。呼び出し側は使い捨ての
// 配列を渡すこと。
export function markQuizDuplicates(
  candidates: QuizInsertRow[],
  vectors: (number[] | null)[],
  population: number[][],
): QuizDedupResult {
  // embedSkipped は embedder の有無を知る embedAndDedupQuizRows が上書きする（この関数は
  // ベクタ配列しか受け取らず、null が「失敗」か「呼んでいない」かを区別できない）。
  const result: QuizDedupResult = {
    rows: [],
    dupFlagged: 0,
    embedFailed: 0,
    embedSkipped: false,
  };
  candidates.forEach((row, i) => {
    const vec = vectors[i];
    if (!vec) {
      // embed 失敗は embedding=null・dup_flag=false・dup_similarity=null で積む。次の cron で backfill が
      // embedding を埋め、rejudgeUnjudgedQuizRows が判定する（それまでは出題プールに残る＝安全側）。
      // dup_similarity=null は再判定の対象を示す印なので、0 等に変えないこと（YAT-82）。
      result.embedFailed += 1;
      result.rows.push({ ...row, embedding: null, dup_flag: false, dup_similarity: null });
      return;
    }
    let maxSim = 0;
    for (const p of population) {
      // 次元不一致は cosineSim も 0 を返すので結果は変わらない（maxSim は 0 初期化＋ sim > maxSim で
      // 更新するため 0 は素通り）。1024 次元の内積を無駄に回さないための計算量対策にすぎない。
      if (p.length !== vec.length) continue;
      const sim = cosineSim(vec, p);
      if (sim > maxSim) maxSim = sim;
    }
    const dupFlag = maxSim >= QUIZ_DEDUP_THRESHOLD;
    if (dupFlag) result.dupFlagged += 1;
    population.push(vec);
    result.rows.push({
      ...row,
      embedding: vecToPg(vec),
      dup_flag: dupFlag,
      dup_similarity: maxSim,
    });
  });
  return result;
}

// 候補行を embed して既存 active プール＋バッチ内既採用と cosine 照合し、近重複に dup_flag を立てる。
// YAT-56: **cron とオンデマンドの両経路がこれを通る**。以前はオンデマンド（generateQuizForCategory）
// だけが dedup を通らず embedding=null で insert し、cron の backfill が後から embedding を埋めて
// いた。その結果、ゲートを一度も通らない行が active プールに入り、以降の dedup 母集団にも載る
// （＝閾値を較正しようにも「ゲートが何を弾いたか」を観測できない状態だった）。
// オンデマンドは after() の中で LLM 生成と併せて走るためユーザーを待たせず、Voyage 呼び出しが
// 1 回増えるコストは生成そのものに比べて小さい。
export async function embedAndDedupQuizRows(
  supabase: SupabaseClient,
  candidates: QuizInsertRow[],
  opts: { embedder?: Embedder | null; sleepBeforeEmbedMs?: number } = {},
): Promise<QuizDedupResult> {
  // 空なら embed も母集団取得もせず即返す。戻り値の形は markQuizDuplicates に作らせて
  // QuizDedupResult の初期値を 2 箇所で定義しない（フィールドが増えたときの取りこぼし防止）。
  // ここは embedder を見ないので embedSkipped=false のまま返るが、候補ゼロ＝embedFailed も 0 で、
  // 両経路のログは embedFailed > 0 でしか発火しないため観測上の差は出ない。
  if (candidates.length === 0) return markQuizDuplicates([], [], []);

  const embedder = opts.embedder === undefined ? createEmbedder() : opts.embedder;
  const population = await loadQuizDedupPopulation(supabase);

  let vectors: (number[] | null)[] = candidates.map(() => null);
  if (embedder) {
    // 直前に別の embed() を叩いている場合の保険（呼び出し"間"はレート制御外）。
    if (opts.sleepBeforeEmbedMs) {
      await new Promise((r) => setTimeout(r, opts.sleepBeforeEmbedMs));
    }
    try {
      vectors = await embedder.embed(candidates.map((row) => quizQuestionEmbedText(row)));
    } catch (e) {
      console.warn("候補クイズの embed に失敗（embedding=null で積む）:", e);
    }
  }

  return { ...markQuizDuplicates(candidates, vectors, population), embedSkipped: !embedder };
}

// ── 判定を受け損ねた行の再判定（YAT-82）─────────────────────────────
// embed に失敗した行は embedding=null・dup_flag=false・dup_similarity=null で積まれ、cron の backfill が
// 後から embedding だけを埋める。以前は判定をやり直さなかったため、近重複でも出題プールに残り続けた。
// 実測（2026-09-24）: 08-17 のオンデマンド補充 3 回で入った 11 行がすべてこの状態で、tech/web では
// 既存問題と類似度 0.905〜0.960 の言い換え問題が「別の問題」として出題され続けていた。
//
// dup_similarity 列（0013）と dup_flag 方式（YAT-61）が入る前の行は、ゲートを一度も通っていないので
// null が正常（0013 が遡って flag を立てない方針を取った行）。この境界より後で null の行だけが
// 「判定を受け損ねた」行。境界は YAT-61 のマージ日。実データでは 07-20 の行が最後の null、
// 07-27 の行が最初の非 null で、その間に行は無い。
export const DUP_JUDGE_ERA_START = "2026-07-23T00:00:00Z";

export type JudgeRow = {
  id: string;
  vec: number[];
  unjudged: boolean; // 再判定の対象か（判定欠落かつ境界以降）
  dupFlag: boolean; // 現在の dup_flag（判定済み行を格上げするかの判断に使う）
};

// judge = 判定欠落行への初回判定 / upgrade = 判定済みの後発行を dup へ格上げ（false→true の片方向のみ）
export type Judgment = {
  id: string;
  kind: "judge" | "upgrade";
  dupFlag: boolean;
  dupSimilarity: number;
};

// DB の行を JudgeRow に変換する（pure）。判定欠落 = 境界以降で dup_similarity が null。
// embedding を読めない行は照合できないので除く（null を返す）。
export function toJudgeRow(
  r: { id: string; created_at: string; embedding: unknown; dup_similarity: number | null; dup_flag: boolean },
  eraStartMs: number,
): JudgeRow | null {
  const vec = parseEmbedding(r.embedding);
  if (!vec) return null;
  return {
    id: r.id,
    vec,
    unjudged: r.dup_similarity === null && Date.parse(r.created_at) >= eraStartMs,
    dupFlag: r.dup_flag,
  };
}

// 時系列順（created_at 昇順・同時刻は id 昇順）に並んだ行を再判定する（pure）。
// ① 判定欠落行はそれより**前の行**と照合する。insert 時の判定と同じく「その時点で既にあった問題」が
//   母集団で、後から入った問題と照合すると、元の問題の方を後発の言い換えの重複として落としかねない。
//   母集団には対象外の行も dup 行も含める（insert 時の keep-all と同じ）。
// ② 判定欠落行 X が embedding を持たない間に入った後発の行 Y は、X 抜きの母集団で判定されている。
//   ①だけでは X と Y が一度も照合されずに残るので、X と閾値以上に近い後発の非 dup 行は Y の側を
//   dup に格上げする（元の問題 X を残し、後発を外す＝①と同じ向き）。
export function judgeUnjudgedRows(rows: JudgeRow[]): Judgment[] {
  const out: Judgment[] = [];
  const upgraded = new Map<string, number>(); // 格上げする行 id → 最大類似度
  const unjudgedBefore: JudgeRow[] = [];
  const population: number[][] = [];
  for (const r of rows) {
    if (r.unjudged) {
      let maxSim = 0;
      for (const p of population) {
        if (p.length !== r.vec.length) continue;
        const sim = cosineSim(r.vec, p);
        if (sim > maxSim) maxSim = sim;
      }
      out.push({
        id: r.id,
        kind: "judge",
        dupFlag: maxSim >= QUIZ_DEDUP_THRESHOLD,
        dupSimilarity: maxSim,
      });
      unjudgedBefore.push(r);
    } else if (!r.dupFlag) {
      for (const x of unjudgedBefore) {
        if (x.vec.length !== r.vec.length) continue;
        const sim = cosineSim(r.vec, x.vec);
        if (sim >= QUIZ_DEDUP_THRESHOLD && sim > (upgraded.get(r.id) ?? 0)) {
          upgraded.set(r.id, sim);
        }
      }
    }
    population.push(r.vec);
  }
  for (const [id, sim] of upgraded) {
    out.push({ id, kind: "upgrade", dupFlag: true, dupSimilarity: sim });
  }
  return out;
}

export type RejudgeResult = {
  judged: number; // 判定欠落行に判定を書き戻した行数
  dupFlagged: number; // うち近重複として dup_flag を立てた行数（出題プールから外れる）
  upgraded: number; // 判定欠落行の後発の言い換えとして dup へ格上げした判定済み行の数
  failed: number; // 書き戻しに失敗した行数（次回 run で再試行される）
};

// embedding はあるのに判定を受けていない行を探して再判定し、dup_flag / dup_similarity を書き戻す。
// cron（runQuizPool）が backfill の直後に呼ぶ。失敗は fail-soft（この回は再判定しないだけ）。
//
// 観測上の注意: 以前は「境界以降で dup_similarity が null の行数」が embed 失敗の永続的な痕跡だった
// （scripts/diagnose-dedup.ts の reportUnjudged）。再判定がこの null を埋めるので、DB に残るのは
// backfill・再判定がまだ済んでいない行だけになる。embed 失敗の累計は cron ログの「再判定 N」で追う。
export async function rejudgeUnjudgedQuizRows(
  supabase: SupabaseClient,
): Promise<RejudgeResult> {
  const result: RejudgeResult = { judged: 0, dupFlagged: 0, upgraded: 0, failed: 0 };

  // 対象が無い回（常態）は全件の embedding を読まずに抜ける。
  const probe = await supabase
    .from("quiz_questions")
    .select("id")
    .eq("status", "active")
    .is("dup_similarity", null)
    .not("embedding", "is", null)
    .gte("created_at", DUP_JUDGE_ERA_START)
    .limit(1);
  if (probe.error) {
    console.warn("判定欠落行の確認に失敗（再判定をスキップ）:", probe.error);
    return result;
  }
  if ((probe.data ?? []).length === 0) return result;

  const rows: JudgeRow[] = [];
  const eraStartMs = Date.parse(DUP_JUDGE_ERA_START);
  try {
    for (let from = 0; ; from += SELECT_PAGE) {
      const { data, error } = await supabase
        .from("quiz_questions")
        .select("id, created_at, embedding, dup_similarity, dup_flag")
        .eq("status", "active")
        .not("embedding", "is", null)
        // 時系列の全順序が判定の意味を決めるので、id を最終キーにして同時刻（同一バッチ）も確定させる。
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + SELECT_PAGE - 1);
      if (error) throw error;
      const batch = (data ?? []) as unknown as Parameters<typeof toJudgeRow>[0][];
      for (const r of batch) {
        const row = toJudgeRow(r, eraStartMs);
        if (row) rows.push(row);
      }
      if (batch.length < SELECT_PAGE) break;
    }
  } catch (e) {
    console.warn("再判定の母集団取得に失敗（再判定をスキップ）:", e);
    return result;
  }

  for (const j of judgeUnjudgedRows(rows)) {
    // 取得後に別経路が書き換えた行は上書きしない: judge は dup_similarity が null のまま、
    // upgrade は dup_flag が false のままの行だけを更新する。一致 0 行はエラーにならないので
    // select で実際に更新された行を数える。
    let q = supabase
      .from("quiz_questions")
      .update({ dup_flag: j.dupFlag, dup_similarity: j.dupSimilarity })
      .eq("id", j.id);
    q = j.kind === "judge" ? q.is("dup_similarity", null) : q.eq("dup_flag", false);
    const { data, error } = await q.select("id");
    if (error) {
      console.warn(`再判定の書き戻しに失敗 [${j.id}]:`, error);
      result.failed += 1;
      continue;
    }
    if ((data ?? []).length === 0) continue;
    if (j.kind === "upgrade") {
      result.upgraded += 1;
      continue;
    }
    result.judged += 1;
    if (j.dupFlag) result.dupFlagged += 1;
  }
  return result;
}

// カテゴリの素材から count 問を目標に生成し、embed → dedup を通して quiz_questions へ積んで返す。
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
  // YAT-56: cron と同じ embed → dedup を通してから insert する。以前はここを素通りして
  // embedding=null で積んでいたため、ゲートを通らない行が active プールに入っていた。
  const deduped = await embedAndDedupQuizRows(supabase, core.rows);
  const inserted = await insertQuizRows(supabase, deduped.rows);
  return {
    requested: core.requested,
    generated: core.generated,
    passed: core.passed,
    inserted,
    dupFlagged: deduped.dupFlagged,
    embedFailed: deduped.embedFailed,
    embedSkipped: deduped.embedSkipped,
    skipped: core.skipped,
  };
}
