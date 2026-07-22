'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  workboardApi,
  type WorkboardEditor,
  type WorkboardScreenLock,
} from '@/lib/api/workboards';

export type { WorkboardEditor, WorkboardScreenLock };

export interface WorkboardPresence {
  /** Other editors currently in this workboard's builder + which screen each is on. */
  editors: WorkboardEditor[];
  /** The caller's soft-lock state for the screen they currently have open
   * (null while on the canvas). `held_by_me=false` with a `holder_key` set
   * means someone else is editing this screen → the caller is view-only. */
  lock: WorkboardScreenLock | null;
  /** screen_id -> current lock holder, for badging canvas screen cards. */
  screenHolders: Record<string, { holder_key: string; holder_name: string | null }>;
  /** Force-claim the lock on a screen ("Chiếm quyền"). */
  takeover: (screenId: string) => Promise<void>;
}

/**
 * Editor presence + soft screen-lock for the Workboard builder.
 *
 * While `enabled` (the user can edit), heartbeats every 20s — and immediately
 * when the user opens a different screen — reporting `editingScreenId`. The
 * backend returns the other live editors, this user's lock state for the
 * current screen, and the per-screen holder map. Best-effort; the backend TTL
 * clears stale editors and lapses their locks.
 *
 * Mirrors `useDashboardPresence` but the cursor/lock unit is a SCREEN, and it
 * exposes a `takeover` action (a dashboard tile has no lock to seize).
 */
export function useWorkboardPresence(
  workboardId: number | null | undefined,
  enabled: boolean,
  editingScreenId: string | null,
): WorkboardPresence {
  const [editors, setEditors] = useState<WorkboardEditor[]>([]);
  const [lock, setLock] = useState<WorkboardScreenLock | null>(null);
  const [screenHolders, setScreenHolders] = useState<
    Record<string, { holder_key: string; holder_name: string | null }>
  >({});
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Hold the latest open screen so the interval beat always reports the current
  // value (the effect below closes over a stale `editingScreenId` otherwise).
  const screenRef = useRef<string | null>(editingScreenId);
  screenRef.current = editingScreenId;

  const beat = useCallback(async () => {
    if (!enabled || !workboardId) return;
    try {
      const res = await workboardApi.editingHeartbeat(workboardId, screenRef.current);
      setEditors(Array.isArray(res.editors) ? res.editors : []);
      setLock(res.lock ?? null);
      setScreenHolders(res.screen_holders ?? {});
    } catch {
      /* presence is best-effort */
    }
  }, [workboardId, enabled]);

  // Periodic heartbeat while enabled; best-effort leave on unmount.
  useEffect(() => {
    if (!enabled || !workboardId) {
      setEditors([]);
      setLock(null);
      setScreenHolders({});
      return;
    }
    void beat();
    timerRef.current = setInterval(() => void beat(), 20_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      workboardApi.editingLeave(workboardId).catch(() => {});
    };
  }, [workboardId, enabled, beat]);

  // Beat immediately when the user opens a different screen, so the lock is
  // claimed/handed-off snappily instead of waiting up to 20s.
  useEffect(() => {
    if (enabled && workboardId) void beat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingScreenId]);

  const takeover = useCallback(
    async (screenId: string) => {
      if (!workboardId) return;
      try {
        const res = await workboardApi.editingTakeover(workboardId, screenId);
        setLock(res.lock ?? null);
        // Refresh presence/holders promptly after seizing the lock.
        void beat();
      } catch {
        /* best-effort */
      }
    },
    [workboardId, beat],
  );

  return { editors, lock, screenHolders, takeover };
}
