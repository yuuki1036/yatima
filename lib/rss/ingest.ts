import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAndParse, type ParsedItem } from "./parser";

// 取得→保存のコアロジック。SupabaseClient を引数で受け取り、
// cron スクリプト・Server Action・Route Handler のどこからでも注入して使える。

export type IngestResult = {
  feedId: string;
  feedUrl: string;
  inserted: number;
  error?: string;
};

type FeedRow = { id: string; url: string; title: string | null };

// 1 フィードを取得して articles に upsert する
async function ingestOneFeed(
  supabase: SupabaseClient,
  feed: FeedRow,
): Promise<IngestResult> {
  try {
    const parsed = await fetchAndParse(feed.url);

    const rows = (parsed.items ?? [])
      .map((item: ParsedItem) => ({
        feed_id: feed.id,
        // 重複排除キー: guid > link の順で最初に存在するものを採用
        guid: item.guid ?? item.link ?? "",
        url: item.link ?? null,
        title: item.title ?? null,
        author: item.creator ?? null,
        content_html:
          ((item as Record<string, unknown>)["content:encoded"] as
            | string
            | undefined) ??
          item.content ??
          null,
        published_at: item.isoDate ?? null,
      }))
      .filter((r) => r.guid !== "");

    let inserted = 0;
    if (rows.length > 0) {
      // (feed_id, guid) 衝突は無視 → 既存記事は触らず新規のみ挿入
      const { data, error } = await supabase
        .from("articles")
        .upsert(rows, { onConflict: "feed_id,guid", ignoreDuplicates: true })
        .select("id");
      if (error) throw error;
      inserted = data?.length ?? 0;
    }

    // フィードのメタ情報補完 + 取得時刻の更新
    await supabase
      .from("feeds")
      .update({
        last_fetched_at: new Date().toISOString(),
        title: feed.title ?? parsed.title ?? null,
        site_url: parsed.link ?? null,
      })
      .eq("id", feed.id);

    return { feedId: feed.id, feedUrl: feed.url, inserted };
  } catch (e) {
    return {
      feedId: feed.id,
      feedUrl: feed.url,
      inserted: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// active な全フィードを順に取得して保存する
export async function ingestAllFeeds(
  supabase: SupabaseClient,
): Promise<IngestResult[]> {
  const { data: feeds, error } = await supabase
    .from("feeds")
    .select("id, url, title")
    .eq("active", true);
  if (error) throw error;
  if (!feeds || feeds.length === 0) return [];

  const results: IngestResult[] = [];
  for (const feed of feeds as FeedRow[]) {
    results.push(await ingestOneFeed(supabase, feed));
  }
  return results;
}
