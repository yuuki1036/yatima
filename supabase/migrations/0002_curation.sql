-- Phase3 スキーマ: 興味順キュレーション + Tinder UI（YAT-5）
-- 適用方法: Supabase ダッシュボード > SQL Editor に貼り付けて実行
--           （または supabase CLI: supabase db push）
-- 0001 を壊さず追加のみ。articles の is_read / is_starred は温存（/list が使う）。

-- ── tags: 固定階層タグ語彙（SSoT は lib/tags/vocabulary.ts。ここは FK 用の実体）──
create table if not exists public.tags (
  slug       text primary key,                 -- 'tech/ai' 等の slug（vocabulary.ts と一致）
  label      text not null,                    -- 表示用日本語ラベル
  parent     text references public.tags(slug),-- 親 slug（大分類は null）
  sort_order int  not null default 0,
  created_at timestamptz not null default now()
);

-- ── article_tags: 記事×タグ（多対多・LLM 付与）──────────────────
create table if not exists public.article_tags (
  article_id uuid not null references public.articles(id) on delete cascade,
  tag_slug   text not null references public.tags(slug)   on delete cascade,
  source     text not null default 'llm',      -- 付与元。将来 'manual'/'rule' を足せる拡張点
  created_at timestamptz not null default now(),
  primary key (article_id, tag_slug)
);
create index if not exists idx_article_tags_tag on public.article_tags (tag_slug);

-- ── preferences: 嗜好スコア（汎用 KV。今は kind='tag'。将来 'source'/'source_tag' を同居）──
create table if not exists public.preferences (
  kind       text not null,                    -- 'tag' | 将来 'source' | 'source_tag'
  key        text not null,                    -- tag_slug / feed_id / 'feed_id|tag_slug'
  weight     double precision not null default 0,
  updated_at timestamptz not null default now(),
  primary key (kind, key)
);

-- ── article_feedback: フィードバック元帳（1記事1判定・再計算可能な台帳）──
create table if not exists public.article_feedback (
  article_id uuid primary key references public.articles(id) on delete cascade,
  action     text not null,                    -- 'open' | 'useful' | 'dismiss'
  created_at timestamptz not null default now()
);

-- ── articles に列追加: キュレーション確定枠 ─────────────────────
alter table public.articles
  add column if not exists score       double precision,  -- キュレーション確定時のスコア（表示順に使用）
  add column if not exists picked_date date;               -- 「今日の10件」確定日（NULL=未ピック）
create index if not exists idx_articles_picked_date on public.articles (picked_date);

-- ── RLS（0001 と同じ方針: anon は SELECT のみ。書き込みは service_role がバイパス）──
alter table public.tags             enable row level security;
alter table public.article_tags     enable row level security;
alter table public.preferences      enable row level security;
alter table public.article_feedback enable row level security;
create policy "read tags"             on public.tags             for select to anon, authenticated using (true);
create policy "read article_tags"     on public.article_tags     for select to anon, authenticated using (true);
create policy "read preferences"      on public.preferences      for select to anon, authenticated using (true);
create policy "read article_feedback" on public.article_feedback for select to anon, authenticated using (true);

-- ── tags seed（lib/tags/vocabulary.ts と一致させること）────────────
-- 大分類（parent = null）
insert into public.tags (slug, label, parent, sort_order) values
  ('tech',     'テック',     null, 10),
  ('science',  '科学',       null, 20),
  ('business', 'ビジネス',   null, 30),
  ('society',  '社会',       null, 40),
  ('culture',  'カルチャー', null, 50),
  ('life',     'ライフ',     null, 60)
on conflict (slug) do nothing;
-- leaf（parent あり）
insert into public.tags (slug, label, parent, sort_order) values
  ('tech/ai',            'AI・機械学習',       'tech',     11),
  ('tech/web',           'Web・フロントエンド','tech',     12),
  ('tech/programming',   'プログラミング',     'tech',     13),
  ('tech/infra',         'インフラ・クラウド', 'tech',     14),
  ('tech/security',      'セキュリティ',       'tech',     15),
  ('tech/data',          'データ・DB',         'tech',     16),
  ('tech/hardware',      'ハードウェア',       'tech',     17),
  ('tech/mobile',        'モバイル',           'tech',     18),
  ('science/space',      '宇宙',               'science',  21),
  ('science/bio',        '生物・医療',         'science',  22),
  ('science/physics',    '物理・数学',         'science',  23),
  ('science/climate',    '気候・環境',         'science',  24),
  ('business/startup',   'スタートアップ',     'business', 31),
  ('business/finance',   '金融・経済',         'business', 32),
  ('business/bigtech',   '大手テック企業',     'business', 33),
  ('society/politics',   '政治',               'society',  41),
  ('society/policy',     '政策・規制',         'society',  42),
  ('culture/media',      'メディア・娯楽',     'culture',  51),
  ('culture/art',        'アート・デザイン',   'culture',  52),
  ('life/health',        '健康',               'life',     61),
  ('life/career',        'キャリア・働き方',   'life',     62),
  ('life/productivity',  '生産性・ツール',     'life',     63),
  ('other',              'その他',             null,       99)
on conflict (slug) do nothing;
