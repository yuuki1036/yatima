// YAT-27: 決定的 grounding ゲートの型非依存プリミティブ。
// card-gate.ts（YAT-17）の qa/cloze 密結合な照合ロジックから純粋関数だけを切り出し、
// MCQ（quiz-gate.ts）と qa/cloze（card-gate.ts）の双方が各々 target を組んで呼べるようにする（F4）。
// LLM 出力の逐語照合という一次防御をここに集約し、型ごとの分岐は呼び出し側に閉じる。

// ── grounding 閾値（design doc open「grounding 強度下限」の起点値）─────
// YAT-58 時点の状態: どちらも「較正前提の仮値」ではなくなっている。下の groundingReason の注記も参照。
export const MIN_QUOTE_CHARS = 24; // source_quote の最小文字数（日本語記事の主防御。短い断片を弾く）
// 較正対象から外した（YAT-58）。MCQ・card 両経路の計測とも①の棄却が 0 件で、動かす根拠になる
// 観測データが出ない。値を変える前にまず①が発火する条件を観測すること。
export const MIN_OVERLAP = 0.12; // source_quote と設問本体の最小語彙重なり（無関係な前書き抜粋を弾く）
// 呼び出し側が④を無効化（0 を渡す）したため、この既定値を使う経路は実質デッド。下の注記を参照。

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

// grounding 照合の判定結果。pass 以外はどの段で落ちたかを示す（診断・較正用。YAT-30）。
export type GroundingReason =
  | "pass"
  | "too_short" // ①最小長 未満
  | "not_verbatim" // ②逐語照合 失敗（原文の部分文字列でない）
  | "not_specific" // ③固有性 なし（固有寄りトークンを含まない）
  | "low_overlap"; // ④設問本体との語彙重なり 不足

// 逐語 grounding 照合（決定的・型非依存）。判定順序は安く効く制約から: ①長さ → ②逐語 → ③固有性
// → ④設問関連。短い汎用語での素通り（骨抜き）を順序で防ぐ。どの段で落ちたかを返す（診断用）。
// - quoteRaw: LLM が付けた原文抜粋（生。呼び出し側で norm しない）
// - groundBodyNorm: norm() 済みの照合母体（本文）。呼び出し側で一度だけ norm して使い回す想定
// - targetRaw: 設問本体（MCQ なら stem + choices、qa なら front+back 等）。抜粋が設問と無関係でないか照合
// minOverlap: ④の語彙重なり閾値。0 を渡すと④は無効化される。
// 英語記事の逐語引用×日本語の設問/カードでは quote と target の固有トークンが言語違いでほぼ重ならず、
// jaccard が構造的に 0 へ潰れて④が支配的な棄却要因になる（YAT-30: MCQ で生成の 69%、
// YAT-58: card で生成の 68%・通過率 12%）。このため呼び出し側 2 経路とも④を無効化している
// （quiz-gate の QUIZ_MIN_OVERLAP=0 / card-gate の CARD_MIN_OVERLAP=0）。いずれも②逐語＋
// ③固有性に依拠する（正誤の真偽は元々④では検証しておらず F2 の別軸）。
// 稼働状況は非対称: 現用の cron 経路は quiz-gate のみ。card-gate は YAT-27 で凍結済みで、
// card 側の④無効化は本番で運用実績が無い（詳細は card-gate.ts の CARD_MIN_OVERLAP を参照）。
// 注意: 既定値 MIN_OVERLAP を使う呼び出し側はもう無い（診断スクリプトが比較用に使うのみ）。
// 引数を省略すると、上記のとおり言語跨ぎで機能しない④が黙って有効になる。省略せず明示的に渡すこと。
// なお④は injection 防御ではない。攻撃者が本文を制御できる前提では①〜④すべて自明に満たせる
// （payload の語をカード本文にも含ませればよい）。④の実体は「LLM が無関係な箇所を帰属先に選ぶ」
// ことへの品質防御であり、無効化による injection 耐性の低下は無い。
export function groundingReason(
  quoteRaw: string,
  groundBodyNorm: string,
  targetRaw: string,
  minOverlap: number = MIN_OVERLAP,
): GroundingReason {
  const q = norm(quoteRaw);

  // ① 最小長（1 文未満の断片を弾く）
  if (q.length < MIN_QUOTE_CHARS) return "too_short";

  // ② 逐語照合（原文の部分文字列であること＝幻覚抜粋を弾く中核）
  if (!groundBodyNorm.includes(q)) return "not_verbatim";

  // ③ 固有性（記事固有の語を含むこと。汎用句が偶然 includes を通すのを弾く）
  if (specificTokens(q).size === 0) return "not_specific";

  // ④ 設問本体との語彙重なり（quote が設問と無関係な箇所の抜粋なのを弾く）。minOverlap=0 で無効。
  if (jaccardSpecific(q, norm(targetRaw)) < minOverlap) return "low_overlap";

  return "pass";
}

// 逐語 grounding 照合（bool 版）。挙動は groundingReason(...) === "pass" と同一。
export function isQuoteGrounded(
  quoteRaw: string,
  groundBodyNorm: string,
  targetRaw: string,
  minOverlap: number = MIN_OVERLAP,
): boolean {
  return groundingReason(quoteRaw, groundBodyNorm, targetRaw, minOverlap) === "pass";
}
