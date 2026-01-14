# CLAUDE.md

## 概要

Google Apps Script プロジェクトテンプレート。
TypeScript + webpack + clasp によるモダンな GAS 開発環境を提供。

## 技術スタック

- TypeScript + webpack + clasp
- Google Apps Script
- bun（パッケージマネージャー）

## コマンド

```bash
bun run build       # webpackでビルド（dist/bundle.js生成）
bun run build:watch # ファイル変更時に自動ビルド
bun run typecheck   # TypeScript型チェック
bun run lint        # ESLint実行
bun run lint:fix    # ESLint自動修正
```

### デプロイ禁止

ローカルからのデプロイは禁止。以下のコマンドは実行しないこと:

```bash
# 実行禁止
bun run push
bun run deploy
clasp push
```

デプロイはGitHub Actions経由でのみ実行する（mainブランチへのプッシュ時に自動実行）。

## アーキテクチャ

```
src/
└── index.ts    # エントリーポイント（グローバル関数エクスポート）
```

### GASグローバル関数の公開

GASから呼び出す関数は `src/index.ts` でエクスポートし、webpackのgas-webpack-pluginがグローバル関数として公開する。

## デプロイ

mainブランチへのプッシュでGitHub Actionsが自動デプロイを実行。

IMPORTANT: ローカルからのデプロイは禁止。必ずPR経由でmainにマージすること。

### 初回セットアップ

1. `.clasp.json` に `scriptId` を設定
2. GitHub Secretsに `CLASPRC_JSON` を設定（clasp認証情報）

## サブエージェント呼び出し時の追加情報

IMPORTANT: サブエージェント（ユーザーレベル汎用版）を呼び出す際は、以下の情報をタスク指示に含めること。

### quality-checker / typecheck-runner / lint-runner

対象: src/
typecheck: bun run typecheck
lint: bun run lint

### self-reviewer / pr-reviewer

ベースブランチ: main
アーキテクチャルール:
  - index.ts: エントリーポイント（グローバル関数エクスポートのみ）

追加チェック:
  - GAS固有のAPI（SpreadsheetApp等）の適切な使用
  - グローバル関数はindex.tsでのみエクスポート

## 注意事項

- GAS環境ではES Modulesが使えないため、webpackでバンドルが必要
- webpackはdevelopmentモードを使用（productionモードはgas-webpack-pluginと競合）
- スプレッドシートの列構成等はプロジェクト固有の設定ファイルで定義
