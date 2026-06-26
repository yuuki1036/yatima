"use client";

import { useActionState } from "react";
import { refreshNow, type RefreshState } from "../actions";

// 手動「更新」ボタン。取得パイプライン（embed 除く）を起動し、結果/クールダウンを横に表示する。
// 取得→要約→curate はサーバーで同期実行されるため、完了まで pending（数十秒かかりうる）。
export function RefreshButton() {
  const [state, action, pending] = useActionState<RefreshState, FormData>(
    refreshNow,
    null,
  );

  return (
    <form action={action} className="flex items-center gap-3">
      <button
        type="submit"
        disabled={pending}
        className="border border-border px-3 py-1.5 font-mono text-xs tracking-widest transition-colors hover:bg-foreground hover:text-background disabled:opacity-50"
      >
        {pending ? "取得中…" : "更新"}
      </button>
      {state?.message && (
        <span
          className={`font-mono text-xs ${state.ok ? "text-faint" : "text-accent"}`}
        >
          {state.message}
        </span>
      )}
    </form>
  );
}
