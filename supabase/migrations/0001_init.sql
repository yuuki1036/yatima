-- Phase1 スキーマ: feeds / articles
-- 適用方法: Supabase ダッシュボード > SQL Editor に貼り付けて実行
--           （または supabase CLI: supabase db push）

create extension if not exists pgcrypto; -- gen_random_uuid() 用

-- ── feeds: 購読フィード ────────────────────────────────
create table if not exists public.feeds (
  id              uuid primary key default gen_random_uuid(),
  url             text not null unique,         -- フィード URL
  title           text,
  site_url        text,                          -- サイト本体 URL
  active          boolean not null default true,
  last_fetched_at timestamptz,
  created_at      timestamptz not null default now()
);

-- ── articles: 記事 ────────────────────────────────────
create table if not exists public.articles (
  id            uuid primary key default gen_random_uuid(),
  feed_id       uuid not null references public.feeds(id) on delete cascade,
  guid          text not null,                   -- RSS の guid/id（重複排除キー）
  url           text,
  title         text,
  author        text,
  content_html  text,
  summary       text,                            -- Phase2: AI 日本語要約の空き枠
  published_at  timestamptz,
  fetched_at    timestamptz not null default now(),
  is_read       boolean not null default false,
  is_starred    boolean not null default false,
  unique (feed_id, guid)                         -- 同一フィード内の重複をスキップ
);

create index if not exists idx_articles_published_at on public.articles (published_at desc);
create index if not exists idx_articles_feed_id      on public.articles (feed_id);
create index if not exists idx_articles_is_read      on public.articles (is_read);

-- ── RLS ──────────────────────────────────────────────
-- 自分専用。anon には SELECT のみ許可（公開 read）。
-- 書き込み（cron / Server Actions）は service_role キーが RLS をバイパスするためポリシー不要。
alter table public.feeds    enable row level security;
alter table public.articles enable row level security;

-- create policy は非冪等（再実行で 42710）。drop if exists を前置して再適用可能にする。
drop policy if exists "read feeds"    on public.feeds;
drop policy if exists "read articles" on public.articles;
create policy "read feeds"    on public.feeds    for select to anon, authenticated using (true);
create policy "read articles" on public.articles for select to anon, authenticated using (true);
