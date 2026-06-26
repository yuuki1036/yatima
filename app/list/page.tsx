import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatDateShort, errorMessage } from "@/lib/format";
import type { ArticleWithFeed } from "@/lib/types";
import { toggleRead, toggleStar } from "../actions";
import { RefreshButton } from "../_components/refresh-button";

// 全件ブラウズ用の密リスト（旧トップ）。Tinder（/）の取りこぼし確認・既読/スター操作の受け皿。
export const dynamic = "force-dynamic";
// 手動「更新」(refreshNow) が取得→要約→curate を同期実行するため、関数時間を延ばす。
export const maxDuration = 60;

const btn =
  "border border-border px-2.5 py-1 font-mono text-xs tracking-wide transition-colors hover:bg-foreground hover:text-background";

export default async function ListPage() {
  let articles: ArticleWithFeed[] = [];
  let errorMsg: string | null = null;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("articles")
      // 一覧で使う列だけ明示取得する。`*` だと embedding vector(1024) や content_html まで
      // 100 件ぶん載りペイロードが肥大するため除外する。
      .select(
        "id, url, title, summary, is_read, is_starred, published_at, feeds(title, site_url)",
      )
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
          ALL ARTICLES
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
          記事がありません。
          <br />
          「FEEDS」からフィードを追加すると、定期実行で記事が取得されます。
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
              <div className="flex shrink-0 gap-1.5">
                <form action={toggleStar}>
                  <input type="hidden" name="id" value={a.id} />
                  <input
                    type="hidden"
                    name="is_starred"
                    value={String(a.is_starred)}
                  />
                  <button
                    className={`${btn} ${a.is_starred ? "text-accent" : ""}`}
                    title="スター"
                  >
                    {a.is_starred ? "★" : "☆"}
                  </button>
                </form>
                <form action={toggleRead}>
                  <input type="hidden" name="id" value={a.id} />
                  <input
                    type="hidden"
                    name="is_read"
                    value={String(a.is_read)}
                  />
                  <button className={btn}>
                    {a.is_read ? "未読に戻す" : "既読にする"}
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
