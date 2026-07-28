import type { SupabaseClient } from "@supabase/supabase-js";
import { createEmbedder, type Embedder } from "@/lib/llm/embed";
import { vecToPg, cardCandidateEmbedText } from "@/lib/rss/embed";
import { cosineSim, parseEmbedding, CARD_DEDUP_THRESHOLD } from "@/lib/ranking/dedup";
import { htmlToInputText } from "@/lib/llm/extract-text";
// grounding の決定的プリミティブ（norm / 逐語照合）は型非依存の共通モジュールへ抽出済み（YAT-27・F4）。
import { norm, isQuoteGrounded, GROUND_BODY_MAX_CHARS } from "@/lib/learn/grounding";
import {
  createCardGenerator,
  MAX_CARDS_PER_ARTICLE,
  type CardGenerator,
  type GeneratedCard,
} from "@/lib/llm/generate-cards";

// YAT-17: 学習カードの機械ゲート。lib/rss/discover.ts の runDiscoveryGate（候補 → 機械フィルタ →
// 重複排除 → pending 登録の fail-soft 構造）を雛形に、LLM 生成カードを決定的に検証して
// card_candidates(pending) に積む。LLM 出力は grounding + 形式検証を通った分のみ採用し、本文中の
// 指示は信用しない（prompt injection 一次対処）。dedup 中核（cosineSim）は ranking 層を呼ぶだけ。
// grounding 閾値・逐語照合は lib/learn/grounding.ts に抽出済み（YAT-27・F4）。

const DEFAULT_MAX_ARTICLES = 10; // 1 回の実行で処理する対象記事の上限（Voyage レート/cron 時間の制御）
const SELECT_PAGE = 1000; // PostgREST 既定の 1 ページ上限。これを超える全件取得は .range() で回す
const IN_CHUNK = 200; // .in() に渡す id の 1 リクエスト上限（URI 長超過を避ける）

export type CardGateResult = {
  scannedArticles: number; // 対象母集団（useful & summary & 未カード化）から処理した件数
  generated: number; // LLM が返した候補の総数
  groundingPassed: number; // grounding + 形式検証を通過した候補数
  dupFlagged: number; // dedup で dup_flag を立てた数
  inserted: number; // card_candidates へ insert した数
  failed: number; // 記事単位で fail-soft 落ちした件数
  skipped: boolean; // ANTHROPIC_API_KEY 未設定でスキップした場合 true
};

type ArticleRow = {
  id: string;
  title: string | null;
  content_html: string | null;
  summary: string | null;
  published_at: string | null;
};

// cloze 文から穴埋めマーカーを外して素のテキストにする（語彙重なり計算の対象用）。
// 診断スクリプト（diagnose-card-grounding）が本番と同じ target を組めるよう export する。
export function stripCloze(cloze: string): string {
  // {{c1::答え}} → 答え（ヒント付き {{c1::答え::ヒント}} は答えのみ残す）
  return cloze.replace(/\{\{c\d+::(.*?)(?:::.*?)?\}\}/g, "$1");
}

// 形式検証（最安・LLM 不要）。type ごとに必須フィールドの充足と cloze 構文を確認する。
// 診断スクリプトが本番と同じ順序（形式 → grounding）を再現できるよう export する。
export function isValidFormat(card: GeneratedCard): boolean {
  if (card.type === "qa") {
    return Boolean(card.front?.trim()) && Boolean(card.back?.trim());
  }
  // cloze: cloze_text が非空かつ {{c1::...}} を少なくとも1つ含み、中身が空でない
  const text = card.cloze_text?.trim();
  if (!text) return false;
  const m = text.match(/\{\{c\d+::(.*?)(?:::.*?)?\}\}/);
  return Boolean(m && m[1].trim());
}

// ④語彙重なりを無効化する（YAT-58）。YAT-30 が MCQ で下した判断（quiz-gate の QUIZ_MIN_OVERLAP=0）
// を card 経路へ揃えるもの。英語記事の逐語引用×日本語カードで固有トークンが言語違いによりほぼ
// 重ならず、jaccard が構造的に 0 へ潰れるため閾値較正では解決しない。
// 計測（YAT-58 / diagnose-card-grounding・サンプル 6 記事・生成 25 件）: low_overlap が生成の
// 68%（17/25。棄却 22 件に対しては 77%）、通過率 12.0% → ④無効で 80.0%。jaccard 実測値は
// 0.000〜0.054 で qa/cloze とも一様に棄却。
// ②逐語＋③固有性が「引用は実在の記事固有テキスト」を担保する。この経路では②が現に 25 件中 5 件
// （20%）を捕捉しており、MCQ（同計測で②棄却 0 件）より防御が効いている。
//
// 限界と前提（復活時に必ず読むこと）:
// - この経路は YAT-27 で凍結済み。runCardGate を回す cron は無く（learn.yml は generate-quiz のみ）、
//   到達経路は手動の `npm run generate-cards` だけ。よって④無効化は本番で運用実績が無い。
// - ④が担っていた「quote が設問と無関係な箇所からの抜粋でない」担保は失われる。knowledge は
//   これを人手承認で緩衝する二層設計としているが、その承認 UI も YAT-27 で撤去済み
//   （approveCard/rejectCard は呼び出し側ゼロ）。緩衝層が無い状態であることを前提にすること。
// - 計測サンプルは published_at 降順の新着で、投稿量の多い英語フィードに偏る。日本語記事×日本語
//   カードでは固有トークンが正常に交差するため④は機能しており、その層は未計測のまま無効化した。
//   経路を quiz と揃えることを優先した判断で、日本語層での妥当性は追試していない。
const CARD_MIN_OVERLAP = 0;

// grounding 照合の target（設問本体）を type ごとに組む。診断スクリプトが本番と同一の target を
// 再現できるよう export する（重複実装だと isGrounded の変更時に計測が黙って乖離するため）。
export function cardTarget(card: GeneratedCard): string {
  return card.type === "cloze"
    ? stripCloze(card.cloze_text ?? "")
    : `${card.front ?? ""} ${card.back ?? ""}`;
}

// grounding 照合（決定的）。共通の逐語照合ゲート（grounding.ts の isQuoteGrounded）へ委ねる。
// 判定順序＝①長さ →②逐語 →③固有性 →④設問関連。④は CARD_MIN_OVERLAP=0 で無効。
// 「④を渡している」という配線自体が YAT-58 の修正内容なので、テストから直接叩けるよう export する。
export function isGrounded(card: GeneratedCard, groundBody: string): boolean {
  return isQuoteGrounded(card.source_quote, groundBody, cardTarget(card), CARD_MIN_OVERLAP);
}

// card_candidates の 1 列を .range() で全件ページ取得する。行は単調増加するため、PostgREST の
// 既定 1000 行上限で暗黙に打ち切ると dedup 母集団が頭打ちになり、カード化済み判定も取りこぼす
// （findUntaggedSummarized と同じページ走査パターン）。
async function selectAllCardColumn(
  supabase: SupabaseClient,
  column: "embedding" | "article_id",
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += SELECT_PAGE) {
    const { data, error } = await supabase
      .from("card_candidates")
      .select(column)
      // id を二次キーにして同一 created_at でのページ境界の取りこぼし/重複を防ぐ
      // （summarize-batch.ts の findUntaggedSummarized と同じページ走査の作法）。
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + SELECT_PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as unknown as Record<string, unknown>[];
    out.push(...batch);
    if (batch.length < SELECT_PAGE) break;
  }
  return out;
}

// 既存 card_candidates の embedding を全 status 分ロードして dedup 母集団にする（行は永続）。
// 取得失敗は fail-soft で空母集団に倒す（＝この回は dedup が効かないだけ。重複候補が pending に
// 積まれる可能性は許容する。承認層は存在しないので、緩衝はない — ADR-20260728184233）。
async function loadDedupPopulation(
  supabase: SupabaseClient,
): Promise<number[][]> {
  let rows: Record<string, unknown>[];
  try {
    rows = await selectAllCardColumn(supabase, "embedding");
  } catch (e) {
    console.warn("dedup 母集団の取得に失敗（空母集団で続行）:", e);
    return [];
  }
  const vecs: number[][] = [];
  for (const r of rows) {
    const v = parseEmbedding(r.embedding);
    if (v) vecs.push(v);
  }
  return vecs;
}

// 既にカード化済みの記事 id 集合（全 status）。同じ記事から重複生成しないために除外する。
async function loadCardedArticleIds(
  supabase: SupabaseClient,
): Promise<Set<string>> {
  const rows = await selectAllCardColumn(supabase, "article_id");
  const set = new Set<string>();
  for (const r of rows) {
    if (r.article_id) set.add(r.article_id as string);
  }
  return set;
}

// useful 判定の記事 id を元帳から全件ページ取得する（article_feedback も行が単調増加する）。
async function loadUsefulArticleIds(
  supabase: SupabaseClient,
): Promise<string[]> {
  const ids: string[] = [];
  for (let from = 0; ; from += SELECT_PAGE) {
    const { data, error } = await supabase
      .from("article_feedback")
      .select("article_id")
      .eq("action", "useful")
      .order("article_id", { ascending: true }) // ページ境界を安定させる全順序
      .range(from, from + SELECT_PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as { article_id: string }[];
    for (const r of batch) ids.push(r.article_id);
    if (batch.length < SELECT_PAGE) break;
  }
  return ids;
}

// 対象母集団を取得する: feedback=useful かつ summary IS NOT NULL かつ未カード化の記事を新着順。
// targetIds は useful 記事の累積で大きくなりうるため、.in() を IN_CHUNK 単位に分割して URI 長
// 超過を避ける（一括 .in だと数百件で 414 失敗 → 恒久的に 0 件生成に倒れる）。各チャンクを
// 新着 maxArticles 件に絞って取得し、最後にまとめて新着順 maxArticles 件へ揃える。
async function loadTargetArticles(
  supabase: SupabaseClient,
  maxArticles: number,
): Promise<ArticleRow[]> {
  const usefulIds = await loadUsefulArticleIds(supabase);
  if (usefulIds.length === 0) return [];

  // カード化済み判定の取得失敗は throw して全件スキップする（不完全な判定で生成すると重複候補を
  // 積むため・loadDedupPopulation の空倒しとは非対称）。0 生成が続いたとき原因を切り分けられる
  // よう、useful 母集団の失敗や「対象なし」と区別できる専用の痕跡を残してから再送出する。
  let carded: Set<string>;
  try {
    carded = await loadCardedArticleIds(supabase);
  } catch (e) {
    console.warn("カード化済み判定の取得に失敗（重複生成を避けるため全件スキップ）:", e);
    throw e;
  }
  const targetIds = usefulIds.filter((id) => !carded.has(id));
  if (targetIds.length === 0) return [];

  const collected: ArticleRow[] = [];
  for (let i = 0; i < targetIds.length; i += IN_CHUNK) {
    const chunk = targetIds.slice(i, i + IN_CHUNK);
    const { data, error } = await supabase
      .from("articles")
      .select("id, title, content_html, summary, published_at")
      .in("id", chunk)
      .not("summary", "is", null)
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(maxArticles);
    if (error) throw error;
    collected.push(...((data ?? []) as ArticleRow[]));
  }

  // チャンク横断で新着順に揃え、上限件数へ切る。
  collected.sort((a, b) => {
    const ta = a.published_at ? Date.parse(a.published_at) : 0;
    const tb = b.published_at ? Date.parse(b.published_at) : 0;
    return tb - ta;
  });
  return collected.slice(0, maxArticles);
}

// 機械ゲート本体。母集団取得 → 記事ごとに 形式 → grounding → その場 embed + dedup → pending insert。
// 各段は fail-soft（1 記事の失敗が全体を止めない）。runDiscoveryGate の集計・構造に倣う。
//
// 【凍結中・承認層なし】この経路は YAT-27 で凍結された（ADR-20260728184233 / YAT-59）。
// cron からは呼ばれず、到達手段は手動 `npm run generate-cards` のみ。pending に積まれた候補を
// 承認・消費する UI は存在せず、昇格先（cards / SRS）も未実装。「人手承認が緩衝する」前提の
// 判断をこの経路に積まないこと。復活は ADR の supersede とセットで行う。
export async function runCardGate(
  supabase: SupabaseClient,
  opts: {
    generator?: CardGenerator | null;
    embedder?: Embedder | null;
    maxArticles?: number;
    maxCardsPerArticle?: number;
  } = {},
): Promise<CardGateResult> {
  const generator =
    opts.generator !== undefined ? opts.generator : createCardGenerator();
  const embedder =
    opts.embedder !== undefined ? opts.embedder : createEmbedder();
  const maxArticles = opts.maxArticles ?? DEFAULT_MAX_ARTICLES;
  const maxCardsPerArticle = opts.maxCardsPerArticle ?? MAX_CARDS_PER_ARTICLE;

  const result: CardGateResult = {
    scannedArticles: 0,
    generated: 0,
    groundingPassed: 0,
    dupFlagged: 0,
    inserted: 0,
    failed: 0,
    skipped: false,
  };

  // API キー未設定 → 生成スキップ（cron は成功扱い）。
  if (!generator) {
    result.skipped = true;
    return result;
  }

  let articles: ArticleRow[];
  let population: number[][];
  try {
    articles = await loadTargetArticles(supabase, maxArticles);
    population = await loadDedupPopulation(supabase);
  } catch (e) {
    console.warn("カード生成の母集団取得に失敗:", e);
    return result;
  }
  result.scannedArticles = articles.length;
  if (articles.length === 0) return result;

  // insert 行を蓄積して最後に bulk insert する（runDiscoveryGate と同方針）。
  const rows: Record<string, unknown>[] = [];

  // 記事単位の fail-soft ループ（直列。生成は cron なので直列で十分・Voyage レートも素直）。
  for (const article of articles) {
    try {
      const rawBody = [
        htmlToInputText(article.content_html, GROUND_BODY_MAX_CHARS),
        article.summary ?? "",
      ]
        .filter(Boolean)
        .join("\n");
      // grounding 照合は正規化（小文字化・空白圧縮）した本文で行うが、LLM へは生本文を渡す。
      // norm 済みを渡すと source_quote や生成文まで小文字化され（React→react 等）カードの表示
      // 品質が落ちるため、LLM 入力（rawBody）と照合母体（groundBody）を分離する。
      const groundBody = norm(rawBody);

      const cards = await generator.generate({
        title: article.title,
        articleText: rawBody,
      });
      result.generated += cards.length;

      // ① 形式 → ② grounding（安い順）を通過した候補だけ残し、上限枚数で切る。
      const survivors = cards
        .filter((c) => isValidFormat(c) && isGrounded(c, groundBody))
        .slice(0, maxCardsPerArticle);
      result.groundingPassed += survivors.length;
      if (survivors.length === 0) continue;

      // ③ dedup: 候補をその場で embed → 既存母集団 + 本記事内既採用と cosine 照合。
      // embedder 無し/失敗時は embedding=null・dup_flag=false で insert し、後段の
      // embedMissingCardCandidates が補完する（未 embedding は dedup 母集団から自然に外れる）。
      let vectors: (number[] | null)[] = survivors.map(() => null);
      if (embedder) {
        try {
          vectors = await embedder.embed(
            survivors.map((c) => cardCandidateEmbedText(c)),
          );
        } catch (e) {
          console.warn(`カード候補の embed に失敗 [${article.id}]:`, e);
        }
      }

      survivors.forEach((card, i) => {
        const vec = vectors[i];
        let dupFlag = false;
        let dupSim: number | null = null;
        if (vec) {
          let maxSim = 0;
          for (const p of population) {
            const sim = cosineSim(vec, p);
            if (sim > maxSim) maxSim = sim;
          }
          dupSim = maxSim;
          dupFlag = maxSim >= CARD_DEDUP_THRESHOLD;
          if (dupFlag) result.dupFlagged += 1;
          population.push(vec); // 同一 run の後続記事ともダブらせない
        }
        rows.push({
          article_id: article.id,
          type: card.type,
          front: card.front,
          back: card.back,
          cloze_text: card.cloze_text,
          source_quote: card.source_quote,
          concept_tag: card.concept_tag,
          embedding: vec ? vecToPg(vec) : null,
          dup_flag: dupFlag,
          dup_similarity: dupSim,
          status: "pending",
        });
      });
    } catch (e) {
      result.failed += 1;
      console.warn(`カード生成に失敗 [${article.id}]:`, e);
    }
  }

  if (rows.length > 0) {
    const { data, error } = await supabase
      .from("card_candidates")
      .insert(rows)
      .select("id");
    if (error) {
      console.warn("card_candidates への登録に失敗:", error);
    } else {
      result.inserted = data?.length ?? 0;
    }
  }

  return result;
}
