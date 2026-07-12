import { config } from "dotenv";

// ローカル実行用に .env.local を読む。
// GitHub Actions では secrets が既に process.env にあるため、ここは実質 no-op。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import {
  collectCandidatesFromArticles,
  discoverFromArticles,
} from "../lib/rss/discover-articles";
import {
  discoverFromPreferences,
  planPreferenceSearch,
} from "../lib/rss/discover-preference";
import type { SupabaseClient } from "@supabase/supabase-js";

// 情報源の自動発見の実行スクリプト。週次 cron（discover.yml）と手動実行から呼ぶ。
// ingest（毎時）とは分離した低頻度・重いジョブ。方式①（記事リンク発掘・YAT-16）と
// 方式②（嗜好ベース提案・YAT-38）を独立ステージとして直列に回す。一方が落ちても他方は走らせる。
// --dry-run では feed の探索も feed_candidates への登録もしない。両方式とも DB read のみで無料・
// 安全に保つ（方式①は候補ドメイン、方式②は検索テーマと生成クエリまでを見せ、外部 API は叩かない）。

async function runArticles(supabase: SupabaseClient, dryRun: boolean) {
  console.log("== 方式① 記事リンク発掘 ==");
  if (dryRun) {
    const { inputs, scannedArticles } =
      await collectCandidatesFromArticles(supabase);
    console.log(`走査記事: ${scannedArticles} 件 / 候補ドメイン: ${inputs.length} 件`);
    for (const i of inputs) {
      console.log(`  ${i.siteUrl}  (${i.discoveredFrom})`);
    }
    console.log("[dry-run] 探索・登録はスキップしました");
    return;
  }

  const r = await discoverFromArticles(supabase);
  console.log(
    `走査記事 ${r.scannedArticles} / 候補 ${r.candidateDomains} / 検査 ${r.examined}\n` +
      `feed 検出 ${r.discovered} / 新規登録 ${r.inserted} / ` +
      `既存feedで除外 ${r.skippedExisting} / 既存候補で除外 ${r.skippedCandidate}`,
  );
}

async function runPreferences(supabase: SupabaseClient, dryRun: boolean) {
  console.log("== 方式② 嗜好ベース提案 ==");
  if (dryRun) {
    // dry-run は無料・安全（DB read のみ）に保つ。実際の候補サイトは Tavily/LLM を叩かないと
    // 出ないため、ここでは検索するテーマと生成クエリだけを見せる（課金呼び出しはしない）。
    const plan = await planPreferenceSearch(supabase);
    console.log(`検索テーマ: ${plan.length} 件`);
    for (const { theme, query } of plan) {
      console.log(`  ${theme.label}（重み ${theme.weight.toFixed(2)}） → "${query}"`);
    }
    console.log("[dry-run] Tavily 検索・LLM 選別・登録はスキップしました");
    return;
  }

  const r = await discoverFromPreferences(supabase);
  console.log(
    `テーマ ${r.themes} / 候補サイト ${r.candidateSites} / 検査 ${r.examined}\n` +
      `feed 検出 ${r.discovered} / 新規登録 ${r.inserted} / ` +
      `既存feedで除外 ${r.skippedExisting} / 既存候補で除外 ${r.skippedCandidate}`,
  );
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const supabase = createAdminClient();

  // 各方式は独立ステージ。一方が throw しても他方は走らせる（発見の取りこぼしを最小化）。
  let failed = false;
  for (const [name, run] of [
    ["方式①", runArticles],
    ["方式②", runPreferences],
  ] as const) {
    try {
      await run(supabase, dryRun);
    } catch (e) {
      failed = true;
      console.error(`${name} が失敗しました:`, e);
    }
    console.log("");
  }

  // どれか 1 ステージでも落ちたら非ゼロ終了（cron が失敗を検知できるように）。
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
