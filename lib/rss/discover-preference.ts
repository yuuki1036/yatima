import type { SupabaseClient } from "@supabase/supabase-js";
import {
  runDiscoveryGate,
  type DiscoveryGateResult,
  type DiscoveryInput,
} from "./discover";
import {
  createTavilyClient,
  type TavilyClient,
  type TavilyResult,
} from "./tavily";
import { createSourceSelector, type SourceSelector } from "../llm/select-sources";
import { loadTagPrefs } from "../ranking/preferences";
import { tagLabel } from "../tags/vocabulary";
import { formatPreferenceProvenance } from "../feeds/discovered-from";

// 情報源の自動発見（YAT-38）の発見フロント・方式②「嗜好ベース提案」。
// タグ嗜好の上位テーマを起点に Tavily で候補サイトを検索し、LLM で購読価値のあるサイトを
// 選別してから、候補サイト URL を runDiscoveryGate に渡す。feed の実在確認・重複排除・承認待ち
// 登録はゲート（discover.ts）が担う。方式①（記事リンク発掘）が「今読んでいる記事の参照先」しか
// 掘れないのに対し、方式②はまだ接点のない良質ソースへ発見範囲を広げる。
//
// 外部依存（Tavily / LLM）は interface + factory で注入可能にし、鍵が無い環境（ビルド・テスト）でも
// null で fail-soft に縮退する。cron スクリプトから SupabaseClient を注入して呼ぶ。

const DEFAULT_MAX_THEMES = 5; // 検索するテーマ数（＝Tavily クエリ数）の上限。無料枠を使い切らない蓋
const DEFAULT_MAX_RESULTS_PER_QUERY = 5; // 1 クエリあたりの検索結果数
const MIN_PREF_WEIGHT = 0; // この重み以下のタグは検索起点にしない（正の嗜好だけを掘る）

export type DiscoverPreferenceOptions = {
  maxThemes?: number;
  maxResultsPerQuery?: number;
  tavily?: TavilyClient; // 省略時は createTavilyClient()。テストや dry-run で差し替え可能
  selector?: SourceSelector; // 省略時は createSourceSelector()
};

// 検索起点にするテーマ（嗜好上位のタグ）。
export type DiscoveryTheme = {
  slug: string; // タグ leaf slug（provenance の起点）
  label: string; // 日本語ラベル（検索クエリ・UI 用）
  weight: number; // 嗜好の重み（降順選定に使用）
};

export type DiscoverPreferenceResult = DiscoveryGateResult & {
  themes: number; // 検索に使ったテーマ数
  candidateSites: number; // LLM 選別を通しゲートへ渡したサイト数
};

// 嗜好起点の検索クエリを組む。テーマの日本語ラベルに「継続購読できる情報源」へ寄せる語を足す
// 定型テンプレート（LLM でのクエリ展開はコスト増なので初手は定型・YAT-15 の方針）。
// ドメイン中立にする（"技術" 等で絞らない）: タグ語彙は tech に限らず science/business/life 等も
// 含み、嗜好上位が非テックのこともある。テック語を混ぜると非テックテーマで的外れな検索になる。
export function buildQuery(label: string): string {
  return `${label} ブログ おすすめ`;
}

// タグ嗜好の上位テーマを選ぶ。重み降順で、正の重みのものだけを maxThemes 件まで。
// 同点は slug 昇順で決定的に並べる（実行ごとのぶれを避ける）。
export function selectThemes(
  prefs: Map<string, number>,
  maxThemes: number,
): DiscoveryTheme[] {
  return [...prefs.entries()]
    .filter(([, weight]) => weight > MIN_PREF_WEIGHT)
    .sort((a, b) => {
      if (a[1] !== b[1]) return b[1] - a[1];
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    })
    .slice(0, maxThemes)
    .map(([slug, weight]) => ({ slug, label: tagLabel(slug), weight }));
}

// 検索する予定のテーマと生成クエリを返す（外部 API を叩かない・DB read のみ）。dry-run の
// 安全なプレビュー用。実際の候補サイトは Tavily/LLM を叩かないと出せないが、テーマ選定と
// クエリ生成という決定的な部分だけは無料で確認できる（--dry-run が課金呼び出しを起こさない契約）。
export async function planPreferenceSearch(
  supabase: SupabaseClient,
  opts: Pick<DiscoverPreferenceOptions, "maxThemes"> = {},
): Promise<{ theme: DiscoveryTheme; query: string }[]> {
  const maxThemes = opts.maxThemes ?? DEFAULT_MAX_THEMES;
  const prefs = await loadTagPrefs(supabase);
  return selectThemes(prefs, maxThemes).map((theme) => ({
    theme,
    query: buildQuery(theme.label),
  }));
}

// 嗜好上位テーマから候補サイト（DiscoveryInput）を組み立てる。テーマごとに Tavily 検索 →
// LLM 選別を回し、選ばれた URL を provenance 付きで集約する。同一 URL は先勝ちで 1 度だけ入れる
// （ゲートも eTLD+1 で最終重複排除するが、ここは無駄な検査を減らす枠の節約）。
// Tavily / LLM のどちらかが未設定（鍵なし）なら空を返す（fail-soft）。
export async function collectCandidatesFromPreferences(
  supabase: SupabaseClient,
  opts: DiscoverPreferenceOptions = {},
): Promise<{ inputs: DiscoveryInput[]; themes: DiscoveryTheme[] }> {
  const tavily = opts.tavily ?? createTavilyClient();
  const selector = opts.selector ?? createSourceSelector();
  if (!tavily || !selector) {
    console.warn(
      "[discover] 方式② スキップ（TAVILY_API_KEY / ANTHROPIC_API_KEY 未設定）",
    );
    return { inputs: [], themes: [] };
  }

  const maxResults = opts.maxResultsPerQuery ?? DEFAULT_MAX_RESULTS_PER_QUERY;

  const plan = await planPreferenceSearch(supabase, opts);
  const themes = plan.map((p) => p.theme);
  if (themes.length === 0) return { inputs: [], themes: [] };

  const inputs: DiscoveryInput[] = [];
  const seenUrls = new Set<string>();

  // テーマは直列。並列化しても Tavily 無料枠・LLM レート的な旨みは薄く、fail-soft の切り分けを
  // 単純にするため 1 テーマの失敗が他を巻き込まないよう try/catch で囲う。
  for (const { theme, query } of plan) {
    let results: TavilyResult[];
    try {
      results = await tavily.search(query, { maxResults });
    } catch (e) {
      console.warn(`[discover] Tavily 検索失敗（${theme.label}）: ${errMsg(e)}`);
      continue;
    }
    if (results.length === 0) continue;

    let selected: string[];
    try {
      selected = await selector.select({
        themeLabel: theme.label,
        candidates: results,
      });
    } catch (e) {
      console.warn(`[discover] LLM 選別失敗（${theme.label}）: ${errMsg(e)}`);
      continue;
    }

    // 決定的ガード（層3）: 選別結果を「この検索で実在が確認できた URL」に絞る。HaikuSourceSelector
    // 内にも同じ包含チェックがあるが、selector は opts で差し替え可能な注入点。幻覚・injection 由来の
    // 一覧外 URL がゲート（=外部 fetch）に届かないよう、選別実装に依存しない choke point でも弾く。
    const allowed = new Set(results.map((r) => r.url));

    for (const url of selected) {
      if (!allowed.has(url) || seenUrls.has(url)) continue;
      seenUrls.add(url);
      inputs.push({
        siteUrl: url,
        discoveredFrom: formatPreferenceProvenance(theme.slug),
      });
    }
  }

  return { inputs, themes };
}

// 方式②の入口。嗜好起点で候補を集め、検証ゲートに通して承認待ち登録まで一気通貫で回す。
export async function discoverFromPreferences(
  supabase: SupabaseClient,
  opts: DiscoverPreferenceOptions = {},
): Promise<DiscoverPreferenceResult> {
  const { inputs, themes } = await collectCandidatesFromPreferences(
    supabase,
    opts,
  );
  const gate = await runDiscoveryGate(supabase, inputs);
  return { ...gate, themes: themes.length, candidateSites: inputs.length };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
