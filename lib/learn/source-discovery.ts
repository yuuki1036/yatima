import type { SupabaseClient } from "@supabase/supabase-js";
import { type TagSlug, tagLabel } from "@/lib/tags/vocabulary";
import {
  createSourceProposer,
  PROPOSE_COUNT,
  type SourceProposer,
} from "@/lib/llm/propose-sources";
import {
  fetchAndExtractArticle,
  extractedTextLength,
} from "@/lib/net/fetch-article";
import { normalizeUrl } from "@/lib/net/normalize-url";

// YAT-32: 学習ソースの発見＝「LLM 提案 → 決定的検証ゲート → learn_sources(pending) へ upsert」。
// LLM 出力は信じず、URL 正規化・重複排除・SSRF 付き fetch・本文抽出・最小長を通ったものだけ積む
// （幻覚 URL/リンク切れ/ナビだけの薄いページはここで死ぬ）。承認は人が別途行う（reviewLearnSource）。

// 抽出本文（タグ除去後テキスト）がこの長さ未満なら「薄い＝学習素材に不適」として捨てる。
const MIN_SOURCE_TEXT_CHARS = 500;
// 並列 fetch のチャンクサイズ（maxDuration=60 内に収める。enrich と同値）。
const FETCH_CONCURRENCY = 4;

export type DiscoverLearnSourcesResult = {
  proposed: number; // LLM が返した候補数
  validated: number; // 検証（正規化＋重複除外＋fetch＋最小長）を通過した数
  inserted: number; // upsert で新規に積んだ数（既存 URL は ignoreDuplicates で除外）
  skipped: boolean; // ANTHROPIC_API_KEY 未設定で提案スキップ
};

type PendingRow = {
  url: string;
  title: string | null;
  content_html: string;
  category: TagSlug;
  status: "pending";
  proposed_by: "llm";
  rationale: string | null;
};

// カテゴリの学習ソースを発見して pending で積む。生成の素材は承認済みのみが対象なので、ここでは
// pending までを作る（承認 UI が approved に倒す）。
export async function discoverLearnSources(
  supabase: SupabaseClient,
  opts: {
    category: TagSlug;
    count?: number;
    hint?: string; // 任意の sub-topic 絞り込み（例「TypeScript, React」）。粗いカテゴリを steer する
    proposer?: SourceProposer | null;
  },
): Promise<DiscoverLearnSourcesResult> {
  const result: DiscoverLearnSourcesResult = {
    proposed: 0,
    validated: 0,
    inserted: 0,
    skipped: false,
  };

  const proposer =
    opts.proposer !== undefined ? opts.proposer : createSourceProposer();
  if (!proposer) {
    result.skipped = true;
    return result;
  }

  // 既存 URL（重複提案の抑制＋ローカル重複排除）。url は正規化済みで積まれる前提。
  let existingUrls: string[] = [];
  try {
    const { data, error } = await supabase
      .from("learn_sources")
      .select("url");
    if (error) throw error;
    existingUrls = (data ?? []).map((r) => r.url as string);
  } catch (e) {
    console.warn("learn_sources 既存 URL の取得に失敗（重複提案を許容して続行）:", e);
  }
  const seen = new Set(existingUrls);

  let proposals;
  try {
    proposals = await proposer.propose({
      categoryLabel: tagLabel(opts.category),
      existingUrls,
      count: opts.count ?? PROPOSE_COUNT,
      hint: opts.hint,
    });
  } catch (e) {
    console.warn("学習ソースの LLM 提案に失敗:", e);
    return result;
  }
  result.proposed = proposals.length;

  // 正規化＋重複排除（既存＋バッチ内）。ここで残った URL だけ fetch にかける。
  const candidates: { url: string; title: string; rationale: string }[] = [];
  for (const p of proposals) {
    const url = normalizeUrl(p.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    candidates.push({ url, title: p.title, rationale: p.rationale });
  }

  // 並列 fetch＋本文抽出＋最小長チェック。fail-soft（1 件の失敗で全体は止めない）。
  const rows: PendingRow[] = [];
  for (let i = 0; i < candidates.length; i += FETCH_CONCURRENCY) {
    const chunk = candidates.slice(i, i + FETCH_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map(async (c) => {
        const fetched = await fetchAndExtractArticle(c.url);
        // 理由は捨てる: LLM 提案の候補数が読めず、大半は取得失敗・薄いページで脱落するため
        // ログに出すと溢れる（enrich と違い件数が固定されない）。
        if (!fetched.ok) return null; // SSRF 弾き／取得失敗／本文空
        if (extractedTextLength(fetched.article.contentHtml) < MIN_SOURCE_TEXT_CHARS) {
          return null; // ナビだけ等の薄いページ
        }
        const row: PendingRow = {
          url: c.url,
          title: fetched.article.title ?? (c.title || null),
          content_html: fetched.article.contentHtml,
          category: opts.category,
          status: "pending",
          proposed_by: "llm",
          rationale: c.rationale || null,
        };
        return row;
      }),
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) rows.push(s.value);
    }
  }
  result.validated = rows.length;
  if (rows.length === 0) return result;

  // upsert(onConflict:"url", ignoreDuplicates) で並行実行・再提案の URL 衝突を吸収する（YAT-16 と同作法）。
  const { data, error } = await supabase
    .from("learn_sources")
    .upsert(rows, { onConflict: "url", ignoreDuplicates: true })
    .select("id");
  if (error) {
    console.warn("learn_sources への登録に失敗:", error);
    return result;
  }
  result.inserted = (data ?? []).length;
  return result;
}
