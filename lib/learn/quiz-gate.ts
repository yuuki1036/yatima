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
// それが全件ロードの根拠だった。dup_flag 方式では dup 行も active として残る一方、countActive は
// それを充足に数えない（＝deficit を埋めない）ので、行数は頭打ちしない。増加ペースは週次 cron の
// MAX_NEW_PER_RUN=24 とセッション補充が上限なので緩やかだが、単調に増える。
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
  const result: QuizDedupResult = { rows: [], dupFlagged: 0, embedFailed: 0 };
  candidates.forEach((row, i) => {
    const vec = vectors[i];
    if (!vec) {
      // embed 失敗は embedding=null・dup_flag=false で積み、次回バックフィルが embedding を埋めて
      // 以降の母集団に乗せる。dup 判定はやり直さない＝未判定分は出題プールに残る（安全側）。
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

  return markQuizDuplicates(candidates, vectors, population);
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
    skipped: core.skipped,
  };
}
