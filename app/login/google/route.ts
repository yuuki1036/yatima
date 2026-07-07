import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import {
  googleConfig,
  buildGoogleAuthUrl,
  GOOGLE_CALLBACK_PATH,
  OAUTH_STATE_COOKIE,
} from "@/lib/auth/google";

// YAT-34: Google ログインの開始。state（CSRF 用ワンタイム）を Cookie に置き、Google の同意画面へ送る。
// 認証済み判定より前の未認証経路なので proxy が /login/* を素通しする（proxy.ts 参照）。
export const dynamic = "force-dynamic";

const STATE_MAX_AGE_SEC = 600; // 10 分（同意〜コールバックの猶予）

export async function GET(req: NextRequest) {
  const cfg = googleConfig();
  if (!cfg) {
    // env 未設定＝Google ログイン無効。パスワードで入ってもらう。
    return NextResponse.redirect(
      new URL("/login?error=google_unconfigured", req.nextUrl.origin),
    );
  }

  const state = crypto.randomUUID();
  const redirectUri = new URL(GOOGLE_CALLBACK_PATH, req.nextUrl.origin).href;

  const cookieStore = await cookies();
  cookieStore.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax", // トップレベル GET リダイレクトで戻るため lax が必要
    path: "/",
    maxAge: STATE_MAX_AGE_SEC,
  });

  return NextResponse.redirect(
    buildGoogleAuthUrl(cfg.clientId, redirectUri, state),
  );
}
