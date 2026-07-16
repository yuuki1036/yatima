import type { SupabaseClient } from "@supabase/supabase-js";
import Parser from "rss-parser";
import { isPubliclyRoutableHttpUrl } from "@/lib/net/ssrf";
import { safeFetchText } from "@/lib/net/safe-fetch";

// 情報源の自動発見（YAT-16）の検証ゲート。方式①（記事リンク発掘）/ 方式②（嗜好ベース提案）
// のどのフロントも、最終的に「候補サイト → autodiscovery → RSS パース成功で feed 実在確認 →
// eTLD+1 で既存 feeds と重複排除 → 承認待ちで feed_candidates に登録」の同一ゲートに収束する。
// LLM に feed URL を直接生成させず、実在する feed だけを通すのがこのゲートの役割。
// フロントは差し替え可能にし、本ファイルは候補サイト URL を受け取る形に保つ。
// 外部 URL の取得はすべて safeFetchText（manual redirect + 各ホップ SSRF 再検証）に寄せる。

const FETCH_TIMEOUT_MS = 12_000; // root HTML 取得
const PROBE_TIMEOUT_MS = 6_000; // 探索の RSS 検証。本番取得(parser.ts 15s)より短くし dead サイトの滞留を防ぐ
const DISCOVER_CONCURRENCY = 4;

// 探索専用の rss-parser。ネットワーク取得は safeFetchText が担い、この parser は取得済み XML の
// parseString だけに使う（parseURL は内部でリダイレクトを再検証せず追従するため使わない）。
const feedParser = new Parser();

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// SSRF ガード isPubliclyRoutableHttpUrl は lib/net/ssrf.ts に共通化（import 済み）。

// 自動発見ソースの低い初期 prior（feed_candidates.credibility の default と一致させる）。
// 未検証ソースを本番取得に混ぜないための承認制と対で、承認時に feeds へ低めに引き継ぐ。
const AUTODISCOVERED_CREDIBILITY = -0.3;

// root の <link rel=alternate> で取れない取りこぼし（小実験の歩留まり17%の主因）を埋める
// ためのサブパス探索リスト。head リンクが先に通れば探索はそこで止まる（後述 discoverFeedsForSite）。
const FEED_SUBPATHS = [
  "/feed",
  "/feed/",
  "/rss",
  "/rss.xml",
  "/feed.xml",
  "/atom.xml",
  "/index.xml",
  "/rss/",
  "/feed/atom",
  "/blog/feed",
  "/blog/rss",
  "/feeds/posts/default", // Blogger
  "/?feed=rss2", // WordPress
];

// eTLD+1 の算出で「サフィックス＋1ラベル」を登録単位とみなす集合。
// ① 多段 country-code TLD（co.jp 等）。素朴な「末尾2ラベル」では tld 部分しか取れない。
// ② ブログ系のマルチテナント基盤。方式①はブログを掘るため、ここを末尾2ラベルで畳むと
//    user-a.github.io と user-b.github.io を同一ソース扱いして別人のブログを取りこぼす。
// 厳密版が要れば public-suffix 系（psl / tldts）の導入を検討する（Issue 備考）。
const REGISTRABLE_SUFFIXES = new Set([
  // 多段 country-code TLD
  "co.jp",
  "or.jp",
  "ne.jp",
  "ac.jp",
  "go.jp",
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "co.nz",
  "com.br",
  // ブログ系マルチテナント基盤（サブドメイン＝別ブログ＝別ソース）
  "github.io",
  "substack.com",
  "wordpress.com",
  "blogspot.com",
  "hatenablog.com",
  "hatenadiary.jp",
  "ghost.io",
  "netlify.app",
  "vercel.app",
  "pages.dev",
  "bearblog.dev",
]);

export type DiscoveredFeed = {
  url: string; // RSS パース成功で実在確認した feed URL
  title: string | null;
  siteUrl: string | null;
  sourceDomain: string; // eTLD+1。重複排除・候補集約キー
};

export type DiscoveryInput = {
  siteUrl: string; // 候補サイト（方式①ならリンク先の origin）
  discoveredFrom?: string; // 発見元（記事 URL 等）。トレーサビリティ用
};

export type DiscoveryGateResult = {
  examined: number; // ドメイン重複排除後に検査したサイト数
  discovered: number; // feed を検出できたサイト数
  inserted: number; // feed_candidates に新規登録した数
  skippedExisting: number; // 既存 feeds と同一ドメインでスキップ
  skippedCandidate: number; // 既存候補・バッチ内重複でスキップ
};

// 簡易 eTLD+1。重複排除のドメイン正規化に使う。末尾2ラベルを基本とし、
// REGISTRABLE_SUFFIXES に該当するときだけ1ラベル繰り上げる。
export function eTLDPlusOne(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join(".");
  if (REGISTRABLE_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

// HTML の <link rel="alternate" type="application/(rss|atom)+xml" href> を拾う。
// cheerio 等を入れず link タグだけ正規表現で抽出する（依存を増やさない）。head 以外の
// 紛れ込みは RSS 検証段で弾かれるため、ここは緩く拾って後段の実在確認に委ねる。
function extractFeedLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?[^"'>]*\balternate\b/i.test(tag)) continue;
    if (!/type\s*=\s*["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      links.push(new URL(href, baseUrl).toString());
    } catch {
      // 相対解決に失敗する不正な href は捨てる
    }
  }
  return links;
}

// 候補 URL を RSS としてパースできれば「実在する feed」と判定する。取得は safeFetchText で
// manual redirect + SSRF 再検証を通し、取れた XML だけを parseString に渡す。
// 404・非フィード HTML・タイムアウトは fetch/parse が throw するので catch で null に倒す。
async function validateFeed(
  url: string,
): Promise<{ title: string | null; siteUrl: string | null } | null> {
  try {
    const fetched = await safeFetchText(url, { timeoutMs: PROBE_TIMEOUT_MS });
    // 理由は使わず捨てる: 1 サイトにつき head リンク＋サブパス 13 本を probe し大半が 404 なので、
    // ログに出すと溢れる（root 取得と違い件数が読めない）。
    if (!fetched.ok) return null;
    const parsed = await feedParser.parseString(fetched.text);
    const hasItems = (parsed.items?.length ?? 0) > 0;
    // title も items も無いものは feed の体を成さないので不採用。
    if (!parsed.title && !hasItems) return null;
    return { title: parsed.title ?? null, siteUrl: parsed.link ?? null };
  } catch {
    return null;
  }
}

// 1サイトから feed を1本発見する。① root HTML の <link rel=alternate> を優先し、
// 無ければ ② サブパス探索にフォールバックする。候補は人手承認なので1ドメイン1本で十分。
// 最初に RSS 検証を通った URL を返し、以降の探索は打ち切る（dead サイトの全探索を避ける）。
export async function discoverFeedsForSite(
  siteUrl: string,
): Promise<DiscoveredFeed | null> {
  const safe = isPubliclyRoutableHttpUrl(siteUrl);
  if (!safe) {
    console.warn(`[discover] スキップ（不正/非公開 URL）: ${siteUrl}`);
    return null;
  }
  const origin = safe.origin;
  const sourceDomain = eTLDPlusOne(safe.hostname);

  // ① root HTML から宣言された feed リンク（fail-soft: 取得失敗時はサブパス探索へ）。
  // 取得は safeFetchText 経由で manual redirect + 各ホップ SSRF 再検証を通す。
  let headLinks: string[] = [];
  try {
    const fetched = await safeFetchText(origin, { timeoutMs: FETCH_TIMEOUT_MS });
    if (fetched.ok) headLinks = extractFeedLinks(fetched.text, origin);
    // root は 1 サイト 1 回なので理由を出す（validateFeed の probe と違いログが溢れない）。
    else console.warn(`[discover] root 取得失敗: ${origin}: ${fetched.reason}`);
  } catch (e) {
    // root が落ちていてもサブパスが生きていることがあるので探索は続ける（理由は残す）
    console.warn(`[discover] root 取得失敗: ${origin}: ${errMsg(e)}`);
  }

  // head リンク → サブパスの順に候補を並べる。head リンクは別ホストを指しうるため
  // SSRF ガードを再度通す。重複 URL は除く。
  const ordered = [
    ...headLinks,
    ...FEED_SUBPATHS.map((p) => origin + p).filter((u) => !headLinks.includes(u)),
  ].filter((u) => isPubliclyRoutableHttpUrl(u) !== null);

  // 候補を並列で RSS 検証し、優先順（head リンク → サブパス）で最初に通った1本を採用する。
  // 順次 await だと dead サイトでタイムアウトが直列に積み上がる（最悪 13×timeout）ため並列化する。
  const verdicts = await Promise.all(ordered.map((u) => validateFeed(u)));
  for (let i = 0; i < ordered.length; i += 1) {
    const valid = verdicts[i];
    if (valid) {
      return {
        url: ordered[i],
        title: valid.title,
        siteUrl: valid.siteUrl ?? origin,
        sourceDomain,
      };
    }
  }
  console.warn(`[discover] feed 見つからず: ${origin}`);
  return null;
}

// feeds テーブルの既存ドメイン集合。url / site_url の両方から eTLD+1 を集めて重複排除の基準にする。
export async function loadExistingFeedDomains(
  supabase: SupabaseClient,
): Promise<Set<string>> {
  const { data, error } = await supabase.from("feeds").select("url, site_url");
  if (error) throw error;
  const set = new Set<string>();
  for (const f of (data ?? []) as { url: string; site_url: string | null }[]) {
    for (const u of [f.site_url, f.url]) {
      if (!u) continue;
      try {
        set.add(eTLDPlusOne(new URL(u).hostname));
      } catch {
        // 不正 URL はスキップ
      }
    }
  }
  return set;
}

// feed_candidates の既存ドメイン集合（status 不問）。承認待ち・却下済みを問わず再登録しない。
export async function loadCandidateDomains(
  supabase: SupabaseClient,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("feed_candidates")
    .select("source_domain");
  if (error) throw error;
  const set = new Set<string>();
  for (const c of (data ?? []) as { source_domain: string }[]) {
    if (c.source_domain) set.add(c.source_domain);
  }
  return set;
}

// 検証ゲート本体。候補サイト群を受け取り、検出 → 重複排除 → feed_candidates へ承認待ち登録する。
// 方式①/② のフロントはここに候補サイト URL を渡すだけでよい（発見ロジックを共有する）。
export async function runDiscoveryGate(
  supabase: SupabaseClient,
  inputs: DiscoveryInput[],
): Promise<DiscoveryGateResult> {
  // 入力をドメイン単位で畳む（同一ドメインの複数記事リンクを1回の探索にまとめる）。
  const byDomain = new Map<string, DiscoveryInput>();
  for (const inp of inputs) {
    try {
      const domain = eTLDPlusOne(new URL(inp.siteUrl).hostname);
      if (!byDomain.has(domain)) byDomain.set(domain, inp);
    } catch {
      // 不正 URL は無視
    }
  }

  // 重複排除の基準集合。取得失敗（throw）はゲートごと落とす — 基準が欠けたまま登録すると
  // 既存 feed と重複した未検証ソースを本番に混ぜるため、enrich.ts と違い fail-soft にしない。
  const existingDomains = await loadExistingFeedDomains(supabase);
  const existingCandidateDomains = await loadCandidateDomains(supabase);

  const targets = [...byDomain.values()];
  const result: DiscoveryGateResult = {
    examined: targets.length,
    discovered: 0,
    inserted: 0,
    skippedExisting: 0,
    skippedCandidate: 0,
  };

  // 検出は並列・fail-soft（1サイトの失敗が全体を止めない）。
  const discovered: { feed: DiscoveredFeed; discoveredFrom?: string }[] = [];
  for (let i = 0; i < targets.length; i += DISCOVER_CONCURRENCY) {
    const chunk = targets.slice(i, i + DISCOVER_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((t) => discoverFeedsForSite(t.siteUrl)),
    );
    settled.forEach((s, idx) => {
      if (s.status === "fulfilled" && s.value) {
        discovered.push({
          feed: s.value,
          discoveredFrom: chunk[idx].discoveredFrom,
        });
      } else if (s.status === "rejected") {
        // discoverFeedsForSite は内部で例外を握るので、ここに来るのは想定外バグ。握りつぶさず記録。
        console.error(
          `[discover] 探索が想定外に失敗: ${chunk[idx].siteUrl}: ${errMsg(s.reason)}`,
        );
      }
    });
  }
  result.discovered = discovered.length;

  // 既存 feeds・既存候補・バッチ内重複を eTLD+1 で弾いてから登録行を組む。
  const seenInBatch = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  for (const { feed, discoveredFrom } of discovered) {
    const domain = feed.sourceDomain;
    if (existingDomains.has(domain)) {
      result.skippedExisting += 1;
      continue;
    }
    if (existingCandidateDomains.has(domain) || seenInBatch.has(domain)) {
      result.skippedCandidate += 1;
      continue;
    }
    seenInBatch.add(domain);
    rows.push({
      url: feed.url,
      title: feed.title,
      site_url: feed.siteUrl,
      source_domain: domain,
      discovered_from: discoveredFrom ?? null,
      credibility: AUTODISCOVERED_CREDIBILITY,
      status: "pending",
    });
  }

  if (rows.length > 0) {
    // url unique 制約での衝突は無視（ドメイン重複をすり抜けた同一 URL の保険）。
    const { data, error } = await supabase
      .from("feed_candidates")
      .upsert(rows, { onConflict: "url", ignoreDuplicates: true })
      .select("id");
    if (error) throw error;
    result.inserted = data?.length ?? 0;
  }

  return result;
}
