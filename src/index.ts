/**
 * @fileoverview エントリーポイント
 * GASグローバル関数として公開する関数をエクスポート
 * gas-webpack-pluginがexportされた関数をグローバル関数に変換する
 */

/**
 * メイン関数
 * GASから直接呼び出される
 */
export function main(): void {
  console.log('main');
}
