-- select_embed_candidates の pending（ゲート前の候補数）を、選抜があるときは下界で返す（YAT-84）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 冪等: function は create or replace。
--
-- 症状: ingest が毎 run 呼ぶこの RPC が、pg_stat_statements で最大 5,925ms（1 回 約 12,600 ページ）。
--   PostgREST（authenticator）の statement_timeout=8s に近い。timeout すると fail-soft で selectError に
--   なり、赤くなるのは 26h 後の isEmbedSelectStalled を待つことになる（0018 の症状と同じ型）。
--
-- 原因: 0018 の 'pending' は「30 日窓 ∧ embedding null ∧ active」の全件 count で、30 日窓の全行
--   （約 12,000 行）を idx_articles_feed_published でたどり、embedding null の判定のために 1 行ずつ
--   ヒープを読んでいた（約 9,900 ページ）。選抜そのもの（gated / eligible / picked）は約 2,700 ページ。
--
-- 直し方（0021 の pool と同じ考え方）:
--   - pending を読んで判定しているのは isEmbedGateStuck（pending > 0 ∧ eligible = 0）だけ。
--   - gated（ゲート後の候補）は pending の部分集合（同じ条件 ∧ body_text_len >= min_len）なので、
--     eligible > 0 のとき gated の件数は pending の下界で、しかも 0 より大きい。判定には十分。
--   - 全件の count は eligible = 0 のとき（＝ゲート全閉を疑う回）だけ行い、正確な pending を返す。
--   - 'pending_capped' = true は「pending は下界」を表す。ログでは「候補 N+」と表示する。
--   選抜される行・並び・rows の中身は 0018 と同一（used / gated / eligible / picked は一字一句同じ）。
--
-- 関連: 0017（導入）、0018（detoast の除去）、0021（claim の pool を下界にした同種の対処）

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
  n_gated    bigint;
  n_eligible bigint;
  n_pending  bigint;
  v_rows     jsonb;
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
  select (select count(*) from gated),
         (select count(*) from eligible),
         coalesce((
           select jsonb_agg(
             jsonb_build_object('id', id, 'feed_id', feed_id, 'title', title,
                                'published_at', published_at, 'content_head', content_head)
             order by pick_rn)
           from picked
         ), '[]'::jsonb)
  into n_gated, n_eligible, v_rows;

  if n_eligible > 0 then
    -- gated ⊆ pending なので下界。eligible > 0 なら gated > 0 で、isEmbedGateStuck の判定には足りる。
    n_pending := n_gated;
  else
    -- ゲート全閉を疑う回だけ、ゲート前の候補を全部数える（0018 と同じ式）。
    select count(*) into n_pending
    from public.articles a
    join public.feeds f on f.id = a.feed_id
    where a.embedding is null
      and f.active
      and a.published_at >= now() - interval '30 days';
  end if;

  return jsonb_build_object(
    'pending', n_pending,
    'pending_capped', n_eligible > 0,
    'eligible', n_eligible,
    'rows', v_rows
  );
end;
$$;

-- create or replace は既存の権限を保つが、0017 / 0018 と同じ意図を明示するため再掲する。
revoke execute on function public.select_embed_candidates(integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.select_embed_candidates(integer, integer, integer) to service_role;
