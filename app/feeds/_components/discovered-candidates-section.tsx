import type { FeedCandidate } from "@/lib/types";
import {
  credibilityLevel,
  CREDIBILITY_LABELS,
  discoverySourceCount,
  discoveryPreferenceLabel,
  NOTABLE_SOURCE_COUNT,
} from "@/lib/feeds/discovery-display";
import { approveFeedCandidate, rejectFeedCandidate } from "../../actions";
import { FeedActionButton } from "./feed-action-button";

// 承認待ちの自動発見候補（YAT-16）。取得と失敗時の畳み込みは page が行い、ここは描画に徹する。
// 候補が無ければ何も描かない。
export function DiscoveredCandidatesSection({
  candidates,
}: {
  candidates: FeedCandidate[];
}) {
  if (candidates.length === 0) return null;

  return (
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
              <FeedActionButton
                id={c.id}
                action={approveFeedCandidate}
                successMsg="承認しました"
                className="border border-border px-2.5 py-1 font-mono text-xs tracking-wide text-accent transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                承認
              </FeedActionButton>
              <FeedActionButton
                id={c.id}
                action={rejectFeedCandidate}
                successMsg="却下しました"
                className="border border-border px-2.5 py-1 font-mono text-xs tracking-wide text-muted transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
              >
                却下
              </FeedActionButton>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
