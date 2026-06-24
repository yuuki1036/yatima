// 固定階層タグ語彙の SSoT（Single Source of Truth）。
// LLM はここに定義した leaf slug からのみタグを選ぶ。語彙を固定する理由:
// 自由生成だとタグが分散して嗜好スコアが希薄化し機能しなくなる（先行事例 mkj の運用課題）。
//
// 重要: supabase/migrations/0002_curation.sql の tags seed と slug/label/parent を一致させること。

export type TagCategory = { slug: string; label: string };
export type TagLeaf = { slug: string; label: string; parent: string | null };

// 大分類（tags テーブルの parent 行）。表示・将来の階層 UI 用。
export const TAG_CATEGORIES: readonly TagCategory[] = [
  { slug: "tech", label: "テック" },
  { slug: "science", label: "科学" },
  { slug: "business", label: "ビジネス" },
  { slug: "society", label: "社会" },
  { slug: "culture", label: "カルチャー" },
  { slug: "life", label: "ライフ" },
] as const;

// leaf タグ。LLM はこの slug 集合からのみ選ぶ。スコアリングの単位もこの leaf。
export const TAG_LEAVES = [
  { slug: "tech/ai", label: "AI・機械学習", parent: "tech" },
  { slug: "tech/web", label: "Web・フロントエンド", parent: "tech" },
  { slug: "tech/programming", label: "プログラミング", parent: "tech" },
  { slug: "tech/infra", label: "インフラ・クラウド", parent: "tech" },
  { slug: "tech/security", label: "セキュリティ", parent: "tech" },
  { slug: "tech/data", label: "データ・DB", parent: "tech" },
  { slug: "tech/hardware", label: "ハードウェア", parent: "tech" },
  { slug: "tech/mobile", label: "モバイル", parent: "tech" },
  { slug: "science/space", label: "宇宙", parent: "science" },
  { slug: "science/bio", label: "生物・医療", parent: "science" },
  { slug: "science/physics", label: "物理・数学", parent: "science" },
  { slug: "science/climate", label: "気候・環境", parent: "science" },
  { slug: "business/startup", label: "スタートアップ", parent: "business" },
  { slug: "business/finance", label: "金融・経済", parent: "business" },
  { slug: "business/bigtech", label: "大手テック企業", parent: "business" },
  { slug: "society/politics", label: "政治", parent: "society" },
  { slug: "society/policy", label: "政策・規制", parent: "society" },
  { slug: "culture/media", label: "メディア・娯楽", parent: "culture" },
  { slug: "culture/art", label: "アート・デザイン", parent: "culture" },
  { slug: "life/health", label: "健康", parent: "life" },
  { slug: "life/career", label: "キャリア・働き方", parent: "life" },
  { slug: "life/productivity", label: "生産性・ツール", parent: "life" },
  { slug: "other", label: "その他", parent: null },
] as const satisfies readonly TagLeaf[];

// 固定語彙のリテラルユニオン型。coerce 後はコンパイル時に不正タグが排除される。
export type TagSlug = (typeof TAG_LEAVES)[number]["slug"];

const TAG_SET = new Set<string>(TAG_LEAVES.map((t) => t.slug));
const LABEL_BY_SLUG = new Map<string, string>(
  TAG_LEAVES.map((t) => [t.slug, t.label]),
);

export function isTagSlug(s: string): s is TagSlug {
  return TAG_SET.has(s);
}

// slug → 表示用日本語ラベル（未知 slug はそのまま返す）
export function tagLabel(slug: string): string {
  return LABEL_BY_SLUG.get(slug) ?? slug;
}

// LLM 出力（unknown）を語彙内 leaf のみに正規化する。
// 配列でない・語彙外・重複は捨て、最大 max 件に切り詰める。sanitizeSummary と同じ「後処理で矯正」思想。
export function coerceTags(raw: unknown, max = 3): TagSlug[] {
  if (!Array.isArray(raw)) return [];
  const out: TagSlug[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    if (isTagSlug(v) && !out.includes(v)) out.push(v);
    if (out.length >= max) break;
  }
  return out;
}

// LLM プロンプトに列挙する語彙文字列（"tech/ai (AI・機械学習), ..."）
export const TAG_VOCAB_PROMPT = TAG_LEAVES.map(
  (t) => `${t.slug} (${t.label})`,
).join(", ");
