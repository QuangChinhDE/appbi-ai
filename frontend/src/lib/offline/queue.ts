/**
 * Offline submit queue (IndexedDB).
 *
 * Form submits made while the device cannot reach the server are stored here
 * and replayed on reconnect. Persists across app restarts (unlike memory).
 *
 * IMPORTANT: "offline" is detected by an actual failed network request (axios
 * error with no `response`), NOT `navigator.onLine` — the latter reports
 * "online" whenever any LAN/Wi-Fi is up even if the server is unreachable.
 */
export interface QueuedSubmit {
  opId: string; // client-generated; used as the idempotency key on replay
  token: string;
  workboardId: number;
  screenId: string;
  screenTitle?: string;
  values: Record<string, unknown>;
  createdAt: number;
  status: 'pending' | 'error';
  error?: string | null;
}

const DB_NAME = 'appbi-offline';
const STORE = 'submits';
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'opId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export function newOpId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `op-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export async function enqueueSubmit(rec: QueuedSubmit): Promise<void> {
  await tx('readwrite', (s) => s.put(rec));
}

export async function allSubmits(): Promise<QueuedSubmit[]> {
  try {
    const list = await tx<QueuedSubmit[]>('readonly', (s) => s.getAll() as IDBRequest<QueuedSubmit[]>);
    return (list || []).sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

export async function pendingCount(): Promise<number> {
  const list = await allSubmits();
  return list.length;
}

export async function removeSubmit(opId: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(opId));
}

export async function updateSubmit(opId: string, patch: Partial<QueuedSubmit>): Promise<void> {
  const existing = await tx<QueuedSubmit | undefined>('readonly', (s) => s.get(opId) as IDBRequest<QueuedSubmit | undefined>);
  if (!existing) return;
  await tx('readwrite', (s) => s.put({ ...existing, ...patch }));
}
