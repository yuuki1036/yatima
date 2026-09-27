import { describe, it, expect } from "vitest";
import { buildQuizUserText, type GenerateQuizInput } from "@/lib/llm/generate-quiz";

// YAT-82: 同じ本文を渡すと LLM は毎回ほぼ同じ設問を作り直す。既出の設問が LLM に届くことを固定する
// （届かなければ再生成→dup_flag で、未回答が増えないまま生成コストだけかかる状態に戻る）。
describe("buildQuizUserText", () => {
  const base: GenerateQuizInput = {
    title: "Using the Fetch API",
    articleText: "本文",
    categoryLabel: "Web",
    count: 4,
    existingConcepts: [],
    avoidStems: [],
  };

  it("既出の設問を列挙する", () => {
    const text = buildQuizUserText({ ...base, avoidStems: ["設問A", "設問B"] });
    expect(text).toContain("既出の設問");
    expect(text).toContain("- 設問A\n- 設問B");
  });

  it("既出が無ければ既出の節を出さない", () => {
    expect(buildQuizUserText(base)).not.toContain("既出の設問");
  });
});
