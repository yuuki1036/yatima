// DB テーブルと 1:1 対応する型。Phase2 以降で summary/embedding を埋めていく。

export type Feed = {
  id: string;
  url: string;
  title: string | null;
  site_url: string | null;
  active: boolean;
  last_fetched_at: string | null;
  created_at: string;
};

// Phase4: 自動発見の承認待ち候補（YAT-16）。承認で feeds へ昇格する。
export type FeedCandidate = {
  id: string;
  url: string;
  title: string | null;
  site_url: string | null;
  source_domain: string;
  discovered_from: string | null;
  credibility: number;
  status: "pending" | "approved" | "rejected";
  created_at: string;
};

export type Article = {
  id: string;
  feed_id: string;
  guid: string;
  url: string | null;
  title: string | null;
  author: string | null;
  content_html: string | null;
  summary: string | null; // Phase2: AI 日本語要約
  published_at: string | null;
  fetched_at: string;
  is_read: boolean;
  is_starred: boolean;
  score: number | null; // Phase3: キュレーション確定時のスコア（表示順に使用）
  picked_date: string | null; // Phase3: 「今日の10件」確定日（YYYY-MM-DD, JST）
};

// 一覧表示でフィード名を添えるための結合型
export type ArticleWithFeed = Article & {
  feeds: Pick<Feed, "title" | "site_url"> | null;
};

// ── Phase3: タグ / 嗜好 / フィードバック ──────────────────────

export type Tag = {
  slug: string;
  label: string;
  parent: string | null;
  sort_order: number;
  created_at: string;
};

export type ArticleTag = {
  article_id: string;
  tag_slug: string;
  source: string;
  created_at: string;
};

// 嗜好スコアの汎用 KV（kind='tag' / 将来 'source' / 'source_tag'）
export type Preference = {
  kind: string;
  key: string;
  weight: number;
  updated_at: string;
};

export type FeedbackAction = "open" | "useful" | "dismiss";

export type ArticleFeedback = {
  article_id: string;
  action: FeedbackAction;
  created_at: string;
};

// Tinder デッキ1枚分。Server Component が組み立てて Client Deck へ渡す（シリアライズ可能な平坦形）。
export type CurationCard = {
  id: string;
  title: string | null;
  summary: string | null;
  url: string | null;
  published_at: string | null;
  feedTitle: string | null;
  tags: string[]; // tag_slug の配列
};
