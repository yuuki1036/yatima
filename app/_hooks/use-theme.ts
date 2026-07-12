"use client";

import { useSyncExternalStore } from "react";

// テーマ preference（localStorage "theme"）の共有ストア。ThemeToggle と sonner Toaster の
// 両方が同じ effective(light/dark) を購読できるよう、theme-toggle が持っていたストアロジックを
// ここへ切り出した。effective 値は layout の THEME_INIT が <html data-theme> を先に確定させるので
// 見た目のソースは data-theme、本フックはそれを React 側から購読する経路を与える（YAT-41）。

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "theme";
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb); // 別タブでの変更に追従
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

function getSnapshot(): ThemePreference {
  // render 中に同期で呼ばれるため、ストレージ全ブロック環境（SecurityError）でも throw させない。
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s === "light" || s === "dark" || s === "system" ? s : "system";
  } catch {
    return "system";
  }
}

// サーバ／hydration 時は localStorage を読めないため system を返す（実際の見た目は
// layout のインラインスクリプトが data-theme を先に確定させているのでズレない）。
function getServerSnapshot(): ThemePreference {
  return "system";
}

// preference を実際の light/dark に解決する（system のみ OS 設定を見る）。
function resolveEffective(pref: ThemePreference): "light" | "dark" {
  if (pref === "dark") return "dark";
  if (pref === "light") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

// preference を購読する（ThemeToggle 用）。
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// effective を <html data-theme> に反映し、購読側へ通知する。
export function setThemePreference(pref: ThemePreference) {
  // 永続化できない環境でも見た目の切替は止めない（setItem は throw しうる）。
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // ignore: persistence は best-effort
  }
  document.documentElement.dataset.theme = resolveEffective(pref);
  listeners.forEach((l) => l());
}

// effective(light/dark) を購読する外部ストア。preference の listeners に加え、
// system 選択時の OS 色設定変化（prefers-color-scheme）にも追従する。
function subscribeEffective(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
    mq.removeEventListener("change", cb);
  };
}

function getEffectiveSnapshot(): "light" | "dark" {
  return resolveEffective(getSnapshot());
}

// effective(light/dark) を購読する（sonner Toaster の theme 連動用）。preference の変化と
// system 選択中の OS 設定変化の両方に追従する。effect 内 setState を避けるため
// useSyncExternalStore で直接購読する。SSR/hydration は "light" を返すが、実際の見た目は layout の
// THEME_INIT が data-theme を先に確定させるのでズレず、toast の初期表示も稀なので実害はない。
export function useEffectiveTheme(): "light" | "dark" {
  return useSyncExternalStore(
    subscribeEffective,
    getEffectiveSnapshot,
    () => "light",
  );
}
