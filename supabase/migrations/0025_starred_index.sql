-- /saved（お気に入り一覧）を seq scan から index scan にする（YAT-84）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 冪等: index は if not exists。
--
-- 症状: /saved の表示のたびに発行される is_starred = true ∧ order by published_at desc nulls last
--   limit 100 が、is_starred に index が無いため articles の seq scan（約 12,000 ページ）になっていた
--   （pg_stat_statements の最大 2,878ms）。★ は数件しかないのに、コストは全記事に比例する。
--
-- 対処: ★ の行だけの部分 index を (published_at desc nulls last) で張る。並びは app/saved/page.tsx の
--   order（nullsFirst: false）と揃える（desc の既定は nulls first なので明示する。0020 と同じ罠）。
--   ★ は手で付けるものなので index は数件〜数十件に留まる。
--
-- HOT 更新への影響: toggleStar の update は is_starred（この index の述語列）を変えるので HOT で
--   なくなる。★ の付け外しは手動で低頻度なので影響は無視できる。
--
-- CONCURRENTLY は使わない（migrate ランナーが各ファイルを begin/commit で包むため）。作成時の全走査は
-- 数秒で、その間 articles への書き込みは待たされる。ingest が走っていない時刻に適用する。

set local lock_timeout = '5s';

create index if not exists idx_articles_starred
  on public.articles (published_at desc nulls last)
  where is_starred;
