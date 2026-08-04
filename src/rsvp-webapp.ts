import { AgendaItem, RsvpSubmission } from './types';
import { RESPONSE_NONE, getAgendaPeriod, getCopyConfig, toRsvpResponse } from './config';
import {
  CopySnapshot,
  getCopySnapshot,
  listCopySnapshots,
  normalizeNote,
  patchCopyState,
  replaceNoteSection,
} from './copy-service';
import { applyPendingResponse } from './copy-engine';

const AGENDA_TEMPLATE = 'agenda';
const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

/** 同期トリガと重なったときに待つ上限。待てないときは再試行を促す */
const LOCK_TIMEOUT_MS = 10000;

/**
 * 予定一覧ページを返す
 */
export function renderAgendaPage(): GoogleAppsScript.HTML.HtmlOutput {
  return HtmlService.createHtmlOutputFromFile(AGENDA_TEMPLATE)
    .setTitle('予定一覧')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 集約カレンダーのコピーを開始日時順に返す
 */
export function loadAgenda(): AgendaItem[] {
  const config = getCopyConfig();

  return listCopySnapshots(config.targetCalendarId, getAgendaPeriod())
    .map(toAgendaItem)
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
}

/**
 * 出欠・メモの入力を集約カレンダーへ保存する
 * 自プロジェクト担当のコピー元にはその場で出欠を反映し、担当外は次の同期に任せる
 */
export function submitRsvp(submission: RsvpSubmission): AgendaItem {
  if (!submission?.eventId) {
    throw new Error('対象の予定が指定されていません');
  }

  const config = getCopyConfig();
  const lock = LockService.getScriptLock();

  // 同期トリガと同時に同じコピーを patch すると、書いた入力が古い内容で上書きされる
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    throw new Error('同期処理の実行中です。しばらく待ってから再試行してください');
  }

  try {
    const snapshot = getCopySnapshot(config.targetCalendarId, submission.eventId);
    if (!snapshot) {
      throw new Error('集約カレンダーのコピーではない予定です');
    }

    const metadata: Record<string, string> = {};
    let description: string | undefined;

    if (submission.note != null) {
      const note = normalizeNote(submission.note);
      metadata.note = note;
      description = replaceNoteSection(snapshot.event.description, note);
    }

    if (submission.response != null) {
      const response = toRsvpResponse(submission.response);
      if (!response) {
        throw new Error(`不正な出欠値です: ${submission.response}`);
      }
      metadata.pendingResponse = response;
      metadata.pendingResponseAt = new Date().toISOString();
      metadata.responseError = '';
    }

    if (Object.keys(metadata).length === 0) {
      return toAgendaItem(snapshot);
    }

    patchCopyState(config.targetCalendarId, snapshot.state, { metadata, description });

    if (
      metadata.pendingResponse &&
      config.sourceCalendarIds.includes(snapshot.state.sourceCalendarId)
    ) {
      applyPendingResponse(config.targetCalendarId, snapshot.state);
    }

    return toAgendaItem(snapshot);
  } finally {
    lock.releaseLock();
  }
}

function toAgendaItem({ event, state }: CopySnapshot): AgendaItem {
  const timeZone = Session.getScriptTimeZone();
  const startDateTime = event.start?.dateTime;
  const endDateTime = event.end?.dateTime;
  const startDate = startDateTime ? new Date(startDateTime) : parseDateOnly(event.start?.date);

  return {
    eventId: event.id ?? '',
    title: event.summary ?? '',
    sortKey: startDateTime ?? event.start?.date ?? '',
    dateKey: Utilities.formatDate(startDate, timeZone, 'yyyy-MM-dd'),
    dateLabel: `${Utilities.formatDate(startDate, timeZone, 'M/d')} (${WEEKDAY_LABELS[startDate.getDay()]})`,
    timeLabel: startDateTime
      ? `${formatTime(startDate, timeZone)}–${endDateTime ? formatTime(new Date(endDateTime), timeZone) : ''}`
      : '終日',
    isAllDay: !startDateTime,
    sourceCalendarId: state.sourceCalendarId,
    location: event.location ?? '',
    detail: replaceNoteSection(event.description, ''),
    responseStatus: state.responseStatus,
    pendingResponse: state.pendingResponse,
    note: state.note,
    responseError: state.responseError,
    canRespond: state.responseStatus !== RESPONSE_NONE,
  };
}

function parseDateOnly(date: string | undefined): Date {
  // 'yyyy-MM-dd' をそのまま Date に渡すと UTC 解釈になり、JST では前日にずれる
  return date ? new Date(`${date}T00:00:00`) : new Date();
}

function formatTime(date: Date, timeZone: string): string {
  return Utilities.formatDate(date, timeZone, 'HH:mm');
}
