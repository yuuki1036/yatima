import type { Metadata } from "next";
import { Archivo, Inter, IBM_Plex_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { getSession } from "@/lib/auth/session";
import { SiteNav } from "./_components/site-nav";
import { ThemeToggle } from "./_components/theme-toggle";
import { LogoutButton } from "./_components/logout-button";
import { Toaster } from "./_components/toaster";

// 描画前に preference を effective(light/dark) に解決して <html data-theme> をセットする。
// React hydration より前に同期実行され、FOUC（一瞬のライト→ダークのちらつき）を防ぐ。
const THEME_INIT = `(function(){try{var p=localStorage.getItem('theme')||'system';var d=p==='dark'||(p!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light';}catch(e){}})();`;

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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // ヘッダ（ロゴ・ナビ・ログアウト）は認証済みのときだけ出す。未認証で見えるのは /login だけなので、
  // ログイン画面にアプリの chrome が透けるのを防ぐ（YAT-34）。proxy が /login 以外を未認証で弾くため、
  // 実質「/login では非表示・それ以外では表示」になる。
  const session = await getSession();

  return (
    <html
      lang="ja"
      suppressHydrationWarning
      className={`${inter.variable} ${archivo.variable} ${ibmPlexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background font-sans text-foreground">
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        {session && (
          <header className="border-b-2 border-border">
            <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4">
              <Link
                href="/"
                className="font-display text-lg font-extrabold tracking-tight"
              >
                yatima
              </Link>
              {/* テーマ・ログアウト: 狭幅はロゴと同じ行の右端（ml-auto）、広幅は最右端（order-last）。 */}
              <div className="order-2 ml-auto flex items-center gap-5 sm:order-3 sm:ml-0">
                <ThemeToggle />
                <LogoutButton />
              </div>
              {/* ナビ: 狭幅は w-full で2行目に単独で回り込ませ見切れを防ぐ。
                  広幅は sm:ml-auto で右クラスタに寄せ、従来どおり1行に収める。 */}
              <div className="order-3 w-full sm:order-2 sm:ml-auto sm:w-auto">
                <SiteNav />
              </div>
            </div>
          </header>
        )}
        <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
          {children}
        </main>
        <Toaster />
      </body>
    </html>
  );
}
