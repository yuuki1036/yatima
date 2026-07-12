"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { toggleRead, toggleStar, type MutationResult } from "../../actions";

// /saved 各行の star / read トグル（YAT-41）。素の form を client 化し、送信中は disabled＋aria-busy で
// pending を示し、失敗時のみ toast で伝える（成功 toast は出さない＝軽量トグルの頻発回避）。
// 軽量なのでスピナーは出さず disabled（opacity）で pending を表す。

const btn =
  "border border-border px-2.5 py-1 font-mono text-xs tracking-wide transition-colors hover:bg-foreground hover:text-background disabled:cursor-not-allowed disabled:opacity-50";

export function SaveActions({
  id,
  isStarred,
  isRead,
}: {
  id: string;
  isStarred: boolean;
  isRead: boolean;
}) {
  const [pending, startTransition] = useTransition();

  function run(
    action: (fd: FormData) => Promise<MutationResult>,
    key: string,
    current: boolean,
    failMsg: string,
    toastId: string,
  ) {
    const fd = new FormData();
    fd.set("id", id);
    fd.set(key, String(current)); // 反転前の値を送る（Server 側が反転する）
    startTransition(async () => {
      const r = await action(fd);
      if (!r?.ok) toast.error(failMsg, { id: toastId });
    });
  }

  return (
    <div className="flex shrink-0 gap-1.5">
      <button
        type="button"
        onClick={() =>
          run(
            toggleStar,
            "is_starred",
            isStarred,
            "スターの更新に失敗しました",
            "star-fail",
          )
        }
        disabled={pending}
        aria-busy={pending}
        className={`${btn} ${isStarred ? "text-accent" : ""}`}
        title="スター"
      >
        {isStarred ? "★" : "☆"}
      </button>
      <button
        type="button"
        onClick={() =>
          run(
            toggleRead,
            "is_read",
            isRead,
            "既読の更新に失敗しました",
            "read-fail",
          )
        }
        disabled={pending}
        aria-busy={pending}
        className={btn}
      >
        {isRead ? "未読に戻す" : "既読にする"}
      </button>
    </div>
  );
}
