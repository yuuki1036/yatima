import { formatDateShort } from "@/lib/format";
import type { Feed } from "@/lib/types";
import { deactivateFeed, deleteFeed, reactivateFeed } from "../../actions";
import { FeedActionButton } from "./feed-action-button";

// 購読フィード一覧。非活性 feed は末尾へ（active を先に、created_at 降順は各群内で維持）。
// 空表示（「まだフィードがありません」）は page 側がエラー有無と合わせて出し分けるためここでは扱わない。
export function FeedsListSection({ feeds }: { feeds: Feed[] }) {
  const orderedFeeds = [...feeds].sort(
    (a, b) => Number(a.active === false) - Number(b.active === false),
  );

  if (orderedFeeds.length === 0) return null;

  return (
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
            <FeedActionButton
              id={f.id}
              action={f.active ? deactivateFeed : reactivateFeed}
              successMsg={f.active ? "非活性化しました" : "復活しました"}
              className="border border-border px-2.5 py-1 font-mono text-xs tracking-wide text-muted transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
            >
              {f.active ? "非活性化" : "復活"}
            </FeedActionButton>
            <FeedActionButton
              id={f.id}
              action={deleteFeed}
              successMsg="削除しました"
              className="border border-border px-2.5 py-1 font-mono text-xs tracking-wide text-accent transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              削除
            </FeedActionButton>
          </div>
        </li>
      ))}
    </ul>
  );
}
