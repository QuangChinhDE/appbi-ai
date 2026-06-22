/**
 * Replay queued offline submits when the server is reachable again.
 *
 * - Network error (no response) on an item → still offline: STOP, keep the
 *   whole queue intact (don't burn through items that can't reach the server).
 * - 4xx/5xx with a response → the server rejected it (validation etc.): mark
 *   that item `error` and continue with the rest.
 * - Success → remove from queue. Replay is idempotent via `opId` (client_op_id).
 */
import { allSubmits, removeSubmit, updateSubmit } from './queue';
import { workspaceApi } from '@/lib/api/workspace';

export function isNetworkError(err: unknown): boolean {
  // axios: a transport failure has no `response`; a server reply (4xx/5xx) does.
  const e = err as { response?: unknown; code?: string } | undefined;
  return !!e && e.response === undefined;
}

export interface SyncResult {
  synced: number;
  failed: number;
  remaining: number;
  stoppedOffline: boolean;
}

let inflight: Promise<SyncResult> | null = null;

export function syncSubmits(): Promise<SyncResult> {
  if (inflight) return inflight; // coalesce concurrent triggers
  inflight = (async () => {
    const items = await allSubmits();
    let synced = 0;
    let failed = 0;
    let stoppedOffline = false;
    for (const it of items) {
      if (it.status === 'error') continue; // needs user attention; skip auto-replay
      try {
        await workspaceApi.insertScreenRow(it.token, it.workboardId, it.screenId, it.values, it.opId);
        await removeSubmit(it.opId);
        synced++;
      } catch (err) {
        if (isNetworkError(err)) {
          stoppedOffline = true;
          break; // still offline — leave the rest queued
        }
        const detail =
          (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
        await updateSubmit(it.opId, {
          status: 'error',
          error: typeof detail === 'string' ? detail : 'Máy chủ từ chối bản ghi này.',
        });
        failed++;
      }
    }
    const remaining = (await allSubmits()).length;
    return { synced, failed, remaining, stoppedOffline };
  })();
  try {
    return inflight;
  } finally {
    inflight.finally(() => {
      inflight = null;
    });
  }
}
