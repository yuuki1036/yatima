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
  // dead: 発信が止まっている（YAT-70 で再定義）。判定は「その feed 自身の投稿間隔」を基準にした
  // 適応閾値で行う。閾値は max(DEAD_DAYS, DEAD_STALL_MULTIPLIER × 投稿間隔の中央値)。
  //
  // 旧定義は last_fetched_at ベースだったが、この列は ingest の「取得成功時」に更新されるため
  // 測れるのは「こちらが取得できているか」であって「発信元が止まったか」ではなかった。実測でも
  // active 34 feed すべてが取得停滞 0.0d（＝誰にも立たない）である一方、発信が止まっている
  // feed を 1 件も検出していなかった。取得失敗の検知は YAT-68 で ingest 側（6 時間で CI を
  // 赤くする）に移したので、ここは発信停滞に専念する。
  //
  // 固定閾値にしなかったのは実測による。14 日固定では 4 件中 2 件が誤検知だった:
  //   Berkeley BAIR   中央値 38.0d / 沈黙 15.2d → 通常運転（誤検知）
  //   Ahead of AI     中央値 25.0d / 沈黙 26.1d → 月刊の通常運転（誤検知）
  //   VentureBeat AI  中央値  3.0d / 沈黙 27.8d → 本当に停滞
  //   PFN Tech Blog   中央値  7.9d / 沈黙 27.6d → 本当に停滞
  // 発信間隔は feed ごとに自然なスケールが違う（日刊〜月刊）ので、固定閾値だと「低頻度だが
  // 健全」な媒体が構造的に誤検知になる。near_dup の一次ソース誤判定と同じ族の問題。
  //
  // DEAD_DAYS は適応閾値の**下限**として働く。高頻度 feed（中央値 0.1d 等）で閾値が数時間まで
  // 縮み、一度の休載で dead になるのを防ぐ。
  DEAD_DAYS: 14,
  // 投稿間隔の中央値の何倍の沈黙を「停滞」とみなすか。実測 4 件はこの値で完全に分離する
  // （誤検知 2 件は 0.4 倍 / 1.04 倍、真陽性 2 件は 9.3 倍 / 3.5 倍）。暫定値。
  DEAD_STALL_MULTIPLIER: 2.5,
  // 中央値の算出に使う直近記事の件数。少なすぎると中央値が不安定、多すぎると過去の刊行ペースを
  // 引きずる。RPC(feed_recent_published) の sample_size と揃えること。
  CADENCE_SAMPLE: 15,
  // 新規 feed の誤検知ガード: 追加から猶予日数が経つまで dead 判定しない。
  // 追加直後でまだ記事が 1 件も入っていない feed を「死亡」と誤らないため。
  NEW_FEED_GRACE_DAYS: 3,
  // 信頼度がこの値未満（汎用アグリゲータ下限域。0=中立 / -0.8=最低）。
  //
  // -0.4 なのは境界がシード値と重ならないようにするため（YAT-55 観測 ⑥）。元は -0.3 だったが
  // credibility のシード値は離散的な段（-0.8 / -0.5 / -0.3 / 0.0 / 0.3 / 0.5 / 0.8 / 1.0 / 1.5）で、
  // -0.3 ちょうどの feed が 6 件（active の 18%）ある。strict 比較の閾値を分布の**山の上**に置くと
  // 「等号ひとつで 6 feed の判定が反転する」不安定な状態になり、実際 F の指摘として 2 回持ち越された。
  // -0.5 と -0.3 の間には feed が 1 つも無いので、-0.4 に寄せれば挙動は現状と完全に同じまま
  // （-0.5 / -0.8 は立つ、-0.3 は立たない）境界の曖昧さだけが消える。
  // 「-0.3 を低信頼に含めるか」は値の問題として較正で決める（今は含めない側を明示的に選択）。
  LOW_CREDIBILITY: -0.4,
  // ソース嗜好 weight がこの値未満（dismiss(-1.1) が 2 回累積で超える水準。1 回では外さない）。
  LOW_PREF: -2.0,
  // near-dup 率がこの値以上を「重複量産」とみなす。
  //
  // 0.5 は near_dup が**無向**だった頃の値（「記事の半数以上が他 feed と重複」）。YAT-70 で
  // 有向化（dup と数えるのは「より早く公開した他 feed と一致」した場合のみ）した際、決定 4-C は
  // 「0.5 のままでは near_dup が永久に発火しない」として暫定値の設定を求めていたが、
  // **実装で落ちていた**（YAT-55 観測 ⑥ で発覚。08-14〜08-26 の 12 日間シグナルは沈黙）。
  //
  // 0.20 の根拠は無向→有向のスケール変化。同一母集団で両方を測った 2026-08-13 の実測では
  // 有向値は無向値の約 0.4 倍（中央値）になる:
  //   テクノエッジ 0.23→0.19 / ITmedia 0.21→0.16 / タグAI 0.42→0.17 / Zenn生成AI 0.40→0.16
  //   Zenn機械学習 0.28→0.06 / Latent.Space 0.19→0.14 / Zenn AI 0.18→0.06 / DeepMind 0.67→0.00
  // 0.5 × 0.4 ≒ 0.20。この値で立つのは後追い型ニュース媒体（ITmedia AI+ 0.21 /
  // テクノエッジ 0.20）で、決めること 4 の実測が「転載側」と特定した feed と一致する。
  //
  // **暫定値。** 観測 ⑥ は要約全滅（YAT-73）で汚染された窓の値であり、テクノエッジは境界上に
  // 乗っている。feed_health_snapshots に健全な系列が貯まったら較正すること。
  NEAR_DUP_RATE: 0.2,
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
   * この feed の直近記事の公開日（新しい順・最大 CADENCE_SAMPLE 件。YAT-70 で
   * last_fetched_at から差し替え）。最新値と投稿間隔の中央値の両方をここから導く。
   *
   * 三状態を意図的に区別する:
   *   - 非空配列 … 先頭が最新の公開日。2 件以上あれば投稿間隔の中央値も出せる
   *   - `[]`（空配列） … 記事が 1 件も無い。新規猶予を過ぎていれば dead
   *   - `undefined` … **取得できなかった（未知）**。dead 判定自体をスキップする
   *
   * undefined が要るのは、供給元が RPC（feed_recent_published）で失敗しうるため。ここで
   * 空配列に畳むと「記事が無い」と同じ扱いになり、RPC 未適用・一時障害のときに **全 feed が
   * 一斉に dead へ倒れる**。シグナルを黙らせる方が、全件を誤って退役推奨に出すより安全。
   */
  recentPublishedAt: string[] | undefined;
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

/**
 * 直近の公開日リスト（新しい順）から「最後の発信からの経過ミリ秒」を出す。
 * 記事ゼロは Infinity（＝未発信）。先頭がパース不能なら NaN を返し、呼び出し側の比較で
 * dead が立たない側に倒れる。
 */
function quietMillis(recent: string[], now: number): number {
  if (recent.length === 0) return Infinity;
  return now - Date.parse(recent[0]);
}

/**
 * その feed 自身の投稿間隔から dead の閾値（ミリ秒）を出す。
 *
 * `max(DEAD_DAYS, DEAD_STALL_MULTIPLIER × 投稿間隔の中央値)`。
 * 中央値を使うのは、長期休載や連投といった外れ値に平均より強いため。サンプルが 2 件未満で
 * 間隔が 1 つも取れない場合は DEAD_DAYS だけで判定する（そこにしか根拠が無いので）。
 */
export function deadThresholdMs(recent: string[]): number {
  const t = FEED_HEALTH_THRESHOLDS;
  const floor = t.DEAD_DAYS * DAY_MS;
  const times = recent
    .slice(0, t.CADENCE_SAMPLE)
    .map((s) => Date.parse(s))
    .filter((n) => Number.isFinite(n));
  if (times.length < 2) return floor;

  // recent は新しい順なので、隣接差は times[i] - times[i+1] が正になる。
  const gaps: number[] = [];
  for (let i = 0; i < times.length - 1; i += 1) gaps.push(times[i] - times[i + 1]);
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median =
    gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;

  return Math.max(floor, median * t.DEAD_STALL_MULTIPLIER);
}

// 1 feed を評価して理由タグ・スコア・推奨可否を返す（純関数）。
export function evaluateFeedHealth(
  input: FeedHealthInput,
  now: number = Date.now(),
): RetireSuggestion {
  const t = FEED_HEALTH_THRESHOLDS;
  const reasons: RetireReason[] = [];

  // dead: 新規ガードを通過した上で、沈黙がその feed 自身の投稿間隔に照らして長すぎる。
  // recentPublishedAt が undefined（＝取得できなかった）ときは判定自体を見送る。型定義の注釈を参照。
  const ageMs = now - Date.parse(input.created_at);
  const isNew = ageMs < t.NEW_FEED_GRACE_DAYS * DAY_MS;
  if (!isNew && input.recentPublishedAt !== undefined) {
    const quietMs = quietMillis(input.recentPublishedAt, now);
    // Date.parse 不能な値は NaN になり、比較が false になって dead を立てない（安全側）。
    if (quietMs > deadThresholdMs(input.recentPublishedAt)) reasons.push("dead");
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
