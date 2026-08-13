import { config } from "dotenv";

// ローカル実行用に .env.local を読む。GitHub Actions では secrets が process.env にあり no-op。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import { parseEmbedding, cosineSim, DEDUP_THRESHOLD } from "../lib/ranking/dedup";
import {
  fetchWindowArticles,
  WINDOW_DAYS,
  MIN_OWN_ARTICLES,
  FETCH_CAP,
} from "../lib/ranking/near-dup-window";

// feed ごとの「重複量産率」を事前算出して feeds.near_dup_rate に書き込む週次ジョブ（YAT-20）。
// 削除推奨の near-dup シグナル。新規 embedding は発生せず、既存ベクタの cosine 集計のみ。
// /feeds 表示時に pgvector NN を多数叩かないための事前算出。learn.yml（週次）から回す。
//
// 算出: active feed A について「A の直近30日記事（最大100件）」の各記事が、
// 「他 feed の直近30日記事（窓内全件）」のうち **A より早く公開されたもの** のいずれかと
// cosine >= 0.86 で近重複になる割合（YAT-70 で有向化。それ以前は向きを見ていなかったため、
// 転載された一次ソース側が「重複量産」と誤判定されていた）。
// 母数（embedding を持つ A の直近記事）が MIN_OWN_ARTICLES 件未満なら null（未算出）に倒す
// — 小サンプルでは 1 件のマッチだけで率が 1.0 に振れ、良質だが低頻度の feed を誤って
// 推奨へ上げてしまうため（YAT-36）。

// WINDOW_DAYS / MIN_OWN_ARTICLES / 取得クエリは near-dup-window に集約した
// （diagnose-feed-health.ts と母集団を共有するため。定数コメントでの手動同期は drift した）。
const PER_FEED_LIMIT = 100; // 自 feed 側の評価対象（直近）

// 比較プールにはかつて COMPARE_LIMIT=1000（他 feed の新着 1000 件）を掛けていたが撤廃した。
// 母集団の取りこぼしを直して own が窓全体に広がった結果、own（30日）と others（新着1000件＝
// 実測で約5日）の時間帯が噛み合わなくなり、own の古い記事が「比較相手のいない期間」と突き合わ
// されて近重複が原理的に検出されなくなった（実測: near_dup_rate が軒並み低下し、最大でも 0.40 と
// 閾値 0.5 に届かずシグナルが死んだ）。窓全体と比較すれば定義どおりになる。
// コストは許容範囲: 総実行時間はほぼ embedding の fetch 待ちで、cosine は CPU 数秒しか使わない。

type Art = { feedId: string; vec: number[]; publishedAt: number };

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

  // ── 直近30日・embedding ありの記事をまとめて取得（新しい順・.range() で全件）。
  const { rows: arts, truncated } = await fetchWindowArticles(supabase, Date.now());
  if (truncated) {
    console.warn(
      `⚠ 窓内の記事が安全弁 ${FETCH_CAP} 件に達した。古い側が切れており窓が実質縮んでいる。` +
        `低頻度 feed が母数不足（<${MIN_OWN_ARTICLES}）に倒れて near_dup_rate が null になる方向に偏る`,
    );
  }

  // feed_id ごとにパース済みベクタを束ねる（新しい順を維持）。
  const byFeed = new Map<string, Art[]>();
  const all: Art[] = [];
  for (const a of arts ?? []) {
    const vec = parseEmbedding((a as { embedding?: unknown }).embedding);
    const feedId = (a.feed_id ?? "") as string;
    if (!vec || !feedId) continue;
    // 有向判定に使う公開時刻。窓のクエリが published_at で絞っているので通常は非 null だが、
    // パース不能なら NaN のまま置く（比較が false になり dup に数えられない＝安全側）。
    const publishedAt = Date.parse(
      ((a as { published_at?: string | null }).published_at ?? "") as string,
    );
    const art = { feedId, vec, publishedAt };
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
    if (own.length < MIN_OWN_ARTICLES) {
      rate = null; // embedding を持つ記事が母数未満 → 小サンプル膨張を避けて未算出
    } else {
      // 比較プールは窓内の他 feed 記事の全件。自 feed を除く判定はループ内で行い、feed ごとに
      // 6000 件規模の配列を作り直さない。一致が見つかった時点で打ち切る（元の .some() と同じ）。
      let dup = 0;
      for (const a of own) {
        for (const o of all) {
          if (o.feedId === feedId) continue;
          // 有向化（YAT-70）: dup と数えるのは「**より早く公開した**他 feed の記事と一致」した
          // 場合だけ。「重複量産 = 他所が既に出したものを後追いで出す」という語義に合わせる。
          //
          // 無向だった頃は、公式発表を後追い媒体が転載すると転載側でなく**一次ソース**が
          // 重複量産と判定されていた（実測: 唯一フラグが立った Google DeepMind News は
          // 重複 4 件すべてで一次ソース側。有向にすると 0.67 → 0.00）。
          //
          // 同時刻は dup に数えない（どちらが後追いか決められないため安全側に倒す）。
          // 時刻比較を cosine の前に置くのは意味だけでなく速度のため（重い方を後段にする）。
          if (!(o.publishedAt < a.publishedAt)) continue; // NaN を含む場合も false → 見送り
          if (cosineSim(a.vec, o.vec) >= DEDUP_THRESHOLD) {
            dup += 1;
            break;
          }
        }
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
    `active feed ${feedIds.length} / 記事 ${all.length}（直近 ${WINDOW_DAYS}d）/ near_dup_rate 更新 ${updated}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
