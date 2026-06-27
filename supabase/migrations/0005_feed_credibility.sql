-- フィードごとの静的な信頼度（ソース信頼度）。
-- スコア式の欠けていた項を補う: score = 新しさ + タグ嗜好 + ソース嗜好 + credibility。
-- 用途は2つ — ①要約予算（毎時20件）を信頼ソースへ優先配分 ②デッキ選定での加点/減点。
-- feed が増えてノイズ源（汎用アグリゲータ等）が候補に混ざるようになったための厳選レバー。
-- 値はあくまで初期の手当て。フィードバック学習（preferences kind='source'）と足し合わさるので、
-- 運用しながら調整する前提のゆるい prior とする。スケールは recency(0〜1) と同じオーダーに合わせ、
-- コールドスタート時に並びを動かしつつ、学習が進めば嗜好に主役を譲る大きさにしてある。
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）または SQL Editor に貼り付け。
-- 冪等: 列追加は if not exists、値は url 一致の update のみ（未知の url は default 0 のまま）。

alter table public.feeds
  add column if not exists credibility double precision not null default 0;

update public.feeds f
set credibility = v.cred
from (values
  -- 一次情報 / フロンティアラボ・研究機関の公式（最優先）
  ('https://export.arxiv.org/rss/cs.AI', 1.5),
  ('https://openai.com/news/rss.xml', 1.5),
  ('https://deepmind.google/blog/rss.xml', 1.5),
  ('https://research.google/blog/rss/', 1.5),
  ('https://bair.berkeley.edu/blog/feed.xml', 1.5),
  ('https://tim-hilde.github.io/anthropic-rss/rss.xml', 1.5),
  ('https://importai.substack.com/feed', 1.5),
  ('https://magazine.sebastianraschka.com/feed', 1.5),
  -- 質の高い研究ブログ / 個人の専門家・キュレーション
  ('https://mistral.ai/rss.xml', 1.0),
  ('https://huggingface.co/blog/feed.xml', 1.0),
  ('https://papers.takara.ai/api/feed', 1.0),
  ('https://tech.preferred.jp/ja/blog/feed/', 1.0),
  ('https://www.microsoft.com/en-us/research/feed/', 1.0),
  ('https://www.latent.space/feed', 1.0),
  ('https://simonwillison.net/atom/entries/', 1.0),
  ('https://www.technologyreview.com/topic/artificial-intelligence/feed/', 0.8),
  -- AI/ML を絞った技術メディア・トピックフィード
  ('https://zenn.dev/topics/ai/feed', 0.5),
  ('https://zenn.dev/topics/llm/feed', 0.5),
  ('https://zenn.dev/topics/%E7%94%9F%E6%88%90ai/feed', 0.5),
  ('https://zenn.dev/topics/machinelearning/feed', 0.5),
  ('https://cloudblog.withgoogle.com/ja/rss/', 0.5),
  ('https://rss.itmedia.co.jp/rss/2.0/aiplus.xml', 0.5),
  ('https://blog.g-gen.co.jp/feed', 0.5),
  -- 汎用テック寄り（AI 特化でない / PR 寄り）はやや控えめ
  ('https://www.publickey1.jp/atom.xml', 0.3),
  ('https://xtech.nikkei.com/rss/xtech-it.rdf', 0.3),
  ('https://www.techno-edge.net/rss20/index.rdf', 0.3),
  -- 汎用アグリゲータ / 高ボリューム・低シグナル源は減点（厳選の主目的）
  ('https://b.hatena.ne.jp/q/AI?mode=rss&sort=recent&users=50', -0.3),
  ('https://venturebeat.com/category/ai/feed/', -0.3),
  ('https://hnrss.org/frontpage', -0.5),
  ('https://dev.to/feed/tag/ai', -0.5),
  ('https://b.hatena.ne.jp/hotentry/it.rss', -0.8)
) as v(url, cred)
where f.url = v.url;
