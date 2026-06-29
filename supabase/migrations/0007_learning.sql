-- 0007_learning.sql — 学習 Module① カード候補（YAT-17）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 0001〜0006 を壊さず追加のみ。
-- cards / card_reviews（FSRS 状態・復習ログ）は YAT-18 スコープのため本 migration には含めない。

-- pgvector は 0003 で有効化済みだが、ダッシュボードに 0007 単独を貼る運用でも壊れないよう冪等に再宣言する。
create extension if not exists vector;

-- ── card_candidates: 承認待ちの学習カード候補（feed_candidates と同型の承認キュー）──────
-- read 済み・useful な記事から LLM で生成したカードを直接本番に入れず、いったんここで人手承認を
-- 待たせる。grounding 照合 + 形式検証 + dedup の機械フィルタ（LLM 不要・決定的）を通過した候補
-- だけを積む。承認時に status=approved へ倒す（cards への昇格は YAT-18）。誤生成を本番に混ぜない。
-- 行は status 不問で永続させ、embedding を dedup 母集団として兼ねる（YAT-16 と同じ「候補は消さず
-- status で管理」）。
create table if not exists public.card_candidates (
  id             uuid primary key default gen_random_uuid(),
  article_id     uuid references public.articles(id) on delete cascade, -- 由来記事。記事削除で候補も消す
  type           text not null,                     -- 'qa' | 'cloze'
  front          text,                              -- qa 用（設問）
  back           text,                              -- qa 用（解答）
  cloze_text     text,                              -- cloze 用（{{c1::...}} 構文）
  source_quote   text not null,                     -- grounding 根拠（原文の逐語抜粋）
  concept_tag    text,                              -- 概念ラベル（任意）
  -- dedup 母集団用。articles.embedding と同じ Voyage 1024 次元（0003_embeddings.sql）。
  -- 全 status で残し、JS cosine（lib/ranking/dedup.ts）の近重複判定に使う。
  embedding      vector(1024),
  dup_flag       boolean not null default false,    -- 近重複フラグ。自動 reject せず承認 UI で畳む
  dup_similarity real,                              -- 最も近い既存候補との cosine（運用較正用）
  status         text not null default 'pending',   -- pending → approved / rejected
  created_at     timestamptz not null default now(),
  constraint card_candidates_status_chk
    check (status in ('pending', 'approved', 'rejected')),
  constraint card_candidates_type_chk
    check (type in ('qa', 'cloze'))
);

-- 承認 UI は pending を新しい順で出す。
create index if not exists idx_card_candidates_status
  on public.card_candidates (status, created_at desc);
-- 未カード化判定（card-gate が既存候補の article_id 集合を引く）と FK 整合の高速化。
create index if not exists idx_card_candidates_article
  on public.card_candidates (article_id);

-- ── RLS ──────────────────────────────────────────────
-- 0001 / 0006 と同方針。anon/authenticated には SELECT のみ。
-- 書き込み（週次 cron / 承認 Server Action）は service_role が RLS をバイパスするためポリシー不要。
alter table public.card_candidates enable row level security;

drop policy if exists "read card_candidates" on public.card_candidates;
create policy "read card_candidates" on public.card_candidates
  for select to anon, authenticated using (true);
