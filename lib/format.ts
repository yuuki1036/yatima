export function formatDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
