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
};

// 一覧表示でフィード名を添えるための結合型
export type ArticleWithFeed = Article & {
  feeds: Pick<Feed, "title" | "site_url"> | null;
};
