import type { SupabaseClient } from "@supabase/supabase-js";
import type { Summarizer } from "./types";
import { createHaikuSummarizer } from "./haiku";
import { htmlToInputText } from "./extract-text";

// 取得→保存の後に呼ぶバッチ要約。ingestAllFeeds と同じく SupabaseClient を注入して使う。
// summary IS NULL の記事を拾って要約し、articles.summary を埋める。
// 設計方針: fail-soft。例外は一切外へ漏らさず集計に畳む（要約由来で ingest を止めない）。

export type SummarizeBatchResult = {
  picked: number; // summary IS NULL から取得した件数
  succeeded: number;
  failed: number;
  skipped: boolean; // API キー未設定でスキップした場合 true
};

type Row = { id: string; title: string | null; content_html: string | null };

const DEFAULT_LIMIT = 20; // 1 回の実行で要約する上限（コスト暴走を防ぐ。残りは次回消化）
const DEFAULT_CONCURRENCY = 5; // 同時並列数（レート制限に配慮）

export async function summarizeMissing(
  supabase: SupabaseClient,
  opts: {
    limit?: number;
    concurrency?: number;
    summarizer?: Summarizer | null;
  } = {},
): Promise<SummarizeBatchResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  // opts.summarizer を明示指定（null 含む）した場合はそれを尊重。未指定なら Haiku を生成。
  const summarizer =
    opts.summarizer !== undefined ? opts.summarizer : createHaikuSummarizer();

  // API キー未設定 → 要約スキップ（ingest は成功扱い）
  if (!summarizer) {
    return { picked: 0, succeeded: 0, failed: 0, skipped: true };
  }

  let rows: Row[] = [];
  try {
    const { data, error } = await supabase
      .from("articles")
      .select("id, title, content_html")
      .is("summary", null)
      .not("content_html", "is", null)
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    rows = (data ?? []) as Row[];
  } catch (e) {
    // select 失敗も握りつぶす（fail-soft）。原因だけは残して調査可能にする。
    console.warn("要約対象の取得に失敗:", e);
    return { picked: 0, succeeded: 0, failed: 0, skipped: false };
  }

  let succeeded = 0;
  let failed = 0;

  // limit 件を concurrency ずつ Promise.allSettled で回す軽量プール
  for (let i = 0; i < rows.length; i += concurrency) {
    const chunk = rows.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map(async (row) => {
        const text = htmlToInputText(row.content_html);
        // 本文がタグのみ等で整形後に空でも、タイトルがあれば要約する。
        // 両方空の記事を failed で NULL のまま残すと、毎回 published_at 降順の
        // 先頭枠に再ピックされ後続が処理されなくなるため、ここで救済する。
        if (!text && !row.title) throw new Error("本文・タイトルとも空");
        const summary = await summarizer.summarize({ title: row.title, text });
        if (!summary) throw new Error("要約が空"); // 空要約は保存せず NULL のまま再試行に回す
        const { error } = await supabase
          .from("articles")
          .update({ summary })
          .eq("id", row.id);
        if (error) throw error;
      }),
    );
    results.forEach((r, idx) => {
      if (r.status === "fulfilled") {
        succeeded += 1;
      } else {
        failed += 1;
        // fail-soft は維持しつつ失敗理由を残す（API エラー / 空 / DB エラーの切り分け用）
        console.warn(`要約失敗 [${chunk[idx].id}]:`, r.reason);
      }
    });
  }

  return { picked: rows.length, succeeded, failed, skipped: false };
}

// Phase3: 取得→保存の後に呼ぶバッチ「アノテート」。要約とタグを同時生成して保存する。
// summarizeMissing の上位互換（要約も埋める）。cron / refreshNow からはこちらを呼ぶ。
export type AnnotateBatchResult = {
  picked: number;
  succeeded: number;
  failed: number;
  skipped: boolean; // API キー未設定でスキップした場合 true
};

export async function annotateMissing(
  supabase: SupabaseClient,
  opts: {
    limit?: number;
    concurrency?: number;
    summarizer?: Summarizer | null;
  } = {},
): Promise<AnnotateBatchResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const summarizer =
    opts.summarizer !== undefined ? opts.summarizer : createHaikuSummarizer();

  if (!summarizer) {
    return { picked: 0, succeeded: 0, failed: 0, skipped: true };
  }

  // summary 未設定の記事を対象にする（新着が summary+tags を一括で得る）。
  // 既存の要約済み記事は対象外で、72h のキュレーション候補窓から自然に外れていく。
  let rows: Row[] = [];
  try {
    const { data, error } = await supabase
      .from("articles")
      .select("id, title, content_html")
      .is("summary", null)
      .not("content_html", "is", null)
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(limit);
    if (error) throw error;
    rows = (data ?? []) as Row[];
  } catch (e) {
    console.warn("アノテート対象の取得に失敗:", e);
    return { picked: 0, succeeded: 0, failed: 0, skipped: false };
  }

  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += concurrency) {
    const chunk = rows.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      chunk.map(async (row) => {
        const text = htmlToInputText(row.content_html);
        if (!text && !row.title) throw new Error("本文・タイトルとも空");
        const { summary, tags } = await summarizer.annotate({
          title: row.title,
          text,
        });
        if (!summary) throw new Error("要約が空");

        // タグを先に保存 → 要約を後に保存。こうすると summary が埋まった記事は必ずタグも持つ
        // （途中失敗時は summary が NULL のまま残り、次回再アノテートで収束する）。
        if (tags.length) {
          const tagRows = tags.map((t) => ({
            article_id: row.id,
            tag_slug: t,
            source: "llm",
          }));
          const { error: tagErr } = await supabase
            .from("article_tags")
            .upsert(tagRows, {
              onConflict: "article_id,tag_slug",
              ignoreDuplicates: true,
            });
          if (tagErr) throw tagErr;
        }
        const { error: upErr } = await supabase
          .from("articles")
          .update({ summary })
          .eq("id", row.id);
        if (upErr) throw upErr;
      }),
    );
    results.forEach((r, idx) => {
      if (r.status === "fulfilled") {
        succeeded += 1;
      } else {
        failed += 1;
        console.warn(`アノテート失敗 [${chunk[idx].id}]:`, r.reason);
      }
    });
  }

  return { picked: rows.length, succeeded, failed, skipped: false };
}
