import { describe, it, expect } from "vitest";
import { extractJsonArray } from "@/lib/llm/extract-json-array";

describe("extractJsonArray", () => {
  it("空文字は null", () => {
    expect(extractJsonArray("")).toBeNull();
  });

  it("素の JSON 配列をパースする", () => {
    expect(extractJsonArray('["a","b"]')).toEqual(["a", "b"]);
  });

  it("```json コードフェンスを除去してパースする", () => {
    expect(extractJsonArray('```json\n[1, 2, 3]\n```')).toEqual([1, 2, 3]);
  });

  it("配列の後ろの角括弧つき散文に影響されない", () => {
    // lastIndexOf("]") 素朴版が壊れるケース（実装コメントの例）
    const raw = '["x","y"] 最も関連性が高いのは [1] 番目です';
    expect(extractJsonArray(raw)).toEqual(["x", "y"]);
  });

  it("文字列リテラル内の ] を終端と誤認しない", () => {
    expect(extractJsonArray('["a]b","c"]')).toEqual(["a]b", "c"]);
  });

  it("閉じ ] が無い（途中切れ）は null", () => {
    expect(extractJsonArray('["a","b"')).toBeNull();
  });

  it("開き [ が無ければ null", () => {
    expect(extractJsonArray('{"summary":"x"}')).toBeNull();
  });

  it("配列でない JSON（オブジェクト）は null", () => {
    // "{...}" は [ を含まないため null に倒れる
    expect(extractJsonArray('{"a":1}')).toBeNull();
  });

  it("角括弧を含まない散文は null", () => {
    expect(extractJsonArray("just prose, no bracket")).toBeNull();
  });

  it("ネストした配列も最初の対応で正しく切る", () => {
    expect(extractJsonArray('[[1,2],[3,4]] trailing')).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
});
