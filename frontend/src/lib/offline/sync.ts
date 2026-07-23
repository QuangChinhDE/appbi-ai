/** Dependency-aware replay for persistent offline form submissions. */
import { workspaceApi } from '@/lib/api/workspace';
import {
  allSubmits,
  getRelationFlow,
  hasResolvedParentKey,
  notifyOfflineQueueChanged,
  removeSubmit,
  retryFailedSubmits,
  updateRelationFlow,
  updateSubmit,
} from './queue';

export function isNetworkError(err: unknown): boolean {
  const error = err as { response?: unknown; code?: string } | undefined;
  return !!error && error.response === undefined;
}

export interface SyncResult {
  synced: number;
  failed: number;
  remaining: number;
  stoppedOffline: boolean;
}

interface SyncOptions {
  retryErrors?: boolean;
}

function responseValue(result: Record<string, unknown>, column: string): unknown {
  const row = result.row;
  if (row && typeof row === 'object' && column in row) {
    return (row as Record<string, unknown>)[column];
  }
  const pk = result.pk;
  if (pk && typeof pk === 'object' && column in pk) {
    return (pk as Record<string, unknown>)[column];
  }
  return undefined;
}

function serverErrorMessage(err: unknown): string {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object' && 'message' in detail) {
    return String((detail as { message: unknown }).message);
  }
  return 'Máy chủ từ chối bản ghi này.';
}

function dependencyOrder(items: Awaited<ReturnType<typeof allSubmits>>) {
  const byId = new Map(items.map((item) => [item.opId, item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: typeof items = [];
  const visit = (opId: string) => {
    if (visited.has(opId) || visiting.has(opId)) return;
    const item = byId.get(opId);
    if (!item) return;
    visiting.add(opId);
    if (item.dependsOnOpId) visit(item.dependsOnOpId);
    visiting.delete(opId);
    visited.add(opId);
    ordered.push(item);
  };
  items.forEach((item) => visit(item.opId));
  return ordered;
}

let inflight: Promise<SyncResult> | null = null;

export function syncSubmits(options: SyncOptions = {}): Promise<SyncResult> {
  if (inflight) return inflight;
  inflight = (async () => {
    if (options.retryErrors) await retryFailedSubmits();
    const items = dependencyOrder(await allSubmits());
    const byOpId = new Map(items.map((item) => [item.opId, item]));
    let synced = 0;
    let failed = 0;
    let stoppedOffline = false;

    for (const item of items) {
      if (item.status === 'error') continue;

      let relationContext: Record<string, unknown> | null = null;
      if (item.relation) {
        const flow = await getRelationFlow(item.relation.flowId);
        if (!flow) {
          await updateSubmit(item.opId, {
            status: 'error',
            error: 'Không tìm thấy ngữ cảnh cha-con đã lưu trên thiết bị.',
          });
          failed++;
          continue;
        }
        if (item.dependsOnOpId && byOpId.has(item.dependsOnOpId)) {
          // Even when the user supplied the future parent key offline, the
          // parent row must exist before backend relation/RLS validation runs.
          continue;
        }
        if (!hasResolvedParentKey(flow)) {
          const parent = item.dependsOnOpId ? byOpId.get(item.dependsOnOpId) : null;
          if (parent) {
            // Parent appears earlier in the queue. It either could not sync in
            // this pass or is waiting for the user to retry its error.
            continue;
          }
          await updateSubmit(item.opId, {
            status: 'error',
            error: 'Không thể resolve khóa Parent cho bản ghi Child.',
          });
          failed++;
          continue;
        }
        relationContext = {
          relation_id: flow.relationId,
          parent_screen_id: flow.parentScreenId,
          parent_key_value: flow.parentKeyValue,
        };
      }

      try {
        const result = await workspaceApi.insertScreenRow(
          item.token,
          item.workboardId,
          item.screenId,
          item.values,
          item.opId,
          relationContext,
        );

        if (item.producesRelation) {
          const parentKeyValue = responseValue(result, item.producesRelation.parentKeyColumn);
          if (parentKeyValue === undefined || parentKeyValue === null || parentKeyValue === '') {
            const message = `Parent đã đồng bộ nhưng phản hồi không có khóa ${item.producesRelation.parentKeyColumn}.`;
            await updateSubmit(item.opId, { status: 'error', error: message });
            await updateRelationFlow(item.producesRelation.flowId, {
              status: 'error',
              error: message,
            });
            failed++;
            continue;
          }
          const currentFlow = await getRelationFlow(item.producesRelation.flowId);
          const updated = await updateRelationFlow(item.producesRelation.flowId, {
            parentKeyValue,
            status: currentFlow?.status === 'finished' ? 'finished' : 'active',
            error: null,
          });
          if (!updated) {
            await updateSubmit(item.opId, {
              status: 'error',
              error: 'Không thể lưu kết quả đồng bộ Parent vào relation flow.',
            });
            failed++;
            continue;
          }
        }

        await removeSubmit(item.opId);
        byOpId.delete(item.opId);
        synced++;
      } catch (err) {
        if (isNetworkError(err)) {
          stoppedOffline = true;
          break;
        }
        const message = serverErrorMessage(err);
        await updateSubmit(item.opId, { status: 'error', error: message });
        if (item.producesRelation) {
          await updateRelationFlow(item.producesRelation.flowId, {
            status: 'error',
            error: message,
          });
        }
        failed++;
      }
    }

    const remaining = (await allSubmits()).length;
    notifyOfflineQueueChanged();
    return { synced, failed, remaining, stoppedOffline };
  })();
  const current = inflight;
  void current.then(
    () => {
      if (inflight === current) inflight = null;
    },
    () => {
      if (inflight === current) inflight = null;
    },
  );
  return current;
}
