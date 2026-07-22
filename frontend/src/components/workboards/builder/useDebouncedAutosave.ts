/**
 * Auto-save hook for the workboard builder.
 *
 * Watches a layout object and PATCHes the latest DRAFT (workboard.layout_json)
 * after a debounce window so the iframe preview can refresh without the admin
 * clicking Save. Returns a status enum the UI shows as the sync badge.
 *
 *   idle       — nothing pending, last save (if any) succeeded
 *   pending    — user is still typing; we're waiting for the quiet window
 *   saving     — request in flight
 *   saved      — last save succeeded; ``savedAt`` is set
 *   error      — last save failed; ``errorMessage`` is set
 *
 * Concurrency contract (single-flight queue): AT MOST ONE save request is ever
 * in flight. Each save re-captures the LATEST snapshot at the moment it starts,
 * and a new save never begins until the previous one resolves — so a slow older
 * request can never land after (and clobber) a newer edit. Edits that arrive
 * mid-save are coalesced: the loop simply runs one more iteration with the new
 * latest snapshot. (This is the client-side guard; a backend optimistic-lock /
 * 409 for cross-tab/multi-user races is a separate, later hardening.)
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { workboardApi, type Workboard, type WorkboardLayoutJson } from '@/lib/api/workboards';
import type { MiniAppLayoutSpec } from './types';

export type AutosaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface UseAutosaveResult {
  status: AutosaveStatus;
  savedAt: Date | null;
  errorMessage: string | null;
  /** Persist the latest draft right now (e.g. before Publish), bypassing the
   * debounce and awaiting until the draft is fully flushed. No-op when disabled. */
  flush: () => Promise<void>;
}

const DEBOUNCE_MS = 1200;

function getErrorMessage(error: unknown, fallback: string): string {
  const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  // FastAPI/Pydantic 422 returns a list of {loc, msg, type, ...} entries.
  // Surface the first 1-2 so the builder badge tooltip is actually useful
  // instead of the generic fallback.
  if (Array.isArray(detail)) {
    const parts = detail.slice(0, 2).map((entry) => {
      const loc = Array.isArray((entry as { loc?: unknown }).loc)
        ? ((entry as { loc: unknown[] }).loc as unknown[])
            .filter((segment) => typeof segment === 'string' || typeof segment === 'number')
            .join('.')
        : '';
      const msg = (entry as { msg?: unknown }).msg;
      return loc && typeof msg === 'string' ? `${loc}: ${msg}` : typeof msg === 'string' ? msg : '';
    }).filter(Boolean);
    if (parts.length) return parts.join('; ');
  }
  return fallback;
}

export function useDebouncedAutosave(
  workboardId: number,
  layout: MiniAppLayoutSpec,
  enabled: boolean,
): UseAutosaveResult {
  const [status, setStatus] = useState<AutosaveStatus>('idle');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const qc = useQueryClient();

  // Latest layout snapshot to persist. Updated every render.
  const layoutRef = useRef<MiniAppLayoutSpec>(layout);
  layoutRef.current = layout;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // Don't fire a save on mount (the layout arrived from the server unchanged).
  const isInitialMount = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Single-flight state:
  //   dirtyRef   — layoutRef holds changes not yet persisted by a *completed* save
  //   runningRef — the active save loop promise (null when idle)
  //   erroredRef — last save attempt failed (stop looping; wait for next edit)
  const dirtyRef = useRef(false);
  const runningRef = useRef<Promise<void> | null>(null);
  const erroredRef = useRef(false);

  // Drain the dirty draft to the server, one request at a time, until clean.
  // Re-entrant-safe: if a loop is already running it is reused, guaranteeing a
  // single in-flight request. Each iteration re-reads layoutRef so the newest
  // snapshot always wins.
  const saveLoop = useCallback((): Promise<void> => {
    if (runningRef.current) return runningRef.current;
    if (!enabledRef.current || !dirtyRef.current) return Promise.resolve();
    const loop = (async () => {
      while (dirtyRef.current && enabledRef.current) {
        dirtyRef.current = false; // consume; capture the latest snapshot now
        const snapshot = layoutRef.current;
        setStatus('saving');
        setErrorMessage(null);
        try {
          const updated = await workboardApi.update(workboardId, {
            layout_json: snapshot as unknown as Partial<WorkboardLayoutJson>,
          });
          erroredRef.current = false;
          setSavedAt(new Date());
          // Refresh ONLY the lifecycle fields in the workboard cache so the
          // topbar publish pill flips to "unpublished changes" right after an
          // edit. We deliberately do NOT overwrite the cached layout_json — the
          // builder owns the working draft copy, and clobbering it here could
          // fight the local editing state.
          qc.setQueryData<Workboard>(['workboards', workboardId], (old) =>
            old
              ? {
                  ...old,
                  version: updated.version,
                  published_version: updated.published_version,
                  publish_status: updated.publish_status,
                  updated_at: updated.updated_at,
                }
              : old,
          );
        } catch (err: unknown) {
          erroredRef.current = true;
          setErrorMessage(getErrorMessage(err, 'Could not save.'));
          setStatus('error');
          // Stop looping on error — the un-persisted change is still in
          // layoutRef and will re-dirty on the next edit/flush; we don't hammer
          // a failing endpoint in a tight loop.
          break;
        }
      }
      if (!erroredRef.current) setStatus(dirtyRef.current ? 'pending' : 'saved');
    })();
    runningRef.current = loop.finally(() => {
      runningRef.current = null;
    });
    return runningRef.current;
  }, [workboardId, qc]);

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    if (!enabled) return; // view-only: never autosave
    dirtyRef.current = true;
    setStatus('pending');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      void saveLoop();
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // Re-run on every layout change. enabled/saveLoop are stable per instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, enabled]);

  const flush = useCallback(async () => {
    if (!enabledRef.current) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // Force-persist the latest draft (used before Publish so the promotion
    // snapshots exactly what the builder shows). Awaits until fully drained.
    dirtyRef.current = true;
    await saveLoop();
  }, [saveLoop]);

  return { status, savedAt, errorMessage, flush };
}
