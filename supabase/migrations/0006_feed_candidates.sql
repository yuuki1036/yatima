-- Phase4 スキーマ: 情報源の自動発見（YAT-16）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 0001〜0005 を壊さず追加のみ。

-- ── feed_candidates: 承認待ちの発見候補フィード ──────────────────
-- 自動発見した feed を直接 feeds に入れず、いったんここで人手承認を待たせる。
-- 検証ゲート（autodiscovery → RSS パース成功で実在確認 → eTLD+1 で既存重複排除）を
-- 通過した URL だけを積む。承認時に feeds へ昇格させる（誤検出を本番取得に混ぜない）。
create table if not exists public.feed_candidates (
  id              uuid primary key default gen_random_uuid(),
  url             text not null unique,            -- 候補フィード URL（検証ゲート通過済み）
  title           text,                            -- RSS パースで得た表示名（承認 UI 用）
  site_url        text,                            -- サイト本体 URL
  source_domain   text not null,                   -- eTLD+1。既存 feeds との重複排除・候補集約キー
  discovered_from text,                            -- 発見元（方式①: リンク抽出した記事 URL）
  -- 未検証の自動発見ソースの低い初期 prior。承認時に feeds.credibility の初期値として引き継ぎ、
  -- 人手で調整する前提（[[source-credibility-prior]]）。スケールは recency(0〜1) と同オーダー。
  credibility     double precision not null default -0.3,
  status          text not null default 'pending', -- pending → approved / rejected
  created_at      timestamptz not null default now(),
  constraint feed_candidates_status_chk
    check (status in ('pending', 'approved', 'rejected'))
);

-- 承認 UI は pending を新しい順で出す。重複排除は source_domain で引く。
create index if not exists idx_feed_candidates_status
  on public.feed_candidates (status, created_at desc);
create index if not exists idx_feed_candidates_source_domain
  on public.feed_candidates (source_domain);

-- ── RLS ──────────────────────────────────────────────
-- 0001 と同方針。anon/authenticated には SELECT のみ。
-- 書き込み（週次 cron / 承認 Server Action）は service_role が RLS をバイパスするためポリシー不要。
alter table public.feed_candidates enable row level security;

drop policy if exists "read feed_candidates" on public.feed_candidates;
create policy "read feed_candidates" on public.feed_candidates
  for select to anon, authenticated using (true);
