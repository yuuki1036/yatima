import { createSupabaseServerClient } from "@/lib/supabase/server";
import { formatDateShort } from "@/lib/format";
import { loadSourcePrefs } from "@/lib/ranking/preferences";
import {
  computeRetireSuggestions,
  RETIRE_REASON_LABELS,
  type RetireSuggestion,
} from "@/lib/ranking/feed-health";
import type { Feed, FeedCandidate } from "@/lib/types";
import {
  credibilityLevel,
  CREDIBILITY_LABELS,
  discoverySourceCount,
  discoveryPreferenceLabel,
  NOTABLE_SOURCE_COUNT,
} from "@/lib/feeds/discovery-display";
import {
  addFeed,
  approveFeedCandidate,
  deactivateFeed,
  deleteFeed,
  reactivateFeed,
  rejectFeedCandidate,
} from "../actions";

export const dynamic = "force-dynamic";

export default async function FeedsPage() {
  let feeds: Feed[] = [];
  let candidates: FeedCandidate[] = [];
  let suggestions: RetireSuggestion[] = [];
  let errorMsg: string | null = null;

  try {
    const supabase = await createSupabaseServerClient();
    const [feedsRes, candRes, sourcePrefs] = await Promise.all([
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
      // 削除推奨のソース嗜好シグナル用。推奨はベストエフォートなので失敗は空 Map に倒す。
      loadSourcePrefs(supabase).catch(() => new Map<string, number>()),
    ]);
    if (feedsRes.error) throw feedsRes.error;
    // 候補の取得失敗は致命ではない（feeds 一覧は出す）。枠だけ畳む。
    feeds = (feedsRes.data ?? []) as Feed[];
    candidates = candRes.error ? [] : ((candRes.data ?? []) as FeedCandidate[]);

    // 削除推奨（YAT-20）: active な feed だけを評価対象にする（非活性は既に退役済み）。
    suggestions = computeRetireSuggestions(
      feeds
        .filter((f) => f.active)
        .map((f) => ({
          id: f.id,
          title: f.title,
          url: f.url,
          created_at: f.created_at,
          last_fetched_at: f.last_fetched_at,
          credibility: f.credibility,
          near_dup_rate: f.near_dup_rate,
          sourcePref: sourcePrefs.get(f.id) ?? 0,
        })),
    );
  } catch (e) {
    errorMsg = e instanceof Error ? e.message : String(e);
  }

  // 非活性 feed は一覧末尾へ（active を先に、created_at 降順は各群内で維持）。
  const orderedFeeds = [...feeds].sort(
    (a, b) => Number(a.active === false) - Number(b.active === false),
  );

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

      {suggestions.length > 0 && (
        <section className="mb-8">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="font-mono text-xs font-medium tracking-widest text-accent">
              RETIRE SUGGESTIONS
            </span>
            <span className="font-mono text-xs tracking-widest text-faint tabular-nums">
              {String(suggestions.length).padStart(2, "0")}
            </span>
          </div>
          <p className="mb-3 text-xs text-muted">
            自動評価で価値低下が疑われるフィード。確認して非活性化できます（記事は残り、後で復活できます）。
          </p>
          <ul className="border-t border-line">
            {suggestions.map((s) => (
              <li
                key={s.id}
                className="flex items-start gap-3 border-b border-line py-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{s.title ?? s.url}</div>
                  <div className="mt-1 truncate font-mono text-xs text-muted">
                    {s.url}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {s.reasons.map((r) => (
                      <span
                        key={r}
                        className="border border-border px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-accent"
                      >
                        {RETIRE_REASON_LABELS[r]}
                      </span>
                    ))}
                  </div>
                </div>
                <form action={deactivateFeed} className="shrink-0">
                  <input type="hidden" name="id" value={s.id} />
                  {/* 非活性化は可逆操作なので muted。赤(accent)は破壊的な「削除」に予約し一覧側と様式を揃える。 */}
                  <button className="border border-border px-2.5 py-1 font-mono text-xs tracking-wide text-muted transition-colors hover:bg-surface">
                    非活性化
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
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
            記事リンクや興味のあるテーマから自動発見した候補。承認すると購読フィードに加わります（信頼度は低めの初期値で開始）。
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
                  </div>
                  {/* 承認/却下の判断材料（YAT-26）: 信頼度の段階と、何媒体が参照していたか。 */}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {(() => {
                      const level = credibilityLevel(c.credibility);
                      // 低は控えめ(faint)、中は muted、高は accent で強調して段階を色でも示す。
                      const tone =
                        level === "high"
                          ? "text-accent"
                          : level === "mid"
                            ? "text-muted"
                            : "text-faint";
                      return (
                        <span
                          className={`border border-border px-1.5 py-0.5 font-mono text-[10px] tracking-wide ${tone}`}
                        >
                          信頼度 {CREDIBILITY_LABELS[level]}
                        </span>
                      );
                    })()}
                    {(() => {
                      const n = discoverySourceCount(c.discovered_from);
                      if (n === null) return null;
                      // 複数ソースからの参照は承認寄りの材料なので accent で強調する。
                      const tone =
                        n >= NOTABLE_SOURCE_COUNT ? "text-accent" : "text-faint";
                      return (
                        <span
                          className={`border border-border px-1.5 py-0.5 font-mono text-[10px] tracking-wide tabular-nums ${tone}`}
                        >
                          {n} 媒体が参照
                        </span>
                      );
                    })()}
                    {(() => {
                      // 方式②（嗜好ベース提案）候補は発見経路（起点テーマ）を出す。
                      const label = discoveryPreferenceLabel(c.discovered_from);
                      if (label === null) return null;
                      return (
                        <span className="border border-border px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-faint">
                          {label} から発見
                        </span>
                      );
                    })()}
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

      {orderedFeeds.length > 0 && (
        <ul className="border-t border-line">
          {orderedFeeds.map((f) => (
            <li
              key={f.id}
              className="flex items-start gap-4 border-b border-line py-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{f.title ?? f.url}</span>
                  {!f.active && (
                    <span className="border border-border px-1.5 py-0.5 font-mono text-[10px] tracking-widest text-faint">
                      INACTIVE
                    </span>
                  )}
                </div>
                <div className="mt-1 truncate font-mono text-xs text-muted">
                  {f.url}
                </div>
                <div className="mt-1 font-mono text-xs tracking-wide text-faint">
                  {f.last_fetched_at
                    ? `LAST FETCH — ${formatDateShort(f.last_fetched_at)}`
                    : "NOT FETCHED"}
                </div>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <form action={f.active ? deactivateFeed : reactivateFeed}>
                  <input type="hidden" name="id" value={f.id} />
                  <button className="border border-border px-2.5 py-1 font-mono text-xs tracking-wide text-muted transition-colors hover:bg-surface">
                    {f.active ? "非活性化" : "復活"}
                  </button>
                </form>
                <form action={deleteFeed}>
                  <input type="hidden" name="id" value={f.id} />
                  <button className="border border-border px-2.5 py-1 font-mono text-xs tracking-wide text-accent transition-colors hover:bg-accent hover:text-accent-foreground">
                    削除
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
