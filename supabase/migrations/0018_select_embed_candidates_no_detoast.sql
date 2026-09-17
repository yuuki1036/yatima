-- select_embed_candidates の statement timeout を直す（YAT-77 hotfix）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 冪等: function は create or replace、index は if not exists。
--
-- 症状: 段階 3 デプロイ直後の初回 run（2026-09-16 21:23 UTC）で RPC が
--   code 57014 'canceling statement due to statement timeout' を返し、embed が 1 件も進まなかった
--   （候補 -1 → 選抜 -1）。isEmbedSelectStalled は 26h 実績が残っている間は鳴らないので run は緑。
--
-- 原因: 0017 の pool CTE が `left(a.content_html, 8000)` を**候補全件**（30 日窓 × embedding null ≒
--   14,000 行）に対して計算していた。content_html は TOAST に外出しされているので、これは 14,000 行分の
--   detoast（≒ 110MB）を「pending を数えるためだけ」に払う形になる。しかも pool は 3 回参照されるため
--   Postgres が CTE を materialize し、その 110MB がメモリ/一時領域に落ちる。max_rows=120 しか返さないのに。
--
-- 直し方（返り値の形・意味は 0017 と同一に保つ）:
--   1. pending は id だけを count する（content_html を触らない）
--   2. eligible は body_text_len >= min_len を WHERE に置く（idx_articles_embed_pending の述語と一致）
--   3. content_head の detoast は pick_rn <= max_rows に絞った**後**の join で行う（最大 max_rows 行分だけ）
--   4. used（直近 24h の feed 別 embed 数）を支える embedded_at の部分 index を足す（これまで seq scan）
--
-- 設計: .claude/designs/20260906-llm-cost-batches-embed-decoupling.md「near_dup の保護」

-- ═══════════════════════════════════════════════════════════════════════
-- 1. used 側を支える index（0017 には無かった）
-- ═══════════════════════════════════════════════════════════════════════
-- `embedded_at >= now() - interval '24 hours'` は `embedded_at is not null` を含意するので部分 index が効く。
-- embedStalled の 26h 実績 count（lib/rss/embed.ts embedHealthCounts）も同じ列を gte で引くので恩恵を受ける。
create index if not exists idx_articles_embedded_at
  on public.articles (embedded_at desc)
  where embedded_at is not null;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. select_embed_candidates を detoast なしに書き直す
-- ═══════════════════════════════════════════════════════════════════════
-- 述語: embedding is null ∧ feeds.active ∧ body_text_len >= min_len ∧ published_at >= now() - 30d
--       ∧ その feed の直近 24h の embed 数 < per_day（0017 と同一）
-- 返り値 jsonb: {"pending": ゲート前の件数, "eligible": ゲート後の件数, "rows": [...]}（0017 と同一）
-- **eligible = 0 でも pending を返す**（pending > 0 ∧ eligible = 0 はゲート全閉の署名。embedGateStuck が読む）。
-- rows の content_head は先頭 8,000 字。呼び出し側が htmlToInputText して 250 字に切る。
create or replace function public.select_embed_candidates(
  per_day  integer,
  max_rows integer,
  min_len  integer default 250
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  result jsonb;
begin
  with used as (
    select feed_id, count(*) as used
    from public.articles
    where embedded_at >= now() - interval '24 hours'
    group by feed_id
  ),
  gated as (
    -- ゲート後の候補。content_html はここで触らない（候補全件の detoast を払わない）。
    -- body_text_len >= min_len を WHERE に置くことで idx_articles_embed_pending
    -- （where embedding is null and body_text_len >= 250）を使える形にする。
    -- NULL（backfill 未了）は `>=` で偽になり除外される（0017 の coalesce(…, 0) と同じ結果）。
    select a.id, a.feed_id, a.published_at,
           row_number() over (partition by a.feed_id order by a.published_at desc, a.id) as rn,
           per_day - coalesce(u.used, 0) as room
    from public.articles a
    join public.feeds f on f.id = a.feed_id
    left join used u on u.feed_id = a.feed_id
    where a.embedding is null
      and f.active
      and a.published_at >= now() - interval '30 days'
      and a.body_text_len >= min_len
  ),
  eligible as (
    select id, feed_id, published_at,
           row_number() over (order by published_at desc, id) as pick_rn
    from gated
    where rn <= room
  ),
  picked as (
    -- detoast はここだけ。max_rows 行に絞ってから content_html を引く。
    select e.id, e.feed_id, e.published_at, e.pick_rn,
           a.title, left(a.content_html, 8000) as content_head
    from eligible e
    join public.articles a on a.id = e.id
    where e.pick_rn <= max_rows
  )
  select jsonb_build_object(
    'pending', (
      -- ゲート前の候補数。id だけ数える（0017 は content_head を計算した pool を count していた）。
      select count(*)
      from public.articles a
      join public.feeds f on f.id = a.feed_id
      where a.embedding is null
        and f.active
        and a.published_at >= now() - interval '30 days'
    ),
    'eligible', (select count(*) from eligible),
    'rows', coalesce((
      select jsonb_agg(
        jsonb_build_object('id', id, 'feed_id', feed_id, 'title', title,
                           'published_at', published_at, 'content_head', content_head)
        order by pick_rn)
      from picked
    ), '[]'::jsonb)
  )
  into result;

  return result;
end;
$$;

-- create or replace は既存の権限を保つが、0017 と同じ意図を明示するため再掲する。
revoke execute on function public.select_embed_candidates(integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.select_embed_candidates(integer, integer, integer) to service_role;
