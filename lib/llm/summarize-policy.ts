// 要約の「何件まで・何時間まで」と、1 run の要約予算を Batches と同期にどう配るかの判断（YAT-79）。
//
// 数値とその根拠をここ 1 か所に置き、判断は純関数にする（DB・env・SDK に依存しない）。
// 同期の annotateMissing（summarize-batch.ts）・Batches の submit（annotate-batch.ts）・
// ingest.ts の配線とガード（ingest-health.ts）はここを読むだけにする。

// 1 UTC 日あたりの要約上限（YAT-74 → YAT-78）。**run をまたぐ唯一の支出天井。**
//
// PER_RUN_MAX は 1 run の上限でしかなく、日次の消費は cron の発火回数に比例する。
// その発火回数は GitHub Actions の best-effort スケジューリングで実測 2〜23 回/日 と
// 10 倍振れるため、日次消費は制御できていなかった（2026-08-19 のクレジット枯渇の直接原因）。
//
// YAT-78 で 300 → 120 に絞る（月 $20 → 約 $8）。**率でなく実数で置く**（率だと絞り込みの
// ノブを回すたびに閾値も動く）。下流の必要量から引く: デッキ 10 件/日 × 72h 窓 = 360 件が
// 常時候補にいればよく、feed RR で 120 件/日 でも流入 3.75/日 未満の feed は実質 100% 要約される。
// 判定は articles.summarized_at（着地）でなく llm_batches の当日 request_count 合計（投入基準）。
// Batches（YAT-79）で投入と着地が正当に乖離するため、上限は投入で数える（着地を待つと
// submit を止められない）。summarized_at は着地の観測として残し、乖離＝未回収量として監視する。
export const DAILY_SUMMARIZE_CAP = 120;

// claim_summary_candidates の per_feed。1 run で 1 feed から取る上限（rn 昇順の RR の粒度）。
// 120 ÷ 32 feed ≒ 3.75 の切り上げ。バックログを持つ feed が 5 本未満のときだけ run 枠が余るが、
// それはバックログがほぼ捌けた状態。dev.to（流入の 35%）を日次 4 件/日 に抑える効果もここ。
export const SUMMARIZE_PER_FEED = 4;

// 記事固有の失敗の隔離閾値（0017 の claim RPC 既定 max_attempts と同値）。unquarantine と
// 隔離増加ガードが読む。**claim 時には増やさない**（証人ゲート・ADR-20260906205227）。
export const SUMMARY_MAX_ATTEMPTS = 3;

// 1 run で要約に回す上限。Batches と同期の合計（YAT-79）。cron の 1 run の時間とコスト暴走を抑える。
export const PER_RUN_MAX = 20;

// 予約（summary_reserved_until）の長さ。同期は 1 run 内で settle するので 0017 の既定 30h のまま。
export const SYNC_LEASE_HOURS = 30;

// Batches 経路の予約・停滞判定・孤児の掃除はすべて 36h（YAT-79）。
// design doc は「Batches の SLA 24h ＋ 発火のブレ 6h = 30h」としたが、毎時 cron の実際の発火間隔は
// 最大 7.4h あり（YAT-85 の実測）、24h かかったバッチは 31h 付近で回収される。30h だと予約が先に切れて
// 同期経路が同じ記事を取り直し、batchStuck も誤って鳴る。24h ＋ cron 間隔 2 回分で 36h。
// 3 つは同じ値でなければならない（予約が停滞判定より先に切れると二重要約が赤より先に起きる）。
// migration 0017 の列コメントにある 30h は、この訂正の前の設計値（適用済みなので書き換えない）。
export const BATCH_LEASE_HOURS = 36;
export const BATCH_STUCK_HOURS = 36;
export const STALE_LEDGER_HOURS = 36;

// 未回収のバッチがこの本数に達したら投入を見送る（inflight_cap）。回収が止まったまま投入だけ
// 続いて予約が積み上がるのを止める。CAP=20 なら 1 日 1 本なので、届くのは回収停止の 12 日後。
export const MAX_INFLIGHT_BATCHES = 12;

export type SummaryUsage = {
  /** 当日（UTC）の要約の投入件数（同期 + Batches）。 */
  total: number;
  /** そのうち Batches に回した件数。 */
  batch: number;
};

export type BatchEnv = {
  /** SUMMARIZE_BATCH_CAP。DAILY_SUMMARIZE_CAP のうち Batches に回す日次件数。0 は全件同期。 */
  cap: number;
  /** SUMMARIZE_BATCH_COLLECT。"0" のときだけ回収を止める（運用実験・障害対応）。 */
  collectEnabled: boolean;
  /** SUMMARIZE_BATCH_CAP が設定されているのに数として読めなかった（0 として扱う）。 */
  capInvalid: boolean;
  capRaw: string | undefined;
};

// GitHub Actions の vars は未設定だと空文字に展開される。Number("") は 0、parseInt("") は NaN なので、
// 0 以上の整数だけを採用し、それ以外（未設定・空・負数・小数・文字）は 0 ＝ 全件同期に倒す
// （CAP=0 が公式のロールバック手順なので、読めない値はロールバック側に倒すのが安全）。
export function parseBatchEnv(env: Record<string, string | undefined>): BatchEnv {
  const capRaw = env.SUMMARIZE_BATCH_CAP;
  const trimmed = (capRaw ?? "").trim();
  const valid = /^\d+$/.test(trimmed);
  const cap = valid ? Math.min(Number(trimmed), DAILY_SUMMARIZE_CAP) : 0;
  return {
    cap,
    collectEnabled: (env.SUMMARIZE_BATCH_COLLECT ?? "").trim() !== "0",
    capInvalid: trimmed !== "" && !valid,
    capRaw,
  };
}

// 日次上限の起点。cron が UTC 基準なので、ローカル時刻で切ると日境界が run の途中に来る。
export function utcDayStartIso(now: number): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export function dailyRemaining(total: number): number {
  return Math.max(0, DAILY_SUMMARIZE_CAP - total);
}

export type SubmitPlan =
  | { submit: true; maxRows: number }
  | { submit: false; reason: "inflight_cap" | "daily_capped" | "batch_capped" };

// この run で Batches に投入する件数。cap <= 0（ロールバック）は呼び出し側が台帳を読む前に弾く。
// 判定順: 回収の詰まり（inflight_cap）を最優先で知らせる → 日次上限 → Batches の当日枠。
export function planBatchSubmit(p: {
  cap: number;
  usage: SummaryUsage;
  inflight: number;
}): SubmitPlan {
  if (p.inflight >= MAX_INFLIGHT_BATCHES) return { submit: false, reason: "inflight_cap" };
  const daily = dailyRemaining(p.usage.total);
  if (daily === 0) return { submit: false, reason: "daily_capped" };
  const batchLeft = p.cap - p.usage.batch;
  if (batchLeft <= 0) return { submit: false, reason: "batch_capped" };
  return { submit: true, maxRows: Math.min(PER_RUN_MAX, batchLeft, daily) };
}

// Batches が台帳に載せた件数（ledgerCounted）を引いた、この run の同期の残り枠。create に渡した件数
// （reserved）ではない: 送れる行 0 件や create 失敗でも台帳には載っている。投入の結果をそのまま受けて、
// 呼び出し側でどの件数を渡すかを選ばせない。日次の残りは annotateMissing が自分で台帳を読み直して引く
// （Batches の行が既に入っているので二重には引かない）。
export function syncLimitAfterSubmit(sub: { ledgerCounted: number }): number {
  return Math.max(0, PER_RUN_MAX - sub.ledgerCounted);
}

export type SyncPlan =
  | { run: true; maxRows: number }
  | { run: false; reason: "no_run_budget" | "daily_capped" };

// 同期経路（annotateMissing）の件数。limit <= 0 は Batches がこの run の枠を使い切った状態で、
// claim を max_rows=0 で呼ぶと「候補はあるのに予約 0 件」になって isSelectionDead が誤って鳴る。
export function planSyncRun(limit: number, total: number): SyncPlan {
  if (limit <= 0) return { run: false, reason: "no_run_budget" };
  const daily = dailyRemaining(total);
  if (daily === 0) return { run: false, reason: "daily_capped" };
  return { run: true, maxRows: Math.min(limit, daily) };
}
