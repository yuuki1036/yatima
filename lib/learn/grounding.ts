// YAT-27: 決定的 grounding ゲートの型非依存プリミティブ。
// card-gate.ts（YAT-17）の qa/cloze 密結合な照合ロジックから純粋関数だけを切り出し、
// MCQ（quiz-gate.ts）と qa/cloze（card-gate.ts）の双方が各々 target を組んで呼べるようにする（F4）。
// LLM 出力の逐語照合という一次防御をここに集約し、型ごとの分岐は呼び出し側に閉じる。

// ── grounding 閾値（design doc open「grounding 強度下限」の起点値・PoC で較正前提）─────
export const MIN_QUOTE_CHARS = 24; // source_quote の最小文字数（日本語記事の主防御。短い断片を弾く）
export const MIN_OVERLAP = 0.12; // source_quote と設問本体の最小語彙重なり（無関係な前書き抜粋を弾く）

// 本文照合の母体テキストの上限。要約用の 2000 字では grounding 母体として短すぎ逐語照合が落ちる
// ため、本文を厚めに取る（content_html 全体に近い長さ）。
export const GROUND_BODY_MAX_CHARS = 20_000;

// 照合用に正規化（連続空白を1つに・前後 trim・小文字化）。HTML 起因の空白差で逐語照合が落ちるのを防ぐ。
export function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// 4 文字以上の英数字連なり、または 3 文字以上の漢字/カナ連なりを「固有寄りトークン」として拾う。
// 汎用ひらがな短句だけの source_quote（「だと思います」等）を弾くための固有性チェックに使う。
export function specificTokens(s: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of s.matchAll(/[a-z0-9]{4,}/gi)) tokens.add(m[0].toLowerCase());
  for (const m of s.matchAll(/[一-鿿゠-ヿ]{3,}/g)) tokens.add(m[0]);
  return tokens;
}

// 2 つのテキストの固有寄りトークン集合の Jaccard 類似（source_quote と設問の語彙重なり判定用）。
export function jaccardSpecific(a: string, b: string): number {
  const sa = specificTokens(a);
  const sb = specificTokens(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

// 逐語 grounding 照合（決定的・型非依存）。判定順序は安く効く制約から: ①長さ → ②逐語 → ③固有性
// → ④設問関連。短い汎用語での素通り（骨抜き）を順序で防ぐ。
// - quoteRaw: LLM が付けた原文抜粋（生。呼び出し側で norm しない）
// - groundBodyNorm: norm() 済みの照合母体（本文）。呼び出し側で一度だけ norm して使い回す想定
// - targetRaw: 設問本体（MCQ なら stem + choices、qa なら front+back 等）。抜粋が設問と無関係でないか照合
export function isQuoteGrounded(
  quoteRaw: string,
  groundBodyNorm: string,
  targetRaw: string,
): boolean {
  const q = norm(quoteRaw);

  // ① 最小長（1 文未満の断片を弾く）
  if (q.length < MIN_QUOTE_CHARS) return false;

  // ② 逐語照合（原文の部分文字列であること＝幻覚抜粋を弾く中核）
  if (!groundBodyNorm.includes(q)) return false;

  // ③ 固有性（記事固有の語を含むこと。汎用句が偶然 includes を通すのを弾く）
  if (specificTokens(q).size === 0) return false;

  // ④ 設問本体との語彙重なり（quote が設問と無関係な箇所の抜粋なのを弾く）
  if (jaccardSpecific(q, norm(targetRaw)) < MIN_OVERLAP) return false;

  return true;
}
