import { describe, it, expect } from "vitest";
import {
  articleEmbedText,
  DISK_CEILING_BYTES,
  EMBED_MIN_BODY_LEN,
  EMBED_LEAD_CHARS,
} from "@/lib/rss/embed";

// YAT-77: embedding を要約から切り離す。新レシピ（title＋本文冒頭 250 字）のテキスト整形と、
// 分布実測で確定した定数の値を固定する。ここは「レシピの契約」であり、実測（p50 0.741 等）を
// 再現する条件なので、値・順序を変えるときは仕様変更として書き換える。

describe("articleEmbedText", () => {
  it("HTML タグと実体参照を除去して title と本文冒頭を \\n で連結する", () => {
    expect(
      articleEmbedText({
        title: "見出し",
        content_head: "<p>本文 &amp; 続き</p>",
      }),
    ).toBe("見出し\n本文 & 続き");
  });

  it("本文冒頭は 250 字ちょうどに切る", () => {
    const body = "a".repeat(301);
    const text = articleEmbedText({ title: "T", content_head: `<div>${body}</div>` });
    const lead = text.split("\n")[1];
    expect(lead.length).toBe(EMBED_LEAD_CHARS);
    expect(lead.length).toBe(250);
  });

  it("content_head が無くても title だけで壊れない", () => {
    expect(articleEmbedText({ title: "タイトルのみ", content_head: null })).toBe(
      "タイトルのみ",
    );
  });

  it("title が無くても lead だけ返す（順序は title→lead 固定）", () => {
    expect(articleEmbedText({ content_head: "<p>本文</p>" })).toBe("本文");
  });

  it("title→lead の順で連結する（実測分布を再現する条件なので固定）", () => {
    const text = articleEmbedText({ title: "T", content_head: "<p>B</p>" });
    expect(text).toBe("T\nB");
  });
});

describe("embed の定数", () => {
  it("ゲートの本文長下限は 250（変更時は 0017 の idx_articles_embed_pending を張り直す）", () => {
    // ⚠ この値を変えたら migration 0017 の部分 index 述語（body_text_len >= 250 が焼き込み）も
    // 変えること（design doc open 6）。動かさず閾値だけ変えると seq scan に落ちる。
    expect(EMBED_MIN_BODY_LEN).toBe(250);
  });

  it("ディスク天井は 450MB（base-2）", () => {
    expect(DISK_CEILING_BYTES).toBe(450 * 1024 * 1024);
  });
});
