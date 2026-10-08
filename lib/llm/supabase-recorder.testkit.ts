import type { SupabaseClient } from "@supabase/supabase-js";

// テスト専用の Supabase スタブ（*.test.ts ではないので vitest は拾わない）。
//
// from(table) から始まるメソッドチェーンと rpc(fn, args) を、await された時点で 1 件の呼び出しとして
// 記録し、handler が返した { data, error, count } で解決する。どのメソッドでも受け付けるので、
// テストは「どの順で何を書いたか」と「何を返されたらどう振る舞うか」だけを書けばよい
// （annotate-rows.test.ts の手書きスタブを、チェーンの形に依らず使えるようにしたもの）。

export type ChainStep = { method: string; args: unknown[] };

export type RecordedCall =
  | { kind: "from"; table: string; chain: ChainStep[] }
  | { kind: "rpc"; fn: string; args: unknown };

export type StubResponse = { data?: unknown; error?: unknown; count?: number | null };

export type Recorder = {
  client: SupabaseClient;
  calls: RecordedCall[];
};

export function createRecorder(
  handler: (call: RecordedCall) => StubResponse | undefined,
): Recorder {
  const calls: RecordedCall[] = [];
  const settle = (call: RecordedCall) => {
    calls.push(call);
    const r = handler(call) ?? {};
    return { data: r.data ?? null, error: r.error ?? null, count: r.count ?? null };
  };

  const builder = (call: Extract<RecordedCall, { kind: "from" }>): unknown => {
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
              try {
                resolve(settle(call));
              } catch (e) {
                reject(e);
              }
            };
          }
          return (...args: unknown[]) => {
            call.chain.push({ method: String(prop), args });
            return proxy;
          };
        },
      },
    );
    return proxy;
  };

  const client = {
    from(table: string) {
      return builder({ kind: "from", table, chain: [] });
    },
    rpc(fn: string, args: unknown) {
      const call: RecordedCall = { kind: "rpc", fn, args };
      return {
        then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
          try {
            resolve(settle(call));
          } catch (e) {
            reject(e);
          }
        },
      };
    },
  } as unknown as SupabaseClient;

  return { client, calls };
}

// 呼び出しの短い名前。from は「table.最初の書き込み/読み取りメソッド」、rpc は「rpc:関数名」。
export function callName(c: RecordedCall): string {
  if (c.kind === "rpc") return `rpc:${c.fn}`;
  const op = c.chain.find((s) =>
    ["select", "insert", "update", "upsert", "delete"].includes(s.method),
  );
  return `${c.table}.${op?.method ?? "?"}`;
}

// チェーン中の指定メソッドの引数（最初の出現）。
export function argOf(c: RecordedCall, method: string): unknown[] | undefined {
  if (c.kind !== "from") return undefined;
  return c.chain.find((s) => s.method === method)?.args;
}

export function isFrom(c: RecordedCall, table: string, method: string): boolean {
  return c.kind === "from" && c.table === table && c.chain.some((s) => s.method === method);
}

// 関数名まで絞る判定なので型ガードにしない（偽の分岐で rpc 型ごと消えるため）。
export function isRpc(c: RecordedCall, fn: string): boolean {
  return c.kind === "rpc" && c.fn === fn;
}
