-- 退役スコアリングの観測を耐久化する（YAT-55 観測 ⑥）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 冪等: table / index は if not exists、policy は drop → create。
-- 0001〜0014 を壊さず追加のみ（新規テーブルのみ。既存テーブルには一切触らない）。
--
-- 背景: 退役推奨の閾値較正（YAT-55）は 2026-07-14 の起票から 6 週間、観測が 1 点も残っていない。
-- 理由は「待ち時間」ではなく置き場が無いこと:
--   - feeds.near_dup_rate は上書き列（0008）で履歴が無い。週次 cron が毎回踏み潰す
--   - diagnose-feed-health は手動実行のみで、出力は標準出力にしか出ない
-- 結果、系列は 3 回リセットされた（母集団バグ 2026-08-04 / feed の非活性化 08-13 /
-- 要約全滅 08-26）。とくに 3 回目では、指標を有向化した後で唯一クリーンだった 08-17 の cron 結果が
-- 08-24 の汚染値に上書きされて失われている。knowledge の
-- [[defer-on-zero-observation-needs-durable-probe]]（判断をひっくり返す観測手段を必ず残す）と
-- [[fixing-truncated-population-exposes-hidden-bias]]（上書き型の列は観測もリセットする）が該当。
--
-- なぜ feeds に列を足すのでなく別テーブルか: 必要なのは「今の値」ではなく「値の系列」だから。
-- 上書き列をいくら足しても同じ問題を再生産する。

create table if not exists public.feed_health_snapshots (
  id uuid primary key default gen_random_uuid(),
  captured_at timestamptz not null default now(),

  -- **FK を張らない。** feed を物理削除しても系列を残すため（0011 の source_ref と同じ作法:
  -- 「FK なし＝記事削除で問題は残す」）。on delete cascade にすると、退役推奨が出た feed ほど
  -- 削除されやすく、その判断を裏付けた系列が同時に消える——本テーブルが防ごうとしている
  -- 「系列が消える」事故を、/feeds の削除ボタン 1 回で再現することになる。
  -- 参照整合より系列の保存を優先する。表示名も撮影時点の値を焼き込む。
  feed_id uuid not null,
  feed_title text,

  -- ── 判定結果（撮影時点の閾値に依存する導出値）──
  score double precision not null,
  reasons text[] not null default '{}',
  recommended boolean not null,

  -- 撮影時に効いていた閾値セット一式（FEED_HEALTH_THRESHOLDS + MIN_OWN_ARTICLES + PER_FEED_LIMIT）。
  -- **本テーブルの目的が閾値較正である以上、閾値は必ず変わる。** これが無いと、半年後に
  -- recommended=true を見た人が「どの閾値で立った推奨か」を復元できず、系列の前後を比較できない。
  -- jsonb なのは定数が増減しても migration を要さないため（語彙が固定の reasons とは要請が違う）。
  thresholds jsonb not null,

  -- ── シグナルの生値（撮影時点）──
  -- dead: 発信停滞の日数と、その feed の投稿間隔から出した適応閾値（YAT-70）。
  -- どちらも null = 記事が 1 件も無く算出不能（「沈黙 0 日」とは別物なので集計時に除外すること）。
  silence_days double precision,
  dead_threshold_days double precision,
  -- 新規猶予（NEW_FEED_GRACE_DAYS）の判定を後から再現するために要る。feed 削除後は
  -- feeds.created_at から復元できないので、ここに焼き込む。
  feed_age_days double precision not null,
  credibility double precision not null,
  source_pref double precision not null,

  -- near_dup_rate は null を取りうる（母数不足 / embedding 0 件）。
  -- **これは「撮影時点で DB にあった値」であって「撮影時点で算出した値」ではない。**
  -- 書き手は週次の compute-dedup-rate だけなので、cron ではその直後に撮って一致させるが、
  -- 手動実行や算出の失敗時には最大 1 週間ぶん古い。鮮度は near_dup_fresh で判別する。
  near_dup_rate double precision,
  -- この撮影と同じ run で compute-dedup-rate が成功したか。false の行の near_dup_rate は
  -- 過去の値なので較正から外すこと。observation の信頼性を行自身に持たせるという本テーブルの
  -- 方針を、要約/embed 経路（window_*）だけでなく near_dup の鮮度軸にも通す。
  near_dup_fresh boolean not null default false,

  -- near_dup_rate の**実分母** = min(窓内の embedding 付き自 feed 記事数, PER_FEED_LIMIT)。
  -- compute-dedup-rate は自 feed 側を新しい順 PER_FEED_LIMIT 件に切ってから率を出すので、
  -- 「1 記事が率をどれだけ動かすか」はこの値で読む。実数を使うと 100 超の feed で過大評価になる。
  own_articles integer not null,
  -- clamp 前の実数。near_dup_rate が null の理由（母数不足 / embedding ゼロ）の切り分けに使う。
  window_own_embedded integer not null,

  -- ── 観測の信頼性（この行を較正に使ってよいかの判断材料）──
  -- 窓内の記事総数と、うち embedding を持つ件数。比が大きく落ちていれば要約/embed 経路の
  -- 障害中に撮った観測なので較正から除外する。
  window_articles integer not null,
  window_embedded integer not null,
  -- 窓が FETCH_CAP に達して古い側を切り捨てたか。true のとき window_embedded 側だけが頭打ちに
  -- なるため、網羅率は実態より低く出る。
  window_truncated boolean not null default false,

  -- 'cron' | 'manual'。手動実行と re-run で観測点が二重に積まれるのを較正時に除外できるようにする
  -- （concurrency は直列化するだけで重複実行を防がない）。
  run_kind text not null default 'cron'
);

-- 系列読み出しは「feed ごとに時系列」と「撮影回ごとに横断」の両方をやる。
create index if not exists idx_feed_health_snapshots_feed_time
  on public.feed_health_snapshots (feed_id, captured_at desc);
create index if not exists idx_feed_health_snapshots_time
  on public.feed_health_snapshots (captured_at desc);

-- ── RLS ──────────────────────────────────────────────
-- 0001 / 0006 と同方針。anon/authenticated には SELECT のみ。
-- 書き込み（週次 cron）は service_role が RLS をバイパスするためポリシー不要。
-- 現時点で読み手はリポジトリ内に無い（較正は SQL Editor から見る）が、既存 12 テーブルと
-- 揃えて開けておく。列の内容は feeds / preferences の派生で、どちらも既に anon SELECT 可。
alter table public.feed_health_snapshots enable row level security;

drop policy if exists "read feed_health_snapshots" on public.feed_health_snapshots;
create policy "read feed_health_snapshots" on public.feed_health_snapshots
  for select to anon, authenticated using (true);
