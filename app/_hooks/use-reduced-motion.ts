import { useSyncExternalStore } from "react";

// OS の「視差効果を減らす」設定（prefers-reduced-motion）を SSR セーフに購読する。
// CSS の @media だけでは setTimeout 駆動の状態更新（カードの index 前進など）は止まらないため、
// JS 側でも reduced を読み、タイマーを張らず即確定する分岐に使う。
const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(callback: () => void) {
  if (typeof window === "undefined") return () => {};
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getSnapshot() {
  return window.matchMedia(QUERY).matches;
}

function getServerSnapshot() {
  // サーバ／初回 hydration では false（通常アニメ側）に固定し、hydration mismatch を避ける。
  // reduced ユーザーは初回 1 フレームだけ通常状態を描くが、操作起点の演出なので体感影響はない。
  return false;
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
