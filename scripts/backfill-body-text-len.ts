import { config } from "dotenv";

config({ path: ".env.local" });

import { Client } from "pg";

// articles.body_text_len の backfill（YAT-75・migration 0017 の後に 1 回だけ流す）。
//
// 0017 の trigger は insert と content_html の update でしか走らないので、既存 53,000 行は
// null のまま。migration の 1 トランザクションで全行 UPDATE すると articles が丸ごとロックされ、
// TOAST を含む書き換えで数分かかるため、ここで 2,000 行ずつ autocommit で埋める。
// 値は trigger と同じ public.body_text_len_of() で出す（JS で再計算して送り返さない。
// content_html を全件ダウンロードすると egress 数百 MB になるうえ、定義が 2 つに割れる）。
//
// 使い方: npm run backfill:body-text-len
//   何度流しても安全（null の行しか触らない）。途中で止めても次回は残りから再開する。
//   SUPABASE_DB_URL が要る（migrate.ts と同じ）。

const BATCH = 2000;

async function main() {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error("SUPABASE_DB_URL が未設定です（migrate.ts と同じ接続文字列）。");
    process.exit(1);
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows: fn } = await client.query<{ ok: boolean }>(
      "select to_regprocedure('public.body_text_len_of(text)') is not null as ok",
    );
    if (!fn[0]?.ok) {
      throw new Error("public.body_text_len_of が無い。先に npm run migrate で 0017 を適用すること。");
    }

    const { rows: before } = await client.query<{ n: string }>(
      "select count(*) as n from public.articles where body_text_len is null and content_html is not null",
    );
    const total = Number(before[0].n);
    console.log(`backfill 対象: ${total} 行（content_html あり ∧ body_text_len null）`);

    let done = 0;
    for (;;) {
      // ctid ではなく id で切る: 途中で ingest が insert しても（trigger で埋まるので）対象に入らない。
      const { rowCount } = await client.query(
        `update public.articles a
           set body_text_len = public.body_text_len_of(a.content_html)
         where a.id in (
           select id from public.articles
            where body_text_len is null and content_html is not null
            limit $1
         )`,
        [BATCH],
      );
      if (!rowCount) break;
      done += rowCount;
      console.log(`  ${done}/${total}`);
    }

    const { rows: after } = await client.query<{ n: string; ge250: string }>(
      `select count(*) filter (where body_text_len is null and content_html is not null) as n,
              count(*) filter (where body_text_len >= 250) as ge250
         from public.articles`,
    );
    console.log(
      `完了: ${done} 行更新。残り null ${after[0].n} 行。body_text_len >= 250 は ${after[0].ge250} 行`,
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
