"use client";

import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { addFeed, type AddFeedState } from "../../actions";
import { SubmitButton } from "../../_components/submit-button";

// フィード追加フォーム（YAT-41）。useActionState で pending（SubmitButton）を出し、完了を toast で
// 伝える。成功時は入力をクリアして連続追加しやすくする。
export function AddFeedForm() {
  const [state, formAction] = useActionState<AddFeedState, FormData>(
    addFeed,
    null,
  );
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      toast.success(state.message, { id: "add-feed" });
      ref.current?.reset();
    } else {
      toast.error(state.message, { id: "add-feed" });
    }
  }, [state]);

  return (
    <form ref={ref} action={formAction} className="mb-6 flex">
      <input
        type="url"
        name="url"
        required
        aria-label="追加するフィードの URL"
        placeholder="https://example.com/feed.xml"
        className="flex-1 border border-border bg-surface px-3 py-2 font-mono text-sm outline-none focus:border-accent"
      />
      <SubmitButton
        pendingLabel="追加中…"
        className="border border-l-0 border-border bg-accent px-5 py-2 font-mono text-sm font-semibold tracking-widest text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-70"
      >
        ADD
      </SubmitButton>
    </form>
  );
}
