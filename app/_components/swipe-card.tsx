import type { CurationCard } from "@/lib/types";
import { formatDate } from "@/lib/format";
import { tagLabel } from "@/lib/tags/vocabulary";

// Tinder デッキ1枚分の見た目（presentational）。状態は持たない。
export function SwipeCard({ card }: { card: CurationCard }) {
  return (
    <article className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-lg font-semibold leading-snug">
        {card.url ? (
          <a
            href={card.url}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
          >
            {card.title ?? "(無題)"}
          </a>
        ) : (
          (card.title ?? "(無題)")
        )}
      </h2>

      {card.summary && (
        <p className="mt-3 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
          {card.summary}
        </p>
      )}

      {card.tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {card.tags.map((t) => (
            <span
              key={t}
              className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
            >
              {tagLabel(t)}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-x-2 text-xs text-zinc-500">
        {card.feedTitle && <span>{card.feedTitle}</span>}
        {card.published_at && <span>· {formatDate(card.published_at)}</span>}
      </div>
    </article>
  );
}
