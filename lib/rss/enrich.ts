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

// 差し替えなかった場合は理由つきで返す。呼び出し側のログが「なぜ差し替わらなかったか」を
// 語れるようにするため（[[shared-primitive-returns-reason-caller-logs]]・YAT-57）。
export type EnrichBodyResult =
  | { ok: true; content: string } // 差し替えた後の content_html
  | { ok: false; reason: string };

// 1 記事の本文をリンク先から取得して content_html を差し替える。URL 無し・SSRF ガードで
// 弾かれた・取得失敗・取得本文が元と同等以下なら ok:false を理由つきで返す。
// enrichMissingBodies（要約前バッチ）と再アノテート（YAT-13）の両方から再利用する。
export async function enrichArticleBody(
  supabase: SupabaseClient,
  row: Row,
): Promise<EnrichBodyResult> {
  if (!row.url) return { ok: false, reason: "URL が無い" };
  // row.url は feed の記事リンク（第三者由来）。SSRF ガード＋fetch＋本文抽出は共通処理に委譲する
  // （弾かれた／取得失敗は理由つきで返る。source-discovery と同じ一次防御・抽出を共有）。
  const fetched = await fetchAndExtractArticle(row.url);
  if (!fetched.ok) return { ok: false, reason: fetched.reason };
  const content = fetched.article.contentHtml;
  // 取得本文が元より十分長いときだけ差し替える（薄い→薄いは無意味）。
  const got = htmlToInputText(content).length;
  const had = htmlToInputText(row.content_html).length;
  if (got <= had) {
    return {
      ok: false,
      reason: `取得本文が元より長くない（${got} <= ${had} 文字）`,
    };
  }
  const { error } = await supabase
    .from("articles")
    .update({ content_html: content })
    .eq("id", row.id);
  if (error) throw error;
  return { ok: true, content };
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
        const result = await enrichArticleBody(supabase, row);
        // 差し替えなかった理由（取得失敗 / SSRF ガード / 本文が元と同等以下 等）をそのまま載せる。
        // 1 実行 20 件（DEFAULT_LIMIT）でログが溢れないため、ここは理由を出す価値がある（YAT-57）。
        if (!result.ok) throw new Error(`本文を差し替えなかった: ${result.reason}`);
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
