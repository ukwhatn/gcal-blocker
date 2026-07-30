import { CalendarLabel, CopyCandidate, CopyMetadata, ExistingCopy, SyncPeriod } from './types';
import {
  COPY_MARKER_KEY,
  COPY_MARKER_VALUE,
  EXCLUDED_PREFIXES,
  UNTITLED_EVENT_TITLE,
  getCalendarLabel,
} from './config';
import { parseBlockMetadataFromDescription } from './calendar-service';

type ApiEvent = GoogleAppsScript.Calendar.Schema.Event;
type EventsCollection = GoogleAppsScript.Calendar.Collection.EventsCollection;

const PAGE_SIZE = 250;
const GUEST_SECTION_HEADING = '# ゲスト';
const MEET_SECTION_HEADING = '# Meet';
const LOCATION_SEPARATOR = ' / ';

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
 * コピー元カレンダーから、コピー対象イベントを取得して payload まで組み立てる
 * 除外対象（自動ブロック・非DEFAULT・除外prefix・欠席・キャンセル）はここで落とす
 */
export function listCopyCandidates(
  sourceCalendarId: string,
  period: SyncPeriod,
  labels: Record<string, CalendarLabel>
): CopyCandidate[] {
  const label = getCalendarLabel(sourceCalendarId, labels);

  return listEvents(sourceCalendarId, period)
    .filter((event) => isCopyable(event, sourceCalendarId))
    .map((event) => {
      const sourceEventId = event.id ?? '';
      const sourceUpdated = event.updated ?? '';
      return {
        key: buildCopyKey(sourceCalendarId, sourceEventId),
        sourceCalendarId,
        sourceEventId,
        sourceUpdated,
        payload: {
          ...buildCopyPayload(event, label),
          extendedProperties: {
            private: buildCopyMetadata(sourceCalendarId, sourceEventId, sourceUpdated),
          },
        },
      };
    })
    .filter((candidate) => candidate.sourceEventId !== '');
}

/**
 * コピー先の既存コピーを取得し、コピー元イベント単位で索引化する
 * 同一キーで重複コピーが存在する場合（手動編集・過去の不具合起因）も取りこぼさないよう配列で返す
 */
export function listExistingCopies(
  targetCalendarId: string,
  period: SyncPeriod
): Map<string, ExistingCopy[]> {
  const copies = new Map<string, ExistingCopy[]>();

  for (const event of listEvents(targetCalendarId, period, {
    privateExtendedProperty: [`${COPY_MARKER_KEY}=${COPY_MARKER_VALUE}`],
  })) {
    const metadata = event.extendedProperties?.private;
    const eventId = event.id;
    if (!eventId || !metadata?.sourceCalendarId || !metadata?.sourceEventId) continue;

    const key = buildCopyKey(metadata.sourceCalendarId, metadata.sourceEventId);
    const entry: ExistingCopy = {
      eventId,
      sourceCalendarId: metadata.sourceCalendarId,
      sourceUpdated: metadata.sourceUpdated ?? '',
    };
    copies.set(key, [...(copies.get(key) ?? []), entry]);
  }

  return copies;
}

export function insertCopy(targetCalendarId: string, candidate: CopyCandidate): void {
  getEventsApi().insert(candidate.payload, targetCalendarId);
}

export function patchCopy(
  targetCalendarId: string,
  eventId: string,
  candidate: CopyCandidate
): void {
  getEventsApi().patch(candidate.payload, targetCalendarId, eventId);
}

export function deleteCopy(targetCalendarId: string, eventId: string): void {
  getEventsApi().remove(targetCalendarId, eventId);
}

export function buildCopyKey(sourceCalendarId: string, sourceEventId: string): string {
  return `${sourceCalendarId}|${sourceEventId}`;
}

/**
 * コピー先へ書き込むイベント内容を組み立てる
 * location / description は空文字を明示して、元イベントで消された内容が patch で残らないようにする
 */
export function buildCopyPayload(event: ApiEvent, label: CalendarLabel): ApiEvent {
  const meetUrl = getMeetUrl(event);
  const payload: ApiEvent = {
    summary: `[${label.label}] ${event.summary || UNTITLED_EVENT_TITLE}`,
    description: buildCopyDescription(event, meetUrl),
    location: joinLocation(event.location, meetUrl),
    start: event.start,
    end: event.end,
    visibility: event.visibility ?? 'default',
    transparency: event.transparency ?? 'opaque',
    reminders: { useDefault: false, overrides: [] },
  };

  if (label.colorId) {
    payload.colorId = label.colorId;
  }

  return payload;
}

function buildCopyMetadata(
  sourceCalendarId: string,
  sourceEventId: string,
  sourceUpdated: string
): CopyMetadata {
  return {
    isCopy: COPY_MARKER_VALUE,
    sourceCalendarId,
    sourceEventId,
    sourceUpdated,
  };
}

function isCopyable(event: ApiEvent, sourceCalendarId: string): boolean {
  if (event.status === 'cancelled') return false;
  if ((event.eventType ?? 'default') !== 'default') return false;
  if (parseBlockMetadataFromDescription(event.description) !== null) return false;

  const title = event.summary ?? '';
  if (EXCLUDED_PREFIXES.some((prefix) => title.startsWith(prefix))) return false;

  return getOwnerResponseStatus(event, sourceCalendarId) !== 'declined';
}

/**
 * コピー元カレンダーの所有者の出欠を取得
 * getMyStatus() は実行ユーザーの出欠を返すため、所有者アドレスとの一致で判定する
 */
function getOwnerResponseStatus(event: ApiEvent, sourceCalendarId: string): string | undefined {
  const owner = sourceCalendarId.toLowerCase();
  return (event.attendees ?? []).find((attendee) => attendee.email?.toLowerCase() === owner)
    ?.responseStatus;
}

function buildCopyDescription(event: ApiEvent, meetUrl: string | undefined): string {
  const sections: string[] = [];

  const body = event.description?.trim();
  if (body) sections.push(body);

  const guests = collectGuestEmails(event);
  if (guests.length > 0) {
    sections.push([GUEST_SECTION_HEADING, ...guests.map((email) => `- ${email}`)].join('\n'));
  }

  if (meetUrl) sections.push(`${MEET_SECTION_HEADING}\n${meetUrl}`);

  return sections.join('\n\n');
}

/**
 * ゲストのメールアドレスを列挙
 * 会議室（resource）は location に現れるため除外する
 */
function collectGuestEmails(event: ApiEvent): string[] {
  return (event.attendees ?? [])
    .filter((attendee) => attendee.resource !== true)
    .map((attendee) => attendee.email)
    .filter((email): email is string => !!email)
    .sort();
}

function getMeetUrl(event: ApiEvent): string | undefined {
  if (event.hangoutLink) return event.hangoutLink;
  return (event.conferenceData?.entryPoints ?? []).find(
    (entryPoint) => entryPoint.entryPointType === 'video'
  )?.uri;
}

function joinLocation(location: string | undefined, meetUrl: string | undefined): string {
  return [location?.trim(), meetUrl].filter((part): part is string => !!part).join(LOCATION_SEPARATOR);
}

function listEvents(
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
