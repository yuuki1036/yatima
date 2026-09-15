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

// ── embed / デッキ供給の静かな死の検知（YAT-76）──────────────────────────────
//
// 要約の全滅（YAT-73 の annotateDead）は赤くなるのに、embed の全滅・停滞とデッキ供給の
// 枯渇は素通りしていた。実際に embed が 13 日間 1 件も進まず、気付いたのは feed 網羅率の
// 週次低下からという遅すぎる検知が起票の理由。判定は純関数に閉じ、DB カウントの取得は
// 呼び出し側（scripts/ingest.ts + lib/rss/embed.ts の embedHealthCounts）に置く。
//
// 取得失敗（-1）はどのガードも不活性にする。0 と混ぜると「進んでいない」偽陽性か
// 「対象なし」偽陰性のどちらかに倒れるため、-1 は「判定不能」として warn だけ残す。

// embed の run 内全滅。対象を拾ったのに 1 件も成功しなかった＝ Voyage 側の恒常障害
// （キー失効・クレジット・レート制限の張り付き）。対象ゼロは正常なので発火しない。
export function isEmbedDead(em: {
  skipped: boolean;
  picked: number;
  succeeded: number;
}): boolean {
  return !em.skipped && em.picked > 0 && em.succeeded === 0;
}

// embed の生存判定。候補が積まれているのに直近 26h で 1 件も進んでいない。
// run 単位の isEmbedDead と違い、「fail-soft で毎 run 静かに 0 件のまま流れる」型を捕まえる。
// ディスク天井で意図的に止めた run（skipReason='disk_ceiling'・YAT-77 で実装）は除外する
// ——天井は exit 1 にしない設計（永久赤を作らない）なので、その skip をここで赤に
// 変換したら台無しになる。
export function isEmbedStalled(
  em: { skipReason?: string },
  counts: { embeddedLast26h: number; candidatesAvailable: number },
): boolean {
  return (
    em.skipReason !== "disk_ceiling" &&
    counts.embeddedLast26h === 0 &&
    counts.candidatesAvailable > 0
  );
}

// デッキ供給の最終防衛線。curate が拾う候補（要約済み ∧ 未ピック ∧ 直近 72h）の実数が
// この床を割ったら、取得・要約・選抜のどこが壊れていても最後にここで赤くなる。
// 40 は日次 10 件×3 日ぶん＋余裕。候補が細るのは上流障害の遅行指標なので、床は
// 「即死ではないが放置すると数日でデッキが空く」水準に置く。
export const DECK_STARVED_FLOOR = 40;

export function isDeckStarved(candidateCount: number): boolean {
  return candidateCount >= 0 && candidateCount < DECK_STARVED_FLOOR;
}
