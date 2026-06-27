import { logout } from "../login/actions";

// ヘッダのログアウト。セッション Cookie を破棄して /login へ戻る（Server Action）。
// クライアント状態を持たず Server Action を form にバインドするだけなので Server Component。
export function LogoutButton() {
  return (
    <form action={logout}>
      <button
        type="submit"
        className="border-b-2 border-transparent pb-0.5 font-mono text-xs tracking-widest text-muted transition-colors hover:text-foreground"
      >
        OUT
      </button>
    </form>
  );
}
