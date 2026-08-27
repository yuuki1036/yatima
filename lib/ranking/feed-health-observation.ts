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
  WINDOW_DAYS,
  PER_FEED_LIMIT,
} from "./near-dup-window";
import type { Feed } from "../types";

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
  } = await fetchWindowFeedCounts(supabase, now);

  // 窓内の記事「総数」。窓の取得は embedding 非 null に絞っているので別途数える。
  // これが無いと「窓が痩せている」と「そもそも記事が少ない」を区別できない。
  const { count: windowTotal, error: wErr } = await supabase
    .from("articles")
    .select("id", { count: "exact", head: true })
    .gte("published_at", since);
  if (wErr) throw wrap("窓内の記事数の取得に失敗", wErr);
  const articlesTotal = windowTotal ?? 0;

  const rows: FeedObservation[] = inputs.map((input) => {
    const recent = input.recentPublishedAt ?? [];
    const own = perFeed.get(input.id) ?? 0;
    return {
      input,
      result: evaluateFeedHealth(input, now),
      ageMs: now - Date.parse(input.created_at),
      quietMs: recent.length === 0 ? Infinity : now - Date.parse(recent[0]),
      deadMs: deadThresholdMs(recent),
      windowOwnEmbedded: own,
      ownArticles: Math.min(own, PER_FEED_LIMIT),
    };
  });
  rows.sort((a, b) => b.result.score - a.result.score);

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
    },
    prefsError,
  };
}

/**
 * 窓の健全性を 1 行で説明する（診断の見出しと snapshot の共用）。
 *
 * `truncated` はここでは出さない。呼び出し側が「何が起きるか」まで書いた専用の警告を持っており、
 * 両方出すと同じ事実が 2 回並ぶ。
 */
export function describeWindow(w: ObservationWindow): string {
  return (
    `窓 ${WINDOW_DAYS}d: 記事 ${w.articles} 件 / embedding 付き ${w.embedded} 件` +
    `（網羅率 ${(w.coverage * 100).toFixed(1)}%）`
  );
}

