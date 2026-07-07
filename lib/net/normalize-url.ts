// URL を重複排除キー用に正規化する（YAT-32）。表記ゆれ（scheme/host 大小・末尾スラッシュ・www・
// トラッキングクエリ・フラグメント）で同一 docs が二重投入されるのを防ぐ。learn_sources.url の
// unique 制約と組み合わせ、insert は upsert(ignoreDuplicates) で並行時の衝突を吸収する。
// パースできない入力は null（呼び出し側で弾く）。

// 除去するトラッキング/計測クエリ（意味のあるクエリ＝docs のバージョン等は残す）。
const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
];

export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  // host は小文字化し、先頭 www. を落とす（www 有無で割れないように）。
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");

  // フラグメント（#section）は同一ページなので落とす。
  u.hash = "";

  // トラッキングクエリを除去し、残りはキー昇順で安定化する。
  for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
  u.searchParams.sort();

  // 末尾スラッシュを畳む（ルート "/" は残す）。search を跨がないよう pathname だけ処理する。
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }

  return u.toString();
}
