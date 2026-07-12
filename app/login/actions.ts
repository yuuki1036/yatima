"use server";

import { redirect } from "next/navigation";
import { deleteSession } from "@/lib/auth/session";

// セッション Cookie を破棄してログイン画面へ。ログインは Google OAuth（/login/google）が担うため、
// この Server Action はログアウトのみを持つ。
export async function logout(): Promise<void> {
  await deleteSession();
  redirect("/login");
}
