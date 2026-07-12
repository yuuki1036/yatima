---
last-validated: 2026-07-08
phase: current
role: yatima を運用する開発者本人
---

# Epic: 嗜好起点で新しい情報源を自動発見したい（方式②）

## User Story

Userは、**yatima を運用する開発者本人** として、**タグ嗜好の上位テーマを起点に Tavily 検索＋LLM 選別で新しい情報源候補が週次で自動発見され、承認待ちに積まれる** ようにしたい。

## Why（動機）

手動でフィードを探さなくても、まだ接点のない良質ソースへ発見範囲を広げたい。方式①（記事リンク発掘）は「今読んでいる記事の参照先」しか掘れず、既存の購読圏の外にあるソースには届かない。嗜好を起点にした検索ベースの発見で、購読圏の外側を継続的に開拓する（YAT-38 / 親調査 YAT-15）。

## What（成果物の輪郭）

このエピックが完了した時、以下が達成されている:

- [ ] 週次 cron（既存 discover.yml）で方式②が方式①と併走し、発見候補が承認待ちに積まれる
- [ ] 嗜好タグの上位テーマから検索クエリが組まれ、Tavily で候補サイトを検索する
- [ ] LLM は検索結果の実在 URL からの選別のみを行い、URL を生成しない
- [ ] 発見候補は既存の検証ゲート（`runDiscoveryGate`）を通過して登録される
- [ ] 承認 UI で方式②由来であること（発見経路）が識別できる

## Acceptance Criteria（受入条件）

以下の Scenario が `spec.md` で定義され、全て pass する:

- [ ] AC-1: 週次実行で嗜好上位テーマの発見候補が承認待ちに積まれる → `spec.md:#scenario-1`
- [ ] AC-2: 既存フィード・既存候補と重複するドメインは登録されない → `spec.md:#scenario-2`
- [ ] AC-3: LLM が生成した URL は使われない（検索結果の実在 URL のみ通る） → `spec.md:#scenario-3`
- [ ] AC-4: 週次実行あたりの検索クエリ数が上限を超えない（無料枠ガード） → `spec.md:#scenario-4`
- [ ] AC-5: 嗜好タグが空・検索 API 障害でも、収集や方式①の実行を壊さない → `spec.md:#scenario-5` / `spec.md:#scenario-6`
- [ ] AC-6: 検索結果由来のテキストによる prompt injection で選別が乗っ取られない → `spec.md:#scenario-7`
- [ ] AC-7: 承認 UI で発見経路（方式②）が識別できる → `spec.md:#scenario-8`

> AC は `spec.md` の Scenario と **双方向リンク** する。spec.md 側からも epic.md の AC 番号を参照する。

## スコープ外

このエピックで **やらないこと** を明示:

- 方式③（OPML / awesome-feeds 取込）
- credibility の動的学習（静的低初期値＋人手承認のまま）
- 検索 API の差し替え抽象化・Tavily 有料化対応
- 承認 UI の大幅拡張（発見経路バッジの追加のみ）

## 関連 epic

- 依存: YAT-16 発見基盤（検証ゲート・承認制 UI・週次 cron）— 実装済み
- 後続: なし（Phase4 の発見フロントはこれで①②が揃う）

## 用語

このエピック内で使う固有語のうち、`all_spec.md` の用語 SSoT に未登録のもの:

- 発見候補: 自動発見されたが未承認のフィード（`feed_candidates` の行。status=pending）
- 発見経路: 発見候補がどの方式で見つかったかの記録（`discovered_from`。provenance）
- 嗜好タグ: フィードバックから学習したタグごとの重み（`preferences` kind=tag）
- 選別: 検索結果のうち購読価値のあるサイトだけを LLM が選ぶ処理（URL の生成はしない）

> 用語が確定したら `all_spec.md` に昇格させる。
