-- 要約の隔離件数（summaryQuarantineCounts）と unquarantine の対象取得を seq scan から index scan にする（YAT-84）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 冪等: index は if not exists。
--
-- 症状: ingest が毎 run 呼ぶ summaryQuarantineCounts（lib/llm/summarize-batch.ts）の
--     summary_attempts >= 3 and summary_last_failed_at >= now() - 24h の count が、articles の
--   seq scan（約 12,000 ページ）になっていた。pg_stat_statements の最大は 5,260ms、冷えた状態の
--   実測は 2,863ms。0021 の claim と同じく「触るページ数が全件に比例する文」なので、遅い回に
--   PostgREST（authenticator）の statement_timeout=8s を越えうる。失敗しても fail-soft で -1 を
--   返すため run は赤くならず、隔離の急増ガード（isQuarantineSurging）が黙って止まる。
--
-- 対処: 要約に失敗したことのある行だけの部分 index を summary_last_failed_at desc で張る。
--   summary_last_failed_at は settle_summary_attempts（0017）が失敗時にだけ now() を入れ、消さない。
--   summary_attempts を増やすのも同じ update なので「summary_attempts > 0 ⇒ summary_last_failed_at
--   is not null」が成り立ち、隔離（attempts >= 閾値）の行は必ずこの index に入る。
--   失敗したことのある行は全体のごく一部（2026-09-28 時点で 0 行）なので、index は小さいまま。
--   閾値（3）は述語に焼き込まない（0020 のコメントにある idx_articles_embed_pending の罠）。
--   summaryQuarantineCounts の `summary_last_failed_at >= cutoff` は strict な比較なので is not null を
--   含意し、planner はこの部分 index を選べる。scripts/unquarantine.ts は attempts だけで絞っていたので、
--   同じ不変条件にもとづく is not null を足して index に乗せた（対象の行は変わらない）。
--
-- HOT 更新への影響: summary_last_failed_at を書き換えるのは settle の失敗経路だけで、同じ update は
--   summary_reserved_until も書く。成功経路（summary を埋める）は既に他の部分 index の述語列を変える
--   ので HOT ではない。失敗は 1 run 高々 20 件なので影響は小さい。
--
-- CONCURRENTLY は使わない（migrate ランナーが各ファイルを begin/commit で包むため）。作成時の全走査は
-- 0021 と同じく数秒で、その間 articles への書き込みは待たされる。ingest が走っていない時刻に適用する。
--
-- 関連: 0017（summary_last_failed_at と settle の導入）、0021（同種の timeout の対処）

set local lock_timeout = '5s';

create index if not exists idx_articles_summary_failed
  on public.articles (summary_last_failed_at desc)
  where summary_last_failed_at is not null;
