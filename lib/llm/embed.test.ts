import { describe, it, expect } from "vitest";
import { estimateTokens, hasTimeBudget } from "@/lib/llm/embed";

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

// YAT-77: 壁時計締切の判定。deadlineMs 未指定は従来の挙動（締切なし）を保つのが唯一の契約。
describe("hasTimeBudget", () => {
  it("deadlineMs 未指定なら常に true（既存呼び出しの挙動不変）", () => {
    expect(hasTimeBudget(undefined, 999_999, 0)).toBe(true);
  });

  it("残りが needMs より多ければ true", () => {
    // now=0, deadline=100, need=50 → 0+50 < 100 → true
    expect(hasTimeBudget(100, 50, 0)).toBe(true);
  });

  it("残りがちょうど needMs は false（間に合わない側に倒す）", () => {
    // now=0, deadline=100, need=100 → 0+100 < 100 は false
    expect(hasTimeBudget(100, 100, 0)).toBe(false);
  });

  it("締切を既に過ぎていれば false", () => {
    expect(hasTimeBudget(100, 10, 200)).toBe(false);
  });
});
