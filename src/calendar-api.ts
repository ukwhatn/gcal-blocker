import { SyncPeriod } from './types';
import { RESPONSE_NONE } from './config';

type ApiEvent = GoogleAppsScript.Calendar.Schema.Event;
type EventsCollection = GoogleAppsScript.Calendar.Collection.EventsCollection;

const PAGE_SIZE = 250;

/**
 * 元イベントに記録されている自分の出欠
 */
export interface OwnerResponse {
  status: string;
  comment: string;
}

/**
 * Advanced Calendar Service の Events コレクションを取得
 * @throws Advanced Calendar Service が有効化されていない場合
 */
export function getEventsApi(): EventsCollection {
  const events = Calendar.Events;
  if (events == null) {
    throw new Error(
      'Advanced Calendar Service (Calendar API v3) is not enabled. ' +
        'Add it to appsscript.json, deploy, and re-authorize the project.'
    );
  }
  return events;
}

/**
 * 期間内のイベントを繰り返し予定を展開して全ページ取得する
 */
export function listApiEvents(
  calendarId: string,
  period: SyncPeriod,
  extraArgs: Record<string, unknown> = {}
): ApiEvent[] {
  const api = getEventsApi();
  const events: ApiEvent[] = [];
  let pageToken: string | undefined;

  do {
    const page = api.list(calendarId, {
      timeMin: period.start.toISOString(),
      timeMax: period.end.toISOString(),
      singleEvents: true,
      showDeleted: false,
      maxResults: PAGE_SIZE,
      pageToken,
      ...extraArgs,
    });
    events.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);

  return events;
}

/**
 * カレンダー所有者の出欠を取得
 * CalendarApp の getMyStatus() は実行ユーザーの出欠を返し、実行ユーザーが予定の owner なら
 * 常に OWNER になる。別アカウントのカレンダーでは所有者の欠席を拾えないため、所有者アドレスとの一致で判定する
 */
export function getOwnerResponse(event: ApiEvent, calendarId: string): OwnerResponse {
  const owner = calendarId.toLowerCase();
  const attendee = (event.attendees ?? []).find(
    (candidate) => candidate.email?.toLowerCase() === owner
  );

  return {
    status: attendee?.responseStatus ?? RESPONSE_NONE,
    comment: attendee?.comment ?? '',
  };
}
