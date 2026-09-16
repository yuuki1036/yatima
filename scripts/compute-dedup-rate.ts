import { config } from "dotenv";

// ローカル実行用に .env.local を読む。GitHub Actions では secrets が process.env にあり no-op。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import { parseEmbedding, cosineSim, DEDUP_THRESHOLD } from "../lib/ranking/dedup";
import {
  fetchWindowArticles,
  filterByRecipe,
  firstLeadEmbeddedAt,
  WINDOW_DAYS,
  MIN_OWN_ARTICLES,
  PER_FEED_LIMIT,
  FETCH_CAP,
} from "../lib/ranking/near-dup-window";
import {
  judgeRecipe,
  RECIPE_MAJORITY_SHARE,
  RECIPE_MIXED_GRACE_DAYS,
} from "../lib/ranking/embed-recipe";

// feed ごとの「重複量産率」を事前算出して feeds.near_dup_rate に書き込む週次ジョブ（YAT-20）。
// 削除推奨の near-dup シグナル。新規 embedding は発生せず、既存ベクタの cosine 集計のみ。
// /feeds 表示時に pgvector NN を多数叩かないための事前算出。learn.yml（週次）から回す。
//
// 算出: active feed A について「A の直近30日記事（最大100件）」の各記事が、
// 「他 feed の直近30日記事（窓内全件）」のうち **A より早く公開されたもの** のいずれかと
// cosine >= 0.86 で近重複になる割合（YAT-70 で有向化。それ以前は向きを見ていなかったため、
// 転載された一次ソース側が「重複量産」と誤判定されていた）。
// 母数（embedding を持つ A の直近記事）が MIN_OWN_ARTICLES 件未満なら null（未算出）に倒す
// — 小サンプルでは 1 件のマッチが率を 1/母数 ぶん動かしてしまい、良質だが低頻度の feed を誤って
// 推奨へ上げてしまうため（YAT-36）。
//
// 既知の偏り（有向化で新たに生じたもの・未対処）: 窓の**古い端**にある記事は「自分より早い記事」の
// 比較プールが構造的に小さい。窓の下端に接する記事は比較相手がほぼ居らず、dup と判定されにくい。
// own は「その feed の新しい順 100 件」なので、高頻度 feed の own は窓の新しい側に固まり影響が
// 小さい一方、低頻度 feed の own は窓全体に広がるため影響を受けやすい。偏りの向きは
// 過小評価（＝退役推奨を出しすぎない安全側）。直すなら others 側だけ窓を広げて取る必要があり、
// 取得コストが増えるので較正時に判断する（YAT-55）。

// WINDOW_DAYS / MIN_OWN_ARTICLES / PER_FEED_LIMIT / 取得クエリは near-dup-window に集約した
// （diagnose-feed-health.ts と母集団を共有するため。定数コメントでの手動同期は drift した）。


// 比較プールにはかつて COMPARE_LIMIT=1000（他 feed の新着 1000 件）を掛けていたが撤廃した。
// 母集団の取りこぼしを直して own が窓全体に広がった結果、own（30日）と others（新着1000件＝
// 実測で約5日）の時間帯が噛み合わなくなり、own の古い記事が「比較相手のいない期間」と突き合わ
// されて近重複が原理的に検出されなくなった（実測: near_dup_rate が軒並み低下し、最大でも 0.40。
// 当時の閾値 0.5（無向スケール）に届かずシグナルが死んだ。**この 0.5 は現行値ではない** —
// YAT-70 の有向化に合わせて 0.2 に下げてあるので、0.40 は今なら余裕でフラグが立つ）。
// 窓全体と比較すれば定義どおりになる。
// コストは許容範囲: 総実行時間はほぼ embedding の fetch 待ちで、cosine は CPU 数秒しか使わない。

type Art = { feedId: string; vec: number[]; publishedAt: number };

async function main() {
  const supabase = createAdminClient();
  // --dry-run: UPDATE を打たず share / verdict / 混在日数だけ出す（本番投入前の確認用・YAT-77）。
  const dryRun = process.argv.includes("--dry-run");

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
  const {
    rows: allArts,
    truncated,
    byRecipe,
  } = await fetchWindowArticles(supabase, Date.now());
  if (truncated) {
    console.warn(
      `⚠ 窓内の記事が安全弁 ${FETCH_CAP} 件に達した。古い側が切れており窓が実質縮んでいる。` +
        `低頻度 feed が母数不足（<${MIN_OWN_ARTICLES}）に倒れて near_dup_rate が null になる方向に偏る`,
    );
  }

  // ── レシピ移行の判定（YAT-77 段階 4）。旧レシピ（title+summary）と新レシピ（title+lead）が
  // 窓で混ざる期間は、多数派 share が 0.8 に届くまで算出しない（クロスレシピ汚染を near_dup_rate に
  // 入れない）。firstLead は 45 日 clock の耐久 probe（DB 由来・prune で消えない）。
  const firstLead = await firstLeadEmbeddedAt(supabase);
  const verdict = judgeRecipe(byRecipe, firstLead, Date.now());
  console.log(
    `レシピ内訳: legacy ${byRecipe.legacy} / lead ${byRecipe.lead}` +
      `（多数派 ${verdict.kind === "compute" ? verdict.recipe : majorityLabel(byRecipe)} ` +
      `share ${verdict.share.toFixed(2)} / 判定 ${verdict.kind}` +
      (verdict.kind === "compute"
        ? ""
        : ` / 混在 ${verdict.mixedDays.toFixed(1)}d・猶予 ${RECIPE_MIXED_GRACE_DAYS}d`) +
      `）`,
  );

  // compute 以外は全 feed の near_dup_rate を null にする（既知の空白）。stuck は null 化を
  // **先に**済ませてから exit 1 する（snapshot の「行を insert してから exit」と同じ作法——
  // exit の前に DB を正しい状態＝古い値を残さない状態にする）。
  if (verdict.kind !== "compute") {
    if (verdict.kind === "blank") {
      console.warn(
        `⚠ レシピ多数派 share ${verdict.share.toFixed(2)} < ${RECIPE_MAJORITY_SHARE}。` +
          `混在中のため全 active feed の near_dup_rate を null にする（既知の空白・exit 0）`,
      );
    } else {
      console.error(
        `✗ レシピ混在が ${verdict.mixedDays.toFixed(1)}d 続いている（猶予 ${RECIPE_MIXED_GRACE_DAYS}d 超過）。` +
          `旧レシピが供給され続けている可能性が高い（embed の切り離しが効いているか確認）`,
      );
    }
    if (dryRun) {
      console.log(`[dry-run] ${feedIds.length} feed を null にする UPDATE は実行しない`);
    } else {
      await nullifyAll(supabase, feedIds);
      console.log(`active feed ${feedIds.length} の near_dup_rate を null にした`);
    }
    if (verdict.kind === "stuck") process.exit(1);
    return;
  }

  // compute: 多数派レシピの記事だけで算出する（own と比較プールの両方に効かせる）。
  // 多数派が legacy かつ share 1.0（段階 3 前・revert 後）なら 1 行も落ちない＝現行挙動に合流。
  const arts = filterByRecipe(allArts, verdict.recipe);

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
    if (dryRun) {
      updated += 1;
      continue;
    }
    const { error: uErr } = await supabase
      .from("feeds")
      .update({ near_dup_rate: rate })
      .eq("id", feedId);
    if (uErr) throw uErr;
    updated += 1;
  }

  console.log(
    `active feed ${feedIds.length} / 記事 ${all.length}（直近 ${WINDOW_DAYS}d・${verdict.recipe}）` +
      `/ near_dup_rate ${dryRun ? "算出（dry-run・未更新）" : "更新"} ${updated}`,
  );
}

// 全 active feed の near_dup_rate を null にする（レシピ混在の既知の空白）。
// PostgREST の .in() は URL 長超過（knowledge supabase-in-filter-url-length-limit）を避けるため
// feed 数ぶんループで UPDATE する（active feed は数十本規模なので往復コストは無視できる）。
async function nullifyAll(
  supabase: ReturnType<typeof createAdminClient>,
  feedIds: string[],
): Promise<void> {
  for (const feedId of feedIds) {
    const { error } = await supabase
      .from("feeds")
      .update({ near_dup_rate: null })
      .eq("id", feedId);
    if (error) throw error;
  }
}

function majorityLabel(c: { legacy: number; lead: number }): string {
  return c.lead > c.legacy ? "lead" : "legacy";
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
