// IPv4 の内部・予約レンジ判定。列挙する各レンジは先頭 2 オクテットで判別できる。
// IPv4 リテラルと IPv4-mapped IPv6 の双方から再利用する。
function isPrivateOrReservedV4(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 127 || // ループバック
    a === 10 || // RFC1918
    (a === 169 && b === 254) || // リンクローカル（クラウドメタデータ含む）
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    (a === 100 && b >= 64 && b <= 127) // CGN（RFC6598）
  );
}

// IPv4-mapped IPv6 から先頭 2 オクテットを取り出す。mapped でなければ null。
// このガードは常に new URL() 正規化後の hostname を渡すため、mapped は WHATWG シリアライザにより
// 必ず 16 進 2 グループ表記になる（[::ffff:127.0.0.1] → ::ffff:7f00:1）。上位グループの
// 上位/下位バイトが第 1/第 2 オクテット。
function mappedV4Octets(v6: string): [number, number] | null {
  const hex = v6.match(/^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    return [(hi >> 8) & 0xff, hi & 0xff];
  }
  return null;
}

// 外部由来 URL を fetch する処理の一次 SSRF ガード。候補/記事リンク URL は第三者コンテンツ
// 由来で信頼できないため、http/https 以外と内部・予約レンジ（localhost / ループバック /
// リンクローカル 169.254 / RFC1918 / CGN / ユニークローカル IPv6 / IPv4-mapped IPv6）を弾く。
// 通れば正規化済み URL を、弾けば null を返す。
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
  if (v4 && isPrivateOrReservedV4(Number(v4[1]), Number(v4[2]))) {
    return null;
  }

  // IPv6 リテラル（角括弧表記）。ループバック / 未指定 / リンクローカル / ユニークローカルに
  // 加え、IPv4-mapped IPv6（::ffff:127.0.0.1 → ::ffff:7f00:1 等）が内部 IPv4 を包んでいる場合も弾く。
  if (host.startsWith("[")) {
    const v6 = host.replace(/^\[|\]$/g, "");
    const mapped = mappedV4Octets(v6);
    if (
      v6 === "::1" ||
      v6 === "::" ||
      /^fe[89ab]/.test(v6) || // リンクローカル fe80::/10（fe80〜febf。前方一致 "fe80" だと fe9x〜febx を取りこぼす）
      v6.startsWith("fc") || // ユニークローカル fc00::/7（fc・fd）
      v6.startsWith("fd") ||
      (mapped !== null && isPrivateOrReservedV4(mapped[0], mapped[1]))
    ) {
      return null;
    }
  }

  return u;
}
