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
  // ストリーム読み込みの前に判定するので、渡せば無関係な巨大ボディの読み切りを避けられる。
  //
  // 運用方針（YAT-57 で 4 呼び出し箇所を検討した結論）: 渡すのは fetch-article だけ。
  // 「取得対象の Content-Type が実際に多様」かつ「弾いても失うものが小さい」経路にだけ渡す。
  // - fetch-article: RSS の記事リンクは PDF/画像を指すことが実際にある。弾いても本文が
  //   薄いまま要約が続くだけ（fail-soft・回復可能）なので、渡す価値がある。
  // - parser / discover の probe（feed 取得）: 配信側の Content-Type が rss+xml / atom+xml /
  //   rdf+xml / xml / text/xml / text/plain と割れており、網羅を試みると誤弾きする。実測でも
  //   本番 feed の一部が application/rss+xml・application/rdf+xml を返し、HTML 用の正規表現では
  //   落ちる。XML かどうかは後段の parseString が throw して弾くので前段フィルタは不要。
  // - discover の root 取得: root は事実上ほぼ HTML なので絞る便益が小さい一方、HTML を
  //   text/plain 等で配る設定ミスのサイトを弾くと、そのサイトの feed が別ホスト（FeedBurner や
  //   feeds.* 等）にある場合に恒久的に発見不能になる（フォールバックのサブパス探索は同一
  //   origin しか叩かないため救えない）。節約は上限 maxBytes の一回きりで回復可能、損失は
  //   恒久的かつ静かなので、非対称を見て渡さない判断にした。
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
