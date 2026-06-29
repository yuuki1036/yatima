import { createSupabaseServerClient } from "@/lib/supabase/server";
import { errorMessage, formatDateShort } from "@/lib/format";
import type { CardCandidate } from "@/lib/types";
import { approveCard, rejectCard } from "../actions";

export const dynamic = "force-dynamic";

// カード候補1件の表示＋承認/却下フォーム（YAT-17）。/feeds の DISCOVERED 枠と同じ操作モデル。
function CandidateRow({ c }: { c: CardCandidate }) {
  return (
    <li className="flex items-start gap-3 border-b border-line py-4">
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 font-mono text-xs tracking-widest text-faint">
          <span>{c.type.toUpperCase()}</span>
          {c.concept_tag && <span className="text-muted">— {c.concept_tag}</span>}
          {c.dup_flag && c.dup_similarity != null && (
            <span className="text-accent">
              DUP {c.dup_similarity.toFixed(2)}
            </span>
          )}
        </div>
        {c.type === "cloze" ? (
          <div className="whitespace-pre-wrap font-medium">{c.cloze_text}</div>
        ) : (
          <div>
            <div className="font-semibold">{c.front}</div>
            <div className="mt-1 text-sm text-muted">{c.back}</div>
          </div>
        )}
        <div className="mt-2 border-l-2 border-line pl-2 text-xs text-faint">
          {c.source_quote}
        </div>
        <div className="mt-1 font-mono text-xs tracking-wide text-faint">
          {formatDateShort(c.created_at)}
        </div>
      </div>
      <div className="flex shrink-0 gap-1.5">
        <form action={approveCard}>
          <input type="hidden" name="id" value={c.id} />
          <button className="border border-border px-2.5 py-1 font-mono text-xs tracking-wide text-accent transition-colors hover:bg-accent hover:text-accent-foreground">
            承認
          </button>
        </form>
        <form action={rejectCard}>
          <input type="hidden" name="id" value={c.id} />
          <button className="border border-border px-2.5 py-1 font-mono text-xs tracking-wide text-muted transition-colors hover:bg-surface">
            却下
          </button>
        </form>
      </div>
    </li>
  );
}

export default async function LearnPage() {
  let candidates: CardCandidate[] = [];
  let errorMsg: string | null = null;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("card_candidates")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: false });
    if (error) throw error;
    candidates = (data ?? []) as CardCandidate[];
  } catch (e) {
    // Supabase の PostgrestError は Error 非継承なので errorMessage() で読める文字列に変換する。
    errorMsg = errorMessage(e);
  }

  // 近重複候補（dup_flag）は誤削除を避けつつキューのノイズを抑えるため別枠に畳む（自動 reject はしない）。
  const fresh = candidates.filter((c) => !c.dup_flag);
  const dups = candidates.filter((c) => c.dup_flag);

  return (
    <div>
      <div className="mb-5 flex items-baseline justify-between">
        <span className="font-mono text-xs font-medium tracking-widest text-accent">
          REVIEW QUEUE
        </span>
        <span className="font-mono text-xs tracking-widest text-faint tabular-nums">
          {String(candidates.length).padStart(2, "0")}
        </span>
      </div>

      <p className="mb-6 text-xs text-muted">
        read 済み・役立った記事から自動生成した学習カード候補。承認すると学習カードに加わります。
      </p>

      {errorMsg && (
        <div className="mb-4 border-l-2 border-accent bg-surface px-4 py-3 text-sm text-foreground">
          カード候補を取得できませんでした: {errorMsg}
          <br />
          <span className="text-xs text-muted">
            .env.local の Supabase 設定と、supabase/migrations/0007_learning.sql の適用を確認してください。
          </span>
        </div>
      )}

      {!errorMsg && fresh.length === 0 && (
        <p className="border border-line py-12 text-center text-sm text-muted">
          承認待ちの新規カード候補はありません。
          {candidates.length === 0
            ? "生成 cron（npm run generate-cards）が候補を積みます。"
            : "（近重複のみ — 下の枠を確認）"}
        </p>
      )}

      {fresh.length > 0 && (
        <ul className="border-t border-line">
          {fresh.map((c) => (
            <CandidateRow key={c.id} c={c} />
          ))}
        </ul>
      )}

      {dups.length > 0 && (
        <details className="mt-6">
          <summary className="cursor-pointer font-mono text-xs tracking-widest text-muted">
            近重複 {String(dups.length).padStart(2, "0")} 件（既存候補と類似）
          </summary>
          <ul className="mt-2 border-t border-line">
            {dups.map((c) => (
              <CandidateRow key={c.id} c={c} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
