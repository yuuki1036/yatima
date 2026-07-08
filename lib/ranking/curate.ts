import type { SupabaseClient } from "@supabase/supabase-js";
import { todayJst } from "@/lib/format";
import { score, preferenceScore, recencyDecay } from "./score";
import { loadTagPrefs, loadSourcePrefs } from "./preferences";
import { parseEmbedding, isNearDuplicate } from "./dedup";

// 「今日のデッキ」を未判定 size 件に保つキュレーション。ingest パイプライン末尾（cron）と
// 手動「更新」から呼ぶ。
//
// 連続トップアップ方式: かつての「1日1回だけ確定」する日次ガードは廃止し、未判定の手持ちが
// size 件を下回っていれば不足分だけ補充する。これで「更新を押せば必ず最大 size 件が並ぶ」
// 「1日 size 件で打ち止めにならない（判定し切ったら更新で次が出る）」を両立する。冪等性は
// 「未判定が size 件あれば何もしない」ことで担保する（毎時 cron が走っても無駄に増えない）。
// 既出（判定済み含む）の記事は picked_date が立っているので候補から自然に外れ、二重提示しない。

const DAILY_COUNT = 10; // 並べる未判定デッキの目標サイズ
const CANDIDATE_WINDOW_HOURS = 72; // 採点候補は直近 72h（鮮度と母数のバランス）
const CANDIDATE_LIMIT = 200;
const MAX_PER_SOURCE = 3; // デッキ内で同一ソースの最大数（多様性キャップ。当日累積で数える）
const EXPLORE_COUNT = 2; // デッキ内で嗜好中立（未知トピック）に充てる探索枠の目標数（YAT-37・tunable）
const EXPLORE_NEUTRAL_BAND = 0.5; // 「嗜好中立」とみなす preferenceScore の絶対値上限（tunable）

export type CurateResult = {
  date: string; // JST の YYYY-MM-DD
  picked: number; // 今回新たに補充した件数
  skipped: boolean; // 既に未判定が size 件あり何もしなかった場合 true
  deduped: number; // embedding 類似で近重複として弾いた候補数（観測・閾値調整用）
  explored: number; // 今回の補充で探索枠として採った件数（観測・filter bubble 効果測定用）
};

// PostgREST のネスト select は to-one でもオブジェクト/配列で返りうるため両対応で信頼度を取り出す。
function feedCredibility(
  feeds: { credibility?: number } | { credibility?: number }[] | null,
): number {
  if (!feeds) return 0;
  const f = Array.isArray(feeds) ? feeds[0] : feeds;
  return f?.credibility ?? 0;
}

// ── 選定に必要な最小データに落とした候補と既出記事。DB 非依存の純関数 pickDeck で扱えるよう
//    curateToday 側で articles 行をこの形に整形する。
export type DeckCandidate = {
  id: string;
  feedId: string | null;
  vec: number[] | null; // embedding（近重複判定用。無ければ非重複扱い）
  pref: number; // 嗜好成分（Σ タグ嗜好 + ソース嗜好）。探索枠の中立判定に使う
  recency: number; // 新しさ減衰（探索枠を recency 降順に並べるため）
  value: number; // 総合スコア（通常パスの並び順）
};

export type DeckSeed = {
  feedId: string | null;
  vec: number[] | null;
  pref: number; // 嗜好成分（未判定分だけ探索枠の充足カウントに使う）
  judged: boolean; // 判定済みか（未判定のみ探索枠カウント対象）
};

export type PickDeckResult = {
  scored: { id: string; value: number }[];
  deduped: number;
  explored: number;
};

// デッキ選定の純関数。DB IO を持たず、整形済みの候補・既出記事から補充分を決める。
// 3 パス構成: ①探索枠（嗜好中立を recency 降順）→ ②通常（スコア降順）→ ③fallback（cap 緩和・dedup 維持）。
// 多様性キャップ・近重複除外は「当日デッキ全体」に効かせるため seed（既出記事）を継続して積む。
export function pickDeck(params: {
  candidates: DeckCandidate[];
  seeds: DeckSeed[];
  need: number; // 補充する目標件数（size - 未判定数、> 0 前提）
  hasPrefSignal: boolean; // 嗜好が学習済みか（false=コールドスタート → 探索枠を畳む）
  exploreCount?: number;
  neutralBand?: number;
  maxPerSource?: number;
}): PickDeckResult {
  const {
    candidates,
    seeds,
    need,
    hasPrefSignal,
    exploreCount = EXPLORE_COUNT,
    neutralBand = EXPLORE_NEUTRAL_BAND,
    maxPerSource = MAX_PER_SOURCE,
  } = params;

  const isExploratory = (pref: number) => Math.abs(pref) <= neutralBand;

  const scored: { id: string; value: number }[] = [];
  const pickedIds = new Set<string>();
  const pickedVecs: number[][] = []; // 既出＋採用済みの embedding（dedup 比較用）
  const perSource = new Map<string, number>();

  // ── 当日既出（判定済み含む）を seed に積む。キャップも dedup も「当日デッキ全体」に対して
  //    効かせるため（補充で同一ソース偏重や別メディア再掲が起きない）。探索枠の充足は未判定分
  //    だけで数える（判定済みは既にデッキから消化されている）。
  let curExplore = 0;
  for (const s of seeds) {
    const key = s.feedId ?? "";
    perSource.set(key, (perSource.get(key) ?? 0) + 1);
    if (s.vec) pickedVecs.push(s.vec);
    if (!s.judged && isExploratory(s.pref)) curExplore += 1;
  }

  // 探索枠の不足分。嗜好シグナルが無い（コールドスタート）なら抜け出すべき bubble 自体が無いので 0。
  const exploreNeed = hasPrefSignal
    ? Math.max(0, Math.min(exploreCount - curExplore, need))
    : 0;

  const ranked = [...candidates].sort((x, y) => y.value - x.value);
  let deduped = 0;
  let explored = 0;

  // 1 件採否。capped=true のとき多様性キャップを適用。dedup は常に適用。採れたら true。
  const tryPick = (r: DeckCandidate, capped: boolean): boolean => {
    const key = r.feedId ?? "";
    if (capped && (perSource.get(key) ?? 0) >= maxPerSource) return false;
    // embedding がある候補のみ dedup 判定（無い記事＝未生成は非重複扱いで素通し）。
    if (r.vec && isNearDuplicate(r.vec, pickedVecs)) {
      deduped += 1;
      return false;
    }
    perSource.set(key, (perSource.get(key) ?? 0) + 1);
    scored.push({ id: r.id, value: r.value });
    pickedIds.add(r.id);
    if (r.vec) pickedVecs.push(r.vec);
    return true;
  };

  // ① 探索枠パス: 嗜好中立（未知トピック）の候補を recency 降順で exploreNeed 件だけ。
  if (exploreNeed > 0) {
    const exploratory = ranked
      .filter((r) => isExploratory(r.pref))
      .sort((x, y) => y.recency - x.recency);
    for (const r of exploratory) {
      if (explored >= exploreNeed) break;
      if (pickedIds.has(r.id)) continue;
      if (tryPick(r, true)) explored += 1;
    }
  }

  // ② 通常パス: スコア降順で need を満たすまで補充。探索枠で採用済みは飛ばす。
  for (const r of ranked) {
    if (scored.length >= need) break;
    if (pickedIds.has(r.id)) continue;
    tryPick(r, true);
  }

  // ③ fallback: キャップ/dedup で need に満たない場合、キャップだけ外して充足を優先する。
  // dedup は残す: 連続トップアップでは当日累積でソースが次々 cap に達し fallback の発動頻度が
  // 構造的に上がるため、ここで dedup を外すと既出記事の近重複（別メディアの同一ニュース等）を
  // 同日デッキに再掲してしまう。重複より充足を優先する旧来の意図は cap 緩和で満たしつつ、
  // 近重複だけは引き続き弾く。
  if (scored.length < need) {
    for (const r of ranked) {
      if (scored.length >= need) break;
      if (pickedIds.has(r.id)) continue;
      tryPick(r, false);
    }
  }

  return { scored, deduped, explored };
}

export async function curateToday(
  supabase: SupabaseClient,
  opts: { now?: number; size?: number } = {},
): Promise<CurateResult> {
  const now = opts.now ?? Date.now();
  const size = opts.size ?? DAILY_COUNT;
  const today = todayJst(now);

  // ── 今日すでに出した記事（判定済み含む）を取得。未判定数の算出と、補充時の多様性キャップ・
  //    近重複除外・探索枠の充足カウントを「当日デッキ全体」に対して継続させる seed に使う。
  //    article_tags は探索枠の中立判定（嗜好成分）に要る。
  const { data: picked, error: pErr } = await supabase
    .from("articles")
    .select("id, feed_id, embedding, article_tags(tag_slug)")
    .eq("picked_date", today);
  if (pErr) throw pErr;
  const pickedToday = picked ?? [];

  // 当日ピックのうち判定済み（article_feedback にある）を引いて未判定数を出す。
  let judged = new Set<string>();
  if (pickedToday.length > 0) {
    const { data: fb, error: fErr } = await supabase
      .from("article_feedback")
      .select("article_id")
      .in(
        "article_id",
        pickedToday.map((r) => r.id as string),
      );
    if (fErr) throw fErr;
    judged = new Set((fb ?? []).map((x) => x.article_id as string));
  }
  const unjudged = pickedToday.filter((r) => !judged.has(r.id as string)).length;
  const need = size - unjudged;
  // ── 冪等ガード: 未判定が既に size 件あれば補充不要。
  if (need <= 0)
    return { date: today, picked: 0, skipped: true, deduped: 0, explored: 0 };

  // ── 嗜好を read（空ならコールドスタート → score は recency + credibility に縮退・探索枠も畳む）
  const [tagPrefs, sourcePrefs] = await Promise.all([
    loadTagPrefs(supabase),
    loadSourcePrefs(supabase),
  ]);

  // ── 候補取得: 未ピック・要約済み・直近72h。credibility を join して厳選の加点に使う。
  const since = new Date(now - CANDIDATE_WINDOW_HOURS * 3_600_000).toISOString();
  const { data: cands, error: cErr } = await supabase
    .from("articles")
    .select(
      "id, feed_id, published_at, embedding, article_tags(tag_slug), feeds(credibility)",
    )
    .is("picked_date", null)
    .not("summary", "is", null)
    .gte("published_at", since)
    .order("published_at", { ascending: false })
    .limit(CANDIDATE_LIMIT);
  if (cErr) throw cErr;

  const candidates: DeckCandidate[] = (cands ?? []).map((a) => {
    const tags = ((a.article_tags ?? []) as { tag_slug: string }[]).map(
      (t) => t.tag_slug,
    );
    const feedId = (a.feed_id ?? null) as string | null;
    const publishedAt = a.published_at as string | null;
    return {
      id: a.id as string,
      feedId,
      vec: parseEmbedding((a as { embedding?: unknown }).embedding),
      pref: preferenceScore({ tags, tagPrefs, sourceId: feedId, sourcePrefs }),
      recency: recencyDecay(publishedAt, now),
      value: score({
        publishedAt,
        tags,
        tagPrefs,
        sourceId: feedId,
        sourcePrefs,
        credibility: feedCredibility(
          (a as { feeds?: Parameters<typeof feedCredibility>[0] }).feeds ??
            null,
        ),
        now,
      }),
    };
  });

  // 既出記事を選定用 seed に整形（多様性キャップ・dedup・探索枠カウントの継続用）。
  const seeds: DeckSeed[] = pickedToday.map((r) => {
    const tags = ((r.article_tags ?? []) as { tag_slug: string }[]).map(
      (t) => t.tag_slug,
    );
    const feedId = (r.feed_id ?? null) as string | null;
    return {
      feedId,
      vec: parseEmbedding((r as { embedding?: unknown }).embedding),
      pref: preferenceScore({ tags, tagPrefs, sourceId: feedId, sourcePrefs }),
      judged: judged.has(r.id as string),
    };
  });

  const hasPrefSignal = tagPrefs.size > 0 || sourcePrefs.size > 0;
  const { scored, deduped, explored } = pickDeck({
    candidates,
    seeds,
    need,
    hasPrefSignal,
  });

  if (scored.length === 0)
    return { date: today, picked: 0, skipped: false, deduped, explored };

  // ── 確定: 先に score を個別保存 → 最後に picked_date を一括付与。順序が肝で、score を先に
  // するのは部分失敗時の自己回復のため: score update が throw すれば picked_date は未付与のまま
  // 残り、次回 curate が同じ候補をやり直せる（picked_date 先付与だと部分失敗でも固定される）。
  for (const s of scored) {
    const { error: sErr } = await supabase
      .from("articles")
      .update({ score: s.value })
      .eq("id", s.id);
    if (sErr) throw sErr;
  }
  const ids = scored.map((s) => s.id);
  const { error: pickErr } = await supabase
    .from("articles")
    .update({ picked_date: today })
    .in("id", ids);
  if (pickErr) throw pickErr;

  return { date: today, picked: scored.length, skipped: false, deduped, explored };
}
