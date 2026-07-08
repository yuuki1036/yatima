// 線形ランキングのスコア純関数。
//   score = 新しさ減衰 + Σ(記事に付いたタグの tag_pref) + ソース嗜好(source_pref) + ソース信頼度(credibility)
// 引数だけに依存する純関数にし、`now` / `tagPrefs` / `sourcePrefs` / `credibility` を注入することで
// フィード1本でも複数でも同じ関数で計算でき、DB なしでユニットテストできる。
// credibility は feeds 列由来の静的 prior（嗜好は学習・信頼度は手当ての固定値）で役割が異なる。

const RECENCY_HALF_LIFE_HOURS = 24; // 新しさ減衰の半減期（24h で 0.5 倍）

// published_at の古さに応じて 1→0 に減衰する半減期型の係数。
export function recencyDecay(
  publishedAt: string | null,
  now: number = Date.now(),
): number {
  if (!publishedAt) return 0;
  const ageH = (now - new Date(publishedAt).getTime()) / 3_600_000;
  if (!Number.isFinite(ageH)) return 0;
  if (ageH < 0) return 1; // 未来日付（時計ズレ）は最新扱い
  return Math.pow(0.5, ageH / RECENCY_HALF_LIFE_HOURS);
}

export type ScoreInput = {
  publishedAt: string | null;
  tags: string[];
  tagPrefs: Map<string, number>; // preferences(kind='tag') を Map 化したもの
  sourceId?: string | null; // 記事のフィード id（preferences(kind='source') のキー）
  sourcePrefs?: Map<string, number>; // preferences(kind='source') を Map 化したもの
  credibility?: number; // feeds.credibility（静的なソース信頼度の prior）
  now?: number;
};

// 嗜好成分だけを取り出す純関数（学習値 = Σ タグ嗜好 + ソース嗜好）。recency・credibility は含まない。
// 「嗜好の押し上げ／押し下げがどれだけ効いているか」を score から分離して見るために使う
// （YAT-37 探索枠: 嗜好が中立（≈0）な未知トピックを選ぶ判定に必要）。
export function preferenceScore(input: {
  tags: string[];
  tagPrefs: Map<string, number>;
  sourceId?: string | null;
  sourcePrefs?: Map<string, number>;
}): number {
  const tagScore = input.tags.reduce(
    (s, t) => s + (input.tagPrefs.get(t) ?? 0),
    0,
  );
  const sourceScore =
    input.sourceId && input.sourcePrefs
      ? (input.sourcePrefs.get(input.sourceId) ?? 0)
      : 0;
  return tagScore + sourceScore;
}

export function score(input: ScoreInput): number {
  const now = input.now ?? Date.now();
  const recency = recencyDecay(input.publishedAt, now);
  const pref = preferenceScore(input);
  const credibility = input.credibility ?? 0;
  // コールドスタート（pref 全 0）時は pref=0 に縮退し、score = recency + credibility。
  // 信頼ソースが上に、汎用アグリゲータが下に来る「厳選された新着順」になる。
  return recency + pref + credibility;
}
