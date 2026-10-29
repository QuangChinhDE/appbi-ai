import type { WorkboardDefaultOwnerCredentials } from '@/lib/api/workboards';

export interface WorkboardDefaultOwnerNotice extends WorkboardDefaultOwnerCredentials {
  workboardId: number;
}

// The default owner PIN is shown exactly once, in DefaultOwnerCredentialsDialog,
// and must survive a navigation that happens before the user acknowledged it.
// sessionStorage (per tab, gone when the tab closes) is the fallback for that
// window only:
//   - it is cleared the moment the user acknowledges (clear…),
//   - it expires after NOTICE_TTL_MS even if never acknowledged,
//   - reading it (peek…) does NOT clear it, so a refresh before acknowledging
//     does not lose the credentials.
// Never log or render the value outside the dialog.
const NOTICE_KEY_PREFIX = 'workboard-default-owner:';
const NOTICE_TTL_MS = 15 * 60 * 1000;

function getNoticeKey(workboardId: number): string {
  return `${NOTICE_KEY_PREFIX}${workboardId}`;
}

export function storeWorkboardDefaultOwnerNotice(notice: WorkboardDefaultOwnerNotice): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(
      getNoticeKey(notice.workboardId),
      JSON.stringify({ ...notice, expiresAt: Date.now() + NOTICE_TTL_MS }),
    );
  } catch {}
}

export function clearWorkboardDefaultOwnerNotice(workboardId: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(getNoticeKey(workboardId));
  } catch {}
}

/** Unacknowledged credentials for this workboard, if any. Does not clear them. */
export function peekWorkboardDefaultOwnerNotice(
  workboardId: number,
): WorkboardDefaultOwnerNotice | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(getNoticeKey(workboardId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WorkboardDefaultOwnerNotice> & { expiresAt?: number };
    if (
      Number(parsed.workboardId) === workboardId &&
      typeof parsed.username === 'string' &&
      typeof parsed.pin === 'string' &&
      typeof parsed.expiresAt === 'number' &&
      parsed.expiresAt > Date.now()
    ) {
      return { workboardId, username: parsed.username, pin: parsed.pin };
    }
  } catch {}
  // Malformed, legacy (no expiry) or expired: drop it.
  clearWorkboardDefaultOwnerNotice(workboardId);
  return null;
}
