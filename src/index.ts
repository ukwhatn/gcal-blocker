/**
 * @fileoverview Google Calendar 相互ブロック機能
 * 複数カレンダー間で予定を相互にブロックする
 */

import { runSync } from './sync-engine';

/**
 * カレンダー同期を実行
 * 手動実行またはトリガーから呼び出される
 */
export function syncCalendars(): void {
  try {
    const result = runSync();
    console.log(
      `Sync completed: created=${result.created}, deleted=${result.deleted}, errors=${result.errors.length}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Sync failed: ${message}`);
  }
}

/**
 * 定期実行トリガーを設定（15分間隔）
 */
export function setupTrigger(): void {
  // 既存トリガーを削除
  removeTrigger();

  ScriptApp.newTrigger('syncCalendars').timeBased().everyMinutes(15).create();

  console.log('Trigger created: syncCalendars every 15 minutes');
}

/**
 * トリガーを削除
 */
export function removeTrigger(): void {
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'syncCalendars') {
      ScriptApp.deleteTrigger(trigger);
    }
  }
  console.log('Existing triggers removed');
}
