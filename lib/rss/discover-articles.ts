import type { SupabaseClient } from "@supabase/supabase-js";
import {
  eTLDPlusOne,
  loadCandidateDomains,
  loadExistingFeedDomains,
  runDiscoveryGate,
  type DiscoveryGateResult,
  type DiscoveryInput,
} from "./discover";

// 情報源の自動発見（YAT-16）の発見フロント・方式①「記事リンク発掘」。
// 既に購読しているフィードの記事本文に張られた外部リンクを集め、ドメイン単位で畳んで
// 「複数の既存ソースから参照されている＝発見する価値の高いサイト」を候補に挙げる。
// 候補サイト URL を runDiscoveryGate に渡すところまでが本ファイルの責務で、feed の実在確認・
// 重複排除・承認待ち登録は検証ゲート（discover.ts）が担う。フロントは差し替え可能な層であり、
// 方式②（嗜好ベース提案）は同じゲートに別フロントとして後乗せする。

const DEFAULT_ARTICLE_LOOKBACK = 500; // 走査する直近記事数（published_at desc）
const DEFAULT_MAX_CANDIDATES = 40; // 1 回の発見でゲートに渡すサイト上限（探索コストの蓋）
const MIN_DISTINCT_SOURCES = 1; // この数未満のソースからしか参照されないドメインは捨てる

// 小実験で判明した「候補が製品/SaaS・巨大プラットフォームに偏る」問題への一次対処。
// 個人ブログ的ソースを掘る方式①の目的に対してノイズにしかならない登録ドメインを弾く。
// 完璧な網羅は狙わない（最終判断は承認制の人手）。明確な大手だけを列挙し、残りは
// ブログ的ヒューリスティックのスコアリングと人気度で沈める。
const BLOCKLIST_DOMAINS = new Set([
  // SNS・アグリゲータ・動画
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "reddit.com",
  "youtube.com",
  "youtu.be",
  "t.me",
  "bsky.app",
  "threads.net",
  "news.ycombinator.com",
  "producthunt.com",
  // コードホスト・パッケージレジストリ・Q&A
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "npmjs.com",
  "pypi.org",
  "crates.io",
  "rubygems.org",
  "packagist.org",
  "stackoverflow.com",
  "stackexchange.com",
  // リファレンス・ドキュメント基盤
  "wikipedia.org",
  "developer.mozilla.org",
  "w3.org",
  "readthedocs.io",
  "gitbook.io",
  // 論文・プレプリント（firehose 過ぎて個別ソースにならない）
  "arxiv.org",
  "doi.org",
  "semanticscholar.org",
  // CDN・アセット・短縮 URL・トラッキング
  "amazonaws.com",
  "cloudfront.net",
  "googleapis.com",
  "gstatic.com",
  "googleusercontent.com",
  "gravatar.com",
  "imgur.com",
  "wp.com",
  "substackcdn.com",
  "bit.ly",
  "t.co",
  "goo.gl",
  "buff.ly",
  "dlvr.it",
  "amzn.to",
  "feedburner.com",
  "web.archive.org",
  "archive.org",
  // ブログ系プラットフォームの素の root（user サブドメインは eTLD+1 で別ドメインに畳まれるため、
  // ここに残るのはプラットフォーム自体への直リンク = ブログ実体ではない）
  "substack.com",
  "medium.com",
  // 大手 SaaS・ストア（製品ページに偏る代表例）
  "google.com",
  "apple.com",
  "microsoft.com",
  "amazon.com",
  "notion.so",
  "figma.com",
  "slack.com",
]);

// ブログ系マルチテナント基盤。ここに該当する登録ドメインはブログである蓋然性が高いので加点する。
// discover.ts の REGISTRABLE_SUFFIXES（重複排除の登録単位補正）と概念は近いが、用途が違う
// （あちらは集約キーの算出、こちらはスコアリング）ので別集合として持つ。medium.com / dev.to /
// zenn.dev / qiita.com は登録単位こそ畳まれないが、ブログ的シグナルとして同様に扱う。
const BLOG_PLATFORM_DOMAINS = new Set([
  "github.io",
  "substack.com",
  "wordpress.com",
  "blogspot.com",
  "hatenablog.com",
  "hatenadiary.jp",
  "ghost.io",
  "bearblog.dev",
  "medium.com",
  "dev.to",
  "zenn.dev",
  "qiita.com",
  "note.com",
  "svbtle.com",
  "posthaven.com",
]);

// パスにブログらしさが滲むときの加点パターン（/blog, /posts, /writing, /2024/ など）。
const BLOG_PATH_RE = /\/(blog|posts?|writing|articles?|notes?|essays?)\b|\/(19|20)\d\d\//i;

export type DiscoverArticlesOptions = {
  lookback?: number; // 走査する直近記事数
  maxCandidates?: number; // ゲートに渡すサイト上限
};

export type DiscoverArticlesResult = DiscoveryGateResult & {
  scannedArticles: number; // content_html を走査した記事数
  candidateDomains: number; // フィルタ後にゲートへ渡したドメイン数
};

type ArticleRow = { url: string | null; content_html: string | null };

// content_html の <a href> から http(s) の絶対 URL を拾う。cheerio 等を足さず正規表現で抜く
// （extractFeedLinks / htmlToInputText と同じ方針）。相対リンクは baseUrl で解決し、自己ドメイン
// 判定で後段から自然に落ちる。mailto / javascript / アンカーは URL.protocol で弾く。
function extractOutboundUrls(html: string, baseUrl: string | null): URL[] {
  const out: URL[] = [];
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi)) {
    const href = m[1];
    if (!href || href.startsWith("#")) continue;
    let u: URL;
    try {
      u = baseUrl ? new URL(href, baseUrl) : new URL(href);
    } catch {
      continue; // 相対 href で baseUrl も無い等、解決できないものは捨てる
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    out.push(u);
  }
  return out;
}

// 1 ドメインの集計。人気度（参照してきた既存ソースの異なり数）とブログ的シグナルを溜める。
type Candidate = {
  domain: string; // eTLD+1（集約キー）
  sourceDomains: Set<string>; // このドメインを参照した記事側の登録ドメイン集合（人気度）
  hostCounts: Map<string, number>; // 観測したホスト別出現数（代表 origin の選定用）
  originByHost: Map<string, string>; // ホスト→最初に観測した origin（scheme を保つ）
  blogPathHit: boolean; // ブログらしいパスを1度でも観測したか
};

// 登録ドメインがブログ系プラットフォーム上か。github.io 等は eTLD+1 が user.github.io に畳まれる
// （マルチテナント補正）ため完全一致では拾えない。サフィックス一致でサブドメインブログも拾う。
function isOnBlogPlatform(domain: string): boolean {
  for (const p of BLOG_PLATFORM_DOMAINS) {
    if (domain === p || domain.endsWith(`.${p}`)) return true;
  }
  return false;
}

function blogScore(c: Candidate): number {
  let s = 0;
  if (isOnBlogPlatform(c.domain)) s += 2;
  // blog.* サブドメインで観測されていれば加点
  for (const host of c.hostCounts.keys()) {
    if (host.startsWith("blog.")) {
      s += 1;
      break;
    }
  }
  if (c.blogPathHit) s += 1;
  return s;
}

// 代表 origin を選ぶ。feed は blog.* サブドメインに居がちなので優先し、次に出現数の多いホスト。
// 同数なら短いホスト（apex/www 寄り）を採る。ゲートはこの origin の root + サブパスを探索する。
function representativeOrigin(c: Candidate): string {
  const hosts = [...c.hostCounts.keys()].sort((a, b) => {
    const blogA = a.startsWith("blog.") ? 1 : 0;
    const blogB = b.startsWith("blog.") ? 1 : 0;
    if (blogA !== blogB) return blogB - blogA;
    const cntA = c.hostCounts.get(a) ?? 0;
    const cntB = c.hostCounts.get(b) ?? 0;
    if (cntA !== cntB) return cntB - cntA;
    return a.length - b.length;
  });
  return c.originByHost.get(hosts[0]) ?? `https://${hosts[0]}`;
}

// 直近記事の外部リンクから候補サイト（DiscoveryInput）を組み立てる。発見ロジックの中核。
// 既存 feeds・既存候補ドメインはここで先に除外し、上位 N の枠を既知ソースで浪費しないようにする
// （ゲートも最終的に再除外するため、ここは枠の節約が目的）。
export async function collectCandidatesFromArticles(
  supabase: SupabaseClient,
  opts: DiscoverArticlesOptions = {},
): Promise<{ inputs: DiscoveryInput[]; scannedArticles: number }> {
  const lookback = opts.lookback ?? DEFAULT_ARTICLE_LOOKBACK;

  const { data, error } = await supabase
    .from("articles")
    .select("url, content_html")
    .not("content_html", "is", null)
    .order("published_at", { ascending: false })
    .limit(lookback);
  if (error) throw error;
  const articles = (data ?? []) as ArticleRow[];

  // 既知ドメイン（既存 feeds + 全候補）。基準取得の失敗はフロントごと落とす
  // — 基準が欠けたまま既知ソースを候補に混ぜないため、ゲートと同じ厳格方針にする。
  const [existingFeedDomains, candidateDomains] = await Promise.all([
    loadExistingFeedDomains(supabase),
    loadCandidateDomains(supabase),
  ]);
  const known = new Set<string>([...existingFeedDomains, ...candidateDomains]);

  const byDomain = new Map<string, Candidate>();
  for (const a of articles) {
    if (!a.content_html) continue;
    // 記事側（自分が購読しているソース）の登録ドメイン。自己リンク除外と人気度の異なり数に使う。
    let sourceDomain: string | null = null;
    if (a.url) {
      try {
        sourceDomain = eTLDPlusOne(new URL(a.url).hostname);
      } catch {
        sourceDomain = null;
      }
    }

    for (const u of extractOutboundUrls(a.content_html, a.url)) {
      const host = u.hostname.toLowerCase();
      let domain: string;
      try {
        domain = eTLDPlusOne(host);
      } catch {
        continue;
      }
      if (BLOCKLIST_DOMAINS.has(domain)) continue;
      if (known.has(domain)) continue;
      if (sourceDomain && domain === sourceDomain) continue; // 自己リンク

      let c = byDomain.get(domain);
      if (!c) {
        c = {
          domain,
          sourceDomains: new Set(),
          hostCounts: new Map(),
          originByHost: new Map(),
          blogPathHit: false,
        };
        byDomain.set(domain, c);
      }
      if (sourceDomain) c.sourceDomains.add(sourceDomain);
      c.hostCounts.set(host, (c.hostCounts.get(host) ?? 0) + 1);
      if (!c.originByHost.has(host)) c.originByHost.set(host, u.origin);
      if (!c.blogPathHit && BLOG_PATH_RE.test(u.pathname)) c.blogPathHit = true;
    }
  }

  // スコア = 人気度（異なりソース数）×3 + ブログ的シグナル。人気度を主軸に、ブログらしさで微調整。
  const ranked = [...byDomain.values()]
    .filter((c) => c.sourceDomains.size >= MIN_DISTINCT_SOURCES)
    .map((c) => ({ c, score: c.sourceDomains.size * 3 + blogScore(c) }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return b.c.sourceDomains.size - a.c.sourceDomains.size;
    })
    .slice(0, opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES);

  const inputs: DiscoveryInput[] = ranked.map(({ c }) => ({
    siteUrl: representativeOrigin(c),
    discoveredFrom: `article-links:${c.sourceDomains.size}src`,
  }));

  return { inputs, scannedArticles: articles.length };
}

// 方式①の入口。記事リンクから候補を集め、検証ゲートに通して承認待ち登録まで一気通貫で回す。
// 週次 cron / Server Action / 手動スクリプトのどこからでも SupabaseClient を注入して呼べる。
export async function discoverFromArticles(
  supabase: SupabaseClient,
  opts: DiscoverArticlesOptions = {},
): Promise<DiscoverArticlesResult> {
  const { inputs, scannedArticles } = await collectCandidatesFromArticles(
    supabase,
    opts,
  );
  const gate = await runDiscoveryGate(supabase, inputs);
  return { ...gate, scannedArticles, candidateDomains: inputs.length };
}
