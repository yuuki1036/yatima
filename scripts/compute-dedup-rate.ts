import { config } from "dotenv";

// ローカル実行用に .env.local を読む。GitHub Actions では secrets が process.env にあり no-op。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import { parseEmbedding, cosineSim, DEDUP_THRESHOLD } from "../lib/ranking/dedup";

// feed ごとの「重複量産率」を事前算出して feeds.near_dup_rate に書き込む週次ジョブ（YAT-20）。
// 削除推奨の near-dup シグナル。新規 embedding は発生せず、既存ベクタの cosine 集計のみ。
// /feeds 表示時に pgvector NN を多数叩かないための事前算出。learn.yml（週次）から回す。
//
// 算出: active feed A について「A の直近30日記事（最大100件）」の各記事が、
// 「他 feed の直近30日記事（最大1000件）」のいずれかと cosine >= 0.86 で近重複になる割合。
// 母数（embedding を持つ A の記事）が 0 件なら null（未算出）に倒す。

const WINDOW_DAYS = 30;
const PER_FEED_LIMIT = 100; // 自 feed 側の評価対象（直近）
const COMPARE_LIMIT = 1000; // 他 feed 側の比較プール（直近）
const FETCH_LIMIT = 5000; // 取得する直近記事の上限（安全弁）

type Art = { feedId: string; vec: number[] };

async function main() {
  const supabase = createAdminClient();

  // ── 対象は active feed のみ（非活性 feed は推奨対象外なので算出不要）。
  const { data: feeds, error: fErr } = await supabase
    .from("feeds")
    .select("id")
    .eq("active", true);
  if (fErr) throw fErr;
  const feedIds = (feeds ?? []).map((f) => f.id as string);
  if (feedIds.length === 0) {
    console.log("active feed が無いため算出をスキップしました");
    return;
  }

  // ── 直近30日・embedding ありの記事をまとめて取得（新しい順）。
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const { data: arts, error: aErr } = await supabase
    .from("articles")
    .select("feed_id, embedding, published_at")
    .gte("published_at", since)
    .not("embedding", "is", null)
    .order("published_at", { ascending: false })
    .limit(FETCH_LIMIT);
  if (aErr) throw aErr;

  // feed_id ごとにパース済みベクタを束ねる（新しい順を維持）。
  const byFeed = new Map<string, Art[]>();
  const all: Art[] = [];
  for (const a of arts ?? []) {
    const vec = parseEmbedding((a as { embedding?: unknown }).embedding);
    const feedId = (a.feed_id ?? "") as string;
    if (!vec || !feedId) continue;
    const art = { feedId, vec };
    const bucket = byFeed.get(feedId);
    if (bucket) bucket.push(art);
    else byFeed.set(feedId, [art]);
    all.push(art);
  }

  // ── feed ごとに near-dup 率を算出して UPDATE。
  let updated = 0;
  for (const feedId of feedIds) {
    const own = (byFeed.get(feedId) ?? []).slice(0, PER_FEED_LIMIT);
    let rate: number | null;
    if (own.length === 0) {
      rate = null; // embedding を持つ記事が無い → 未算出
    } else {
      // 比較プールは「他 feed 横断の新着 COMPARE_LIMIT 件」。高頻度 feed が新着上位を占めると
      // 低頻度 feed の重複が過小評価される方向に偏る（安全側＝推奨を出しすぎない）。feed が
      // 大規模化したら own の published_at 近傍で others を引く設計に寄せて偏りを減らす。
      const others = all
        .filter((x) => x.feedId !== feedId)
        .slice(0, COMPARE_LIMIT);
      let dup = 0;
      for (const a of own) {
        if (others.some((o) => cosineSim(a.vec, o.vec) >= DEDUP_THRESHOLD))
          dup += 1;
      }
      rate = dup / own.length;
    }
    const { error: uErr } = await supabase
      .from("feeds")
      .update({ near_dup_rate: rate })
      .eq("id", feedId);
    if (uErr) throw uErr;
    updated += 1;
  }

  console.log(
    `active feed ${feedIds.length} / 記事 ${all.length} / near_dup_rate 更新 ${updated}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
