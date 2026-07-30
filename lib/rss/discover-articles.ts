import type { SupabaseClient } from "@supabase/supabase-js";
import {
  eTLDPlusOne,
  loadCandidateDomains,
  loadExistingFeedDomains,
  runDiscoveryGate,
  type DiscoveryGateResult,
  type DiscoveryInput,
} from "./discover";
import { formatArticleLinksProvenance } from "../feeds/discovered-from";

// 情報源の自動発見（YAT-16）の発見フロント・方式①「記事リンク発掘」。
// 既に購読しているフィードの記事本文に張られた外部リンクを集め、ドメイン単位で畳んで
// 「複数の既存ソースから参照されている＝発見する価値の高いサイト」を候補に挙げる。
// 候補サイト URL を runDiscoveryGate に渡すところまでが本ファイルの責務で、feed の実在確認・
// 重複排除・承認待ち登録は検証ゲート（discover.ts）が担う。フロントは差し替え可能な層であり、
// 方式②（嗜好ベース提案）は同じゲートに別フロントとして後乗せする。

const DEFAULT_ARTICLE_LOOKBACK = 500; // 走査する直近記事数（published_at desc）
const DEFAULT_MAX_CANDIDATES = 40; // 1 回の発見でゲートに渡すサイト上限（探索コストの蓋）
// 人気度（参照してきた既存ソースの異なり数）の主軸しきい値（tunable）。YAT-65 で 1 → 2。
// 旧値 1 は 0 媒体（参照元記事の url が全て欠損）だけを落とす実質ほぼ全通しで、1 媒体クラスが
// 流入の大半を占めて承認 UI が回らなくなっていた（件数の実測は YAT-65 参照。運用値なので
// ここには焼き込まない）。
// 値 2 は表示層の NOTABLE_SOURCE_COUNT（lib/feeds/discovery-display.ts）と同じ「2 媒体以上＝
// 複数の独立ソースが参照＝強いシグナル」の語彙。片方を動かすなら両方を見直すこと
// （層が違うので import はせず、定数はそれぞれの層に置いたまま相互参照だけ張る）。
//
// ここで落とすことには「候補として登録しない」以上の意味がある。詳細は discover.ts の
// loadCandidateDomains のコメント（status 不問ゆえ却下はドメインを永久に焼く）。
// 要点だけ: **ゲートで落とすのは可逆、登録してから却下するのは不可逆**。だから低価値な候補は
// 却下ではなくここで落とす（今週 1 媒体でも、来週 2 媒体が貼れば通る）。
const MIN_DISTINCT_SOURCES = 2;

// ただし人気度だけで切ると方式①の目的（個人ブログ的ソースの発掘）を殺す。個人ブログは
// 構造的に被参照数が少なく、1 媒体クラスには thezvi.substack.com や colah.github.io のような
// 「まさに掘りたい良質な個人ブログ」が混ざる。**量のノブだけ回すと、母集団で少数派の良質群が
// 真っ先に消える。** そこで被参照 1 件でも明確にブログ形なら通す逃げ道を置く（tunable）。
//
// 2 以上＝「ブログ基盤に載っている（+2 単独で到達）」または「blog.* サブドメインとブログ的パスの
// 両方（+1 +1）」を要求する水準。大手メディアはブログ的パス加点で 1 まで上がることがあるが
// （BLOG_PATH_RE は /articles/ や /2024/ に当たる）、ブログ基盤加点が付かないので 2 には届かない。
// **余裕は 1 点しかない**ので 1 に下げると大手メディアが全面的に流入する。
// 既知のトレードオフ: ブログ基盤 +2 だけで単独通過できるため、プラットフォームのサポートページや
// 基盤上のスパムブログも通る。最終的な篩は承認制の人手に委ねる設計（[[feed-autodiscovery-validation-gate]]）。
const MIN_BLOG_SCORE_FOR_SINGLE_SOURCE = 2;

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
  // 判定は eTLD+1 なので **ccTLD 版は別ドメイン扱いで、ここに個別に書かないと効かない**
  // （`amazon.com` は `amazon.co.jp` を覆わない）。YAT-65 のゲート引き上げ後に残った候補を
  // 見て amazon.co.jp を追加した。同種の取りこぼしを足すときはこの性質に注意する。
  "google.com",
  "apple.com",
  "microsoft.com",
  "amazon.com",
  "amazon.co.jp",
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
  gateStats: CandidateGateStats; // 登録ゲートの通過/棄却の内訳
};

// 登録ゲート（passesCandidateGate）の内訳。棄却側は inputs に残らないため、閾値が厳しすぎる／
// 緩すぎるを後から判断する唯一の材料になる。cron ログと dry-run の両方に出す。
export type CandidateGateStats = {
  examinedDomains: number; // blocklist 通過後・ゲート適用前のドメイン数
  passed: number; // ゲートを通った数
  droppedNoSource: number; // 参照元が 0 媒体（articles.url が解決できず size=0）
  droppedLowSignal: number; // 1 媒体だがブログ形でもない（＝今回厳しくした分の本体）
  passedByBlogEscape: number; // 1 媒体だがブログ形で救済された数
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

// 登録ドメインがブログ系プラットフォーム上か（blogScore の +2 成分）。github.io 等は eTLD+1 が
// user.github.io に畳まれる（マルチテナント補正）ため完全一致では拾えない。サフィックス一致で
// サブドメインブログも拾う。
function isOnBlogPlatform(domain: string): boolean {
  for (const p of BLOG_PLATFORM_DOMAINS) {
    if (domain === p || domain.endsWith(`.${p}`)) return true;
  }
  return false;
}

// ブログらしさの加点（0〜4）。ブログ基盤 +2 / blog.* サブドメイン +1 / ブログ的パス +1。
// 注意: BLOG_PATH_RE は `/articles/` や `/2024/` にも当たるため、**大手メディアの記事 URL は
// たいてい +1 が付く**（bloomberg / forbes / theverge / npr の URL 形で実測）。つまり大手の
// blogScore は 0 ではなく 1。逃げ道の閾値 2 までの余裕はわずか 1 点しかないので、
// MIN_BLOG_SCORE_FOR_SINGLE_SOURCE を 1 に下げると大手メディアが全面的に流入する。
function blogScore(c: BlogShapeInput): number {
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

// blogScore / passesCandidateGate が実際に見るフィールドだけを切り出した入力型。
// Candidate 全体を要求しないことで、テストが originByHost 等のダミーを作らずに済む。
export type BlogShapeInput = {
  domain: string;
  sourceDomains: Set<string>;
  hostCounts: Map<string, number>;
  blogPathHit: boolean;
};

// 候補をゲートに通すか。純関数として切り出して単体検証できるようにする
// （閾値・判定条件を持つ他モジュールと同じ流儀: lib/ranking/feed-health.ts）。
//
// 条件は「参照元が 1 媒体以上」を絶対の下限としたうえで、
//   ① 2 媒体以上（人気度の主軸） または
//   ② 1 媒体でも明確にブログ形（個人ブログの救済）
// のいずれか。
//
// 下限 1 が要るのは、`sourceDomains` へは参照元記事の url が解決できたときだけ加算されるため
// （articles.url は nullable）**size が 0 になりうる**から。旧実装の `>= 1` はこの 0 媒体クラスを
// 弾いていた唯一のケースで、②を OR で足すときに素通りさせると `article-links:0src` が登録され、
// parseArticleLinksSourceCount が n > 0 を要求するので承認 UI の媒体バッジが丸ごと消える。
export function passesCandidateGate(c: BlogShapeInput): boolean {
  if (c.sourceDomains.size < 1) return false;
  return (
    c.sourceDomains.size >= MIN_DISTINCT_SOURCES ||
    blogScore(c) >= MIN_BLOG_SCORE_FOR_SINGLE_SOURCE
  );
}

// 閾値の値そのものをテストから固定するために公開する（判定ロジックのテストだけでは数値の
// 書き換えに気づけない: [[mutation-test-what-the-test-actually-guards]]）。
export const CANDIDATE_GATE_THRESHOLDS = {
  MIN_DISTINCT_SOURCES,
  MIN_BLOG_SCORE_FOR_SINGLE_SOURCE,
} as const;

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
): Promise<{
  inputs: DiscoveryInput[];
  scannedArticles: number;
  gateStats: CandidateGateStats;
}> {
  const lookback = opts.lookback ?? DEFAULT_ARTICLE_LOOKBACK;

  const { data, error } = await supabase
    .from("articles")
    .select("url, content_html")
    .not("content_html", "is", null)
    // published_at は nullable。Postgres は DESC で NULLS FIRST がデフォルトのため、
    // 明示しないと日付欠落記事が先頭に滞留し lookback 枠を食う（enrich.ts / embed.ts と同作法）。
    .order("published_at", { ascending: false, nullsFirst: false })
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

  // ゲートを通す/落とすを分けて数える。落とした側は inputs に残らないので、ここで数えないと
  // 「厳しすぎて良い候補を落とし始めた」ことに誰も気づけない（ゲートを厳しくする変更を入れる
  // 瞬間が、棄却理由が要る瞬間になる: [[shared-primitive-returns-reason-caller-logs]]）。
  // 集計だけなら DB も課金も増えないので、dry-run とログの両方で観測できるようにする。
  const all = [...byDomain.values()];
  const passed = all.filter((c) => passesCandidateGate(c));
  const gateStats: CandidateGateStats = {
    examinedDomains: all.length,
    passed: passed.length,
    droppedNoSource: all.filter((c) => c.sourceDomains.size < 1).length,
    droppedLowSignal: all.filter(
      (c) => c.sourceDomains.size >= 1 && !passesCandidateGate(c),
    ).length,
    passedByBlogEscape: passed.filter(
      (c) => c.sourceDomains.size < MIN_DISTINCT_SOURCES,
    ).length,
  };

  // スコア = 人気度（異なりソース数）×3 + ブログ的シグナル。人気度を主軸に、ブログらしさで微調整。
  const ranked = passed
    .map((c) => ({ c, score: c.sourceDomains.size * 3 + blogScore(c) }))
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return b.c.sourceDomains.size - a.c.sourceDomains.size;
    })
    .slice(0, opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES);

  const inputs: DiscoveryInput[] = ranked.map(({ c }) => ({
    siteUrl: representativeOrigin(c),
    discoveredFrom: formatArticleLinksProvenance(c.sourceDomains.size),
  }));

  return { inputs, scannedArticles: articles.length, gateStats };
}

// 方式①の入口。記事リンクから候補を集め、検証ゲートに通して承認待ち登録まで一気通貫で回す。
// 週次 cron / Server Action / 手動スクリプトのどこからでも SupabaseClient を注入して呼べる。
export async function discoverFromArticles(
  supabase: SupabaseClient,
  opts: DiscoverArticlesOptions = {},
): Promise<DiscoverArticlesResult> {
  const { inputs, scannedArticles, gateStats } =
    await collectCandidatesFromArticles(supabase, opts);
  const gate = await runDiscoveryGate(supabase, inputs);
  return { ...gate, scannedArticles, candidateDomains: inputs.length, gateStats };
}
