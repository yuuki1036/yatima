import { isPubliclyRoutableHttpUrl } from "@/lib/net/ssrf";

// 外部 URL を SSRF 一次ガードつきで取得する共通プリミティブ。リダイレクトを手動追従し、各ホップの
// URL を fetch 前に isPubliclyRoutableHttpUrl で再検証、レスポンスは byte 上限つきストリームで読む。
// 素の fetch / rss-parser.parseURL は既定でリダイレクトを追従し Location 先を再検証しないため、
// 外部由来 URL の取得はすべてこの関数に寄せる（[[external-url-fetch-needs-ssrf-guard]]）。
// DNS rebinding までは対応しない一次防御（ssrf.ts と同方針）。fetch-article（記事本文）/ discover
// （feed 発見）/ parser（feed 本番取得）が共用する。承認済み feed も配信元が後から変化しうるので
// 例外にしない（YAT-49）。
// 常に UTF-8 でデコードするため、非 UTF-8 の feed / ページは文字化けする。feed は YAT-49 で
// active 34 本を実測し全て UTF-8 だったが、記事本文（fetch-article）と discover の取得対象は
// 任意の外部サイトで非有界・未計測。charset 対応が不要と確認できているのは feed 経路だけ。
// 高水準 API（rss-parser の parseURL 等）から寄せる際は、charset・timeout の意味・既定ヘッダも
// 一緒に剥がれる点に注意。

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

// 失敗時は reason に理由を載せる。呼び出し側が fail-soft で捨てるか、ログ・例外メッセージに使うかを
// 選べるようにするため（単なる null だと「ガードに弾かれた」と「404」が区別できず、運用ログから
// 原因を辿れない）。ここで理由を作るのは、どの条件で落ちたかを知っているのがこの関数の内側だけだから。
export type SafeFetchResult =
  | { ok: true; text: string; finalUrl: string } // finalUrl はリダイレクト解決後の最終 URL（相対リンク解決の基準に使える）
  | { ok: false; reason: string };

// URL からテキストを取得する（fetch/timeout の例外は握らず投げ、呼び出し側の fail-soft に委ねる）。
export async function safeFetchText(
  rawUrl: string,
  opts: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const safe = isPubliclyRoutableHttpUrl(current);
    // 初回・リダイレクト先とも fetch 前に弾く。hop>0 は「追従先が内部を指した」= 元 URL からは
    // 読み取れない失敗なので、どちらだったかを reason に残す。
    if (!safe) {
      return {
        ok: false,
        reason:
          hop === 0
            ? `SSRF ガード不通過: ${current}`
            : `リダイレクト先が SSRF ガード不通過: ${current}（${hop} ホップ目）`,
      };
    }

    const res = await fetch(safe.href, {
      method: "GET",
      redirect: "manual", // 自動追従させず、Location を自分で再検証してから次へ
      headers: { "user-agent": UA },
      signal,
    });

    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get("location");
      if (!location) {
        return { ok: false, reason: `${res.status} だが Location ヘッダが無い` };
      }
      current = new URL(location, safe.href).href; // 相対リダイレクトを解決し次ループで再検証
      continue;
    }

    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    if (!res.body) return { ok: false, reason: `レスポンスボディが空 (HTTP ${res.status})` };

    if (opts.allowContentType) {
      const ctype = res.headers.get("content-type")?.toLowerCase() ?? "";
      if (ctype && !opts.allowContentType.test(ctype)) {
        return { ok: false, reason: `Content-Type 不許可: ${ctype}` };
      }
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
            return {
              ok: false,
              reason: `サイズ上限超過（${maxBytes} bytes を超えた）`,
            };
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
    return {
      ok: true,
      text: new TextDecoder("utf-8").decode(buf),
      finalUrl: safe.href,
    };
  }

  return { ok: false, reason: `リダイレクトが ${MAX_REDIRECTS} 回を超えた` };
}
