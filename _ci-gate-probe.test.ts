import { describe, it, expect } from "vitest";

// YAT-69: CI ゲートが実際に止めるかを確かめるための一時ファイル。直後に削除する。
// 3 つ同時に壊して、lint が落ちても test / typecheck が続行することも併せて検証する。
const unusedVar: string = 123; // 型エラー(TS2322) + 未使用変数(lint)

describe("CI gate probe", () => {
  it("意図的に失敗する", () => {
    expect(1).toBe(2);
  });
});
