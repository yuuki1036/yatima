import { config } from "dotenv";

// ローカル実行用に .env.local を読む。GitHub Actions では secrets が process.env にあり no-op。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import {
  evaluateFeedHealth,
  FEED_HEALTH_THRESHOLDS as TH,
  RETIRE_SIGNAL_WEIGHTS,
  RETIRE_REASON_LABELS,
  type FeedHealthInput,
  type RetireReason,
} from "../lib/ranking/feed-health";
import { loadSourcePrefs, FEEDBACK_WEIGHT } from "../lib/ranking/preferences";
import { parseEmbedding } from "../lib/ranking/dedup";
import {
  fetchWindowArticles,
  WINDOW_DAYS,
  MIN_OWN_ARTICLES,
  FETCH_CAP,
} from "../lib/ranking/near-dup-window";
import { padEndWide } from "./_report-format";
import type { Feed } from "../lib/types";

// YAT-60: feed 引退推奨スコアリングの較正用診断スクリプト。
// /feeds の RETIRE SUGGESTIONS は computeRetireSuggestions が recommend=true で filter するため、
// 「閾値を跨がなかった feed のシグナル値」が UI からも CLI からも観測できない。結果として
// 「推奨が出すぎているのか出なすぎているのか」を判断する材料が無い（YAT-55 のブロッカー）。
// このスクリプトは全 active feed を filter せず評価し、各シグナルの生値・閾値との差・立ったフラグ・
// score・recommend を一覧で出す。当てずっぽうで閾値を触らないための観測。
//
// あわせて near_dup_rate=null の内訳（初回 cron 前 / 母数不足 / embedding ゼロ / 記事ゼロ）を出す。
// null は「未算出」と「算出して 0」を区別できないため、near_dup が効いていないのか閾値が高すぎるのか
// を切り分けるにはこの内訳が要る。
//
// 読み取り専用。DB は一切書き換えない（createAdminClient は service_role で書き込み権限を持つので、
// SELECT のみに限ることを規約で担保する）。LLM 呼び出しが無いので課金は発生しない。
// 注意: near_dup_rate は上書き型で履歴が無く、過去に遡った較正が原理的にできない
// （dead は YAT-70 で articles.published_at 由来になったため遡れるようになった）。
// このスクリプトを入れてから定期的に回して分布を貯めるのが前提（YAT-55 の調査結果 B）。

// WINDOW_DAYS / MIN_OWN_ARTICLES / 取得クエリは near-dup-window から取る。以前はここに同値の
// 定数を置いて「compute-dedup-rate.ts と揃える」とコメントしていたが、揃っていたのは定数だけで
// クエリ（行数上限）はズレていた。母集団ごと共有して drift の余地を消す。
const DAY_MS = 86_400_000;

// feed ごとの記事状況。near_dup_rate=null の理由を切り分けるために数える。
type ArticleStats = { inWindow: number; withEmbedding: number; total: number; nullPublished: number };

function fmtDays(ms: number): string {
  if (!Number.isFinite(ms)) return "未取得";
  return `${(ms / DAY_MS).toFixed(1)}d`;
}

const pad = padEndWide;

async function main() {
  const supabase = createAdminClient();
  // now を一度固定して評価にも生値表示にも使う（page.tsx は既定の Date.now() 任せだが、
  // 診断では判定と表示の時刻がズレると内訳が読めなくなるため明示的に渡す）。
  const now = Date.now();

  // ── feeds + source pref（app/feeds/page.tsx と同じ組み立て）────────────────
  const { data: feedData, error: feedErr } = await supabase
    .from("feeds")
    .select("*")
    .order("created_at", { ascending: false });
  if (feedErr) {
    console.error("feeds の取得に失敗:", feedErr);
    process.exit(1);
  }
  const feeds = (feedData ?? []) as Feed[];
  // page.tsx は空 Map に倒す（UI が落ちないことを優先）。診断では黙って倒すと「pref シグナルが
  // 一件も立たない」を「嗜好は健全」と誤読するので、失敗したことを明示する。
  let prefsFailed = false;
  const sourcePrefs = await loadSourcePrefs(supabase).catch((e) => {
    console.warn("⚠ preferences の取得に失敗。pref 列は全て 0 として扱う（判定は無意味になる）:", e);
    prefsFailed = true;
    return new Map<string, number>();
  });

  const active = feeds.filter((f) => f.active);

  // dead シグナル用（YAT-70 で last_fetched_at から差し替え）。診断では「RPC が取れなかった」を
  // 黙って通すと dead 列が全て空欄になり健全と誤読されるので、失敗を明示して落とす。
  const { data: latestRows, error: lpErr } = await supabase.rpc("feed_latest_published");
  if (lpErr) {
    console.error(
      "feed_latest_published の取得に失敗（migration 0014 未適用の可能性）:",
      lpErr,
    );
    process.exit(1);
  }
  const latestPublished = new Map(
    ((latestRows ?? []) as { feed_id: string; latest_published_at: string | null }[]).map(
      (r) => [r.feed_id, r.latest_published_at],
    ),
  );

  const inputs: FeedHealthInput[] = active.map((f) => ({
    id: f.id,
    title: f.title,
    url: f.url,
    created_at: f.created_at,
    latestPublishedAt: latestPublished.get(f.id) ?? null,
    credibility: f.credibility,
    near_dup_rate: f.near_dup_rate,
    sourcePref: sourcePrefs.get(f.id) ?? 0,
  }));

  // ── articles（near_dup_rate=null の内訳用）──────────────────────────────
  // 母集団は compute-dedup-rate.ts と共有する（near-dup-window）。ここが 1 行でもズレると
  // 「なぜ null なのか」の内訳が算出側の実態と食い違い、診断の意味が無くなる。
  const { rows: articles, truncated } = await fetchWindowArticles(supabase, now);
  const stats = new Map<string, ArticleStats>();
  for (const a of articles) {
    const s = stats.get(a.feed_id) ?? { inWindow: 0, withEmbedding: 0, total: 0, nullPublished: 0 };
    s.total += 1;
    s.inWindow += 1;
    // compute-dedup-rate は parseEmbedding 失敗行も捨てるので、そこまで揃える。
    if (parseEmbedding(a.embedding)) s.withEmbedding += 1;
    stats.set(a.feed_id, s);
  }
  if (truncated) {
    console.warn(
      `⚠ 窓内の記事が安全弁 ${FETCH_CAP} 件に達した。古い記事が切れており、` +
        `feed 別の embedding 件数が実態より小さく出る（母数不足の誤判定につながる）`,
    );
  }

  // 窓外・embedding 無しも含めた feed 別の記事有無。「記事そのものが無い」と
  // 「記事はあるが窓/embedding の条件で落ちた」を切り分けるために別途数える。
  //
  // 以前はここも articles を一括 select して JS 側で数えていたが、articles は 3 万行あり
  // PostgREST の db-max-rows（1000）で新着 1000 件に切られていた。結果、最近記事の無い feed が
  // 軒並み「記事そのものが無い」に誤分類されていた。件数しか要らないので head+count で feed ごとに
  // 引く（33 feed 程度なら往復コストより正確さが勝つ。行数上限に原理的に左右されない）。
  const hasAnyArticle = new Map<string, { total: number; nullPublished: number }>();
  for (const input of inputs) {
    const { count: total, error: cErr } = await supabase
      .from("articles")
      .select("id", { count: "exact", head: true })
      .eq("feed_id", input.id);
    if (cErr) {
      console.error("articles の件数取得に失敗:", cErr);
      process.exit(1);
    }
    // published_at が null の記事は compute-dedup-rate の 30d 窓（gte）から構造的に漏れる。
    const { count: nullPublished, error: nErr } = await supabase
      .from("articles")
      .select("id", { count: "exact", head: true })
      .eq("feed_id", input.id)
      .is("published_at", null);
    if (nErr) {
      console.error("articles の件数取得に失敗:", nErr);
      process.exit(1);
    }
    hasAnyArticle.set(input.id, { total: total ?? 0, nullPublished: nullPublished ?? 0 });
  }

  // ── 評価（filter せず全 active feed）────────────────────────────────────
  const rows = inputs.map((input) => {
    const result = evaluateFeedHealth(input, now);
    const ageMs = now - Date.parse(input.created_at);
    // 発信停滞（最新記事の公開からの経過）。記事ゼロは Infinity＝「未発信」として扱う。
    const quietMs =
      input.latestPublishedAt == null
        ? Infinity
        : now - Date.parse(input.latestPublishedAt);
    return { input, result, ageMs, quietMs, stat: stats.get(input.id) };
  });
  rows.sort((a, b) => b.result.score - a.result.score);

  console.log("=== feed 引退スコアリング診断（YAT-60） ===");
  console.log(
    `feed 総数 ${feeds.length}（active ${active.length} / 非活性 ${feeds.length - active.length}）` +
      ` / 推奨 ${rows.filter((r) => r.result.recommend).length}`,
  );
  console.log(
    `閾値: dead(発信停滞)>${TH.DEAD_DAYS}d（新規猶予 ${TH.NEW_FEED_GRACE_DAYS}d） / credibility<${TH.LOW_CREDIBILITY}` +
      ` / pref<${TH.LOW_PREF} / near_dup>=${TH.NEAR_DUP_RATE}`,
  );
  console.log(
    `加重: ${(Object.keys(RETIRE_SIGNAL_WEIGHTS) as RetireReason[]).map((k) => `${k}=${RETIRE_SIGNAL_WEIGHTS[k]}`).join(" / ")}`,
  );
  if (prefsFailed) {
    console.log("⚠ preferences 取得失敗のため pref 列と low_pref 判定は無効（全て 0 扱い）");
  }

  console.log("\n--- 全 active feed のシグナル値（score 降順・推奨は ★）---");
  console.log(
    `${pad("feed", 28)} ${"score".padStart(5)} ${"沈黙".padStart(7)} ${"cred".padStart(6)} ${"pref".padStart(6)} ${"ndup".padStart(6)}  理由`,
  );
  for (const r of rows) {
    const mark = r.result.recommend ? "★" : " ";
    const nd = r.input.near_dup_rate === null ? "null" : r.input.near_dup_rate.toFixed(2);
    const reasons = r.result.reasons.map((x) => RETIRE_REASON_LABELS[x]).join(",") || "―";
    console.log(
      `${mark}${pad(r.input.title ?? r.input.url, 27)} ${r.result.score.toFixed(1).padStart(5)}` +
        ` ${fmtDays(r.quietMs).padStart(7)} ${r.input.credibility.toFixed(2).padStart(6)}` +
        ` ${r.input.sourcePref.toFixed(2).padStart(6)} ${nd.padStart(6)}  ${reasons}`,
    );
  }

  // ── 閾値までの距離（出すぎ/出なすぎの判断材料）──────────────────────────
  console.log("\n--- 閾値までの距離（近いものから。閾値を動かしたとき最初に動く feed）---");
  const dismissW = Math.abs(FEEDBACK_WEIGHT.dismiss);
  // 「閾値を動かしたとき最初に動く feed」を見るための表なので、**まだ立っていないシグナル**の
  // うち閾値に最も近いものを並べる。既に立っている feed を混ぜると（符号付き gap の昇順だと
  // 大きく割り込んだ feed が上位を占め）肝心の境界付近が枠から押し出される。
  const gapStr = (gap: number): string => (gap < 0 ? `到達済(${gap.toFixed(2)})` : `+${gap.toFixed(2)}`);
  const graceMs = TH.NEW_FEED_GRACE_DAYS * DAY_MS;
  const near = rows
    .map((r) => {
      // credibility / pref は「閾値を下回る」で立つので、gap は現在値 - 閾値（負なら到達済）。
      const credGap = r.input.credibility - TH.LOW_CREDIBILITY;
      const prefGap = r.input.sourcePref - TH.LOW_PREF;
      // dead は evaluateFeedHealth が新規猶予中は判定自体をスキップする。ここもそれに揃えないと
      // 追加直後で未取得（staleMs=Infinity）の feed が「dead 到達済」と出てスコア表と矛盾する。
      const isNew = r.ageMs < graceMs;
      const staleGap = isNew ? null : (TH.DEAD_DAYS * DAY_MS - r.quietMs) / DAY_MS;
      // まだ立っていないシグナルの中で最も閾値に近い距離。全部立っていれば対象外。
      const pending = [credGap, prefGap, staleGap].filter(
        (g): g is number => g !== null && g >= 0,
      );
      return {
        title: r.input.title ?? r.input.url,
        credGap,
        prefGap,
        staleGap,
        isNew,
        graceLeftDays: (graceMs - r.ageMs) / DAY_MS,
        flagged: r.result.recommend,
        nearest: pending.length > 0 ? Math.min(...pending) : Infinity,
      };
    })
    .filter((n) => Number.isFinite(n.nearest))
    .sort((a, b) => a.nearest - b.nearest)
    .slice(0, 12);
  for (const n of near) {
    // 判定は strict（< 閾値）なので、gap をちょうど使い切っただけでは立たない。1 回余分に要る。
    const dismissesLeft = n.prefGap >= 0 ? Math.floor(n.prefGap / dismissW) + 1 : 0;
    const dismissNote = n.prefGap >= 0 ? `あと ${dismissesLeft} 回 dismiss` : "pref 到達済";
    const deadNote = n.isNew
      ? `新規猶予中（あと ${n.graceLeftDays.toFixed(1)}d は判定対象外）`
      : n.staleGap !== null && n.staleGap > 0
        ? `あと ${n.staleGap.toFixed(1)}d`
        : "到達済";
    console.log(
      `  ${n.flagged ? "★" : " "}${pad(n.title, 27)} cred ${gapStr(n.credGap)}` +
        ` / pref ${gapStr(n.prefGap)}（${dismissNote}）` +
        ` / dead ${deadNote}`,
    );
  }
  console.log(
    `  ※ 未到達のシグナルが 1 つ以上ある feed のみ、閾値に近い順に最大 12 件。★ は別シグナルで既に推奨済み`,
  );
  console.log(
    `  ※ credibility / pref は「< 閾値」の strict 比較。ちょうど ${TH.LOW_CREDIBILITY} の feed は` +
      `フラグが立たない（cred +0.00 の行がそれ）。dismiss 回数もこれを織り込んで +1 している`,
  );

  // ── near_dup_rate = null の内訳 ────────────────────────────────────────
  const nullRows = rows.filter((r) => r.input.near_dup_rate === null);
  const nonNull = rows.length - nullRows.length;
  console.log(
    `\n--- near_dup_rate = null の内訳（${nullRows.length} / ${rows.length} feed）` +
      `｜母集団: 直近 ${WINDOW_DAYS}d の embedding 付き記事 ${articles.length} 件 ---`,
  );
  if (nonNull === 0 && rows.length > 0) {
    console.log(
      "  ⚠ active feed の全件が null。compute-dedup-rate の cron が一度も回っていない可能性が高い",
    );
    console.log("    （このジョブは active feed 全件を必ず update するため、1 件でも非 null なら実行済み）");
  }
  let noArticle = 0;
  let onlyNullPublished = 0;
  let noEmbed = 0;
  let tooFew = 0;
  // 母数は足りているのに null ＝ cron 未実行 / 途中失敗。件数だけでは「直近追加の feed だから
  // まだ月曜 cron を通っていない（無害）」と「update が途中で落ちた（要調査）」を切り分けられない
  // ので、該当 feed を名前・embedding 件数・feed 齢つきで挙げる。
  const enoughButNullRows: typeof nullRows = [];
  for (const r of nullRows) {
    const withEmbed = r.stat?.withEmbedding ?? 0;
    const any = hasAnyArticle.get(r.input.id);
    if (withEmbed >= MIN_OWN_ARTICLES) enoughButNullRows.push(r);
    else if (withEmbed > 0) tooFew += 1;
    else if (!any || any.total === 0) noArticle += 1;
    // 記事は存在するが published_at が全て null → 30d 窓（gte）に構造的に入らない。
    else if (any.nullPublished === any.total) onlyNullPublished += 1;
    else noEmbed += 1;
  }
  console.log(`  記事そのものが無い                   : ${noArticle}`);
  console.log(`  記事はあるが published_at が全て null : ${onlyNullPublished}`);
  console.log(`  窓内に記事はあるが embedding が 0 件  : ${noEmbed}`);
  console.log(`  embedding 1〜${MIN_OWN_ARTICLES - 1} 件（母数不足）       : ${tooFew}`);
  console.log(`  embedding ${MIN_OWN_ARTICLES} 件以上あるのに null      : ${enoughButNullRows.length}`);
  if (enoughButNullRows.length > 0) {
    for (const r of enoughButNullRows) {
      // created_at は null 許容。齢が出せないと「直近追加か否か」の切り分けができないので明示する。
      const age = Number.isFinite(r.ageMs)
        ? `feed 齢 ${(r.ageMs / DAY_MS).toFixed(1)}d（作成 ${r.input.created_at?.slice(0, 10)}）`
        : "feed 齢 不明（created_at が null）";
      console.log(
        `    - ${pad(r.input.title ?? r.input.url, 27)} embedding ${r.stat?.withEmbedding ?? 0} 件 / ${age}`,
      );
    }
    console.log(
      `  ⚠ 母数は足りているので「MIN_OWN_ARTICLES を下げる」は対処にならない。` +
        `疑う順は ①算出側を直した直後で cron がまだ回っていない ②直近に追加した feed ` +
        `③update 失敗でループが途中終了、の順`,
    );
    console.log(
      `    （near_dup_rate は DB に保存された値、母数はいま数えた値なので、両者は算出時点の` +
        `母集団がズレていれば食い違う。まず \`npm run compute-dedup-rate\` を回して` +
        `再測定し、それでも残る feed だけが本当の異常）`,
    );
  }
  if (onlyNullPublished > 0) {
    console.log(
      `  ※ published_at が null の記事は compute-dedup-rate の 30d 窓（gte）から漏れる。` +
        `feed は生きているのに near_dup が永久に算出されない`,
    );
  }
  if (noEmbed > 0) {
    console.log(
      `  ※ embedding は要約済み記事にしか付かず、要約予算は credibility でリランクされる。` +
        `低 credibility feed ほど near_dup が算出されない構造（YAT-55 の調査結果 E）`,
    );
  }

  console.log(
    `\n※ near_dup_rate は上書き型で履歴が無い。分布を得るには本スクリプトを定期実行して記録を貯める` +
      `必要がある（dead は YAT-70 で articles.published_at 由来になったため遡れる）`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
