# CLAUDE.md

## 概要

Google Calendar の複数カレンダー間でブロックイベントを相互に同期するGAS。
加えて、全プロジェクト共通の 1 カレンダーへ予定の中身をコピーする機能を持つ。
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
├── types.ts             # BlockMetadata/BlockCandidate/CopyCandidate/SyncResult 等の型定義
├── config.ts            # スクリプトプロパティ読み込み、同期期間、ラベル導出
├── calendar-service.ts  # CalendarApp 操作、外部系統判定、origin引き継ぎ
├── block-manager.ts     # カレンダーペア間の差分検出・適用、clear
├── sync-engine.ts       # 全カレンダーペアのオーケストレーション
├── copy-service.ts      # Calendar API v3 操作、コピー対象判定、コピー内容の組み立て、出欠の反映
├── copy-engine.ts       # コピーの作成/更新/削除・出欠入力の消費のオーケストレーション
├── rsvp-webapp.ts       # 出欠変更ページのサーバ側（1 件の状態取得・入力保存）
├── ui/rsvp.html         # 出欠変更ページの画面（ビルドで dist/ へコピー）
└── index.ts             # グローバル関数エクスポート
```

### GASグローバル関数

| 関数 | 用途 |
|------|------|
| `syncCalendarsMain()` | メイン用同期（トリガ登録ハンドラ） |
| `syncCalendarsSatellite()` | サテライト用同期（トリガ登録ハンドラ） |
| `setupTriggerMain()` | メイン用 15分トリガを登録（全ロールトリガ削除後） |
| `setupTriggerSatellite()` | サテライト用 15分トリガを登録（全ロールトリガ削除後） |
| `removeTriggerMain()` / `removeTriggerSatellite()` | 全 sync トリガ削除（旧 `syncCalendars` トリガ含む） |
| `clearAllBlocks()` | 自スクリプト管理の全自動ブロック削除（他プロジェクト管理は保護） |
| `clearOutOfRangeBlocks()` | 同期対象期間外の孤児ブロック削除 |
| `copyEvents()` | 共通カレンダーへのイベントコピー（トリガ登録ハンドラ） |
| `setupCopyTrigger()` / `removeCopyTrigger()` | コピー用 15分トリガの登録・削除（sync トリガとは独立） |
| `clearAllCopies()` | 自プロジェクト担当のコピーを全削除（他プロジェクト担当は保護） |
| `clearOutOfRangeCopies()` | 同期対象期間外に取り残されたコピー削除 |
| `doGet(e)` | 出欠変更ページ（メインのみデプロイ。`?c=<コピー元カレンダー>&e=<コピー元イベント>`） |
| `submitResponse()` | ページのクライアントから `google.script.run` 経由で呼ばれる |

## イベントコピー機能

全プロジェクト共通の 1 カレンダーへ、担当カレンダーの予定をタイトル・description・ゲスト・Meet URL つきでコピーする。ブロック同期とは独立したトリガ（`copyEvents`）で動く。

- **Calendar API v3（Advanced Calendar Service）が必須**。Meet URL の取得・所有者の出欠判定・`extendedProperties.private` への不可視メタデータ格納がこれに依存する。`dist/appsscript.json` の `enabledAdvancedServices` で有効化し、各プロジェクトで再認可が必要
- **担当分離**: コピー元は `CALENDAR_IDS` ではなく `COPY_SOURCE_IDS` で明示する。ブリッジカレンダーは複数プロジェクトの `CALENDAR_IDS` に含まれるため、流用すると二重コピーと振動が起きる
- **削除責任分離**: 作成・更新・削除はすべて自プロジェクトの `COPY_SOURCE_IDS` 由来のコピーのみが対象
- コピー先カレンダーは `CALENDAR_IDS` に含めてはならない（`getCopyConfig()` が検証してエラーにする）
- ゲストは招待せず description に列挙する（実在の相手に招待メールが飛ぶため）
- 更新は `Event.updated` と保存済み `sourceUpdated` の比較、および出欠の変化で差分 patch

## 出欠変更ページ（ウェブアプリ）

集約カレンダーのコピーの description に載せたリンクから、その 1 件の出欠と返信メモを変更する画面。一覧は持たない（カレンダーの下位互換になるため）。**メインだけ**をウェブアプリとしてデプロイする（`dist/appsscript.json` の `webapp` は `access: MYSELF` / `executeAs: USER_DEPLOYING`）。

- リンクは `?c=<コピー元カレンダー>&e=<コピー元イベント>`。**コピー先の event ID は使わない** — insert のレスポンスを待たないと決まらず、リンクを書くために作成直後もう一度 patch する必要が出るため。ページ側は `privateExtendedProperty` でコピーを引く
- リンクの URL はスクリプトプロパティ `RSVP_WEB_APP_URL` から取る。サテライトも同じリンクを description に書くため、`ScriptApp.getService().getUrl()` は使えない（自分自身の URL を書いてしまう）
- Calendar API は RSVP の変更に「そのカレンダーへの書き込み権限」を要求するため、CalD の予定はメインから直接書けない。入力をコピーの `pendingAt` / `pendingResponse` / `pendingComment` に置き、**各プロジェクトの `copyEvents` が自分の `COPY_SOURCE_IDS` 由来の入力だけを反映する**（メイン担当分は `submitResponse` 内で即時反映）
- 元イベントへの書き込みは attendees 配列ごと patch する（自分のエントリだけを差し替える。配列を部分送信すると他のゲストが消える）。反映結果は patch のレスポンスから読み直して保存する
- **返信メモは `attendees[].comment`** なので主催者と他ゲストに見える。集約カレンダー側には description の `# 返信メモ` として出る
- コピー同期の patch はウェブアプリが書いたメタを既存値からマージして保持する。コピー同期側が書くのは `isCopy` / `sourceCalendarId` / `sourceEventId` / `sourceUpdated` / `responseStatus` / `responseComment` だけ
- `submitResponse` は `copyEvents` と同じ ScriptLock を取る（同時 patch による入力消失の防止）
- 欠席にしたコピーは削除せず、タイトルに `❌` を付けて `transparent` にする（ページから取り消せるようにするため）
- **ウェブアプリはコード push だけでは更新されない**。GAS エディタで「デプロイを管理 > 編集 > バージョン: 新バージョン」が必要

### スクリプトプロパティ

| キー | 役割 |
|------|------|
| `COPY_TARGET_CALENDAR_ID` | コピー先の共通カレンダー ID（全プロジェクト同値） |
| `COPY_SOURCE_IDS` | 自プロジェクトが担当するコピー元（カンマ区切り） |
| `CALENDAR_LABELS` | `<calendarId>:<LABEL>[:<colorId>]` をカンマ区切り。未設定時はドメインからラベルを導出 |
| `RSVP_WEB_APP_URL` | メインの出欠変更ページの `/exec` URL。全プロジェクトに同値を設定する |

### メタデータ設計

コピーイベントのメタは `extendedProperties.private`（Calendar API v3）。コピー同期が書く 6 キーに加え、ウェブアプリが `pendingAt` / `pendingResponse` / `pendingComment` を、反映処理が `responseError` を書く。Calendar API は値を削除できないため、消費済みの入力は空文字で消す（`pendingAt` の有無が未反映の入力があるかの判定）。

ブロックイベントの description には JSON 形式でメタデータを埋め込む。

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

- 読み取りは 1 カレンダー 1 回（`readCalendarSnapshot`）。ペアごとに読み直さず、作成・削除でターゲットの索引を更新しながらメモリ上で差分を解く
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

### イベントコピー（全プロジェクト共通）
1. コピー先カレンダーを作成し、他プロジェクトの実行アカウントに「予定の表示と変更」権限で共有
2. スクリプトプロパティ `COPY_TARGET_CALENDAR_ID` / `COPY_SOURCE_IDS` / `CALENDAR_LABELS` を設定
3. `bun run deploy:*` で Advanced Calendar Service 入りのマニフェストを push
4. `copyEvents()` を 1 回手動実行して Advanced Service の認可を通し、ログで created 件数を確認
5. `setupCopyTrigger()` を 1 回手動実行

## ブランチ

ベースブランチ: main

## 注意事項

- GAS環境ではES Modulesが使えないため、webpackでバンドルが必要
- webpackはdevelopmentモードを使用（productionモードはgas-webpack-pluginと競合）
- `clasp` は `~/.clasprc.json` を単一参照する。メイン⇔サテライト切替時は `clasp logout && clasp login` が必要
