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

// 外部由来（RSS フィード）の記事タイトルを LLM の document に渡す前に無害化する。
// プロンプトインジェクションの本命防御は system prompt 側（記事内の指示に従わない旨の明示）で、
// これは制御文字・不可視文字・双方向テキスト制御による細工を潰す保険層。
// null / 実質空文字は "" を返す（呼び出し側でフォールバックや filter(Boolean) に載せる）。
export function sanitizeTitle(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw;
  // C0 / C1 制御文字（タブ・改行含む）と DEL をスペース化
  s = s.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ");
  // ゼロ幅・不可視文字（ZWSP / ZWNJ / ZWJ / word joiner / BOM / soft hyphen）を除去
  s = s.replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "");
  // 双方向テキスト制御を除去: bidi マーク（LRM/RLM/ALM）＋ override/embedding（U+202A-202E）＋ isolate（U+2066-2069）
  s = s.replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "");
  // タグ文字（U+E0000-E007F。不可視 ASCII 密輸ベクタ）を除去。u フラグでコードポイント単位に扱う
  s = s.replace(/[\u{E0000}-\u{E007F}]/gu, "");
  // 改行・連続空白を単一スペースへ畳む
  s = s.replace(/\s+/g, " ").trim();
  return s;
}
