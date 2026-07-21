import { describe, it, expect } from "vitest";
import {
  parseEmbedding,
  cosineSim,
  isNearDuplicate,
  DEDUP_THRESHOLD,
  CARD_DEDUP_THRESHOLD,
  QUIZ_DEDUP_THRESHOLD,
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

// YAT-56 の較正の記録。3 値は現状すべて 0.86 だが、それぞれ別の理由で 0.86 に居る
// （card=プラトー中央で動かす根拠なし / quiz=弾いた候補を観測できず判断保留 / 記事=別ドメイン）。
// 値そのものをリテラルで固定し、「気づかず動く」ことだけを防ぐ。定数間の関係は固定しない
// （偶然の一致を仕様にすると、無関係なドメインの較正で別ドメインのテストが落ちる）。
describe("dedup 閾値（YAT-56 の較正記録）", () => {
  it("card は 0.86（maxSim 中央値 0.740 に対しプラトーの中央）", () => {
    expect(CARD_DEDUP_THRESHOLD).toBe(0.86);
  });

  it("quiz は 0.86（弾いた候補が観測できないため据え置き。根拠は dedup.ts のコメント）", () => {
    expect(QUIZ_DEDUP_THRESHOLD).toBe(0.86);
  });

  it("すべて 0..1 の cosine 域にある", () => {
    for (const t of [DEDUP_THRESHOLD, CARD_DEDUP_THRESHOLD, QUIZ_DEDUP_THRESHOLD]) {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThanOrEqual(1);
    }
  });
});
