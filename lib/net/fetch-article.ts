import { extractFromHtml } from "@extractus/article-extractor";
import { safeFetchText } from "@/lib/net/safe-fetch";
import { htmlToInputText } from "@/lib/llm/extract-text";

// 外部 URL から本文を取得する共通処理（DB 非依存）。取得は safeFetchText（manual redirect + 各ホップ
// SSRF 再検証 + byte cap）に委ね、ここでは HTML/XML 以外を弾き article-extractor で本文を抽出する
// （htmlToInputText はタグ除去のみで本文抽出はしないため、この一段が必要＝YAT-32 design review F-A）。
// 記事本文の差し替え（enrich）と学習ソースの取り込み（source-discovery）が共用する。
// YAT-32 self-review SEC-1/SEC-2 でリダイレクト再検証と byte cap を追加、YAT-44 で safe-fetch に集約。

const FETCH_TIMEOUT_MS = 12_000; // リダイレクト追従を含む全体の時間予算
const MAX_CONTENT_CHARS = 200_000; // 抽出後本文の保存上限（さらに念のため）
// HTML 以外（画像/PDF 等）は本文抽出の対象外。明示された Content-Type がこれに合わなければ弾く。
// RSS の記事リンクは PDF/画像を指すことが実際にあり、弾いても本文が薄いまま要約が続くだけなので
// ここは絞る価値がある。他の safeFetchText 呼び出しが渡さない理由は safe-fetch.ts の
// allowContentType のコメント参照（YAT-57）。
const HTML_CONTENT_TYPE = /(text\/html|xhtml|text\/xml|application\/xml)/;

export type FetchedArticle = {
  title: string | null;
  contentHtml: string; // article-extractor が抽出した本文 HTML（本文領域のみ）
};

// 失敗は理由つきで返す（safeFetchText の SafeFetchResult と同形）。この関数は enrich と
// source-discovery が共有するプリミティブで、両者でログの適正粒度が違う（enrich は 1 実行 20 件で
// 理由を出す価値があり、source-discovery は候補数が読めず出すと溢れる）。どちらに合わせても
// 片方が損をするため、理由は返り値で配ってログ粒度は呼び出し側に決めさせる
// （[[shared-primitive-returns-reason-caller-logs]]・YAT-57）。
export type FetchArticleResult =
  | { ok: true; article: FetchedArticle }
  | { ok: false; reason: string };

// URL から本文を取得・抽出して返す。SSRF で弾かれた／取得失敗／本文が空なら ok:false（呼び出し側が
// fail-soft で扱う）。fetch/parse の例外はここで握らず投げる（呼び出し側のループが個別に握る）。
export async function fetchAndExtractArticle(
  rawUrl: string,
): Promise<FetchArticleResult> {
  const fetched = await safeFetchText(rawUrl, {
    timeoutMs: FETCH_TIMEOUT_MS,
    allowContentType: HTML_CONTENT_TYPE,
  });
  if (!fetched.ok) return { ok: false, reason: fetched.reason };

  const article = await extractFromHtml(fetched.text, fetched.finalUrl);
  const contentHtml = article?.content ?? "";
  // 取得は成功したが本文領域を取り出せなかった場合（ナビだけのページ・JS 描画等）。
  if (!contentHtml) return { ok: false, reason: "本文を抽出できなかった" };

  return {
    ok: true,
    article: {
      title: article?.title ?? null,
      contentHtml: contentHtml.slice(0, MAX_CONTENT_CHARS),
    },
  };
}

// 抽出本文の実テキスト長（タグ除去後）。「薄いページ（ナビだけ等）」の足切り判定に使う共通基準。
export function extractedTextLength(contentHtml: string): number {
  return htmlToInputText(contentHtml).length;
}
