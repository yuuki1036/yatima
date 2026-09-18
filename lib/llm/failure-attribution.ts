import { APIError, APIConnectionError } from "@anthropic-ai/sdk";

// 要約失敗の帰責（ADR-20260906205227）。error type でなく「同ラウンドの証人」で分ける。
//
// なぜ純関数として切り出すか: 「どの失敗に summary_attempts +1 するか」は DB も LLM も無しで
// 決められる（SDK のエラークラスだけに依存する）。summarize-batch.ts に混ぜると Supabase を
// モックしないとテストできない。分類表が壊れると健全期に backlog 上位が全滅するので、
// ここを機械強制（ユニットテスト）できる形に閉じるのが要件（ADR「機械強制できる部分」）。

// 帰責対象の失敗（LLM 呼び出し / DB 書き込みのどちらで落ちたかは問わない）。
export type SettleFailure = { id: string; reason: unknown };
// settle_summary_attempts に渡す 1 件。error は痕跡（summary_last_error）に書かれる。
export type SettleEntry = { id: string; error: string };

/**
 * 記事に課金（summary_attempts +1）してよい失敗か。false = 環境起因に確定できるもの。
 *
 * 環境起因（false）に確定できるのは、error type から「記事の中身と無関係」と断言できるものだけ:
 * - APIConnectionError（接続断 / timeout・status は undefined）
 * - APIError で status 401（認証）/ 429（レート制限）/ >= 500（サーバ側・529 overloaded 含む）
 *
 * それ以外はすべて chargeable（true）:
 * - 400 invalid_request_error … クレジット切れも「本文が壊れている」も同じ型で来る（ADR。実測 100%）。
 *   環境起因ならラウンド全体が落ちて witness=0 になり、splitSettle 側で自動的に救済される。
 * - Error("要約が空") / htmlToInputText 後が空 … 記事固有。
 * - PostgrestError（DB 書き込み失敗）… 「LLM に払い終えてから落ちる」唯一の経路。environment
 *   扱いにすると無限有償リトライになる（ADR 決定 4）。一時障害なら witness=0 で救済される。
 * - 403 permission_denied は ADR の趣旨では環境起因だが、実ログで観測していないので分類表に
 *   入れず chargeable のまま扱う。observe されたら 401/429 と同じ非課金側に足す（ADR「機械強制
 *   できない部分」）。
 *
 * APIConnectionError は APIError のサブクラス（status は undefined）なので、先に判定する。
 */
export function chargeable(e: unknown): boolean {
  if (e instanceof APIConnectionError) return false;
  if (e instanceof APIError) {
    const s = e.status;
    if (s === 401 || s === 429 || (typeof s === "number" && s >= 500)) {
      return false;
    }
    return true;
  }
  return true;
}

/**
 * 同ラウンドの証人ゲート。witness=false（1 件も成功しなかった）なら誰も課金しない
 * ＝全件 released（予約解除のみ・attempts 据え置き）。環境起因の全滅ラウンドを記事のせいに
 * しないための唯一の仕掛け（ADR 決定 2）。witness=true のときだけ chargeable な失敗を +1 する。
 */
export function splitSettle(
  failures: SettleFailure[],
  witness: boolean,
): { charged: SettleEntry[]; released: SettleEntry[] } {
  const charged: SettleEntry[] = [];
  const released: SettleEntry[] = [];
  for (const f of failures) {
    const entry: SettleEntry = { id: f.id, error: errorText(f.reason) };
    if (witness && chargeable(f.reason)) {
      charged.push(entry);
    } else {
      released.push(entry);
    }
  }
  return { charged, released };
}

// 痕跡（summary_last_error）用の文字列化。PostgrestError（message を持つプレーンオブジェクト）・
// Error・不明値のいずれも読める形に畳む。SQL 側で left(500) に切るのでここでは長さを制限しない。
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
