// 情報源の自動発見（YAT-16）の承認 UI 向け表示ヘルパー（YAT-26）。
// 承認/却下の判断材料を候補行に出すための純粋関数。ランキング計算には使わない。

import { parseArticleLinksSourceCount } from "./discovered-from";

export type CredibilityLevel = "high" | "mid" | "low";

// credibility（feeds/feed_candidates の静的 prior, YAT-14）を人間可読な 3 段階へ落とす。
// 値域は -0.8〜1.5 の連続値（0005 migration）。しきい値は手動 prior の分布に合わせ、
// 高=1.0+（研究ブログ・一次情報源）／中=0.3+（AI 特化メディア）／
// 低=それ未満（汎用アグリゲータ・未検証の自動発見初期値 -0.3）とする。
export function credibilityLevel(value: number): CredibilityLevel {
  if (value >= 1.0) return "high";
  if (value >= 0.3) return "mid";
  return "low";
}

export const CREDIBILITY_LABELS: Record<CredibilityLevel, string> = {
  high: "高",
  mid: "中",
  low: "低",
};

// 自動発見候補の discovered_from から参照元ソースの異なり数を取り出す。「何媒体がこの候補に
// リンクしていたか」を表し、多くの信頼ソースから参照される候補ほど承認価値が高い、という
// 承認 UI の判断材料になる。フォーマットの生成/パースは discovered-from.ts に集約してあり
// （YAT-36）、ここは表示ヘルパーとして UI 語彙の名前で再公開する。
export const discoverySourceCount = parseArticleLinksSourceCount;

// 参照元ソース数が 2 以上なら「複数の独立ソースが参照」＝相対的に強いシグナルとして強調する。
export const NOTABLE_SOURCE_COUNT = 2;
