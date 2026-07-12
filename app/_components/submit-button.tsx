"use client";

import { useFormStatus } from "react-dom";
import type { ComponentProps, ReactNode } from "react";
import { Spinner } from "./spinner";

// 共通の送信ボタン。form の子で useFormStatus() の pending を読み、送信中は disabled＋Spinner を出す
// （YAT-41）。専用の formAction prop は設けず（実コードに単一 form 多ボタン分岐はない）、必要なら
// 標準の button 属性（formAction / name / value）を spread で渡せるようにしてある。スタイルは呼び出し
// 側の className に委ね、中身だけ inline-flex で中央寄せする（既存の flex-1 等のレイアウトを壊さない）。
type Props = ComponentProps<"button"> & {
  // 送信中に children を差し替える文言（省略時は children のまま Spinner を前置）。
  pendingLabel?: ReactNode;
};

export function SubmitButton({
  children,
  pendingLabel,
  className = "",
  disabled,
  type = "submit",
  ...rest
}: Props) {
  const { pending } = useFormStatus();
  // rest を先に spread し、不変条件（type / disabled / aria-busy）は後置で必ず勝たせる。
  return (
    <button
      {...rest}
      type={type}
      disabled={pending || disabled}
      aria-busy={pending}
      className={className}
    >
      <span className="inline-flex items-center justify-center gap-2">
        {pending && <Spinner className="size-4" />}
        {pending && pendingLabel !== undefined ? pendingLabel : children}
      </span>
    </button>
  );
}
