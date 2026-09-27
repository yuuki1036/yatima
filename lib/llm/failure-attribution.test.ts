import { describe, it, expect } from "vitest";
import {
  APIError,
  APIConnectionError,
  BadRequestError,
  RateLimitError,
  InternalServerError,
  AuthenticationError,
  PermissionDeniedError,
} from "@anthropic-ai/sdk";
import { chargeable, splitSettle } from "./failure-attribution";

// ADR-20260906205227 の分類表を固定する。error type が変わったときにここが落ちる＝人手判断の合図。
// SDK のエラークラスはコンストラクタが Headers を要求するため new Headers() を渡す。

const H = () => new Headers();

// クレジット切れ・本文破損の両方が来る実ログどおりの型（実測 100% がこれ）。
const badRequest = () =>
  new BadRequestError(400, { type: "invalid_request_error" }, "invalid_request_error", H());
const rateLimit = () => new RateLimitError(429, undefined, "rate_limited", H());
const serverErr = () => new InternalServerError(500, undefined, "internal", H());
const overloaded = () => new InternalServerError(529, undefined, "overloaded", H());
const authErr = () => new AuthenticationError(401, undefined, "auth", H());
const connErr = () => new APIConnectionError({ message: "socket hang up" });
// DB 書き込み失敗（PostgrestError 相当のプレーンオブジェクト）。
const pgErr = () => ({ message: "duplicate key", code: "23505", details: "", hint: "" });

describe("chargeable", () => {
  it("400 invalid_request_error は chargeable（環境起因と記事固有が同型で来るため）", () => {
    expect(chargeable(badRequest())).toBe(true);
  });
  it("429 / 5xx / 401 / 接続断は非課金（環境起因に確定できる）", () => {
    expect(chargeable(rateLimit())).toBe(false);
    expect(chargeable(serverErr())).toBe(false);
    expect(chargeable(overloaded())).toBe(false);
    expect(chargeable(authErr())).toBe(false);
    expect(chargeable(connErr())).toBe(false);
  });
  it("403 permission_denied は chargeable のまま（未観測なので非課金の分類表に入れない）", () => {
    // ADR-20260906205227「機械強制できない部分」: 403 は実ログで観測されたら 401/429 と同じ
    // 非課金側へ足す。それまでは分類表に入れず chargeable。この pin で誤って非課金に倒す変異を弾く。
    expect(chargeable(new PermissionDeniedError(403, undefined, "forbidden", H()))).toBe(true);
  });
  it("PostgrestError（DB 書き込み失敗）は chargeable（無限有償リトライを避ける）", () => {
    expect(chargeable(pgErr())).toBe(true);
  });
  it('Error("要約が空") など記事固有の失敗は chargeable', () => {
    expect(chargeable(new Error("要約が空"))).toBe(true);
    expect(chargeable(new Error("本文・タイトルとも空"))).toBe(true);
  });
  it("status を持たない APIError（undefined）は chargeable", () => {
    // APIConnectionError 以外で status undefined の APIError は分類表に無いので課金側に倒す。
    const e = new APIError(undefined, undefined, "unknown", H());
    expect(chargeable(e)).toBe(true);
  });
});

describe("splitSettle", () => {
  const failures = [
    { id: "a", reason: badRequest() }, // chargeable
    { id: "b", reason: rateLimit() }, // 非課金
    { id: "c", reason: new Error("要約が空") }, // chargeable
  ];

  it("witness=false（全滅ラウンド）なら誰も課金しない — 全件 released", () => {
    const { charged, released } = splitSettle(failures, false);
    expect(charged).toHaveLength(0);
    expect(released.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("witness=true なら chargeable な失敗だけ charged、環境起因は released", () => {
    const { charged, released } = splitSettle(failures, true);
    expect(charged.map((r) => r.id)).toEqual(["a", "c"]);
    expect(released.map((r) => r.id)).toEqual(["b"]);
  });

  it("error 文字列を痕跡として持つ", () => {
    const { charged } = splitSettle([{ id: "x", reason: new Error("要約が空") }], true);
    expect(charged[0]).toEqual({ id: "x", error: "要約が空" });
  });

  it("空配列は空を返す", () => {
    expect(splitSettle([], true)).toEqual({ charged: [], released: [] });
  });
});
