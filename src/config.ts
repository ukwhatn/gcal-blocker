import { CalendarConfig, CalendarLabel, CopyConfig, SyncPeriod } from './types';

/** ブロックイベントのタイトル */
export const BLOCK_TITLE = '予定あり(自動ブロック)';

/** ブロック対象から除外するイベントタイトルのプレフィックス */
export const EXCLUDED_PREFIXES = ['[TASK]', '⏳', '✅', '❌'];

/** 同期対象期間（月数） */
const SYNC_MONTHS = 1;

/** コピーイベントの目印（extendedProperties.private） */
export const COPY_MARKER_KEY = 'isCopy';
export const COPY_MARKER_VALUE = 'true';

/** タイトルが空のイベントをコピーする際の代替タイトル */
export const UNTITLED_EVENT_TITLE = '(無題)';

/**
 * 登録可能ラベルの判定で読み飛ばす第2レベル接尾辞
 * これがないと nxtend.or.jp から OR を拾ってしまう
 */
const SECOND_LEVEL_SUFFIXES = ['co', 'or', 'ne', 'ac', 'go', 'ed', 'gr', 'lg', 'com', 'net', 'org'];

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

  const calendarIds = splitCalendarIds(calendarIdsRaw);

  if (calendarIds.length < 2) {
    throw new Error(
      'At least 2 calendar IDs are required for mutual blocking.'
    );
  }

  return {
    calendarIds,
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

/**
 * スクリプトプロパティからコピー機能の設定を読み込む
 * @throws コピー先が未設定・担当カレンダーが空・コピー先が同期対象に含まれる場合
 */
export function getCopyConfig(): CopyConfig {
  const props = PropertiesService.getScriptProperties();

  const targetCalendarId = (props.getProperty('COPY_TARGET_CALENDAR_ID') ?? '').trim();
  if (!targetCalendarId) {
    throw new Error(
      'COPY_TARGET_CALENDAR_ID is not set in Script Properties. ' +
        'Please set the shared calendar ID to copy events into.'
    );
  }

  const sourceCalendarIds = splitCalendarIds(props.getProperty('COPY_SOURCE_IDS'));
  if (sourceCalendarIds.length === 0) {
    throw new Error(
      'COPY_SOURCE_IDS is not set in Script Properties. ' +
        'Please set comma-separated calendar IDs this project is responsible for copying.'
    );
  }

  if (sourceCalendarIds.includes(targetCalendarId)) {
    throw new Error('COPY_TARGET_CALENDAR_ID must not be included in COPY_SOURCE_IDS.');
  }

  // コピー先がブロック同期対象だと、全カレンダー分のコピーがブロック元になり相互ブロックが二重に走る
  if (splitCalendarIds(props.getProperty('CALENDAR_IDS')).includes(targetCalendarId)) {
    throw new Error('COPY_TARGET_CALENDAR_ID must not be included in CALENDAR_IDS.');
  }

  return {
    targetCalendarId,
    sourceCalendarIds,
    labels: parseCalendarLabels(props.getProperty('CALENDAR_LABELS')),
  };
}

/**
 * CALENDAR_LABELS を解析する
 * 形式: `<calendarId>:<label>[:<colorId>]` をカンマ区切りで連結
 */
export function parseCalendarLabels(raw: string | null): Record<string, CalendarLabel> {
  const labels: Record<string, CalendarLabel> = {};
  if (!raw) return labels;

  for (const entry of raw.split(',')) {
    const [calendarId, label, colorId] = entry.split(':').map((part) => part.trim());
    if (!calendarId || !label) continue;
    labels[calendarId] = colorId ? { label, colorId } : { label };
  }

  return labels;
}

/**
 * コピー元カレンダーの表示設定を取得
 * 未設定のカレンダーはドメインから導出したラベルを使う（色は付けない）
 */
export function getCalendarLabel(
  calendarId: string,
  labels: Record<string, CalendarLabel>
): CalendarLabel {
  return labels[calendarId] ?? { label: deriveLabelFromCalendarId(calendarId) };
}

/**
 * カレンダーID（メールアドレス）から表示ラベルを導出する
 * public suffix 直前のラベルを大文字化する（nxtend.or.jp -> NXTEND, dena.jp -> DENA）
 */
export function deriveLabelFromCalendarId(calendarId: string): string {
  const domain = calendarId.split('@')[1] ?? calendarId;
  const parts = domain.split('.').filter(Boolean);
  if (parts.length === 0) return calendarId.toUpperCase();

  const withoutTld = parts.length > 1 ? parts.slice(0, -1) : parts;
  const last = withoutTld[withoutTld.length - 1];
  const registrable =
    withoutTld.length > 1 && SECOND_LEVEL_SUFFIXES.includes(last)
      ? withoutTld[withoutTld.length - 2]
      : last;

  return registrable.toUpperCase();
}

function splitCalendarIds(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}
