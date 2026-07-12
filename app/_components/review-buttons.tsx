"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { reviewLearnSource } from "../actions";
import { Spinner } from "./spinner";

// 学習ソースの承認/却下（YAT-41）。素の form を client 化し、破壊的操作なので pending スピナー＋
// 成功 toast を出す。押した側のボタンにだけスピナー／aria-busy を出すため、どちらを操作中かを
// busy state で持つ（単一 pending だと無関係な承認側にスピナーが出て誤認を招くため）。
export function ReviewButtons({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);

  function review(decision: "approve" | "reject") {
    setBusy(decision);
    const fd = new FormData();
    fd.set("id", id);
    fd.set("decision", decision);
    startTransition(async () => {
      const r = await reviewLearnSource(fd);
      if (r?.ok)
        toast.success(decision === "approve" ? "承認しました" : "却下しました");
      else toast.error("処理に失敗しました", { id: "review-source-fail" });
      setBusy(null);
    });
  }

  return (
    <div className="flex shrink-0 gap-1.5">
      <button
        type="button"
        onClick={() => review("approve")}
        disabled={pending}
        aria-busy={busy === "approve"}
        className="border border-border px-2.5 py-1 font-mono text-xs tracking-wide text-accent transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="inline-flex items-center gap-1.5">
          {busy === "approve" && <Spinner className="size-3" />}
          承認
        </span>
      </button>
      <button
        type="button"
        onClick={() => review("reject")}
        disabled={pending}
        aria-busy={busy === "reject"}
        className="border border-border px-2.5 py-1 font-mono text-xs tracking-wide text-muted transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="inline-flex items-center gap-1.5">
          {busy === "reject" && <Spinner className="size-3" />}
          却下
        </span>
      </button>
    </div>
  );
}
