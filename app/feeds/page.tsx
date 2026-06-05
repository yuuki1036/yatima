import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatDate } from "@/lib/format";
import type { Feed } from "@/lib/types";
import { addFeed, deleteFeed } from "../actions";

export const dynamic = "force-dynamic";

export default async function FeedsPage() {
  let feeds: Feed[] = [];
  let errorMsg: string | null = null;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("feeds")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    feeds = (data ?? []) as Feed[];
  } catch (e) {
    errorMsg = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">フィード</h1>

      <form action={addFeed} className="mb-6 flex gap-2">
        <input
          type="url"
          name="url"
          required
          placeholder="https://example.com/feed.xml"
          className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300">
          追加
        </button>
      </form>

      {errorMsg && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          フィードを取得できませんでした: {errorMsg}
          <br />
          <span className="text-xs">
            .env.local の Supabase 設定と、supabase/migrations/0001_init.sql の適用を確認してください。
          </span>
        </div>
      )}

      {!errorMsg && feeds.length === 0 && (
        <p className="py-12 text-center text-sm text-zinc-500">
          まだフィードがありません。上のフォームから追加してください。
        </p>
      )}

      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
        {feeds.map((f) => (
          <li key={f.id} className="flex items-start gap-3 py-3">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{f.title ?? f.url}</div>
              <div className="mt-0.5 truncate text-xs text-zinc-500">{f.url}</div>
              <div className="mt-0.5 text-xs text-zinc-400">
                {f.last_fetched_at
                  ? `最終取得: ${formatDate(f.last_fetched_at)}`
                  : "未取得"}
              </div>
            </div>
            <form action={deleteFeed} className="shrink-0">
              <input type="hidden" name="id" value={f.id} />
              <button className="rounded-md border border-zinc-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-zinc-700 dark:hover:bg-red-950">
                削除
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
