/**
 * 自動ブロックイベントのメタデータ
 * descriptionにJSON形式で埋め込む
 * source* は直接の取得元、origin* は伝搬起源（後方互換のためoptional）
 */
export interface BlockMetadata {
  isAutoBlock: true;
  sourceCalendarId: string;
  sourceEventId: string;
  sourceStartTime: string; // ISO8601形式
  originCalendarId?: string;
  originEventId?: string;
  originStartTime?: string; // ISO8601形式
  createdAt: string; // ISO8601形式
}

/**
 * ブロック対象イベントの情報
 * origin* は外部系統からの伝搬時に元のソースを保持。通常イベントは自身と同じ
 */
export interface BlockCandidate {
  sourceCalendarId: string;
  sourceEventId: string;
  sourceStartTime: Date;
  sourceEndTime: Date;
  isAllDay: boolean;
  originCalendarId: string;
  originEventId: string;
  originStartTime: Date;
}

/**
 * 同期結果
 */
export interface SyncResult {
  created: number;
  deleted: number;
  privatized: number; // 既存ブロックを非公開化した件数
  freed: number; // 除外prefixイベントを「予定なし」化した件数
  errors: string[];
}

/**
 * カレンダー設定
 */
export interface CalendarConfig {
  calendarIds: string[];
}

/**
 * 同期期間
 */
export interface SyncPeriod {
  start: Date;
  end: Date;
}
