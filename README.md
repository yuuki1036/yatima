# RSS Reader

自分専用の AI 情報収集 RSS リーダー（主に AI / 技術系の情報収集用）。

- **利用者**: 開発者本人のみ（マルチユーザー認証なし）
- **スタック**: Next.js 16 (App Router) + Supabase (Postgres) + GitHub Actions cron
- **Phase1（現在）**: RSS 取得 → DB 保存 → 一覧表示（AI なし）
- **Phase2 以降**: 日本語 AI 要約 / pgvector ランキング / 情報源自動発見 / 横断 Q&A・レポート

---

## アーキテクチャ

```
GitHub Actions (毎時 cron)            Next.js (ローカル / 後で Vercel)
   └ scripts/ingest.ts                   ├ app/page.tsx        記事一覧 (anon 読み取り)
      └ lib/rss/ingest.ts ──────┐        ├ app/feeds/page.tsx  フィード管理
         (service role 書き込み) │        └ app/actions.ts      追加/削除/既読 (service role)
                                 ▼
                        Supabase Postgres
                        (feeds / articles, RLS あり)
```

取得ロジック（`lib/rss/ingest.ts`）は SupabaseClient を引数で受け取る純粋関数。
cron スクリプト・Server Actions のどちらからでも注入して使える。

---

## セットアップ

### 1. Supabase プロジェクト作成
[supabase.com](https://supabase.com) で無料プロジェクトを作成。

### 2. テーブル作成
ダッシュボードの **SQL Editor** に `supabase/migrations/0001_init.sql` を貼り付けて実行。

### 3. 環境変数
`.env.example` をコピーして `.env.local` を作り、値を埋める
（ダッシュボード > Project Settings > API）。

```bash
cp .env.example .env.local
```

| 変数 | 用途 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | プロジェクト URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | フロント読み取り（RLS 前提） |
| `SUPABASE_SERVICE_ROLE_KEY` | サーバー書き込み（RLS バイパス・非公開） |

### 4. 依存インストール & 起動
```bash
npm install
npm run dev      # http://localhost:3000
```

`/feeds` でフィードを追加 → 「今すぐ取得」または下記 cron で記事が入る。

---

## RSS 取得

```bash
npm run ingest   # 全 active フィードを取得して保存（手動実行）
```

### 自動化（GitHub Actions）
`.github/workflows/ingest.yml` が **毎時** 実行する。
リポジトリの **Settings > Secrets and variables > Actions** に以下を登録:

| Secret | 値 |
|---|---|
| `SUPABASE_URL` | `NEXT_PUBLIC_SUPABASE_URL` と同じ |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role キー |

Actions タブから **Run workflow**（`workflow_dispatch`）で手動実行も可能。
毎時アクセスにより Supabase 無料枠の「7日無活動 pause」も自然回避できる。

---

## ディレクトリ

```
app/            UI（記事一覧 / フィード管理 / Server Actions）
lib/supabase/   Supabase クライアント（server=anon, admin=service role）
lib/rss/        RSS 取得・パース・保存コア
scripts/        cron から実行する独立エントリ
supabase/       マイグレーション SQL
.github/        GitHub Actions cron
```
