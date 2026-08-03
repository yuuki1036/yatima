import { describe, expect, it } from "vitest";
import { eTLDPlusOne } from "./discover";

// eTLD+1 は「重複排除の集約キー」と「ブロックリストの判定単位」を兼ねる要の関数。
// 判定単位がズレると、別人のブログを同一ソース扱いして取りこぼしたり（マルチテナント基盤）、
// ブロックしたはずの大手が素通りしたり（ccTLD）する。いずれも静かに壊れるので境界を固定する。

describe("eTLDPlusOne", () => {
  describe("多段 ccTLD は 1 ラベル繰り上げる", () => {
    // ブロックリストは eTLD+1 の完全一致集合なので、この性質により
    // `amazon.com` の登録は `amazon.co.jp` を覆わない（YAT-65 で実際に取りこぼした）。
    it("co.jp は繰り上げる", () => {
      expect(eTLDPlusOne("www.amazon.co.jp")).toBe("amazon.co.jp");
    });

    it("通常の gTLD は繰り上げない", () => {
      expect(eTLDPlusOne("www.amazon.com")).toBe("amazon.com");
    });

    it("co.uk も繰り上げる", () => {
      expect(eTLDPlusOne("news.bbc.co.uk")).toBe("bbc.co.uk");
    });
  });

  describe("ブログ基盤はサブドメインを別ソースとして残す", () => {
    // 末尾 2 ラベルで畳むと user-a.github.io と user-b.github.io が同一ソースになり、
    // 別人のブログを取りこぼす（方式①はブログを掘るのでここが効く）。
    it("github.io", () => {
      expect(eTLDPlusOne("colah.github.io")).toBe("colah.github.io");
    });

    it("substack.com", () => {
      expect(eTLDPlusOne("thezvi.substack.com")).toBe("thezvi.substack.com");
    });
  });

  describe("通常ドメイン", () => {
    it("末尾 2 ラベルに畳む", () => {
      expect(eTLDPlusOne("blog.sparkly.sh")).toBe("sparkly.sh");
    });

    it("2 ラベル以下はそのまま", () => {
      expect(eTLDPlusOne("example.com")).toBe("example.com");
    });

    it("大文字と末尾ドットを正規化する", () => {
      expect(eTLDPlusOne("WWW.Example.COM.")).toBe("example.com");
    });
  });
});
