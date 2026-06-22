'use client';

/**
 * Floating offline/sync status bar for the mini-app runtime.
 *
 * Shows the number of submits queued offline + a manual "Đồng bộ" action, and
 * auto-syncs when the browser fires `online`, on a periodic retry, and when a
 * form is saved offline (`appbi-queue-changed`).
 *
 * The setup effect runs ONCE on mount. The auto-sync trigger functions are held
 * in refs (not effect deps) so toggling `syncing`/`pending` state never tears
 * down + re-arms the listeners — an earlier version put `doSync` in the deps and
 * span into a ~2/sec retry loop while offline (battery/network killer on mobile).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, WifiOff } from 'lucide-react';
import { pendingCount } from '@/lib/offline/queue';
import { syncSubmits } from '@/lib/offline/sync';

export default function OfflineBar() {
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);

  // Guard against overlapping syncs without making `doSync` depend on render
  // state (which would change its identity and retrigger the setup effect).
  const syncingRef = useRef(false);

  const doSync = useCallback(async () => {
    if (syncingRef.current) return;
    const before = await pendingCount();
    setPending(before);
    if (before === 0) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const r = await syncSubmits();
      setPending(r.remaining);
      setOffline(r.stoppedOffline);
      if (r.synced > 0) {
        setFlash(`Đã đồng bộ ${r.synced} bản ghi`);
        setTimeout(() => setFlash(null), 3000);
      }
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, []);

  // Keep a stable ref to the latest doSync so the mount-once effect can call it
  // without listing it as a dependency.
  const doSyncRef = useRef(doSync);
  doSyncRef.current = doSync;

  useEffect(() => {
    let cancelled = false;
    const sync = () => doSyncRef.current();
    const refresh = async () => {
      const n = await pendingCount();
      if (!cancelled) setPending(n);
    };

    refresh();
    const onChanged = () => {
      refresh();
      sync();
    };
    const onOnline = () => sync();
    window.addEventListener('appbi-queue-changed', onChanged);
    window.addEventListener('online', onOnline);
    // Periodic retry while items are queued (covers flaky / partial connectivity).
    const iv = setInterval(async () => {
      const n = await pendingCount();
      if (cancelled) return;
      setPending(n);
      if (n > 0) sync();
    }, 30000);
    // Attempt once on mount in case we reopened with a backlog + connectivity.
    sync();

    return () => {
      cancelled = true;
      window.removeEventListener('appbi-queue-changed', onChanged);
      window.removeEventListener('online', onOnline);
      clearInterval(iv);
    };
  }, []);

  if (pending === 0 && !flash) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex justify-center px-4">
      {flash && pending === 0 ? (
        <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 shadow-lg">
          <CheckCircle2 className="h-4 w-4" />
          {flash}
        </div>
      ) : (
        <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-amber-200 bg-white px-4 py-2 text-sm shadow-lg">
          <span className="flex items-center gap-1.5 font-semibold text-amber-700">
            {offline ? <WifiOff className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4 text-amber-500" />}
            {pending} bản ghi chờ gửi
          </span>
          <button
            onClick={() => doSyncRef.current()}
            disabled={syncing}
            className="flex items-center gap-1.5 rounded-full bg-[#0D3B7A] px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
          >
            {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {syncing ? 'Đang đồng bộ…' : 'Đồng bộ'}
          </button>
        </div>
      )}
    </div>
  );
}
