import { describe, it, expect } from "vitest";
import { isPubliclyRoutableHttpUrl } from "@/lib/net/ssrf";

const blocked = (url: string) => isPubliclyRoutableHttpUrl(url) === null;

describe("isPubliclyRoutableHttpUrl", () => {
  describe("内部・予約アドレスを弾く", () => {
    const cases: [string, string][] = [
      ["http://localhost/", "localhost"],
      ["http://foo.local/", ".local"],
      ["http://svc.internal/", ".internal"],
      ["http://127.0.0.1/", "IPv4 ループバック"],
      ["http://10.0.0.1/", "IPv4 RFC1918 (10)"],
      ["http://192.168.1.1/", "IPv4 RFC1918 (192.168)"],
      ["http://172.16.0.1/", "IPv4 RFC1918 (172.16)"],
      ["http://169.254.169.254/", "IPv4 メタデータ"],
      ["http://100.64.0.1/", "IPv4 CGN"],
      ["http://2130706433/", "IPv4 10進表記(=127.0.0.1)"],
      ["http://0x7f000001/", "IPv4 16進表記(=127.0.0.1)"],
      ["http://[::1]/", "IPv6 ループバック"],
      ["http://[fc00::1]/", "IPv6 ULA (fc)"],
      ["http://[fd00::1]/", "IPv6 ULA (fd)"],
    ];
    it.each(cases)("%s を弾く（%s）", (url) => {
      expect(blocked(url)).toBe(true);
    });
  });

  // YAT-45 回帰: IPv4-mapped IPv6 が内部 IPv4 を包む場合を弾く
  describe("IPv4-mapped IPv6（YAT-45 回帰）を弾く", () => {
    const cases: string[] = [
      "http://[::ffff:127.0.0.1]/", // → ::ffff:7f00:1
      "http://[::ffff:169.254.169.254]/", // メタデータ
      "http://[::ffff:10.0.0.5]/",
      "http://[::ffff:192.168.1.1]/",
      "http://[::ffff:172.16.0.1]/",
      "http://[::ffff:100.64.0.1]/",
      "http://[::FFFF:127.0.0.1]/", // 大文字も toLowerCase で吸収
    ];
    it.each(cases)("%s を弾く", (url) => {
      expect(blocked(url)).toBe(true);
    });
  });

  // YAT-45 セルフレビュー派生: リンクローカル fe80::/10 の全域
  describe("リンクローカル fe80::/10 を弾く", () => {
    it.each(["http://[fe80::1]/", "http://[fe9a::1]/", "http://[febf::1]/"])(
      "%s を弾く",
      (url) => {
        expect(blocked(url)).toBe(true);
      },
    );
  });

  describe("非 http(s) スキームを弾く", () => {
    it.each(["ftp://example.com/", "file:///etc/passwd", "gopher://x/"])(
      "%s を弾く",
      (url) => {
        expect(blocked(url)).toBe(true);
      },
    );
  });

  describe("正当な外部アドレスは通す（誤ブロックしない）", () => {
    const cases: string[] = [
      "https://example.com/feed.xml",
      "http://8.8.8.8/",
      "http://[2606:4700:4700::1111]/", // 外部 IPv6
      "http://[::ffff:8.8.8.8]/", // mapped だが外部 IPv4
    ];
    it.each(cases)("%s を通す", (url) => {
      expect(blocked(url)).toBe(false);
    });

    it("通過時は正規化済みの URL を返す", () => {
      const u = isPubliclyRoutableHttpUrl("https://Example.com/feed.xml");
      expect(u).toBeInstanceOf(URL);
      expect(u?.hostname).toBe("example.com");
    });
  });

  it("パース不能な入力は null", () => {
    expect(isPubliclyRoutableHttpUrl("not a url")).toBeNull();
  });
});
