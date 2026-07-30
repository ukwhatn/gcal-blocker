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
  adjusted: number; // 終了時刻のずれを補正した件数
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

/**
 * コピー元カレンダーの表示設定
 * colorId は Calendar API のイベント色 ID（1〜11）
 */
export interface CalendarLabel {
  label: string;
  colorId?: string;
}

/**
 * コピー機能の設定
 * sourceCalendarIds は自プロジェクトが担当するコピー元（他プロジェクト分のコピーには触れない）
 */
export interface CopyConfig {
  targetCalendarId: string;
  sourceCalendarIds: string[];
  labels: Record<string, CalendarLabel>;
}

/**
 * コピーイベントの管理メタデータ
 * Calendar API の extendedProperties.private に格納するため値はすべて文字列
 */
export interface CopyMetadata {
  [key: string]: string; // extendedProperties.private が Record<string, string> を要求するため
  isCopy: string;
  sourceCalendarId: string;
  sourceEventId: string;
  sourceUpdated: string;
}

/**
 * コピー対象イベント
 * payload はコピー先へ insert/patch する Calendar API のリソース
 */
export interface CopyCandidate {
  key: string;
  sourceCalendarId: string;
  sourceEventId: string;
  sourceUpdated: string;
  payload: GoogleAppsScript.Calendar.Schema.Event;
}

/**
 * コピー先に存在するコピーイベント
 */
export interface ExistingCopy {
  eventId: string;
  sourceCalendarId: string;
  sourceUpdated: string;
}

/**
 * コピー同期の結果
 */
export interface CopyResult {
  created: number;
  updated: number;
  deleted: number;
  errors: string[];
}
