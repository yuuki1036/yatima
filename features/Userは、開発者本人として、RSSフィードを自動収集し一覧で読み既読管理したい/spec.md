---
last-validated: 2026-06-04
phase: current
role: 自分専用RSSリーダーを使う開発者本人
epic: ./epic.md
---

# Feature: RSSフィードの自動収集と閲覧（Phase 1 土台）

> User story: Userは、**自分専用RSSリーダーを使う開発者本人** として、**複数のRSS/Atomフィードを自動収集し、横断一覧で新着順に読み、既読管理し、フィードを登録・削除** したい
> Why: 詳細は [epic.md](./epic.md) を参照

## Background

- 共通仕様は [../common_spec.md](../common_spec.md) を参照（単一利用者・認証なし・収集エラーの扱い・閾値）
- 用語定義は [../all_spec.md](../all_spec.md) を参照（用語 SSoT）

このフィーチャー固有の前提:

```gherkin
Given DB に feeds テーブルと articles テーブルが存在する
And 収集は cron（GitHub Actions → /api/cron/fetch）から起動される
```

---

## Scenarios

### Scenario 1: 有効なフィードを登録する

> Trace: [epic.md AC-1](./epic.md#acceptance-criteria受入条件)

```gherkin
Given フィードが 1 件も登録されていない
When 利用者が有効な RSS フィードの URL を登録する
Then フィードが feeds テーブルに保存される（active=true）
And フィードのタイトル・サイトURL がフィードのメタ情報から取得され保存される
```

**カバーする因子**: フィードURL=有効なRSS, 形式=RSS

---

### Scenario 2: 不正・重複なURLの登録を拒否する

> Trace: [epic.md AC-2](./epic.md#acceptance-criteria受入条件)

```gherkin
Scenario Outline: フィード登録のバリデーション
  Given フィードが <事前状態> である
  When 利用者が <input> を登録しようとする
  Then 結果は <expected> になる

  #### Examples

  | input | 事前状態 | expected | 因子 |
  |-------|---------|----------|------|
  | 有効なAtom URL | 空 | 登録成功 | 形式=Atom（正常） |
  | フィードでないHTMLページのURL | 空 | ERR-FEED-001 で拒否 | RSS/Atom非公開（異常） |
  | 不正な文字列（URLでない） | 空 | ERR-FEED-001 で拒否 | 不正入力（異常） |
  | 既に登録済みのURL | 同URL登録済み | ERR-FEED-002 で拒否 | 重複（境界） |
```

---

### Scenario 3: 収集ジョブが新着記事を保存する

> Trace: [epic.md AC-3](./epic.md#acceptance-criteria受入条件)

```gherkin
Given active=true のフィードが登録されている
And そのフィードに未取得の新着記事が複数ある
When cron が /api/cron/fetch を起動する
Then 各フィードが取得・パースされる
And 新着記事が articles テーブルに保存される（is_read=false, published_at で並べ替え可能）
And フィードの last_fetched_at が更新される
```

**カバーする因子**: 取得結果=成功, guid=あり

---

### Scenario 4: 重複記事は二重保存されない

> Trace: [epic.md AC-4](./epic.md#acceptance-criteria受入条件)

```gherkin
Scenario Outline: 記事の重複排除
  Given 記事 <記事> が既に保存されている
  When 収集で同じフィードを再取得し <再取得記事> を得る
  Then <expected>

  #### Examples

  | 記事 | 再取得記事 | expected | 因子 |
  |------|-----------|----------|------|
  | guid=X の記事 | 同じ guid=X | 二重保存されない（guid で一意） | guid一致（重複） |
  | guid 無し・url=U の記事 | guid 無し・同じ url=U | 二重保存されない（url で一意） | guidなし→url fallback（重複） |
  | guid=X の記事 | guid=Y（別記事） | 新規記事として保存される | 別記事（正常） |
```

---

### Scenario 5: 一部フィードの失敗が他フィードの収集を妨げない

> Trace: [epic.md AC-5](./epic.md#acceptance-criteria受入条件)

```gherkin
Scenario Outline: 収集の失敗耐性
  Given 健全なフィード A と <問題フィード> B が登録されている
  When cron が収集を実行する
  Then フィード A の新着記事は保存される
  And <B結果>

  #### Examples

  | 問題フィード | B結果 | 因子 |
  |-------------|-------|------|
  | タイムアウトするフィード B | B はスキップされ ERR-FETCH-001 がログに記録される | タイムアウト（異常） |
  | 5xx を返すフィード B | B はスキップされ ERR-FETCH-002 がログに記録される | サーバエラー（異常） |
  | 不正XMLを返すフィード B | B はスキップされ ERR-PARSE-001 がログに記録される | パース失敗（異常） |
```

---

### Scenario 6: 記事一覧がフィード横断・新着順で表示される

> Trace: [epic.md AC-6](./epic.md#acceptance-criteria受入条件)

```gherkin
Given 複数フィードにまたがる記事が保存されている
When 利用者が記事一覧を開く
Then 全フィードの記事が published_at の新しい順で表示される
And 1 ページあたり 50 件（共通閾値）でページングされる
And 各記事にタイトル・フィード名・公開日時・既読状態が表示される
```

**カバーする因子**: 並び順=新着順, 横断=全フィード

---

### Scenario 7: 記事を既読にでき、未読フィルタに反映される

> Trace: [epic.md AC-7](./epic.md#acceptance-criteria受入条件)

```gherkin
Given is_read=false の記事が一覧に表示されている
When 利用者がその記事を開く（既読にする）
Then 記事の is_read が true に更新される
And 「未読のみ」フィルタを適用すると、その記事は一覧から外れる
And 再読み込みしても既読状態が保持されている（DB 永続化）
```

**カバーする因子**: 状態遷移=未読→既読, フィルタ=未読のみ

---

### Scenario 8: フィードを削除する

> Trace: [epic.md AC-8](./epic.md#acceptance-criteria受入条件)

```gherkin
Given フィードが登録されている
When 利用者がそのフィードを削除する
Then フィードが feeds テーブルから削除される
And そのフィードに紐づく記事も削除される（cascade）
And 削除後の収集対象から外れる
```

**カバーする因子**: 削除=cascade

---

## 同値分割・境界値分析表

| 因子 | 同値クラス | 代表値 | カバー Scenario |
|------|-----------|--------|------------------|
| フィードURL形式 | 正常（RSS） | 有効RSS URL | Scenario 1 |
| フィードURL形式 | 正常（Atom） | 有効Atom URL | Scenario 2 |
| フィードURL形式 | 異常（フィード非公開HTML） | HTMLページURL | Scenario 2 |
| フィードURL形式 | 異常（不正文字列） | URLでない文字列 | Scenario 2 |
| フィードURL重複 | 境界（既登録と同一） | 登録済みURL | Scenario 2 |
| 記事識別子 | 正常（guidあり） | guid=X | Scenario 3, 4 |
| 記事識別子 | 正常（guidなし→url） | url=U | Scenario 4 |
| 取得結果 | 正常（成功） | 200 + 有効XML | Scenario 3 |
| 取得結果 | 異常（タイムアウト） | 10秒超 | Scenario 5 |
| 取得結果 | 異常（4xx/5xx） | 500 | Scenario 5 |
| 取得結果 | 異常（不正XML） | 壊れたXML | Scenario 5 |
| 記事状態 | 未読→既読 | is_read false→true | Scenario 7 |

## トレーサビリティ

| AC | Scenario | カバー因子 |
|----|----------|------------|
| AC-1 | Scenario 1 | URL形式=RSS（正常） |
| AC-2 | Scenario 2 | URL形式=Atom/異常/不正, 重複 |
| AC-3 | Scenario 3 | 取得結果=成功, guidあり |
| AC-4 | Scenario 4 | 記事識別子=guid/url, 重複/別記事 |
| AC-5 | Scenario 5 | 取得結果=タイムアウト/5xx/不正XML |
| AC-6 | Scenario 6 | 並び順=新着順, 横断 |
| AC-7 | Scenario 7 | 状態遷移=未読→既読 |
| AC-8 | Scenario 8 | 削除=cascade |

---

## エラーケース

`common_spec.md` 参照（ERR-FEED-001/002, ERR-FETCH-001/002, ERR-PARSE-001, ERR-SYS-001）。このフィーチャー固有の追加エラーなし。

## 用語

`all_spec.md` 登録済み。固有の新規用語なし。

## 関連

- 依存フィーチャー: なし
- 後続フィーチャー: Phase 2「記事の日本語自動要約」
