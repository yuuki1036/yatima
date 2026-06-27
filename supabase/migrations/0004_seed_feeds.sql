-- AI/技術/研究系フィードの初期投入。
-- 出典: mkj/Zenn「AI系情報収集手法 2025年版」を参考に抽出。
--   Anthropic は公式 RSS が無いため claude.com/blog の非公式ミラーを採用。
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 冪等: url の unique 制約に対し on conflict do nothing。既存フィードは触らない。
-- 全 URL は実取得で生存確認済み（2026-06-27）。

insert into public.feeds (url) values
  -- 日本語テック / AI メディア
  ('https://rss.itmedia.co.jp/rss/2.0/aiplus.xml'),               -- ITmedia AI＋
  ('https://b.hatena.ne.jp/hotentry/it.rss'),                     -- はてブ 人気エントリー（テクノロジー）
  ('https://b.hatena.ne.jp/q/AI?mode=rss&sort=recent&users=50'),  -- はてブ タグ「AI」（新着・50users 以上）
  ('https://xtech.nikkei.com/rss/xtech-it.rdf'),                  -- 日経XTECH IT
  ('https://www.techno-edge.net/rss20/index.rdf'),                -- テクノエッジ
  ('https://blog.g-gen.co.jp/feed'),                              -- G-gen Tech Blog
  -- Zenn トピック（AI/ML を厳選。生成ai は日本語 slug を URL エンコード）
  ('https://zenn.dev/topics/ai/feed'),                            -- Zenn: AI
  ('https://zenn.dev/topics/llm/feed'),                           -- Zenn: LLM
  ('https://zenn.dev/topics/%E7%94%9F%E6%88%90ai/feed'),          -- Zenn: 生成AI
  ('https://zenn.dev/topics/machinelearning/feed'),              -- Zenn: 機械学習
  -- クラウド公式
  ('https://cloudblog.withgoogle.com/ja/rss/'),                   -- Google Cloud Blog（日本語）
  -- 研究論文 / 研究ブログ
  ('https://export.arxiv.org/rss/cs.AI'),                         -- arXiv cs.AI（1日50件規模・量多め）
  ('https://papers.takara.ai/api/feed'),                          -- Hugging Face Daily Papers（非公式・takara.ai／リダイレクト追従が必要）
  ('https://bair.berkeley.edu/blog/feed.xml'),                    -- BAIR Blog（少量・高品質）
  -- AI 企業 / 研究所の公式ブログ（Anthropic のみ公式 RSS 無し → claude.com/blog の非公式ミラー）
  ('https://openai.com/news/rss.xml'),                            -- OpenAI News
  ('https://research.google/blog/rss/'),                          -- Google Research
  ('https://www.microsoft.com/en-us/research/feed/'),             -- Microsoft Research
  ('https://mistral.ai/rss.xml'),                                 -- Mistral AI
  ('https://deepmind.google/blog/rss.xml'),                       -- Google DeepMind（件数多め）
  ('https://huggingface.co/blog/feed.xml'),                       -- Hugging Face Blog（全履歴 500 件超のため初回は大量流入）
  ('https://tim-hilde.github.io/anthropic-rss/rss.xml')           -- Anthropic / Claude Blog（非公式・第三者運用）
on conflict (url) do nothing;

-- 任意枠は本 migration に含めない。件数が多く CORE と内容が重複しやすいうえ、
-- 要約(Haiku)/embedding(Voyage) は cron 1 回あたりの処理件数に上限があり、入れすぎると未要約記事が滞留する。
-- 追加するときは別 migration（0005_seed_feeds_extra.sql 等）を新設して npm run migrate する。
-- 候補: Zenn deeplearning/nlp/python/googlecloud, Google Cloud Blog（英語）, arXiv cs.CL/cs.LG。
