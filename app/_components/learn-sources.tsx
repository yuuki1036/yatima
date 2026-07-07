import { createSupabaseServerClient } from "@/lib/supabase/server";
import { TAG_LEAVES, tagLabel } from "@/lib/tags/vocabulary";
import type { LearnSource } from "@/lib/types";
import { proposeLearnSources, reviewLearnSource } from "../actions";
import { LearnSourceFinder } from "./learn-source-finder";

// YAT-32: 学習ソースの管理パネル（picker 画面の下部に差し込む）。承認済み learn_sources だけが
// クイズ生成の素材になるため、ここで「探す（LLM 提案→検証）」→「承認待ちを承認/却下」を回す。
// RSS 記事プールとは分離した evergreen ソース（公式 docs・定番解説）だけを学習に使う（design 20260707）。

// 提案対象カテゴリ = tech/* leaf（おまかせは提案テーマが曖昧なので出さない）。
const FINDER_CATEGORIES = TAG_LEAVES.filter((t) => t.parent === "tech").map(
  (t) => ({ slug: t.slug, label: t.label }),
);

export async function LearnSources() {
  let pending: LearnSource[] = [];
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("learn_sources")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false });
    if (error) throw error;
    pending = (data ?? []) as LearnSource[];
  } catch (e) {
    console.warn("学習ソースの承認待ち取得に失敗:", e);
  }

  return (
    <section className="mt-10 border-t border-line pt-6">
      <div className="mb-3 font-mono text-xs font-medium tracking-widest text-accent">
        LEARN SOURCES
      </div>
      <p className="mb-4 text-xs text-muted">
        公式ドキュメントや定番の解説を承認すると、クイズの出題元になります（時事ニュースは対象外）。
      </p>

      <LearnSourceFinder categories={FINDER_CATEGORIES} action={proposeLearnSources} />

      {pending.length > 0 && (
        <ul className="mt-5 space-y-2">
          {pending.map((s) => (
            <li
              key={s.id}
              className="flex items-start justify-between gap-3 border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate text-sm text-foreground hover:text-accent"
                >
                  {s.title || s.url}
                </a>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span className="border border-border px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-faint">
                    {tagLabel(s.category)}
                  </span>
                  <span className="truncate font-mono text-[10px] tracking-wide text-faint">
                    {s.url}
                  </span>
                </div>
                {s.rationale && (
                  <p className="mt-1 line-clamp-2 text-xs text-muted">{s.rationale}</p>
                )}
              </div>
              <div className="flex shrink-0 gap-1.5">
                <form action={reviewLearnSource}>
                  <input type="hidden" name="id" value={s.id} />
                  <input type="hidden" name="decision" value="approve" />
                  <button className="border border-border px-2.5 py-1 font-mono text-xs tracking-wide text-accent transition-colors hover:bg-accent hover:text-accent-foreground">
                    承認
                  </button>
                </form>
                <form action={reviewLearnSource}>
                  <input type="hidden" name="id" value={s.id} />
                  <input type="hidden" name="decision" value="reject" />
                  <button className="border border-border px-2.5 py-1 font-mono text-xs tracking-wide text-muted transition-colors hover:bg-surface">
                    却下
                  </button>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
