import { BlockMetadata, BlockCandidate } from './types';
import { BLOCK_TITLE } from './config';

type Calendar = GoogleAppsScript.Calendar.Calendar;
type CalendarEvent = GoogleAppsScript.Calendar.CalendarEvent;
type GuestStatus = GoogleAppsScript.Calendar.GuestStatus;

/**
 * カレンダーIDからカレンダーを取得
 */
export function getCalendar(calendarId: string): Calendar {
  const calendar = CalendarApp.getCalendarById(calendarId);
  if (!calendar) {
    throw new Error(`Calendar not found: ${calendarId}`);
  }
  return calendar;
}

/**
 * ブロック対象のイベントを取得
 * - 自動ブロックイベントは除外
 * - 出欠ステータスでフィルタリング
 */
export function getBlockableEvents(
  calendar: Calendar,
  start: Date,
  end: Date,
  blockingStatuses: GuestStatus[]
): BlockCandidate[] {
  const events = calendar.getEvents(start, end);
  const calendarId = calendar.getId();

  return events
    .filter((event) => {
      // 自動ブロックイベントは除外
      if (isAutoBlockEvent(event)) return false;
      // 出欠ステータスでフィルタ
      const status = event.getMyStatus();
      return blockingStatuses.includes(status);
    })
    .map((event) => ({
      sourceCalendarId: calendarId,
      sourceEventId: event.getId(),
      sourceStartTime: new Date(event.getStartTime().getTime()),
      sourceEndTime: new Date(event.getEndTime().getTime()),
      isAllDay: event.isAllDayEvent(),
    }));
}

/**
 * 自動ブロックイベントかどうかを判定
 */
function isAutoBlockEvent(event: CalendarEvent): boolean {
  const description = event.getDescription() || '';
  try {
    const metadata = JSON.parse(description) as Partial<BlockMetadata>;
    return metadata.isAutoBlock === true;
  } catch {
    return false;
  }
}

/**
 * ブロックイベントのメタデータを解析
 */
export function parseBlockMetadata(
  event: CalendarEvent
): BlockMetadata | null {
  const description = event.getDescription() || '';
  try {
    const metadata = JSON.parse(description) as Partial<BlockMetadata>;
    if (
      metadata.isAutoBlock === true &&
      metadata.sourceCalendarId &&
      metadata.sourceEventId &&
      metadata.sourceStartTime
    ) {
      return metadata as BlockMetadata;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * ブロックイベントを作成
 */
export function createBlockEvent(
  targetCalendar: Calendar,
  candidate: BlockCandidate
): void {
  const metadata: BlockMetadata = {
    isAutoBlock: true,
    sourceCalendarId: candidate.sourceCalendarId,
    sourceEventId: candidate.sourceEventId,
    sourceStartTime: candidate.sourceStartTime.toISOString(),
    createdAt: new Date().toISOString(),
  };

  const options = {
    description: JSON.stringify(metadata),
  };

  if (candidate.isAllDay) {
    // 終日イベント: 開始日と終了日を指定
    targetCalendar.createAllDayEvent(
      BLOCK_TITLE,
      candidate.sourceStartTime,
      candidate.sourceEndTime,
      options
    );
  } else {
    // 通常イベント: 開始時刻と終了時刻を指定
    targetCalendar.createEvent(
      BLOCK_TITLE,
      candidate.sourceStartTime,
      candidate.sourceEndTime,
      options
    );
  }
}

/**
 * 既存のブロックイベントを検索
 * キー: sourceCalendarId|sourceEventId|sourceStartTime
 */
export function findExistingBlockEvents(
  calendar: Calendar,
  start: Date,
  end: Date
): Map<string, CalendarEvent> {
  const events = calendar.getEvents(start, end);
  const blockEvents = new Map<string, CalendarEvent>();

  for (const event of events) {
    const metadata = parseBlockMetadata(event);
    if (metadata) {
      const key = buildBlockKey(
        metadata.sourceCalendarId,
        metadata.sourceEventId,
        metadata.sourceStartTime
      );
      blockEvents.set(key, event);
    }
  }

  return blockEvents;
}

/**
 * ブロックイベントのキーを生成
 */
export function buildBlockKey(
  sourceCalendarId: string,
  sourceEventId: string,
  sourceStartTime: string
): string {
  return `${sourceCalendarId}|${sourceEventId}|${sourceStartTime}`;
}
