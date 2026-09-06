import { config } from "dotenv";

// ローカル実行用に .env.local を読む。
// GitHub Actions では secrets が既に process.env にあるため、ここは実質 no-op。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import { ingestAllFeeds } from "../lib/rss/ingest";
import {
  findStaleFeeds,
  formatStale,
  STALE_ALERT_HOURS,
} from "../lib/rss/ingest-health";
import { enrichMissingBodies } from "../lib/rss/enrich";
import { annotateMissing } from "../lib/llm/summarize-batch";
import { embedMissing } from "../lib/rss/embed";
import { curateToday } from "../lib/ranking/curate";

async function main() {
  const supabase = createAdminClient();
  const results = await ingestAllFeeds(supabase);

  let total = 0;
  let failed = 0;
  for (const r of results) {
    if (r.error) {
      failed += 1;
      console.error(`✗ ${r.feedUrl}: ${r.error}`);
    } else {
      total += r.inserted;
      console.log(`✓ ${r.feedUrl}: +${r.inserted}`);
    }
  }
  console.log(
    `\n完了: ${results.length} フィード / 新規 ${total} 記事 / 失敗 ${failed} 件`,
  );

  // 要約前に、本文が薄い記事（HN 等）の本文をリンク先から取得して補完する（fail-soft）。
  const en = await enrichMissingBodies(supabase);
  console.log(
    `本文補完: 取得 ${en.enriched} / 失敗 ${en.failed}（対象 ${en.thin} 件）`,
  );

  // 取得後にバッチ要約+タグ付け（summary IS NULL を埋める）。個々の失敗は fail-soft で流し、
  // 全滅だけ末尾でまとめて赤くする（YAT-73。判定は下の「失敗の可視化」節）。
  const s = await annotateMissing(supabase);
  console.log(
    `要約+タグ: 成功 ${s.succeeded} / 失敗 ${s.failed}${s.skipped ? " (ANTHROPIC_API_KEY 未設定でスキップ)" : ""}`,
  );
  // 消費台帳（YAT-74）。毎 run 出しておくと「今日いくら使ったか」が Actions のログから読める。
  // クレジット枯渇のとき、この数字がプロジェクト側のどこにも無かったのが診断を遅らせた。
  if (!s.skipped) {
    console.log(
      `  日次要約: ${s.dailyUsed + s.succeeded} / ${s.dailyCap} 件（UTC 日次上限）`,
    );
    if (s.dailyCapped) {
      console.log(
        `  ⚠ 日次上限に達したため要約を見送った。対象が無いのではなく上限で止まっている`,
      );
    }
  }

  // 要約済み記事を embed（重複排除用。summary 済み×embedding NULL が対象。fail-soft）。
  const em = await embedMissing(supabase);
  console.log(
    `embedding: 成功 ${em.succeeded} / 失敗 ${em.failed}${em.skipped ? " (VOYAGE_API_KEY 未設定でスキップ)" : ""}`,
  );

  // デッキを未判定10件へ補充（連続トップアップ。未判定が10件あれば skip で冪等）。
  // キュレーション失敗は ingest 全体を落とさない（fail-soft）。
  try {
    const c = await curateToday(supabase);
    console.log(
      c.skipped
        ? `キュレーション: デッキ充足のため補充なし`
        : `キュレーション: デッキに ${c.picked}件 を補充${c.explored ? `（探索枠 ${c.explored}件）` : ""}${c.deduped ? `（近重複 ${c.deduped}件を除外）` : ""}`,
    );
  } catch (e) {
    console.warn("キュレーション失敗:", e);
  }

  // ── 失敗の可視化（YAT-68）─────────────────────────────────────────────
  // 単発の失敗は上の console.error に出るだけで、毎時 24 回のログに埋もれる。恒常的に
  // 落ちている feed は exit(1) で CI を赤くして気付けるようにする（Import AI が 15 日間
  // 403 で落ち続けたのを退役推奨で知る、という遅すぎる検知が起票の理由）。
  const stale = findStaleFeeds(results);
  if (stale.length > 0) {
    console.error(
      `\n⚠ ${STALE_ALERT_HOURS} 時間以上ずっと取得に失敗している feed が ${stale.length} 件:`,
    );
    for (const s of stale) {
      console.error(
        `  - ${s.title ?? s.feedUrl}（最後の成功から ${formatStale(s.staleMs)}）: ${s.error}`,
      );
      console.error(`    ${s.feedUrl}`);
    }
    console.error(
      `  feed 側が死んだのか、取得元の環境が弾かれているのかはローカルからの取得と見比べること`,
    );
  }

  // 要約の全滅（YAT-73）: 対象があったのに 1 件も成功しなかった＝ LLM 側の恒常障害。
  // 取得の継続失敗は上で検知できるのに要約の全滅は素通りする、という非対称を埋める。
  // 要約が付かない記事はキュレーションに乗らないので、放置すると TODAY デッキが空のまま緑で流れる
  // （2026-08-26 に実際に発生。クレジット切れで 20 件全滅・デッキ 0 件だったが、
  // その run が赤かったのは別要因の feed 継続失敗が同時に出ていたからにすぎない）。
  //
  // 対象ゼロ（succeeded も failed も 0）は正常なので判定に入れない。
  // 日次上限で止まった run（dailyCapped）も failed=0 なので発火しない。上限は正常な抑制であって
  // 障害ではないため（上限に達したこと自体は上のログで可視化する）。
  const annotateDead = !s.skipped && s.failed > 0 && s.succeeded === 0;
  if (annotateDead) {
    console.error(
      `\n⚠ 要約+タグが ${s.failed} 件すべて失敗している（成功 0）`,
    );
    console.error(
      `  LLM 呼び出しが全滅している可能性が高い（API キー・クレジット残高・レート制限を確認）`,
    );
    console.error(
      `  要約が付かない記事はキュレーションに乗らないため、放置すると TODAY デッキが空になる`,
    );
  }

  // 全フィード失敗は「6 時間待たずに今すぐ赤くすべき」別の障害モードなので併存させる。
  const allFailed = results.length > 0 && failed === results.length;
  if (allFailed || stale.length > 0 || annotateDead) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
