import type { SupabaseClient } from "@supabase/supabase-js";
import { todayJst } from "@/lib/format";
import { score } from "./score";
import { loadTagPrefs } from "./preferences";

// 「今日の固定10件」を確定するキュレーション。ingest パイプライン末尾（cron）から呼ぶ。
// 日次ガードで冪等: 当日分が既にあれば何もしない（毎時 cron が走っても固定される）。

const DAILY_COUNT = 10;
const CANDIDATE_WINDOW_HOURS = 72; // 採点候補は直近 72h（鮮度と母数のバランス）
const CANDIDATE_LIMIT = 200;

export type CurateResult = {
  date: string; // JST の YYYY-MM-DD
  picked: number;
  skipped: boolean; // 当日分が既にあって何もしなかった場合 true
};

export async function curateToday(
  supabase: SupabaseClient,
  opts: { now?: number; size?: number } = {},
): Promise<CurateResult> {
  const now = opts.now ?? Date.now();
  const size = opts.size ?? DAILY_COUNT;
  const today = todayJst(now);

  // ── 日次ガード（冪等性の要）: 今日の picked_date が既にあれば skip
  const { count, error: gErr } = await supabase
    .from("articles")
    .select("id", { count: "exact", head: true })
    .eq("picked_date", today);
  if (gErr) throw gErr;
  if ((count ?? 0) > 0) return { date: today, picked: count ?? 0, skipped: true };

  // ── 嗜好を read（空ならコールドスタート → score は recency のみに縮退）
  const tagPrefs = await loadTagPrefs(supabase);

  // ── 候補取得: 未ピック・要約済み・直近72h
  const since = new Date(now - CANDIDATE_WINDOW_HOURS * 3_600_000).toISOString();
  const { data: cands, error: cErr } = await supabase
    .from("articles")
    .select("id, published_at, article_tags(tag_slug)")
    .is("picked_date", null)
    .not("summary", "is", null)
    .gte("published_at", since)
    .order("published_at", { ascending: false })
    .limit(CANDIDATE_LIMIT);
  if (cErr) throw cErr;

  const scored = (cands ?? [])
    .map((a) => {
      const tags = (
        (a.article_tags ?? []) as { tag_slug: string }[]
      ).map((t) => t.tag_slug);
      return {
        id: a.id as string,
        value: score({
          publishedAt: a.published_at as string | null,
          tags,
          tagPrefs,
          now,
        }),
      };
    })
    .sort((x, y) => y.value - x.value)
    .slice(0, size);

  if (scored.length === 0) return { date: today, picked: 0, skipped: false };

  // ── 確定: 先に score を個別保存 → 最後に picked_date を一括付与（日次ガードを満たす commit）。
  // 順序が肝。score を先にするのは部分失敗時の自己回復のため:
  // score update がエラーで throw すれば picked_date は未付与のまま → 日次ガードが立たず、
  // 次回 curate が同じ候補をやり直せる（picked_date 先付与だと部分失敗でも固定されてしまう）。
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

  return { date: today, picked: scored.length, skipped: false };
}
