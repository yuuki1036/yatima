import { describe, expect, it } from "vitest";
import { htmlToInputText } from "./extract-text";

describe("htmlToInputText", () => {
  it("切り詰めの境界でサロゲートペアが割れても、孤立したサロゲートを残さない（YAT-79）", () => {
    // 1999 字の後に絵文字（2 コード単位）を置き、2000 で切ると上位サロゲートだけが残る位置にする
    const html = `<p>${"a".repeat(1999)}🚀続き</p>`;
    const text = htmlToInputText(html);
    expect(text.isWellFormed()).toBe(true);
    expect(text).toHaveLength(2000);
    expect(text.endsWith("�")).toBe(true);
    // Anthropic API が拒否する \ud83d のような孤立エスケープが JSON に出ない
    expect(JSON.stringify(text)).not.toMatch(/\\ud[89ab][0-9a-f]{2}"$/i);
  });

  it("割れていない絵文字はそのまま残す", () => {
    expect(htmlToInputText("<p>新モデル 🚀 発表</p>")).toBe("新モデル 🚀 発表");
  });
});
