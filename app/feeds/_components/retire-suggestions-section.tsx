import {
  RETIRE_REASON_LABELS,
  type RetireSuggestion,
} from "@/lib/ranking/feed-health";
import { deactivateFeed } from "../../actions";
import { FeedActionButton } from "./feed-action-button";

// 削除推奨（YAT-20）: 4 シグナルで価値低下が疑われた feed を提示する。評価そのものは取得データと
// 合わせて page が行い、ここは描画に徹する。退役候補が無ければ何も描かない。
export function RetireSuggestionsSection({
  suggestions,
}: {
  suggestions: RetireSuggestion[];
}) {
  if (suggestions.length === 0) return null;

  return (
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
            {/* 非活性化は可逆操作なので muted。赤(accent)は破壊的な「削除」に予約し一覧側と様式を揃える。 */}
            <FeedActionButton
              id={s.id}
              action={deactivateFeed}
              successMsg="非活性化しました"
              className="shrink-0 border border-border px-2.5 py-1 font-mono text-xs tracking-wide text-muted transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
            >
              非活性化
            </FeedActionButton>
          </li>
        ))}
      </ul>
    </section>
  );
}
