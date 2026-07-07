import { extractFromHtml } from "@extractus/article-extractor";
import { isPubliclyRoutableHttpUrl } from "@/lib/net/ssrf";
import { htmlToInputText } from "@/lib/llm/extract-text";

// 外部 URL から本文を取得する共通処理（DB 非依存）。SSRF を一次ガードだけで済ませず、
// リダイレクトを手動追従して各ホップを再検証し、レスポンスは byte 上限つきストリームで読む。
// 本文抽出は article-extractor が担う（htmlToInputText はタグ除去のみで本文抽出はしないため、
// この一段が必要＝YAT-32 design review F-A）。記事本文の差し替え（enrich）と学習ソースの取り込み
// （source-discovery）が共用する。YAT-32 self-review SEC-1/SEC-2 でリダイレクト再検証と byte cap を追加。

const FETCH_TIMEOUT_MS = 12_000; // リダイレクト追従を含む全体の時間予算
const MAX_REDIRECTS = 5; // 追従するリダイレクトの上限（ループ・遠回り防止）
const MAX_FETCH_BYTES = 5_000_000; // 取得 HTML の byte 上限（巨大レスポンスによるメモリ膨張を防ぐ）
const MAX_CONTENT_CHARS = 200_000; // 抽出後本文の保存上限（さらに念のため）
const UA = "Mozilla/5.0 (compatible; yatima/1.0; +personal use)";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type FetchedArticle = {
  title: string | null;
  contentHtml: string; // article-extractor が抽出した本文 HTML（本文領域のみ）
};

// リダイレクトを手動追従しつつ HTML を byte 上限つきで取得する。各ホップの URL を fetch 前に
// SSRF 再検証するので、リダイレクト先が内部/予約レンジでも実際には fetch しない（DNS rebinding
// の厳密対策までは行わない一次防御の範囲＝ssrf.ts と同方針）。取得できなければ null。
async function safeFetchHtml(
  rawUrl: string,
): Promise<{ html: string; finalUrl: string } | null> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS); // 全ホップで共有＝合計 12s 予算
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const safe = isPubliclyRoutableHttpUrl(current);
    if (!safe) return null; // 初回・リダイレクト先とも fetch 前に弾く

    const res = await fetch(safe.href, {
      method: "GET",
      redirect: "manual", // 自動追従させず、Location を自分で再検証してから次へ
      headers: { "user-agent": UA },
      signal,
    });

    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get("location");
      if (!location) return null;
      // 相対リダイレクトを現在 URL 基準で解決し、次ループの先頭で再度 SSRF 検証する。
      current = new URL(location, safe.href).href;
      continue;
    }

    if (!res.ok || !res.body) return null;

    // HTML 以外（画像/PDF 等）は本文抽出の対象外。Content-Type が明示され、かつ html/xml 系で
    // ないものは弾く（未指定は許容してパーサに委ねる）。
    const ctype = res.headers.get("content-type")?.toLowerCase() ?? "";
    if (ctype && !/(text\/html|xhtml|text\/xml|application\/xml)/.test(ctype)) {
      return null;
    }

    // byte 上限つきでストリーム読み込み。上限を超えたら「巨大ページ」として捨てる（切り詰め本文の
    // パースはしない＝部分 HTML の誤抽出を避ける）。
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > MAX_FETCH_BYTES) {
            await reader.cancel();
            return null;
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }

    const buf = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      buf.set(c, offset);
      offset += c.byteLength;
    }
    const html = new TextDecoder("utf-8").decode(buf);
    return { html, finalUrl: safe.href };
  }

  return null; // リダイレクト過多
}

// URL から本文を取得・抽出して返す。SSRF で弾かれた／取得失敗／本文が空なら null（呼び出し側が
// fail-soft で扱う）。fetch/parse の例外はここで握らず投げる（呼び出し側のループが個別に握る）。
export async function fetchAndExtractArticle(
  rawUrl: string,
): Promise<FetchedArticle | null> {
  const fetched = await safeFetchHtml(rawUrl);
  if (!fetched) return null;

  const article = await extractFromHtml(fetched.html, fetched.finalUrl);
  const contentHtml = article?.content ?? "";
  if (!contentHtml) return null;

  return {
    title: article?.title ?? null,
    contentHtml: contentHtml.slice(0, MAX_CONTENT_CHARS),
  };
}

// 抽出本文の実テキスト長（タグ除去後）。「薄いページ（ナビだけ等）」の足切り判定に使う共通基準。
export function extractedTextLength(contentHtml: string): number {
  return htmlToInputText(contentHtml).length;
}
