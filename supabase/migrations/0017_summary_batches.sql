-- LLM コスト削減の土台: 要約の予約・台帳・選抜 RPC と embedding の要約からの切り離し（YAT-75）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 冪等: 列 / table / index は if not exists、function は create or replace、
--       trigger と policy は drop → create。HNSW index は drop → create（述語を変えるため）。
-- 0001〜0016 を壊さず追加のみ。**既存コードは新列を一切読まないので挙動は変わらない。**
--
-- 設計: .claude/designs/20260906-llm-cost-batches-embed-decoupling.md（段階 1）
-- ADR:  20260906205224（支出の天井は run をまたぐ実数で置く）
--       20260906205225（派生値は消費者の窓に閉じ込める。llm_batches は本 ADR の既知の例外）
--       20260906205226（非同期化は投入/回収を並置し同期 API は触らない）
--       20260906205227（失敗の帰責は同ラウンドの証人で分ける）
--
-- 背景: 要約経路が LLM 月額の 97%（$19.4）を占める。Batches API（単価 50% 減）と選抜の絞り込みで
-- $4/月 まで落とすが、要約を絞ると title+summary で作っている embedding が同時に痩せ、near_dup
-- （YAT-55）の母集団が消える。そこで embedding を要約から切り離す（title+本文冒頭 250 字）。
-- この migration は後続 YAT-76〜80 が読む列・台帳・RPC を先に足すだけで、値の書き手はまだ居ない。

-- ═══════════════════════════════════════════════════════════════════════
-- 1. articles に 8 列
-- ═══════════════════════════════════════════════════════════════════════
alter table public.articles
  -- 期限付き予約（既定 30h）。Batches の二重投入を防ぐ唯一の手段。期限切れは自動失効なので、
  -- ロールバック（SUMMARIZE_BATCH_CAP=0）時に孤児予約を掃除する処理が要らない。
  add column if not exists summary_reserved_until timestamptz,
  -- 予約が属する llm_batches の行。FK は張らない（台帳は append-only で消えないが、
  -- 参照整合より「記事側の書き込みが台帳の状態で失敗しない」ことを優先する）。
  add column if not exists summary_batch_id uuid,
  -- 記事固有の失敗を隔離する（>= 3 で候補から外す）。**claim 時には増やさない。**
  -- 結果が返った後、同ラウンドに成功した記事（証人）が居るときだけ +1 する（ADR ...227）。
  add column if not exists summary_attempts integer not null default 0,
  -- 失敗の痕跡。課金（attempts）と切り離して必ず書く。
  -- 「同じ記事が 5 日連続で落ちている」を DB から読めるようにするため。
  add column if not exists summary_last_error text,
  add column if not exists summary_last_failed_at timestamptz,
  -- 本文 fetch（enrich）を試行済みか。成否に関わらず立てる（薄い本文を毎 run 取りに行かない）。
  add column if not exists enriched_at timestamptz,
  -- embedding の liveness probe。null = 旧レシピ（title+summary）、非 null = 新レシピ（title+lead）
  -- の暗黙マーカーを兼ねる。embedding_kind 列は作らない: 既存 16,000 行を UPDATE すると
  -- HNSW が +93MB 膨らむ（Supabase 無料枠 500MB のうち embedding が既に 77%）。
  add column if not exists embedded_at timestamptz,
  -- htmlToInputText 後の実本文長（下の trigger で維持）。embed ゲート（>= 250）の判定に使う。
  -- char_length(content_html) はマークアップ込みなので不可（HN の RSS は本文 0 字でも HTML は数百字）。
  add column if not exists body_text_len integer;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. body_text_len の算出関数と trigger
-- ═══════════════════════════════════════════════════════════════════════
-- lib/llm/extract-text.ts の htmlToInputText を SQL に写したもの。置換の順序も同じにする
-- （&amp;lt; → &lt; → < のように逐次置換の結果が順序に依存するため）。
-- 違い: JS 側は既定で 2000 字に切り詰めるが、ここは切らない（長さの観測値として上限を残す
-- 理由が無い。ゲートは 250 で、2000 超の記事はどのみち通る）。
-- \s の Unicode 範囲は JS と Postgres（iswspace）で僅かに違う（U+00A0 等）ため、長さそのものは
-- 本番 1,000 件のうち 56 件でずれる。250 の判定は同じ 1,000 件で不一致 0（YAT-75 で実測）。
create or replace function public.body_text_len_of(html text)
returns integer
language sql
immutable
strict
parallel safe
set search_path = public
as $$
  select char_length(
    btrim(
      regexp_replace(
        replace(replace(replace(replace(replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(html, '<(script|style).*?</\1>', ' ', 'gi'),
              '<[^>]+>', ' ', 'g'),
            '&nbsp;', ' ', 'gi'),
          '&amp;', '&'), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''),
        '\s+', ' ', 'g')
    )
  );
$$;

create or replace function public.articles_set_body_text_len()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.body_text_len := public.body_text_len_of(new.content_html);
  return new;
end;
$$;

-- insert と content_html の update（enrich の差し替え）で維持する。ingest の upsert は
-- ignoreDuplicates=true なので既存行は触らない＝insert 時に 1 回だけ計算される。
-- 既存 53,000 行の backfill は本 migration では**やらない**（1 トランザクションで全行 UPDATE すると
-- articles が丸ごとロックされ、TOAST を含む書き換えで数分かかる）。
-- `npm run backfill:body-text-len` が同じ関数で 2,000 行ずつ埋める。
drop trigger if exists trg_articles_body_text_len on public.articles;
create trigger trg_articles_body_text_len
  before insert or update of content_html on public.articles
  for each row execute function public.articles_set_body_text_len();

-- ═══════════════════════════════════════════════════════════════════════
-- 3. llm_batches: LLM 支出の唯一の台帳（append-only）
-- ═══════════════════════════════════════════════════════════════════════
-- YAT-74 は日次上限を articles.summarized_at（着地）で数えたが、Batches で非同期化すると
-- 「投入した件数」と「着地した件数」が正当に乖離し、支出の天井は投入基準で数える必要がある
-- （着地を待つと submit を止められない）。この台帳が日次上限の判定・コスト検証・
-- 「投入が止まったのか回収が止まったのか」の切り分けを一手に担う。
-- summarized_at は着地の観測として残し、両者の乖離＝未回収量として監視する。
create table if not exists public.llm_batches (
  id            uuid primary key default gen_random_uuid(),
  -- 'summarize' 等。用途別に日次上限を分けられるように持つ。
  purpose       text not null,
  -- Anthropic 側の msgbatch id。**同期経路（annotateMissing / refreshNow）は null。**
  -- unique は「同じバッチを 2 行に記録しない」ため（null 同士は衝突しない）。
  batch_id      text unique,
  -- claimed: 台帳行は作ったが create 前 / submitted: create 成功 / unresolved: 回収を試みたが未完
  -- collected: 結果を記事に反映済み / expired_unknown: 30h 経っても batch_id が分からず予約を解放した孤児
  status        text not null default 'claimed'
                check (status in ('claimed', 'submitted', 'unresolved', 'collected', 'expired_unknown')),
  model         text not null,
  -- **claim 時に立てる**（create 成功時ではない）。create 成功後に batch_id の書き込みが失われた
  -- 孤児も「submitted_at < now() - 30h」で拾えるようにするため。日次上限もこの列で数える。
  submitted_at  timestamptz not null default now(),
  request_count integer not null default 0,
  ended_at      timestamptz,
  collected_at  timestamptz,
  resolved_at   timestamptz,
  succeeded     integer,
  errored       integer,
  expired       integer,
  canceled      integer,
  -- 記事に実際に書けた件数。succeeded との差 = 回収中の DB 書き込み失敗。
  applied       integer,
  input_tokens  bigint,
  output_tokens bigint,
  -- 'cron' | 'manual'。0015 と同じ。手動 run の消費を分けて集計できるように。
  run_kind      text not null default 'cron',
  -- claim の結果（pool / per_feed / max_rows 等）。「絞り込みが 0 件」と「対象ゼロ」を後から区別する。
  selection     jsonb,
  last_error    text
);

-- 日次上限: 「今日の request_count 合計」を毎 run 引く。
create index if not exists idx_llm_batches_submitted_at
  on public.llm_batches (submitted_at desc);
-- collect と resolveStaleLedger: 未回収の行だけを舐める。
create index if not exists idx_llm_batches_open
  on public.llm_batches (status, submitted_at)
  where collected_at is null;

-- RLS: 有効化するがポリシーは付けない（anon / authenticated は全拒否）。
-- 読み手は cron と保守スクリプト（service_role）だけで、UI から読む予定が無い。
-- 0015 の「既存テーブルと揃えて開ける」より、支出の台帳は閉じておく方を優先する。
alter table public.llm_batches enable row level security;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. RPC
-- ═══════════════════════════════════════════════════════════════════════
-- 4a. claim_summary_candidates: 要約対象の選抜と予約を**原子的に**行う
--
-- feed 単位のラウンドロビン（credibility はタイブレーク）。rn 昇順で取ると「どの feed も 1 件目を
-- 取り終わるまで誰も 2 件目に進めない」ので、流入 3.75/日 未満の feed は実質 100% 要約され、
-- dev.to（流入の 35%）は日次 120 ÷ 32 feed ≒ 4 件/日 に落ちる。
--
-- 返り値は jsonb: {"pool": 絞り込み前の母数, "ids": [予約した記事 id], "lease_deadline": 予約期限}
-- **pool を必ず返す。** 返さないと「絞り込みが 0 件」と「対象ゼロ＝正常」が同じ 0 に潰れ、
-- 要約が止まったまま緑で流れる（YAT-74 セルフレビューで実際に作りかけた欠陥）。
-- lease_deadline は settle の所有者チェックに使う。JS の Date は ms 精度なので、µs を含む
-- timestamptz をそのまま返すと往復で一致しなくなる → ms に丸めてから予約に書く。
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
  -- pool は 2 回参照されるので Postgres 12+ では自動的に materialize される（1 回しか走らない）。
  with pool as (
    select a.id, a.feed_id, a.published_at, f.credibility
    from public.articles a
    join public.feeds f on f.id = a.feed_id
    where a.summary is null
      and a.content_html is not null
      and f.active
      and a.summary_attempts < max_attempts
      and (a.summary_reserved_until is null or a.summary_reserved_until < now())
  ),
  ranked as (
    select id, credibility, published_at,
           row_number() over (partition by feed_id order by published_at desc nulls last, id) as rn
    from pool
  ),
  picked as (
    select id from ranked
    where rn <= per_feed
    order by rn, credibility desc, published_at desc nulls last, id
    limit max_rows
  ),
  locked as (
    -- 同時 run（cron の重複発火・refreshNow）と取り合わない。取れなかった行は黙って飛ばす。
    -- ⚠ 予約述語をここに**再掲する**のは飾りではない。READ COMMITTED では、pool のスナップショット
    -- 取得後・この lock 到達前に別 run が同じ行を予約して commit すると、skip locked は
    -- （既に unlock 済みなので）スキップせず、EvalPlanQual が再評価するのはこの scan 自身の
    -- 述語だけ。予約条件を pool にしか書かないと再評価されず、同じ行を二重予約 → 二重投入 →
    -- 二重課金になる（この設計が最も防ぎたい事故）。ここに書けば EPQ が新しい行版で弾く。
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
    'pool', (select count(*) from pool),
    'ids', coalesce((select jsonb_agg(id) from reserved), '[]'::jsonb),
    'lease_deadline', deadline
  )
  into result;

  return result;
end;
$$;

-- 4b. settle_summary_attempts: 結果が返った後の帰責
--
-- charged / released はどちらも [{"id": uuid, "error": text}] の jsonb 配列。
-- charged: attempts +1 ＋ 痕跡 ＋ 予約解除（記事固有の失敗。同ラウンドに証人が居るときだけ）
-- released: 痕跡 ＋ 予約解除のみ（環境起因。attempts は据え置き）
-- 成功した記事は呼び出し側が summary と一緒に予約を消すので、ここでは扱わない。
-- 所有者チェック: summary_reserved_until = lease_deadline の行だけ触る（他 run の予約を消さない）。
-- 返り値 {"charged": n, "released": n} は「触れた行数」。呼び出し側は要求数と比べて、
-- 予約が既に失効して他 run に取られていた行を検出する。
create or replace function public.settle_summary_attempts(
  charged        jsonb,
  released       jsonb,
  lease_deadline timestamptz
)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  n_charged  integer := 0;
  n_released integer := 0;
begin
  with c as (
    select (e->>'id')::uuid as id, e->>'error' as err
    from jsonb_array_elements(coalesce(charged, '[]'::jsonb)) e
  ),
  upd as (
    update public.articles a
    set summary_attempts       = a.summary_attempts + 1,
        summary_last_error     = left(c.err, 500),
        summary_last_failed_at = now(),
        summary_reserved_until = null,
        summary_batch_id       = null
    from c
    where a.id = c.id
      and a.summary_reserved_until = lease_deadline
    returning a.id
  )
  select count(*) into n_charged from upd;

  with r as (
    select (e->>'id')::uuid as id, e->>'error' as err
    from jsonb_array_elements(coalesce(released, '[]'::jsonb)) e
  ),
  upd as (
    update public.articles a
    set summary_last_error     = left(r.err, 500),
        summary_last_failed_at = now(),
        summary_reserved_until = null,
        summary_batch_id       = null
    from r
    where a.id = r.id
      and a.summary_reserved_until = lease_deadline
    returning a.id
  )
  select count(*) into n_released from upd;

  return jsonb_build_object('charged', n_charged, 'released', n_released);
end;
$$;

-- 4c. select_embed_candidates: embedding 対象の選抜（要約と独立）
--
-- 述語: embedding is null ∧ feeds.active ∧ body_text_len >= min_len ∧ published_at >= now() - 30d
--       ∧ その feed の直近 24h の embed 数 < per_day
-- 候補を 30 日窓に閉じるのは、窓外は near_dup（YAT-55）に 1 件も効かないのに予算を食うため
-- （消費者の窓に閉じ込める。ADR ...225）。per_day は「窓の保有数」でなく「日次流量」で置く:
-- 保有数でキャップすると貪欲消費と組み合わさって bang-bang になる。
--
-- 返り値 jsonb: {"pending": ゲート前の件数, "eligible": ゲート後の件数, "rows": [...]}
-- **eligible = 0 でも pending を返す。** pending > 0 ∧ eligible = 0 は「ゲート全閉」の署名で、
-- day-0 回帰（enriched_at 全 NULL で純ゲートが全部弾く）を検知する唯一の手掛かり。
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
  with pool as (
    select a.id, a.feed_id, a.title, a.published_at,
           left(a.content_html, 8000) as content_head,
           coalesce(a.body_text_len, 0) >= min_len as long_enough
    from public.articles a
    join public.feeds f on f.id = a.feed_id
    where a.embedding is null
      and f.active
      and a.published_at >= now() - interval '30 days'
  ),
  used as (
    select feed_id, count(*) as used
    from public.articles
    where embedded_at >= now() - interval '24 hours'
    group by feed_id
  ),
  gated as (
    select p.id, p.feed_id, p.title, p.published_at, p.content_head,
           row_number() over (partition by p.feed_id order by p.published_at desc, p.id) as rn,
           per_day - coalesce(u.used, 0) as room
    from pool p
    left join used u on u.feed_id = p.feed_id
    where p.long_enough
  ),
  eligible as (
    select id, feed_id, title, published_at, content_head,
           row_number() over (order by published_at desc, id) as pick_rn
    from gated
    where rn <= room
  )
  select jsonb_build_object(
    'pending',  (select count(*) from pool),
    'eligible', (select count(*) from eligible),
    'rows', coalesce((
      select jsonb_agg(
        jsonb_build_object('id', id, 'feed_id', feed_id, 'title', title,
                           'published_at', published_at, 'content_head', content_head)
        order by pick_rn)
      from eligible where pick_rn <= max_rows
    ), '[]'::jsonb)
  )
  into result;

  return result;
end;
$$;

-- select_embed_candidates の pending 側を支える部分 index。
-- ⚠ 述語に 250 が焼き込まれる（design doc open 6）: min_len を動かすときは index も張り直すこと。
-- 動かさずに閾値だけ変えると index が効かず seq scan に落ちる（静かな劣化）。
create index if not exists idx_articles_embed_pending
  on public.articles (published_at desc)
  where embedding is null and body_text_len >= 250;

-- 4d. db_size_bytes: ディスク天井（450MB）の判定
--
-- pg_database_size は接続 role の権限で動くので security definer にして service_role から呼べるようにする。
-- ingest はこの値が天井を超えたら embed を skipReason='disk_ceiling' で見送る（exit 1 にはしない。
-- 永久赤を作らない）。
create or replace function public.db_size_bytes()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select pg_database_size(current_database());
$$;

-- RPC 4 本とも Server Action / cron から service_role 経由でのみ呼ぶ。0009 と同じく、関数作成時の
-- public への既定 EXECUTE 付与を PostgREST に公開される anon / authenticated から取り消す。
-- claim / settle は書き込み、db_size_bytes は security definer なので、match_articles より強い理由で塞ぐ。
revoke execute on function public.claim_summary_candidates(integer, integer, integer, integer, uuid)
  from public, anon, authenticated;
revoke execute on function public.settle_summary_attempts(jsonb, jsonb, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.select_embed_candidates(integer, integer, integer)
  from public, anon, authenticated;
revoke execute on function public.db_size_bytes()
  from public, anon, authenticated;
grant execute on function public.claim_summary_candidates(integer, integer, integer, integer, uuid) to service_role;
grant execute on function public.settle_summary_attempts(jsonb, jsonb, timestamptz) to service_role;
grant execute on function public.select_embed_candidates(integer, integer, integer) to service_role;
grant execute on function public.db_size_bytes() to service_role;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. match_articles と HNSW index を「要約済み」に閉じる
-- ═══════════════════════════════════════════════════════════════════════
-- embedding を要約から切り離すと「embedding はあるが summary が無い」記事が top-8 を占め、
-- /ask の Citation が空になる。0009 のコメントが名指しした footgun。
-- 条件を WHERE に足すだけだと post-filter になり、切り離し後は HNSW の上位 40 近傍の ~72% が
-- 捨てられて recall が静かに痩せる。そこで index 自体を summary 済に閉じる（部分 index）。
-- この index の利用者は match_articles だけ（<=> は 0009/0010 にしか無く、compute-dedup-rate と
-- curate は JS で cosine。生涯 idx_scan=2）なので、述語を足しても他経路に影響しない。
-- 現状は embedding 付き 6,126 件が全件 summary 済なので index の中身は変わらず、
-- 差し替え直後のサイズも同じ（48MB）。切り離し後に summary 無しの embedding が増えても膨らまない。
--
-- ⚠ 述語を焼き込む: RAG のコーパス定義（summary is not null）を変えるときは index も変えること。
drop index if exists public.idx_articles_embedding;
create index idx_articles_embedding
  on public.articles using hnsw (embedding vector_cosine_ops)
  where embedding is not null and summary is not null;

-- 本体は 0010 と同一 ＋ `and a.summary is not null`。planner が部分 index を選ぶには、
-- クエリの WHERE が index の述語を含意している必要がある（両方の条件を明示する）。
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
    and a.summary is not null
    and (filter_published_after is null or a.published_at >= filter_published_after)
    and (filter_feed_id is null or a.feed_id = filter_feed_id)
    and (a.embedding <=> query_embedding) < 1 - match_threshold
  order by a.embedding <=> query_embedding asc
  limit least(match_count, 200);
$$;

revoke execute on function public.match_articles(
  vector, double precision, int, timestamptz, uuid
) from anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. feed_health_snapshots に gate 起因の欠損を追う 2 列
-- ═══════════════════════════════════════════════════════════════════════
-- window_own_articles: 窓内の自 feed 記事総数（embedding の有無を問わない）
-- window_own_eligible: うち embed ゲート（body_text_len >= 250）を通る件数
-- window_own_embedded（0015）との 3 段で「記事が無い / ゲートで弾かれた / embed が追いついていない」を
-- feed 単位で切り分ける。既存行は null（撮影時に列が無かった）。
alter table public.feed_health_snapshots
  add column if not exists window_own_articles integer,
  add column if not exists window_own_eligible integer;
