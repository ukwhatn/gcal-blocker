import {
  CalendarLabel,
  CopyCandidate,
  CopyMetadata,
  ExistingCopy,
  RsvpResponse,
  SyncPeriod,
} from './types';
import {
  COPY_MARKER_KEY,
  COPY_MARKER_VALUE,
  EXCLUDED_PREFIXES,
  NOTE_MAX_LENGTH,
  RESPONSE_MARKS,
  RESPONSE_NONE,
  UNTITLED_EVENT_TITLE,
  getCalendarLabel,
} from './config';
import { parseBlockMetadataFromDescription } from './calendar-service';

type ApiEvent = GoogleAppsScript.Calendar.Schema.Event;
type EventsCollection = GoogleAppsScript.Calendar.Collection.EventsCollection;

const PAGE_SIZE = 250;
const NOTE_SECTION_HEADING = '# メモ';
const GUEST_SECTION_HEADING = '# ゲスト';
const MEET_SECTION_HEADING = '# Meet';
const LOCATION_SEPARATOR = ' / ';
const SECTION_SEPARATOR = '\n\n';

/**
 * 元イベントへの出欠反映の結果
 * 権限エラー等は例外として投げ、出欠を持たない予定だけを notApplicable で返す
 */
export type RsvpApplyOutcome =
  | { status: 'applied'; responseStatus: string }
  | { status: 'notApplicable'; reason: string };

/**
 * コピー先に存在するコピーイベントと、そこに保存された状態
 * 表示に本体（タイトル・時刻）が要る Web App のために両方を返す
 */
export interface CopySnapshot {
  event: ApiEvent;
  state: ExistingCopy;
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
 * コピー元カレンダーから、コピー対象イベントを取得して payload まで組み立てる
 * 除外対象（自動ブロック・非DEFAULT・除外prefix・キャンセル）はここで落とす
 * existingCopies は既存コピーのメモを payload に引き継ぐために使う
 */
export function listCopyCandidates(
  sourceCalendarId: string,
  period: SyncPeriod,
  labels: Record<string, CalendarLabel>,
  existingCopies: Map<string, ExistingCopy[]>
): CopyCandidate[] {
  const label = getCalendarLabel(sourceCalendarId, labels);

  return listEvents(sourceCalendarId, period)
    .filter((event) => isCopyable(event))
    .map((event) => {
      const sourceEventId = event.id ?? '';
      const sourceUpdated = event.updated ?? '';
      const responseStatus = getOwnerResponseStatus(event, sourceCalendarId);
      const key = buildCopyKey(sourceCalendarId, sourceEventId);
      const note = existingCopies.get(key)?.[0]?.note ?? '';

      return {
        key,
        sourceCalendarId,
        sourceEventId,
        sourceUpdated,
        responseStatus,
        payload: {
          ...buildCopyPayload(event, label, responseStatus, note),
          extendedProperties: {
            private: buildCopyMetadata(
              sourceCalendarId,
              sourceEventId,
              sourceUpdated,
              responseStatus
            ),
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

  for (const { state } of listCopySnapshots(targetCalendarId, period)) {
    const key = buildCopyKey(state.sourceCalendarId, state.sourceEventId);
    copies.set(key, [...(copies.get(key) ?? []), state]);
  }

  return copies;
}

/**
 * コピー先のコピーイベントを本体つきで取得する
 */
export function listCopySnapshots(targetCalendarId: string, period: SyncPeriod): CopySnapshot[] {
  const snapshots: CopySnapshot[] = [];

  for (const event of listEvents(targetCalendarId, period, {
    privateExtendedProperty: [`${COPY_MARKER_KEY}=${COPY_MARKER_VALUE}`],
  })) {
    const state = toExistingCopy(event);
    if (state) snapshots.push({ event, state });
  }

  return snapshots;
}

/**
 * コピー先の 1 件を取得する
 * 自スクリプトが作ったコピーでなければ null を返す（Web App から任意の eventId を渡されても書き換えない）
 */
export function getCopySnapshot(targetCalendarId: string, eventId: string): CopySnapshot | null {
  const event = getEventsApi().get(targetCalendarId, eventId);
  const state = toExistingCopy(event);
  return state ? { event, state } : null;
}

export function insertCopy(targetCalendarId: string, candidate: CopyCandidate): void {
  getEventsApi().insert(candidate.payload, targetCalendarId);
}

/**
 * 既存コピーを最新の内容へ更新する
 * Web App が書いたメタ（pendingResponse / note 等）を消さないよう、既存メタに上書きする形で送る
 */
export function patchCopy(
  targetCalendarId: string,
  existing: ExistingCopy,
  candidate: CopyCandidate
): void {
  const payload: ApiEvent = {
    ...candidate.payload,
    extendedProperties: {
      private: { ...existing.metadata, ...candidate.payload.extendedProperties?.private },
    },
  };
  getEventsApi().patch(payload, targetCalendarId, existing.eventId);
}

/**
 * コピーのメタデータ・description だけを更新する
 * 省略したフィールドは変更しない
 *
 * 渡された copy も最新化する。同じ run の後続処理（コピー同期の patch）が
 * 古いメタをマージし直すと、消したはずの出欠入力が復活するため
 */
export function patchCopyState(
  targetCalendarId: string,
  copy: ExistingCopy,
  patch: { metadata?: Record<string, string>; description?: string }
): void {
  const metadata = patch.metadata ? { ...copy.metadata, ...patch.metadata } : copy.metadata;
  const payload: ApiEvent = {};

  if (patch.metadata) {
    payload.extendedProperties = { private: metadata };
  }
  if (patch.description != null) {
    payload.description = patch.description;
  }

  getEventsApi().patch(payload, targetCalendarId, copy.eventId);

  copy.metadata = metadata;
  copy.responseStatus = metadata.responseStatus ?? '';
  copy.pendingResponse = metadata.pendingResponse ?? '';
  copy.note = metadata.note ?? '';
  copy.responseError = metadata.responseError ?? '';
}

export function deleteCopy(targetCalendarId: string, eventId: string): void {
  getEventsApi().remove(targetCalendarId, eventId);
}

/**
 * 元カレンダーのイベントへ出欠を書き込む
 * 自分（コピー元カレンダー）の attendee エントリだけを差し替える。
 * attendees は配列ごと送らないと他のゲストが消えるため、取得したものを写して送る
 */
export function applyResponseToSourceEvent(
  sourceCalendarId: string,
  sourceEventId: string,
  response: RsvpResponse
): RsvpApplyOutcome {
  const api = getEventsApi();
  const event = api.get(sourceCalendarId, sourceEventId);

  if (event.status === 'cancelled') {
    return { status: 'notApplicable', reason: '元の予定が削除されています' };
  }

  const owner = sourceCalendarId.toLowerCase();
  const attendees = event.attendees ?? [];
  if (!attendees.some((attendee) => attendee.email?.toLowerCase() === owner)) {
    return {
      status: 'notApplicable',
      reason: 'ゲストとして登録されていない予定のため出欠を設定できません',
    };
  }

  api.patch(
    {
      attendees: attendees.map((attendee) =>
        attendee.email?.toLowerCase() === owner
          ? { ...attendee, responseStatus: response }
          : attendee
      ),
    },
    sourceCalendarId,
    sourceEventId
  );

  return { status: 'applied', responseStatus: response };
}

export function buildCopyKey(sourceCalendarId: string, sourceEventId: string): string {
  return `${sourceCalendarId}|${sourceEventId}`;
}

/**
 * description のメモセクションを差し替える
 * Web App は担当外カレンダーの元イベントを読めないため、description 全体を組み直さず
 * セクション単位で差し替える
 */
export function replaceNoteSection(description: string | undefined, note: string): string {
  const sections = (description ?? '')
    .split(SECTION_SEPARATOR)
    .filter((section) => !section.startsWith(NOTE_SECTION_HEADING))
    .filter((section) => section.trim() !== '');

  const normalized = normalizeNote(note);
  if (normalized) {
    sections.unshift(`${NOTE_SECTION_HEADING}\n${normalized}`);
  }

  return sections.join(SECTION_SEPARATOR);
}

/**
 * メモを保存できる形に整える
 * 空行はセクション区切りと衝突して次回の差し替えで取り残されるため 1 行に潰す
 */
export function normalizeNote(note: string): string {
  return note
    .trim()
    .replace(/\r\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .slice(0, NOTE_MAX_LENGTH);
}

/**
 * コピー先へ書き込むイベント内容を組み立てる
 * location / description は空文字を明示して、元イベントで消された内容が patch で残らないようにする
 */
export function buildCopyPayload(
  event: ApiEvent,
  label: CalendarLabel,
  responseStatus: string,
  note: string
): ApiEvent {
  const meetUrl = getMeetUrl(event);
  const mark = RESPONSE_MARKS[responseStatus];
  const payload: ApiEvent = {
    summary: `[${label.label}] ${mark ? `${mark} ` : ''}${event.summary || UNTITLED_EVENT_TITLE}`,
    description: replaceNoteSection(buildCopyDescription(event, meetUrl), note),
    location: joinLocation(event.location, meetUrl),
    start: event.start,
    end: event.end,
    visibility: event.visibility ?? 'default',
    // 欠席した予定は空き時間として見せる（一覧には残して取り消しできるようにする）
    transparency: responseStatus === 'declined' ? 'transparent' : (event.transparency ?? 'opaque'),
    reminders: { useDefault: false, overrides: [] },
  };

  if (label.colorId) {
    payload.colorId = label.colorId;
  }

  return payload;
}

/**
 * コピー元カレンダーの所有者の出欠を取得
 * getMyStatus() は実行ユーザーの出欠を返すため、所有者アドレスとの一致で判定する
 */
export function getOwnerResponseStatus(event: ApiEvent, sourceCalendarId: string): string {
  const owner = sourceCalendarId.toLowerCase();
  const attendee = (event.attendees ?? []).find(
    (candidate) => candidate.email?.toLowerCase() === owner
  );
  return attendee?.responseStatus ?? RESPONSE_NONE;
}

function toExistingCopy(event: ApiEvent): ExistingCopy | null {
  const metadata = event.extendedProperties?.private;
  const eventId = event.id;

  if (metadata?.[COPY_MARKER_KEY] !== COPY_MARKER_VALUE) return null;
  if (!eventId || !metadata.sourceCalendarId || !metadata.sourceEventId) return null;

  return {
    eventId,
    sourceCalendarId: metadata.sourceCalendarId,
    sourceEventId: metadata.sourceEventId,
    sourceUpdated: metadata.sourceUpdated ?? '',
    responseStatus: metadata.responseStatus ?? '',
    pendingResponse: metadata.pendingResponse ?? '',
    note: metadata.note ?? '',
    responseError: metadata.responseError ?? '',
    metadata,
  };
}

function buildCopyMetadata(
  sourceCalendarId: string,
  sourceEventId: string,
  sourceUpdated: string,
  responseStatus: string
): CopyMetadata {
  return {
    isCopy: COPY_MARKER_VALUE,
    sourceCalendarId,
    sourceEventId,
    sourceUpdated,
    responseStatus,
  };
}

function isCopyable(event: ApiEvent): boolean {
  if (event.status === 'cancelled') return false;
  if ((event.eventType ?? 'default') !== 'default') return false;
  if (parseBlockMetadataFromDescription(event.description) !== null) return false;

  const title = event.summary ?? '';
  return !EXCLUDED_PREFIXES.some((prefix) => title.startsWith(prefix));
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

  return sections.join(SECTION_SEPARATOR);
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
  return [location?.trim(), meetUrl]
    .filter((part): part is string => !!part)
    .join(LOCATION_SEPARATOR);
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
