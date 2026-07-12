"use client";

import { useTransition } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import type { MutationResult } from "../../actions";
import { Spinner } from "../../_components/spinner";

// hidden id 1 個の feed アクション（非活性化/復活/削除/候補承認/却下）を client 化する汎用ボタン
// （YAT-41）。Server Action を prop で受け、破壊的操作なので pending スピナー＋成功 toast を出す。
// pending 中はラベルをスピナーに置換して幅の伸びを抑える（隣接ボタンのレイアウトシフト回避）。
export function FeedActionButton({
  id,
  action,
  successMsg,
  className,
  children,
}: {
  id: string;
  action: (fd: FormData) => Promise<MutationResult>;
  successMsg: string;
  className?: string;
  children: ReactNode;
}) {
  const [pending, startTransition] = useTransition();

  function run() {
    const fd = new FormData();
    fd.set("id", id);
    startTransition(async () => {
      const r = await action(fd);
      if (r?.ok) toast.success(successMsg);
      else toast.error("処理に失敗しました", { id: "feed-action-fail" });
    });
  }

  return (
    <button
      type="button"
      onClick={run}
      disabled={pending}
      aria-busy={pending}
      className={className}
    >
      <span className="inline-flex items-center justify-center gap-1.5">
        {pending ? <Spinner className="size-3" /> : children}
      </span>
    </button>
  );
}
