import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Summarizer } from "./types";
import {
  annotateRows,
  findBrokenAnnotations,
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

describe("findBrokenAnnotations", () => {
  it("複数パターンに当たった記事を id で重複排除して返す", async () => {
    const byPattern: Record<string, { id: string; summary: string }[]> = {
      '%"summary"%': [
        { id: "a1", summary: '{"summary": "x"} 注: …' },
        { id: "a2", summary: '…"summary":' },
      ],
      '%"tags"%': [{ id: "a1", summary: '{"summary": "x"} 注: …' }], // a1 は重複
      "%```%": [{ id: "a3", summary: "```json" }],
    };
    const calls: string[] = [];
    const sb = {
      from: () => ({
        select: () => ({
          like: (_col: string, pattern: string) => {
            calls.push(pattern);
            return {
              order: () =>
                Promise.resolve({ data: byPattern[pattern], error: null }),
            };
          },
        }),
      }),
    } as unknown as SupabaseClient;

    const rows = await findBrokenAnnotations(sb);
    expect(rows.map((r) => r.id)).toEqual(["a1", "a2", "a3"]);
    expect(calls).toEqual(['%"summary"%', '%"tags"%', "%```%"]);
  });
});
