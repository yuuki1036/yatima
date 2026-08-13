-- feed ごとの「直近の記事公開日」を引く RPC（YAT-70）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 冪等: function は create or replace / index は if not exists。
--
-- 背景: 退役推奨の dead シグナルは feeds.last_fetched_at で判定していたが、この列は ingest の
-- 「取得成功時」に更新されるため、実際に測れるのは「こちらが取得できているか」であって
-- 「発信元が止まったか」ではない。取得失敗の検知は YAT-68 で ingest 側の別機構に移ったので、
-- dead は本来の意味（発信停滞）へ再定義する。
--
-- なぜ「最新 1 件」でなく「直近 N 件」か: 固定閾値（14 日）では判定できないため。実測で
-- Ahead of AI は投稿間隔の中央値が 25 日、Berkeley BAIR は 38 日で、どちらも 14 日の沈黙は
-- 通常運転だった（一方 VentureBeat AI は中央値 3 日に対し 27.8 日沈黙＝本当に停滞）。
-- feed ごとに自然なスケールが違う量なので、その feed 自身の投稿間隔を基準にする必要がある。
-- 中央値の算出は JS 側（lib/ranking/feed-health.ts）に置き、SQL は生の公開日だけを返す
-- ——判定ロジックを純関数に集めてユニットテスト可能にするため。
--
-- なぜ RPC か: 判定は /feeds のページレンダリングで行う。feed ごとに 1 クエリ投げると 30 往復を
-- 超え、PostgREST には「グループごとに上位 N 件」の汎用手段も無い。1 往復で済ませる。
-- 非正規化列にしなかったのは、ingest 側に更新責務が増えて実体とのドリフト経路を作るため。
--
-- なぜ anon から revoke しないか: 0009 / 0010 の match_articles は service_role からのみ呼ぶため
-- anon / authenticated の EXECUTE を落としているが、この関数は /feeds が anon キーの
-- Server Component クライアント（lib/supabase/server.ts）から呼ぶので落とすとページが壊れる。
-- 返すのは feed_id と公開日だけで、既存の anon SELECT (articles) で読める範囲を超えない。
-- search_path は 0010 と同じ理由で public に固定する。

-- 「feed ごとに published_at の降順で上位 N 件」を index で賄う。既存の idx_articles_feed_id は
-- feed_id 単独で、feed ごとに行を舐めてソートが要る。articles は 3 万行規模でページレンダリングの
-- 同期パスに乗るため複合にする。
create index if not exists idx_articles_feed_published
  on public.articles (feed_id, published_at desc);

create or replace function public.feed_recent_published(sample_size int default 15)
returns table (
  feed_id uuid,
  published_at timestamptz
)
language sql
stable
set search_path = public
as $$
  select r.feed_id, r.published_at
  from (
    select
      a.feed_id,
      a.published_at,
      row_number() over (
        partition by a.feed_id
        order by a.published_at desc
      ) as rn
    from public.articles a
    where a.published_at is not null
  ) r
  -- 上限を least で締めるのは match_articles と同じ作法（呼び出し側の指定で全件走査させない）。
  where r.rn <= least(greatest(sample_size, 2), 50)
  order by r.feed_id, r.published_at desc;
$$;
