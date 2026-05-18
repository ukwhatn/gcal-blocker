# CLAUDE.md

## 概要

Google Calendar の複数カレンダー間でブロックイベントを相互に同期するGAS。
TypeScript + webpack + clasp によるモダンな GAS 開発環境で構築。

## 技術スタック

- TypeScript + webpack + clasp
- Google Apps Script
- bun（パッケージマネージャー）

## コマンド

```bash
bun run build              # webpackでビルド（dist/bundle.js生成）
bun run build:watch        # ファイル変更時に自動ビルド
bun run typecheck          # TypeScript型チェック
bun run lint               # ESLint実行
bun run lint:fix           # ESLint自動修正
bun run deploy:main        # メインGASプロジェクト（CalAアカウント）へデプロイ
bun run deploy:satellite   # サテライトGASプロジェクト（CalDアカウント）へデプロイ
```

### デプロイ運用

**ローカル手動デプロイ運用**。IP 制限により GitHub Actions から GAS API を叩けないため、CI/CD は採用していない。

```bash
# メインへのデプロイ（CalA アカウント）
clasp login --status            # 現在のログインアカウント確認
# 必要なら: clasp logout && clasp login で CalA に切替
bun run deploy:main

# サテライトへのデプロイ（CalD アカウント）
clasp logout && clasp login     # CalD に切替（メイン後に必須）
bun run deploy:satellite
```

`bun run deploy:*` 以外のデプロイコマンド（`clasp push` 直接実行等）は誤デプロイ防止のため使用禁止。

## アーキテクチャ

### メイン/サテライト構成

- **メインプロジェクト**（CalA アカウント、`CALENDAR_IDS=A,B,C`）: フルメッシュ相互ブロック
- **サテライトプロジェクト**（CalD アカウント、`CALENDAR_IDS=B,D`）: B↔D 相互ブロック
- 別 Org の CalD は CalA に Edit 権限を付けられない制約があるため、CalB を共有ブリッジに使う構成
- 両プロジェクトに同じ bundle.js をデプロイ。トリガに登録する関数だけ変える（`syncCalendarsMain` / `syncCalendarsSatellite`）

伝搬経路:
- A→B→D: メインが A→B にブロック → サテライトが B→D に伝搬
- D→B→A/C: サテライトが D→B にブロック → メインが B→A/C に伝搬
- 反映ラグ最大 30 分（メイン 15 分 + サテライト 15 分）

### ソース構成

```
src/
├── types.ts             # BlockMetadata/BlockCandidate/SyncResult/CalendarConfig 型定義
├── config.ts            # スクリプトプロパティ読み込み、同期期間
├── calendar-service.ts  # CalendarApp 操作、外部系統判定、origin引き継ぎ
├── block-manager.ts     # カレンダーペア間の差分検出・適用、clear
├── sync-engine.ts       # 全カレンダーペアのオーケストレーション
└── index.ts             # グローバル関数エクスポート
```

### GASグローバル関数

| 関数 | 用途 |
|------|------|
| `syncCalendarsMain()` | メイン用同期（トリガ登録ハンドラ） |
| `syncCalendarsSatellite()` | サテライト用同期（トリガ登録ハンドラ） |
| `setupTriggerMain()` | メイン用 15分トリガを登録（全ロールトリガ削除後） |
| `setupTriggerSatellite()` | サテライト用 15分トリガを登録（全ロールトリガ削除後） |
| `removeTriggerMain()` / `removeTriggerSatellite()` | 全 sync トリガ削除 |
| `clearAllBlocks()` | 自スクリプト管理の全自動ブロック削除（他プロジェクト管理は保護） |
| `clearOutOfRangeBlocks()` | 同期対象期間外の孤児ブロック削除 |
| `syncCalendars()` / `setupTrigger()` / `removeTrigger()` | 旧名互換 wrapper（既存トリガ救済用） |

### メタデータ設計

ブロックイベントの description に JSON 形式でメタデータを埋め込む。

```json
{
  "isAutoBlock": true,
  "sourceCalendarId": "<直接の取得元>",
  "sourceEventId": "<直接の取得元 event ID>",
  "sourceStartTime": "<ISO8601>",
  "originCalendarId": "<伝搬起源>",
  "originEventId": "<起源 event ID>",
  "originStartTime": "<ISO8601>",
  "createdAt": "<ISO8601>"
}
```

- 内部系統判定: `direct sourceCalendarId ∈ 自スクリプトの CALENDAR_IDS` なら除外（無限ループ防止）
- キー生成: origin ベース（A→B 直接と A→B→D 経由が同じキーで重複検知）
- 削除責任分離: 各 sync ペアは `direct source` 一致のブロックのみ削除

## 初回セットアップ

### メインプロジェクト
1. CalA アカウントで GAS プロジェクト作成 → scriptId 取得
2. `.clasp-main.json` に scriptId を記載してコミット
3. CalA アカウントで `clasp login`
4. `bun run deploy:main`
5. GAS エディタでスクリプトプロパティ `CALENDAR_IDS=<CalA>,<CalB>,<CalC>` を設定
6. CalB/C のカレンダー設定で CalA に「予定の表示と変更」権限を付与
7. `setupTriggerMain()` を 1 回手動実行

### サテライトプロジェクト
1. CalD アカウントで GAS プロジェクト作成 → scriptId 取得
2. `.clasp-satellite.json` の scriptId placeholder を実値に置換してコミット
3. CalD のカレンダー設定で CalB を「予定の表示と変更」権限で共有
4. `clasp logout && clasp login` で CalD アカウント認証
5. `bun run deploy:satellite`
6. GAS エディタでスクリプトプロパティ `CALENDAR_IDS=<CalB の ID>,<CalD の ID>` を設定
7. `setupTriggerSatellite()` を 1 回手動実行
8. `syncCalendarsSatellite()` を手動実行して動作確認（ログで `role=satellite` 確認）

## ブランチ

ベースブランチ: main

## 注意事項

- GAS環境ではES Modulesが使えないため、webpackでバンドルが必要
- webpackはdevelopmentモードを使用（productionモードはgas-webpack-pluginと競合）
- `clasp` は `~/.clasprc.json` を単一参照する。メイン⇔サテライト切替時は `clasp logout && clasp login` が必要
