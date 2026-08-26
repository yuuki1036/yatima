-- 退役スコアリングの観測を耐久化する（YAT-55 観測 ⑥）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 冪等: table / index は if not exists、policy は drop → create。
--
-- 背景: 退役推奨の閾値較正（YAT-55）は 2026-07-14 の起票から 6 週間、観測が 1 点も残っていない。
-- 理由は「待ち時間」ではなく置き場が無いこと:
--   - feeds.near_dup_rate は上書き列（0008）で履歴が無い。週次 cron が毎回踏み潰す
--   - diagnose-feed-health は手動実行のみで、出力は標準出力にしか出ない
-- 結果、系列は 3 回リセットされた（母集団バグ 2026-08-04 / Import AI 非活性化 08-13 /
-- 要約全滅 08-26）。とくに 3 回目では、有向 near_dup で唯一クリーンだった 08-17 の cron 結果が
-- 08-24 の汚染値に上書きされて失われている。knowledge の
-- [[defer-on-zero-observation-needs-durable-probe]]（判断をひっくり返す観測手段を必ず残す）と
-- [[fixing-truncated-population-exposes-hidden-bias]]（上書き型の列は観測もリセットする）が該当。
--
-- なぜ feeds に列を足すのでなく別テーブルか: 必要なのは「今の値」ではなく「値の系列」だから。
-- 上書き列をいくら足しても同じ問題を再生産する。
--
-- なぜ window_* を各行に非正規化するか: **その観測が信用できるかを観測自身に持たせるため。**
-- 08-24 の汚染は「30 日窓に直近 5 日の記事が 1 件も無い」状態だったが、当時それを示す記録が
-- どこにも無く、2 日後に別経路（articles を数え直す）で気付いた。窓の総数と embedding 網羅率を
-- 同じ行に書いておけば、後から系列を見た人が汚染点を除外できる。run 単位のテーブルに分けても
-- よいが、feed 33 本 × 週次 ≒ 1.7k 行/年なので結合のコストの方が高い。

create table if not exists public.feed_health_snapshots (
  id uuid primary key default gen_random_uuid(),
  captured_at timestamptz not null default now(),

  feed_id uuid not null references public.feeds(id) on delete cascade,
  -- feed が消えても系列を読めるように、表示名は撮影時点の値を焼き込む。
  feed_title text,

  -- ── 判定結果 ──
  score double precision not null,
  reasons text[] not null default '{}',
  recommended boolean not null,

  -- ── シグナルの生値（撮影時点）──
  -- dead: 発信停滞の日数と、その feed の投稿間隔から出した適応閾値（YAT-70）。
  silence_days double precision,
  dead_threshold_days double precision,
  credibility double precision,
  source_pref double precision,
  -- near_dup_rate は null を取りうる（母数不足 / embedding 0 件）。null の理由を切り分けられる
  -- ように own_articles を併記する。
  near_dup_rate double precision,
  own_articles integer,

  -- ── 観測の信頼性（この行を較正に使ってよいかの判断材料）──
  -- 窓内の記事総数と、うち embedding を持つ件数。比が大きく落ちていれば要約/embed 経路の
  -- 障害中に撮った観測なので較正から除外する。
  window_articles integer,
  window_embedded integer,
  -- fetchWindowArticles が FETCH_CAP に達して古い側を切り捨てたか。true なら窓が実質縮んでいる。
  window_truncated boolean not null default false
);

-- 系列読み出しは「feed ごとに時系列」と「撮影回ごとに横断」の両方をやる。
create index if not exists idx_feed_health_snapshots_feed_time
  on public.feed_health_snapshots (feed_id, captured_at desc);
create index if not exists idx_feed_health_snapshots_time
  on public.feed_health_snapshots (captured_at desc);

-- ── RLS ──────────────────────────────────────────────
-- 0001 / 0006 と同方針。anon/authenticated には SELECT のみ。
-- 書き込み（週次 cron）は service_role が RLS をバイパスするためポリシー不要。
alter table public.feed_health_snapshots enable row level security;

drop policy if exists "read feed_health_snapshots" on public.feed_health_snapshots;
create policy "read feed_health_snapshots" on public.feed_health_snapshots
  for select to anon, authenticated using (true);
