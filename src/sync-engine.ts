import { SyncResult } from './types';
import { getConfig, getSyncPeriod } from './config';
import { syncCalendarPair } from './block-manager';

/**
 * 全カレンダー間の同期を実行
 */
export function runSync(): SyncResult {
  const config = getConfig();
  const period = getSyncPeriod();

  const result: SyncResult = {
    created: 0,
    deleted: 0,
    errors: [],
  };

  // 各カレンダーから他の全カレンダーへブロック
  for (const sourceId of config.calendarIds) {
    for (const targetId of config.calendarIds) {
      if (sourceId === targetId) continue;

      try {
        const pairResult = syncCalendarPair(sourceId, targetId, config, period);
        result.created += pairResult.created;
        result.deleted += pairResult.deleted;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${sourceId} -> ${targetId}: ${message}`);
      }
    }
  }

  return result;
}
