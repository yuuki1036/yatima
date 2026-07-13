import { isPubliclyRoutableHttpUrl } from "@/lib/net/ssrf";

// 外部 URL を SSRF 一次ガードつきで取得する共通プリミティブ。リダイレクトを手動追従し、各ホップの
// URL を fetch 前に isPubliclyRoutableHttpUrl で再検証、レスポンスは byte 上限つきストリームで読む。
// 素の fetch / rss-parser.parseURL は既定でリダイレクトを追従し Location 先を再検証しないため、
// 外部由来 URL の取得はすべてこの関数に寄せる（[[external-url-fetch-needs-ssrf-guard]]）。
// DNS rebinding までは対応しない一次防御（ssrf.ts と同方針）。fetch-article（記事本文）/ discover
// （feed 発見）が共用する。

const MAX_REDIRECTS = 5; // 追従するリダイレクトの上限（ループ・遠回り防止）
const DEFAULT_MAX_BYTES = 5_000_000; // 取得 byte の既定上限（巨大レスポンスによるメモリ膨張を防ぐ）
const UA = "Mozilla/5.0 (compatible; yatima/1.0; +personal use)";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type SafeFetchOptions = {
  timeoutMs: number; // 全リダイレクトホップで共有する合計の時間予算
  maxBytes?: number; // 取得 byte 上限（既定 5MB）
  // Content-Type が明示され、かつこの正規表現にマッチしないレスポンスは弾く（未指定ヘッダは許容）。
  allowContentType?: RegExp;
};

// URL からテキストを取得する。取得できなければ null（fetch/timeout の例外は握らず投げ、呼び出し側の
// fail-soft に委ねる）。finalUrl はリダイレクト解決後の最終 URL（相対リンク解決の基準に使える）。
export async function safeFetchText(
  rawUrl: string,
  opts: SafeFetchOptions,
): Promise<{ text: string; finalUrl: string } | null> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
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
      current = new URL(location, safe.href).href; // 相対リダイレクトを解決し次ループで再検証
      continue;
    }

    if (!res.ok || !res.body) return null;

    if (opts.allowContentType) {
      const ctype = res.headers.get("content-type")?.toLowerCase() ?? "";
      if (ctype && !opts.allowContentType.test(ctype)) return null;
    }

    // byte 上限つきでストリーム読み込み。上限を超えたら捨てる（巨大ページの読み切りを避ける）。
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > maxBytes) {
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
    return { text: new TextDecoder("utf-8").decode(buf), finalUrl: safe.href };
  }

  return null; // リダイレクト過多
}
