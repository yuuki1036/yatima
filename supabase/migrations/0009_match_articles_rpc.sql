-- Phase5 スキーマ: 横断 Q&A（RAG）の ANN 検索 RPC（YAT-22）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 冪等: function は create or replace。新規 index は無し（フィルタ用 B-tree は 0001 で作成済み、
--       cosine の hnsw index は 0003 で作成済みなのでそのまま再利用する）。

-- 記事 embedding（0003 の vector(1024)）に対する cosine 近傍検索。
-- 既存 dedup は「全 embedding を JS へ転送して cosine 計算」だが、全期間コーパスでは
-- ペイロードが肥大して破綻するため、RAG は DB 内 ANN（hnsw index）で引く（YAT-21 調査結論）。
--
-- 引数:
--   query_embedding        … 検索クエリのベクトル（PostgREST が text '[..]' → vector にキャスト）
--   match_threshold        … cosine 類似度の下限（0〜1）。距離 <=> は 1 - 類似度 の関係
--   match_count            … 返却上限（least で 200 にハードキャップ）
--   filter_published_after … 指定時はこの日時以降の記事のみ（任意）
--   filter_feed_id         … 指定時はこの feed の記事のみ（任意）
--
-- 演算子は cosine の <=>（0003 の vector_cosine_ops index と一致させること。違う演算子だと
-- index が効かない）。`order by embedding <=> query asc` で hnsw index による近傍順を取る。
-- ef_search は既定（40）のまま使う。取得件数 8 に対し 40 は十分で recall も足りる。
-- 関数レベル `set hnsw.ef_search` は Supabase の pooler ロールに設定権限が無く migration が
-- 失敗するため張らない（permission denied to set parameter）。recall 不足が出たら別途検討する。
-- iterative_scan（pgvector 0.8 の post-filter 対策）も MVP では使わない。フィルタ UI を持たず
-- 素の ANN top-k が主用途のため。フィルタ併用で recall 不足が出たら別途チューニングする。
create or replace function public.match_articles(
  query_embedding vector(1024),
  match_threshold double precision default 0.4,
  match_count int default 8,
  filter_published_after timestamptz default null,
  filter_feed_id uuid default null
)
returns table (
  id uuid,
  title text,
  summary text,
  url text,
  published_at timestamptz,
  feed_id uuid,
  similarity double precision
)
language sql
stable
as $$
  select
    a.id,
    a.title,
    a.summary,
    a.url,
    a.published_at,
    a.feed_id,
    1 - (a.embedding <=> query_embedding) as similarity
  from public.articles a
  where a.embedding is not null
    and (filter_published_after is null or a.published_at >= filter_published_after)
    and (filter_feed_id is null or a.feed_id = filter_feed_id)
    and (a.embedding <=> query_embedding) < 1 - match_threshold
  order by a.embedding <=> query_embedding asc
  limit least(match_count, 200);
$$;

-- この RPC は Server Action から service_role（admin クライアント）経由でのみ呼ぶ。
-- PostgREST に公開される anon / authenticated ロールからの実行を塞ぐ（関数作成時の
-- public への既定 EXECUTE 付与を取り消す）。情報露出自体は既存の anon SELECT を
-- 超えないが、未認証から HNSW スキャンを起こせる導線を残さない防御。
revoke execute on function public.match_articles(
  vector, double precision, int, timestamptz, uuid
) from anon, authenticated;
