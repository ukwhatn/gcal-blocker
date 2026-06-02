import { CalendarConfig, SyncPeriod } from './types';
import {
  getCalendar,
  getBlockableEvents,
  findExistingBlockEvents,
  createBlockEvent,
  ensureEventPrivate,
  buildBlockKey,
  parseBlockMetadata,
} from './calendar-service';

type CalendarEvent = GoogleAppsScript.Calendar.CalendarEvent;

interface PairSyncResult {
  created: number;
  deleted: number;
  privatized: number;
  errors: string[];
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
  let privatized = 0;
  const errors: string[] = [];

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
      // 非公開ブロック作成に成功した場合のみ加算（失敗時は作成イベント削除済み・次回再試行）
      if (createBlockEvent(targetCalendar, candidate)) {
        created++;
      } else {
        // 非公開化失敗でブロックは未作成（公開ブロックは残さない）。検知のため errors に記録
        errors.push(
          `block not created (visibility failed) on ${targetCalendarId} @ ${candidate.sourceStartTime.toISOString()}`
        );
      }
    }
  }

  // 既存ブロックの是正: 自source の relevantBlocks が非公開でなければ非公開化
  for (const [, events] of relevantBlocks) {
    for (const event of events) {
      try {
        if (ensureEventPrivate(event)) {
          console.log(`  非公開化: ${event.getStartTime().toISOString()}`);
          privatized++;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`  既存ブロックの非公開化に失敗: ${message}`);
        // 公開ブロックが残存し得るため検知用に記録
        errors.push(
          `ensureEventPrivate failed on ${targetCalendarId} @ ${event.getStartTime().toISOString()}: ${message}`
        );
      }
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

  return { created, deleted, privatized, errors };
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
