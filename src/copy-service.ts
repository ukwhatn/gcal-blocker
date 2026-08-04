import {
  CalendarLabel,
  CopyCandidate,
  CopyConfig,
  CopyMetadata,
  ExistingCopy,
  RsvpResponse,
  SyncPeriod,
} from './types';
import {
  COMMENT_MAX_LENGTH,
  COPY_MARKER_KEY,
  COPY_MARKER_VALUE,
  EXCLUDED_PREFIXES,
  RESPONSE_MARKS,
  RESPONSE_NONE,
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
const SECTION_SEPARATOR = '\n\n';

/** 返信メモ（元イベントの attendee コメント）を載せる見出し */
export const COMMENT_SECTION_HEADING = '# 返信メモ';

/** 出欠変更ページへのリンクを載せる見出し */
export const RSVP_SECTION_HEADING = '# 出欠変更';

/**
 * 元イベントに記録されている自分の出欠
 */
export interface OwnerResponse {
  status: string;
  comment: string;
}

/**
 * 元イベントへの出欠反映の結果
 * 権限エラー等は例外として投げ、出欠を持たない予定だけを notApplicable で返す
 */
export type RsvpApplyOutcome =
  | { status: 'applied'; response: OwnerResponse }
  | { status: 'notApplicable'; reason: string };

/**
 * コピー先に存在するコピーイベントと、そこに保存された状態
 * 表示に本体（タイトル・時刻）が要るウェブアプリのために両方を返す
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
 */
export function listCopyCandidates(
  sourceCalendarId: string,
  period: SyncPeriod,
  config: CopyConfig
): CopyCandidate[] {
  const label = getCalendarLabel(sourceCalendarId, config.labels);

  return listEvents(sourceCalendarId, period)
    .filter((event) => isCopyable(event))
    .map((event) => {
      const sourceEventId = event.id ?? '';
      const sourceUpdated = event.updated ?? '';
      const owner = getOwnerResponse(event, sourceCalendarId);

      return {
        key: buildCopyKey(sourceCalendarId, sourceEventId),
        sourceCalendarId,
        sourceEventId,
        sourceUpdated,
        responseStatus: owner.status,
        responseComment: owner.comment,
        payload: {
          ...buildCopyPayload(
            event,
            label,
            owner,
            buildRsvpUrl(config, sourceCalendarId, sourceEventId, owner)
          ),
          extendedProperties: {
            private: buildCopyMetadata(sourceCalendarId, sourceEventId, sourceUpdated, owner),
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
 * コピー元の識別子からコピーを引く
 *
 * ウェブアプリの URL にはコピー先の event ID ではなくコピー元の識別子を載せる。
 * コピー先の ID は insert のレスポンスを待たないと決まらず、リンクを description に
 * 書くために作成直後もう一度 patch する必要が出るため
 */
export function findCopyBySource(
  targetCalendarId: string,
  sourceCalendarId: string,
  sourceEventId: string
): CopySnapshot | null {
  const page = getEventsApi().list(targetCalendarId, {
    privateExtendedProperty: [
      `${COPY_MARKER_KEY}=${COPY_MARKER_VALUE}`,
      `sourceCalendarId=${sourceCalendarId}`,
      `sourceEventId=${sourceEventId}`,
    ],
    showDeleted: false,
    maxResults: 2,
  });

  for (const event of page.items ?? []) {
    const state = toExistingCopy(event);
    if (state) return { event, state };
  }

  return null;
}

export function insertCopy(targetCalendarId: string, candidate: CopyCandidate): void {
  getEventsApi().insert(candidate.payload, targetCalendarId);
}

/**
 * 既存コピーを最新の内容へ更新する
 * ウェブアプリが書いたメタ（pending*）を消さないよう、既存メタに上書きする形で送る
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
 * コピーのメタデータだけを更新する
 *
 * 渡された copy も最新化する。同じ run の後続処理（コピー同期の patch）が
 * 古いメタをマージし直すと、消したはずの入力が復活するため
 */
export function patchCopyMetadata(
  targetCalendarId: string,
  copy: ExistingCopy,
  changes: Record<string, string>
): void {
  const metadata = { ...copy.metadata, ...changes };
  getEventsApi().patch(
    { extendedProperties: { private: metadata } },
    targetCalendarId,
    copy.eventId
  );

  copy.metadata = metadata;
  copy.responseStatus = metadata.responseStatus ?? '';
  copy.responseComment = metadata.responseComment ?? '';
  copy.pendingAt = metadata.pendingAt ?? '';
  copy.pendingResponse = metadata.pendingResponse ?? '';
  copy.pendingComment = metadata.pendingComment ?? '';
  copy.responseError = metadata.responseError ?? '';
}

export function deleteCopy(targetCalendarId: string, eventId: string): void {
  getEventsApi().remove(targetCalendarId, eventId);
}

/**
 * 元カレンダーのイベントへ出欠と返信メモを書き込む
 * 自分（コピー元カレンダー）の attendee エントリだけを差し替える。
 * attendees は配列ごと送らないと他のゲストが消えるため、取得したものを写して送る
 */
export function applyResponseToSourceEvent(
  sourceCalendarId: string,
  sourceEventId: string,
  response: RsvpResponse | null,
  comment: string
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

  // 反映結果は patch のレスポンスから読み直す。API が値を受け付けなかったとき、
  // 送った値を「反映済み」として保存しないため
  const applied = api.patch(
    {
      attendees: attendees.map((attendee) =>
        attendee.email?.toLowerCase() === owner
          ? { ...attendee, responseStatus: response ?? attendee.responseStatus, comment }
          : attendee
      ),
    },
    sourceCalendarId,
    sourceEventId
  );

  return { status: 'applied', response: getOwnerResponse(applied, sourceCalendarId) };
}

export function buildCopyKey(sourceCalendarId: string, sourceEventId: string): string {
  return `${sourceCalendarId}|${sourceEventId}`;
}

/**
 * description から指定した見出しのセクションを取り除く
 */
export function stripSections(description: string | undefined, headings: string[]): string {
  return (description ?? '')
    .split(SECTION_SEPARATOR)
    .filter((section) => !headings.some((heading) => section.startsWith(heading)))
    .filter((section) => section.trim() !== '')
    .join(SECTION_SEPARATOR);
}

/**
 * 返信メモを保存できる形に整える
 */
export function normalizeComment(comment: string): string {
  return comment.trim().replace(/\r\n/g, '\n').slice(0, COMMENT_MAX_LENGTH);
}

/**
 * コピー先へ書き込むイベント内容を組み立てる
 * location / description は空文字を明示して、元イベントで消された内容が patch で残らないようにする
 */
export function buildCopyPayload(
  event: ApiEvent,
  label: CalendarLabel,
  owner: OwnerResponse,
  rsvpUrl: string
): ApiEvent {
  const meetUrl = getMeetUrl(event);
  const mark = RESPONSE_MARKS[owner.status];
  const payload: ApiEvent = {
    summary: `[${label.label}] ${mark ? `${mark} ` : ''}${event.summary || UNTITLED_EVENT_TITLE}`,
    description: buildCopyDescription(event, meetUrl, owner, rsvpUrl),
    location: joinLocation(event.location, meetUrl),
    start: event.start,
    end: event.end,
    visibility: event.visibility ?? 'default',
    // 欠席した予定は空き時間として見せる（コピーは残して出欠を取り消せるようにする）
    transparency: owner.status === 'declined' ? 'transparent' : (event.transparency ?? 'opaque'),
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
export function getOwnerResponse(event: ApiEvent, sourceCalendarId: string): OwnerResponse {
  const owner = sourceCalendarId.toLowerCase();
  const attendee = (event.attendees ?? []).find(
    (candidate) => candidate.email?.toLowerCase() === owner
  );

  return {
    status: attendee?.responseStatus ?? RESPONSE_NONE,
    comment: attendee?.comment ?? '',
  };
}

/**
 * 出欠変更ページの URL を組み立てる
 * 出欠を持たない予定にはリンクを載せない（開いても操作できないため）
 */
function buildRsvpUrl(
  config: CopyConfig,
  sourceCalendarId: string,
  sourceEventId: string,
  owner: OwnerResponse
): string {
  if (!config.rsvpWebAppUrl || owner.status === RESPONSE_NONE) return '';

  const params = [
    `c=${encodeURIComponent(sourceCalendarId)}`,
    `e=${encodeURIComponent(sourceEventId)}`,
  ];
  return `${config.rsvpWebAppUrl}?${params.join('&')}`;
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
    responseComment: metadata.responseComment ?? '',
    pendingAt: metadata.pendingAt ?? '',
    pendingResponse: metadata.pendingResponse ?? '',
    pendingComment: metadata.pendingComment ?? '',
    responseError: metadata.responseError ?? '',
    metadata,
  };
}

function buildCopyMetadata(
  sourceCalendarId: string,
  sourceEventId: string,
  sourceUpdated: string,
  owner: OwnerResponse
): CopyMetadata {
  return {
    isCopy: COPY_MARKER_VALUE,
    sourceCalendarId,
    sourceEventId,
    sourceUpdated,
    responseStatus: owner.status,
    responseComment: owner.comment,
  };
}

function isCopyable(event: ApiEvent): boolean {
  if (event.status === 'cancelled') return false;
  if ((event.eventType ?? 'default') !== 'default') return false;
  if (parseBlockMetadataFromDescription(event.description) !== null) return false;

  const title = event.summary ?? '';
  return !EXCLUDED_PREFIXES.some((prefix) => title.startsWith(prefix));
}

function buildCopyDescription(
  event: ApiEvent,
  meetUrl: string | undefined,
  owner: OwnerResponse,
  rsvpUrl: string
): string {
  const sections: string[] = [];

  if (owner.comment) sections.push(`${COMMENT_SECTION_HEADING}\n${owner.comment}`);

  const body = event.description?.trim();
  if (body) sections.push(body);

  const guests = collectGuestEmails(event);
  if (guests.length > 0) {
    sections.push([GUEST_SECTION_HEADING, ...guests.map((email) => `- ${email}`)].join('\n'));
  }

  if (meetUrl) sections.push(`${MEET_SECTION_HEADING}\n${meetUrl}`);
  if (rsvpUrl) sections.push(`${RSVP_SECTION_HEADING}\n${rsvpUrl}`);

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
