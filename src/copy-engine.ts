import { CopyCandidate, CopyConfig, CopyResult, ExistingCopy, SyncPeriod } from './types';
import { getCopyConfig, getCopyPeriod, toRsvpResponse } from './config';
import {
  applyResponseToSourceEvent,
  deleteCopy,
  insertCopy,
  listCopyCandidates,
  listExistingCopies,
  patchCopy,
  patchCopyMetadata,
} from './copy-service';

/** 期間外コピーの掃除で遡る月数 */
const OUT_OF_RANGE_MONTHS = 6;

/** 出欠入力を消費したあとのメタ（Calendar API は値を削除できないため空文字で消す） */
const CONSUMED_PENDING = { pendingAt: '', pendingResponse: '', pendingComment: '' };

/**
 * 担当カレンダーの予定を共通カレンダーへコピーする
 * 作成・更新・削除はいずれも自プロジェクトの COPY_SOURCE_IDS 由来のコピーだけを対象にする
 */
export function runCopy(): CopyResult {
  const config = getCopyConfig();
  const period = getCopyPeriod();

  console.log('=== コピー開始 ===');
  console.log(`コピー先: ${config.targetCalendarId}`);
  console.log(`担当カレンダー: ${config.sourceCalendarIds.join(', ')}`);
  console.log(`対象期間: ${period.start.toISOString()} ~ ${period.end.toISOString()}`);

  const result: CopyResult = { created: 0, updated: 0, deleted: 0, applied: 0, errors: [] };
  const existingCopies = listExistingCopies(config.targetCalendarId, period);
  const candidateKeys = new Set<string>();
  const failedSources = new Set<string>();

  // コピー同期より先に反映する。反映で元イベントが更新され、その結果を同じ run で拾えるため
  result.applied = applyPendingResponses(config, existingCopies, result.errors);

  for (const sourceCalendarId of config.sourceCalendarIds) {
    console.log(`--- ${sourceCalendarId} ---`);
    try {
      const candidates = listCopyCandidates(sourceCalendarId, period, config);
      console.log(`  コピー対象: ${candidates.length}`);

      for (const candidate of candidates) {
        candidateKeys.add(candidate.key);
        try {
          applyCandidate(
            config.targetCalendarId,
            candidate,
            existingCopies.get(candidate.key),
            result
          );
        } catch (error) {
          const message = toMessage(error);
          result.errors.push(`copy ${candidate.key}: ${message}`);
          console.warn(`  コピーに失敗: ${message}`);
        }
      }
    } catch (error) {
      const message = toMessage(error);
      // 一覧取得に失敗したカレンダーのコピーは削除対象から外す（全消し事故の防止）
      failedSources.add(sourceCalendarId);
      result.errors.push(`list ${sourceCalendarId}: ${message}`);
      console.error(`  エラー: ${message}`);
    }
  }

  result.deleted += deleteObsoleteCopies(
    config,
    existingCopies,
    (key, copy) => !candidateKeys.has(key) && !failedSources.has(copy.sourceCalendarId),
    result.errors
  );

  console.log('=== コピー完了 ===');
  console.log(
    `合計: created=${result.created}, updated=${result.updated}, deleted=${result.deleted}, applied=${result.applied}, errors=${result.errors.length}`
  );

  return result;
}

/**
 * 集約カレンダーに置かれた出欠入力を、自プロジェクト担当のコピー元へ反映する
 * 他プロジェクト担当のコピーには触れない（そのカレンダーへの書き込み権限を持たないため）
 */
export function applyPendingResponses(
  config: CopyConfig,
  existingCopies: Map<string, ExistingCopy[]>,
  errors: string[]
): number {
  let applied = 0;

  for (const copies of existingCopies.values()) {
    for (const copy of copies) {
      if (!copy.pendingAt) continue;
      if (!config.sourceCalendarIds.includes(copy.sourceCalendarId)) continue;

      try {
        if (applyPendingResponse(config.targetCalendarId, copy)) applied++;
      } catch (error) {
        const message = toMessage(error);
        errors.push(`rsvp ${copy.sourceCalendarId}|${copy.sourceEventId}: ${message}`);
        console.warn(`  出欠の反映に失敗: ${message}`);
      }
    }
  }

  return applied;
}

/**
 * 1 件の入力を元カレンダーへ反映し、入力を消費済みにする
 * 反映できなかった理由はコピーに残してウェブアプリから見えるようにする
 */
export function applyPendingResponse(targetCalendarId: string, copy: ExistingCopy): boolean {
  const outcome = applyResponseToSourceEvent(
    copy.sourceCalendarId,
    copy.sourceEventId,
    toRsvpResponse(copy.pendingResponse),
    copy.pendingComment
  );

  if (outcome.status === 'notApplicable') {
    patchCopyMetadata(targetCalendarId, copy, {
      ...CONSUMED_PENDING,
      responseError: outcome.reason,
    });
    console.log(`  出欠を反映できず: ${copy.sourceEventId} (${outcome.reason})`);
    return false;
  }

  patchCopyMetadata(targetCalendarId, copy, {
    ...CONSUMED_PENDING,
    responseError: '',
    responseStatus: outcome.response.status,
    responseComment: outcome.response.comment,
  });
  console.log(`  出欠を反映: ${copy.sourceEventId} -> ${outcome.response.status}`);
  return true;
}

/**
 * 自プロジェクト担当のコピーを同期対象期間内で全削除
 */
export function clearAllCopyEvents(): { deleted: number; errors: string[] } {
  return clearCopiesInPeriod(getCopyPeriod());
}

/**
 * 同期対象期間外に取り残されたコピーを削除
 * 同期期間の短縮で孤児化したコピーの掃除に使う
 * 削除対象は自プロジェクト担当分のみなので、COPY_SOURCE_IDS から外したカレンダーのコピーは
 * 一度 COPY_SOURCE_IDS へ戻して clearAllCopies() を実行する
 */
export function clearOutOfRangeCopyEvents(): { deleted: number; errors: string[] } {
  const period = getCopyPeriod();
  const end = new Date(period.end);
  end.setMonth(end.getMonth() + OUT_OF_RANGE_MONTHS);
  return clearCopiesInPeriod({ start: period.end, end });
}

function clearCopiesInPeriod(period: SyncPeriod): { deleted: number; errors: string[] } {
  const config = getCopyConfig();

  console.log('=== コピー削除開始 ===');
  console.log(`対象期間: ${period.start.toISOString()} ~ ${period.end.toISOString()}`);

  const errors: string[] = [];
  const existingCopies = listExistingCopies(config.targetCalendarId, period);
  const deleted = deleteObsoleteCopies(config, existingCopies, () => true, errors);

  console.log('=== コピー削除完了 ===');
  console.log(`合計削除数: ${deleted}`);

  return { deleted, errors };
}

function applyCandidate(
  targetCalendarId: string,
  candidate: CopyCandidate,
  existing: ExistingCopy[] | undefined,
  result: CopyResult
): void {
  if (!existing || existing.length === 0) {
    insertCopy(targetCalendarId, candidate);
    console.log(`  作成: ${candidate.payload.summary}`);
    result.created++;
    return;
  }

  const [current, ...duplicates] = existing;
  if (
    current.sourceUpdated !== candidate.sourceUpdated ||
    current.responseStatus !== candidate.responseStatus ||
    current.responseComment !== candidate.responseComment
  ) {
    patchCopy(targetCalendarId, current, candidate);
    console.log(`  更新: ${candidate.payload.summary}`);
    result.updated++;
  }

  for (const duplicate of duplicates) {
    deleteCopy(targetCalendarId, duplicate.eventId);
    console.warn(`  重複コピーを削除: ${candidate.key}`);
    result.deleted++;
  }
}

function deleteObsoleteCopies(
  config: CopyConfig,
  existingCopies: Map<string, ExistingCopy[]>,
  shouldDelete: (key: string, copy: ExistingCopy) => boolean,
  errors: string[]
): number {
  let deleted = 0;

  for (const [key, copies] of existingCopies) {
    for (const copy of copies) {
      if (!config.sourceCalendarIds.includes(copy.sourceCalendarId)) continue;
      if (!shouldDelete(key, copy)) continue;

      try {
        deleteCopy(config.targetCalendarId, copy.eventId);
        console.log(`  削除: ${key}`);
        deleted++;
      } catch (error) {
        const message = toMessage(error);
        errors.push(`delete ${key}: ${message}`);
        console.warn(`  削除に失敗: ${message}`);
      }
    }
  }

  return deleted;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
