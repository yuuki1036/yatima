import type { CategoryMastery } from "@/lib/types";

// YAT-28: 弱点マップ。tech/* カテゴリ別の習熟バーと、各カテゴリの弱点 concept 上位を出す。
// 非インタラクティブな Server Component（picker の下に masterySlot として差し込む）。
// row が無ければ null（初回利用時はマップなしで picker のみ）。

type Props = { categories: CategoryMastery[] };

export function MasteryMap({ categories }: Props) {
  if (categories.length === 0) return null;

  return (
    <div className="mt-10 border-t border-line pt-6">
      <div className="mb-5 flex items-baseline justify-between">
        <span className="font-mono text-xs font-medium tracking-widest text-accent">
          MASTERY
        </span>
        <span className="font-mono text-xs tracking-widest text-faint">
          弱点マップ
        </span>
      </div>

      <div className="flex flex-col gap-4">
        {categories.map((c) => {
          const pct = Math.round(c.mastery * 100);
          return (
            <div key={c.slug}>
              <div className="mb-1 flex items-baseline justify-between font-mono text-xs tracking-wide">
                <span className="text-muted">{c.label}</span>
                <span className="tabular-nums text-faint">
                  {pct}% · {c.conceptCount}
                </span>
              </div>
              {/* 習熟バー: 色だけに頼らず数値も併記済み。支援技術には progressbar で値を伝える。 */}
              <div
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${c.label} 習熟度`}
                className="h-1.5 w-full bg-surface"
              >
                <div
                  aria-hidden
                  className="h-full bg-accent"
                  style={{ width: `${pct}%` }}
                />
              </div>
              {c.weakest.length > 0 && (
                <ul className="mt-2 flex flex-col gap-0.5">
                  {c.weakest.map((w) => (
                    <li
                      key={w.concept_key}
                      className="flex items-baseline justify-between font-mono text-xs text-faint"
                    >
                      <span className="truncate pr-2" title={w.concept_label}>
                        {w.concept_label}
                      </span>
                      <span className="tabular-nums">
                        {Math.round(w.mastery * 100)}%
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
