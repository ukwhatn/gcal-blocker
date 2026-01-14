import { CalendarConfig, SyncPeriod } from './types';
import {
  getCalendar,
  getBlockableEvents,
  findExistingBlockEvents,
  createBlockEvent,
  buildBlockKey,
} from './calendar-service';

type CalendarEvent = GoogleAppsScript.Calendar.CalendarEvent;

interface PairSyncResult {
  created: number;
  deleted: number;
}

/**
 * 単一のカレンダーペア間でブロックを同期
 * source -> target へブロックイベントを作成/削除
 */
export function syncCalendarPair(
  sourceCalendarId: string,
  targetCalendarId: string,
  config: CalendarConfig,
  period: SyncPeriod
): PairSyncResult {
  const sourceCalendar = getCalendar(sourceCalendarId);
  const targetCalendar = getCalendar(targetCalendarId);

  // ソースカレンダーのブロック対象イベントを取得
  const blockCandidates = getBlockableEvents(
    sourceCalendar,
    period.start,
    period.end,
    config.blockingStatuses
  );
  console.log(`  ソースイベント数: ${blockCandidates.length}`);

  // ターゲットカレンダーの既存ブロックイベントを取得
  const existingBlocks = findExistingBlockEvents(
    targetCalendar,
    period.start,
    period.end
  );

  // このソースカレンダーからのブロックのみをフィルタ
  const relevantBlocks = new Map<string, CalendarEvent>();
  for (const [key, event] of existingBlocks) {
    if (key.startsWith(sourceCalendarId + '|')) {
      relevantBlocks.set(key, event);
    }
  }
  console.log(`  既存ブロック数: ${relevantBlocks.size}`);

  let created = 0;
  let deleted = 0;

  // 必要なブロックを作成
  const candidateKeys = new Set<string>();
  for (const candidate of blockCandidates) {
    const key = buildBlockKey(
      candidate.sourceCalendarId,
      candidate.sourceEventId,
      candidate.sourceStartTime.toISOString()
    );
    candidateKeys.add(key);

    if (!relevantBlocks.has(key)) {
      console.log(`  作成: ${candidate.sourceStartTime.toISOString()} (${candidate.isAllDay ? '終日' : '時間指定'})`);
      createBlockEvent(targetCalendar, candidate);
      created++;
    }
  }

  // 不要なブロックを削除（元イベントが削除/欠席になった場合）
  for (const [key, event] of relevantBlocks) {
    if (!candidateKeys.has(key)) {
      console.log(`  削除: ${event.getStartTime().toISOString()}`);
      event.deleteEvent();
      deleted++;
    }
  }

  return { created, deleted };
}
