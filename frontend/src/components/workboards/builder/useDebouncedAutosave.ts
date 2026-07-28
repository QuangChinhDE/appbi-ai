/**
 * Auto-save hook for the workboard builder.
 *
 * Watches a layout object and persists the DRAFT after a debounce window so the
 * iframe preview refreshes without the admin clicking Save. Returns a status
 * enum the UI shows as the sync badge.
 *
 *   idle       — nothing pending, last save (if any) succeeded
 *   pending    — user is still typing; we're waiting for the quiet window
 *   saving     — request in flight
 *   saved      — last save succeeded; ``savedAt`` is set
 *   error      — last save failed; ``errorMessage`` is set
 *
 * TWO SAVE PATHS (co-edit safety, Slice 2):
 *   • SCREEN-scoped — a screen-CONTENT edit persists via
 *     PATCH /workboards/{id}/screens/{screenId}, which merges that ONE screen
 *     into the server's current layout. No board-version guard, so two people
 *     editing DIFFERENT screens never 409 or clobber each other.
 *   • WHOLE-BOARD — a structural/app edit (add/delete/reorder screens, nav,
 *     groups, dataset, branding) persists via PATCH /workboards/{id} with the
 *     board-version guard (structural conflicts are genuine).
 * The builder classifies each edit by setting `dirtyTracking` refs; this hook
 * reads them at save time. When no tracking is supplied it defaults to
 * whole-board (legacy behaviour).
 *
 * Concurrency contract (single-flight queue): AT MOST ONE save chain is ever in
 * flight. Each drain re-captures the LATEST snapshot, and a new drain never
 * begins until the previous resolves — a slow older request can't land after
 * (and clobber) a newer edit. Edits mid-save are coalesced.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { workboardApi, type Workboard, type WorkboardLayoutJson } from '@/lib/api/workboards';
import type { MiniAppLayoutSpec } from './types';
import { useI18n } from '@/providers/LanguageProvider';

export type AutosaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface UseAutosaveResult {
  status: AutosaveStatus;
  savedAt: Date | null;
  errorMessage: string | null;
  /** Persist the latest draft right now (e.g. before Publish), bypassing the
   * debounce and awaiting until fully flushed. Forces a WHOLE-BOARD save so the
   * publish snapshot captures the entire layout. No-op when disabled. */
  flush: () => Promise<void>;
}

/** The builder sets these so the hook knows how to persist each pending edit. */
export interface AutosaveDirtyTracking {
  /** A structural/app-level edit happened → the next save is whole-board. */
  structuralRef: MutableRefObject<boolean>;
  /** Screen ids whose CONTENT changed → each persists screen-scoped. */
  screenIdsRef: MutableRefObject<Set<string>>;
}

const DEBOUNCE_MS = 1200;

function getErrorMessage(error: unknown, fallback: string): string {
  const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  // FastAPI/Pydantic 422 returns a list of {loc, msg, type, ...} entries.
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
  dirtyTracking?: AutosaveDirtyTracking,
): UseAutosaveResult {
  const { t } = useI18n();
  const [status, setStatus] = useState<AutosaveStatus>('idle');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const qc = useQueryClient();

  // Latest layout snapshot to persist. Updated every render.
  const layoutRef = useRef<MiniAppLayoutSpec>(layout);
  layoutRef.current = layout;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const trackingRef = useRef<AutosaveDirtyTracking | undefined>(dirtyTracking);
  trackingRef.current = dirtyTracking;

  // Don't fire a save on mount (the layout arrived from the server unchanged).
  const isInitialMount = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dirtyRef = useRef(false);
  const runningRef = useRef<Promise<void> | null>(null);
  const erroredRef = useRef(false);

  // Merge ONLY the lifecycle fields of a save response into the workboard cache
  // so the topbar publish pill flips to "unpublished changes" AND both save
  // paths keep the cached board `version` fresh (so a later whole-board save's
  // expected_version isn't stale). We deliberately do NOT overwrite the cached
  // layout_json — the builder owns the working draft copy.
  const mergeLifecycle = useCallback(
    (updated: Workboard) => {
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
    },
    [qc, workboardId],
  );

  // Drain the dirty draft to the server, one chain at a time, until clean.
  const saveLoop = useCallback((): Promise<void> => {
    if (runningRef.current) return runningRef.current;
    if (!enabledRef.current || !dirtyRef.current) return Promise.resolve();
    const loop = (async () => {
      while (dirtyRef.current && enabledRef.current) {
        dirtyRef.current = false; // consume; capture the latest snapshot now
        const snapshot = layoutRef.current;
        const tracking = trackingRef.current;
        // Classify what to persist, consuming the dirty markers now.
        const structural = tracking ? tracking.structuralRef.current : true;
        const screenIds = tracking ? Array.from(tracking.screenIdsRef.current) : [];
        if (tracking) {
          tracking.structuralRef.current = false;
          tracking.screenIdsRef.current.clear();
        }
        setStatus('saving');
        setErrorMessage(null);
        try {
          if (structural || screenIds.length === 0) {
            // Whole-board save with the optimistic board-version guard.
            const known = qc.getQueryData<Workboard>(['workboards', workboardId])?.version;
            const updated = await workboardApi.update(workboardId, {
              layout_json: snapshot as unknown as Partial<WorkboardLayoutJson>,
              ...(typeof known === 'number' ? { expected_version: known } : {}),
            });
            mergeLifecycle(updated);
          } else {
            // Screen-scoped saves — one PATCH per changed screen. No board
            // version guard, so editors on different screens never conflict.
            let last: Workboard | undefined;
            for (const sid of screenIds) {
              const screen = snapshot.screens.find((s) => s.id === sid);
              if (!screen) continue; // deleted since — a structural save covers it
              last = await workboardApi.updateScreen(
                workboardId,
                sid,
                screen as unknown as Record<string, unknown>,
              );
            }
            if (last) mergeLifecycle(last);
          }
          erroredRef.current = false;
          setSavedAt(new Date());
        } catch (err: unknown) {
          erroredRef.current = true;
          const httpStatus = (err as { response?: { status?: number } })?.response?.status;
          if (httpStatus === 409) {
            // Stale whole-board (structural) save: a concurrent tab/session
            // advanced the board. Don't clobber — surface + refetch.
            setErrorMessage(t('workboards.autosave.conflict'));
            void qc.invalidateQueries({ queryKey: ['workboards', workboardId] });
          } else {
            setErrorMessage(getErrorMessage(err, t('workboards.autosave.saveFailed')));
          }
          // Re-mark the pending edits so the next edit/flush retries them
          // instead of dropping the un-persisted change.
          if (trackingRef.current) {
            if (structural || screenIds.length === 0) {
              trackingRef.current.structuralRef.current = true;
            } else {
              screenIds.forEach((sid) => trackingRef.current!.screenIdsRef.current.add(sid));
            }
          }
          setStatus('error');
          break; // don't hammer a failing endpoint
        }
      }
      if (!erroredRef.current) setStatus(dirtyRef.current ? 'pending' : 'saved');
    })();
    runningRef.current = loop.finally(() => {
      runningRef.current = null;
    });
    return runningRef.current;
  }, [workboardId, qc, mergeLifecycle, t]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, enabled]);

  const flush = useCallback(async () => {
    if (!enabledRef.current) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // Force a whole-board save so the pre-Publish snapshot captures the entire
    // layout (not just the last screen-scoped edit).
    if (trackingRef.current) trackingRef.current.structuralRef.current = true;
    dirtyRef.current = true;
    await saveLoop();
  }, [saveLoop]);

  return { status, savedAt, errorMessage, flush };
}
