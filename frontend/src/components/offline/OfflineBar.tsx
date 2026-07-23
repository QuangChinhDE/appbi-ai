'use client';

/** Floating queue status and retry control for the mini-app runtime. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, WifiOff } from 'lucide-react';
import { queueStats } from '@/lib/offline/queue';
import { syncSubmits } from '@/lib/offline/sync';

export default function OfflineBar() {
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const syncingRef = useRef(false);

  const refreshStats = useCallback(async () => {
    const stats = await queueStats();
    setPending(stats.total);
    setFailed(stats.failed);
    return stats;
  }, []);

  const doSync = useCallback(async (retryErrors = false) => {
    if (syncingRef.current) return;
    const before = await refreshStats();
    if (before.total === 0) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const result = await syncSubmits({ retryErrors });
      await refreshStats();
      setOffline(result.stoppedOffline);
      if (result.synced > 0) {
        setFlash(`Đã đồng bộ ${result.synced} bản ghi`);
        setTimeout(() => setFlash(null), 3000);
      }
    } catch {
      await refreshStats();
      setOffline(true);
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [refreshStats]);

  const doSyncRef = useRef(doSync);
  doSyncRef.current = doSync;

  useEffect(() => {
    let cancelled = false;
    const sync = () => void doSyncRef.current(false);
    const refresh = async () => {
      const stats = await queueStats();
      if (!cancelled) {
        setPending(stats.total);
        setFailed(stats.failed);
      }
      return stats;
    };
    const onChanged = () => void refresh();
    const onOnline = () => sync();

    void refresh();
    window.addEventListener('appbi-queue-changed', onChanged);
    window.addEventListener('online', onOnline);
    const interval = setInterval(async () => {
      const stats = await refresh();
      if (!cancelled && stats.pending > 0) sync();
    }, 30000);
    sync();

    return () => {
      cancelled = true;
      window.removeEventListener('appbi-queue-changed', onChanged);
      window.removeEventListener('online', onOnline);
      clearInterval(interval);
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
          <span className={`flex items-center gap-1.5 font-semibold ${failed > 0 ? 'text-rose-700' : 'text-amber-700'}`}>
            {failed > 0 ? (
              <AlertTriangle className="h-4 w-4" />
            ) : offline ? (
              <WifiOff className="h-4 w-4" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-amber-500" />
            )}
            {failed > 0 ? `${failed} lỗi, ${pending - failed} chờ gửi` : `${pending} bản ghi chờ gửi`}
          </span>
          <button
            type="button"
            onClick={() => void doSyncRef.current(true)}
            disabled={syncing}
            className="flex items-center gap-1.5 rounded-full bg-[#0D3B7A] px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
          >
            {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {syncing ? 'Đang đồng bộ...' : failed > 0 ? 'Thử lại' : 'Đồng bộ'}
          </button>
        </div>
      )}
    </div>
  );
}
