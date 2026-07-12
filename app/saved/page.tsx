import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatDateShort, errorMessage } from "@/lib/format";
import type { ArticleWithFeed } from "@/lib/types";
import { RefreshButton } from "../_components/refresh-button";
import { SaveActions } from "./_components/save-actions";

// 「後で読む」お気に入り（is_starred）の一覧。デッキ（/）で★を付けた記事を貯める受け皿。
export const dynamic = "force-dynamic";
// 手動「更新」(refreshNow) が取得→要約→curate を同期実行するため、関数時間を延ばす。
export const maxDuration = 60;

export default async function SavedPage() {
  let articles: ArticleWithFeed[] = [];
  let errorMsg: string | null = null;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("articles")
      // 一覧で使う列だけ明示取得する。`*` だと embedding vector(1024) や content_html まで
      // 最大 100 件分のペイロードに載って肥大するため除外する。
      .select(
        "id, url, title, summary, is_read, is_starred, published_at, feeds(title, site_url)",
      )
      // お気に入り（★）のみ。デッキ・この一覧の双方から付け外しできる。
      .eq("is_starred", true)
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(100);
    if (error) throw error;
    articles = (data ?? []) as unknown as ArticleWithFeed[];
  } catch (e) {
    errorMsg = errorMessage(e);
  }

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <span className="font-mono text-xs font-medium tracking-widest text-accent">
          SAVED
        </span>
        <div className="flex items-center gap-4">
          <span className="font-mono text-xs tracking-widest text-faint tabular-nums">
            {String(articles.length).padStart(2, "0")}
          </span>
          <RefreshButton />
        </div>
      </div>

      {errorMsg && (
        <div className="mb-4 border-l-2 border-accent bg-surface px-4 py-3 text-sm text-foreground">
          記事を取得できませんでした: {errorMsg}
          <br />
          <span className="text-xs text-muted">
            .env.local の Supabase 設定と、supabase/migrations の適用を確認してください。
          </span>
        </div>
      )}

      {!errorMsg && articles.length === 0 && (
        <p className="border border-line py-12 text-center text-sm text-muted">
          お気に入りがありません。
          <br />
          デッキ（TODAY）で★を付けると、後で読む記事がここに貯まります。
        </p>
      )}

      {articles.length > 0 && (
        <ul className="border-t border-line">
          {articles.map((a, i) => (
            <li
              key={a.id}
              className="flex items-start gap-4 border-b border-line py-4"
            >
              <span className="w-7 shrink-0 pt-1 font-mono text-xs tabular-nums text-faint">
                {String(i + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0 flex-1">
                <a
                  href={a.url ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`block font-semibold hover:text-accent ${
                    a.is_read ? "text-muted" : ""
                  }`}
                >
                  {a.is_starred && <span className="text-accent">★ </span>}
                  {a.title ?? "(無題)"}
                </a>
                {a.summary && (
                  <p className="mt-1 line-clamp-2 text-sm text-muted">
                    {a.summary}
                  </p>
                )}
                <div className="mt-1.5 font-mono text-xs tracking-wide text-faint">
                  {a.feeds?.title && <span>{a.feeds.title}</span>}
                  {a.feeds?.title && a.published_at && <span> — </span>}
                  {a.published_at && (
                    <span>{formatDateShort(a.published_at)}</span>
                  )}
                </div>
              </div>
              <SaveActions
                id={a.id}
                isStarred={a.is_starred}
                isRead={a.is_read}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
