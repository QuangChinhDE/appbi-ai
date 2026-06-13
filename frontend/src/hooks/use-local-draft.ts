'use client';

/**
 * useLocalDraft — generic client-side draft autosave backed by localStorage.
 *
 * Purpose: keep work-in-progress for a form/editor from being lost on
 * refresh, tab-close, or in-app navigation, WITHOUT persisting anything to
 * the backend. The caller owns the editable `value` and tells the hook
 * whether it currently diverges from the saved baseline (`isDirty`). The hook
 * debounce-writes the dirty value to `localStorage[key]`, surfaces any draft
 * it finds for the current `key` as `pendingDraft` (so the caller can show a
 * "restore?" banner — restore is never automatic), and flushes the current
 * value to the OLD key when `key` changes (so switching contexts within the
 * debounce window doesn't drop the last edits).
 *
 * Design notes (matches ModelViewEditPanel's measure-config flow):
 *   - The hook is deliberately dumb about "is this draft meaningful". A draft
 *     equal to the saved baseline is still written/read; the CALLER compares
 *     `pendingDraft.data` to its own baseline and calls `discard()` for a
 *     spurious match. This keeps the hook free of any baseline knowledge and
 *     robust against transient renders where the caller's `value` lags a
 *     context switch.
 *   - Restore is explicit (banner → `restore()`), never auto-applied: a draft
 *     may be stale if the saved record changed elsewhere, so the user decides.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface LocalDraft<T> {
  data: T;
  savedAt: number;
}

interface UseLocalDraftOptions<T> {
  /** localStorage key. When null, the hook is inert (no read/write). */
  key: string | null;
  /** Current editable value to persist. Memoize in the caller so the
   *  autosave effect doesn't re-run on every unrelated render. */
  value: T;
  /** Whether `value` diverges from the saved/baseline state. */
  isDirty: boolean;
  /** Master switch — when false, the hook never reads or writes. */
  enabled?: boolean;
  /** Debounce before writing a dirty value (ms). Default 800. */
  debounceMs?: number;
}

interface UseLocalDraftResult<T> {
  /** A draft found in storage for the current key, awaiting the caller's
   *  restore/discard decision. Null when none or after resolution. */
  pendingDraft: LocalDraft<T> | null;
  /** Read the pending draft's data and clear the pending flag. */
  restore: () => T | null;
  /** Remove the stored draft for the current key + clear the pending flag. */
  discard: () => void;
  /** Write the current value to the current key immediately (skip debounce). */
  flush: () => void;
}

function readDraft<T>(key: string): LocalDraft<T> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalDraft<T>;
    if (!parsed || typeof parsed.savedAt !== 'number' || !('data' in parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDraft<T>(key: string, data: T): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: LocalDraft<T> = { data, savedAt: Date.now() };
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    /* quota / serialization failure — drafts are best-effort, never block UX */
  }
}

function removeDraft(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function useLocalDraft<T>({
  key,
  value,
  isDirty,
  enabled = true,
  debounceMs = 800,
}: UseLocalDraftOptions<T>): UseLocalDraftResult<T> {
  const [pendingDraft, setPendingDraft] = useState<LocalDraft<T> | null>(null);

  // Live refs so flush()/cleanup read the freshest value/dirtiness without
  // re-binding the effects on every keystroke.
  const valueRef = useRef(value);
  valueRef.current = value;
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // ── Read draft for the active key; flush to the OLD key on key change. ──
  useEffect(() => {
    if (!enabled || !key) {
      setPendingDraft(null);
      return;
    }
    setPendingDraft(readDraft<T>(key));
    const activeKey = key; // captured → this is the OLD key in the cleanup
    return () => {
      // Persist the latest value to the key we're leaving so a fast context
      // switch (within the debounce window) doesn't drop unsaved edits.
      if (enabledRef.current && isDirtyRef.current) {
        writeDraft(activeKey, valueRef.current);
      }
    };
  }, [key, enabled]);

  // ── Debounced autosave for the active key. ──
  useEffect(() => {
    if (!enabled || !key) return;
    if (isDirty) {
      const timer = setTimeout(() => writeDraft(key, value), debounceMs);
      return () => clearTimeout(timer);
    }
    // Value matches the saved baseline → drop the draft, UNLESS one is still
    // awaiting the caller's restore/discard decision (don't kill the banner).
    if (!pendingDraft) removeDraft(key);
    return undefined;
  }, [key, value, isDirty, enabled, debounceMs, pendingDraft]);

  const restore = useCallback((): T | null => {
    if (!pendingDraft) return null;
    const data = pendingDraft.data;
    setPendingDraft(null);
    return data;
  }, [pendingDraft]);

  const discard = useCallback(() => {
    if (key) removeDraft(key);
    setPendingDraft(null);
  }, [key]);

  const flush = useCallback(() => {
    if (enabledRef.current && key && isDirtyRef.current) {
      writeDraft(key, valueRef.current);
    }
  }, [key]);

  return { pendingDraft, restore, discard, flush };
}
