-- 要約の消費台帳と日次上限のための列（YAT-74）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 冪等: 列追加は if not exists、index も if not exists。
-- 0001〜0015 を壊さず追加のみ（既存行は触らない＝backfill しない。理由は下記）。
--
-- 背景: 2026-08-19 に Anthropic のクレジットが尽きて要約が 18 日止まった。事故の構造は 2 段:
--   1. 支出に天井が無い。1 run 20 件（DEFAULT_LIMIT）の上限はあるが、run をまたぐ上限が無く、
--      cron の実発火が 2〜23 回/日 で 10 倍振れるため日次消費は 40〜460 件と制御不能だった
--   2. 消費の一次情報が Anthropic コンソールにしか無く、プロジェクト側から
--      「今日いくら使ったか」を観測できなかった
-- この列は両方に効く。summary が書かれた瞬間を記録するので、
--   - 日次の要約件数 = その日の LLM 呼び出し成功数（= 消費の代理指標）
--   - 「今日あと何件やってよいか」を run をまたいで数えられる
--
-- なぜ articles の列で、専用の台帳テーブルでないか: 要約は articles.summary と 1 対 1 で、
-- 別テーブルにすると「summary はあるが台帳に無い」ドリフト経路を作る。列なら原理的にズレない。
--
-- なぜ backfill しないか: 既存の 16,760 件は「いつ要約したか」を復元できない
-- （created_at は記事の取り込み時刻であって要約時刻ではない）。推測で埋めると台帳が嘘をつく。
-- NULL = 「この列の導入前に要約された」であって「要約されていない」ではない。
-- 日次集計は summarized_at >= 当日 で引くので、NULL 行は自然に集計外になる。

alter table public.articles
  add column if not exists summarized_at timestamptz;

-- 日次上限の判定は「今日の summarized_at の件数」を毎 run 引くので、時刻の範囲検索が要る。
-- 部分 index（非 NULL のみ）にするのは、導入直後は大半が NULL で index が無駄に太るため。
create index if not exists idx_articles_summarized_at
  on public.articles (summarized_at desc)
  where summarized_at is not null;
