---
project: RSS-READER
created: 2026-06-05
---
# RSS-READER: RSS Reader

## 概要
自分専用の AI 情報収集 RSS リーダー（主に AI / 技術系の情報収集が目的）をフルスクラッチ自作する。
利用者は開発者本人のみ。無料〜低コストのクラウド（Vercel / Supabase 無料枠）で運用する。

必須 AI 機能（4つ）: ①記事の日本語自動要約 ②フィルタ/ランキング ③情報源の自動発見 ④横断 Q&A・レポート生成。

技術スタック: Next.js 16 (App Router) + Supabase (Postgres + pgvector) + GitHub Actions cron + 安価な LLM API。

MVP ロードマップ:
- **Phase1（土台・実装済み）**: RSS 取得 → DB 保存 → 一覧 UI（AI なし）
- Phase2: 日本語 AI 要約
- Phase3: pgvector フィルタ/ランキング
- Phase4: 情報源の自動発見
- Phase5: 横断 Q&A・レポート（RAG）

## ステータスサマリー
| ステータス | 件数 |
|-----------|------|
| backlog | 0 |
| in-progress | 0 |
| frozen | 0 |
| debt | 0 |
| completed | 0 |

## 関連 Issue
| ID | タイトル | ステータス | タイプ |
|----|---------|-----------|--------|
