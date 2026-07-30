import { BlockCandidate, SyncPeriod } from './types';
import {
  CalendarSnapshot,
  readCalendarSnapshot,
  findExistingBlockEvents,
  createBlockEvent,
  ensureEventPrivate,
  ensureBlockEventDuration,
  buildBlockKey,
  parseBlockMetadata,
} from './calendar-service';

type CalendarEvent = GoogleAppsScript.Calendar.CalendarEvent;

interface PairSyncResult {
  created: number;
  deleted: number;
  privatized: number;
  adjusted: number;
  errors: string[];
}

/**
 * 単一のカレンダーペア間でブロックを同期
 * source -> target へブロックイベントを作成/削除
 *
 * - 作成判定: existingBlocks 全体（origin key）で重複防止
 * - 削除判定: direct source 一致の relevantBlocks のみ操作（所有権分離）
 *
 * existingBlocks は呼び出し側が保持する target の索引で、作成・削除に合わせて更新する
 * （同一実行の後続ペアが同じ origin のブロックを二重作成しないため）
 */
export function syncCalendarPair(
  sourceCalendarId: string,
  blockCandidates: BlockCandidate[],
  target: CalendarSnapshot,
  existingBlocks: Map<string, CalendarEvent[]>
): PairSyncResult {
  const targetCalendarId = target.calendarId;
  console.log(`  ソースイベント数: ${blockCandidates.length}`);

  // 削除責任分離: このソースが直接 put したブロックのみ削除候補化
  const relevantBlocks = new Map<string, CalendarEvent[]>();
  for (const [key, events] of existingBlocks) {
    const filtered = events.filter((event) => {
      const md = parseBlockMetadata(event);
      return md !== null && md.sourceCalendarId === sourceCalendarId;
    });
    if (filtered.length > 0) {
      relevantBlocks.set(key, filtered);
    }
  }
  console.log(`  既存ブロック数(自source): ${relevantBlocks.size}`);

  let created = 0;
  let deleted = 0;
  let privatized = 0;
  let adjusted = 0;
  const errors: string[] = [];

  // 作成: existingBlocks 全体で重複検知（origin key 一意性）
  const candidateByKey = new Map<string, BlockCandidate>();
  for (const candidate of blockCandidates) {
    const key = buildBlockKey(
      candidate.originCalendarId,
      candidate.originEventId,
      candidate.originStartTime.toISOString()
    );
    candidateByKey.set(key, candidate);

    if (!existingBlocks.has(key)) {
      console.log(`  作成: ${candidate.sourceStartTime.toISOString()} (${candidate.isAllDay ? '終日' : '時間指定'}, origin=${candidate.originCalendarId})`);
      // 非公開ブロック作成に成功した場合のみ加算（失敗時は作成イベント削除済み・次回再試行）
      const blockEvent = createBlockEvent(target.calendar, candidate);
      if (blockEvent) {
        existingBlocks.set(key, [blockEvent]);
        created++;
      } else {
        // 非公開化失敗でブロックは未作成（公開ブロックは残さない）。検知のため errors に記録
        errors.push(
          `block not created (visibility failed) on ${targetCalendarId} @ ${candidate.sourceStartTime.toISOString()}`
        );
      }
    }
  }

  // 既存ブロックの是正: 自source の relevantBlocks を非公開化し、期間のずれを補正する
  for (const [key, events] of relevantBlocks) {
    const candidate = candidateByKey.get(key);
    for (const event of events) {
      try {
        if (ensureEventPrivate(event)) {
          console.log(`  非公開化: ${event.getStartTime().toISOString()}`);
          privatized++;
        }
        if (candidate && ensureBlockEventDuration(event, candidate)) {
          console.log(`  期間補正: ${event.getStartTime().toISOString()}`);
          adjusted++;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`  既存ブロックの是正に失敗: ${message}`);
        // 公開ブロック・期間ずれが残存し得るため検知用に記録
        errors.push(
          `ensure block failed on ${targetCalendarId} @ ${event.getStartTime().toISOString()}: ${message}`
        );
      }
    }
  }

  // 削除: 自source の relevantBlocks のみ、配列全要素を対象
  for (const [key, events] of relevantBlocks) {
    if (candidateByKey.has(key)) continue;
    for (const event of events) {
      console.log(`  削除: ${event.getStartTime().toISOString()}`);
      event.deleteEvent();
      removeFromIndex(existingBlocks, key, event);
      deleted++;
    }
  }

  return { created, deleted, privatized, adjusted, errors };
}

/**
 * 削除したブロックを target の索引から取り除く
 * 同一キーに他 source のブロックが残る場合があるため、キーごと消さずに要素単位で外す
 */
function removeFromIndex(
  existingBlocks: Map<string, CalendarEvent[]>,
  key: string,
  removed: CalendarEvent
): void {
  const remaining = (existingBlocks.get(key) ?? []).filter(
    (event) => event.getId() !== removed.getId()
  );
  if (remaining.length > 0) {
    existingBlocks.set(key, remaining);
  } else {
    existingBlocks.delete(key);
  }
}

/**
 * 指定カレンダーから自スクリプト管理の自動ブロックイベントを削除
 * direct source ∈ internalCalendarIds のものだけ削除（他プロジェクト管理を保護）
 */
export function clearBlockEvents(
  calendarId: string,
  period: SyncPeriod,
  internalCalendarIds: string[]
): number {
  const existingBlocks = findExistingBlockEvents(readCalendarSnapshot(calendarId, period));

  let deleted = 0;
  for (const [, events] of existingBlocks) {
    for (const event of events) {
      const md = parseBlockMetadata(event);
      if (md && internalCalendarIds.includes(md.sourceCalendarId)) {
        console.log(`  削除: ${event.getStartTime().toISOString()}`);
        event.deleteEvent();
        deleted++;
      }
    }
  }

  return deleted;
}
