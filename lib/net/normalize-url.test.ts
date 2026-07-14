import { describe, it, expect } from "vitest";
import { normalizeUrl } from "@/lib/net/normalize-url";

describe("normalizeUrl", () => {
  it("パース不能な入力は null", () => {
    expect(normalizeUrl("not a url")).toBeNull();
  });

  it("非 http(s) スキームは null", () => {
    expect(normalizeUrl("ftp://example.com/x")).toBeNull();
  });

  it("host を小文字化し先頭 www. を落とす", () => {
    expect(normalizeUrl("https://WWW.Example.com/docs")).toBe(
      "https://example.com/docs",
    );
  });

  it("フラグメント（#section）を除去する", () => {
    expect(normalizeUrl("https://example.com/a#top")).toBe(
      "https://example.com/a",
    );
  });

  it("トラッキングクエリを除去し、意味のあるクエリは残す", () => {
    expect(
      normalizeUrl("https://example.com/a?utm_source=x&v=2&gclid=y"),
    ).toBe("https://example.com/a?v=2");
  });

  it("残ったクエリはキー昇順で安定化する", () => {
    expect(normalizeUrl("https://example.com/a?b=2&a=1")).toBe(
      "https://example.com/a?a=1&b=2",
    );
  });

  it("末尾スラッシュを畳む（ルート / は残す）", () => {
    expect(normalizeUrl("https://example.com/docs/")).toBe(
      "https://example.com/docs",
    );
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("前後の空白を trim してからパースする", () => {
    expect(normalizeUrl("  https://example.com/a  ")).toBe(
      "https://example.com/a",
    );
  });

  it("表記ゆれが同一キーに正規化される（重複排除キー用途）", () => {
    const a = normalizeUrl("https://www.Example.com/p/?utm_medium=rss#x");
    const b = normalizeUrl("https://example.com/p");
    expect(a).toBe(b);
  });
});
