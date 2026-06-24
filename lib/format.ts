export function formatDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// JST 基準の「今日」(YYYY-MM-DD)。cron は UTC で動くため日付境界を JST に固定する。
// キュレーション確定日・取得日の判定で共通利用し、環境間の日付ズレ事故を防ぐ。
export function todayJst(now: number = Date.now()): string {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Error / Supabase の PostgrestError（message を持つ素のオブジェクト）/ その他を
// 読めるメッセージ文字列に変換する。catch した値をそのまま UI に出すと "[object Object]" に
// なるのを防ぐ。
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return String(e);
}
