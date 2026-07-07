"use client";

import { useActionState } from "react";
import type { ProposeSourcesState } from "../actions";

// YAT-32: 学習ソースの「探す」フォーム。カテゴリを選んで proposeLearnSources を呼び、LLM 提案 →
// 検証ゲート → 承認待ち登録の結果メッセージを出す。提案は fetch を伴い数秒〜十数秒かかるため
// useActionState の pending でボタンを無効化する（/learn の maxDuration=60 内）。

type Category = { slug: string; label: string };

type Props = {
  categories: Category[]; // tech/* leaf のみ（おまかせは提案テーマが曖昧なので出さない）
  action: (
    prev: ProposeSourcesState,
    formData: FormData,
  ) => Promise<ProposeSourcesState>;
};

export function LearnSourceFinder({ categories, action }: Props) {
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <select
        name="category"
        defaultValue={categories[0]?.slug}
        disabled={pending}
        className="border border-border bg-background px-2 py-1.5 font-mono text-xs tracking-wide text-foreground disabled:opacity-50"
      >
        {categories.map((c) => (
          <option key={c.slug} value={c.slug}>
            {c.label}
          </option>
        ))}
      </select>
      <input
        type="text"
        name="hint"
        maxLength={100}
        placeholder="絞り込み（任意・例: TypeScript, React）"
        disabled={pending}
        className="min-w-0 flex-1 border border-border bg-background px-2 py-1.5 font-mono text-xs tracking-wide text-foreground placeholder:text-faint disabled:opacity-50"
      />
      <button
        disabled={pending}
        className="border border-border px-3 py-1.5 font-mono text-xs tracking-wide text-accent transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "探索中…" : "ソースを探す"}
      </button>
      {state && (
        <span
          className={`font-mono text-xs tracking-wide ${state.ok ? "text-foreground" : "text-muted"}`}
        >
          {state.message}
        </span>
      )}
    </form>
  );
}
