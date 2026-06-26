import type { Metadata } from "next";
import { Archivo, Inter, IBM_Plex_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { SiteNav } from "./_components/site-nav";

// 本文・タイトル
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

// ディスプレイ（ワードマーク・特大インデックス番号）。Archivo は可変フォントなので
// weight 指定は不要（Tailwind の font-extrabold 等で任意ウェイトを使う）。
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
});

// ラベル・ナビ・メタ（uppercase + letter-spacing）。IBM Plex Mono は静的フォントなので
// 使用ウェイトを明示する。
const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  weight: ["400", "500", "600"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "yatima",
  description: "自分専用 AI 情報収集 RSS リーダー",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ja"
      className={`${inter.variable} ${archivo.variable} ${ibmPlexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background font-sans text-foreground">
        <header className="border-b-2 border-border">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-6 px-4 py-4">
            <Link
              href="/"
              className="font-display text-lg font-extrabold tracking-tight"
            >
              yatima
            </Link>
            <SiteNav />
          </div>
        </header>
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
