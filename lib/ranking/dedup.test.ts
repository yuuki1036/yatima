import { describe, it, expect } from "vitest";
import {
  parseEmbedding,
  cosineSim,
  isNearDuplicate,
  DEDUP_THRESHOLD,
} from "@/lib/ranking/dedup";

describe("parseEmbedding", () => {
  it("配列はそのまま返す", () => {
    expect(parseEmbedding([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('文字列 "[1,2,3]" をパースする', () => {
    expect(parseEmbedding("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("空文字は null", () => {
    expect(parseEmbedding("")).toBeNull();
  });

  it("空配列文字列は null（embedding 無し扱い）", () => {
    expect(parseEmbedding("[]")).toBeNull();
  });

  it('"null" 文字列は null', () => {
    expect(parseEmbedding("null")).toBeNull();
  });

  it("パース不能な文字列は null", () => {
    expect(parseEmbedding("not json")).toBeNull();
  });

  it("文字列でも配列でもない値は null", () => {
    expect(parseEmbedding(42)).toBeNull();
    expect(parseEmbedding(null)).toBeNull();
    expect(parseEmbedding(undefined)).toBeNull();
  });
});

describe("cosineSim", () => {
  it("同一ベクトルは 1", () => {
    expect(cosineSim([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it("直交ベクトルは 0", () => {
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("逆向きは -1", () => {
    expect(cosineSim([1, 1], [-1, -1])).toBeCloseTo(-1);
  });

  it("次元不一致は 0（非類似）", () => {
    expect(cosineSim([1, 2, 3], [1, 2])).toBe(0);
  });

  it("零ベクトルは 0（ゼロ除算回避）", () => {
    expect(cosineSim([0, 0], [1, 1])).toBe(0);
  });
});

describe("isNearDuplicate", () => {
  it("既選のいずれかと閾値超で類似すれば true", () => {
    expect(isNearDuplicate([1, 0], [[0, 1], [1, 0]])).toBe(true);
  });

  it("どれとも類似しなければ false", () => {
    expect(isNearDuplicate([1, 0], [[0, 1]])).toBe(false);
  });

  it("既選が空なら false", () => {
    expect(isNearDuplicate([1, 0], [])).toBe(false);
  });

  it("閾値を明示指定できる（低くすると弾きやすい）", () => {
    // cosineSim ≈ 0.7071 の 45 度ずれペア
    const cand = [1, 0];
    const picked = [[1, 1]];
    expect(isNearDuplicate(cand, picked, 0.6)).toBe(true);
    expect(isNearDuplicate(cand, picked, DEDUP_THRESHOLD)).toBe(false);
  });
});
