# yatima

> 情報空間を生きる、自分専用の AI 情報収集エージェント。

**yatima** は、AI・技術系の情報（ニュース・論文・ブログ・リリース情報）を自動で集め、要約し、興味に合わせて選り分け、横断的に問いかけられる——自分だけのための RSS リーダー兼インテリジェンス基盤です。

名前はグレッグ・イーガン『ディアスポラ』の主人公 **ヤチマ（Yatima）** に由来します。ポリスの中で孤児として生成された、肉体を持たないソフトウェアの意識。情報空間そのものを住処とするその存在に、「情報を糧に生きるソフトウェア」というこのプロジェクトのコンセプトを重ねています。

## コンセプト

四方から流れ込む情報の辻に立ち、ノイズを払い、意味のあるシグナルだけを手元に届ける。単なるフィードリーダーではなく、AI が収集・要約・選別・対話までを担う「情報の伴走者」を目指します。

## 主な機能

| # | 機能 | 内容 | 状態 |
|---|------|------|------|
| 1 | 📝 自動要約 | 新着記事を日本語で簡潔に要約 | Phase2 実装済み |
| 2 | 🎯 フィルタ / ランキング | 興味プロファイルに合う記事を抽出し、重要度順に提示 | 計画 |
| 3 | 🔭 情報源の自動発見 | 新しい RSS フィード・情報源を AI が探索（feedfinder / RSSHub / arXiv 等） | 計画 |
| 4 | 💬 横断 Q&A・レポート | 集めた記事群への質問応答（RAG）と日次/週次サマリー生成 | 計画 |

## 技術スタック

- **フレームワーク**: Next.js 16 (App Router / Turbopack)
- **DB / ベクトル検索**: Supabase (Postgres + pgvector)
- **収集**: RSS 取得・パース（feedfinder-ts / RSSHub / arXiv API を予定）
- **定期実行**: GitHub Actions cron（毎時。Vercel Hobby は cron 1日1回制限のため収集には非推奨）
- **要約 LLM**: Claude Haiku 4.5（`lib/llm/` でプロバイダ差し替え可能に設計）
- **embedding（予定）**: OpenAI `text-embedding-3-small`

> 想定コスト: インフラ無料枠 **$0/月** + LLM/embedding **約 $1〜2/月**

## ロードマップ

- [x] **Phase 1 — 土台**: RSS 取得 → DB 保存 → 一覧/既読 UI（AI なし）
- [x] **Phase 2 — 要約**: 新着記事に日本語 AI 要約を付与（Claude Haiku 4.5）
- [ ] **Phase 3 — ランキング**: embedding + 興味プロファイルでスコア順表示
- [ ] **Phase 4 — 情報源発見**: feedfinder / RSSHub / arXiv で新フィード提案
- [ ] **Phase 5 — RAG / レポート**: 横断 Q&A + 日次/週次サマリー

---

## アーキテクチャ

```
GitHub Actions (毎時 cron)            Next.js (ローカル / 後で Vercel)
   └ scripts/ingest.ts                   ├ app/page.tsx        記事一覧 + 要約 (anon 読み取り)
      ├ lib/rss/ingest.ts ───────┐       ├ app/feeds/page.tsx  フィード管理
      └ lib/llm/summarize-batch  │       └ app/actions.ts      追加/削除/既読/取得 (service role)
         (service role 書き込み) │
                                 ▼
                        Supabase Postgres
                        (feeds / articles, RLS あり)
```

取得ロジック（`lib/rss/ingest.ts`）と要約バッチ（`lib/llm/summarize-batch.ts`）は SupabaseClient を引数で受け取る純粋関数。cron スクリプト・Server Actions のどちらからでも注入して使える。

---

## セットアップ

### 1. Supabase プロジェクト作成
[supabase.com](https://supabase.com) で無料プロジェクトを作成。

### 2. テーブル作成
ダッシュボードの **SQL Editor** に `supabase/migrations/0001_init.sql` を貼り付けて実行。

### 3. 環境変数
`.env.example` をコピーして `.env.local` を作り、値を埋める。

```bash
cp .env.example .env.local
```

| 変数 | 用途 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | プロジェクト URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | フロント読み取り（RLS 前提） |
| `SUPABASE_SERVICE_ROLE_KEY` | サーバー書き込み（RLS バイパス・非公開） |
| `ANTHROPIC_API_KEY` | Phase2 の AI 要約（未設定なら要約スキップ・取得は成功） |

### 4. 依存インストール & 起動
```bash
npm install
npm run dev      # http://localhost:3000
```

`/feeds` でフィードを追加 → 「今すぐ取得」または下記 cron で記事が入り、AI 要約が付く。

---

## RSS 取得 + 要約

```bash
npm run ingest   # 全 active フィードを取得 → 保存 → 未要約記事を一括要約
```

### 自動化（GitHub Actions）
`.github/workflows/ingest.yml` が **毎時** 実行する。
リポジトリの **Settings > Secrets and variables > Actions** に以下を登録:

| Secret | 値 |
|---|---|
| `SUPABASE_URL` | `NEXT_PUBLIC_SUPABASE_URL` と同じ |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role キー |
| `ANTHROPIC_API_KEY` | Anthropic API キー（要約用） |

毎時アクセスにより Supabase 無料枠の「7日無活動 pause」も自然回避できる。

---

## ディレクトリ

```
app/            UI（記事一覧 / フィード管理 / Server Actions）
lib/supabase/   Supabase クライアント（server=anon, admin=service role）
lib/rss/        RSS 取得・パース・保存コア
lib/llm/        AI 要約（Summarizer 抽象 + Haiku 実装 + バッチ）
scripts/        cron から実行する独立エントリ
supabase/       マイグレーション SQL
features/       BDD spec（user story / Feature / Scenario）
.github/        GitHub Actions cron
```

---

*"There was a mind, and the mind had a name, and the name was Yatima."*
