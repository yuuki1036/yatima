// LLM が返す annotate 出力（summary + tags の JSON）を頑健にパースする。
// Haiku は時々 ```json フェンスや前置きを付けるため、最初の { ... } を抽出して JSON.parse する。
// 失敗時は呼び出し側で「要約だけ救済・tags 空」にフォールバックさせる（fail-soft）。

export type RawAnnotation = { summary: string; tags: unknown };

// パース不能なら null を返す。呼び出し側がフォールバックを決める。
export function parseAnnotation(raw: string): RawAnnotation | null {
  if (!raw) return null;

  // コードフェンス除去 → 最初の { から最後の } までを抽出
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }

  if (typeof obj !== "object" || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  const summary = typeof rec.summary === "string" ? rec.summary : "";
  if (!summary) return null; // 要約が取れなければパース失敗扱い（フォールバックで生テキスト救済）
  return { summary, tags: rec.tags };
}
