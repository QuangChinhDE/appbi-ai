import type { WorkboardDefaultOwnerCredentials } from '@/lib/api/workboards';

export interface WorkboardDefaultOwnerNotice extends WorkboardDefaultOwnerCredentials {
  workboardId: number;
}

const NOTICE_KEY_PREFIX = 'workboard-default-owner:';

function getNoticeKey(workboardId: number): string {
  return `${NOTICE_KEY_PREFIX}${workboardId}`;
}

export function storeWorkboardDefaultOwnerNotice(notice: WorkboardDefaultOwnerNotice): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(getNoticeKey(notice.workboardId), JSON.stringify(notice));
  } catch {}
}

export function consumeWorkboardDefaultOwnerNotice(
  workboardId: number,
): WorkboardDefaultOwnerNotice | null {
  if (typeof window === 'undefined') return null;
  const key = getNoticeKey(workboardId);
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    window.sessionStorage.removeItem(key);
  } catch {}
  try {
    const parsed = JSON.parse(raw) as Partial<WorkboardDefaultOwnerNotice>;
    if (
      Number(parsed.workboardId) === workboardId &&
      typeof parsed.username === 'string' &&
      typeof parsed.pin === 'string'
    ) {
      return {
        workboardId,
        username: parsed.username,
        pin: parsed.pin,
      };
    }
  } catch {
    return null;
  }
  return null;
}
