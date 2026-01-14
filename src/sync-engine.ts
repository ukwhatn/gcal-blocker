import { SyncResult } from './types';
import { getConfig, getSyncPeriod } from './config';
import { syncCalendarPair } from './block-manager';

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
    errors: [],
  };

  // 各カレンダーから他の全カレンダーへブロック
  for (const sourceId of config.calendarIds) {
    for (const targetId of config.calendarIds) {
      if (sourceId === targetId) continue;

      console.log(`--- ${sourceId} -> ${targetId} ---`);

      try {
        const pairResult = syncCalendarPair(sourceId, targetId, config, period);
        result.created += pairResult.created;
        result.deleted += pairResult.deleted;
        console.log(`  結果: created=${pairResult.created}, deleted=${pairResult.deleted}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${sourceId} -> ${targetId}: ${message}`);
        console.error(`  エラー: ${message}`);
      }
    }
  }

  console.log('=== 同期完了 ===');
  console.log(`合計: created=${result.created}, deleted=${result.deleted}, errors=${result.errors.length}`);

  return result;
}
