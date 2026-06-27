import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";

// 自分専用アプリの共有パスワード認証。ユーザーは1人なので payload は所有者マーカーのみ持つ。
// 照合パスワード(APP_PASSWORD)と JWT 署名鍵(SESSION_SECRET)は環境変数（サーバー専用・NEXT_PUBLIC_ は付けない）。

export const SESSION_COOKIE = "yatima_session";
const SESSION_SUBJECT = "owner";
// 自分専用なので長めに保つ（毎回ログインは煩雑）。30日。
const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 30;

// JWT 偽造耐性はこの鍵の強度に完全依存する。弱鍵だと sub="owner" を偽造され全認証を
// バイパスされるため、未設定だけでなく最小長（32 文字 = openssl rand -base64 32 相当）も強制する。
const MIN_SECRET_LENGTH = 32;

// 共有パスワードはこのアプリ唯一の認証要素。レート制限を置かない代わりに、オンライン総当たりが
// 事実上不可能な高エントロピーを最小長で要求する（弱いパスワードの設定自体を弾く）。
const MIN_PASSWORD_LENGTH = 16;

function encodedSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET が未設定または短すぎます（${MIN_SECRET_LENGTH} 文字以上必須・openssl rand -base64 32 で生成）`,
    );
  }
  return new TextEncoder().encode(secret);
}

// 入力パスワードを APP_PASSWORD と比較する。
// 両者を固定長(SHA-256)ダイジェスト化してから timingSafeEqual で比べることで、
// 比較時間が入力長・一致進捗に依存せず（正解長のリークもなく）定数時間になる。
// 自前のバイト比較ループは JIT 最適化で定数時間が保証されないため node:crypto に委ねる。
export function verifyPassword(input: string): boolean {
  const expected = process.env.APP_PASSWORD;
  if (!expected || expected.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `APP_PASSWORD が未設定または短すぎます（${MIN_PASSWORD_LENGTH} 文字以上必須・レート制限を置かない分エントロピーで守る）`,
    );
  }
  const a = createHash("sha256").update(input).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// JWT 文字列を検証して payload を返す（不正・期限切れ・署名不一致なら null）。
// next/headers に依存しない純関数なので proxy からも使える。
export async function verifyToken(
  token: string | undefined,
): Promise<JWTPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, encodedSecret(), {
      algorithms: ["HS256"],
    });
    if (payload.sub !== SESSION_SUBJECT) return null;
    return payload;
  } catch {
    // 署名不一致・期限切れ等。痕跡は呼び出し側の判断に委ね、ここでは握り潰す。
    return null;
  }
}

// ログイン成功時にセッション Cookie を発行する（Server Action から呼ぶ）。
export async function createSession(): Promise<void> {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(SESSION_SUBJECT)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SEC}s`)
    .sign(encodedSecret());

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });
}

// ログアウト時に Cookie を破棄する。
export async function deleteSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

// 現在のリクエストが認証済みかを返す（Server Component / Action 用）。
export async function getSession(): Promise<JWTPayload | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return verifyToken(token);
}

// 未認証なら /login へ送る Server Action 用ガード。
// proxy で全ルートをゲートしているが、公式ガイド（DAL パターン）が「proxy だけを防御線に
// するな」と明記しているため、直 POST 対策として各 mutation 冒頭で呼ぶ二段目の防御。
// 素の throw ではなく redirect にするのは、useActionState の戻り値契約を壊さず、
// error.tsx 不在でも画面を壊さないため（公式 verifySession も redirect する）。
// 通常は proxy が先に弾くため、ここへ到達するのは直 POST か Cookie 破損時に限られる。
export async function requireSession(): Promise<void> {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
}
