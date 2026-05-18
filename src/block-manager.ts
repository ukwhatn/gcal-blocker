import { CalendarConfig, SyncPeriod } from './types';
import {
  getCalendar,
  getBlockableEvents,
  findExistingBlockEvents,
  createBlockEvent,
  buildBlockKey,
  parseBlockMetadata,
} from './calendar-service';

type CalendarEvent = GoogleAppsScript.Calendar.CalendarEvent;

interface PairSyncResult {
  created: number;
  deleted: number;
}

/**
 * 単一のカレンダーペア間でブロックを同期
 * source -> target へブロックイベントを作成/削除
 *
 * - 作成判定: existingBlocks 全体（origin key）で重複防止
 * - 削除判定: direct source 一致の relevantBlocks のみ操作（所有権分離）
 */
export function syncCalendarPair(
  sourceCalendarId: string,
  targetCalendarId: string,
  config: CalendarConfig,
  period: SyncPeriod
): PairSyncResult {
  const sourceCalendar = getCalendar(sourceCalendarId);
  const targetCalendar = getCalendar(targetCalendarId);

  const blockCandidates = getBlockableEvents(
    sourceCalendar,
    period.start,
    period.end,
    config.blockingStatuses,
    config.calendarIds
  );
  console.log(`  ソースイベント数: ${blockCandidates.length}`);

  const existingBlocks = findExistingBlockEvents(
    targetCalendar,
    period.start,
    period.end
  );

  // 削除責任分離: このソースが直接 put したブロックのみ削除候補化
  const relevantBlocks = new Map<string, CalendarEvent[]>();
  for (const [key, events] of existingBlocks) {
    const filtered = events.filter((event) => {
      const md = parseBlockMetadata(event);
      return md !== null && md.sourceCalendarId === sourceCalendarId;
    });
    if (filtered.length > 0) {
      relevantBlocks.set(key, filtered);
    }
  }
  console.log(`  既存ブロック数(自source): ${relevantBlocks.size}`);

  let created = 0;
  let deleted = 0;

  // 作成: existingBlocks 全体で重複検知（origin key 一意性）
  const candidateKeys = new Set<string>();
  for (const candidate of blockCandidates) {
    const key = buildBlockKey(
      candidate.originCalendarId,
      candidate.originEventId,
      candidate.originStartTime.toISOString()
    );
    candidateKeys.add(key);

    if (!existingBlocks.has(key)) {
      console.log(`  作成: ${candidate.sourceStartTime.toISOString()} (${candidate.isAllDay ? '終日' : '時間指定'}, origin=${candidate.originCalendarId})`);
      createBlockEvent(targetCalendar, candidate);
      created++;
    }
  }

  // 削除: 自source の relevantBlocks のみ、配列全要素を対象
  for (const [key, events] of relevantBlocks) {
    if (!candidateKeys.has(key)) {
      for (const event of events) {
        console.log(`  削除: ${event.getStartTime().toISOString()}`);
        event.deleteEvent();
        deleted++;
      }
    }
  }

  return { created, deleted };
}

/**
 * 指定カレンダーから自スクリプト管理の自動ブロックイベントを削除
 * direct source ∈ internalCalendarIds のものだけ削除（他プロジェクト管理を保護）
 */
export function clearBlockEvents(
  calendarId: string,
  period: SyncPeriod,
  internalCalendarIds: string[]
): number {
  const calendar = getCalendar(calendarId);
  const existingBlocks = findExistingBlockEvents(calendar, period.start, period.end);

  let deleted = 0;
  for (const [, events] of existingBlocks) {
    for (const event of events) {
      const md = parseBlockMetadata(event);
      if (md && internalCalendarIds.includes(md.sourceCalendarId)) {
        console.log(`  削除: ${event.getStartTime().toISOString()}`);
        event.deleteEvent();
        deleted++;
      }
    }
  }

  return deleted;
}
