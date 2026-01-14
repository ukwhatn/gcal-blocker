# GAS on clasp Template

TypeScript, webpack, clasp を利用して、モダンな開発環境で Google Apps Script (GAS) を構築するためのテンプレートプロジェクトです。

## ローカルに必要なもの

-   [Node.js](https://nodejs.org/) (clasp の内部で利用されます)
-   [Bun](https://bun.sh/)

### セットアップ手順

1.  **Google Apps Script API の有効化**
    開発を始める前に、Google アカウントで [Apps Script API を有効](https://script.google.com/home/usersettings) にする。

2.  **依存パッケージをインストール**
    プロジェクトに必要なライブラリをインストールします。
    ```bash
    bun install
    ```

3.  **Google アカウントで clasp にログイン**
    GAS プロジェクトを操作するために、Google アカウントへのアクセス許可を行います。
    ```bash
    bun run clasp login
    ```
    ブラウザが開き、認証が求められます。承認すると、認証情報がローカルに保存されます。

4.  **GAS プロジェクトを作成**
    [Google Apps Script Console](https://script.google.com/home) から「新しいプロジェクトを作成」してください

5. **ScriptIDを設定**
    プロジェクトのWebエディタを開き、URLの `https://script.google.com/home/projects/<HERE>/edit` から `<HERE>` の部分にある文字列をコピーし、 `.clasp.json` の `scriptId` に設定してください。

6. **GitHub Secretsを設定（CI/CD用）**
    GitHub Actionsでの自動デプロイを有効にするために、リポジトリのSecretsに `CLASPRC_JSON` を設定してください。
    ```bash
    cat ~/.clasprc.json
    ```
    上記コマンドの出力内容をそのまま `CLASPRC_JSON` として登録します。

## 開発の流れ

ソースコードはすべて `src` ディレクトリで管理します。メインファイルは `src/index.ts` です。

webpackによるコンパイルが行われるため、複数ファイルでのソースコード管理が可能です。

GAS から呼び出したい関数は、`export` することでグローバル関数として公開されます（gas-webpack-pluginが自動変換）。

**例: 新しい関数を追加する**

```typescript:src/index.ts
/**
 * スプレッドシートを開いたときに実行される関数
 */
export function onOpen(): void {
  SpreadsheetApp.getUi()
    .createMenu('カスタムメニュー')
    .addItem('挨拶', 'helloWorld')
    .addToUi();
}

/**
 * メニューから呼び出される関数
 */
export function helloWorld(): void {
  Browser.msgBox('こんにちは、世界！');
}
```

### 基本的なコマンド

-   **ビルド**
    `src` 以下の TypeScript をコンパイルし、GAS で実行可能な `bundle.js` を `dist` ディレクトリに作成します。
    ```bash
    bun run build
    ```

-   **型チェック**
    TypeScriptの型エラーをチェックします。
    ```bash
    bun run typecheck
    ```

-   **Lint**
    ESLintでコードスタイルをチェックします。
    ```bash
    bun run lint
    ```

### 開発用コマンド

-   **自動ビルド**
    ファイルの変更を監視し、保存するたびに自動でビルドが実行されます。
    ```bash
    bun run build:watch
    ```

## デプロイ

本テンプレートでは、GitHub Actions経由での自動デプロイを推奨しています。

-   **自動デプロイ（推奨）**
    `main` ブランチへのプッシュ時に自動でGASにデプロイされます。
    PRを作成し、マージすることでデプロイが実行されます。

-   **手動デプロイ**
    ローカルからのデプロイも可能ですが、CI/CDを通さないため非推奨です。
    ```bash
    bun run deploy
    ```

## ディレクトリ・ファイル構成

```
.
├── .github/             # GitHub Actions設定
│   └── workflows/
│       └── deploy.yml   # CI/CDワークフロー
├── dist/                # ビルド後のファイルが格納される（clasp のプッシュ対象）
│   ├── appsscript.json  # GAS のマニフェストファイル
│   └── bundle.js        # webpack によってバンドルされた JS ファイル
├── src/                 # 開発用ソースコード
│   └── index.ts         # メインの TypeScript ファイル
├── .clasp.json          # clasp の設定ファイル (scriptId など)
├── eslint.config.mjs    # ESLint設定
├── package.json         # プロジェクト設定とスクリプト
├── tsconfig.json        # TypeScript のコンパイラ設定
└── webpack.config.js    # webpack の設定
```
