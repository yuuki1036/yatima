// 自動発見候補の provenance（feed_candidates.discovered_from）フォーマットの単一の出典（YAT-36）。
// 生成側（lib/rss/discover-articles.ts）とパース側（lib/feeds/discovery-display.ts）が
// `article-links:Nsrc` という文字列契約で暗黙結合していた（両方 string で型が不整合を検知できず、
// フォーマットを変えると承認 UI のバッジが静かに消える）のを、format / parse のペアと
// プレフィックス定数に集約して明示化する。フォーマットを変えるときはここだけを直せば両側が追従する。

// 方式①（記事リンク発掘）の provenance プレフィックス。方式②以降が別プレフィックスで書くとき、
// パース側はこの接頭辞で厳密に判定するため、方式①の値だけを source count として読む。
const ARTICLE_LINKS_PREFIX = "article-links:";

// 方式①の discovered_from 文字列を組み立てる。
// sourceCount = この候補を参照していた既存ソースの異なり数（人気度）。
export function formatArticleLinksProvenance(sourceCount: number): string {
  return `${ARTICLE_LINKS_PREFIX}${sourceCount}src`;
}

// discovered_from から参照元ソースの異なり数を取り出す。方式①のプレフィックスに合致し、
// 続きが `Nsrc`（N は正の整数）の形のときだけ数値を返す。想定外フォーマット・欠損・0 は null。
export function parseArticleLinksSourceCount(
  discoveredFrom: string | null,
): number | null {
  if (!discoveredFrom || !discoveredFrom.startsWith(ARTICLE_LINKS_PREFIX)) {
    return null;
  }
  const m = discoveredFrom.slice(ARTICLE_LINKS_PREFIX.length).match(/^(\d+)src$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}
