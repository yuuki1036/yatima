import { config } from "dotenv";

// ローカル実行用に .env.local を読む。
// GitHub Actions では secrets が既に process.env にあるため、ここは実質 no-op。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import { ingestAllFeeds } from "../lib/rss/ingest";
import {
  findStaleFeeds,
  formatStale,
  isDeckStarved,
  isEmbedDead,
  isEmbedStalled,
  isEmbedGateStuck,
  isEmbedSelectStalled,
  isSelectionDead,
  isQuarantineSurging,
  DECK_STARVED_FLOOR,
  STALE_ALERT_HOURS,
} from "../lib/rss/ingest-health";
import { enrichMissingBodies } from "../lib/rss/enrich";
import {
  annotateMissing,
  summaryQuarantineCounts,
} from "../lib/llm/summarize-batch";
import {
  embedHealthCounts,
  embedMissing,
  pruneStaleEmbeddings,
  DISK_CEILING_BYTES,
  EMBED_RETENTION_DAYS,
  EMBED_STALL_WINDOW_HOURS,
} from "../lib/rss/embed";
import { countDeckCandidates, curateToday } from "../lib/ranking/curate";

// 窓外に残ってよい embedding の上限（YAT-74）。定常の流出は 1 日 165 件程度なので、
// これを超えるのは prune が止まっているか、初回の積み残しが未消化かのどちらか。
const EMBED_PRUNE_BACKLOG_LIMIT = 1000;

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
  // 全滅・選抜死・帰責失敗・隔離暴走を末尾でまとめて赤くする（YAT-73 / YAT-78。判定は下の
  // 「失敗の可視化」節）。選抜は feed ラウンドロビン（claim RPC）、日次上限は llm_batches の
  // 当日 request_count 合計（投入基準・YAT-78）。
  const s = await annotateMissing(supabase, { runKind: "cron" });
  console.log(
    `要約+タグ: 母数 ${s.pool} → 選抜 ${s.selected} / 成功 ${s.succeeded} / 失敗 ${s.failed}` +
      `（課金 ${s.charged} / 解放 ${s.released}）` +
      (s.skipped ? ` (skip: ${s.skipReason})` : ""),
  );
  // 消費台帳（YAT-74 → YAT-78）。分母は台帳（投入基準）＝ dailyUsed + この run の selected。
  // succeeded を足さない（fail-soft-return-breaks-ratio-logs: 分子と分母を別ステージ由来にしない）。
  if (!s.skipped && !s.capUnavailable && !s.ledgerError) {
    console.log(
      `  日次要約: ${s.dailyUsed + s.selected} / ${s.dailyCap} 件（UTC・投入基準）`,
    );
  }
  if (s.skipped && s.skipReason === "daily_capped") {
    console.log(
      `  ⚠ 日次上限（${s.dailyCap}）に達したため要約を見送った。対象が無いのではなく上限で止まっている`,
    );
  }
  if (s.capUnavailable) {
    console.error(
      `\n⚠ 日次消費の台帳（llm_batches）クエリに失敗した（migration 0017 未適用の可能性）`,
    );
    console.error(
      `  上限が確認できないため要約を見送った。これは上限到達ではなく障害なので赤くする`,
    );
  }
  if (s.ledgerError) {
    console.error(`\n⚠ 要約台帳（llm_batches）の記録に失敗した: ${s.ledgerError}`);
    console.error(
      `  LLM を呼ばず予約を解放した。台帳が書けないと支出天井が効かないので赤くする`,
    );
  }
  if (s.settleError) {
    console.error(`\n⚠ 要約失敗の帰責（settle_summary_attempts）に失敗した: ${s.settleError}`);
    console.error(
      `  予約が残ったままになる（次 run で候補から一時的に消える）。RPC / 権限を確認`,
    );
  }

  // デッキを未判定10件へ補充（連続トップアップ。未判定が10件あれば skip で冪等）。
  // キュレーション失敗は ingest 全体を落とさない（fail-soft）。
  // embed の前に置く（YAT-77）: embed は壁時計 3 分を使う最長ステップなので、その下流に curate を
  // 置くと timeout でデッキ補充が巻き添えで落ちる。
  // トレードオフ: curate の近重複除外は DB の embedding 列を読むため、この run で新規 embed される
  // 候補は curate 時点では embedding NULL で dedup 母集団から外れる（同一 run 内の dedup が弱まる）。
  // 切り離し後（YAT-77）embedding は要約・デッキ入りより前の run で概ね済むため取りこぼしは embed
  // バックログ滞留時に限られ、timeout でデッキ補充ごと落ちるリスクの方を重く見て embed を後段に置く。
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

  // 記事を embed（重複排除用。要約から切り離し・title＋本文冒頭 250 字・YAT-77）。
  // select_embed_candidates で選抜し、ディスク天井 450MB 超なら disk_ceiling で見送る（fail-soft）。
  const em = await embedMissing(supabase);
  if (em.skipReason === "disk_ceiling") {
    console.warn(
      `embedding: DB が ${DISK_CEILING_BYTES} bytes を超えたため見送った（disk_ceiling）。` +
        `これは障害ではないので赤くしない。content_html の保持窓（別テーマ）を検討する時期`,
    );
  } else {
    console.log(
      `embedding: 成功 ${em.succeeded} / 失敗 ${em.failed} / 締切持ち越し ${em.deferred}` +
        `（候補 ${em.pending} → 選抜 ${em.eligible} → 取得 ${em.picked}）` +
        (em.skipped ? " (VOYAGE_API_KEY 未設定でスキップ)" : ""),
    );
  }
  // TPM 台帳（YAT-76）。無料枠 10K TPM の消費を毎 run 残す。見積もりを併記するのは
  // estimateTokens の係数ずれ（過大だと 1 リクエストに詰められず消化が遅い）を実測と
  // 突き合わせて観測するため。
  if (em.tokensUsed !== undefined) {
    console.log(
      `  Voyage 消費: ${em.tokensUsed} tokens（見積もり ${em.tokensEstimated ?? "-"}・無料枠 10K TPM）`,
    );
  }

  // 保持窓より古い embedding を落とす（YAT-74）。embedding は 30 日窓の生き物で、
  // 貯め続けると Supabase 無料枠 500MB の 77% を占める（実測 417MB 中 323MB）。
  // 行は消さずベクタだけ NULL にするので、記事・要約・タグは残る。
  const pr = await pruneStaleEmbeddings(supabase);
  if (pr.pruned > 0 || pr.remaining > 0) {
    console.log(
      `embedding prune: ${pr.pruned} 件を解放（${EMBED_RETENTION_DAYS}日より古い）/ 窓外の残り ${pr.remaining} 件`,
    );
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

  // 要約の選抜死（YAT-78）: claim RPC の恒常失敗、または「候補はあるのに 1 件も予約できない」。
  // annotateDead は failed>0 が要るが、選抜が 0 件だと failed=0 で素通りする穴を塞ぐ。
  // 正常な抑制（daily_capped / no_api_key）は skipped で自動除外、capUnavailable は pool=-1 で不活性。
  const selectionDead = isSelectionDead(s);
  if (selectionDead) {
    console.error(
      `\n⚠ 要約の選抜が死んでいる（母数 ${s.pool} / 選抜 ${s.selected}${s.poolError ? ` / エラー: ${s.poolError}` : ""}）`,
    );
    console.error(
      `  claim_summary_candidates の失敗 / migration 0017 未適用 / RPC 権限（service_role）を疑う`,
    );
  }

  // 隔離（summary_attempts >= 3）の 24h 暴走（YAT-78・ADR-20260906205227）。環境起因の失敗を
  // 誤って課金すると backlog 上位が全滅する。増えすぎたら赤くして npm run unquarantine を促す。
  const quarantine = await summaryQuarantineCounts(supabase);
  const quarantineSurge = isQuarantineSurging(quarantine);
  if (quarantineSurge) {
    console.error(
      `\n⚠ 隔離（summary_attempts >= 3）が直近 24h で ${quarantine.quarantinedLast24h} 件に増えた`,
    );
    console.error(
      `  環境起因の失敗を誤課金している可能性。npm run unquarantine で戻せる。対象（先頭 10 件）:`,
    );
    for (const q of quarantine.samples) {
      console.error(`    - [${q.id}] ${q.title ?? "(無題)"}: ${q.lastError ?? ""}`);
    }
  }

  // 全フィード失敗は「6 時間待たずに今すぐ赤くすべき」別の障害モードなので併存させる。
  // prune が機能しなくなると embedding が単調増加し、無料枠 500MB を静かに食い潰す
  // （残り 83MB / 1 件 12.2KB なので、止まれば 1 ヶ月強で書き込みごと落ちる）。
  // 定常状態の窓外残りは 1 日ぶん（165 件程度）なので、1000 件を超えたら排出が追いついていない。
  // remaining < 0 は取得自体の失敗（prune が一度も走っていない）なのでこれも異常に含める。
  // embed の静かな死（YAT-76）: 要約の annotateDead（YAT-73）の embed 版。
  // embedDead は run 内の全滅（対象を拾ったのに成功 0）、embedStalled は 26h の停滞
  // （候補が積まれているのに embedded_at が 1 件も進まない）。前者は即日、後者は
  // fail-soft で「毎 run 静かに 0 件」のまま流れる型を捕まえる（実際に 13 日沈黙した）。
  // カウントは embedMissing の後に取る＝この run の成功が分子に反映されてから判定する。
  const eh = await embedHealthCounts(supabase, em);
  const embedDead = isEmbedDead(em);
  if (embedDead) {
    // 判定と同じ attempted で件数を出す（picked だと壁時計持ち越し deferred ぶんまで「失敗」と過大表示する）。
    console.error(`\n⚠ embedding が ${em.attempted} 件すべて失敗している（成功 0）`);
    console.error(
      `  Voyage 呼び出しが全滅している可能性が高い（VOYAGE_API_KEY・クレジット・レート制限を確認）`,
    );
  }
  const embedStalled = isEmbedStalled(em, eh);
  if (embedStalled) {
    console.error(
      `\n⚠ embed 候補が ${eh.candidatesAvailable} 件あるのに、直近 ${EMBED_STALL_WINDOW_HOURS}h で 1 件も embed されていない`,
    );
    console.error(
      `  run 単位では fail-soft で流れる型の停滞。embedding が付かない記事は近重複判定の母集団から欠け、`,
    );
    console.error(`  feed 網羅率が静かに下がる（過去に 13 日間沈黙した実績がある）`);
  }

  // embed ゲート全閉（YAT-77・day-0 回帰の署名）: 候補はあるのに body_text_len >= 250 が全部弾く。
  const embedGateStuck = isEmbedGateStuck(em);
  if (embedGateStuck) {
    console.error(
      `\n⚠ embed 候補 ${em.pending} 件に対し選抜が 0 件（body_text_len >= 250 のゲートが全閉）`,
    );
    console.error(
      `  backfill:body-text-len の未了 / body_text_len trigger の停止 / feeds.active を疑う`,
    );
  }

  // 選抜 RPC の恒常失敗（YAT-77）: 候補取得を RPC に寄せた結果生まれた静かな死。RPC が落ち続けると
  // pending/eligible が -1 になって上の 2 ガードが不活性化し、embed が止まったまま緑で流れる。
  const embedSelectStalled = isEmbedSelectStalled(em, eh);
  if (embedSelectStalled) {
    console.error(
      `\n⚠ select_embed_candidates が失敗し、直近 ${EMBED_STALL_WINDOW_HOURS}h で 1 件も embed されていない`,
    );
    console.error(`  RPC エラー: ${em.selectError}`);
    console.error(`  migration 0017 の未適用 / RPC の権限（service_role）を疑う`);
  }

  // デッキ供給の最終防衛線（YAT-76）: 取得・要約・選抜のどこが壊れても、curate が拾える
  // 候補の実数が床を割ればここで赤くなる。個別ガードの取りこぼしに対する保険。
  const deckCandidates = await countDeckCandidates(supabase);
  const deckStarved = isDeckStarved(deckCandidates);
  if (deckStarved) {
    console.error(
      `\n⚠ デッキ候補（要約済み・未ピック・72h）が ${deckCandidates} 件しかない（床 ${DECK_STARVED_FLOOR}）`,
    );
    console.error(
      `  上流（取得・要約・選抜）のどこかが細っている。放置すると数日で TODAY デッキが空になる`,
    );
  }

  const pruneStalled = pr.remaining < 0 || pr.remaining > EMBED_PRUNE_BACKLOG_LIMIT;
  if (pruneStalled) {
    console.error(
      `\n⚠ 保持窓より古い embedding が ${pr.remaining} 件残っている（上限 ${EMBED_PRUNE_BACKLOG_LIMIT}）`,
    );
    console.error(
      `  排出が追いついていない。Supabase 無料枠 500MB のうち embedding が 77% を占めるため、`,
    );
    console.error(`  放置すると DB が満杯になり書き込みごと落ちる`);
  }

  const allFailed = results.length > 0 && failed === results.length;
  if (
    allFailed ||
    stale.length > 0 ||
    annotateDead ||
    selectionDead ||
    quarantineSurge ||
    s.ledgerError !== null ||
    s.settleError !== null ||
    embedDead ||
    embedStalled ||
    embedGateStuck ||
    embedSelectStalled ||
    deckStarved ||
    pruneStalled ||
    s.capUnavailable
  )
    process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
