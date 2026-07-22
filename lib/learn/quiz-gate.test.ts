import { describe, it, expect } from "vitest";
import { shuffleChoices, choiceShuffleSeed } from "@/lib/learn/quiz-gate";

// YAT-62: LLM は正解を choices[0] に置きがちなので、insert 前に決定的シャッフルで位置を一様化する。
// 実使用で「選択肢 1 つ目が答えであることがほとんど」という報告が出た件の回帰ガード
// （原因はシャッフル導入前の旧データだったが、シャッフル自体が壊れていないことも固定しておく）。

describe("choiceShuffleSeed", () => {
  it("同じ入力からは同じ seed（再現可能・移行 script が同じ並びを再現できる前提）", () => {
    expect(choiceShuffleSeed("api-design", "Q1 とは何か")).toBe(
      choiceShuffleSeed("api-design", "Q1 とは何か"),
    );
  });

  it("concept か stem が違えば seed も違う", () => {
    const base = choiceShuffleSeed("api-design", "Q1");
    expect(choiceShuffleSeed("api-design", "Q2")).not.toBe(base);
    expect(choiceShuffleSeed("other", "Q1")).not.toBe(base);
  });

  // 区切りは U+0000。実バイトの NUL をソースに置くと file(1) がバイナリ判定し grep -r が
  // 黙ってスキップするため、エスケープ表記で書いている。文字としては同一なので seed も同一。
  it("区切りは U+0000（実バイト NUL と同じ文字＝既存問題の seed が変わらない）", () => {
    const NUL = String.fromCharCode(0);
    // FNV-1a を直接計算した参照値と突き合わせる（実装の写しではなく仕様の再計算）。
    const fnv = (s: string) => {
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return h >>> 0;
    };
    expect(choiceShuffleSeed("c", "s")).toBe(fnv(`c${NUL}s`));
  });

  it("区切りがあるので連結の境界が違えば別 seed（'ab'+'c' と 'a'+'bc' が衝突しない）", () => {
    expect(choiceShuffleSeed("ab", "c")).not.toBe(choiceShuffleSeed("a", "bc"));
  });
});

describe("shuffleChoices", () => {
  const choices = ["正解", "誤り1", "誤り2", "誤り3"];

  it("正解のテキストが移動先でも保たれる", () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const r = shuffleChoices(choices, 0, seed);
      expect(r.choices[r.answerIndex]).toBe("正解");
    }
  });

  it("選択肢の集合は変わらない（並べ替えのみ）", () => {
    const r = shuffleChoices(choices, 2, 12345);
    expect([...r.choices].sort()).toEqual([...choices].sort());
  });

  it("同じ seed なら同じ結果（決定的）", () => {
    const a = shuffleChoices(choices, 1, 999);
    const b = shuffleChoices(choices, 1, 999);
    expect(a).toEqual(b);
  });

  it("重複した選択肢があっても正解位置が一意に決まる", () => {
    // indexOf の最初一致に倒れると、重複がある場合に誤った位置を返しうる。
    // インデックス配列を並べ替えて写像を作っているので、正解として指定した要素が追跡される。
    const dup = ["同じ", "同じ", "別1", "別2"];
    for (let seed = 0; seed < 50; seed += 1) {
      const r = shuffleChoices(dup, 1, seed);
      expect(r.choices[r.answerIndex]).toBe("同じ");
      // 「同じ」は 2 つあるが、answerIndex は index=1 由来の 1 箇所だけを指す。
      expect(r.choices.filter((c) => c === "同じ")).toHaveLength(2);
    }
  });

  // これが本丸。LLM が常に 0 を正解にしても、保存される位置が偏らないことを固定する。
  it("正解が常に choices[0] でも、保存位置は 4 箇所へ十分ばらける", () => {
    const dist = [0, 0, 0, 0];
    for (let i = 0; i < 4000; i += 1) {
      const r = shuffleChoices(choices, 0, choiceShuffleSeed(`c${i}`, `stem ${i}`));
      dist[r.answerIndex] += 1;
    }
    const expected = 4000 / 4;
    const chi = dist.reduce((s, o) => s + (o - expected) ** 2 / expected, 0);
    // 自由度 3 の χ² 上側 0.1% 点は 16.27。実装が偏っていれば遥かに超える
    // （シャッフル導入前の実データは χ²=89 だった）。
    expect(chi).toBeLessThan(16.27);
    for (const n of dist) expect(n).toBeGreaterThan(0);
  });
});
