// embedding のレシピ判定（YAT-77 段階 4）。DB 依存ゼロの純関数だけを置く。
//
// ⚠ ロールバック不変条件（先に読むこと）:
//   段階 4 は単独で revert できる。**段階 3（lib/rss/embed.ts の切り離し）を段階 4 より先に
//   revert してはならない。** 段階 3 を戻すと embedMissing は旧レシピ（title+summary）に戻るが
//   stampColumn: "embedded_at"（YAT-76 由来）は残るため、旧レシピ行が EPOCH 以降の stamp を持つ
//   ＝ lead に誤分類される。段階 4 が入ったままだと汚染された母集団で near_dup を算出し、しかも
//   near_dup_fresh=true で snapshot に貯まる（YAT-55 で 3 回踏んだ「汚染を fresh と記録」の 4 回目）。
//   段階 4 を先に戻せば compute はレシピを見なくなり、この危険は消える。
//
// なぜ時刻でカットするのか（embedded_at の null/非 null で分けない理由）:
//   design doc は「null＝旧 / 非 null＝新」を前提にするが、YAT-76（fd2ea48）が既に旧レシピのまま
//   embedded_at を stamp しているためこの前提は破れている。0017 はマージ済みで列を足せない
//   （embedding_kind を塗ると HNSW +93MB）。DB を 1 行も書かずに済むエポック定数で分ける。

// 新レシピ（title+本文冒頭）で embed を始めた瞬間。**段階 3 の実デプロイ時刻の直後の正時（UTC）**に
// 置く。EPOCH の誤りは非対称で、遅い側に倒すのが安全:
//   - 早すぎる → 旧レシピ行が lead に混入 → クロスレシピ汚染が near_dup_rate に入り fresh で記録（致命的）
//   - 遅すぎる → 初期の lead 行が legacy に落ちる → share 0.8 到達が数日遅れるだけ（軽微・自己回復）
// デプロイが遅れたら値を後ろへ動かすこと（前へは動かさない）。
export const EMBED_RECIPE_EPOCH = "2026-09-17T00:00:00.000Z";

// YAT-76 が旧レシピのまま embedded_at を stamp し始めた頃（テスト用の下限）。この時刻〜EPOCH の間に
// stamp された行は「旧レシピなのに embedded_at 非 null」＝汚染分で、recipeOf は legacy に落とす。
export const EMBED_STAMP_INTRODUCED = "2026-09-16T00:00:00.000Z";

export type EmbedRecipe = "legacy" | "lead";
export type RecipeCounts = Record<EmbedRecipe, number>;

// 窓の多数派がこの share に届かない間は算出しない（既知の空白）。
export const RECIPE_MAJORITY_SHARE = 0.8;
// 混在がこの日数続いたら異常（旧レシピが供給され続けている）。
export const RECIPE_MIXED_GRACE_DAYS = 45;

const DAY_MS = 86_400_000;

// embedded_at からレシピを読む。null / パース不能 / EPOCH 未満はすべて legacy
// （＝ YAT-76 が旧レシピで押した stamp を含む）。EPOCH 以降のみ lead。境界は inclusive（>=）。
export function recipeOf(embeddedAt: string | null | undefined): EmbedRecipe {
  if (!embeddedAt) return "legacy";
  const t = Date.parse(embeddedAt);
  if (!Number.isFinite(t)) return "legacy";
  return t >= Date.parse(EMBED_RECIPE_EPOCH) ? "lead" : "legacy";
}

// 多数派レシピとその share。total=0 なら { recipe: "legacy", share: 0, total: 0 }（段階 3 前・
// 窓に embedding が無い状態＝現行挙動へ合流）。同数は legacy 側に倒す（決定的）。
export function majorityRecipe(c: RecipeCounts): {
  recipe: EmbedRecipe;
  share: number;
  total: number;
} {
  const total = c.legacy + c.lead;
  if (total === 0) return { recipe: "legacy", share: 0, total: 0 };
  const recipe: EmbedRecipe = c.lead > c.legacy ? "lead" : "legacy";
  return { recipe, share: Math.max(c.legacy, c.lead) / total, total };
}

export type RecipeVerdict =
  // 多数派が確立 → その多数派レシピで near_dup を算出する
  | { kind: "compute"; recipe: EmbedRecipe; share: number; total: number }
  // 混在中だが猶予内 → 全 feed を null 化して exit 0（既知の空白）
  | { kind: "blank"; share: number; total: number; mixedDays: number }
  // 混在が猶予を超えた → exit 1（旧レシピが供給され続けている異常）
  | { kind: "stuck"; share: number; total: number; mixedDays: number };

// counts と「新レシピの最初の embed 時刻」から算出可否を判定する唯一の関数。
//
// firstLeadEmbeddedAt が null（新レシピ行ゼロ＝ day-0 / embed 全停止）なら clock 起点を EPOCH に
// フォールバックする——先送りにすると embed が死んだまま永久に緑になる
// （knowledge defer-on-zero-observation-needs-durable-probe）。firstLead が EPOCH より前（呼び出し側の
// フィルタ漏れ）でも EPOCH に clamp して clock が不当に早く切れないようにする。
export function judgeRecipe(
  counts: RecipeCounts,
  firstLeadEmbeddedAt: string | null,
  now: number,
): RecipeVerdict {
  const m = majorityRecipe(counts);
  const epochMs = Date.parse(EMBED_RECIPE_EPOCH);
  const firstMs = firstLeadEmbeddedAt ? Date.parse(firstLeadEmbeddedAt) : NaN;
  const clockStart = Number.isFinite(firstMs)
    ? Math.max(firstMs, epochMs)
    : epochMs;
  const mixedDays = (now - clockStart) / DAY_MS;

  if (m.total === 0) {
    // 窓に embedding が 1 件も無い。算出しようがないので blank（毎時の embedStalled が本命）。
    return { kind: "blank", share: m.share, total: m.total, mixedDays };
  }
  if (m.share >= RECIPE_MAJORITY_SHARE) {
    return { kind: "compute", recipe: m.recipe, share: m.share, total: m.total };
  }
  if (mixedDays >= RECIPE_MIXED_GRACE_DAYS) {
    return { kind: "stuck", share: m.share, total: m.total, mixedDays };
  }
  return { kind: "blank", share: m.share, total: m.total, mixedDays };
}

// near_dup_fresh の理由（snapshot に残す）。値だけでなく「その値を信じてよいか」を対で記録する
// （knowledge defer-on-zero-observation）。
export type NearDupFreshReason = "fresh" | "compute_failed" | "recipe_mixed";

// near_dup_fresh の判定を純関数に切り出す（snapshot が env とローカル share から合成する）。
// computeOk = compute-dedup-rate が exit 0 で回ったか（learn.yml が env で渡す・必要条件）。
// share = snapshot が今数えた窓の多数派 share（compute が実際に値を入れたか・十分条件）。
// 優先順位: compute が落ちていれば理由は compute_failed（share は見ない）。
export function nearDupFreshness(
  computeOk: boolean,
  share: number,
): { fresh: boolean; reason: NearDupFreshReason } {
  if (!computeOk) return { fresh: false, reason: "compute_failed" };
  if (share < RECIPE_MAJORITY_SHARE)
    return { fresh: false, reason: "recipe_mixed" };
  return { fresh: true, reason: "fresh" };
}
