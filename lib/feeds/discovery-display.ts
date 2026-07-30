// 情報源の自動発見（YAT-16）の承認 UI 向け表示ヘルパー（YAT-26）。
// 承認/却下の判断材料を候補行に出すための純粋関数。ランキング計算には使わない。

import {
  parseArticleLinksSourceCount,
  parsePreferenceTagSlug,
} from "./discovered-from";
import { tagLabel } from "@/lib/tags/vocabulary";

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
// 発見側の登録ゲート MIN_DISTINCT_SOURCES（lib/rss/discover-articles.ts）と同じ閾値・同じ語彙。
// 層が違うため定数は共有せず、相互参照のみ張っている。
// YAT-65 以降のバッジ分布: ゲートは「2 媒体以上 **または** ブログ形」なので 1 媒体の候補も通り、
// 実測では新規候補の多数が 1 媒体（＝非強調）になる。つまり強調は「原則すべて立つ」ではなく
// **少数の強シグナルを際立たせる側に役割が反転した**。強調の情報量は失われていない。
export const NOTABLE_SOURCE_COUNT = 2;

// 方式②（嗜好ベース提案・YAT-38）候補の発見経路ラベルを返す。discovered_from が方式②の
// フォーマットなら起点タグの日本語ラベル（例「AI・機械学習」）を、そうでなければ null を返す。
// 承認 UI で「{ラベル} から発見」バッジを出し、方式①（媒体参照数）と発見経路を出し分ける。
// tagLabel は未知 slug をそのまま返すため、語彙外でも表示は壊れない。
export function discoveryPreferenceLabel(
  discoveredFrom: string | null,
): string | null {
  const slug = parsePreferenceTagSlug(discoveredFrom);
  return slug === null ? null : tagLabel(slug);
}
