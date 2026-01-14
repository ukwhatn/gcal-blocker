/**
 * 自動ブロックイベントのメタデータ
 * descriptionにJSON形式で埋め込む
 */
export interface BlockMetadata {
  isAutoBlock: true;
  sourceCalendarId: string;
  sourceEventId: string;
  sourceStartTime: string; // ISO8601形式
  createdAt: string; // ISO8601形式
}

/**
 * ブロック対象イベントの情報
 */
export interface BlockCandidate {
  sourceCalendarId: string;
  sourceEventId: string;
  sourceStartTime: Date;
  sourceEndTime: Date;
  isAllDay: boolean;
}

/**
 * 同期結果
 */
export interface SyncResult {
  created: number;
  deleted: number;
  errors: string[];
}

/**
 * カレンダー設定
 */
export interface CalendarConfig {
  calendarIds: string[];
  blockingStatuses: GoogleAppsScript.Calendar.GuestStatus[];
}

/**
 * 同期期間
 */
export interface SyncPeriod {
  start: Date;
  end: Date;
}
