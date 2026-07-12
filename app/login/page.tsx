import type { Metadata } from "next";
import { isGoogleAuthConfigured } from "@/lib/auth/google";

export const metadata: Metadata = {
  title: "ログイン · yatima",
};

// エラーコード→表示文言（理由は伏せて中断/不可のみ伝える）。
const ERROR_MESSAGES: Record<string, string> = {
  state: "ログインが中断されました。もう一度お試しください。",
  denied: "このアカウントではログインできません。",
  google: "Google ログインに失敗しました。もう一度お試しください。",
  google_unconfigured: "Google ログインが設定されていません。",
};

// 自分専用アプリのログイン画面。proxy が未認証アクセスをここへ集める。ルートレイアウトのヘッダは
// 未認証では出ないので（YAT-34）、この画面はロゴ＋ログイン手段だけのクリーンな見た目になる。
// ログイン手段は Google 認証のみ（YAT-39 でパスワードログインを撤去）。env が未設定だと入口が
// なくなるため、その場合は設定エラーを明示して無言のブランクを避ける。
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const errorMessage = error ? ERROR_MESSAGES[error] : undefined;
  const googleEnabled = isGoogleAuthConfigured();

  if (!googleEnabled) {
    // env 未設定＝唯一の手段が使えず締め出し。どの env が欠けているかはサーバログにだけ出し、
    // 未認証で誰でも見られる画面には具体名を出さない（構成の推測材料を与えない）。
    const missing = [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "OWNER_EMAIL",
    ].filter((k) => !process.env[k]);
    console.warn(`[login] Google 認証が未設定です。欠けている環境変数: ${missing.join(", ")}`);
  }

  return (
    <div className="mx-auto max-w-xs py-16">
      <h1 className="mb-8 font-display text-2xl font-extrabold tracking-tight">
        yatima
      </h1>

      {/* Google 未設定時は下の専用ブロックが唯一の案内になるため、汎用バナーは出さない
          （二重 alert の回避）。state/denied/google 等のエラーは Google 開始後にしか出ず、
          その経路は googleEnabled=true が前提なので、抑制しても取りこぼしは無い。 */}
      {googleEnabled && errorMessage && (
        <p
          role="alert"
          className="mb-6 border-l-2 border-accent bg-surface px-4 py-3 font-mono text-xs text-foreground"
        >
          {errorMessage}
        </p>
      )}

      {googleEnabled ? (
        // 通常 GET で /login/google（OAuth 開始 route）へ。Server Action ではなく素のナビ。
        <a
          href="/login/google"
          className="block border-2 border-border px-3 py-2 text-center font-mono text-xs tracking-widest transition-colors hover:bg-foreground hover:text-background"
        >
          Google でログイン
        </a>
      ) : (
        // 唯一の手段が未設定＝ログイン不能。締め出しの事実だけを伝える（原因はサーバログ側）。
        <p
          role="alert"
          className="border-l-2 border-accent bg-surface px-4 py-3 font-mono text-xs leading-relaxed text-foreground"
        >
          Google ログインが設定されていません。サーバの環境変数を確認してください。
        </p>
      )}
    </div>
  );
}
