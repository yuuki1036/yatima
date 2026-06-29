-- feed ごとの「重複量産率」: その feed の直近記事が他 feed 記事と embedding 近重複
-- (cosine >= 0.86) になる割合。削除推奨（YAT-20）の near-dup シグナルに使う派生値。
-- 週次 cron（npm run compute-dedup-rate, learn.yml）が active feed を走査して書き込む。
-- ページ表示時に pgvector NN を叩かず、この事前算出値を読むだけにするための列。
-- null = 未算出（初回 cron 前 / embedding を持つ記事が 0 件の feed）。スコアリングでは
-- null をフラグ false 扱いにするので安全側に倒れる。
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）または SQL Editor に貼り付け。
-- 冪等: 列追加は if not exists のみ。

alter table public.feeds
  add column if not exists near_dup_rate double precision;
