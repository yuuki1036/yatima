import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadSourcePrefs } from "@/lib/ranking/preferences";
import {
  computeRetireSuggestions,
  FEED_HEALTH_THRESHOLDS,
  type RetireSuggestion,
} from "@/lib/ranking/feed-health";
import type { Feed, FeedCandidate } from "@/lib/types";
import { AddFeedForm } from "./_components/add-feed-form";
import { RetireSuggestionsSection } from "./_components/retire-suggestions-section";
import { DiscoveredCandidatesSection } from "./_components/discovered-candidates-section";
import { FeedsListSection } from "./_components/feeds-list-section";

export const dynamic = "force-dynamic";

// /feeds はソース管理画面。取得とエラー処理はこの page が一手に引き受け、独立した 3 セクション
// （退役提案 / 発見候補 / 一覧）へは描画だけを委譲する（YAT-51）。
// 取得をセクション側に分散させると、①どれかの throw が page の catch を抜けて error.tsx に化ける
// ②feeds 失敗時に他セクションだけ描かれる ③Promise.all の並列が直列に退化する、を招くため、
// データの流れは意図して page に集約している。
export default async function FeedsPage() {
  let feeds: Feed[] = [];
  let candidates: FeedCandidate[] = [];
  let suggestions: RetireSuggestion[] = [];
  let errorMsg: string | null = null;

  try {
    const supabase = await createSupabaseServerClient();
    const [feedsRes, candRes, sourcePrefs, recentPublished] = await Promise.all([
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
      // dead シグナル用の「feed ごとの直近記事の公開日」（YAT-70 の RPC）。最新値と投稿間隔の
      // 中央値の両方をここから導く。失敗時は空 Map ではなく **null** を返す。空 Map に倒すと
      // 「記事が 1 件も無い」と区別が付かず、migration 未適用や一時障害のときに全 feed が
      // 一斉に dead へ倒れる。
      (async (): Promise<Map<string, string[]> | null> => {
        try {
          const { data, error } = await supabase.rpc("feed_recent_published", {
            sample_size: FEED_HEALTH_THRESHOLDS.CADENCE_SAMPLE,
          });
          if (error) return null;
          const rows = (data ?? []) as {
            feed_id: string;
            published_at: string;
          }[];
          // RPC は feed_id ごとに published_at 降順で返す。その順序を保って束ねる。
          const m = new Map<string, string[]>();
          for (const r of rows) {
            const l = m.get(r.feed_id);
            if (l) l.push(r.published_at);
            else m.set(r.feed_id, [r.published_at]);
          }
          return m;
        } catch {
          return null;
        }
      })(),
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
          // RPC が取れなかった場合は undefined を渡して dead 判定を見送らせる
          // （空配列は「記事ゼロ」の意味なので畳んではいけない。feed-health.ts の注釈を参照）。
          recentPublishedAt: recentPublished
            ? (recentPublished.get(f.id) ?? [])
            : undefined,
          credibility: f.credibility,
          near_dup_rate: f.near_dup_rate,
          sourcePref: sourcePrefs.get(f.id) ?? 0,
        })),
    );
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

      <AddFeedForm />

      {errorMsg && (
        <div className="mb-4 border-l-2 border-accent bg-surface px-4 py-3 text-sm text-foreground">
          フィードを取得できませんでした: {errorMsg}
          <br />
          <span className="text-xs text-muted">
            .env.local の Supabase 設定と、supabase/migrations/0001_init.sql の適用を確認してください。
          </span>
        </div>
      )}

      <RetireSuggestionsSection suggestions={suggestions} />

      <DiscoveredCandidatesSection candidates={candidates} />

      {!errorMsg && feeds.length === 0 && (
        <p className="border border-line py-12 text-center text-sm text-muted">
          まだフィードがありません。上のフォームから追加してください。
        </p>
      )}

      <FeedsListSection feeds={feeds} />
    </div>
  );
}
