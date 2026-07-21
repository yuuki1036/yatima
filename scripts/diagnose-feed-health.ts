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
// 注意: dead 日数と near_dup_rate は上書き型で履歴が無く、過去に遡った較正が原理的にできない。
// このスクリプトを入れてから定期的に回して分布を貯めるのが前提（YAT-55 の調査結果 B）。

const WINDOW_DAYS = 30; // near_dup_rate 算出の対象窓（compute-dedup-rate.ts と揃える）
const MIN_OWN_ARTICLES = 5; // 母数不足の判定（compute-dedup-rate.ts と揃える）
const FETCH_LIMIT = 5000; // articles 取得の安全弁（compute-dedup-rate.ts と揃える）
const DAY_MS = 86_400_000;

type ArticleRow = { feed_id: string; embedding: unknown; published_at: string | null };

// feed ごとの記事状況。near_dup_rate=null の理由を切り分けるために数える。
type ArticleStats = { inWindow: number; withEmbedding: number; total: number; nullPublished: number };

function fmtDays(ms: number): string {
  if (!Number.isFinite(ms)) return "未取得";
  return `${(ms / DAY_MS).toFixed(1)}d`;
}

function pad(s: string, n: number): string {
  // 全角を 2 幅として数え、日本語 title が混ざっても列がずれないようにする。
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = /[　-鿿＀-｠￠-￦]/.test(ch) ? 2 : 1;
    if (w + cw > n) break;
    out += ch;
    w += cw;
  }
  return out + " ".repeat(Math.max(0, n - w));
}

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
  const sourcePrefs = await loadSourcePrefs(supabase).catch(() => new Map<string, number>());

  const active = feeds.filter((f) => f.active);
  const inputs: FeedHealthInput[] = active.map((f) => ({
    id: f.id,
    title: f.title,
    url: f.url,
    created_at: f.created_at,
    last_fetched_at: f.last_fetched_at,
    credibility: f.credibility,
    near_dup_rate: f.near_dup_rate,
    sourcePref: sourcePrefs.get(f.id) ?? 0,
  }));

  // ── articles（near_dup_rate=null の内訳用）──────────────────────────────
  // compute-dedup-rate.ts と同じ条件で数える: 直近 WINDOW_DAYS・embedding 非 null。
  // parseEmbedding 失敗分まで揃えるため embedding 本体も引く。
  const since = new Date(now - WINDOW_DAYS * DAY_MS).toISOString();
  const { data: artData, error: artErr } = await supabase
    .from("articles")
    .select("feed_id, embedding, published_at")
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(FETCH_LIMIT);
  if (artErr) {
    console.error("articles の取得に失敗:", artErr);
    process.exit(1);
  }
  const articles = (artData ?? []) as unknown as ArticleRow[];
  const stats = new Map<string, ArticleStats>();
  for (const a of articles) {
    const s = stats.get(a.feed_id) ?? { inWindow: 0, withEmbedding: 0, total: 0, nullPublished: 0 };
    s.total += 1;
    // published_at が null の記事は 30 日窓の gte から漏れる（compute-dedup-rate と同じ挙動）。
    // 「記事は来ているのに窓に入らない」ケースの主因になるので別に数える。
    if (a.published_at === null) s.nullPublished += 1;
    else if (a.published_at >= since) {
      s.inWindow += 1;
      if (parseEmbedding(a.embedding)) s.withEmbedding += 1;
    }
    stats.set(a.feed_id, s);
  }
  if (articles.length >= FETCH_LIMIT) {
    console.warn(
      `⚠ articles の取得が上限 ${FETCH_LIMIT} 件に達した。古い記事が切れているため` +
        `「30d 記事 0 件」の判定が実態より多く出る可能性がある`,
    );
  }

  // ── 評価（filter せず全 active feed）────────────────────────────────────
  const rows = inputs.map((input) => {
    const result = evaluateFeedHealth(input, now);
    const ageMs = now - Date.parse(input.created_at);
    const staleMs =
      input.last_fetched_at === null ? Infinity : now - Date.parse(input.last_fetched_at);
    return { input, result, ageMs, staleMs, stat: stats.get(input.id) };
  });
  rows.sort((a, b) => b.result.score - a.result.score);

  console.log("=== feed 引退スコアリング診断（YAT-60） ===");
  console.log(
    `feed 総数 ${feeds.length}（active ${active.length} / 非活性 ${feeds.length - active.length}）` +
      ` / 推奨 ${rows.filter((r) => r.result.recommend).length}`,
  );
  console.log(
    `閾値: dead>${TH.DEAD_DAYS}d（新規猶予 ${TH.NEW_FEED_GRACE_DAYS}d） / credibility<${TH.LOW_CREDIBILITY}` +
      ` / pref<${TH.LOW_PREF} / near_dup>=${TH.NEAR_DUP_RATE}`,
  );
  console.log(
    `加重: ${(Object.keys(RETIRE_SIGNAL_WEIGHTS) as RetireReason[]).map((k) => `${k}=${RETIRE_SIGNAL_WEIGHTS[k]}`).join(" / ")}`,
  );

  console.log("\n--- 全 active feed のシグナル値（score 降順・推奨は ★）---");
  console.log(
    `${pad("feed", 28)} ${"score".padStart(5)} ${"stale".padStart(7)} ${"cred".padStart(6)} ${"pref".padStart(6)} ${"ndup".padStart(6)}  理由`,
  );
  for (const r of rows) {
    const mark = r.result.recommend ? "★" : " ";
    const nd = r.input.near_dup_rate === null ? "null" : r.input.near_dup_rate.toFixed(2);
    const reasons = r.result.reasons.map((x) => RETIRE_REASON_LABELS[x]).join(",") || "―";
    console.log(
      `${mark}${pad(r.input.title ?? r.input.url, 27)} ${r.result.score.toFixed(1).padStart(5)}` +
        ` ${fmtDays(r.staleMs).padStart(7)} ${r.input.credibility.toFixed(2).padStart(6)}` +
        ` ${r.input.sourcePref.toFixed(2).padStart(6)} ${nd.padStart(6)}  ${reasons}`,
    );
  }

  // ── 閾値までの距離（出すぎ/出なすぎの判断材料）──────────────────────────
  console.log("\n--- 閾値までの距離（近いものから。閾値を動かしたとき最初に動く feed）---");
  const dismissW = Math.abs(FEEDBACK_WEIGHT.dismiss);
  // 各シグナルについて「閾値まであとどれだけか」。既に跨いでいるものは到達済と明示する
  // （負の gap を「あと 0 回」と表示すると未到達と誤読されるため）。
  const gapStr = (gap: number, unit: string): string =>
    gap < 0 ? `到達済(${gap.toFixed(2)}${unit})` : `+${gap.toFixed(2)}${unit}`;
  const near = rows
    .map((r) => ({
      title: r.input.title ?? r.input.url,
      // credibility / pref は「閾値を下回る」で立つので、gap は現在値 - 閾値（負なら到達済）。
      credGap: r.input.credibility - TH.LOW_CREDIBILITY,
      prefGap: r.input.sourcePref - TH.LOW_PREF,
      staleGap: (TH.DEAD_DAYS * DAY_MS - r.staleMs) / DAY_MS,
      flagged: r.result.recommend,
    }))
    .sort((a, b) => Math.min(a.credGap, a.prefGap) - Math.min(b.credGap, b.prefGap))
    .slice(0, 12);
  for (const n of near) {
    const dismissesLeft = n.prefGap >= 0 ? Math.ceil(n.prefGap / dismissW) : 0;
    const dismissNote = n.prefGap >= 0 ? `あと ${dismissesLeft} 回 dismiss` : "pref 到達済";
    console.log(
      `  ${n.flagged ? "★" : " "}${pad(n.title, 27)} cred ${gapStr(n.credGap, "")}` +
        ` / pref ${gapStr(n.prefGap, "")}（${dismissNote}）` +
        ` / dead ${n.staleGap > 0 ? `あと ${n.staleGap.toFixed(1)}d` : "到達済"}`,
    );
  }
  console.log(
    `  ※ credibility は「< ${TH.LOW_CREDIBILITY}」の strict 比較。ちょうど ${TH.LOW_CREDIBILITY} の feed は` +
      `フラグが立たない（cred +0.00 の行がそれ）`,
  );

  // ── near_dup_rate = null の内訳 ────────────────────────────────────────
  const nullRows = rows.filter((r) => r.input.near_dup_rate === null);
  const nonNull = rows.length - nullRows.length;
  console.log(`\n--- near_dup_rate = null の内訳（${nullRows.length} / ${rows.length} feed）---`);
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
  for (const r of nullRows) {
    const s = r.stat;
    if (!s || s.total === 0) noArticle += 1;
    // 記事は存在するが published_at が全て null → 30d 窓に入らず母数 0 になる。
    else if (s.inWindow === 0 && s.nullPublished > 0) onlyNullPublished += 1;
    else if (s.inWindow === 0) noArticle += 1;
    else if (s.withEmbedding === 0) noEmbed += 1;
    else tooFew += 1;
  }
  console.log(`  記事そのものが無い / 30d 窓に該当なし : ${noArticle}`);
  console.log(`  記事はあるが published_at が全て null : ${onlyNullPublished}`);
  console.log(`  窓内に記事はあるが embedding が 0 件  : ${noEmbed}`);
  console.log(`  embedding 1〜${MIN_OWN_ARTICLES - 1} 件（母数不足）       : ${tooFew}`);
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
    `\n※ dead 日数と near_dup_rate は上書き型で履歴が無い。分布を得るには本スクリプトを定期実行して` +
      `記録を貯める必要がある（過去に遡った較正はできない）`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
