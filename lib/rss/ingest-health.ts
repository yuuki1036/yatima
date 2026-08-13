import type { IngestResult } from "./ingest";

// ingest の「継続失敗」検知（YAT-68）。
//
// scripts/ingest.ts は長らく「全 feed 失敗時のみ exit(1)」だったため、1 本だけが恒常的に
// 落ちても CI は緑のまま流れた。実際に Import AI が 15 日間 HTTP 403 で落ち続け、feed 退役推奨
// （dead・閾値 14 日）に立って初めて発覚している。退役推奨は「価値の低い feed を外す」ための
// 機能であって障害検知ではない。取得が壊れていることは ingest 自身が言うべき。
//
// 判定は last_fetched_at だけで足りる。この列は ingest 成功時のみ更新される（新着 0 件でも更新）
// ので、now - last_fetched_at がそのまま「最後に成功してからの経過時間」になる。
// fetch_fail_streak のような新規列と migration は要らない。
//
// 純関数に閉じて DB I/O は呼び出し側に置く（feed-health.ts と同じ方針）。

// 継続失敗とみなす経過時間。ingest は毎時なので 6h ≒ 6 回連続失敗。
// 単発の瞬断で鳴らさず、恒常的な失敗は 15 日でなく 6 時間で拾う狙いの暫定値。
export const STALE_ALERT_HOURS = 6;

const HOUR_MS = 3_600_000;

// 判定に必要な feed 側の生値。IngestResult に相乗りさせている（呼び出し側が
// results 以外を持ち回らずに済む）。
export type StaleFeed = {
  feedId: string;
  feedUrl: string;
  title: string | null;
  staleMs: number;
  error: string;
};

// 今回の run で失敗し、かつ最後の成功から STALE_ALERT_HOURS 以上経っている feed を返す。
// stale が長い順（＝放置が深刻な順）。
//
// 成功した feed を先に除くのが要点。ingestAllFeeds が読む feed 行は last_fetched_at を
// 更新する**前**のスナップショットなので、今回成功した feed も古い値を持っている。
// error の有無で絞らないと、成功したばかりの feed まで stale と判定してしまう。
//
// last_fetched_at が null（一度も成功していない）feed は created_at を起点にする。
// 追加直後の feed が初回失敗でいきなり赤くならず、閾値を跨いで初めて鳴る。
// このため専用の「新規 feed 猶予」定数は要らない。
export function findStaleFeeds(
  results: IngestResult[],
  now: number = Date.now(),
): StaleFeed[] {
  const thresholdMs = STALE_ALERT_HOURS * HOUR_MS;
  const stale: StaleFeed[] = [];

  for (const r of results) {
    if (!r.error) continue;

    // 起点が読めない（両方 null / パース不能）feed は判定を諦めて見送る。ここで
    // Infinity に倒すと、created_at の欠けた行が毎回 CI を赤くして本物の障害を埋める。
    //
    // 注意: この guard は下の `staleMs >= thresholdMs` の下では**冗長**（NaN との比較は
    // 常に false なので、guard が無くても見送りになる）。実際ミューテーションでこの行を
    // 消してもテストは 13 件とも通る。dead code に見えるが消さないこと — 比較を否定形
    // （`!(staleMs < thresholdMs)`）に書き換えるリファクタが入ると NaN が true 側へ倒れ、
    // 起点の無い feed が毎回 CI を赤くする。その改変に対してこの guard だけが効く
    // （guard が無い場合はテスト 2 件が落ちて検出する、という別の守り方になる）。
    const anchor = r.lastFetchedAt ?? r.createdAt;
    const anchorMs = anchor === null ? NaN : Date.parse(anchor);
    if (!Number.isFinite(anchorMs)) continue;

    const staleMs = now - anchorMs;
    if (staleMs >= thresholdMs) {
      stale.push({
        feedId: r.feedId,
        feedUrl: r.feedUrl,
        title: r.title,
        staleMs,
        error: r.error,
      });
    }
  }

  return stale.sort((a, b) => b.staleMs - a.staleMs);
}

// ログ用の経過時間表記。6h 未満は出ない前提だが、境界付近を読めるよう時間で刻む。
export function formatStale(staleMs: number): string {
  const hours = staleMs / HOUR_MS;
  return hours >= 48
    ? `${(hours / 24).toFixed(1)}日`
    : `${hours.toFixed(1)}時間`;
}
