# gcal-blocker

Google Calendar の複数カレンダー間で予定を相互ブロックする GAS。

「Cal-A に予定が入っていたら、Cal-B/C/D にも『予定あり(自動ブロック)』を入れて他者からの招待を弾く」用途。
出欠ステータス・「予定なし」設定・除外プレフィックスを尊重し、メタデータベースで作成/削除を冪等に追跡する。

相互ブロックとは別に、**全プロジェクト共通の 1 カレンダーへ予定の中身をコピーする機能**を持つ（[イベントコピー機能](#イベントコピー機能)）。どの環境からでも全カレンダーの予定をタイトル・description つきで一覧できる。

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

## イベントコピー機能

ブロック同期とは独立したトリガ（`copyEvents`）で、担当カレンダーの予定を共通カレンダーへコピーする。

- コピーは Calendar API v3（Advanced Calendar Service）で行う。Meet URL の取得・所有者の出欠判定・不可視メタデータの保持がこれに依存する
- **担当分離**: どのカレンダーをコピーするかは `COPY_SOURCE_IDS` で明示する。ブリッジカレンダーは複数プロジェクトの `CALENDAR_IDS` に含まれるため、`CALENDAR_IDS` を流用すると二重コピーと作成/削除の振動が起きる
- **削除責任分離**: 作成・更新・削除はいずれも自プロジェクトの `COPY_SOURCE_IDS` 由来のコピーのみを対象にする
- コピー先カレンダーは **どのプロジェクトの `CALENDAR_IDS` にも含めない**（含めると全コピーがブロック元になる）。設定時に検証してエラーにする

### コピー内容

| 項目 | 値 |
|------|-----|
| タイトル | `[LABEL] 元タイトル`（LABEL は `CALENDAR_LABELS`、未設定時はドメインから導出） |
| description | 元 description ＋ `# ゲスト`（アドレス列挙）＋ `# Meet`（URL） |
| location | 元 location と Meet URL |
| 開始/終了 | 元と同一（終日は終日イベント） |
| 公開設定 | 元と同一（default / public / private） |
| 予定の有無 | 元と同一（opaque / transparent） |
| 色 | `CALENDAR_LABELS` で指定した colorId（1〜11） |
| ゲスト | **設定しない**（実在の相手に招待メールが飛ぶため description の列挙に留める） |
| 通知 | なし（`useDefault=false`） |

対象期間はブロック同期と分かれており、コピーは現在〜1 年後（`COPY_MONTHS`）を見る。カレンダーごとに一覧取得 1 回で済むため、ブロック同期（`SYNC_MONTHS`、既定 3 ヶ月）より長い期間を扱える。

ブロック同期を長期間に広げないのは、ブロックがカレンダー数に比例して増える（1 予定につき他カレンダー分のブロックが作られる）ためで、先の予定を「見る」用途はコピー側で満たす。

### コピー対象外

自動ブロックイベント / Tasks・誕生日等の非 DEFAULT イベント / `EXCLUDED_PREFIXES` で始まるタイトル / 所有者が欠席（declined）した予定 / キャンセル済み予定。

「予定なし（transparent）」の予定・終日予定・未応答の招待はコピーする。

### 更新と削除

コピーには `extendedProperties.private` に `sourceCalendarId` / `sourceEventId` / `sourceUpdated` を持たせ、元イベントの `updated` と比較して変化したときだけ patch する。元イベントが削除・欠席化・除外対象化されたコピーは削除する。

コピー元の一覧取得に失敗したカレンダーは、そのカレンダー由来のコピーを削除対象から除外する（一時エラーでの全消しを防ぐ）。

削除は自プロジェクト担当分に限られるため、`COPY_SOURCE_IDS` からカレンダーを外すと、そのカレンダーのコピーは残る。掃除するには一度 `COPY_SOURCE_IDS` に戻して `clearAllCopies()` を実行する。

### 共有時の注意

コピー先カレンダーを第三者に共有する場合、**従来の「変更権限」では非公開イベントの詳細まで見える**。詳細を見せたくない相手には「予定の詳細の表示」か、2026-07 から提供の「変更（非公開の予定は予定あり/なしとして表示）」権限を使う。また visibility が `default` の予定は詳細表示権限で中身が見える。

### セットアップ

1. コピー先カレンダーを作成し、他プロジェクトの実行アカウントへ「予定の表示と変更」権限で共有する
2. 各プロジェクトのスクリプトプロパティに `COPY_TARGET_CALENDAR_ID` / `COPY_SOURCE_IDS` / `CALENDAR_LABELS` を設定する
3. `bun run deploy:*` で Advanced Calendar Service を含むマニフェストを push する
4. GAS エディタで `copyEvents()` を 1 回手動実行し、Advanced Service の認可を通す
5. `setupCopyTrigger()` を 1 回手動実行してトリガを登録する

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
| `copyEvents()` | 共通カレンダーへのイベントコピー（トリガ登録ハンドラ） |
| `setupCopyTrigger()` / `removeCopyTrigger()` | コピー用 15 分トリガの登録・削除 |
| `clearAllCopies()` | 自プロジェクト担当のコピーを全削除 |
| `clearOutOfRangeCopies()` | 同期対象期間外に取り残されたコピーを削除 |

## 設定

### スクリプトプロパティ

| キー | 役割 |
|------|------|
| `CALENDAR_IDS` | 相互ブロックの対象カレンダー（カンマ区切り、2 つ以上） |
| `COPY_TARGET_CALENDAR_ID` | コピー先の共通カレンダー ID（全プロジェクト同値） |
| `COPY_SOURCE_IDS` | 自プロジェクトがコピーを担当するカレンダー（カンマ区切り） |
| `CALENDAR_LABELS` | `<calendarId>:<LABEL>[:<colorId>]` をカンマ区切り。未設定のカレンダーはドメインからラベルを導出し色は付けない |

### 定数（src/config.ts）

| 定数 | 役割 |
|------|------|
| `BLOCK_TITLE` | 自動作成ブロックイベントのタイトル（既定: `予定あり(自動ブロック)`） |
| `EXCLUDED_PREFIXES` | ブロック・コピー対象から除外するタイトルprefix（`[TASK]`, `⏳`, `✅`, `❌`） |
| `SYNC_MONTHS` | ブロック同期の対象期間（現在〜N ヶ月後、既定: 3） |
| `COPY_MONTHS` | コピーの対象期間（現在〜N ヶ月後、既定: 12） |

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
├── types.ts             # BlockMetadata/BlockCandidate/CopyCandidate/SyncResult 等の型定義
├── config.ts            # スクリプトプロパティ読み込み、同期期間、ラベル導出
├── calendar-service.ts  # CalendarApp 操作、外部系統判定、origin 引き継ぎ
├── block-manager.ts     # カレンダーペア間の差分検出・適用、clear
├── sync-engine.ts       # 全カレンダーペアのオーケストレーション
├── copy-service.ts      # Calendar API v3 操作、コピー対象判定、コピー内容の組み立て
├── copy-engine.ts       # コピーの作成/更新/削除のオーケストレーション
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

- **読み取りは 1 カレンダー 1 回**: ペアごとに読み直さず、スナップショットを共有してペアの差分はメモリ上で解く（カレンダー 5 つで `getEvents` 45 回 → 5 回）。作成・削除のたびにターゲットの索引を更新するため、同一実行の後続ペアでも重複作成・二重削除は起きない
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
