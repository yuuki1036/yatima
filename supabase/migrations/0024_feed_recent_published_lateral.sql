-- feed_recent_published を feed ごとの LATERAL top-N にする（YAT-84）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 冪等: function は create or replace（引数・返り値の形は 0014 と同一）。
--
-- 症状: 週次の snapshot-feed-health と /feeds の表示が呼ぶこの RPC が、pg_stat_statements で最大
--   5,225ms（service_role）/ 2,816ms（anon）、平均 約 12,000 ページ。PostgREST の statement_timeout に
--   近い。snapshot 側は throw して learn の cron が赤くなり、/feeds 側は null に倒れて dead シグナルが
--   黙って消える。
--
-- 原因: 0014 は published_at が入った全行（約 62,000 行）に feed ごとの row_number を振ってから上位を
--   取っていた。idx_articles_feed_published の全件 Index Only Scan になり、visibility map が崩れると
--   ほぼヒープ全体を読む。返すのは高々「feed 数 × 50」行なのに、コストは全記事に比例する。
--
-- 直し方: feeds を起点に、各 feed の上位 N 件だけを idx_articles_feed_published (feed_id, published_at desc)
--   から引く。読むのは「feed 数 × N」行で、記事がいくら増えても変わらない（実測 約 325 ページ）。
--   返る値は 0014 と同じ:
--   - articles.feed_id は feeds への外部キーなので、記事を持つ feed はすべて feeds にある。記事の無い
--     feed はどちらでも 0 行。active で絞らないのも 0014 と同じ。
--   - 返すのは (feed_id, published_at) だけなので、同じ published_at の並びがどちらに転んでも値は同じ。
--   上限を least(greatest(sample_size, 2), 50) で締めるのも 0014 と同じ。
--
-- 権限: create or replace は既存の権限を保つ（0014 の方針のまま。anon からも呼ぶ）。
--
-- 関連: 0014（導入）、0021（同じ LATERAL top-N の書き換え）

create or replace function public.feed_recent_published(sample_size int default 15)
returns table (
  feed_id uuid,
  published_at timestamptz
)
language sql
stable
set search_path = public
as $$
  select f.id as feed_id, x.published_at
  from public.feeds f
  cross join lateral (
    select a.published_at
    from public.articles a
    where a.feed_id = f.id
      and a.published_at is not null
    order by a.published_at desc
    limit least(greatest(sample_size, 2), 50)
  ) x
  order by f.id, x.published_at desc;
$$;
