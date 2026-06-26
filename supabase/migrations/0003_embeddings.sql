-- Phase3.5 スキーマ: embedding による重複排除（YAT-10）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 0001/0002 を壊さず追加のみ。

-- pgvector 拡張（Supabase 無料枠で利用可の標準拡張）。ここで初めて有効化する。
create extension if not exists vector;

-- ── articles に embedding 列を追加 ──────────────────────────
-- Voyage voyage-3.5-lite の 1024 次元。title+summary を embed した結果を保持する。
-- NULL = 未生成（要約前 / 生成失敗 / VOYAGE_API_KEY 未設定）。dedup では NULL を非重複扱い（fail-soft）。
alter table public.articles
  add column if not exists embedding vector(1024);

-- 近傍検索用 index（cosine）。現状の dedup は JS で計算するため必須ではないが、
-- 将来の一覧クラスタ collapse / ANN 検索のために用意しておく。
-- 部分 index（embedding 有りのみ）で無駄を省く。
create index if not exists idx_articles_embedding
  on public.articles using hnsw (embedding vector_cosine_ops)
  where embedding is not null;
