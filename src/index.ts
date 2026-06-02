/**
 * @fileoverview Google Calendar 相互ブロック機能
 * 複数カレンダー間で予定を相互にブロックする
 *
 * - メインプロジェクト（例: CalA、CALENDAR_IDS=A,B,C）: syncCalendarsMain をトリガ登録
 * - サテライトプロジェクト（例: CalD、CALENDAR_IDS=B,D）: syncCalendarsSatellite をトリガ登録
 */

import { runSync, clearAllBlockEvents, clearOutOfRangeBlockEvents } from './sync-engine';

const MAIN_HANDLER = 'syncCalendarsMain';
const SATELLITE_HANDLER = 'syncCalendarsSatellite';
const LEGACY_HANDLER = 'syncCalendars';

/**
 * メインプロジェクト用 同期実行
 */
export function syncCalendarsMain(): void {
  runSyncWithLog('main');
}

/**
 * サテライトプロジェクト用 同期実行
 */
export function syncCalendarsSatellite(): void {
  runSyncWithLog('satellite');
}

function runSyncWithLog(role: string): void {
  console.log(`=== Sync start (role=${role}) ===`);
  try {
    const result = runSync();
    console.log(
      `Sync completed (role=${role}): created=${result.created}, deleted=${result.deleted}, privatized=${result.privatized}, freed=${result.freed}, errors=${result.errors.length}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Sync failed (role=${role}): ${message}`);
  }
}

/**
 * メイン用トリガー設定（15分間隔）
 * 旧 syncCalendars / 他ロールのトリガも併せて削除し、誤実行を防ぐ
 */
export function setupTriggerMain(): void {
  removeAllSyncTriggers();
  ScriptApp.newTrigger(MAIN_HANDLER).timeBased().everyMinutes(15).create();
  console.log(`Trigger created: ${MAIN_HANDLER} every 15 minutes`);
}

/**
 * サテライト用トリガー設定（15分間隔）
 */
export function setupTriggerSatellite(): void {
  removeAllSyncTriggers();
  ScriptApp.newTrigger(SATELLITE_HANDLER).timeBased().everyMinutes(15).create();
  console.log(`Trigger created: ${SATELLITE_HANDLER} every 15 minutes`);
}

export function removeTriggerMain(): void {
  removeAllSyncTriggers();
}

export function removeTriggerSatellite(): void {
  removeAllSyncTriggers();
}

function removeAllSyncTriggers(): void {
  removeTriggerByName(LEGACY_HANDLER);
  removeTriggerByName(MAIN_HANDLER);
  removeTriggerByName(SATELLITE_HANDLER);
}

function removeTriggerByName(handlerName: string): void {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === handlerName) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`Removed ${removed} trigger(s) for ${handlerName}`);
  }
}

// --- 共通（プロジェクトの CALENDAR_IDS を読んで動作）---

/**
 * 自スクリプト管理の自動ブロックイベントを全削除
 */
export function clearAllBlocks(): void {
  try {
    const result = clearAllBlockEvents();
    console.log(`Clear completed: deleted=${result.deleted}, errors=${result.errors.length}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Clear failed: ${message}`);
  }
}

/**
 * 同期対象期間外の自動ブロックイベントを削除
 * SYNC_MONTHS縮小時の孤児化したブロックをクリーンアップする際に使用
 */
export function clearOutOfRangeBlocks(): void {
  try {
    const result = clearOutOfRangeBlockEvents();
    console.log(
      `Clear out-of-range completed: deleted=${result.deleted}, errors=${result.errors.length}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Clear out-of-range failed: ${message}`);
  }
}
