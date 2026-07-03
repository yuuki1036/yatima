import { isTagSlug, type TagSlug } from "@/lib/tags/vocabulary";

// YAT-27: concept 正規化の SSoT（F3）。弱点マップの軸（topic_mastery の PK）が自由生成 concept で
// 分散するのを、vocabulary.ts の coerceTags と同じ「後処理で矯正」思想で抑える。generate-quiz が
// 既存 concept 候補を LLM に提示（再利用を促す）し、quiz-gate が insert 前に本モジュールで slug 化
// ＋category 矯正を決定的に行う。表記ゆれ（"React Hooks"/"react-hooks"/"react_hooks"）を 1 slug に畳む。

// concept_label を決定的に slug 化する。小文字化・空白/区切りをハイフンに・記号を除去する。
// 英数と `-` に加え、日本語（ひらがな/カタカナ/漢字）は識別子として残す（純英数化すると和文
// concept が空 slug に潰れて全て同一キーに衝突するため）。正規化後が空なら "" を返し、呼び出し側が
// 無効 concept として弾く。
export function conceptSlug(label: string): string {
  return label
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_/]+/g, "-") // 空白・アンダースコア・スラッシュ → ハイフン
    // 英数・ひらがな(3040-309f)・カタカナ(30a0-30ff)・CJK 漢字(4e00-9fff)・ハイフン以外を除去
    .replace(/[^a-z0-9぀-ゟ゠-ヿ一-鿿-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// LLM が付けた category を vocabulary の固定 leaf に矯正する（F5・写像 SSoT）。
// 既知の leaf slug ならそのまま、未知なら fallback（＝生成時に選んだカテゴリ）に倒す。
// 生成時に列へ固定するため、以降 mastery/UI はこの列を信頼して再解決しない。
export function coerceCategory(raw: unknown, fallback: TagSlug): TagSlug {
  if (typeof raw === "string" && isTagSlug(raw)) return raw;
  return fallback;
}
