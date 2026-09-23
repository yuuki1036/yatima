import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Summarizer } from "./types";
import {
  annotateRows,
  findBrokenAnnotations,
  isBrokenSummary,
  type UntaggedRow,
} from "./summarize-batch";

// annotateRows の forceSummary と findBrokenAnnotations の検出・重複排除を、
// Supabase クライアントの最小スタブで検証する（実 DB には触らない）。

type Updated = { id: string; summary: string };

function stubForAnnotate(updated: Updated[], tagged: string[][]) {
  return {
    from(table: string) {
      if (table === "article_tags") {
        return {
          upsert(rows: { article_id: string; tag_slug: string }[]) {
            tagged.push(rows.map((r) => r.tag_slug));
            return Promise.resolve({ error: null });
          },
        };
      }
      return {
        update(patch: { summary: string }) {
          return {
            eq(_col: string, id: string) {
              updated.push({ id, summary: patch.summary });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

const summarizer: Summarizer = {
  summarize: async () => "unused",
  annotate: async () => ({ summary: "作り直した要約", tags: ["tech/ai"] }),
};

const row: UntaggedRow = {
  id: "a1",
  title: "題",
  url: "https://example.com/a",
  // 本文は十分な長さ（isThinBody に引っかからない）＝ enrich しても差し替えは起きない
  content_html: "<p>" + "本文".repeat(400) + "</p>",
};

describe("annotateRows", () => {
  it("forceSummary: true なら本文を補完しなくても要約を上書きする", async () => {
    const updated: Updated[] = [];
    const tagged: string[][] = [];
    const r = await annotateRows(stubForAnnotate(updated, tagged), [row], {
      enrich: false,
      forceSummary: true,
      summarizer,
    });
    expect(r.targeted).toBe(1);
    expect(r.tagged).toBe(1);
    expect(r.failed).toBe(0);
    expect(updated).toEqual([{ id: "a1", summary: "作り直した要約" }]);
    expect(tagged).toEqual([["tech/ai"]]);
  });

  it("既定（forceSummary なし）は本文が変わらなければ要約を温存する", async () => {
    const updated: Updated[] = [];
    const tagged: string[][] = [];
    const r = await annotateRows(stubForAnnotate(updated, tagged), [row], {
      enrich: false,
      summarizer,
    });
    expect(r.tagged).toBe(1);
    expect(updated).toEqual([]); // 要約は書き換えない
    expect(tagged).toEqual([["tech/ai"]]); // タグだけ付く
  });
});

describe("isBrokenSummary", () => {
  it("JSON キーやコードフェンスが残った要約だけを壊れていると判定する", () => {
    expect(isBrokenSummary('{"summary": "x"} 注: …')).toBe(true);
    expect(isBrokenSummary('… "tags":["tech/ai"]')).toBe(true);
    expect(isBrokenSummary("```json")).toBe(true);
    expect(isBrokenSummary("正常な日本語の要約。tags や summary という語を含んでも壊れてはいない")).toBe(false);
    expect(isBrokenSummary(null)).toBe(false);
  });
});

describe("findBrokenAnnotations", () => {
  it("id でキーセット走査し、当たった行だけ本文込みで取り直す", async () => {
    // 2 ページ（1000 件境界）をまたぐ走査を模す。壊れているのは a0500 と a1200。
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      id: `a${String(i).padStart(4, "0")}`,
      summary: i === 500 ? '{"summary": "x"} 注: …' : "正常な要約",
    }));
    const page2 = [
      { id: "a1200", summary: "```json" },
      { id: "a1201", summary: "正常な要約" },
    ];
    const cursors: (string | null)[] = [];
    const fetched: string[][] = [];

    const sb = {
      from: () => ({
        select: (cols: string) => {
          if (cols === "id, summary") {
            const q = {
              cursor: null as string | null,
              not: () => q,
              order: () => q,
              limit: () => q,
              gt: (_c: string, v: string) => {
                q.cursor = v;
                return q;
              },
              then: (resolve: (v: unknown) => void) => {
                cursors.push(q.cursor);
                resolve({ data: q.cursor ? page2 : page1, error: null });
              },
            };
            return q;
          }
          return {
            in: (_c: string, ids: string[]) => {
              fetched.push(ids);
              return {
                order: () =>
                  Promise.resolve({
                    data: ids.map((id) => ({
                      id,
                      title: "題",
                      url: null,
                      content_html: "<p>本文</p>",
                      summary: "壊れた要約",
                    })),
                    error: null,
                  }),
              };
            },
          };
        },
      }),
    } as unknown as SupabaseClient;

    const rows = await findBrokenAnnotations(sb);
    expect(cursors).toEqual([null, "a0999"]); // 2 ページ目は最終 id をカーソルに継ぐ
    expect(fetched).toEqual([["a0500", "a1200"]]); // 当たった 2 件だけ取り直す
    expect(rows.map((r) => r.id)).toEqual(["a0500", "a1200"]);
  });
});
