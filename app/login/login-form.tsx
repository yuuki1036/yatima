"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";

// 共有パスワードの入力フォーム。誤りは useActionState 経由で下に表示する。
export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(
    login,
    null,
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      <label
        htmlFor="password"
        className="font-mono text-xs tracking-widest text-muted"
      >
        PASSWORD
      </label>
      <input
        id="password"
        name="password"
        type="password"
        autoFocus
        autoComplete="current-password"
        aria-invalid={!!state?.error}
        aria-describedby="password-error"
        className="border-2 border-border bg-background px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none"
      />
      <button
        type="submit"
        disabled={pending}
        className="border-2 border-border px-3 py-2 font-mono text-xs tracking-widest transition-colors hover:bg-foreground hover:text-background disabled:opacity-50"
      >
        {pending ? "確認中…" : "ログイン"}
      </button>
      {/* 常時 DOM に置き live region 化する。要素の出現に依存せず読み上げが安定し、
          入力欄の aria-describedby から参照される。誤り時のみ文言が入る。 */}
      <span
        id="password-error"
        role="alert"
        aria-live="polite"
        className="font-mono text-xs text-accent"
      >
        {state?.error}
      </span>
    </form>
  );
}
