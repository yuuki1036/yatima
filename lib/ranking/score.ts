// 線形ランキングのスコア純関数。
//   score = 新しさ減衰 + Σ(記事に付いたタグの tag_pref)
// 引数だけに依存する純関数にし、`now` / `tagPrefs` を注入することで
// フィード1本でも複数でも同じ関数で計算でき、DB なしでユニットテストできる。

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
  now?: number;
  // 将来: sourceId?, sourcePrefs? を足してソース項を加算する
};

export function score(input: ScoreInput): number {
  const now = input.now ?? Date.now();
  const recency = recencyDecay(input.publishedAt, now);
  const tagScore = input.tags.reduce(
    (s, t) => s + (input.tagPrefs.get(t) ?? 0),
    0,
  );
  // コールドスタート（tagPrefs 全 0）時は tagScore=0 となり実質「新着順」に縮退する。
  return recency + tagScore;
  // 将来: + sourceTerm(input.sourceId, input.sourcePrefs)
}
