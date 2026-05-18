# gcal-blocker

Google Calendar の複数カレンダー間で予定を相互ブロックする GAS。

「Cal-A に予定が入っていたら、Cal-B/C/D にも『予定あり(自動ブロック)』を入れて他者からの招待を弾く」用途。
出欠ステータス・「予定なし」設定・除外プレフィックスを尊重し、メタデータベースで作成/削除を冪等に追跡する。

## ブロック構成パターン

### パターン 1: シンプル（メインのみ）

CalA/B/C のように、互いに Edit 権限を付与できるカレンダー群を 1 つの GAS で相互ブロック。

```
CalA ←→ CalB
  ↕     ↕
CalC ←--+
```

- 1 つの GAS プロジェクト（CalA アカウントで動作、CALENDAR_IDS=A,B,C）
- 15 分間隔のトリガで全ペア相互同期

### パターン 2: メイン + サテライト（別Org連携）

別 Org の CalD が CalA に Edit 権限を付けられない場合、CalB を共有ブリッジに使う 2 プロジェクト構成。

```
[メイン: CalAアカウント]      [サテライト: CalDアカウント]
CalA ←→ CalB ←→ CalC          CalB ←→ CalD
         ↕↑
         └─────────────────────┘ (CalB を共有)
```

- メイン: CalA アカウント・`CALENDAR_IDS=A,B,C`・`syncCalendarsMain` を 15 分トリガ
- サテライト: CalD アカウント・`CALENDAR_IDS=B,D`・`syncCalendarsSatellite` を 15 分トリガ
- 同じ bundle.js を両プロジェクトにデプロイ
- 反映ラグ最大 30 分（メイン 15 分 + サテライト 15 分）

伝搬経路:
- A→B→D: メインが A→B にブロック → サテライトが B→D に伝搬
- D→B→A/C: サテライトが D→B にブロック → メインが B→A/C に伝搬

## ローカルに必要なもの

- [Node.js](https://nodejs.org/) (clasp の内部で利用)
- [Bun](https://bun.sh/)

## 開発コマンド

```bash
bun install                 # 依存パッケージインストール
bun run build               # webpack ビルド (dist/bundle.js 生成)
bun run build:watch         # ファイル変更時に自動ビルド
bun run typecheck           # TypeScript 型チェック
bun run lint                # ESLint
bun run lint:fix            # ESLint 自動修正
bun run deploy:main         # メイン GAS プロジェクトへデプロイ
bun run deploy:satellite    # サテライト GAS プロジェクトへデプロイ
```

## デプロイ運用

**ローカル手動デプロイのみ**。IP 制限により GitHub Actions から GAS API を叩けないため、CI/CD は採用していない。

`clasp` は `~/.clasprc.json` を単一参照するため、メイン/サテライトのアカウント切替時は `clasp logout && clasp login` が必要。

```bash
# メインへのデプロイ
clasp login --status            # 現在のアカウント確認
# 必要なら: clasp logout && clasp login で CalA に切替
bun run deploy:main

# サテライトへのデプロイ
clasp logout && clasp login     # CalD に切替
bun run deploy:satellite
```

`deploy:*` は内部で `.clasp-{main,satellite}.json` を `.clasp.json` にコピーしてから `clasp push` する。`.clasp.json` は gitignore。

## 初回セットアップ

### メインプロジェクト
1. CalA アカウントで GAS プロジェクト作成（[Apps Script Console](https://script.google.com/home)）→ scriptId 取得
2. `.clasp-main.json` に scriptId を記載してコミット
3. ローカルで `bun install` → `clasp login`（CalA アカウント）
4. `bun run deploy:main`
5. GAS エディタでスクリプトプロパティ `CALENDAR_IDS=<CalA>,<CalB>,<CalC>` を設定
6. CalB/C のカレンダー設定で CalA に「予定の表示と変更」権限を付与
7. GAS エディタで `setupTriggerMain()` を 1 回手動実行
8. `syncCalendarsMain()` を手動実行して動作確認

### サテライトプロジェクト
1. CalD アカウントで新規 GAS プロジェクト作成 → scriptId 取得
2. `.clasp-satellite.json` の `REPLACE_WITH_CALD_SCRIPT_ID` を実値に置換してコミット
3. CalD のカレンダー設定で CalB を「予定の表示と変更」権限で共有
4. ローカルで `clasp logout && clasp login`（CalD アカウントで認証）
5. `bun run deploy:satellite`
6. GAS エディタでスクリプトプロパティ `CALENDAR_IDS=<CalB の ID>,<CalD の ID>` を設定（**必須、未設定だとエラー**）
7. GAS エディタで `setupTriggerSatellite()` を 1 回手動実行
8. `syncCalendarsSatellite()` を手動実行して動作確認（ログで `role=satellite` 確認）

## マイグレーション（既存環境からの移行）

旧 `syncCalendars` トリガで運用していた場合の手順:

**CRITICAL**: 旧関数（`syncCalendars` / `setupTrigger` / `removeTrigger`）は本バージョンで削除済み。旧トリガが残ったままデプロイすると、トリガ実行時に「関数が見つからない」エラーが発生する。デプロイ前に旧トリガを削除すること。

1. GAS エディタを開き、左メニュー「トリガー」から **旧 `syncCalendars` トリガを手動削除**
2. ローカルで最新コードを pull
3. `bun run deploy:main` を実行
4. GAS エディタで `setupTriggerMain()` を 1 回手動実行（新 `syncCalendarsMain` トリガが登録される）
5. `syncCalendarsMain()` を手動実行して動作確認

## グローバル関数一覧

| 関数 | 用途 |
|------|------|
| `syncCalendarsMain()` | メイン用同期（トリガ登録ハンドラ） |
| `syncCalendarsSatellite()` | サテライト用同期（トリガ登録ハンドラ） |
| `setupTriggerMain()` | メイン用 15 分トリガを登録（全ロールトリガ削除後） |
| `setupTriggerSatellite()` | サテライト用 15 分トリガを登録（全ロールトリガ削除後） |
| `removeTriggerMain()` / `removeTriggerSatellite()` | 全 sync トリガ削除（旧 `syncCalendars` トリガ含む） |
| `clearAllBlocks()` | 自スクリプト管理の全自動ブロック削除 |
| `clearOutOfRangeBlocks()` | 同期対象期間外（SYNC_MONTHS 縮小時の孤児）の自動ブロック削除 |

## 設定（src/config.ts）

| 定数 | 役割 |
|------|------|
| `BLOCK_TITLE` | 自動作成ブロックイベントのタイトル（既定: `予定あり(自動ブロック)`） |
| `EXCLUDED_PREFIXES` | ブロック対象から除外するタイトルprefix（`[TASK]`, `⏳`, `✅`, `❌`） |
| `SYNC_MONTHS` | 同期対象期間（現在〜N ヶ月後、既定: 1） |

## 動作確認チェックリスト（手動）

| # | シナリオ | 確認方法 | 期待結果 |
|---|---------|---------|---------|
| 1 | A 新規予定 → C/D に伝搬 | メイン手動実行 → サテライト手動実行 | C/B/D に origin=A のブロック作成 |
| 2 | D 新規予定 → A/C に伝搬 | サテライト手動実行 → メイン手動実行 | B/A/C に origin=D のブロック作成 |
| 3 | A 削除 → C/D のブロック削除 | メイン手動実行 → サテライト手動実行 | C/B/D の origin=A ブロック消失 |
| 4 | D 削除 → A/C のブロック削除 | サテライト手動実行 → メイン手動実行 | B/A/C の origin=D ブロック消失 |
| 5 | D→B→A 後の再伝搬なし | メイン手動実行を 3 サイクル | A 上の origin=D ブロック数が増加しない |
| 6 | A→B→D 後の再伝搬なし | サテライト手動実行を 3 サイクル | D 上の origin=A ブロック数が増加しない |
| 7 | 既存 metadata fallback | 旧形式メタデータ（origin フィールド無し）のブロックが残存している状態で同期実行 | エラーなく動作、source を origin 扱いで処理 |
| 8 | clearAllBlocks のスコープ分離 | メインで `clearAllBlocks()` 実行 | B 上の source=D（サテライト作成）ブロックは消えない |

## アーキテクチャ

```
src/
├── types.ts             # BlockMetadata/BlockCandidate/SyncResult/CalendarConfig 型定義
├── config.ts            # スクリプトプロパティ読み込み、同期期間
├── calendar-service.ts  # CalendarApp 操作、外部系統判定、origin 引き継ぎ
├── block-manager.ts     # カレンダーペア間の差分検出・適用、clear
├── sync-engine.ts       # 全カレンダーペアのオーケストレーション
└── index.ts             # グローバル関数エクスポート
```

### メタデータ設計

ブロックイベントの description に JSON 形式でメタデータを埋め込む:

```json
{
  "isAutoBlock": true,
  "sourceCalendarId": "<直接の取得元>",
  "sourceEventId": "<取得元 event ID>",
  "sourceStartTime": "<ISO8601>",
  "originCalendarId": "<伝搬起源>",
  "originEventId": "<起源 event ID>",
  "originStartTime": "<ISO8601>",
  "createdAt": "<ISO8601>"
}
```

- **内部系統判定**: `direct sourceCalendarId ∈ 自スクリプトの CALENDAR_IDS` なら除外（無限ループ防止）
- **キー生成**: origin ベース（A→B 直接と A→B→D 経由が同じキーで重複検知）
- **削除責任分離**: 各 sync ペアは `direct source` 一致のブロックのみ削除
- **外部自動ブロックの bypass**: 別アカウント実行時 `getMyStatus()` が不安定なため、外部系統の自動ブロックは出欠フィルタを通さず必ず candidate 化

## ディレクトリ・ファイル構成

```
.
├── dist/                       # ビルド後のファイル（clasp のプッシュ対象）
│   ├── appsscript.json         # GAS マニフェスト
│   └── bundle.js               # webpack バンドル出力
├── src/                        # ソースコード
├── .clasp-main.json            # メインプロジェクトの scriptId（コミット済み）
├── .clasp-satellite.json       # サテライトプロジェクトの scriptId（コミット済み）
├── .clasp.json                 # deploy:* 実行時に動的生成（gitignore）
├── eslint.config.mjs
├── package.json
├── tsconfig.json
└── webpack.config.js
```
