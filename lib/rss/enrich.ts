import type { SupabaseClient } from "@supabase/supabase-js";
import { htmlToInputText } from "@/lib/llm/extract-text";
import { fetchAndExtractArticle } from "@/lib/net/fetch-article";

// 本文が薄い記事（HN 等、RSS の content_html がメタ情報だけ）について、リンク先 URL から
// 本文を取得して content_html を差し替える。要約・タグの入力を実本文にし、憶測（ハルシ
// ネーション）を減らすのが狙い。
// 設計: summary 未生成の記事だけを対象に annotate の前で1回だけ試行。失敗は fail-soft で
// 元の content_html を温存（要約は薄い本文からでも継続できる）。全文配信フィードは本文が
// 十分あるので「薄い」判定で自然に除外される。

export const THIN_BODY_CHARS = 300; // htmlToInputText 後がこれ未満なら「薄い」= 本文取得を試みる
const DEFAULT_LIMIT = 20; // 1 実行で取得する上限（cron の負荷とコストを抑える）
const DEFAULT_CONCURRENCY = 4;

export type EnrichResult = {
  thin: number; // 本文が薄く取得対象になった件数
  enriched: number; // 取得して差し替えた件数
  failed: number; // 取得失敗（fail-soft で元のまま）
};

type Row = { id: string; url: string | null; content_html: string | null };

// 本文が薄いかの判定（呼び出し側が enrich 対象を絞るための共通基準）。
export function isThinBody(content: string | null): boolean {
  return htmlToInputText(content).length < THIN_BODY_CHARS;
}

// 1 記事の本文をリンク先から取得して content_html を差し替える。差し替えたら新しい
// content_html を、URL 無し・SSRF ガードで弾かれた・取得本文が元と同等以下なら null を返す
// （呼び出し側が成否を判定）。
// enrichMissingBodies（要約前バッチ）と再アノテート（YAT-13）の両方から再利用する。
export async function enrichArticleBody(
  supabase: SupabaseClient,
  row: Row,
): Promise<string | null> {
  if (!row.url) return null;
  // row.url は feed の記事リンク（第三者由来）。SSRF ガード＋fetch＋本文抽出は共通処理に委譲する
  // （弾かれた／取得失敗は null。source-discovery と同じ一次防御・抽出を共有）。
  const fetched = await fetchAndExtractArticle(row.url);
  if (!fetched) return null;
  const content = fetched.contentHtml;
  // 取得本文が元より十分長いときだけ差し替える（薄い→薄いは無意味）。
  if (
    htmlToInputText(content).length <= htmlToInputText(row.content_html).length
  ) {
    return null;
  }
  const { error } = await supabase
    .from("articles")
    .update({ content_html: content })
    .eq("id", row.id);
  if (error) throw error;
  return content;
}

export async function enrichMissingBodies(
  supabase: SupabaseClient,
  opts: { limit?: number; concurrency?: number } = {},
): Promise<EnrichResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;

  let rows: Row[] = [];
  try {
    const { data, error } = await supabase
      .from("articles")
      .select("id, url, content_html")
      .is("summary", null)
      .not("url", "is", null)
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    rows = (data ?? []) as Row[];
  } catch (e) {
    console.warn("本文取得対象の取得に失敗:", e);
    return { thin: 0, enriched: 0, failed: 0 };
  }

  // 本文が薄いものだけ対象に絞る（全文配信フィードはここで除外される）。
  const targets = rows.filter((r) => r.url && isThinBody(r.content_html));

  let enriched = 0;
  let failed = 0;
  for (let i = 0; i < targets.length; i += concurrency) {
    const chunk = targets.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map(async (row) => {
        const content = await enrichArticleBody(supabase, row);
        // null は「本文が元と同等以下」「SSRF ガードでスキップ」「取得失敗」を含む。
        // 理由を断定しない文言にする。
        if (!content) throw new Error("本文を差し替えなかった（薄い/スキップ）");
      }),
    );
    results.forEach((r, idx) => {
      if (r.status === "fulfilled") {
        enriched += 1;
      } else {
        failed += 1;
        const reason =
          r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.warn(`本文取得失敗 [${chunk[idx].id}] ${chunk[idx].url}: ${reason}`);
      }
    });
  }

  return { thin: targets.length, enriched, failed };
}
