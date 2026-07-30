/**
 * @fileoverview Google Calendar 相互ブロック機能
 * 複数カレンダー間で予定を相互にブロックする
 *
 * - メインプロジェクト（例: CalA、CALENDAR_IDS=A,B,C）: syncCalendarsMain をトリガ登録
 * - サテライトプロジェクト（例: CalD、CALENDAR_IDS=B,D）: syncCalendarsSatellite をトリガ登録
 */

import { runSync, clearAllBlockEvents, clearOutOfRangeBlockEvents } from './sync-engine';
import { runCopy, clearAllCopyEvents, clearOutOfRangeCopyEvents } from './copy-engine';

const MAIN_HANDLER = 'syncCalendarsMain';
const SATELLITE_HANDLER = 'syncCalendarsSatellite';
const LEGACY_HANDLER = 'syncCalendars';
const COPY_HANDLER = 'copyEvents';

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
      `Sync completed (role=${role}): created=${result.created}, deleted=${result.deleted}, privatized=${result.privatized}, adjusted=${result.adjusted}, freed=${result.freed}, errors=${result.errors.length}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Sync failed (role=${role}): ${message}`);
  }
}

/**
 * 共通カレンダーへのイベントコピー（トリガ登録ハンドラ）
 * 実行中に次のトリガが重なると同じイベントを二重作成し得るためロックを取る
 */
export function copyEvents(): void {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    console.log('Copy skipped: another execution is running');
    return;
  }

  try {
    const result = runCopy();
    console.log(
      `Copy completed: created=${result.created}, updated=${result.updated}, deleted=${result.deleted}, errors=${result.errors.length}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Copy failed: ${message}`);
  } finally {
    lock.releaseLock();
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

/**
 * コピー用トリガー設定（15分間隔）
 * ブロック同期のトリガとは独立に管理する（片方の失敗でもう片方が止まらないようにするため）
 */
export function setupCopyTrigger(): void {
  removeTriggerByName(COPY_HANDLER);
  ScriptApp.newTrigger(COPY_HANDLER).timeBased().everyMinutes(15).create();
  console.log(`Trigger created: ${COPY_HANDLER} every 15 minutes`);
}

export function removeCopyTrigger(): void {
  removeTriggerByName(COPY_HANDLER);
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

/**
 * 自プロジェクト担当のコピーイベントを全削除
 */
export function clearAllCopies(): void {
  try {
    const result = clearAllCopyEvents();
    console.log(`Clear copies completed: deleted=${result.deleted}, errors=${result.errors.length}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Clear copies failed: ${message}`);
  }
}

/**
 * 同期対象期間外に取り残されたコピーイベントを削除
 */
export function clearOutOfRangeCopies(): void {
  try {
    const result = clearOutOfRangeCopyEvents();
    console.log(
      `Clear out-of-range copies completed: deleted=${result.deleted}, errors=${result.errors.length}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Clear out-of-range copies failed: ${message}`);
  }
}
