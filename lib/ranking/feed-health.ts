import { DEDUP_THRESHOLD } from "./dedup";

// feed の「削除推奨」判定（YAT-20）。4 シグナルをハイブリッド方式で評価する:
//   - 各シグナルを独立した閾値フラグで判定し、1 つでも立てば「推奨」
//   - 並び順は各フラグの加重合計スコア（大きいほど要対処）
//   - 表示は理由タグ（dead / 低信頼 / 嗜好低 / 重複量産）
// 純関数に閉じて単体検証可能にし、DB I/O は呼び出し側（page / cron）に任せる。
// 閾値・加重は運用しながら調整する暫定値（DEDUP_THRESHOLD と同じ tunable 思想で定数集約）。

export type RetireReason = "dead" | "low_credibility" | "low_pref" | "near_dup";

// 理由タグの表示ラベル（UI と算出で同一語彙を使うため単一の出典に集約）。
export const RETIRE_REASON_LABELS: Record<RetireReason, string> = {
  dead: "DEAD",
  low_credibility: "低信頼",
  low_pref: "嗜好低",
  near_dup: "重複量産",
};

// 閾値（暫定値・運用で調整）。
export const FEED_HEALTH_THRESHOLDS = {
  // dead: 最新記事の公開からこの日数より古い ＝ 発信が止まっている（YAT-70 で再定義）。
  //
  // 旧定義は last_fetched_at ベースだったが、この列は ingest の「取得成功時」に更新されるため
  // 測れるのは「こちらが取得できているか」であって「発信元が止まったか」ではなかった。実測でも
  // active 34 feed すべてが取得停滞 0.0d（＝誰にも立たない）である一方、発信が 14 日以上
  // 止まっている feed が 4 件あり、そのすべてを取り逃していた。取得失敗の検知は YAT-68 で
  // ingest 側（6 時間で CI を赤くする）に移したので、ここは発信停滞に専念する。
  //
  // 14 日を据え置いたのは実測の分布による: >14d が 4 件（15〜28d）で 5 番目が 6.5d と
  // ギャップがあり、現データでは分離点として機能する。低頻度が正常な媒体（週刊ニュースレター等）
  // と本当に止まった feed を一律閾値で分けられない問題は残る（YAT-55 の較正へ持ち越し）。
  DEAD_DAYS: 14,
  // 新規 feed の誤検知ガード: 追加から猶予日数が経つまで dead 判定しない。
  // 追加直後でまだ記事が 1 件も入っていない feed を「死亡」と誤らないため。
  NEW_FEED_GRACE_DAYS: 3,
  // 信頼度がこの値未満（汎用アグリゲータ下限域。0=中立 / -0.8=最低）。
  LOW_CREDIBILITY: -0.3,
  // ソース嗜好 weight がこの値未満（dismiss(-1.1) が 2 回累積で超える水準。1 回では外さない）。
  LOW_PREF: -2.0,
  // near-dup 率がこの値以上（記事の半数以上が他 feed と重複 = 付加価値ほぼゼロ）。
  NEAR_DUP_RATE: 0.5,
} as const;

// 並び順用の加重。dead を最重視し、重複量産 > 嗜好低 > 低信頼 の順。
export const RETIRE_SIGNAL_WEIGHTS: Record<RetireReason, number> = {
  dead: 3.0,
  near_dup: 2.5,
  low_pref: 2.0,
  low_credibility: 1.5,
};

// 1 feed 分の評価入力（DB から取得済みの生値）。
export type FeedHealthInput = {
  id: string;
  title: string | null;
  url: string;
  created_at: string;
  /**
   * この feed の最新記事の公開日（YAT-70 で last_fetched_at から差し替え）。
   *
   * 三状態を意図的に区別する:
   *   - `string` … 最新記事の公開日。dead は「これが DEAD_DAYS より古いか」で判定する
   *   - `null`   … 記事が 1 件も無い。新規猶予を過ぎていれば dead
   *   - `undefined` … **取得できなかった（未知）**。dead 判定自体をスキップする
   *
   * undefined が要るのは、供給元が RPC（feed_latest_published）で失敗しうるため。ここで
   * null に畳むと「記事が無い」と同じ扱いになり、RPC 未適用・一時障害のときに **全 feed が
   * 一斉に dead へ倒れる**。シグナルを黙らせる方が、全件を誤って退役推奨に出すより安全。
   *
   * この三状態の扱いは **型で強制されている**: 判定側の undefined チェックを外すと
   * `Date.parse(string | undefined)` が TS2345 で落ちる（ミューテーションで確認済み。
   * テストでは殺せないが tsc が殺す）。
   */
  latestPublishedAt: string | null | undefined;
  credibility: number;
  near_dup_rate: number | null; // null = 未算出
  sourcePref: number; // preferences(kind='source', key=id).weight、未登録は 0
};

// 評価結果。recommend=true のものだけ UI に出す。score は並び順用。
export type RetireSuggestion = {
  id: string;
  title: string | null;
  url: string;
  recommend: boolean;
  score: number;
  reasons: RetireReason[];
};

const DAY_MS = 86_400_000;

// 1 feed を評価して理由タグ・スコア・推奨可否を返す（純関数）。
export function evaluateFeedHealth(
  input: FeedHealthInput,
  now: number = Date.now(),
): RetireSuggestion {
  const t = FEED_HEALTH_THRESHOLDS;
  const reasons: RetireReason[] = [];

  // dead: 新規ガードを通過した上で、最新記事の公開が DEAD_DAYS より古い（記事ゼロも含む）。
  // latestPublishedAt が undefined（＝取得できなかった）ときは判定自体を見送る。詳細は型定義の注釈。
  const ageMs = now - Date.parse(input.created_at);
  const isNew = ageMs < t.NEW_FEED_GRACE_DAYS * DAY_MS;
  if (!isNew && input.latestPublishedAt !== undefined) {
    const quietMs =
      input.latestPublishedAt === null
        ? Infinity // 記事が 1 件も無い（猶予は上で通過済み）
        : now - Date.parse(input.latestPublishedAt);
    // Date.parse 不能な値は NaN になり、比較が false になって dead を立てない（安全側）。
    if (quietMs > t.DEAD_DAYS * DAY_MS) reasons.push("dead");
  }

  if (input.credibility < t.LOW_CREDIBILITY) reasons.push("low_credibility");
  if (input.sourcePref < t.LOW_PREF) reasons.push("low_pref");
  if (input.near_dup_rate !== null && input.near_dup_rate >= t.NEAR_DUP_RATE)
    reasons.push("near_dup");

  const score = reasons.reduce((s, r) => s + RETIRE_SIGNAL_WEIGHTS[r], 0);
  return {
    id: input.id,
    title: input.title,
    url: input.url,
    recommend: reasons.length > 0,
    score,
    reasons,
  };
}

// 全 feed を評価し、推奨されたものだけをスコア降順で返す（UI セクション用）。
export function computeRetireSuggestions(
  inputs: FeedHealthInput[],
  now: number = Date.now(),
): RetireSuggestion[] {
  return inputs
    .map((f) => evaluateFeedHealth(f, now))
    .filter((s) => s.recommend)
    .sort((a, b) => b.score - a.score);
}

// near-dup 率の算出に使う cosine 閾値を再公開（cron スクリプトと判定で同一値を使う）。
export { DEDUP_THRESHOLD };
