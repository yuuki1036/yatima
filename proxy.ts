import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifyToken } from "@/lib/auth/session";

// Next.js 16 で middleware は proxy に改称（機能は同じ）。
// 自分専用アプリの認証ゲート（ログインは Google OAuth）: /login と静的アセット以外の全ルートをゲートする。
// Cookie の JWT 検証のみの楽観チェック（DB アクセスなし）。本筋の遮断は各 Server Action の
// requireSession も担う二段防御（公式: proxy だけを防御線にするな）。

const LOGIN_PATH = "/login";

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifyToken(token);

  // 認証済みで /login を開いたら TODAY へ送る。
  if (pathname === LOGIN_PATH) {
    if (session) {
      return NextResponse.redirect(new URL("/", req.nextUrl));
    }
    return NextResponse.next();
  }

  // /login/* は Google OAuth の開始・コールバック経路（未認証で通す。YAT-34）。
  // 認証成立はコールバックが担うので、ここでは素通しする。
  if (pathname.startsWith(`${LOGIN_PATH}/`)) {
    return NextResponse.next();
  }

  // 未認証は /login へ。リダイレクトは Server Action の POST も含めて遮断する。
  if (!session) {
    return NextResponse.redirect(new URL(LOGIN_PATH, req.nextUrl));
  }

  return NextResponse.next();
}

// 静的アセットと画像最適化は除外。それ以外（ページ・Server Action の POST 先）は全て通す。
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
