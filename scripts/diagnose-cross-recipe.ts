import { config } from "dotenv";

// ローカル実行用に .env.local を読む。GitHub Actions では secrets が process.env にあり no-op。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import { parseEmbedding, cosineSim, DEDUP_THRESHOLD } from "../lib/ranking/dedup";
import { recipeOf } from "../lib/ranking/embed-recipe";
import { WINDOW_DAYS } from "../lib/ranking/near-dup-window";
import { pct } from "./_report-format";

// YAT-77 段階 3.5: クロスレシピの cosine 分布を実測する読み取り専用スクリプト。
//
// 目的: DEDUP_THRESHOLD=0.86 が、旧レシピ（title+summary・embedded_at < EPOCH）と新レシピ
// （title+lead・embedded_at >= EPOCH）の**クロスペア**でも同じ意味を持つか。同じ意味を持つなら
// 移行期にレシピを混ぜても near_dup が汚れない＝段階 4 のレシピフィルタは保険で済む。持たないなら
// レシピフィルタが必須。
//
// 計算は compute-dedup-rate と同じ有向・他 feed 限定の maxSim を写す（o.publishedAt < a.publishedAt
// ∧ o.feedId !== a.feedId）が、分布が欲しいので break せず maxSim を最後まで取る。
//
// 読み取り専用。DB は一切書き換えない（createAdminClient は service_role で書き込み権限を持つが、
// SELECT のみに限る）。LLM/embed 呼び出しは無いので課金は発生しない。本 PR では実行しない
// （新レシピが数日ぶん積まれてから回す）。

const SAMPLE_PER_RECIPE = 1000; // レシピごとの標本数（計 2,000 件・約 24MB の egress を一度だけ払う）

type Art = {
  feedId: string;
  vec: number[];
  publishedAt: number;
  recipe: "legacy" | "lead";
};

// レシピごとに直近 WINDOW_DAYS の embedding を新しい順に SAMPLE_PER_RECIPE 件取る。
async function fetchSample(
  supabase: ReturnType<typeof createAdminClient>,
  since: string,
  recipe: "legacy" | "lead",
): Promise<Art[]> {
  const out: Art[] = [];
  const PAGE = 1000;
  let offset = 0;
  while (out.length < SAMPLE_PER_RECIPE) {
    // 粗フィルタは付けず全 embedding を取り、レシピ最終判定は recipeOf に委ねる（EPOCH 境界の
    // µs ずれを JS 側に揃える）。PostgREST の select 文字列リテラルに .not() を条件で継ぎ足すと
    // 型推論が TS2589 になる（knowledge supabase-embedded-select-literal-ts2589）ので分岐で足さない。
    const { data, error } = await supabase
      .from("articles")
      .select("feed_id, embedding, published_at, embedded_at")
      .gte("published_at", since)
      .not("embedding", "is", null)
      .order("published_at", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as unknown as {
      feed_id: string;
      embedding: unknown;
      published_at: string | null;
      embedded_at: string | null;
    }[];
    if (batch.length === 0) break;
    for (const r of batch) {
      if (recipeOf(r.embedded_at) !== recipe) continue;
      const vec = parseEmbedding(r.embedding);
      if (!vec || !r.feed_id) continue;
      out.push({
        feedId: r.feed_id,
        vec,
        publishedAt: Date.parse(r.published_at ?? ""),
        recipe,
      });
      if (out.length >= SAMPLE_PER_RECIPE) break;
    }
    offset += batch.length;
  }
  return out;
}

// a を pool（他 feed・より早い記事）と突き合わせた有向 maxSim。
function directedMaxSim(a: Art, pool: Art[]): number {
  let max = -1;
  for (const o of pool) {
    if (o.feedId === a.feedId) continue;
    if (!(o.publishedAt < a.publishedAt)) continue; // NaN も false → 見送り
    const s = cosineSim(a.vec, o.vec);
    if (s > max) max = s;
  }
  return max;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}

function describe(label: string, sims: number[]): void {
  const valid = sims.filter((s) => s >= -1 && Number.isFinite(s));
  const sorted = [...valid].sort((x, y) => x - y);
  const over = valid.filter((s) => s >= DEDUP_THRESHOLD).length;
  console.log(
    `${label.padEnd(10)} n=${String(valid.length).padStart(5)}` +
      ` p50 ${quantile(sorted, 0.5).toFixed(3)}` +
      ` p90 ${quantile(sorted, 0.9).toFixed(3)}` +
      ` p95 ${quantile(sorted, 0.95).toFixed(3)}` +
      ` p99 ${quantile(sorted, 0.99).toFixed(3)}` +
      ` / >=${DEDUP_THRESHOLD} ${pct(over, valid.length)}`,
  );
}

async function main() {
  const supabase = createAdminClient();
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();

  const legacy = await fetchSample(supabase, since, "legacy");
  const lead = await fetchSample(supabase, since, "lead");
  console.log(
    `=== クロスレシピ cosine 分布（YAT-77 段階 3.5）===\n` +
      `標本: legacy ${legacy.length} / lead ${lead.length}（直近 ${WINDOW_DAYS}d・有向 maxSim・他 feed 限定）`,
  );
  if (legacy.length === 0 || lead.length === 0) {
    console.warn(
      "⚠ どちらかのレシピの標本が 0 件。新レシピがまだ積まれていない可能性が高い（段階 3 から数日待つ）",
    );
    return;
  }

  // 4 象限: new→old / new→new / old→old / old→new。a のレシピ → 比較プールのレシピ。
  const newToOld = lead.map((a) => directedMaxSim(a, legacy));
  const newToNew = lead.map((a) => directedMaxSim(a, lead));
  const oldToOld = legacy.map((a) => directedMaxSim(a, legacy));
  const oldToNew = legacy.map((a) => directedMaxSim(a, lead));

  describe("new→old", newToOld);
  describe("new→new", newToNew);
  describe("old→old", oldToOld);
  describe("old→new", oldToNew);

  console.log(
    `\n判定の目安: new→old の p90 が new→new / old→old の p90 から 0.02 以上ずれるなら、` +
      `レシピ混在は同じ意味を持たない → 段階 4 のレシピフィルタが必須（混ぜて算出してはいけない）。` +
      `ずれが小さければ混在を許容できる（レシピフィルタは保険）。`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
