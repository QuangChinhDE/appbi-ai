/**
 * Persistent offline submit queue and parent-child relation flows.
 *
 * A relation flow uses a client UUID as its local identity. The UUID is not
 * written into the datasource: after the parent syncs, its real server key is
 * stored on the flow and injected into every dependent child replay.
 */
export type QueuedSubmitStatus = 'pending' | 'error';
export type RelationFlowStatus = 'pending_parent' | 'active' | 'error' | 'finished';

export interface OfflineRelationRef {
  flowId: string;
  relationId: string;
  parentScreenId: string;
  childScreenId: string;
  parentKeyColumn: string;
  childForeignKeyColumn: string;
}

export interface QueuedSubmit {
  opId: string;
  token: string;
  workboardId: number;
  screenId: string;
  screenTitle?: string;
  values: Record<string, unknown>;
  createdAt: number;
  status: QueuedSubmitStatus;
  error?: string | null;
  dependsOnOpId?: string | null;
  relation?: OfflineRelationRef | null;
  producesRelation?: OfflineRelationRef | null;
}

export interface OfflineRelationFlow extends OfflineRelationRef {
  token: string;
  workboardId: number;
  parentOpId?: string | null;
  relationLabel?: string | null;
  parentKeyValue?: unknown;
  parentValues?: Record<string, unknown>;
  finishScreenId?: string | null;
  showExisting?: boolean;
  allowMultiple?: boolean;
  keepParentContext?: boolean;
  status: RelationFlowStatus;
  error?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface OfflineQueueStats {
  total: number;
  pending: number;
  failed: number;
}

const DB_NAME = 'appbi-offline';
const SUBMITS_STORE = 'submits';
const RELATION_FLOWS_STORE = 'relation-flows';
const DB_VERSION = 2;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SUBMITS_STORE)) {
        db.createObjectStore(SUBMITS_STORE, { keyPath: 'opId' });
      }
      if (!db.objectStoreNames.contains(RELATION_FLOWS_STORE)) {
        db.createObjectStore(RELATION_FLOWS_STORE, { keyPath: 'flowId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const req = fn(transaction.objectStore(storeName));
        let result = undefined as T;
        req.onsuccess = () => {
          result = req.result as T;
        };
        req.onerror = () => reject(req.error);
        transaction.oncomplete = () => {
          db.close();
          resolve(result);
        };
        transaction.onerror = () => {
          db.close();
          reject(transaction.error);
        };
      }),
  );
}

export function newOpId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    // Fall through for older WebViews.
  }
  return `op-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export function newRelationFlowId(): string {
  return `relation-${newOpId()}`;
}

export function hasResolvedParentKey(flow: OfflineRelationFlow | null | undefined): boolean {
  const value = flow?.parentKeyValue;
  return value !== undefined && value !== null && value !== '';
}

export async function enqueueSubmit(record: QueuedSubmit): Promise<void> {
  await tx(SUBMITS_STORE, 'readwrite', (store) => store.put(record));
}

export async function enqueueRelationParent(
  record: QueuedSubmit,
  flow: OfflineRelationFlow,
): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(
      [SUBMITS_STORE, RELATION_FLOWS_STORE],
      'readwrite',
    );
    transaction.objectStore(SUBMITS_STORE).put(record);
    transaction.objectStore(RELATION_FLOWS_STORE).put(flow);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error || new Error('Offline transaction aborted'));
    };
  });
}

export async function allSubmits(): Promise<QueuedSubmit[]> {
  try {
    const list = await tx<QueuedSubmit[]>(SUBMITS_STORE, 'readonly', (store) =>
      store.getAll() as IDBRequest<QueuedSubmit[]>,
    );
    return (list || []).sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

export async function relationSubmits(flowId: string): Promise<QueuedSubmit[]> {
  return (await allSubmits()).filter(
    (item) => item.relation?.flowId === flowId || item.producesRelation?.flowId === flowId,
  );
}

export async function pendingCount(): Promise<number> {
  return (await allSubmits()).length;
}

export async function queueStats(): Promise<OfflineQueueStats> {
  const items = await allSubmits();
  return {
    total: items.length,
    pending: items.filter((item) => item.status === 'pending').length,
    failed: items.filter((item) => item.status === 'error').length,
  };
}

export async function removeSubmit(opId: string): Promise<void> {
  await tx(SUBMITS_STORE, 'readwrite', (store) => store.delete(opId));
}

export async function updateSubmit(opId: string, patch: Partial<QueuedSubmit>): Promise<void> {
  const existing = await tx<QueuedSubmit | undefined>(SUBMITS_STORE, 'readonly', (store) =>
    store.get(opId) as IDBRequest<QueuedSubmit | undefined>,
  );
  if (!existing) return;
  await tx(SUBMITS_STORE, 'readwrite', (store) => store.put({ ...existing, ...patch }));
}

export async function retryFailedSubmits(): Promise<void> {
  const failed = (await allSubmits()).filter((item) => item.status === 'error');
  await Promise.all(
    failed.map((item) => updateSubmit(item.opId, { status: 'pending', error: null })),
  );
}

export async function saveRelationFlow(flow: OfflineRelationFlow): Promise<void> {
  await tx(RELATION_FLOWS_STORE, 'readwrite', (store) => store.put(flow));
}

export async function getRelationFlow(flowId: string): Promise<OfflineRelationFlow | null> {
  try {
    const flow = await tx<OfflineRelationFlow | undefined>(RELATION_FLOWS_STORE, 'readonly',
      (store) => store.get(flowId) as IDBRequest<OfflineRelationFlow | undefined>,
    );
    return flow || null;
  } catch {
    return null;
  }
}

export async function updateRelationFlow(
  flowId: string,
  patch: Partial<OfflineRelationFlow>,
): Promise<OfflineRelationFlow | null> {
  const existing = await getRelationFlow(flowId);
  if (!existing) return null;
  const next = { ...existing, ...patch, flowId, updatedAt: Date.now() };
  await saveRelationFlow(next);
  return next;
}

export async function finishRelationFlow(flowId: string): Promise<void> {
  await updateRelationFlow(flowId, { status: 'finished', error: null });
}

export async function latestRelationFlow(
  token: string,
  workboardId: number,
  childScreenId?: string,
): Promise<OfflineRelationFlow | null> {
  try {
    const flows = await tx<OfflineRelationFlow[]>(RELATION_FLOWS_STORE, 'readonly', (store) =>
      store.getAll() as IDBRequest<OfflineRelationFlow[]>,
    );
    return (flows || [])
      .filter(
        (flow) =>
          flow.token === token &&
          flow.workboardId === workboardId &&
          flow.status !== 'finished' &&
          (!childScreenId || flow.childScreenId === childScreenId),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
  } catch {
    return null;
  }
}

export function notifyOfflineQueueChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('appbi-queue-changed'));
    window.dispatchEvent(new Event('appbi-relation-flow-changed'));
  }
}
