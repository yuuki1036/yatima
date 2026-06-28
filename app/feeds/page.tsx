import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatDateShort } from "@/lib/format";
import type { Feed, FeedCandidate } from "@/lib/types";
import {
  addFeed,
  approveFeedCandidate,
  deleteFeed,
  rejectFeedCandidate,
} from "../actions";

export const dynamic = "force-dynamic";

export default async function FeedsPage() {
  let feeds: Feed[] = [];
  let candidates: FeedCandidate[] = [];
  let errorMsg: string | null = null;

  try {
    const supabase = await createSupabaseServerClient();
    const [feedsRes, candRes] = await Promise.all([
      supabase
        .from("feeds")
        .select("*")
        .order("created_at", { ascending: false }),
      // 承認待ちの自動発見候補（YAT-16）。新しい順。
      supabase
        .from("feed_candidates")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: false }),
    ]);
    if (feedsRes.error) throw feedsRes.error;
    // 候補の取得失敗は致命ではない（feeds 一覧は出す）。枠だけ畳む。
    feeds = (feedsRes.data ?? []) as Feed[];
    candidates = candRes.error ? [] : ((candRes.data ?? []) as FeedCandidate[]);
  } catch (e) {
    errorMsg = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <div className="mb-5 flex items-baseline justify-between">
        <span className="font-mono text-xs font-medium tracking-widest text-accent">
          SOURCES
        </span>
        <span className="font-mono text-xs tracking-widest text-faint tabular-nums">
          {String(feeds.length).padStart(2, "0")}
        </span>
      </div>

      <form action={addFeed} className="mb-6 flex">
        <input
          type="url"
          name="url"
          required
          placeholder="https://example.com/feed.xml"
          className="flex-1 border border-border bg-surface px-3 py-2 font-mono text-sm outline-none focus:border-accent"
        />
        <button className="border border-l-0 border-border bg-accent px-5 py-2 font-mono text-sm font-semibold tracking-widest text-accent-foreground transition-opacity hover:opacity-90">
          ADD
        </button>
      </form>

      {errorMsg && (
        <div className="mb-4 border-l-2 border-accent bg-surface px-4 py-3 text-sm text-foreground">
          フィードを取得できませんでした: {errorMsg}
          <br />
          <span className="text-xs text-muted">
            .env.local の Supabase 設定と、supabase/migrations/0001_init.sql の適用を確認してください。
          </span>
        </div>
      )}

      {candidates.length > 0 && (
        <section className="mb-8">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="font-mono text-xs font-medium tracking-widest text-accent">
              DISCOVERED
            </span>
            <span className="font-mono text-xs tracking-widest text-faint tabular-nums">
              {String(candidates.length).padStart(2, "0")}
            </span>
          </div>
          <p className="mb-3 text-xs text-muted">
            記事リンクから自動発見した候補。承認すると購読フィードに加わります（信頼度は低めの初期値で開始）。
          </p>
          <ul className="border-t border-line">
            {candidates.map((c) => (
              <li
                key={c.id}
                className="flex items-start gap-3 border-b border-line py-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{c.title ?? c.source_domain}</div>
                  <div className="mt-1 truncate font-mono text-xs text-muted">
                    {c.url}
                  </div>
                  <div className="mt-1 font-mono text-xs tracking-wide text-faint">
                    {c.source_domain}
                    {c.discovered_from ? ` — ${c.discovered_from}` : ""}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <form action={approveFeedCandidate}>
                    <input type="hidden" name="id" value={c.id} />
                    <button className="border border-border px-2.5 py-1 font-mono text-xs tracking-wide text-accent transition-colors hover:bg-accent hover:text-accent-foreground">
                      承認
                    </button>
                  </form>
                  <form action={rejectFeedCandidate}>
                    <input type="hidden" name="id" value={c.id} />
                    <button className="border border-border px-2.5 py-1 font-mono text-xs tracking-wide text-muted transition-colors hover:bg-surface">
                      却下
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!errorMsg && feeds.length === 0 && (
        <p className="border border-line py-12 text-center text-sm text-muted">
          まだフィードがありません。上のフォームから追加してください。
        </p>
      )}

      {feeds.length > 0 && (
        <ul className="border-t border-line">
          {feeds.map((f) => (
            <li
              key={f.id}
              className="flex items-start gap-4 border-b border-line py-4"
            >
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{f.title ?? f.url}</div>
                <div className="mt-1 truncate font-mono text-xs text-muted">
                  {f.url}
                </div>
                <div className="mt-1 font-mono text-xs tracking-wide text-faint">
                  {f.last_fetched_at
                    ? `LAST FETCH — ${formatDateShort(f.last_fetched_at)}`
                    : "NOT FETCHED"}
                </div>
              </div>
              <form action={deleteFeed} className="shrink-0">
                <input type="hidden" name="id" value={f.id} />
                <button className="border border-border px-2.5 py-1 font-mono text-xs tracking-wide text-accent transition-colors hover:bg-accent hover:text-accent-foreground">
                  削除
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
