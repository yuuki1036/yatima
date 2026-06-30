// 外部由来 URL を fetch する処理の一次 SSRF ガード。候補/記事リンク URL は第三者コンテンツ
// 由来で信頼できないため、http/https 以外と内部・予約レンジ（localhost / ループバック /
// リンクローカル 169.254 / RFC1918 / CGN / ユニークローカル IPv6）を弾く。通れば正規化済み
// URL を、弾けば null を返す。
// 名前解決後の IP 判定（DNS リバインディング厳密対策）まではやらず、最安の一次防御に絞る。
// 外部 URL を fetch する各所で共有する。
export function isPubliclyRoutableHttpUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return null;
  }

  // IPv4 リテラル
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (
      a === 0 ||
      a === 127 || // ループバック
      a === 10 || // RFC1918
      (a === 169 && b === 254) || // リンクローカル（クラウドメタデータ含む）
      (a === 172 && b >= 16 && b <= 31) || // RFC1918
      (a === 192 && b === 168) || // RFC1918
      (a === 100 && b >= 64 && b <= 127) // CGN（RFC6598）
    ) {
      return null;
    }
  }

  // IPv6 リテラル（角括弧表記）。ループバック / 未指定 / リンクローカル / ユニークローカルを弾く
  if (host.startsWith("[")) {
    const v6 = host.replace(/^\[|\]$/g, "");
    if (
      v6 === "::1" ||
      v6 === "::" ||
      v6.startsWith("fe80") ||
      v6.startsWith("fc") ||
      v6.startsWith("fd")
    ) {
      return null;
    }
  }

  return u;
}
