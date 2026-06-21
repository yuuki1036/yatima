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

## デプロイ（Vercel）

UI を Vercel Hobby（無料枠）にデプロイする。Next.js 16 の verified adapter なので zero-config。
`vercel.json` は不要、Vercel Cron も使わない（収集は GitHub Actions のまま）。

```bash
# Vercel で GitHub の yuuki1036/yatima を Import（または npx vercel でリンク）
# 下表の環境変数を Production / Preview に登録（値は .env.local から転記）
# Deploy 実行 → 本番 URL 払い出し。以降は main への push で自動デプロイ
```

環境変数（4つ）:

| 変数 | 用途 |
|------|------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 読み取り / 書き込み両方 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Server Component の読み取り |
| `SUPABASE_SERVICE_ROLE_KEY` | 書き込み Server Action（RLS バイパス）。クライアントに露出させない |
| `ANTHROPIC_API_KEY` | `refreshNow`（今すぐ取得）経由の Haiku 要約 |

- ingest cron は別系統で secrets 名が `SUPABASE_URL`（`NEXT_PUBLIC_` なし）。混同しないこと。
- Node は `engines.node >=22`。Vercel もこれを見て Node 22 で動く。
- 現状は認証なしで公開。`refreshNow` 等の Server Action が無認証で叩けるため、URL を知られると課金リスクあり（1回の上限は要約 20 件で頭打ち）。公開後に認証導入を検討する。
