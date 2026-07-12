"use client";

import { Toaster as SonnerToaster } from "sonner";
import { useEffectiveTheme } from "../_hooks/use-theme";

// sonner Toaster のラッパー。theme は自前の data-theme ストア（use-theme）と連動させ、
// ユーザーが OS と異なる light/dark を手動選択したときも toast の見た目を一致させる（YAT-41）。
// sonner 標準の theme="system" は prefers-color-scheme を独自に見るため使わない。
// offset はヘッダ高さ分下げる: top-center のままだとロゴ／ナビに重なりクリックを妨げるため（実機確認）。
export function Toaster() {
  const theme = useEffectiveTheme();
  return (
    <SonnerToaster
      theme={theme}
      position="top-center"
      offset="72px"
      richColors
      closeButton
    />
  );
}
