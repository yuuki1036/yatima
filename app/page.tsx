import { createSupabaseServerClient } from "@/lib/supabase/server";
import { todayJst, errorMessage } from "@/lib/format";
import type { CurationCard } from "@/lib/types";
import { submitFeedback } from "./actions";
import { CurationDeck } from "./_components/curation-deck";

export const dynamic = "force-dynamic";

// Supabase の埋め込み select 結果の素の形（生成型を使っていないので明示する）。
type PickRow = {
  id: string;
  title: string | null;
  summary: string | null;
  url: string | null;
  published_at: string | null;
  score: number | null;
  feeds: { title: string | null } | null;
  article_tags: { tag_slug: string }[] | null;
};

export default async function Home() {
  let cards: CurationCard[] = [];
  let errorMsg: string | null = null;

  try {
    const supabase = await createSupabaseServerClient();
    const today = todayJst();
    const [picksRes, fbRes] = await Promise.all([
      supabase
        .from("articles")
        .select(
          "id, title, summary, url, published_at, score, feeds(title), article_tags(tag_slug)",
        )
        .eq("picked_date", today)
        .order("score", { ascending: false, nullsFirst: false }),
      supabase.from("article_feedback").select("article_id"),
    ]);
    if (picksRes.error) throw picksRes.error;
    if (fbRes.error) throw fbRes.error;

    const done = new Set(
      (fbRes.data ?? []).map((f) => f.article_id as string),
    );
    const rows = (picksRes.data ?? []) as unknown as PickRow[];
    cards = rows
      .filter((a) => !done.has(a.id)) // 判定済みは除外（リロードで続きから）
      .map((a) => ({
        id: a.id,
        title: a.title,
        summary: a.summary,
        url: a.url,
        published_at: a.published_at,
        feedTitle: a.feeds?.title ?? null,
        tags: (a.article_tags ?? []).map((t) => t.tag_slug),
      }));
  } catch (e) {
    errorMsg = errorMessage(e);
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">今日のピック</h1>
      </div>

      {errorMsg && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          記事を取得できませんでした: {errorMsg}
          <br />
          <span className="text-xs">
            .env.local の Supabase 設定と、supabase/migrations の適用を確認してください。
          </span>
        </div>
      )}

      {!errorMsg && (
        <CurationDeck cards={cards} submitFeedbackAction={submitFeedback} />
      )}
    </div>
  );
}
