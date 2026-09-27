import { describe, it, expect } from "vitest";
import { parseAnnotation } from "@/lib/llm/parse-annotation";

describe("parseAnnotation", () => {
  it("空文字は null", () => {
    expect(parseAnnotation("")).toBeNull();
  });

  it("素の {summary, tags} をパースする", () => {
    expect(parseAnnotation('{"summary":"要約","tags":["ai"]}')).toEqual({
      summary: "要約",
      tags: ["ai"],
    });
  });

  it("```json フェンス＋前置きを剥がしてパースする", () => {
    const raw = 'はい、これです:\n```json\n{"summary":"S","tags":[]}\n```';
    expect(parseAnnotation(raw)).toEqual({ summary: "S", tags: [] });
  });

  it("summary が空文字なら null（フォールバックさせる）", () => {
    expect(parseAnnotation('{"summary":"","tags":["x"]}')).toBeNull();
  });

  it("summary キーが無ければ null", () => {
    expect(parseAnnotation('{"tags":["x"]}')).toBeNull();
  });

  it("tags は型検証せずそのまま透過する（呼び出し側の責務）", () => {
    // tags が文字列でも通す（RawAnnotation.tags は unknown）
    expect(parseAnnotation('{"summary":"S","tags":"notarray"}')).toEqual({
      summary: "S",
      tags: "notarray",
    });
  });

  it("{ } が無ければ null", () => {
    expect(parseAnnotation("no braces here")).toBeNull();
  });

  it("不正な JSON は null", () => {
    expect(parseAnnotation('{"summary": }')).toBeNull();
  });

  it("JSON の後ろに注記と別の JSON 例が続いても最初のオブジェクトを採る", () => {
    const raw =
      '```json\n{"summary": "S", "tags": ["tech/ai", "science/math"]}\n```\n\n' +
      '注：「science/math」はタグ候補リストに存在しないため…以下が適切です:\n' +
      '```json\n{"summary": "S", "tags": ["tech/ai"]}\n```';
    expect(parseAnnotation(raw)).toEqual({ summary: "S", tags: ["tech/ai", "science/math"] });
  });

  it("summary 文字列内の { } は括弧カウントに含めない", () => {
    expect(parseAnnotation('{"summary":"a}b{c","tags":[]} 補足 {x}')).toEqual({
      summary: "a}b{c",
      tags: [],
    });
  });
});
