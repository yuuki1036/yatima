-- match_articles の search_path を固定する（YAT-24）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）または SQL Editor に貼り付け
-- 冪等: create or replace。
--
-- Supabase Security Advisor の function_search_path_mutable（WARN）対応。
-- search_path 未設定の関数は、呼び出し側の role 設定で名前解決を差し替えられる余地が残る。
-- public に固定して塞ぐ（vector 型・<=> 演算子・articles はいずれも public スキーマにあるため
-- public 固定で従来どおり解決する。pg_catalog は常に暗黙で先頭に入る）。
--
-- 注意: create or replace function は SET 句を明示しないと既存設定を消す仕様のため、関数本体ごと
-- 再定義して set search_path = public を句に含める（ALTER だと将来の replace で外れる）。本体は
-- 0009 と同一。anon/authenticated への EXECUTE 取消も 0009 と同様に再適用する（自己完結・冪等）。
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
set search_path = public
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

-- create or replace は ACL を保持するが、自己完結のため revoke を再掲（冪等）。
revoke execute on function public.match_articles(
  vector, double precision, int, timestamptz, uuid
) from anon, authenticated;
