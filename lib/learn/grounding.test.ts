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

// 英語記事の逐語引用（本文の一部）と、そこから作った日本語カード/設問。YAT-58 の実測サンプルに近い形。
const EN_QUOTE =
  "For an incident, freshness dominates. A deploy from four minutes ago is worth more than a perfect runbook.";
const JA_TARGET =
  "インシデント対応で「最近の変更」をコンテキストの上位に置くべき理由は何か？ モデルは長い文脈の始まりと終わりに注意を向けるため。";
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

  it("ひらがなだけの汎用句からはトークンを拾わない", () => {
    expect(specificTokens("だと思います").size).toBe(0);
  });
});

describe("jaccardSpecific", () => {
  // YAT-58 の中核。④が閾値較正では直せない理由をここで固定する。
  it("英語 quote × 日本語 target では固有トークンが交差せず 0 になる", () => {
    expect(jaccardSpecific(norm(EN_QUOTE), norm(JA_TARGET))).toBe(0);
  });

  it("同言語で語彙が重なれば正の値になる", () => {
    expect(jaccardSpecific("react hooks context", "react context window")).toBeGreaterThan(0);
  });
});

describe("groundingReason", () => {
  it("最小長未満は too_short", () => {
    const short = "a".repeat(MIN_QUOTE_CHARS - 1);
    expect(groundingReason(short, norm(short), short, 0)).toBe("too_short");
  });

  it("本文に無い抜粋は not_verbatim", () => {
    const hallucinated = "This sentence never appeared in the source article at all.";
    expect(groundingReason(hallucinated, EN_BODY, JA_TARGET, 0)).toBe("not_verbatim");
  });

  it("固有寄りトークンを持たない抜粋は not_specific", () => {
    const generic = "だと思いますだと思いますだと思いますだと思います";
    expect(groundingReason(generic, norm(generic), generic, 0)).toBe("not_specific");
  });

  // ここが YAT-58 の回帰ガード本体。④を既定値のまま使うと、実在する逐語引用が言語違いだけを理由に
  // 落ちる。本番 2 経路（quiz-gate / card-gate）はどちらも 0 を渡してこれを無効化している。
  it("④既定値だと英語 quote × 日本語 target が low_overlap で落ちる", () => {
    expect(groundingReason(EN_QUOTE, EN_BODY, JA_TARGET, MIN_OVERLAP)).toBe("low_overlap");
  });

  it("minOverlap=0 なら同じ組み合わせが pass する", () => {
    expect(groundingReason(EN_QUOTE, EN_BODY, JA_TARGET, 0)).toBe("pass");
  });

  it("④を無効化しても②逐語は効き続ける（防御が骨抜きにならない）", () => {
    const hallucinated = "A completely fabricated quotation that is not in the body text.";
    expect(isQuoteGrounded(hallucinated, EN_BODY, JA_TARGET, 0)).toBe(false);
  });
});
