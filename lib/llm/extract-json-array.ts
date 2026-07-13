// LLM 出力から JSON 配列を頑健に取り出す共通処理。select-sources / propose-sources が
// 同じ「フェンス除去 → 配列を切り出す → JSON.parse」を複製していたので単一の出典に集約する
// （[[string-contract-colocate-format-parse]]）。要素の型検証は各呼び出し側に残し、ここは
// 「配列を安全に取り出す」形式段だけを担う。
//
// lastIndexOf("]") で末尾まで slice する素朴版は、モデルが配列の後ろに `[最も関連性が高い]` の
// ような角括弧つき散文を付けると全体へ伸びて JSON.parse が throw する。最初の `[` から括弧の
// 対応をカウントして最初に閉じた位置で切ることで、後続の散文に影響されない。閉じ `]` が無い
// （max_tokens 到達で途中切れ）ときは null を返し、呼び出し側が空配列へ倒す。

export function extractJsonArray(raw: string): unknown[] | null {
  if (!raw) return null;
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("[");
  if (start === -1) return null;

  // start から括弧の対応をカウントし、最初に深さ 0 へ戻った位置を配列の終端とみなす。
  // 文字列リテラル内の [ ] はカウントしない（\" のエスケープも追う）。
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null; // 閉じ ] が無い（途中切れ等）

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}
