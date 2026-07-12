"use client";

import {
  useThemePreference,
  setThemePreference,
  type ThemePreference,
} from "../_hooks/use-theme";

// テーマ切替ボタン。preference ストアは use-theme に切り出し、sonner Toaster と共有する（YAT-41）。

const ORDER: ThemePreference[] = ["system", "light", "dark"];

const LABEL: Record<ThemePreference, string> = {
  system: "システム設定に追従",
  light: "ライトモード",
  dark: "ダークモード",
};

export function ThemeToggle() {
  const pref = useThemePreference();

  function cycle() {
    setThemePreference(ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length]);
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

function ThemeIcon({ kind }: { kind: ThemePreference }) {
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
