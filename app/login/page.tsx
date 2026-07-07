import type { Metadata } from "next";
import { LoginForm } from "./login-form";
import { isGoogleAuthConfigured } from "@/lib/auth/google";

export const metadata: Metadata = {
  title: "ログイン · yatima",
};

// エラーコード→表示文言（理由は伏せて中断/不可のみ伝える）。
const ERROR_MESSAGES: Record<string, string> = {
  state: "ログインが中断されました。もう一度お試しください。",
  denied: "このアカウントではログインできません。",
  google: "Google ログインに失敗しました。パスワードでもログインできます。",
  google_unconfigured:
    "Google ログインは利用できません。パスワードでログインしてください。",
};

// 自分専用アプリのログイン画面。proxy が未認証アクセスをここへ集める。ルートレイアウトのヘッダは
// 未認証では出ないので（YAT-34）、この画面はロゴ＋ログイン手段だけのクリーンな見た目になる。
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const errorMessage = error ? ERROR_MESSAGES[error] : undefined;
  const googleEnabled = isGoogleAuthConfigured();

  return (
    <div className="mx-auto max-w-xs py-16">
      <h1 className="mb-8 font-display text-2xl font-extrabold tracking-tight">
        yatima
      </h1>

      {errorMessage && (
        <p
          role="alert"
          className="mb-6 border-l-2 border-accent bg-surface px-4 py-3 font-mono text-xs text-foreground"
        >
          {errorMessage}
        </p>
      )}

      {googleEnabled && (
        <>
          {/* 通常 GET で /login/google（OAuth 開始 route）へ。Server Action ではなく素のナビ。 */}
          <a
            href="/login/google"
            className="mb-6 block border-2 border-border px-3 py-2 text-center font-mono text-xs tracking-widest transition-colors hover:bg-foreground hover:text-background"
          >
            Google でログイン
          </a>
          <div className="mb-6 flex items-center gap-3">
            <span className="h-px flex-1 bg-line" />
            <span className="font-mono text-[10px] tracking-widest text-faint">
              または
            </span>
            <span className="h-px flex-1 bg-line" />
          </div>
        </>
      )}

      <LoginForm />
    </div>
  );
}
