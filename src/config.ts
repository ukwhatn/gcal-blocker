import { CalendarConfig, SyncPeriod } from './types';

/** ブロックイベントのタイトル */
export const BLOCK_TITLE = '予定あり(自動ブロック)';

/** 同期対象期間（月数） */
const SYNC_MONTHS = 1;

/**
 * スクリプトプロパティから設定を読み込む
 */
export function getConfig(): CalendarConfig {
  const props = PropertiesService.getScriptProperties();
  const calendarIdsRaw = props.getProperty('CALENDAR_IDS');

  if (!calendarIdsRaw) {
    throw new Error(
      'CALENDAR_IDS is not set in Script Properties. ' +
        'Please set comma-separated calendar IDs.'
    );
  }

  const calendarIds = calendarIdsRaw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  if (calendarIds.length < 2) {
    throw new Error(
      'At least 2 calendar IDs are required for mutual blocking.'
    );
  }

  return {
    calendarIds,
    blockingStatuses: [
      CalendarApp.GuestStatus.YES,
      CalendarApp.GuestStatus.MAYBE,
      CalendarApp.GuestStatus.INVITED,
      CalendarApp.GuestStatus.OWNER,
    ],
  };
}

/**
 * 同期対象期間を取得
 * 現在〜3ヶ月後
 */
export function getSyncPeriod(): SyncPeriod {
  const now = new Date();
  const end = new Date(now);
  end.setMonth(end.getMonth() + SYNC_MONTHS);
  return { start: now, end };
}
