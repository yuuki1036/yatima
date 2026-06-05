import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// service_role キーで RLS をバイパスする書き込み用クライアント。
// 呼び出し元はサーバーのみ: cron スクリプト (scripts/ingest.ts) と Server Actions。
// service_role キーは NEXT_PUBLIC_ ではないためクライアントバンドルに値は乗らない。
// （tsx 実行のスクリプトと共有するため "server-only" は付けない）
export function createAdminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "Supabase の環境変数が未設定です: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
