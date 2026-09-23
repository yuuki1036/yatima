// LLM が返す annotate 出力（summary + tags の JSON）を頑健にパースする。
// Haiku は時々 ```json フェンスや前置き、JSON の後ろに「注: …」と別の JSON 例を付けるため、
// 最初の { から括弧の対応が閉じる位置までを抽出して JSON.parse する（extractJsonObject）。
// 失敗時は呼び出し側で「要約だけ救済・tags 空」にフォールバックさせる（fail-soft）。

import { extractJsonObject } from "./extract-json-array";

export type RawAnnotation = { summary: string; tags: unknown };

// パース不能なら null を返す。呼び出し側がフォールバックを決める。
export function parseAnnotation(raw: string): RawAnnotation | null {
  if (!raw) return null;

  const rec = extractJsonObject(raw);
  if (!rec) return null;
  const summary = typeof rec.summary === "string" ? rec.summary : "";
  if (!summary) return null; // 要約が取れなければパース失敗扱い（フォールバックで生テキスト救済）
  return { summary, tags: rec.tags };
}
