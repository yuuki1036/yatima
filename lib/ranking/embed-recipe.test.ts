import { describe, it, expect } from "vitest";
import {
  recipeOf,
  majorityRecipe,
  judgeRecipe,
  nearDupFreshness,
  EMBED_RECIPE_EPOCH,
  EMBED_STAMP_INTRODUCED,
  RECIPE_MAJORITY_SHARE,
  RECIPE_MIXED_GRACE_DAYS,
} from "@/lib/ranking/embed-recipe";

// YAT-77 段階 4: レシピ判定の純関数。ここは「YAT-76 が旧レシピで押した stamp を lead に誤分類
// しない」ことと「混在が解消しない限り算出しない／45 日で赤くする」ことの契約を固定する。

const DAY = 86_400_000;
const EPOCH = Date.parse(EMBED_RECIPE_EPOCH);

describe("recipeOf", () => {
  it("null / 空文字 / パース不能は legacy", () => {
    expect(recipeOf(null)).toBe("legacy");
    expect(recipeOf(undefined)).toBe("legacy");
    expect(recipeOf("")).toBe("legacy");
    expect(recipeOf("not-a-date")).toBe("legacy");
  });

  it("EPOCH の 1ms 前は legacy、EPOCH ちょうど以降は lead（境界 >=）", () => {
    expect(recipeOf(new Date(EPOCH - 1).toISOString())).toBe("legacy");
    expect(recipeOf(new Date(EPOCH).toISOString())).toBe("lead");
    expect(recipeOf(new Date(EPOCH + DAY).toISOString())).toBe("lead");
  });

  it("汚染回帰: YAT-76 が旧レシピで stamp した実帯の時刻は legacy", () => {
    // ⚠ EPOCH 非依存の**ハードコードされたリテラル**で固定する。EPOCH から導出（mid=(STAMP+EPOCH)/2）
    // すると EPOCH を早めても mid も連動して下がり常に mid<EPOCH になる恒真式になり、
    // 「EPOCH を早めて旧レシピ行を lead に混ぜる」最悪故障を検知できない（この 1 本の存在理由が消える）。
    // 2026-09-16T12:00 は YAT-76 が旧レシピのまま stamp していた実帯。EPOCH をこの時刻以下へ
    // 早めた瞬間にこのテストが落ちる＝旧レシピ行が lead に誤分類される回帰を捕まえる。
    expect(recipeOf("2026-09-16T12:00:00.000Z")).toBe("legacy");
  });
});

describe("EPOCH の関係（redefining-a-metric の作法で固定）", () => {
  it("EPOCH は STAMP_INTRODUCED より後（遅い側に倒す規則）", () => {
    expect(EPOCH).toBeGreaterThan(Date.parse(EMBED_STAMP_INTRODUCED));
  });

  it("EPOCH は遠い未来ではない（段階 3 デプロイ直後に置く。遠すぎると全行 legacy で永久停止）", () => {
    // EPOCH は段階 3 の実デプロイ時刻の直後の正時に置く＝マージ時点では数時間〜1 日の近未来になりうる
    // （遅い側に倒す安全側の設計）。ただし年の打ち間違い等で数十日先に飛ぶと lead が永久に
    // 分類されずシグナルが止まるので、30 日先を超えないことだけ固定する。
    expect(EPOCH).toBeLessThan(Date.now() + 30 * DAY);
  });
});

describe("majorityRecipe", () => {
  it("空は share 0 / total 0 で例外にならない", () => {
    expect(majorityRecipe({ legacy: 0, lead: 0 })).toEqual({
      recipe: "legacy",
      share: 0,
      total: 0,
    });
  });

  it("同数は legacy に倒す（決定的）", () => {
    expect(majorityRecipe({ legacy: 5, lead: 5 }).recipe).toBe("legacy");
  });

  it("多い方を返し share を出す", () => {
    const m = majorityRecipe({ legacy: 2, lead: 8 });
    expect(m.recipe).toBe("lead");
    expect(m.share).toBeCloseTo(0.8);
    expect(m.total).toBe(10);
  });
});

describe("judgeRecipe", () => {
  const now = EPOCH + 10 * DAY;

  it("share 0.8 以上なら compute（境界 >=）", () => {
    const v = judgeRecipe({ legacy: 2, lead: 8 }, new Date(EPOCH).toISOString(), now);
    expect(v.kind).toBe("compute");
    expect(v.share).toBeCloseTo(RECIPE_MAJORITY_SHARE);
  });

  it("share 0.79 は blank（猶予内）", () => {
    const v = judgeRecipe({ legacy: 21, lead: 79 }, new Date(EPOCH).toISOString(), now);
    expect(v.kind).toBe("blank");
  });

  it("多数派が legacy かつ share 1.0 は compute かつ recipe=legacy（段階 3 前・revert 後の合流）", () => {
    const v = judgeRecipe({ legacy: 100, lead: 0 }, null, now);
    expect(v).toMatchObject({ kind: "compute", recipe: "legacy" });
  });

  it("窓に embedding が無い（total 0）は blank", () => {
    expect(judgeRecipe({ legacy: 0, lead: 0 }, null, now).kind).toBe("blank");
  });

  it("混在が 45 日未満なら blank、45 日以上なら stuck", () => {
    const firstLead = new Date(EPOCH).toISOString();
    const counts = { legacy: 50, lead: 50 };
    expect(
      judgeRecipe(counts, firstLead, EPOCH + (RECIPE_MIXED_GRACE_DAYS - 0.1) * DAY).kind,
    ).toBe("blank");
    expect(
      judgeRecipe(counts, firstLead, EPOCH + RECIPE_MIXED_GRACE_DAYS * DAY).kind,
    ).toBe("stuck");
  });

  it("day-0（新レシピ行ゼロ）でも clock は EPOCH 起点で動く＝45 日後に stuck", () => {
    // firstLead=null。先送りにすると embed 全停止で永久に緑になる（defer-on-zero-observation）。
    const v = judgeRecipe(
      { legacy: 100, lead: 5 }, // share 0.95 の legacy だが…下のケースで混在を作る
      null,
      EPOCH + 46 * DAY,
    );
    // legacy share 0.95 >= 0.8 なので compute。混在（share < 0.8）で day-0 の stuck を確認する:
    expect(v.kind).toBe("compute");
    const mixed = judgeRecipe({ legacy: 50, lead: 50 }, null, EPOCH + 46 * DAY);
    expect(mixed.kind).toBe("stuck");
  });

  it("firstLead が EPOCH より前でも EPOCH に clamp する（clock が早く切れない）", () => {
    const early = new Date(EPOCH - 100 * DAY).toISOString();
    // clamp されなければ mixedDays が巨大になり即 stuck。clamp されれば 10 日で blank のまま。
    const v = judgeRecipe({ legacy: 50, lead: 50 }, early, EPOCH + 10 * DAY);
    expect(v.kind).toBe("blank");
  });
});

describe("nearDupFreshness", () => {
  it("compute 成功 × share 0.8 以上は fresh", () => {
    expect(nearDupFreshness(true, 0.9)).toEqual({ fresh: true, reason: "fresh" });
  });

  it("compute 成功 × share 不足は recipe_mixed", () => {
    expect(nearDupFreshness(true, 0.5)).toEqual({
      fresh: false,
      reason: "recipe_mixed",
    });
  });

  it("compute 失敗は share を問わず compute_failed（優先順位）", () => {
    expect(nearDupFreshness(false, 0.9)).toEqual({
      fresh: false,
      reason: "compute_failed",
    });
    expect(nearDupFreshness(false, 0.5)).toEqual({
      fresh: false,
      reason: "compute_failed",
    });
  });
});
