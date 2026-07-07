import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { createSession } from "@/lib/auth/session";
import {
  googleConfig,
  exchangeCodeForIdToken,
  verifyOwnerIdToken,
  GOOGLE_CALLBACK_PATH,
  OAUTH_STATE_COOKIE,
} from "@/lib/auth/google";

// YAT-34: Google ログインのコールバック。state を突き合わせ（CSRF）、認可コードを id_token に交換し、
// 署名・issuer・audience を検証したうえで所有者メール一致なら既存の createSession() で JWT Cookie を
// 発行して TODAY へ送る。失敗は理由を伏せて /login?error=google へ倒す（情報を与えない）。
export const dynamic = "force-dynamic";

function fail(origin: string, code: string) {
  return NextResponse.redirect(new URL(`/login?error=${code}`, origin));
}

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const cfg = googleConfig();
  if (!cfg) return fail(origin, "google_unconfigured");

  const cookieStore = await cookies();
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const savedState = cookieStore.get(OAUTH_STATE_COOKIE)?.value;

  // state Cookie は一度きり。成否に関わらず消す（リプレイ防止）。
  cookieStore.delete(OAUTH_STATE_COOKIE);

  // Google 側のエラー（同意拒否等）や state 不一致は CSRF/中断として弾く。
  if (!code || !state || !savedState || state !== savedState) {
    return fail(origin, "state");
  }

  try {
    const redirectUri = new URL(GOOGLE_CALLBACK_PATH, origin).href;
    const idToken = await exchangeCodeForIdToken(cfg, code, redirectUri);
    const isOwner = await verifyOwnerIdToken(cfg, idToken);
    if (!isOwner) return fail(origin, "denied"); // 別アカウント・未検証メール
    await createSession(); // 既存の共有セッション Cookie を発行（proxy/requireSession はそのまま）
    return NextResponse.redirect(new URL("/", origin));
  } catch (e) {
    console.warn("Google コールバック処理に失敗:", e);
    return fail(origin, "google");
  }
}
