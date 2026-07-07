// DB テーブルと 1:1 対応する型。Phase2 以降で summary/embedding を埋めていく。

export type Feed = {
  id: string;
  url: string;
  title: string | null;
  site_url: string | null;
  active: boolean;
  last_fetched_at: string | null;
  created_at: string;
  credibility: number; // 静的なソース信頼度 prior（YAT-14, 0005）
  near_dup_rate: number | null; // 他 feed との重複量産率（YAT-20, 0008。null=未算出）
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

// YAT-17: 学習カードの承認待ち候補（feed_candidates と同型）。記事から LLM 生成 → grounding/
// 形式/dedup の機械フィルタを通過した候補を pending で積む。承認で status=approved に倒す
// （cards への昇格は YAT-18）。却下は行を残し rejected（dedup 母集団＝全 status を維持）。
export type CardCandidate = {
  id: string;
  article_id: string | null; // on delete cascade（記事削除で候補も消える）
  type: "qa" | "cloze";
  front: string | null; // qa 用（設問）
  back: string | null; // qa 用（解答）
  cloze_text: string | null; // cloze 用（{{c1::...}}）
  source_quote: string; // grounding 根拠（原文の逐語抜粋）
  concept_tag: string | null;
  // embedding 列は dedup 母集団用で UI/型には出さない（FeedCandidate と同様に内部列は型から省く）。
  dup_flag: boolean;
  dup_similarity: number | null;
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
  is_starred: boolean; // 「後で読む」お気に入り。デッキから★トグルで付け外しする
};

// ── YAT-27: 適応クイズ ─────────────────────────────────────

export type QuizDifficulty = "easy" | "medium" | "hard";

// 出題1問（quiz_questions の serving 形）。即時採点のため answer_index / explanation も client へ渡す
// （自分専用アプリで正解を隠す必要はなく、往復なしで採点・解説を出せる利点を採る）。
export type QuizQuestion = {
  id: string;
  concept_key: string;
  concept_label: string;
  category: string; // vocabulary の leaf（tech/* 等）
  difficulty: QuizDifficulty;
  stem: string;
  choices: string[]; // 選択肢4件
  answer_index: number; // 正解の 0-based index
  explanation: string;
  source_quote: string | null; // grounding 根拠（grounded=false なら null）
  grounded: boolean;
  source_ref: string | null; // 由来 id（article_id または learn_sources.id。YAT-32 で後者が主）
};

// YAT-32: 学習クイズの知識ソース（承認制 evergreen）。LLM 提案 → 検証ゲート → 人が承認した
// 公式 docs / 定番解説を生成素材にする。content_html は本文抽出済み（生成・grounding の母体）。
// embedding 列は将来の RAG 編入用に予約せず、まず学習用途に限定する（design 20260707）。
export type LearnSource = {
  id: string;
  url: string; // 正規化済み URL（重複排除キー）
  title: string | null;
  content_html: string | null; // 本文抽出済み HTML
  category: string; // tech/* leaf
  status: "pending" | "approved" | "rejected";
  proposed_by: "llm" | "manual";
  rationale: string | null; // LLM の提案理由（承認の判断材料）
  last_generated_at: string | null; // 生成 LRU ローテーション用
  created_at: string;
  reviewed_at: string | null;
};

// startQuizSession の戻り値（client の QuizDeck が消費）。空セッション/生成スキップは note に理由を載せる。
export type QuizSessionResult = {
  questions: QuizQuestion[];
  note: string | null;
};

// ── YAT-28: 弱点マップ ─────────────────────────────────────

// concept 単位の習熟（弱点マップの最小要素）。topic_mastery の 1 行に対応する。
export type ConceptMastery = {
  concept_key: string;
  concept_label: string;
  mastery: number; // 0..1 の EWMA 推定値
  attempts: number; // 累積回答数（信頼度の目安）
};

// tech/* カテゴリ単位の集約（弱点マップの 1 カテゴリ行）。mastery は所属 concept の単純平均。
export type CategoryMastery = {
  slug: string; // tech/* leaf
  label: string; // tagLabel 済み表示名
  mastery: number; // 所属 concept の mastery 平均（等重み）
  conceptCount: number;
  weakest: ConceptMastery[]; // mastery 昇順 上位数件（弱点 concept）
};
