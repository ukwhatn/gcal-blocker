import { CopyConfig, RsvpSubmission, RsvpView } from './types';
import { RESPONSE_NONE, getCopyConfig, toRsvpResponse } from './config';
import {
  COMMENT_SECTION_HEADING,
  CopySnapshot,
  RSVP_CALENDAR_PARAM,
  RSVP_EVENT_PARAM,
  RSVP_SECTION_HEADING,
  findCopyBySource,
  normalizeComment,
  patchCopyMetadata,
  stripSections,
} from './copy-service';
import { applyPendingResponse } from './copy-engine';

const RSVP_TEMPLATE = 'rsvp';
const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

/** 同期トリガと重なったときに待つ上限。待てないときは再試行を促す */
const LOCK_TIMEOUT_MS = 10000;

/**
 * 出欠変更ページを返す
 * 初期表示に必要な状態を埋め込んで返し、表示のための往復をなくす
 */
export function renderRsvpPage(
  request: GoogleAppsScript.Events.DoGet | undefined
): GoogleAppsScript.HTML.HtmlOutput {
  const template = HtmlService.createTemplateFromFile(RSVP_TEMPLATE);
  template.initialState = JSON.stringify(buildInitialState(request));

  return template
    .evaluate()
    .setTitle('出欠')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 出欠・返信メモの入力を集約カレンダーへ保存する
 * 自プロジェクト担当のコピー元にはその場で反映し、担当外は次の同期に任せる
 */
export function submitRsvp(submission: RsvpSubmission): RsvpView {
  if (!submission?.sourceCalendarId || !submission?.sourceEventId) {
    throw new Error('対象の予定が指定されていません');
  }

  const response = toRsvpResponse(submission.response);
  if (!response) {
    throw new Error(`不正な出欠値です: ${submission.response}`);
  }

  const config = getCopyConfig();
  const lock = LockService.getScriptLock();

  // 同期トリガと同時に同じコピーを patch すると、書いた入力が古い内容で上書きされる
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    throw new Error('同期処理の実行中です。しばらく待ってから再試行してください');
  }

  try {
    const snapshot = findCopy(config, submission.sourceCalendarId, submission.sourceEventId);
    if (snapshot.state.responseStatus === RESPONSE_NONE) {
      throw new Error('ゲストとして登録されていない予定のため出欠を設定できません');
    }

    patchCopyMetadata(config.targetCalendarId, snapshot.state, {
      pendingAt: new Date().toISOString(),
      pendingResponse: response,
      pendingComment: normalizeComment(submission.comment ?? ''),
      responseError: '',
    });

    if (config.sourceCalendarIds.includes(snapshot.state.sourceCalendarId)) {
      applyPendingResponse(config.targetCalendarId, snapshot.state);
    }

    return toRsvpView(snapshot, config);
  } finally {
    lock.releaseLock();
  }
}

function buildInitialState(
  request: GoogleAppsScript.Events.DoGet | undefined
): { view: RsvpView } | { error: string } {
  const sourceCalendarId = request?.parameter?.[RSVP_CALENDAR_PARAM] ?? '';
  const sourceEventId = request?.parameter?.[RSVP_EVENT_PARAM] ?? '';

  if (!sourceCalendarId || !sourceEventId) {
    return { error: '予定が指定されていません。集約カレンダーの予定にある出欠変更リンクから開いてください' };
  }

  try {
    const config = getCopyConfig();
    return { view: toRsvpView(findCopy(config, sourceCalendarId, sourceEventId), config) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function findCopy(
  config: CopyConfig,
  sourceCalendarId: string,
  sourceEventId: string
): CopySnapshot {
  const snapshot = findCopyBySource(config.targetCalendarId, sourceCalendarId, sourceEventId);
  if (!snapshot) {
    throw new Error('集約カレンダーにこの予定のコピーが見つかりません');
  }
  return snapshot;
}

function toRsvpView({ event, state }: CopySnapshot, config: CopyConfig): RsvpView {
  const timeZone = Session.getScriptTimeZone();
  const startDateTime = event.start?.dateTime;
  const endDateTime = event.end?.dateTime;
  const startDate = startDateTime ? new Date(startDateTime) : parseDateOnly(event.start?.date);

  return {
    sourceCalendarId: state.sourceCalendarId,
    sourceEventId: state.sourceEventId,
    title: event.summary ?? '',
    dateLabel: `${Utilities.formatDate(startDate, timeZone, 'yyyy/M/d')} (${WEEKDAY_LABELS[startDate.getDay()]})`,
    timeLabel: startDateTime
      ? `${formatTime(startDate, timeZone)}–${endDateTime ? formatTime(new Date(endDateTime), timeZone) : ''}`
      : '終日',
    location: event.location ?? '',
    detail: stripSections(event.description, [COMMENT_SECTION_HEADING, RSVP_SECTION_HEADING]),
    responseStatus: state.responseStatus,
    responseComment: state.responseComment,
    pendingResponse: state.pendingResponse,
    pendingComment: state.pendingComment,
    responseError: state.responseError,
    canRespond: state.responseStatus !== RESPONSE_NONE,
    appliesImmediately: config.sourceCalendarIds.includes(state.sourceCalendarId),
  };
}

function parseDateOnly(date: string | undefined): Date {
  // 'yyyy-MM-dd' をそのまま Date に渡すと UTC 解釈になり、JST では前日にずれる
  return date ? new Date(`${date}T00:00:00`) : new Date();
}

function formatTime(date: Date, timeZone: string): string {
  return Utilities.formatDate(date, timeZone, 'HH:mm');
}
