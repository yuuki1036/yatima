import type { SupabaseClient } from "@supabase/supabase-js";
import {
  evaluateFeedHealth,
  deadThresholdMs,
  FEED_HEALTH_THRESHOLDS,
  type FeedHealthInput,
  type RetireSuggestion,
} from "./feed-health";
import { loadSourcePrefs } from "./preferences";
import {
  fetchWindowFeedCounts,
  fetchWindowGateCounts,
  WINDOW_DAYS,
  PER_FEED_LIMIT,
} from "./near-dup-window";
import {
  majorityRecipe,
  type EmbedRecipe,
  type RecipeCounts,
} from "./embed-recipe";
import type { Feed } from "../types";

// near_dup を算出できた active feed 数（feedsWithRate）の週次下限（YAT-77）。段階 3/4 の受け入れは
// この値が 13 → 21（構造上限）へ回復すること。12 未満は母集団が痩せた異常（snapshot が exit 1）。
// ただし near_dup_fresh=false（混在期・compute 失敗）のときは feedsWithRate=0 が正常なので、
// ガードは fresh のときだけ有効化する（呼び出し側 snapshot-feed-health.ts）。
export const FEEDS_WITH_RATE_FLOOR = 12;

// 退役スコアリングの「観測 1 回分」を組み立てる共有モジュール（YAT-55 観測 ⑥）。
//
// なぜ共有するのか: 同じ組み立てを diagnose-feed-health（人が読む一覧）と
// snapshot-feed-health（DB に貯める系列）の 2 箇所が必要とする。両者がズレると
// 「診断で見た値」と「較正に使う値」が別物になり、較正そのものが成立しない。
// near-dup-window と同じ判断（定数コメントでの手動同期は drift する）をここでも採る。
//
// 読み取り専用。この module は DB を書き換えない（書き込みは呼び出し側の責務）。

export const DAY_MS = 86_400_000;

/**
 * PostgrestError を message だけに潰さずに包む。
 *
 * `${err.message}` で文字列化すると `code` / `details` / `hint` が落ちる。Supabase の
 * PostgrestError はこの 3 つに原因の大半が入る（RLS 拒否・列名違い・migration 未適用など）ので、
 * 週次 cron が落ちたときにログから復元できなくなる。`cause` に原本を残し、message には
 * 人が読める要約を出す。
 */
function wrap(label: string, err: unknown): Error {
  const e = err as { message?: string; code?: string; details?: string; hint?: string };
  const parts = [e?.message, e?.code && `code=${e.code}`, e?.details, e?.hint].filter(Boolean);
  return new Error(`${label}: ${parts.join(" / ") || String(err)}`, { cause: err });
}

/** feed 1 本ぶんの観測。 */
export type FeedObservation = {
  input: FeedHealthInput;
  result: RetireSuggestion;
  /** feed 登録からの経過。新規猶予の判定内訳を読むのに使う。 */
  ageMs: number;
  /** 発信停滞（最新記事の公開からの経過）。記事ゼロは Infinity＝未発信。 */
  quietMs: number;
  /** その feed の投稿間隔から出した dead の適応閾値（YAT-70）。固定 14d とは別物。 */
  deadMs: number;
  /**
   * 窓内で embedding を持つ自 feed 記事の**実数**（clamp なし）。
   * near_dup_rate が null の理由が「母数不足」なのかを切り分けるのに使う。
   */
  windowOwnEmbedded: number;
  /**
   * near_dup_rate の**実分母** = `min(windowOwnEmbedded, PER_FEED_LIMIT)`。
   *
   * compute-dedup-rate は自 feed 側を新しい順 PER_FEED_LIMIT 件に切ってから
   * `rate = dup / own.length` を計算する。較正で「1 記事が率をどれだけ動かすか」を読むときは
   * 実数ではなくこちらを使うこと（実数を使うと 100 超の feed で安定性を過大評価する）。
   */
  ownArticles: number;
  /** 窓内の自 feed 記事総数（embedding の有無を問わない・YAT-77）。0017 の window_own_articles。 */
  windowOwnArticles: number;
  /** うち embed ゲート（body_text_len >= 250）を通る件数（YAT-77）。0017 の window_own_eligible。
   *  「記事はあるがゲートで弾かれて embed されない」を feed 単位で切り分ける。 */
  windowOwnEligible: number;
  /** 窓内で embedding を持つ自 feed 記事のレシピ内訳（YAT-77）。 */
  windowOwnRecipe: RecipeCounts;
};

/**
 * 観測時点の窓の健全性。**この観測を較正に使ってよいかの判断材料。**
 *
 * 2026-08-26 の事例: クレジット切れで要約が 7 日止まり、要約済みにしか embedding が付かないため
 * 窓の直近 7 日が丸ごと欠けた状態で near_dup が算出された。当時その事実を示す記録がどこにも
 * 無かったので、汚染に気付いたのは 2 日後に別経路で articles を数え直したときだった。
 */
export type ObservationWindow = {
  /** 窓の下端（ISO 8601）。 */
  since: string;
  /** 窓内の記事総数（embedding の有無を問わない）。 */
  articles: number;
  /** 窓内で embedding 列が非 null の件数。 */
  embedded: number;
  /** embedded / articles。大きく落ちていれば要約・embed 経路の障害中の観測。 */
  coverage: number;
  /** FETCH_CAP に達して古い側を切り捨てたか。true なら窓が実質縮んでいる。 */
  truncated: boolean;
  /** 窓内で embedding を持つ記事のレシピ内訳（YAT-77・全 feed 合算）。 */
  byRecipe: RecipeCounts;
  /** byRecipe の多数派とその share（レシピ移行の進行度）。 */
  majority: { recipe: EmbedRecipe; share: number; total: number };
  /** レシピ別網羅率（そのレシピの embedded 数 / articles）。移行期の表示・記録に使う。 */
  coverageByRecipe: Record<EmbedRecipe, number>;
  /** fetchWindowGateCounts 由来。窓内でゲート（body_text_len >= 250）を通る記事数。 */
  eligible: number;
  /** ゲート集計の truncated（GATE_FETCH_CAP 到達）。embedding パスの truncated とは別物。 */
  gateTruncated: boolean;
};

export type FeedHealthObservation = {
  /** 判定にも表示にも使う固定時刻。 */
  now: number;
  feeds: Feed[];
  active: Feed[];
  /** score 降順。 */
  rows: FeedObservation[];
  window: ObservationWindow;
  /**
   * preferences の取得に失敗したときの例外。null なら成功。
   * 非 null なら pref は全て 0 で low_pref 判定は無意味。黙って 0 に倒すと「嗜好シグナルが健全」と
   * 誤読されるので、呼び出し側が**理由まで**提示すること。
   */
  prefsError: unknown;
  /** near_dup_rate が非 null の active feed 数（YAT-77）。段階 3/4 の受け入れ判定（13 → 21）。
   *  near_dup_rate=0.00 は最も多い実値なので、!r.input.near_dup_rate でなく !== null で数える。 */
  feedsWithRate: number;
};

/**
 * 全 active feed を filter せずに評価し、観測 1 回分を返す。
 *
 * feeds / RPC の取得失敗は throw する（呼び出し側が扱いを決める）。preferences の失敗だけは
 * フラグに畳んで続行する——pref 以外のシグナルは観測できるため、丸ごと落とすと損が大きい。
 */
export async function collectFeedHealthObservation(
  supabase: SupabaseClient,
  now: number = Date.now(),
): Promise<FeedHealthObservation> {
  const { data: feedData, error: feedErr } = await supabase
    .from("feeds")
    .select("*")
    .order("created_at", { ascending: false });
  if (feedErr) throw wrap("feeds の取得に失敗", feedErr);
  const feeds = (feedData ?? []) as Feed[];
  const active = feeds.filter((f) => f.active);

  // preferences の失敗は致命ではない（pref 以外のシグナルは観測できる）ので続行するが、
  // **理由は捨てない**。呼び出し側がログ粒度を決められるよう戻り値に載せる
  // （knowledge: 共有プリミティブの失敗は理由を返り値で配り、ログ粒度は呼び出し側が決める）。
  let prefsError: unknown = null;
  const sourcePrefs = await loadSourcePrefs(supabase).catch((e: unknown) => {
    prefsError = e;
    return new Map<string, number>();
  });

  // dead シグナル用（YAT-70）。取れなかったときに空配列へ畳むと全 feed が一斉に dead へ倒れる
  // ので、ここは throw して呼び出し側に止めさせる。
  const { data: recentRows, error: lpErr } = await supabase.rpc(
    "feed_recent_published",
    { sample_size: FEED_HEALTH_THRESHOLDS.CADENCE_SAMPLE },
  );
  if (lpErr)
    throw wrap(
      "feed_recent_published の取得に失敗（migration 0014 未適用の可能性）",
      lpErr,
    );
  const recentPublished = new Map<string, string[]>();
  for (const r of (recentRows ?? []) as {
    feed_id: string;
    published_at: string;
  }[]) {
    const l = recentPublished.get(r.feed_id);
    if (l) l.push(r.published_at);
    else recentPublished.set(r.feed_id, [r.published_at]);
  }

  const inputs: FeedHealthInput[] = active.map((f) => ({
    id: f.id,
    title: f.title,
    url: f.url,
    created_at: f.created_at,
    recentPublishedAt: recentPublished.get(f.id) ?? [],
    credibility: f.credibility,
    near_dup_rate: f.near_dup_rate,
    sourcePref: sourcePrefs.get(f.id) ?? 0,
  }));

  // 母集団は compute-dedup-rate と共有する（near-dup-window）。ここは件数しか要らないので
  // embedding 本体を落とさない軽量経路を使う（差分は fetchWindowFeedCounts の doc を参照）。
  const {
    byFeed: perFeed,
    embedded,
    truncated,
    since,
    byRecipe,
    byFeedRecipe,
  } = await fetchWindowFeedCounts(supabase, now);

  // 窓内の記事「総数」＋ゲート（body_text_len >= 250）を通る件数を feed 別に数える（YAT-77）。
  // 以前は head+count で総数だけ取っていたが、gate 集計と同一スキャン由来にすると
  // 「記事はあるがゲートで弾かれて embed されない」を feed 単位で切り分けられる（0017 の 2 列）。
  const gate = await fetchWindowGateCounts(supabase, now);
  const articlesTotal = gate.articles;

  const rows: FeedObservation[] = inputs.map((input) => {
    const recent = input.recentPublishedAt ?? [];
    const own = perFeed.get(input.id) ?? 0;
    const g = gate.byFeed.get(input.id);
    return {
      input,
      result: evaluateFeedHealth(input, now),
      ageMs: now - Date.parse(input.created_at),
      quietMs: recent.length === 0 ? Infinity : now - Date.parse(recent[0]),
      deadMs: deadThresholdMs(recent),
      windowOwnEmbedded: own,
      ownArticles: Math.min(own, PER_FEED_LIMIT),
      windowOwnArticles: g?.articles ?? 0,
      windowOwnEligible: g?.eligible ?? 0,
      windowOwnRecipe: byFeedRecipe.get(input.id) ?? { legacy: 0, lead: 0 },
    };
  });
  rows.sort((a, b) => b.result.score - a.result.score);

  const majority = majorityRecipe(byRecipe);
  const feedsWithRate = rows.filter(
    (r) => r.input.near_dup_rate !== null,
  ).length;

  return {
    now,
    feeds,
    active,
    rows,
    window: {
      since,
      articles: articlesTotal,
      embedded,
      coverage: articlesTotal === 0 ? 0 : embedded / articlesTotal,
      truncated,
      byRecipe,
      majority,
      coverageByRecipe: {
        legacy: articlesTotal === 0 ? 0 : byRecipe.legacy / articlesTotal,
        lead: articlesTotal === 0 ? 0 : byRecipe.lead / articlesTotal,
      },
      eligible: gate.eligible,
      gateTruncated: gate.truncated,
    },
    prefsError,
    feedsWithRate,
  };
}

/**
 * 窓の健全性を 1 行で説明する（診断の見出しと snapshot の共用）。
 *
 * `truncated` はここでは出さない。呼び出し側が「何が起きるか」まで書いた専用の警告を持っており、
 * 両方出すと同じ事実が 2 回並ぶ。
 */
export function describeWindow(w: ObservationWindow): string {
  const base =
    `窓 ${WINDOW_DAYS}d: 記事 ${w.articles} 件 / embedding 付き ${w.embedded} 件` +
    `（網羅率 ${(w.coverage * 100).toFixed(1)}%）`;
  // 平常時（share 1.0）はレシピ内訳を出さない。移行期（混在）だけ多数派 share を併記する（YAT-77）。
  if (w.majority.share >= 1 || w.majority.total === 0) return base;
  return (
    base +
    `｜legacy ${w.byRecipe.legacy}（${(w.coverageByRecipe.legacy * 100).toFixed(1)}%）` +
    ` / lead ${w.byRecipe.lead}（${(w.coverageByRecipe.lead * 100).toFixed(1)}%）` +
    `・多数派 ${w.majority.recipe} ${w.majority.share.toFixed(2)}`
  );
}

