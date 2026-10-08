import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { buildAnnotateParams, interpretAnnotateMessage } from "./haiku";

// 同期の annotate と Batches 経路が同じリクエストを送り、同じ解釈をすることを固定する（YAT-79）。
// 値は 1 つずつ書く（定数をシンボルで参照すると、値が変わってもテストが追従して通ってしまう）。

const text = (t: string) => ({ type: "text", text: t, citations: null }) as Anthropic.TextBlock;
const msg = (...blocks: Anthropic.ContentBlock[]) => ({ content: blocks });

describe("buildAnnotateParams", () => {
  it("モデル・max_tokens・thinking を固定する", () => {
    const p = buildAnnotateParams({ title: "T", text: "B" });
    expect(p.model).toBe("claude-haiku-4-5");
    expect(p.max_tokens).toBe(1400);
    expect(p.thinking).toEqual({ type: "disabled" });
    expect(typeof p.system).toBe("string");
    expect(p.system as string).toContain('{"summary": "...", "tags": ["...", "..."]}');
  });

  it("user はタイトルと本文を空行で区切る", () => {
    expect(buildAnnotateParams({ title: "T", text: "B" }).messages).toEqual([
      { role: "user", content: "タイトル: T\n\n本文: B" },
    ]);
  });

  it("タイトルと本文の孤立したサロゲートは U+FFFD にして送る（YAT-79）", () => {
    const p = buildAnnotateParams({ title: "T\uD83D", text: "B\uDE80x" });
    expect(p.messages).toEqual([{ role: "user", content: "タイトル: T\uFFFD\n\n本文: B\uFFFDx" }]);
  });

  it("タイトルが無ければ本文だけ", () => {
    expect(buildAnnotateParams({ title: null, text: "B" }).messages).toEqual([
      { role: "user", content: "本文: B" },
    ]);
  });
});

describe("interpretAnnotateMessage", () => {
  it("JSON を要約とタグに分け、語彙外のタグは捨てる", () => {
    const r = interpretAnnotateMessage(
      msg(text('{"summary": "新モデルの発表", "tags": ["tech/ai", "not-a-tag"]}')),
    );
    expect(r).toEqual({ summary: "新モデルの発表", tags: ["tech/ai"] });
  });

  it("text 以外のブロックは無視して text だけを連結する", () => {
    const r = interpretAnnotateMessage(
      msg(
        { type: "thinking", thinking: "x", signature: "s" } as Anthropic.ContentBlock,
        text('{"summary": "新モデルの発表", '),
        text('"tags": ["tech/ai"]}'),
      ),
    );
    expect(r).toEqual({ summary: "新モデルの発表", tags: ["tech/ai"] });
  });

  it('"summary" キーを含む壊れた JSON は救済せず throw する', () => {
    expect(() => interpretAnnotateMessage(msg(text('{"summary": "途中で切れ')))).toThrow(
      "annotate の JSON が壊れている",
    );
  });

  it("JSON でない平文は要約として救済し、タグは空にする", () => {
    expect(interpretAnnotateMessage(msg(text("新モデルが出た")))).toEqual({
      summary: "新モデルが出た",
      tags: [],
    });
  });

  it("空の応答は throw する", () => {
    expect(() => interpretAnnotateMessage(msg())).toThrow("要約が空");
  });
});
