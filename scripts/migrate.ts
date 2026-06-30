import { config } from "dotenv";

// ローカル実行用に .env.local を読む（CI では secrets が process.env にある）。
config({ path: ".env.local" });

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

// supabase/migrations/*.sql を順に適用する最小マイグレーションランナー。
//
// 使い方:
//   npm run migrate              … 未適用の migration をトランザクションで順に適用
//   npm run migrate -- --baseline … 全 migration を「適用済み」として記録（SQL は実行しない）
//                                    既に手動適用済みの DB にこのツールを導入する初回だけ使う
//
// 接続情報: SUPABASE_DB_URL（Supabase > Project Settings > Database >
//   Connection string > Session pooler のURL。末尾の [YOUR-PASSWORD] を実値に置換）。

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "supabase",
  "migrations",
);

function listMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // 0001_, 0002_ ... の辞書順 = 適用順
}

async function main() {
  const baseline = process.argv.includes("--baseline");
  const url = process.env.SUPABASE_DB_URL;
  if (!url) {
    console.error(
      "SUPABASE_DB_URL が未設定です。\n" +
        "Supabase > Project Settings > Database > Connection string > Session pooler の URL を\n" +
        ".env.local に SUPABASE_DB_URL として設定してください（[YOUR-PASSWORD] は実値に置換）。",
    );
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    // 追跡テーブル（適用済み migration のファイル名を記録）
    await client.query(`
      create table if not exists public._migrations (
        name       text primary key,
        applied_at timestamptz not null default now()
      );
    `);

    // _migrations は API から触らない内部テーブル。public スキーマにあると PostgREST 経由で
    // anon に読まれる（Supabase Security Advisor の rls_disabled_in_public）ため RLS を有効化する。
    // ポリシーは付けない＝anon/authenticated は全拒否。migrate 自身は直 Postgres 接続のオーナー
    // 権限で動くので RLS をバイパスし影響を受けない。enable は冪等なので毎回流して既存 DB にも追従させる。
    await client.query(
      "alter table public._migrations enable row level security;",
    );

    const files = listMigrations();

    if (baseline) {
      // 全 migration を「適用済み」として登録（SQL は走らせない）。
      for (const f of files) {
        await client.query(
          "insert into public._migrations (name) values ($1) on conflict (name) do nothing",
          [f],
        );
      }
      console.log(`baseline: ${files.length} 件を適用済みとして記録しました`);
      return;
    }

    const { rows } = await client.query<{ name: string }>(
      "select name from public._migrations",
    );
    const applied = new Set(rows.map((r) => r.name));

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`- skip ${file}（適用済み）`);
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      console.log(`▶ apply ${file} ...`);
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(
          "insert into public._migrations (name) values ($1)",
          [file],
        );
        await client.query("commit");
        console.log(`✓ ${file}`);
        count += 1;
      } catch (e) {
        await client.query("rollback");
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `${file} の適用に失敗（ロールバック済み）: ${msg}\n` +
            "既に手動適用済みの DB なら、初回は `npm run migrate -- --baseline` を実行してください。",
        );
      }
    }
    console.log(
      count === 0 ? "適用すべき migration はありません（最新）" : `完了: ${count} 件適用`,
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
