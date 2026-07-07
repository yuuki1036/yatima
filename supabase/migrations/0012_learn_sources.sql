-- 0012_learn_sources.sql — 適応クイズの知識ソース分離（YAT-32）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 0001〜0011 を壊さず追加のみ。
-- 学習クイズの生成素材を RSS 記事プール（時事ニュース）から分離し、承認制 evergreen ソース
-- （公式 docs・定番解説）専用にする（design doc 20260707-learn-evergreen-sources）。RSS プールは
-- 興味キュレーション（読む）専用、learn_sources は学習（定着）専用の二層に分ける。

-- ── learn_sources: 学習クイズの知識ソース（LLM 提案→検証ゲート→人が承認）────────────
-- url は正規化済み（scheme/host 小文字・末尾スラッシュ/www/トラッキングクエリ/フラグメント除去）
-- の一意キー。二重投入は upsert(onConflict:"url", ignoreDuplicates) で吸収する。content_html は
-- 検証 fetch 時に article-extractor で本文抽出した HTML を保存し、生成・grounding の母体にする
-- （承認時に再 fetch しない＝docs の変化は遅く staleness 許容）。last_generated_at は生成の LRU
-- ローテーション用（昇順に食い、使用後に更新＝同一ソース反復による near-dup を防ぐ）。
create table if not exists public.learn_sources (
  id                uuid primary key default gen_random_uuid(),
  url               text unique not null,              -- 正規化済み URL（重複排除キー）
  title             text,                              -- fetch 時に抽出した見出し
  content_html      text,                              -- 本文抽出済み HTML（生成・照合の母体）
  category          text not null,                     -- tech/* leaf（提案時に指定）
  status            text not null default 'pending',   -- pending | approved | rejected
  proposed_by       text not null default 'llm',       -- llm | manual（手動追加は escape hatch）
  rationale         text,                              -- LLM の提案理由（承認の判断材料）
  last_generated_at timestamptz,                       -- 生成 LRU ローテーション用
  created_at        timestamptz not null default now(),
  reviewed_at       timestamptz,                       -- 承認/却下の時刻
  constraint learn_sources_status_chk
    check (status in ('pending', 'approved', 'rejected')),
  constraint learn_sources_proposed_by_chk
    check (proposed_by in ('llm', 'manual'))
);

-- 承認キューの引き当て（status×新しい順）。承認 UI の pending 一覧。
create index if not exists idx_learn_sources_status
  on public.learn_sources (status, created_at desc);
-- 生成素材の引き当て（approved×カテゴリを LRU 順）。loadLearnSources の主クエリ。
-- last_generated_at は null 最優先で食わせたいので nulls first で並べる。
create index if not exists idx_learn_sources_generate
  on public.learn_sources (status, category, last_generated_at asc nulls first);

-- ── RLS ──────────────────────────────────────────────
-- 0011 と同方針。anon/authenticated には SELECT のみ。書き込み（提案/承認の Server Action・
-- 生成時の last_generated_at 更新）は service_role が RLS をバイパスするためポリシー不要。
alter table public.learn_sources enable row level security;

drop policy if exists "read learn_sources" on public.learn_sources;
create policy "read learn_sources" on public.learn_sources
  for select to anon, authenticated using (true);
