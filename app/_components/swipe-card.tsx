import type { CurationCard } from "@/lib/types";
import { formatDateShort } from "@/lib/format";
import { tagLabel, categoryLabel } from "@/lib/tags/vocabulary";

// Tinder デッキ1枚分の見た目（presentational）。状態は持たない。
// index は 1 始まりの通し番号（デッキ内の位置）。Archivo の特大番号として表示する。
// ★トグル（お気に入り）だけは操作を受けるが、状態は親が持ち、ここはコールバックを呼ぶだけ。
export function SwipeCard({
  card,
  index,
  isStarred,
  onToggleStar,
}: {
  card: CurationCard;
  index: number;
  isStarred: boolean;
  onToggleStar: () => void;
}) {
  // カテゴリ表記（TECH / AI）は先頭タグ slug から導出する。
  const category = card.tags[0] ? categoryLabel(card.tags[0]) : null;

  return (
    <article className="relative border border-border bg-surface">
      {/* ★お気に入りトグル（カード右上）。pointerDown を止めてデッキのドラッグ誤発火を防ぐ。 */}
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onToggleStar}
        aria-label="お気に入り"
        aria-pressed={isStarred}
        title={isStarred ? "お気に入りから外す" : "後で読む（お気に入り）"}
        className={`absolute right-3 top-3 z-10 px-2 py-1 font-mono text-lg leading-none transition-colors ${
          isStarred ? "text-accent" : "text-faint hover:text-foreground"
        }`}
      >
        {isStarred ? "★" : "☆"}
      </button>

      <div className="flex gap-5 p-6">
        <div className="font-display text-4xl font-extrabold leading-none tabular-nums text-foreground">
          {String(index).padStart(2, "0")}
        </div>

        <div className="min-w-0 flex-1">
          {category && (
            <div className="font-mono text-[11px] tracking-widest text-faint">
              {category}
            </div>
          )}

          <h2 className="mt-1.5 pr-8 text-xl font-bold leading-snug">
            {card.url ? (
              <a
                href={card.url}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-accent"
              >
                {card.title ?? "(無題)"}
              </a>
            ) : (
              (card.title ?? "(無題)")
            )}
          </h2>

          {card.summary && (
            <p className="mt-3 text-sm leading-relaxed text-muted">
              {card.summary}
            </p>
          )}

          {card.tags.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {card.tags.map((t) => (
                <span
                  key={t}
                  className="border border-border px-2 py-0.5 text-xs text-foreground"
                >
                  {tagLabel(t)}
                </span>
              ))}
            </div>
          )}

          <div className="mt-5 border-t border-line pt-3 font-mono text-xs tracking-wide text-faint">
            {card.feedTitle && <span>{card.feedTitle}</span>}
            {card.feedTitle && card.published_at && <span> — </span>}
            {card.published_at && (
              <span>{formatDateShort(card.published_at)}</span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
