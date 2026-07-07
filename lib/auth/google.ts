import "server-only";
import { jwtVerify, createRemoteJWKSet, type JWTPayload } from "jose";

// YAT-34: Google OAuth（Authorization Code フロー）。既存の共有パスワード認証を置き換えず、
// 「Google でログイン → ID トークンをサーバ検証 → 所有者メールなら既存の createSession() で
// 同じ JWT Cookie を発行」する軽量方式。proxy / requireSession / logout は無変更のまま再利用する。
// 単一所有者アプリなので「許可メール = OWNER_EMAIL 1 件」で十分（ユーザーテーブルは持たない）。
// 新依存は足さず jose（既存）で ID トークンを検証する。

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
// Google の署名鍵（JWKS）。createRemoteJWKSet が取得・キャッシュ・ローテーションを扱う。
const JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);
// Google が id_token に載せる issuer（両表記がありうるので両方許可する）。
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export const GOOGLE_CALLBACK_PATH = "/login/google/callback";
// CSRF 用ワンタイム state を保持する Cookie（開始 route が発行し callback が突き合わせる）。
export const OAUTH_STATE_COOKIE = "yatima_oauth_state";

type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  ownerEmail: string;
};

// env が3点そろっていれば設定を返す（1つでも欠ければ null＝Google ログインは無効でパスワードのみ）。
export function googleConfig(): GoogleConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const ownerEmail = process.env.OWNER_EMAIL;
  if (!clientId || !clientSecret || !ownerEmail) return null;
  return { clientId, clientSecret, ownerEmail };
}

export function isGoogleAuthConfigured(): boolean {
  return googleConfig() !== null;
}

// 同意画面へ送る authorize URL を組む。scope は openid/email のみ（プロフィールは不要）。
// state は呼び出し側が発行して Cookie と突き合わせる（CSRF 対策）。
export function buildGoogleAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email",
    state,
    prompt: "select_account",
    access_type: "online",
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

// 認可コードを id_token に交換する。失敗は例外を投げる（呼び出し側が /login?error へ倒す）。
export async function exchangeCodeForIdToken(
  cfg: GoogleConfig,
  code: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new Error(`Google トークン交換に失敗: ${res.status}`);
  }
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) throw new Error("id_token がレスポンスに無い");
  return json.id_token;
}

type GoogleIdToken = JWTPayload & {
  email?: string;
  email_verified?: boolean | string;
};

// id_token を検証し、所有者本人（メール一致＋検証済み）なら true。署名・issuer・audience を
// jose で厳格に検証したうえで、email_verified と OWNER_EMAIL 一致を確認する。
// aud を自分の client_id に固定するのが肝（他アプリ向けトークンの流用を防ぐ）。
export async function verifyOwnerIdToken(
  cfg: GoogleConfig,
  idToken: string,
): Promise<boolean> {
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: GOOGLE_ISSUERS,
    audience: cfg.clientId,
  });
  const t = payload as GoogleIdToken;
  const verified = t.email_verified === true || t.email_verified === "true";
  const email = typeof t.email === "string" ? t.email.toLowerCase() : "";
  return verified && email === cfg.ownerEmail.toLowerCase();
}
