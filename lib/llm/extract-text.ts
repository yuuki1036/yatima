// content_html からタグを除去し先頭 maxChars 字に切り詰める。LLM 入力の整形用。
// 外部依存を足さず正規表現だけで処理する（要約に必要な精度で十分）。
export function htmlToInputText(html: string | null, maxChars = 2000): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ") // script/style はブロックごと除去
    .replace(/<[^>]+>/g, " ") // 残りのタグを除去
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ") // 連続空白を1つに圧縮
    .trim()
    .slice(0, maxChars);
}
