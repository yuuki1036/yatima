# yatima

AI・技術系の情報を集めて日本語要約する、自分専用の RSS リーダー。
（名前はイーガン『ディアスポラ』のヤチマから）

## フェーズ

- [x] Phase 1 — RSS 取得 → 保存 → 一覧 / 既読 UI
- [x] Phase 2 — 新着記事の日本語 AI 要約（Claude Haiku 4.5）
- [ ] Phase 3 — embedding + 興味プロファイルでランキング
- [ ] Phase 4 — 情報源の自動発見
- [ ] Phase 5 — 横断 Q&A / レポート

## スタック

Next.js 16 (App Router) / Supabase (Postgres + pgvector) / Claude Haiku 4.5 / GitHub Actions cron

## 使い方

```bash
cp .env.example .env.local   # Supabase URL/keys, ANTHROPIC_API_KEY を埋める
npm install
npm run dev                  # http://localhost:3000
npm run ingest               # 取得 → 保存 → 未要約記事を一括要約
```

- DB: `supabase/migrations/0001_init.sql` を Supabase の SQL Editor で実行
- 自動収集: `.github/workflows/ingest.yml` が毎時実行（Actions secrets に `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `ANTHROPIC_API_KEY`）
