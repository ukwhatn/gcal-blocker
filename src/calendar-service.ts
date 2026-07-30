import { BlockMetadata, BlockCandidate } from './types';
import { BLOCK_TITLE, EXCLUDED_PREFIXES } from './config';

type Calendar = GoogleAppsScript.Calendar.Calendar;
type CalendarEvent = GoogleAppsScript.Calendar.CalendarEvent;

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
 * メタデータから origin 情報を抽出
 * origin* 3 フィールドが揃っていればそれを採用、無ければ source* を origin 扱い（後方互換）
 */
export function getOriginFromMetadata(md: BlockMetadata): {
  calendarId: string;
  eventId: string;
  startTime: string;
} {
  if (md.originCalendarId && md.originEventId && md.originStartTime) {
    return {
      calendarId: md.originCalendarId,
      eventId: md.originEventId,
      startTime: md.originStartTime,
    };
  }
  return {
    calendarId: md.sourceCalendarId,
    eventId: md.sourceEventId,
    startTime: md.sourceStartTime,
  };
}

/**
 * ブロック対象のイベントを取得
 * - 内部系統の自動ブロックは除外（direct source ベース、無限ループ防止）
 * - 外部系統の自動ブロックは出欠フィルタを bypass して伝搬対象に
 * - 通常イベントは「明示的に NO」のみ除外（別アカウント実行時 getMyStatus が null になる対応）
 */
export function getBlockableEvents(
  calendar: Calendar,
  start: Date,
  end: Date,
  internalCalendarIds: string[]
): BlockCandidate[] {
  const events = calendar.getEvents(start, end);
  const calendarId = calendar.getId();

  return events
    .filter((event) => {
      // 1. 内部系統の自動ブロックは除外（無限ループ防止）
      if (isInternalAutoBlockEvent(event, internalCalendarIds)) return false;
      // 2. 外部系統の自動ブロック（metadataあり、ここまでで内部除外済み）は即 candidate 化
      //    別アカウント実行時 getMyStatus() が想定値にならないため出欠フィルタを bypass
      //    prefix/EventType/transparency も bypass: 自動ブロックは生成形式が一定で安全
      const md = parseBlockMetadata(event);
      if (md !== null) {
        return true;
      }
      // 3. 通常イベント: 除外プレフィックスで始まるイベントは除外
      if (EXCLUDED_PREFIXES.some((prefix) => event.getTitle().startsWith(prefix))) return false;
      // EventType==DEFAULTのみ対象（Tasks等を除外）
      if (!isDefaultEventType(event)) return false;
      // 「予定なし」（transparent）のイベントは除外
      if (getEventTransparency(event) === eventTransparency('TRANSPARENT')) return false;
      // 4. 出欠フィルタ: 明示的に NO の場合のみ除外
      //    別アカウント実行時 getMyStatus() が null を返すケースがあり（例: ゲストなしで他人 owner のイベント）、
      //    厳密フィルタだと通常イベントが伝搬されないため緩和
      const status = event.getMyStatus();
      if (status === CalendarApp.GuestStatus.NO) return false;
      return true;
    })
    .map((event) => {
      const md = parseBlockMetadata(event);
      let origin: { calendarId: string; eventId: string; startTime: Date };
      if (md) {
        // 外部系統の自動ブロック: 元のorigin情報を引き継ぐ
        const o = getOriginFromMetadata(md);
        origin = {
          calendarId: o.calendarId,
          eventId: o.eventId,
          startTime: new Date(o.startTime),
        };
      } else {
        // 通常イベント: 自身がorigin
        origin = {
          calendarId,
          eventId: event.getId(),
          startTime: new Date(event.getStartTime().getTime()),
        };
      }
      return {
        sourceCalendarId: calendarId,
        sourceEventId: event.getId(),
        sourceStartTime: new Date(event.getStartTime().getTime()),
        sourceEndTime: new Date(event.getEndTime().getTime()),
        isAllDay: event.isAllDayEvent(),
        originCalendarId: origin.calendarId,
        originEventId: origin.eventId,
        originStartTime: origin.startTime,
      };
    });
}

/**
 * 自スクリプトの CALENDAR_IDS 内で生成された自動ブロックか判定
 * direct source ベース: origin ベースだと D→B→A→B... の経路でループ入口になるため
 */
function isInternalAutoBlockEvent(
  event: CalendarEvent,
  internalCalendarIds: string[]
): boolean {
  const md = parseBlockMetadata(event);
  if (!md) return false;
  return internalCalendarIds.includes(md.sourceCalendarId);
}

/**
 * ブロックイベントのメタデータを解析
 */
export function parseBlockMetadata(
  event: CalendarEvent
): BlockMetadata | null {
  return parseBlockMetadataFromDescription(event.getDescription());
}

/**
 * description 文字列からブロックイベントのメタデータを解析
 * CalendarApp を経由しない Calendar API 側からも同じ判定を使うために分離
 */
export function parseBlockMetadataFromDescription(
  description: string | null | undefined
): BlockMetadata | null {
  try {
    const metadata = JSON.parse(description || '') as Partial<BlockMetadata>;
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
 * metadata には direct source と origin の両方を記録
 * 公開設定は「非公開(PRIVATE)」で作成する。
 * setVisibility が失敗した場合は公開ブロックを残さないよう作成イベントを削除し false を返す
 * （加算は呼び出し側で戻り値が true のときのみ行う。次回 sync で再試行される）
 * @returns 非公開ブロックの作成に成功した場合 true
 */
export function createBlockEvent(
  targetCalendar: Calendar,
  candidate: BlockCandidate
): boolean {
  const metadata: BlockMetadata = {
    isAutoBlock: true,
    sourceCalendarId: candidate.sourceCalendarId,
    sourceEventId: candidate.sourceEventId,
    sourceStartTime: candidate.sourceStartTime.toISOString(),
    originCalendarId: candidate.originCalendarId,
    originEventId: candidate.originEventId,
    originStartTime: candidate.originStartTime.toISOString(),
    createdAt: new Date().toISOString(),
  };

  const options = {
    description: JSON.stringify(metadata),
  };

  const event = candidate.isAllDay
    ? // 終日イベント: 開始日と終了日を指定
      targetCalendar.createAllDayEvent(
        BLOCK_TITLE,
        candidate.sourceStartTime,
        candidate.sourceEndTime,
        options
      )
    : // 通常イベント: 開始時刻と終了時刻を指定
      targetCalendar.createEvent(
        BLOCK_TITLE,
        candidate.sourceStartTime,
        candidate.sourceEndTime,
        options
      );

  try {
    event.setVisibility(CalendarApp.Visibility.PRIVATE);
  } catch (error) {
    // 非公開化に失敗した場合、公開状態のブロックを残さないよう作成イベントを削除する
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`  非公開化に失敗したためブロックを削除: ${message}`);
    try {
      event.deleteEvent();
    } catch {
      // 削除も失敗した場合は是正できない（次回 sync の ensureEventPrivate で再是正を試みる）
    }
    return false;
  }
  return true;
}

/**
 * ブロックイベントの期間が候補とずれていれば補正する
 * ブロックキーは開始時刻までしか含まないため、終了時刻だけが変わった予定はキー一致となり
 * 作成も削除も起きない。その取りこぼしをここで補正する
 * @returns 補正した場合 true
 */
export function ensureBlockEventDuration(
  event: CalendarEvent,
  candidate: BlockCandidate
): boolean {
  // 終日イベントの getEndTime() はカレンダーのタイムゾーン基準の翌日 0 時を返すため、
  // ソースとターゲットのタイムゾーンが違うと絶対時刻の比較が常にずれる。所要時間で比較する
  const blockDuration = event.getEndTime().getTime() - event.getStartTime().getTime();
  const sourceDuration =
    candidate.sourceEndTime.getTime() - candidate.sourceStartTime.getTime();
  if (event.isAllDayEvent() === candidate.isAllDay && blockDuration === sourceDuration) {
    return false;
  }

  if (candidate.isAllDay) {
    event.setAllDayDates(candidate.sourceStartTime, candidate.sourceEndTime);
  } else {
    event.setTime(candidate.sourceStartTime, candidate.sourceEndTime);
  }
  return true;
}

/**
 * イベントが非公開(PRIVATE)でなければ非公開化する
 * @returns 非公開化した場合 true（既に非公開なら false）
 */
export function ensureEventPrivate(event: CalendarEvent): boolean {
  if (event.getVisibility() !== CalendarApp.Visibility.PRIVATE) {
    event.setVisibility(CalendarApp.Visibility.PRIVATE);
    return true;
  }
  return false;
}

/**
 * 除外プレフィックス（EXCLUDED_PREFIXES）で始まる通常イベントが
 * 「予定あり(OPAQUE)」なら「予定なし(TRANSPARENT)」化する。
 * 自動ブロックイベント（metadataあり）は対象外。
 * イベント単位で例外を握り、1件の失敗で残りを止めない。
 * @returns 予定なし化した件数
 */
export function makeExcludedEventsTransparent(
  calendar: Calendar,
  start: Date,
  end: Date
): number {
  const events = calendar.getEvents(start, end);
  let freed = 0;

  for (const event of events) {
    try {
      // 自動ブロックは対象外（予定なし化しない）
      if (parseBlockMetadata(event) !== null) continue;
      const title = event.getTitle();
      if (!EXCLUDED_PREFIXES.some((prefix) => title.startsWith(prefix))) continue;
      // EventType==DEFAULTのみ対象（Tasks/誕生日等の特殊イベントを除外）
      if (!isDefaultEventType(event)) continue;
      // 既に「予定なし」のものはスキップ
      if (getEventTransparency(event) !== eventTransparency('OPAQUE')) continue;
      setEventTransparency(event, 'TRANSPARENT');
      console.log(`  予定なし化: ${title} @ ${event.getStartTime().toISOString()}`);
      freed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`  予定なし化に失敗: ${message}`);
    }
  }

  return freed;
}

/**
 * 既存のブロックイベントを検索
 * キー: originCalendarId|originEventId|originStartTime（後方互換: origin未定義時はsourceで代用）
 * 値は配列: 同一originキーで重複ブロックが存在する場合（過去のバグ・手動編集起因）の取りこぼし防止
 */
export function findExistingBlockEvents(
  calendar: Calendar,
  start: Date,
  end: Date
): Map<string, CalendarEvent[]> {
  const events = calendar.getEvents(start, end);
  const blockEvents = new Map<string, CalendarEvent[]>();

  for (const event of events) {
    const metadata = parseBlockMetadata(event);
    if (metadata) {
      const o = getOriginFromMetadata(metadata);
      const key = buildBlockKey(o.calendarId, o.eventId, o.startTime);
      const arr = blockEvents.get(key) ?? [];
      arr.push(event);
      blockEvents.set(key, arr);
    }
  }
  for (const [key, arr] of blockEvents) {
    if (arr.length > 1) {
      console.warn(`Duplicate block events detected for key=${key}: count=${arr.length}`);
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

/**
 * EventType が DEFAULT（通常イベント）か判定
 * Tasks・誕生日等の特殊イベントを除外するためのガード
 */
function isDefaultEventType(event: CalendarEvent): boolean {
  // @types/google-apps-script に getEventType/EventType が未定義のため型アサーション使用
  const eventType = (event as unknown as { getEventType: () => unknown }).getEventType();
  const defaultType = (CalendarApp as unknown as { EventType: { DEFAULT: unknown } }).EventType
    .DEFAULT;
  return eventType === defaultType;
}

// --- transparency ヘルパー ---
// @types/google-apps-script に getTransparency/setTransparency/EventTransparency が
// 未定義のため、型アサーションをここに集約する
type TransparencyKey = 'OPAQUE' | 'TRANSPARENT';

function getEventTransparency(event: CalendarEvent): unknown {
  return (event as unknown as { getTransparency: () => unknown }).getTransparency();
}

function eventTransparency(key: TransparencyKey): unknown {
  return (
    CalendarApp as unknown as { EventTransparency: Record<TransparencyKey, unknown> }
  ).EventTransparency[key];
}

function setEventTransparency(event: CalendarEvent, key: TransparencyKey): void {
  (event as unknown as { setTransparency: (t: unknown) => void }).setTransparency(
    eventTransparency(key)
  );
}
