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
    .slice(0, maxChars)
    // slice は UTF-16 のコード単位で切るので、絵文字などのサロゲートペアが境界で割れると上位サロゲート
    // だけが残る。そのまま JSON に載せると Anthropic API が本文ごと 400（no low surrogate in string）で
    // 拒否し、Batches では 1 件の記事がバッチ全体の create を毎回落とす（YAT-79）。孤立したサロゲートは
    // U+FFFD に置き換えて、送る文字列を常に well-formed にする。
    .toWellFormed();
}
