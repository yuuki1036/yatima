import Parser from "rss-parser";
import { safeFetchText } from "@/lib/net/safe-fetch";

// 本番取得（ingest）の rss-parser ラッパー。RSS / Atom の両方をパースできる。
// ネットワーク取得は safeFetchText が担い、この parser は取得済み XML の parseString だけに使う
// （parseURL は内部でリダイレクトを再検証せず追従するため使わない）。discover.ts の検証ゲートと
// 同じ形（[[external-url-fetch-needs-ssrf-guard]]）。
const parser = new Parser();

export type ParsedItem = Parser.Item;
export type ParsedFeed = Parser.Output<Parser.Item>;

const FETCH_TIMEOUT_MS = 15_000; // 全リダイレクトホップ合計の時間予算（discover の PROBE_TIMEOUT_MS より長い本番取得）

// feed URL を取得してパースする。承認済み feed でも配信元は後から変化しうるため、取得のたびに
// リダイレクト各ホップを SSRF 再検証する（YAT-49 で「信頼入力として割り切る」案を採らず塞ぐ判断）。
// 取得不能は reason を載せて throw し、呼び出し側の per-feed fail-soft に委ねる。reason は
// ingest 経由で cron ログ（scripts/ingest.ts）に出る唯一の診断材料なので潰さない。
export async function fetchAndParse(url: string): Promise<ParsedFeed> {
  // allowContentType では絞らない: feed の Content-Type は配信側で割れており網羅を試みない
  // （実測で本番 feed が application/rss+xml・application/rdf+xml を返す）。XML かどうかは
  // 直後の parseString が throw して弾く（詳細は safe-fetch.ts の allowContentType 参照）。
  const fetched = await safeFetchText(url, { timeoutMs: FETCH_TIMEOUT_MS });
  if (!fetched.ok) throw new Error(`feed を取得できません（${fetched.reason}）`);
  return parser.parseString(fetched.text);
}
