import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "ログイン · yatima",
};

// 自分専用アプリのログイン画面。proxy が未認証アクセスをここへ集める。
// ルートレイアウトのヘッダ（ナビ）も表示されるが、各リンク先は proxy が再び /login に戻すため実害はない。
export default function LoginPage() {
  return (
    <div className="mx-auto max-w-xs py-16">
      <h1 className="mb-8 font-display text-2xl font-extrabold tracking-tight">
        yatima
      </h1>
      <LoginForm />
    </div>
  );
}
