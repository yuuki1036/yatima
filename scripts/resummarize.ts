import { config } from "dotenv";

// ローカル実行用に .env.local を読む（本番 Supabase + ANTHROPIC_API_KEY を参照）。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import { annotateMissing } from "../lib/llm/summarize-batch";

// 既存記事の要約を作り直す「一回限り」のメンテスクリプト。
// プロンプト変更（要約 1〜2文→3〜4文 + タグ付与）を既存記事に反映するために使う。
//
// 仕組み: summary を NULL 化（＋既存タグ削除）→ annotateMissing が新プロンプトで
// 要約+タグを再生成する。通常 cron は summary IS NULL のみ拾うため既存は対象外で、
// この明示リセットが必要。LLM 呼び出しが対象件数ぶん走る（コスト注意）。

async function main() {
  // 本番 DB を破壊的に書き換えるため dry-run をデフォルトにし、--apply 明示時のみ実行する。
  // .env.local の向き先を取り違えても、まず件数と接続先 URL を目視確認できるようにする。
  const apply = process.argv.includes("--apply");
  const supabase = createAdminClient();

  // 対象: content_html を持つ全記事（annotateMissing が拾える条件と一致）。
  const { data: targets, error: selErr } = await supabase
    .from("articles")
    .select("id")
    .not("content_html", "is", null);
  if (selErr) throw selErr;
  const ids = (targets ?? []).map((r) => r.id as string);

  console.log(`接続先: ${process.env.NEXT_PUBLIC_SUPABASE_URL ?? "(未設定)"}`);
  console.log(`対象 ${ids.length} 件の要約をリセットして再生成します`);
  if (ids.length === 0) return;
  if (!apply) {
    console.log(
      "dry-run（既定）。実際に書き換えるには --apply を付けて再実行してください:\n" +
        "  npm run resummarize -- --apply",
    );
    return;
  }

  // 既存タグを削除（再生成でクリーンなタグ集合にするため）。
  // .in() に全 ID を一括で渡すと URL 長超過で 400 になるため CHUNK ずつ分割する。
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { error: delErr } = await supabase
      .from("article_tags")
      .delete()
      .in("article_id", ids.slice(i, i + CHUNK));
    if (delErr) throw delErr;
  }
  // summary を NULL 化。ID 列挙せず絞り込み条件で一括更新（URL 長の制約を回避）。
  const { error: updErr } = await supabase
    .from("articles")
    .update({ summary: null })
    .not("content_html", "is", null);
  if (updErr) throw updErr;

  // annotateMissing を全件消化まで回す（1 回 = DEFAULT_LIMIT 件ずつ）。
  // succeeded===0 が続いたら無限ループを避けて中断するが、レート制限（429）など一時エラーで
  // 1 ラウンド全滅しただけで処理可能な記事を残して止めないよう、連続 N 回＋バックオフで判定する。
  const MAX_CONSECUTIVE_ZERO = 3;
  const BACKOFF_MS = 5_000;
  let totalOk = 0;
  let consecutiveZero = 0;
  for (;;) {
    const r = await annotateMissing(supabase);
    if (r.skipped) {
      console.warn("ANTHROPIC_API_KEY 未設定でスキップ");
      break;
    }
    // 日次上限（YAT-74）に達しても picked=0 になる。これを「全件完了」と誤判定すると、
    // 大半が summary=NULL のまま偽の完了ログを出す。dailyCapped で区別して break 理由を分ける。
    if (r.dailyCapped) {
      console.log(
        `日次上限（${r.dailyCap} 件）に達したので中断。残りは翌 UTC 日に再実行してください`,
      );
      break;
    }
    if (r.capUnavailable) {
      console.error("日次台帳クエリに失敗（migration 0016 未適用の可能性）。中断します");
      break;
    }
    if (r.picked === 0) {
      console.log("全件完了");
      break;
    }
    totalOk += r.succeeded;
    console.log(`  +${r.succeeded}/${r.picked} 成功（累計 ${totalOk}）`);
    if (r.succeeded === 0) {
      consecutiveZero += 1;
      if (consecutiveZero >= MAX_CONSECUTIVE_ZERO) {
        console.warn(
          `残り ${r.picked} 件が ${MAX_CONSECUTIVE_ZERO} 連続で全失敗。中断`,
        );
        break;
      }
      console.warn(
        `ラウンド全失敗（${consecutiveZero}/${MAX_CONSECUTIVE_ZERO}）。${BACKOFF_MS}ms 待って再試行`,
      );
      await new Promise((res) => setTimeout(res, BACKOFF_MS));
    } else {
      consecutiveZero = 0;
    }
  }
  console.log(`完了: 再生成 ${totalOk} 件`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
