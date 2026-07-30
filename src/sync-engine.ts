import { BlockCandidate, SyncResult } from './types';
import { getConfig, getSyncPeriod } from './config';
import { syncCalendarPair, clearBlockEvents } from './block-manager';
import {
  CalendarSnapshot,
  findExistingBlockEvents,
  getBlockableEvents,
  makeExcludedEventsTransparent,
  readCalendarSnapshot,
} from './calendar-service';

type CalendarEvent = GoogleAppsScript.Calendar.CalendarEvent;

/**
 * 1 カレンダーにつき 1 回の読み取りから作った、同期に必要な材料
 */
interface CalendarState {
  snapshot: CalendarSnapshot;
  candidates: BlockCandidate[];
  blocks: Map<string, CalendarEvent[]>;
}

/**
 * 全カレンダー間の同期を実行
 */
export function runSync(): SyncResult {
  const config = getConfig();
  const period = getSyncPeriod();

  console.log('=== 同期開始 ===');
  console.log(`対象カレンダー数: ${config.calendarIds.length}`);
  console.log(`対象期間: ${period.start.toISOString()} ~ ${period.end.toISOString()}`);
  console.log(`カレンダーID: ${config.calendarIds.join(', ')}`);

  const result: SyncResult = {
    created: 0,
    deleted: 0,
    privatized: 0,
    adjusted: 0,
    freed: 0,
    errors: [],
  };

  // 各カレンダーを 1 回だけ読み、ペアの差分はメモリ上で解く
  const states = new Map<string, CalendarState>();
  for (const calendarId of config.calendarIds) {
    try {
      const snapshot = readCalendarSnapshot(calendarId, period);
      states.set(calendarId, {
        snapshot,
        candidates: getBlockableEvents(snapshot, config.calendarIds),
        blocks: findExistingBlockEvents(snapshot),
      });
      console.log(`読み取り: ${calendarId} (events=${snapshot.events.length})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`read ${calendarId}: ${message}`);
      console.error(`読み取りエラー: ${calendarId}: ${message}`);
    }
  }

  // 各カレンダーから他の全カレンダーへブロック
  for (const sourceId of config.calendarIds) {
    for (const targetId of config.calendarIds) {
      if (sourceId === targetId) continue;

      const source = states.get(sourceId);
      const target = states.get(targetId);
      // 読み取りに失敗したカレンダーが絡むペアは、誤削除を避けるため丸ごと skip する
      if (!source || !target) continue;

      console.log(`--- ${sourceId} -> ${targetId} ---`);

      try {
        const pairResult = syncCalendarPair(
          sourceId,
          source.candidates,
          target.snapshot,
          target.blocks
        );
        result.created += pairResult.created;
        result.deleted += pairResult.deleted;
        result.privatized += pairResult.privatized;
        result.adjusted += pairResult.adjusted;
        result.errors.push(...pairResult.errors);
        console.log(`  結果: created=${pairResult.created}, deleted=${pairResult.deleted}, privatized=${pairResult.privatized}, adjusted=${pairResult.adjusted}, errors=${pairResult.errors.length}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${sourceId} -> ${targetId}: ${message}`);
        console.error(`  エラー: ${message}`);
      }
    }
  }

  // 除外prefixイベントの「予定なし」化（カレンダー単位で1回ずつ）
  for (const [calendarId, state] of states) {
    console.log(`--- 予定なし化チェック: ${calendarId} ---`);
    try {
      const freed = makeExcludedEventsTransparent(state.snapshot);
      result.freed += freed;
      console.log(`  予定なし化: ${freed}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`makeTransparent ${calendarId}: ${message}`);
      console.error(`  エラー: ${message}`);
    }
  }

  console.log('=== 同期完了 ===');
  console.log(`合計: created=${result.created}, deleted=${result.deleted}, privatized=${result.privatized}, adjusted=${result.adjusted}, freed=${result.freed}, errors=${result.errors.length}`);

  return result;
}

/**
 * 全カレンダーから自動ブロックイベントを削除
 */
export function clearAllBlockEvents(): { deleted: number; errors: string[] } {
  const config = getConfig();
  const period = getSyncPeriod();

  console.log('=== ブロック削除開始 ===');
  console.log(`対象カレンダー数: ${config.calendarIds.length}`);

  let totalDeleted = 0;
  const errors: string[] = [];

  for (const calendarId of config.calendarIds) {
    console.log(`--- ${calendarId} ---`);
    try {
      const deleted = clearBlockEvents(calendarId, period, config.calendarIds);
      totalDeleted += deleted;
      console.log(`  削除数: ${deleted}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${calendarId}: ${message}`);
      console.error(`  エラー: ${message}`);
    }
  }

  console.log('=== ブロック削除完了 ===');
  console.log(`合計削除数: ${totalDeleted}`);

  return { deleted: totalDeleted, errors };
}

/**
 * 同期対象期間外の自動ブロックイベントを削除
 * SYNC_MONTHS縮小時の孤児化したブロックをクリーンアップ
 */
export function clearOutOfRangeBlockEvents(): { deleted: number; errors: string[] } {
  const config = getConfig();
  const period = getSyncPeriod();

  // 同期終了日から6ヶ月後までを対象
  const outOfRangeStart = period.end;
  const outOfRangeEnd = new Date(period.end);
  outOfRangeEnd.setMonth(outOfRangeEnd.getMonth() + 6);

  console.log('=== 同期対象外ブロック削除開始 ===');
  console.log(`対象期間: ${outOfRangeStart.toISOString()} ~ ${outOfRangeEnd.toISOString()}`);
  console.log(`対象カレンダー数: ${config.calendarIds.length}`);

  let totalDeleted = 0;
  const errors: string[] = [];

  for (const calendarId of config.calendarIds) {
    console.log(`--- ${calendarId} ---`);
    try {
      const deleted = clearBlockEvents(
        calendarId,
        { start: outOfRangeStart, end: outOfRangeEnd },
        config.calendarIds
      );
      totalDeleted += deleted;
      console.log(`  削除数: ${deleted}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${calendarId}: ${message}`);
      console.error(`  エラー: ${message}`);
    }
  }

  console.log('=== 同期対象外ブロック削除完了 ===');
  console.log(`合計削除数: ${totalDeleted}`);

  return { deleted: totalDeleted, errors };
}
