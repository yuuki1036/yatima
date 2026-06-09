// LLM が SYSTEM_PROMPT の「マークダウン禁止」を無視して付けがちな
// 見出し（# 記号）・装飾（**bold**）・「要約:」等のラベルを除去し、
// UI 一覧に出せるプレーンな 1 段落へ整える。プロンプトと二重の保険。
export function sanitizeSummary(raw: string): string {
  let s = raw.trim();
  // 行頭の Markdown 見出し記号を除去（行の中身は残す）
  s = s.replace(/^[ \t]*#{1,6}[ \t]*/gm, "");
  // 太字/斜体マーカーを剥がす（中身は残す）
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
  // 改行・連続空白を単一スペースに畳む（UI は 1 段落表示のため）
  s = s.replace(/\s+/g, " ").trim();
  // 先頭に残りがちな「要約」ラベルを除去（「記事の要約」「記事要約」「要約」+ 区切り）
  s = s.replace(/^(記事の?要約|要約)\s*[:：]?\s*/, "").trim();
  return s;
}
