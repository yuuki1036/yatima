import { describe, it, expect } from "vitest";
import { estimateTokens } from "@/lib/llm/embed";

// YAT-76: estimateTokens は「実トークン数の上限」であることが唯一の契約
// （上限であることで TOKEN_BUDGET 遵守 → 10K TPM 遵守が保証される）。
// ここでは係数の正確さではなく、文字種で見積もりが分かれること・旧実装（一律 2.0 倍）より
// 英語主体テキストが小さく見積もられることを固定する。

describe("estimateTokens", () => {
  it("ASCII は 0.4 tok/字で見積もる（実測 ~0.25 の上限）", () => {
    expect(estimateTokens("a".repeat(100))).toBe(40);
  });

  it("非 ASCII（CJK 等）は 1.5 tok/字で見積もる（実測 ~1.0 の上限）", () => {
    expect(estimateTokens("あ".repeat(100))).toBe(150);
  });

  it("混在テキストは文字種ごとの和（切り上げ）", () => {
    // ASCII 10 字 (4.0) + 日本語 10 字 (15.0) = 19
    expect(estimateTokens("abcdefghij" + "あいうえおかきくけこ")).toBe(19);
  });

  it("空文字は 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("どの文字種でも旧実装（一律 2.0 倍）を超えない＝チャンク詰めが後退しない", () => {
    for (const t of ["English only text", "日本語だけの本文", "mixed 混在 text"]) {
      expect(estimateTokens(t)).toBeLessThanOrEqual(Math.ceil(t.length * 2.0));
    }
  });
});
