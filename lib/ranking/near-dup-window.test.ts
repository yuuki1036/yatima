import { describe, it, expect } from "vitest";
import { filterByRecipe, type WindowArticle } from "@/lib/ranking/near-dup-window";
import { EMBED_RECIPE_EPOCH } from "@/lib/ranking/embed-recipe";

// YAT-77: filterByRecipe は own と比較プールの両方に同じレシピを効かせる要（compute-dedup-rate）。
// 多数派が legacy かつ全件 legacy のとき「1 行も落とさない＝現行挙動へ合流」を固定する。

const EPOCH = Date.parse(EMBED_RECIPE_EPOCH);
const art = (embedded_at: string | null): WindowArticle => ({
  feed_id: "f",
  embedding: null,
  published_at: "2026-09-10T00:00:00Z",
  embedded_at,
});

describe("filterByRecipe", () => {
  const legacyA = art(null);
  const legacyB = art(new Date(EPOCH - 1).toISOString());
  const leadA = art(new Date(EPOCH).toISOString());
  const leadB = art(new Date(EPOCH + 86_400_000).toISOString());
  const mixed = [legacyA, legacyB, leadA, leadB];

  it("lead だけ抜く", () => {
    expect(filterByRecipe(mixed, "lead")).toEqual([leadA, leadB]);
  });

  it("legacy だけ抜く（null と EPOCH 未満）", () => {
    expect(filterByRecipe(mixed, "legacy")).toEqual([legacyA, legacyB]);
  });

  it("全件 legacy に対して legacy を要求すると全件返す（現行挙動へ合流）", () => {
    const allLegacy = [legacyA, legacyB];
    expect(filterByRecipe(allLegacy, "legacy")).toEqual(allLegacy);
  });

  it("元配列を破壊しない", () => {
    const before = [...mixed];
    filterByRecipe(mixed, "lead");
    expect(mixed).toEqual(before);
  });
});
