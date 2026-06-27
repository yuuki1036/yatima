import type { SupabaseClient } from "@supabase/supabase-js";
import { todayJst } from "@/lib/format";
import { score } from "./score";
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

export type CurateResult = {
  date: string; // JST の YYYY-MM-DD
  picked: number; // 今回新たに補充した件数
  skipped: boolean; // 既に未判定が size 件あり何もしなかった場合 true
  deduped: number; // embedding 類似で近重複として弾いた候補数（観測・閾値調整用）
};

// PostgREST のネスト select は to-one でもオブジェクト/配列で返りうるため両対応で信頼度を取り出す。
function feedCredibility(
  feeds: { credibility?: number } | { credibility?: number }[] | null,
): number {
  if (!feeds) return 0;
  const f = Array.isArray(feeds) ? feeds[0] : feeds;
  return f?.credibility ?? 0;
}

export async function curateToday(
  supabase: SupabaseClient,
  opts: { now?: number; size?: number } = {},
): Promise<CurateResult> {
  const now = opts.now ?? Date.now();
  const size = opts.size ?? DAILY_COUNT;
  const today = todayJst(now);

  // ── 今日すでに出した記事（判定済み含む）を取得。未判定数の算出と、補充時の
  //    多様性キャップ・近重複除外を「当日デッキ全体」に対して継続させるための seed に使う。
  const { data: picked, error: pErr } = await supabase
    .from("articles")
    .select("id, feed_id, embedding")
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
  if (need <= 0) return { date: today, picked: 0, skipped: true, deduped: 0 };

  // ── 嗜好を read（空ならコールドスタート → score は recency + credibility に縮退）
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

  const ranked = (cands ?? [])
    .map((a) => {
      const tags = ((a.article_tags ?? []) as { tag_slug: string }[]).map(
        (t) => t.tag_slug,
      );
      const feedId = (a.feed_id ?? null) as string | null;
      return {
        id: a.id as string,
        feedId,
        vec: parseEmbedding((a as { embedding?: unknown }).embedding),
        value: score({
          publishedAt: a.published_at as string | null,
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
    })
    .sort((x, y) => y.value - x.value);

  // 多様性キャップ + 近重複除外: スコア順に、同一ソース MAX_PER_SOURCE 件まで、かつ既出記事と
  // embedding が近すぎない候補で need 件を補充する。当日すでに出した記事を seed に積むので、
  // キャップも dedup も「当日デッキ全体」に対して効く（補充で同一ソース偏重や再掲が起きない）。
  const scored: { id: string; value: number }[] = [];
  const pickedIds = new Set<string>(pickedToday.map((r) => r.id as string));
  const pickedVecs: number[][] = []; // 既出記事の embedding（dedup 比較用）
  const perSource = new Map<string, number>();
  for (const r of pickedToday) {
    const key = (r.feed_id ?? "") as string;
    perSource.set(key, (perSource.get(key) ?? 0) + 1);
    const vec = parseEmbedding((r as { embedding?: unknown }).embedding);
    if (vec) pickedVecs.push(vec);
  }
  let deduped = 0;
  for (const r of ranked) {
    if (scored.length >= need) break;
    const key = r.feedId ?? "";
    if ((perSource.get(key) ?? 0) >= MAX_PER_SOURCE) continue;
    // embedding がある候補のみ dedup 判定（無い記事＝未生成は非重複扱いで素通し）。
    if (r.vec && isNearDuplicate(r.vec, pickedVecs)) {
      deduped += 1;
      continue;
    }
    perSource.set(key, (perSource.get(key) ?? 0) + 1);
    scored.push({ id: r.id, value: r.value });
    pickedIds.add(r.id);
    if (r.vec) pickedVecs.push(r.vec);
  }
  // キャップ/dedup で need に満たない場合、残りをスコア順で埋める（充足を優先）。
  // ただしキャップ（多様性）は外しても dedup は残す: 連続トップアップでは当日累積でソースが
  // 次々 cap に達し fallback の発動頻度が構造的に上がるため、ここで dedup を外すと既出記事の
  // 近重複（別メディアの同一ニュース等）を同日デッキに再掲してしまう。重複より充足を優先する
  // 旧来の意図は cap 緩和で満たしつつ、近重複だけは引き続き弾く。
  if (scored.length < need) {
    for (const r of ranked) {
      if (scored.length >= need) break;
      if (pickedIds.has(r.id)) continue;
      if (r.vec && isNearDuplicate(r.vec, pickedVecs)) {
        deduped += 1;
        continue;
      }
      scored.push({ id: r.id, value: r.value });
      pickedIds.add(r.id);
      if (r.vec) pickedVecs.push(r.vec);
    }
  }

  if (scored.length === 0)
    return { date: today, picked: 0, skipped: false, deduped };

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

  return { date: today, picked: scored.length, skipped: false, deduped };
}
