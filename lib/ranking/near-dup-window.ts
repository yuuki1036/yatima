import type { SupabaseClient } from "@supabase/supabase-js";
import {
  recipeOf,
  EMBED_RECIPE_EPOCH,
  type EmbedRecipe,
  type RecipeCounts,
} from "./embed-recipe";
import { EMBED_MIN_BODY_LEN } from "../rss/embed";

// near_dup_rate（feed の重複量産率・YAT-20）の「母集団の取り方」を一箇所に固定する。
//
// なぜ共有モジュールなのか: compute-dedup-rate.ts（算出）と diagnose-feed-health.ts（観測）は
// 同じ母集団を見ていなければ診断が成立しないが、両者は窓・上限・パース条件を定数コメント
// （「compute-dedup-rate.ts と揃える」）で手動同期していた。その手動同期こそが下の不具合を
// 一方だけに残す温床だったので、クエリごと共有する。
//
// 直した不具合: `.limit(5000)` は PostgREST の db-max-rows（既定 1000）に上書きされ、
// 30 日窓のつもりが実質「直近 1000 件（≒5 日分）」しか取れていなかった。結果として
//   - 低頻度 feed は母数不足に落ちて near_dup_rate が恒常的に null になる
//   - 比較プールも直近数日に縮み、「他 feed 横断」になっていない
// という状態で、しかも `rows.length >= FETCH_LIMIT` の切り詰め警告は 1000 で頭打ちになるため
// 永久に発火しなかった。全件取得は .range() のページングで回す
// （[[supabase-range-pagination-needs-unique-sort]] / card-gate・diagnose-dedup と同じ作法）。

export const WINDOW_DAYS = 30; // near_dup_rate 算出の対象窓
// 近重複率を算出する最小母数（未満は小サンプル膨張を避けて未算出＝null）。
//
// 20 なのは閾値の粒度に合わせるため（YAT-55 決定 4-D / 観測 ⑥）。元は 5 だったが、これは
// NEAR_DUP_RATE が 0.5 だった頃の値で、有向化して閾値が 0.2 になった今は粗すぎる:
// own=5 だと 1 記事が率を 0.20 動かす＝**1 記事で閾値をまたぐ**。own=20 なら 0.05（閾値の 1/4）。
//
// 実測（2026-08-26・active 33 feed）では 5→20 で算出対象が 24→19 に減るが、外れる 5 feed
// （DeepMind 5 / Nature 5 / HuggingFace 11 / MIT Tech Review 16 / G-gen 17）は**全て ndup 0.00**
// なので、生きているシグナルは 1 つも失わない。決定 4-D の候補 20〜30 の保守側を採った
// （25 以上にすると Latent.Space 0.18 / Publickey 0.19 / Claude Help 20 が落ちて実際に信号を失う）。
export const MIN_OWN_ARTICLES = 20;

// near_dup_rate の分子・分母を作るときに評価する「自 feed 側」の上限（新しい順）。
//
// **これが率の実分母を決める。** compute-dedup-rate は `own = byFeed.get(id).slice(0, PER_FEED_LIMIT)`
// としたうえで `rate = dup / own.length` を計算するので、窓内に 400 件ある feed でも分母は 100。
// 較正で「1 記事が率をどれだけ動かすか」を読むときは、窓内の実件数ではなくこの上限で clamp した
// 値を使うこと（YAT-55 セルフレビュー。`own_articles` に全数を記録していて 4 倍甘く見えていた）。
//
// compute-dedup-rate のローカル定数だったのをここへ移した。窓の定義と一体で使う値であり、
// 別ファイルに置くと本モジュールが解消したはずの「定数の手動同期」を再生産するため。
export const PER_FEED_LIMIT = 100;
const SELECT_PAGE = 1000; // PostgREST 既定の 1 ページ上限。これを超える取得は .range() で回す

// 窓内の記事を全件取ると重い（1 行に 1024 次元の embedding 文字列 ≒12KB）ため上限を置く。
// これは「安全弁」であって窓の定義ではない。到達したら窓が実質縮むので呼び出し側が警告する。
export const FETCH_CAP = 20_000;

// ゲート観点の集計（fetchWindowGateCounts）専用の安全弁。embedding 非 null に絞らず窓内の全記事を
// 数えるため、母集団が embedding パス（FETCH_CAP）より大きい。現状の窓は約 18,910 行で FETCH_CAP に
// 肉薄するので、この経路だけ別に広く取る。
export const GATE_FETCH_CAP = 60_000;

const emptyRecipeCounts = (): RecipeCounts => ({ legacy: 0, lead: 0 });

export type WindowArticle = {
  feed_id: string;
  embedding: unknown;
  published_at: string | null;
  /** レシピ判定（YAT-77）に使う。null / EPOCH 未満は legacy（title+summary）、以降は lead（title+lead）。 */
  embedded_at: string | null;
};

export type WindowFetch = {
  rows: WindowArticle[];
  /** FETCH_CAP に達して古い側を切り捨てたか。true なら低頻度 feed が母数不足に倒れる方向に偏る。 */
  truncated: boolean;
  /** 窓の下端（ISO 8601）。 */
  since: string;
  /** 窓内で embedding を持つ記事のレシピ内訳（YAT-77）。 */
  byRecipe: RecipeCounts;
};

/** 取得済み行を指定レシピだけに絞る（YAT-77）。own と比較プールの両方に同じレシピを効かせる。
 *  多数派が legacy かつ share 1.0（段階 3 前・revert 後）のとき 1 行も落とさない＝現行挙動に合流。
 *  元配列は破壊しない。 */
export function filterByRecipe(
  rows: WindowArticle[],
  recipe: EmbedRecipe,
): WindowArticle[] {
  return rows.filter((r) => recipeOf(r.embedded_at) === recipe);
}

/**
 * 直近 WINDOW_DAYS の「embedding を持つ記事」を新しい順に全件取得する。
 *
 * published_at は非ユニークなので、ページ境界での取りこぼし／重複を防ぐために id を第 2 ソート
 * キーに置いて全順序を確定させる（この二次キーが無いと母集団が静かに欠ける）。
 */
export async function fetchWindowArticles(
  supabase: SupabaseClient,
  now: number,
): Promise<WindowFetch> {
  const since = new Date(now - WINDOW_DAYS * 86_400_000).toISOString();
  const rows: WindowArticle[] = [];
  const byRecipe = emptyRecipeCounts();
  while (rows.length < FETCH_CAP) {
    const size = Math.min(SELECT_PAGE, FETCH_CAP - rows.length);
    const { data, error } = await supabase
      .from("articles")
      .select("feed_id, embedding, published_at, embedded_at")
      .gte("published_at", since)
      .not("embedding", "is", null)
      .order("published_at", { ascending: false })
      .order("id", { ascending: true })
      .range(rows.length, rows.length + size - 1);
    if (error) throw error;
    const batch = (data ?? []) as unknown as WindowArticle[];
    // 打ち切りは「0 件が返った」ときだけにする。`batch.length < size` で判定すると、サーバ側の
    // db-max-rows が SELECT_PAGE より小さい環境で 1 ページ目から break し、残りを丸ごと取りこぼす
    // ——本モジュールが直したはずのバグを、警告も出さずに再発させる形になる。オフセットは要求幅
    // ではなく実取得件数（rows.length）で前進させるので、1 ページの実サイズが何であれ連続する。
    if (batch.length === 0) return { rows, truncated: false, since, byRecipe };
    for (const r of batch) byRecipe[recipeOf(r.embedded_at)] += 1;
    rows.push(...batch);
  }
  return { rows, truncated: true, since, byRecipe };
}

/** feed ごとの窓内件数（embedding 列が非 null の記事）。 */
export type WindowFeedCounts = {
  /** feed_id → 窓内で embedding を持つ記事数（clamp なしの実数）。 */
  byFeed: Map<string, number>;
  /** 窓内で embedding を持つ記事の総数。 */
  embedded: number;
  /** FETCH_CAP に達して古い側を切り捨てたか。 */
  truncated: boolean;
  /** 窓の下端（ISO 8601）。 */
  since: string;
  /** 窓内で embedding を持つ記事のレシピ内訳（YAT-77・全 feed 合算）。 */
  byRecipe: RecipeCounts;
  /** feed_id → その feed のレシピ内訳（YAT-77）。 */
  byFeedRecipe: Map<string, RecipeCounts>;
};

/**
 * `fetchWindowArticles` と**同じ母集団**を、embedding 本体を落とさずに数える。
 *
 * なぜ別関数か: 観測側（feed-health-observation）は embedding の中身を一切使わず「何件あるか」
 * しか要らないのに、`fetchWindowArticles` を呼ぶと 1 行 ≒12KB の vector(1024) を全件ダウンロード
 * していた。窓 7500 行で約 90MB を週次で 2 回（compute-dedup-rate と snapshot）払う計算になり、
 * 無料枠の egress を整数 33 個のために使っていた（YAT-55 セルフレビュー）。
 *
 * 窓・フィルタ・ページングは `fetchWindowArticles` と同一の定義をこのモジュール内で共有する。
 * select する列だけが違う。
 *
 * **`fetchWindowArticles` との差**: あちらは `parseEmbedding` に失敗した行を母集団から落とすが、
 * こちらは「embedding 列が非 null」までしか見ない。`embedding` は `vector(1024)`（migration 0003）
 * なので、非 null 値が JSON 配列としてパースできない経路は実質存在しない。差が出るとすれば
 * 型が変わったときで、そのときは両者を揃え直すこと。
 */
export async function fetchWindowFeedCounts(
  supabase: SupabaseClient,
  now: number,
): Promise<WindowFeedCounts> {
  const since = new Date(now - WINDOW_DAYS * 86_400_000).toISOString();
  const byFeed = new Map<string, number>();
  const byFeedRecipe = new Map<string, RecipeCounts>();
  const byRecipe = emptyRecipeCounts();
  let embedded = 0;
  while (embedded < FETCH_CAP) {
    const size = Math.min(SELECT_PAGE, FETCH_CAP - embedded);
    const { data, error } = await supabase
      .from("articles")
      .select("feed_id, embedded_at")
      .gte("published_at", since)
      .not("embedding", "is", null)
      .order("published_at", { ascending: false })
      .order("id", { ascending: true })
      .range(embedded, embedded + size - 1);
    if (error) throw error;
    const batch = (data ?? []) as unknown as {
      feed_id: string;
      embedded_at: string | null;
    }[];
    // 打ち切り条件は fetchWindowArticles と同じ理由で「0 件が返った」ときだけ。
    if (batch.length === 0)
      return { byFeed, embedded, truncated: false, since, byRecipe, byFeedRecipe };
    for (const r of batch) {
      byFeed.set(r.feed_id, (byFeed.get(r.feed_id) ?? 0) + 1);
      const recipe = recipeOf(r.embedded_at);
      byRecipe[recipe] += 1;
      const fr = byFeedRecipe.get(r.feed_id) ?? emptyRecipeCounts();
      fr[recipe] += 1;
      byFeedRecipe.set(r.feed_id, fr);
    }
    embedded += batch.length;
  }
  return { byFeed, embedded, truncated: true, since, byRecipe, byFeedRecipe };
}

/** 窓内の「全記事」を embed ゲート観点で数える（YAT-77）。embedding の有無を問わない。
 *  feed_health_snapshots の window_own_articles / window_own_eligible を埋めるための母集団で、
 *  「記事はあるがゲート（body_text_len >= 250）で弾かれて embed されない」を feed 単位で切り分ける。 */
export type WindowGateCounts = {
  /** feed_id → { 窓内の記事数, うちゲートを通る（body_text_len >= 250）件数 }。 */
  byFeed: Map<string, { articles: number; eligible: number }>;
  /** 窓内の記事総数。 */
  articles: number;
  /** うちゲートを通る総数。 */
  eligible: number;
  /** GATE_FETCH_CAP に達して古い側を切り捨てたか。embedding パスの truncated とは影響が違う。 */
  truncated: boolean;
  /** 窓の下端（ISO 8601）。 */
  since: string;
};

export async function fetchWindowGateCounts(
  supabase: SupabaseClient,
  now: number,
): Promise<WindowGateCounts> {
  const since = new Date(now - WINDOW_DAYS * 86_400_000).toISOString();
  const byFeed = new Map<string, { articles: number; eligible: number }>();
  let articles = 0;
  let eligible = 0;
  while (articles < GATE_FETCH_CAP) {
    const size = Math.min(SELECT_PAGE, GATE_FETCH_CAP - articles);
    const { data, error } = await supabase
      .from("articles")
      .select("feed_id, body_text_len")
      .gte("published_at", since)
      .order("published_at", { ascending: false })
      .order("id", { ascending: true })
      .range(articles, articles + size - 1);
    if (error) throw error;
    const batch = (data ?? []) as unknown as {
      feed_id: string;
      body_text_len: number | null;
    }[];
    if (batch.length === 0)
      return { byFeed, articles, eligible, truncated: false, since };
    for (const r of batch) {
      const isEligible = (r.body_text_len ?? 0) >= EMBED_MIN_BODY_LEN;
      const cur = byFeed.get(r.feed_id) ?? { articles: 0, eligible: 0 };
      cur.articles += 1;
      if (isEligible) {
        cur.eligible += 1;
        eligible += 1;
      }
      byFeed.set(r.feed_id, cur);
    }
    articles += batch.length;
  }
  return { byFeed, articles, eligible, truncated: true, since };
}

/** 新レシピ（title+lead）で embedding された最初の時刻（YAT-77・45 日 clock の耐久 probe）。
 *  行が無ければ null。**窓で絞らない**——窓外に落ちても clock は動き続ける必要がある。
 *  embedded_at は prune では消えない（pruneStaleEmbeddings は embedding のみ NULL 化）ので耐久。
 *  取得失敗は throw（週次 1 回・判定不能を緑で流さない。null は「行が無い」に予約済み）。 */
export async function firstLeadEmbeddedAt(
  supabase: SupabaseClient,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("articles")
    .select("embedded_at")
    .gte("embedded_at", EMBED_RECIPE_EPOCH)
    .order("embedded_at", { ascending: true })
    .limit(1);
  if (error) throw error;
  const rows = (data ?? []) as unknown as { embedded_at: string | null }[];
  return rows[0]?.embedded_at ?? null;
}
