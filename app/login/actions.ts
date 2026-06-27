"use server";

import { redirect } from "next/navigation";
import { createSession, deleteSession, verifyPassword } from "@/lib/auth/session";

// useActionState で誤りメッセージを返すための型。
export type LoginState = { error: string } | null;

// 共有パスワードを照合し、合致すればセッション Cookie を発行して TODAY へ送る。
export async function login(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const password = String(formData.get("password") ?? "");
  if (!verifyPassword(password)) {
    // 入力欄が空でも誤りでも同じ文言（情報を与えない）。
    return { error: "パスワードが違います" };
  }
  await createSession();
  // redirect は例外で制御を抜けるため、return より後ろには到達しない。
  redirect("/");
}

// セッション Cookie を破棄してログイン画面へ。
export async function logout(): Promise<void> {
  await deleteSession();
  redirect("/login");
}
