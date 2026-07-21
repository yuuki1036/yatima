// 診断スクリプト共通の表示ヘルパ。3 本が同じ表形式で出すため、幅計算をここに集約する
// （feed 名や concept_label に日本語・絵文字が入るので、素の padEnd では列が揃わない）。

// 端末上の表示幅を返す。全角（CJK・ハングル・全角記号）と絵文字を 2 幅として数える。
// Intl.Segmenter を使わず code point 単位で判定する（絵文字の ZWJ 連結までは追わない割り切り。
// feed 名に単発の絵文字が入る程度なら正しく揃う）。
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // ハングル字母
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首・記号
    (cp >= 0x3041 && cp <= 0x33ff) || // かな・ハングル互換・CJK 互換
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 拡張 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 統合漢字
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || // ハングル音節
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 互換漢字
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // 全角英数・記号（半角カナ FF61-FF9F は除く）
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) || // 絵文字
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 拡張 B 以降
  );
}

// 表示幅 n に切り詰めてから右詰めパディングする（列を揃える用）。
export function padEndWide(s: string, n: number): string {
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
    if (w + cw > n) break;
    out += ch;
    w += cw;
  }
  return out + " ".repeat(Math.max(0, n - w));
}

// 表示幅 n で左詰めパディングする（数値列用。切り詰めはしない）。
export function padStartWide(s: string, n: number): string {
  return " ".repeat(Math.max(0, n - displayWidth(s))) + s;
}

// 分子/分母をパーセント表記にする。分母 0 は「―」。
export function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "―";
}
