-- feed ごとの「最新記事の公開日」を引く RPC（YAT-70）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 冪等: function は create or replace / index は if not exists。
--
-- 背景: 退役推奨の dead シグナルは feeds.last_fetched_at で判定していたが、この列は ingest の
-- 「取得成功時」に更新されるため、実際に測れるのは「こちらが取得できているか」であって
-- 「発信元が止まったか」ではない。取得失敗の検知は YAT-68 で ingest 側の別機構に移ったので、
-- dead は本来の意味（発信停滞）へ再定義する。そのために feed ごとの max(published_at) が要る。
--
-- なぜ RPC か: 判定は /feeds のページレンダリングで行う。feed ごとに 1 クエリ投げると 30 往復を
-- 超え、PostgREST には GROUP BY の汎用手段も無い。1 往復で済ませるために集約を DB 側に置く。
-- 非正規化列（feeds.latest_published_at）にしなかったのは、ingest 側に更新責務が増えて
-- 実体とのドリフト経路を作るため。集約は常に articles を正とする。
--
-- なぜ anon から revoke しないか: 0009 / 0010 の match_articles は service_role からのみ呼ぶため
-- anon / authenticated の EXECUTE を落としているが、この関数は /feeds が anon キーの
-- Server Component クライアント（lib/supabase/server.ts）から呼ぶので落とすとページが壊れる。
-- 返すのは feed_id と公開日の最大値だけで、いずれも既存の anon SELECT (articles) で読める範囲を
-- 超えない。search_path は 0010 と同じ理由で public に固定する。

-- 集約を feed 単位のインデックスで賄えるようにする。既存の idx_articles_feed_id は feed_id 単独で、
-- max(published_at) を取るのに feed ごとの行を舐める必要がある。複合にして各 feed の先頭 1 行で
-- 済むようにする（articles は 3 万行規模で、ページレンダリングの同期パスに乗るため）。
create index if not exists idx_articles_feed_published
  on public.articles (feed_id, published_at desc);

create or replace function public.feed_latest_published()
returns table (
  feed_id uuid,
  latest_published_at timestamptz
)
language sql
stable
set search_path = public
as $$
  select a.feed_id, max(a.published_at) as latest_published_at
  from public.articles a
  where a.published_at is not null
  group by a.feed_id;
$$;
