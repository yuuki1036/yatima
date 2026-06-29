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
  // dead: last_fetched_at がこの日数より古い（ingest は毎時・成功時のみ更新するため、
  // この長さ放置 = 取得失敗の継続を強く示唆）。
  DEAD_DAYS: 14,
  // 新規 feed の誤検知ガード: 追加から猶予日数（ingest 約 72 回分）が経つまで dead 判定しない。
  // 追加直後で last_fetched_at=null の feed を「死亡」と誤らないため。
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
  last_fetched_at: string | null;
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

  // dead: 新規ガードを通過した上で、last_fetched_at が無い or DEAD_DAYS より古い。
  const ageMs = now - Date.parse(input.created_at);
  const isNew = ageMs < t.NEW_FEED_GRACE_DAYS * DAY_MS;
  if (!isNew) {
    const staleMs =
      input.last_fetched_at === null
        ? Infinity
        : now - Date.parse(input.last_fetched_at);
    if (staleMs > t.DEAD_DAYS * DAY_MS) reasons.push("dead");
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
