import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Feed } from "@/lib/types";
import { AddFeedForm } from "./_components/add-feed-form";
import { RetireSuggestionsSection } from "./_components/retire-suggestions-section";
import { DiscoveredCandidatesSection } from "./_components/discovered-candidates-section";
import { FeedsListSection } from "./_components/feeds-list-section";

export const dynamic = "force-dynamic";

// /feeds はソース管理画面。共有データ（feeds）とページ全体のエラー/空状態だけをここで束ね、
// 独立した 3 セクション（退役提案 / 発見候補 / 一覧）は各 Server Component に委譲する（YAT-51）。
export default async function FeedsPage() {
  let feeds: Feed[] = [];
  let errorMsg: string | null = null;

  try {
    const supabase = await createSupabaseServerClient();
    const feedsRes = await supabase
      .from("feeds")
      .select("*")
      .order("created_at", { ascending: false });
    if (feedsRes.error) throw feedsRes.error;
    feeds = (feedsRes.data ?? []) as Feed[];
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

      <RetireSuggestionsSection feeds={feeds} />

      <DiscoveredCandidatesSection />

      {!errorMsg && feeds.length === 0 && (
        <p className="border border-line py-12 text-center text-sm text-muted">
          まだフィードがありません。上のフォームから追加してください。
        </p>
      )}

      <FeedsListSection feeds={feeds} />
    </div>
  );
}
