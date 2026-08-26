import { config } from "dotenv";

// ローカル実行用に .env.local を読む。GitHub Actions では secrets が process.env にあり no-op。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import {
  FEED_HEALTH_THRESHOLDS as TH,
  RETIRE_SIGNAL_WEIGHTS,
  RETIRE_REASON_LABELS,
  type RetireReason,
} from "../lib/ranking/feed-health";
import { FEEDBACK_WEIGHT } from "../lib/ranking/preferences";
import {
  collectFeedHealthObservation,
  describeWindow,
} from "../lib/ranking/feed-health-observation";
import { WINDOW_DAYS, MIN_OWN_ARTICLES, FETCH_CAP } from "../lib/ranking/near-dup-window";
import { padEndWide } from "./_report-format";

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

// embedding 網羅率がこれを下回る観測は較正に使わない。平常時は 40〜50%（要約予算が credibility で
// リランクされるため全記事は要約されない）で、2026-08-26 の要約全滅時は 33.6% まで落ちていた。
const WINDOW_COVERAGE_FLOOR = 0.4;

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

  // 収集は snapshot-feed-health と共有する（feed-health-observation）。ここを別実装にすると
  // 「診断で見た値」と「較正に貯める値」が別物になり、較正そのものが成立しない。
  const obs = await collectFeedHealthObservation(supabase, now).catch(
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
  const { feeds, active, rows, window: win, prefsFailed } = obs;
  const inputs = rows.map((r) => r.input);
  if (win.truncated) {
    console.warn(
      `⚠ 窓内の記事が安全弁 ${FETCH_CAP} 件に達した。古い記事が切れており、` +
        `feed 別の embedding 件数が実態より小さく出る（母数不足の誤判定につながる）`,
    );
  }

  // ── 記事の有無（near_dup_rate=null の内訳用）──────────────────────────
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

  console.log("=== feed 引退スコアリング診断（YAT-60） ===");
  console.log(
    `feed 総数 ${feeds.length}（active ${active.length} / 非活性 ${feeds.length - active.length}）` +
      ` / 推奨 ${rows.filter((r) => r.result.recommend).length}`,
  );
  console.log(
    `閾値: dead(発信停滞)>max(${TH.DEAD_DAYS}d, ${TH.DEAD_STALL_MULTIPLIER}×投稿間隔中央値)（新規猶予 ${TH.NEW_FEED_GRACE_DAYS}d） / credibility<${TH.LOW_CREDIBILITY}` +
      ` / pref<${TH.LOW_PREF} / near_dup>=${TH.NEAR_DUP_RATE}`,
  );
  console.log(
    `加重: ${(Object.keys(RETIRE_SIGNAL_WEIGHTS) as RetireReason[]).map((k) => `${k}=${RETIRE_SIGNAL_WEIGHTS[k]}`).join(" / ")}`,
  );
  if (prefsFailed) {
    console.log("⚠ preferences 取得失敗のため pref 列と low_pref 判定は無効（全て 0 扱い）");
  }

  // 窓の健全性を見出しに出す。near_dup は「窓に何が入っていたか」で値が変わるので、
  // 網羅率を見ずに値だけ読むと汚染された観測を較正に使ってしまう（2026-08-26 に実際に起きた:
  // 要約全滅で直近 7 日の embedding が丸ごと欠けた窓で算出された値だった）。
  console.log(describeWindow(win));
  if (win.coverage < WINDOW_COVERAGE_FLOOR) {
    console.log(
      `⚠ embedding 網羅率が ${(WINDOW_COVERAGE_FLOOR * 100).toFixed(0)}% を下回っている。` +
        `要約・embed 経路が止まっている可能性がある（near_dup を較正に使わないこと）`,
    );
  }

  console.log("\n--- 全 active feed のシグナル値（score 降順・推奨は ★）---");
  console.log(
    `${pad("feed", 28)} ${"score".padStart(5)} ${"沈黙".padStart(7)} ${"dead閾値".padStart(8)} ${"cred".padStart(6)} ${"pref".padStart(6)} ${"ndup".padStart(6)}  理由`,
  );
  for (const r of rows) {
    const mark = r.result.recommend ? "★" : " ";
    const nd = r.input.near_dup_rate === null ? "null" : r.input.near_dup_rate.toFixed(2);
    const reasons = r.result.reasons.map((x) => RETIRE_REASON_LABELS[x]).join(",") || "―";
    console.log(
      `${mark}${pad(r.input.title ?? r.input.url, 27)} ${r.result.score.toFixed(1).padStart(5)}` +
        ` ${fmtDays(r.quietMs).padStart(7)} ${fmtDays(r.deadMs).padStart(8)} ${r.input.credibility.toFixed(2).padStart(6)}` +
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
      const staleGap = isNew ? null : (r.deadMs - r.quietMs) / DAY_MS;
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
    `  ※ credibility / pref は「< 閾値」の strict 比較。dismiss 回数もこれを織り込んで +1 している。` +
      `credibility の閾値 ${TH.LOW_CREDIBILITY} はシード値の段（-0.5 / -0.3）の間に置いてあるので、` +
      `境界ちょうどの feed は存在しない（YAT-55 指摘 F の決着）`,
  );

  // ── near_dup_rate = null の内訳 ────────────────────────────────────────
  const nullRows = rows.filter((r) => r.input.near_dup_rate === null);
  const nonNull = rows.length - nullRows.length;
  console.log(
    `\n--- near_dup_rate = null の内訳（${nullRows.length} / ${rows.length} feed）` +
      `｜母集団: 直近 ${WINDOW_DAYS}d の embedding 付き記事 ${win.embedded} 件 ---`,
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
    const withEmbed = r.withEmbedding;
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
        `    - ${pad(r.input.title ?? r.input.url, 27)} embedding ${r.withEmbedding} 件 / ${age}`,
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
    `\n※ near_dup_rate は上書き型で履歴が無く、この出力も残らない。系列は feed_health_snapshots に` +
      `貯めている（週次 cron の npm run snapshot-feed-health）。較正にはそちらを使うこと` +
      `——本スクリプトはあくまで「今」を読むためのもの` +
      `（dead は YAT-70 で articles.published_at 由来になったため遡れる）`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
