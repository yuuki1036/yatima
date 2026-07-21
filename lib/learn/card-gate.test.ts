import { describe, it, expect } from "vitest";
import { cardTarget, isValidFormat, isGrounded } from "@/lib/learn/card-gate";
import { norm } from "@/lib/learn/grounding";
import type { GeneratedCard } from "@/lib/llm/generate-cards";

// YAT-58 の原因は「card-gate が isQuoteGrounded を既定引数で呼び、④が有効なままだった」という
// 配線の問題だった。grounding.ts のプリミティブをいくら固めても配線は守れないので、ここでは
// isGrounded を直接叩いて CARD_MIN_OVERLAP=0 が渡っていることを検証する。
// このファイルが落ちる条件＝YAT-58 の修正が巻き戻された条件。

const EN_QUOTE =
  "For an incident, freshness dominates. A deploy from four minutes ago is worth more than a perfect runbook.";
const BODY = norm(
  `Context engineering for incidents. ${EN_QUOTE} Retrieval hit rate matters too.`,
);

function qaCard(over: Partial<GeneratedCard> = {}): GeneratedCard {
  return {
    type: "qa",
    front: "インシデント対応で「最近の変更」を優先すべき理由は何か？",
    back: "直近のデプロイほど原因である確率が高く、鮮度が精度に勝るため。",
    cloze_text: null,
    source_quote: EN_QUOTE,
    concept_tag: "インシデント対応",
    ...over,
  };
}

function clozeCard(over: Partial<GeneratedCard> = {}): GeneratedCard {
  return {
    type: "cloze",
    front: null,
    back: null,
    cloze_text: "インシデントでは {{c1::鮮度}} が完璧さに勝る。",
    source_quote: EN_QUOTE,
    concept_tag: "インシデント対応",
    ...over,
  };
}

describe("cardTarget", () => {
  it("qa は front と back を連結する", () => {
    const card = qaCard();
    expect(cardTarget(card)).toBe(`${card.front} ${card.back}`);
  });

  it("cloze は穴埋めマーカーを外して答えだけ残す", () => {
    expect(cardTarget(clozeCard())).toBe("インシデントでは 鮮度 が完璧さに勝る。");
  });

  it("cloze のヒント付き構文は答えのみ残す", () => {
    const card = clozeCard({ cloze_text: "答えは {{c1::EWMA::移動平均の一種}} である。" });
    expect(cardTarget(card)).toBe("答えは EWMA である。");
  });

  it("複数の穴をすべて展開する", () => {
    const card = clozeCard({ cloze_text: "{{c1::HNSW}} と {{c2::IVFFlat}} は別物。" });
    expect(cardTarget(card)).toBe("HNSW と IVFFlat は別物。");
  });
});

describe("isValidFormat", () => {
  it("qa は front/back が揃っていれば通る", () => {
    expect(isValidFormat(qaCard())).toBe(true);
  });

  it("qa は back が空だと落ちる", () => {
    expect(isValidFormat(qaCard({ back: "  " }))).toBe(false);
  });

  it("cloze は穴が無いと落ちる", () => {
    expect(isValidFormat(clozeCard({ cloze_text: "穴のない文。" }))).toBe(false);
  });

  it("cloze は穴の中身が空だと落ちる", () => {
    expect(isValidFormat(clozeCard({ cloze_text: "空の {{c1::}} 穴。" }))).toBe(false);
  });
});

describe("isGrounded（④無効化の配線）", () => {
  // ここが YAT-58 の回帰ガード本体。CARD_MIN_OVERLAP を 0.12 に戻す / isQuoteGrounded の
  // 第4引数を消す のいずれをやってもこの 2 件が落ちる。
  it("英語 quote × 日本語 qa カードが通る（④が有効だと落ちる組み合わせ）", () => {
    expect(isGrounded(qaCard(), BODY)).toBe(true);
  });

  it("英語 quote × 日本語 cloze カードが通る", () => {
    expect(isGrounded(clozeCard(), BODY)).toBe(true);
  });

  // ④を外しても②③が効いていることを、本番と同じ入口で確認する。
  it("本文に無い抜粋は落ちる（②逐語は生きている）", () => {
    const card = qaCard({
      source_quote: "A completely fabricated quotation that is not in the body text.",
    });
    expect(isGrounded(card, BODY)).toBe(false);
  });

  it("短すぎる抜粋は落ちる（①最小長は生きている）", () => {
    expect(isGrounded(qaCard({ source_quote: "freshness" }), BODY)).toBe(false);
  });

  it("固有トークンを持たない汎用句は落ちる（③固有性は生きている）", () => {
    const generic = "だと思いますだと思いますだと思いますだと思います";
    expect(isGrounded(qaCard({ source_quote: generic }), norm(generic))).toBe(false);
  });
});
