/**
 * Auto-save hook for the workboard builder.
 *
 * Watches a layout object and POSTs the latest version after a debounce
 * window so the iframe preview can refresh without the admin having to
 * click Save. Returns a status enum the UI uses to show the sync badge.
 *
 *   idle       — nothing pending, last save (if any) succeeded
 *   pending    — user is still typing; we're waiting for the quiet window
 *   saving     — request in flight
 *   saved      — last save succeeded; ``savedAt`` is set
 *   error      — last save failed; ``errorMessage`` is set
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { workboardApi } from '@/lib/api/workboards';
import type { MiniAppLayoutSpec } from './types';

export type AutosaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface UseAutosaveResult {
  status: AutosaveStatus;
  savedAt: Date | null;
  errorMessage: string | null;
  /** Force a save right now, bypassing the debounce window. */
  flush: () => Promise<void>;
}

const DEBOUNCE_MS = 1200;

export function useDebouncedAutosave(
  workboardId: number,
  layout: MiniAppLayoutSpec,
  enabled: boolean,
): UseAutosaveResult {
  const [status, setStatus] = useState<AutosaveStatus>('idle');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Latest layout snapshot we should save when the timer fires.
  const layoutRef = useRef<MiniAppLayoutSpec>(layout);
  layoutRef.current = layout;

  // Track whether the *first* render has happened so we don't fire a save
  // when the component just mounts with the existing server-side layout.
  const isInitialMount = useRef(true);

  // Holds the active debounce timer so we can cancel + restart on each edit.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const doSave = async () => {
    if (!enabled) return;
    setStatus('saving');
    setErrorMessage(null);
    try {
      await workboardApi.update(workboardId, {
        layout_json: layoutRef.current as any,
      });
      setStatus('saved');
      setSavedAt(new Date());
    } catch (err: any) {
      setStatus('error');
      setErrorMessage(err?.response?.data?.detail || 'Không lưu được.');
    }
  };

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    if (!enabled) return;
    setStatus('pending');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      // Coalesce concurrent saves into one in-flight Promise so quick
      // successive edits don't stack on the wire.
      inFlight.current = doSave().finally(() => {
        inFlight.current = null;
      });
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // We intentionally re-run on every layout change. enabled is stable
    // for a given builder instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, enabled]);

  const flush = async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await doSave();
  };

  return { status, savedAt, errorMessage, flush };
}
