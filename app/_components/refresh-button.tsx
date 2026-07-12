"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import { refreshNow, type RefreshState } from "../actions";
import { Spinner } from "./spinner";

// 手動「更新」ボタン。取得パイプライン（embed 除く）を起動する。取得→要約→curate はサーバーで
// 同期実行されるため完了まで pending（数十秒かかりうる）。重い操作なので完了は toast で伝える（YAT-41）。
export function RefreshButton() {
  const [state, action, pending] = useActionState<RefreshState, FormData>(
    refreshNow,
    null,
  );

  // 完了結果（{ ok, message }）を toast に流す。連打時の重複は固定 id で dedup。
  useEffect(() => {
    if (!state?.message) return;
    if (state.ok) toast.success(state.message, { id: "refresh" });
    else toast.error(state.message, { id: "refresh" });
  }, [state]);

  return (
    <form action={action}>
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className="border border-border px-3 py-1.5 font-mono text-xs tracking-widest transition-colors hover:bg-foreground hover:text-background disabled:opacity-50"
      >
        <span className="inline-flex items-center gap-2">
          {pending && <Spinner className="size-3" />}
          {pending ? "取得中…" : "更新"}
        </span>
      </button>
    </form>
  );
}
