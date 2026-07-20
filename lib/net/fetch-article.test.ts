import { describe, it, expect } from "vitest";
import { isHtmlContentType, extractedTextLength } from "@/lib/net/fetch-article";

// fetchAndExtractArticle 自体はネットワーク IO を持つのでテスト対象外（YAT-46 の選定基準）。
// ここでは IO を伴わない述語だけを固定する。

describe("isHtmlContentType", () => {
  describe("本文抽出の対象として通す", () => {
    const cases: [string, string][] = [
      ["text/html", "素の HTML"],
      ["text/html; charset=utf-8", "charset 付き"],
      ["TEXT/HTML", "大文字（小文字化して判定する）"],
      ["application/xhtml+xml", "XHTML"],
      ["text/xml", "text/xml"],
      ["application/xml", "application/xml"],
    ];
    it.each(cases)("%s を通す（%s）", (ctype) => {
      expect(isHtmlContentType(ctype)).toBe(true);
    });
  });

  describe("本文抽出の対象外を弾く", () => {
    const cases: [string, string][] = [
      ["image/png", "画像"],
      ["application/pdf", "PDF"],
      ["application/octet-stream", "バイナリ"],
    ];
    it.each(cases)("%s を弾く（%s）", (ctype) => {
      expect(isHtmlContentType(ctype)).toBe(false);
    });
  });

  // ここが load-bearing: この述語を feed 取得に流用すると実在 feed が静かに落ちる。
  // YAT-57 の当初計画は「HTML_CONTENT_TYPE を共有して discover/parser にも渡す」だったので、
  // 将来また同じ流用が試みられうる。そのとき落ちる Content-Type をテストで可視化しておく。
  describe("feed の Content-Type は通さない（feed 経路へ流用してはいけない根拠）", () => {
    const cases: [string, string][] = [
      ["application/rss+xml", "RSS 2.0（arXiv / HuggingFace で実測）"],
      ["application/atom+xml", "Atom"],
      ["application/rdf+xml", "RSS 1.0（日経 xTECH で実測）"],
    ];
    it.each(cases)("%s を弾く（%s）", (ctype) => {
      expect(isHtmlContentType(ctype)).toBe(false);
    });
  });
});

describe("extractedTextLength", () => {
  it("タグを除いた実テキスト長を返す", () => {
    expect(extractedTextLength("<p>abc</p>")).toBe(3);
  });

  it("タグだけの HTML は 0 になる（薄いページの足切りが効く）", () => {
    expect(extractedTextLength("<div><span></span></div>")).toBe(0);
  });

  it("空文字は 0", () => {
    expect(extractedTextLength("")).toBe(0);
  });
});
