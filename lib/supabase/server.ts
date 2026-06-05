import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// anon キー + Cookie 連携の読み取り用クライアント（Server Component / Server Action）。
// Phase1 は認証セッション未使用だが、将来 Supabase Auth を入れても流れを変えずに済むよう
// 最初から @supabase/ssr 流儀で用意しておく。
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) => {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server Component から呼ばれた場合 set は失敗しうる。
            // セッション更新は middleware 側で行う前提なので無視してよい。
          }
        },
      },
    },
  );
}
