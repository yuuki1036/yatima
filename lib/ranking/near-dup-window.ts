import type { SupabaseClient } from "@supabase/supabase-js";

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

export type WindowArticle = {
  feed_id: string;
  embedding: unknown;
  published_at: string | null;
};

export type WindowFetch = {
  rows: WindowArticle[];
  /** FETCH_CAP に達して古い側を切り捨てたか。true なら低頻度 feed が母数不足に倒れる方向に偏る。 */
  truncated: boolean;
  /** 窓の下端（ISO 8601）。 */
  since: string;
};

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
  while (rows.length < FETCH_CAP) {
    const size = Math.min(SELECT_PAGE, FETCH_CAP - rows.length);
    const { data, error } = await supabase
      .from("articles")
      .select("feed_id, embedding, published_at")
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
    if (batch.length === 0) return { rows, truncated: false, since };
    rows.push(...batch);
  }
  return { rows, truncated: true, since };
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
  let embedded = 0;
  while (embedded < FETCH_CAP) {
    const size = Math.min(SELECT_PAGE, FETCH_CAP - embedded);
    const { data, error } = await supabase
      .from("articles")
      .select("feed_id")
      .gte("published_at", since)
      .not("embedding", "is", null)
      .order("published_at", { ascending: false })
      .order("id", { ascending: true })
      .range(embedded, embedded + size - 1);
    if (error) throw error;
    const batch = (data ?? []) as unknown as { feed_id: string }[];
    // 打ち切り条件は fetchWindowArticles と同じ理由で「0 件が返った」ときだけ。
    if (batch.length === 0) return { byFeed, embedded, truncated: false, since };
    for (const r of batch) byFeed.set(r.feed_id, (byFeed.get(r.feed_id) ?? 0) + 1);
    embedded += batch.length;
  }
  return { byFeed, embedded, truncated: true, since };
}
