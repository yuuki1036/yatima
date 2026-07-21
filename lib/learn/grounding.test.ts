import { describe, it, expect } from "vitest";
import {
  norm,
  specificTokens,
  jaccardSpecific,
  groundingReason,
  isQuoteGrounded,
  MIN_QUOTE_CHARS,
  MIN_OVERLAP,
} from "@/lib/learn/grounding";

// YAT-58 の実測サンプルに近い形の fixture。英語記事の逐語引用と、そこから作った日本語カード/設問。
const EN_QUOTE =
  "For an incident, freshness dominates. A deploy from four minutes ago is worth more than a perfect runbook.";
// ラテン文字を含まない日本語 target（jaccard が厳密 0 になるケース）。
const JA_TARGET_PURE =
  "インシデント対応で「最近の変更」を上位に置くべき理由は何か？ モデルは長い文脈の始まりと終わりに注意を向けるため。";
// 実データに多い「日本語＋ラテン語彙」の target。共有ラテン語 1 語で jaccard ≈ 0.07 になる
// （YAT-58 の実測は 0.034 / 0.054。非ゼロだが MIN_OVERLAP には遠く届かない、という同じ性質）。
const JA_TARGET_MIXED =
  "SRE 運用で deploy の鮮度を重視する理由は何か？ ポストモーテムよりも直近の変更履歴が有効なため。";
const EN_BODY = norm(
  `Context engineering for incidents. ${EN_QUOTE} Retrieval hit rate matters too.`,
);

describe("specificTokens", () => {
  it("英数字4文字以上と漢字カナ3文字以上を拾う", () => {
    const t = specificTokens("react と コンテキスト の話 abc");
    expect(t.has("react")).toBe(true);
    expect(t.has("コンテキスト")).toBe(true);
    expect(t.has("abc")).toBe(false); // 3 文字の英数字は拾わない
  });

  // 境界値。regex の {4,} / {3,} を緩めても厳しくしても落ちるように両側から挟む。
  it("英数字はちょうど4文字から拾い、3文字は拾わない", () => {
    expect(specificTokens("abcd").has("abcd")).toBe(true);
    expect(specificTokens("abc").size).toBe(0);
  });

  it("カナはちょうど3文字から拾い、2文字は拾わない", () => {
    expect(specificTokens("メモリ").has("メモリ")).toBe(true);
    expect(specificTokens("メモ").size).toBe(0);
  });

  it("ひらがなだけの汎用句からはトークンを拾わない", () => {
    expect(specificTokens("だと思います").size).toBe(0);
  });
});

describe("jaccardSpecific", () => {
  // YAT-58 の中核。④が閾値較正では直せない理由をここで固定する。
  // 純日本語 target は文字クラスが排他なので構造的に 0（この 1 件だけでは④の回帰は検出できない）。
  it("英語 quote × ラテン文字なし日本語 target では固有トークンが交差せず 0 になる", () => {
    expect(jaccardSpecific(norm(EN_QUOTE), norm(JA_TARGET_PURE))).toBe(0);
  });

  // 本命。実データの日本語カードは RAG / LLM のようなラテン語彙を含むので jaccard は非ゼロになる。
  // それでも MIN_OVERLAP には遠く届かない、というのが「較正では解決しない」の実質的な根拠。
  it("ラテン語彙を含む日本語 target でも非ゼロ止まりで MIN_OVERLAP に届かない", () => {
    const jac = jaccardSpecific(norm(EN_QUOTE), norm(JA_TARGET_MIXED));
    expect(jac).toBeGreaterThan(0);
    expect(jac).toBeLessThan(MIN_OVERLAP);
  });

  it("同言語で語彙が重なれば有意な値になる", () => {
    const jac = jaccardSpecific("react hooks context", "react context window");
    expect(jac).toBeGreaterThan(MIN_OVERLAP);
  });
});

describe("groundingReason", () => {
  it("最小長未満は too_short", () => {
    const short = "a".repeat(MIN_QUOTE_CHARS - 1);
    expect(groundingReason(short, norm(short), short, 0)).toBe("too_short");
  });

  it("本文に無い抜粋は not_verbatim", () => {
    const hallucinated = "This sentence never appeared in the source article at all.";
    expect(groundingReason(hallucinated, EN_BODY, JA_TARGET_PURE, 0)).toBe("not_verbatim");
  });

  it("固有寄りトークンを持たない抜粋は not_specific", () => {
    // ①で先に落ちないよう MIN_QUOTE_CHARS から長さを導出する（定数変更で誤爆させない）。
    const generic = "だと思います".repeat(Math.ceil((MIN_QUOTE_CHARS + 1) / 6));
    expect(generic.length).toBeGreaterThan(MIN_QUOTE_CHARS);
    expect(groundingReason(generic, norm(generic), generic, 0)).toBe("not_specific");
  });

  it("④既定値だと英語 quote × 日本語 target が low_overlap で落ちる", () => {
    expect(groundingReason(EN_QUOTE, EN_BODY, JA_TARGET_PURE, MIN_OVERLAP)).toBe("low_overlap");
    expect(groundingReason(EN_QUOTE, EN_BODY, JA_TARGET_MIXED, MIN_OVERLAP)).toBe("low_overlap");
  });

  it("minOverlap=0 なら同じ組み合わせが pass する", () => {
    expect(groundingReason(EN_QUOTE, EN_BODY, JA_TARGET_PURE, 0)).toBe("pass");
  });
});

describe("isQuoteGrounded", () => {
  it("④を無効化しても②逐語は効き続ける（防御が骨抜きにならない）", () => {
    const hallucinated = "A completely fabricated quotation that is not in the body text.";
    expect(isQuoteGrounded(hallucinated, EN_BODY, JA_TARGET_PURE, 0)).toBe(false);
  });

  it("実在の逐語引用は④無効なら通る", () => {
    expect(isQuoteGrounded(EN_QUOTE, EN_BODY, JA_TARGET_PURE, 0)).toBe(true);
  });
});
