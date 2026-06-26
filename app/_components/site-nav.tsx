"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// ヘッダのグローバルナビ。現在パスに応じてアクティブ表示（赤＋下線）を切り替える。
const ITEMS = [
  { href: "/", label: "TODAY" },
  { href: "/list", label: "LIST" },
  { href: "/feeds", label: "FEEDS" },
] as const;

export function SiteNav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-5 font-mono text-xs tracking-widest">
      {ITEMS.map((item) => {
        const active =
          item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={
              active
                ? "border-b-2 border-accent pb-0.5 text-accent"
                : "border-b-2 border-transparent pb-0.5 text-muted transition-colors hover:text-foreground"
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
