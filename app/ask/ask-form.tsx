"use client";

import { useActionState } from "react";
import { askQuery, type AskState } from "./actions";
import { formatDateShort } from "@/lib/format";

// 横断 Q&A の入力フォームと結果表示（YAT-22）。
// 重い処理（embed + retrieval + LLM）はサーバーで同期実行されるため、完了まで pending。
// 連投は pending 中の入力/ボタン無効化で防ぐ（Voyage 3 RPM 対策。MVP は DB cooldown を持たない）。
export function AskForm() {
  const [state, action, pending] = useActionState<AskState, FormData>(
    askQuery,
    null,
  );

  return (
    <div>
      <form action={action} className="flex flex-col gap-2">
        <textarea
          name="q"
          aria-label="質問"
          required
          rows={2}
          disabled={pending}
          placeholder="蓄積した記事に質問する（例: 最近の AI エージェントの動向は？）"
          className="resize-y border border-border bg-surface px-3 py-2 font-mono text-sm outline-none focus:border-accent disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={pending}
          className="self-end border border-border px-3 py-1.5 font-mono text-xs tracking-widest transition-colors hover:bg-foreground hover:text-background disabled:opacity-50"
        >
          {pending ? "回答生成中…" : "質問する"}
        </button>
      </form>

      {state?.status === "error" && (
        <div className="mt-4 border-l-2 border-accent bg-surface px-4 py-3 text-sm text-foreground">
          {state.message}
        </div>
      )}

      {state?.status === "abstain" && (
        <div className="mt-4">
          <p className="mb-3 font-mono text-xs tracking-widest text-faint">
            Q. {state.question}
          </p>
          <p className="border border-line py-8 text-center text-sm text-muted">
            {state.message}
          </p>
        </div>
      )}

      {state?.status === "answer" && (
        <div className="mt-4">
          <p className="mb-3 font-mono text-xs tracking-widest text-faint">
            Q. {state.question}
          </p>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {state.answer}
          </p>

          {state.sources.length > 0 && (
            <div className="mt-6">
              <span className="font-mono text-xs font-medium tracking-widest text-accent">
                SOURCES
              </span>
              <ul className="mt-2 border-t border-line">
                {state.sources.map((s, i) => (
                  <li
                    key={s.id}
                    className="flex items-start gap-4 border-b border-line py-3"
                  >
                    <span className="w-7 shrink-0 pt-0.5 font-mono text-xs tabular-nums text-faint">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <div className="min-w-0 flex-1">
                      <a
                        href={s.url ?? "#"}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block font-semibold hover:text-accent"
                      >
                        {s.title ?? "(無題)"}
                      </a>
                      <div className="mt-1 font-mono text-xs tracking-wide text-faint tabular-nums">
                        <span>類似度 {s.similarity.toFixed(2)}</span>
                        {s.publishedAt && (
                          <span> — {formatDateShort(s.publishedAt)}</span>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
