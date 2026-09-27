-- claim_summary_candidates の statement timeout を直す（YAT-78 hotfix・0018〜0020 と同種）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 冪等: index は if not exists、function は create or replace。
--
-- 症状: YAT-78（#86）で annotateMissing が claim_summary_candidates を使い始めた最初の cron run
--   （2026-09-27 08:15 UTC）で RPC が code 57014 'canceling statement due to statement timeout' を返し、
--   要約が 1 件も進まなかった（母数 -1 → 選抜 0）。isSelectionDead が拾って run は赤。
--
-- 原因: 0017 の pool CTE は「未要約 ∧ 本文あり ∧ active feed」の全行（約 33,000 行）を articles の
--   seq scan（約 12,000 ページ・94MB）で集め、feed ごとの row_number のために全件をソートしていた
--   （work_mem を超えて一時ファイルに落ちる）。返すのは高々 max_rows 行なのに、コストは未要約の
--   バックログ全体に比例する。12,000〜32,000 ページを触る同種のクエリは普段 70〜100ms で終わるが、
--   pg_stat_statements では shared_blks_read = 0（全ページが shared_buffers 上）のまま 6.6〜9.7s かかった回が同日に 3 回あり、
--   PostgREST（authenticator）の statement_timeout=8s を越えうる。遅い回は触ったページ数に比例して
--   延びる（1 ページあたり 0.2〜0.6ms）。遅くなる原因（CPU・メモリの逼迫など）は DB の外で未確認なので、
--   直し方は「触るページ数そのものを減らす」に寄せる。
--   未要約は日に約 340 件ずつ増える（直近 30 日: 流入 ≒ 420/日 − 要約 ≒ 80/日）ので、放置すると普段の時間も伸び続ける。
--
-- 直し方（選ばれる行の集合と順序・予約の二重取り防止は 0017 と同一に保つ）:
--   1. 「未要約 ∧ 本文あり」の行だけの部分 index を (feed_id, published_at desc nulls last, id) で張る。
--   2. 選抜を active feed ごとの LATERAL top-N に書き換える。各 feed で index を新しい順に
--      per_feed + 1 件だけ読んで止まるので、読むのは「active feed 数 × (per_feed + 1)」行
--      （現状 31 × 5 ≒ 150 行・約 110 ページ）。バックログがいくら増えても変わらない。
--      feed 内の順序は 0017 の row_number と同じ (published_at desc nulls last, id) なので、
--      「feed ごとの上位 per_feed 件」の集合は 0017 の rn <= per_feed と一致する。
--   3. pool（絞り込み前の母数）を「全件の count」から「frontier の件数（下界）」に変える。
--      全件 count は heap の全走査になる（直し方 2 の意味が無くなる）。呼び出し側が pool を判定に
--      使うのは isSelectionDead の pool > 0 だけで、frontier の件数が 0 になるのは真の母数が 0 の
--      ときに限る（どれか 1 feed に 1 件でもあれば frontier に 1 件以上入る）ので、判定は変わらない。
--      pool_capped = true は「どこかの feed に per_feed 件を超える候補がある＝pool は下界」を表す。
--      per_feed + 1 件目はこの判定のためだけに読む（選抜には入れない）。
--
-- index の述語に summary_attempts / summary_reserved_until を入れない:
--   - どちらも claim / settle が毎 run 書き換える列。index（述語・INCLUDE を含む）に入れると、
--     その update が HOT にならず全 index にエントリが増える。
--   - max_attempts は RPC の引数、予約の期限切れは now() 依存なので述語に焼き込めない。
--   隔離（attempts >= 3）と予約中の行は index scan の後の filter で飛ばす。どちらも feed の先頭付近に
--   しか居ない少数（隔離は isQuarantineSurging が 24h 5 件超で赤、予約は 1 run 高々 20 件）。
-- 述語の 2 列を書き換える update は、この index が無くても既に HOT ではない:
--   summary は 0017 idx_articles_embedding / 0020 idx_articles_enrich_pending の述語列。
--   content_html を書き換えるのは enrich（lib/rss/enrich.ts）だけで、同じ update で embedding
--   （0017 / 0019 の部分 index の述語列）も落とす。
--
-- index は単調に太る: 要約されない古い行は述語から抜けない（現状 41,849 エントリ ≒ 2.3MB・見積もり、
--   月 +10,000 エントリ ≒ +0.6〜1MB）。ただし LATERAL は各 feed の先頭しか読まないので、太っても
--   claim の速さは変わらない（木の高さが対数で増えるだけ）。細らせたいときは述語から行を抜く
--   データ側の手当て（記事本体の保持窓＝design doc open 7 で content_html を落とす等）で効く。
--   選抜を 35 日窓に閉じる案は速さのためには要らず、低流量 feed の古い未要約を捨てる挙動変更に
--   なるので、ここではやらない。
--
-- CONCURRENTLY は使わない（migrate ランナーが各ファイルを begin/commit で包むため）。部分 index の
-- 作成は articles の全走査になり、読み取り部分の代用クエリで実測約 5 秒（遅い状態なら 10 秒程度）。
-- その間 articles への書き込みは SHARE lock で待たされる。ingest（cron "17 * * * *"。GitHub の遅延で
-- 実際の開始は前後する）が走っていない時刻に適用する（0019・0020 と同じ作法）。
-- 適用直前に `gh run list --workflow ingest.yml --status in_progress` が空であることを確かめる。
-- migrate の接続は lock_timeout 0（無制限）なので、下の set local で 5 秒に絞る。ロックが取れずに
-- 失敗したら、この migration ごと rollback されるので時間をおいて再実行すればよい。
--
-- 設計: .claude/designs/20260906-llm-cost-batches-embed-decoupling.md「要約の選抜規則（②）」
-- 関連: 0017（claim_summary_candidates の導入）、0018〜0020（同種 timeout の対処）、PR #86

set local lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════
-- 1. 選抜を支える部分 index
-- ═══════════════════════════════════════════════════════════════════════
-- 列の並びは LATERAL の「feed_id = f.id ∧ order by published_at desc nulls last, id」と揃える。
-- desc の既定は nulls first なので nulls last を明示する（0020 と同じ罠）。id まで入れるのは
-- 同時刻の記事の並び（0017 の row_number の第 2 キー）も index 順で決め、ソートを挟まないため。
-- ⚠ 述語を焼き込む: claim_summary_candidates の WHERE がこの述語（summary is null ∧ content_html
-- is not null）を含意しなくなると、planner はこの index を選べず黙って seq scan に戻る（例: 本文条件を
-- 外す・coalesce(summary, '') = '' に書き換える）。選抜の述語を変えるときは index も張り直すこと。
create index if not exists idx_articles_summary_pending
  on public.articles (feed_id, published_at desc nulls last, id)
  where summary is null and content_html is not null;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. claim_summary_candidates を feed ごとの LATERAL top-N に書き換える
-- ═══════════════════════════════════════════════════════════════════════
-- 引数・返り値の形は 0017 と同一 ＋ 'pool_capped'。
-- 返り値 jsonb: {"pool": frontier の件数（真の母数の下界）, "pool_capped": 下界か,
--                "ids": [予約した記事 id], "lease_deadline": 予約期限}
-- **pool > 0 ⇔ 真の母数 > 0** は 0017 と同じ（isSelectionDead が読むのはここだけ）。
-- pool_capped = false のときは pool が真の母数そのもの。
create or replace function public.claim_summary_candidates(
  per_feed     integer,
  max_rows     integer,
  lease_hours  integer default 30,
  max_attempts integer default 3,
  batch_row    uuid    default null
)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  deadline timestamptz := date_trunc('milliseconds', now() + make_interval(hours => lease_hours));
  result   jsonb;
begin
  -- 0017 では per_feed < 1（や null）でも pool = 全件 > 0・ids = [] を返して isSelectionDead が赤くなった。
  -- frontier 化すると pool = 0 に潰れて「対象ゼロ＝正常」に化けるので、明示的に落として poolError で赤くする。
  -- （`if not (per_feed >= 1)` だと null で条件が null → 偽扱いになり素通りするので is null を分けて書く）
  if per_feed is null or per_feed < 1 then
    raise exception 'claim_summary_candidates: per_feed must be >= 1 (got %)', per_feed;
  end if;

  with frontier as (
    -- active feed ごとに、候補を新しい順に per_feed + 1 件だけ idx_articles_summary_pending から引く。
    -- WHERE は index の述語（summary is null ∧ content_html is not null）を含む形で書く
    -- （planner が部分 index を選ぶには、クエリの WHERE が述語を含意している必要がある）。
    -- rn は feed 内の順位で、0017 の row_number() over (partition by feed_id order by
    -- published_at desc nulls last, id) と同じ値になる（同じ順序の先頭から数えるため）。
    select c.id, c.published_at, f.credibility,
           row_number() over (partition by f.id order by c.published_at desc nulls last, c.id) as rn
    from public.feeds f
    cross join lateral (
      select a.id, a.published_at
      from public.articles a
      where a.feed_id = f.id
        and a.summary is null
        and a.content_html is not null
        and a.summary_attempts < max_attempts
        and (a.summary_reserved_until is null or a.summary_reserved_until < now())
      order by a.published_at desc nulls last, a.id
      limit per_feed::bigint + 1
    ) c
    where f.active
  ),
  picked as (
    -- ここから下は 0017 と同一（rn <= per_feed の行を rn 昇順の RR で取り、credibility はタイブレーク）。
    select id from frontier
    where rn <= per_feed
    order by rn, credibility desc, published_at desc nulls last, id
    limit max_rows
  ),
  locked as (
    -- 同時 run（cron の重複発火・refreshNow）と取り合わない。取れなかった行は黙って飛ばす。
    -- ⚠ 予約述語をここに**再掲する**のは飾りではない（0017 のコメント参照）。READ COMMITTED では、
    -- frontier のスナップショット取得後・この lock 到達前に別 run が同じ行を予約して commit すると、
    -- skip locked はスキップせず、EvalPlanQual が再評価するのはこの scan 自身の述語だけ。
    -- ここに書かないと同じ行を二重予約 → 二重投入 → 二重課金になる。
    select a.id from public.articles a
    where a.id in (select id from picked)
      and a.summary is null
      and a.summary_attempts < max_attempts
      and (a.summary_reserved_until is null or a.summary_reserved_until < now())
    for update of a skip locked
  ),
  reserved as (
    update public.articles a
    set summary_reserved_until = deadline,
        summary_batch_id = batch_row
    where a.id in (select id from locked)
    returning a.id
  )
  select jsonb_build_object(
    'pool', (select count(*) from frontier where rn <= per_feed),
    'pool_capped', (select coalesce(bool_or(rn > per_feed), false) from frontier),
    'ids', coalesce((select jsonb_agg(id) from reserved), '[]'::jsonb),
    'lease_deadline', deadline
  )
  into result;

  return result;
end;
$$;

-- create or replace は既存の権限を保つが、0017 と同じ意図を明示するため再掲する（0018 と同じ作法）。
revoke execute on function public.claim_summary_candidates(integer, integer, integer, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_summary_candidates(integer, integer, integer, integer, uuid) to service_role;
