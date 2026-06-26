"use client";

import { useEffect, useSyncExternalStore } from "react";

type Preference = "system" | "light" | "dark";

const ORDER: Preference[] = ["system", "light", "dark"];
const STORAGE_KEY = "theme";

// ── preference の外部ストア（localStorage）。useSyncExternalStore で購読する。
// effect 内 setState を避けつつ SSR/CSR のスナップショットを React に正しく解決させる。
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb); // 別タブでの変更に追従
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

function getSnapshot(): Preference {
  // useSyncExternalStore は render 中に同期で呼ぶため、ストレージが完全にブロックされた
  // 環境（SecurityError）でも throw させない。THEME_INIT と同じく fail-soft で system に倒す。
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s === "light" || s === "dark" || s === "system" ? s : "system";
  } catch {
    return "system";
  }
}

// サーバ／hydration 時は localStorage を読めないため system を返す（実際の見た目は
// layout のインラインスクリプトが data-theme を先に確定させているのでズレない）。
function getServerSnapshot(): Preference {
  return "system";
}

// preference を実際の light/dark に解決する（system のみ OS 設定を見る）。
function resolveEffective(pref: Preference): "light" | "dark" {
  if (pref === "dark") return "dark";
  if (pref === "light") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

// effective を <html data-theme> に反映し、購読側へ通知する。
function setPreference(pref: Preference) {
  // 永続化できない環境でも見た目の切替は止めない（setItem は throw しうる）。
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // ignore: persistence は best-effort
  }
  document.documentElement.dataset.theme = resolveEffective(pref);
  listeners.forEach((l) => l());
}

const LABEL: Record<Preference, string> = {
  system: "システム設定に追従",
  light: "ライトモード",
  dark: "ダークモード",
};

export function ThemeToggle() {
  const pref = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  // system 選択中は OS 設定の変化に追従する（昼夜の自動切替など）。setState は行わない。
  useEffect(() => {
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      document.documentElement.dataset.theme = mq.matches ? "dark" : "light";
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  function cycle() {
    setPreference(ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length]);
  }

  return (
    <button
      type="button"
      onClick={cycle}
      aria-label={`テーマ: ${LABEL[pref]}（クリックで切替）`}
      title={`テーマ: ${LABEL[pref]}`}
      className="flex h-8 w-8 items-center justify-center border border-border text-foreground transition-colors hover:bg-foreground hover:text-background"
    >
      <ThemeIcon kind={pref} />
    </button>
  );
}

function ThemeIcon({ kind }: { kind: Preference }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (kind === "light") {
    // 太陽
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
      </svg>
    );
  }
  if (kind === "dark") {
    // 月
    return (
      <svg {...common}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    );
  }
  // システム（モニター）
  return (
    <svg {...common}>
      <rect x="3" y="4" width="18" height="12" rx="0" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}
