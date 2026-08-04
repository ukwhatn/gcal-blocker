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
  rsvpWebAppUrl: string;
}

/**
 * Web App から入力できる出欠
 */
export type RsvpResponse = 'accepted' | 'tentative' | 'declined';

/**
 * コピー同期が書き込むメタデータ
 * Calendar API の extendedProperties.private に格納するため値はすべて文字列
 *
 * Web App が権威を持つキー（pendingResponse / note 等）はここに含めない。
 * 含めると毎回のコピー同期で空値に上書きされ、入力が消える
 */
export interface CopyMetadata {
  [key: string]: string; // extendedProperties.private が Record<string, string> を要求するため
  isCopy: string;
  sourceCalendarId: string;
  sourceEventId: string;
  sourceUpdated: string;
  responseStatus: string;
  responseComment: string;
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
  responseStatus: string;
  responseComment: string;
  payload: GoogleAppsScript.Calendar.Schema.Event;
}

/**
 * コピー先に存在するコピーイベント
 * response* は元イベントから読んだ現在値、pending* はウェブアプリからの未反映の入力。
 * metadata は extendedProperties.private の生の内容（patch 時のマージ元）
 */
export interface ExistingCopy {
  eventId: string;
  sourceCalendarId: string;
  sourceEventId: string;
  sourceUpdated: string;
  responseStatus: string;
  responseComment: string;
  pendingAt: string;
  pendingResponse: string;
  pendingComment: string;
  responseError: string;
  metadata: Record<string, string>;
}

/**
 * コピー同期の結果
 */
export interface CopyResult {
  created: number;
  updated: number;
  deleted: number;
  applied: number; // 元カレンダーへ出欠を反映した件数
  errors: string[];
}

/**
 * ウェブアプリが表示する 1 予定の状態
 * pending* が入っているときは、まだ元カレンダーへ反映されていない
 */
export interface RsvpView {
  sourceCalendarId: string;
  sourceEventId: string;
  title: string;
  dateLabel: string;
  timeLabel: string;
  location: string;
  detail: string;
  responseStatus: string;
  responseComment: string;
  pendingResponse: string;
  pendingComment: string;
  responseError: string;
  canRespond: boolean;
  appliesImmediately: boolean; // 自プロジェクト担当なら送信と同時に反映される
}

/**
 * ウェブアプリからの入力
 * 出欠とコメントは常にセットで送る（画面に現在値が入っているため、片方だけの更新を扱わない）
 */
export interface RsvpSubmission {
  sourceCalendarId: string;
  sourceEventId: string;
  response: RsvpResponse;
  comment: string;
}
