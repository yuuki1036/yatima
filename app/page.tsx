import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/format";
import type { ArticleWithFeed } from "@/lib/types";
import { toggleRead, toggleStar, refreshNow } from "./actions";

export const dynamic = "force-dynamic";

const btn =
  "rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800";

export default async function Home() {
  let articles: ArticleWithFeed[] = [];
  let errorMsg: string | null = null;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("articles")
      .select("*, feeds(title, site_url)")
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(100);
    if (error) throw error;
    articles = (data ?? []) as unknown as ArticleWithFeed[];
  } catch (e) {
    errorMsg = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">
          記事 <span className="text-sm font-normal text-zinc-500">({articles.length})</span>
        </h1>
        <form action={refreshNow}>
          <button className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300">
            今すぐ取得
          </button>
        </form>
      </div>

      {errorMsg && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          記事を取得できませんでした: {errorMsg}
          <br />
          <span className="text-xs">
            .env.local の Supabase 設定と、supabase/migrations/0001_init.sql の適用を確認してください。
          </span>
        </div>
      )}

      {!errorMsg && articles.length === 0 && (
        <p className="py-12 text-center text-sm text-zinc-500">
          記事がありません。
          <br />
          「フィード」からフィードを追加して「今すぐ取得」を押してください。
        </p>
      )}

      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {articles.map((a) => (
          <li key={a.id} className="flex items-start gap-3 py-3">
            <div className="min-w-0 flex-1">
              <a
                href={a.url ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
                className={`block font-medium hover:underline ${
                  a.is_read ? "text-zinc-400 dark:text-zinc-500" : ""
                }`}
              >
                {a.is_starred && <span className="text-amber-500">★ </span>}
                {a.title ?? "(無題)"}
              </a>
              {a.summary && (
                <p className="mt-1 line-clamp-2 text-sm text-zinc-600 dark:text-zinc-400">
                  {a.summary}
                </p>
              )}
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-zinc-500">
                {a.feeds?.title && <span>{a.feeds.title}</span>}
                {a.published_at && <span>· {formatDate(a.published_at)}</span>}
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <form action={toggleStar}>
                <input type="hidden" name="id" value={a.id} />
                <input type="hidden" name="is_starred" value={String(a.is_starred)} />
                <button className={btn} title="スター">
                  {a.is_starred ? "★" : "☆"}
                </button>
              </form>
              <form action={toggleRead}>
                <input type="hidden" name="id" value={a.id} />
                <input type="hidden" name="is_read" value={String(a.is_read)} />
                <button className={btn}>
                  {a.is_read ? "未読に戻す" : "既読にする"}
                </button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
