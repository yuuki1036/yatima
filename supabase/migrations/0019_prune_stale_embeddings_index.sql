-- embedding prune の update を seq scan から index scan にする（YAT-77 hotfix・#85 の後続）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 冪等: index は if not exists。
--
-- 症状: ingest cron が断続的に code 57014 'canceling statement due to statement timeout' で赤い
--   （2026-09-18 18:31 UTC 等）。#85 で pruneStaleEmbeddings の before/after 2 count を
--   update 1 本に畳んだが、今度は update 自身が timeout に達した（count → update に問題が移っただけ）。
--
-- 原因: prune の WHERE は `embedding is not null AND (published_at < cutoff OR published_at is null)`。
--   0017 で `idx_articles_embedding` が `where summary is not null` の部分 index に変わって以降、
--   `embedding is not null` に効く index が無く、update が articles 全体（約 5 万行）の seq scan に
--   なっていた。無料枠の共有 CPU では負荷次第で statement_timeout（約 8s）を跨ぐため断続的に落ちる。
--   embed が毎 run 100 件超を書くので prune 対象も変動し、境界を跨ぐ run で赤くなる。
--
-- 対処: `embedding is not null` の行だけを published_at で引ける部分 index を張る。update は
--   この index の range scan（published_at < cutoff）＋ null エントリ（published_at is null）で
--   該当行に直行できる。対象は「窓外の embedding を持つ行」＝ embedding is not null の約 5,000 行
--   なので index は小さく、prune で NULL 化・embed で再設定されるたびのメンテコストも軽い。
--   CONCURRENTLY は使わない（migrate ランナーが各ファイルを begin/commit で包むため）。部分 index
--   なので作成は数秒で、その間の articles への書き込みロックは短い（0018 の index 追加と同じ作法）。
--
-- 設計: .claude/designs/20260906-llm-cost-batches-embed-decoupling.md（段階 3 の prune）
-- 関連: 0017（idx_articles_embedding を部分 index 化）、0018（select 側の同種 timeout 対処）、PR #85

create index if not exists idx_articles_embedding_stale
  on public.articles (published_at)
  where embedding is not null;
