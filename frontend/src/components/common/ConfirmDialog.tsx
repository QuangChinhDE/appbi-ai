'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Info, Send, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { extractApiError } from '@/lib/api-errors';
import { Button, IconButton } from '@/components/ui/Button';
import { useI18n } from '@/providers/LanguageProvider';

/**
 * What the action does — decides colour, initial focus and how the dialog may
 * be dismissed:
 *  - `danger`  destructive (delete, discard real work): red confirm; focus starts
 *              on Cancel so a stray Enter never deletes; no backdrop dismiss.
 *  - `warning` consequential, not destructive (unpublish, revoke, rotate, accept
 *              a baseline): amber icon, primary confirm.
 *  - `primary` a forward action (publish, sync & publish): Ocean Blue confirm.
 *  - `info`    neutral information/acknowledgement: neutral icon, no alarm;
 *              the only kind a backdrop click closes.
 */
export type ConfirmVariant = 'danger' | 'warning' | 'primary' | 'info';

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Return a Promise to let the dialog own the request: it stays open and busy
   * (no second submit, no dismiss) until it settles, closes on success, and on
   * failure STAYS OPEN with the error — a failed delete never looks like a
   * successful one. A void return keeps the legacy behaviour (close at once).
   */
  onConfirm: () => void | Promise<unknown>;
  title: string;
  description: React.ReactNode;
  /** Optional block under the description: the exact object, the impact. */
  details?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
  confirmDisabled?: boolean;
}

const TONE: Record<ConfirmVariant, { icon: React.ReactNode; box: string }> = {
  danger: { icon: <AlertTriangle className="h-4 w-4" />, box: 'text-danger bg-danger-bg' },
  warning: { icon: <AlertTriangle className="h-4 w-4" />, box: 'text-warning bg-warning-bg' },
  primary: { icon: <Send className="h-4 w-4" />, box: 'text-brand-on-container bg-brand-container' },
  info: { icon: <Info className="h-4 w-4" />, box: 'text-text-secondary bg-surface-2' },
};

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  details,
  confirmLabel,
  cancelLabel,
  variant = 'danger',
  confirmDisabled,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();
  const errorId = useId();

  const dismiss = useCallback(() => {
    if (inFlight.current) return; // never abandon a request mid-flight
    onClose();
  }, [onClose]);

  // Open: remember who had focus, reset, focus the safe button. Close: give focus back.
  useEffect(() => {
    if (!isOpen) return;
    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    setError(null);
    setBusy(false);
    inFlight.current = false;
    const id = requestAnimationFrame(() => {
      (variant === 'danger' ? cancelRef.current : confirmRef.current)?.focus();
    });
    return () => {
      cancelAnimationFrame(id);
      restoreFocusTo.current?.focus?.();
    };
  }, [isOpen, variant]);

  // Escape dismisses (unless busy); Tab stays inside the dialog.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        dismiss();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input, select, textarea')];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [isOpen, dismiss]);

  if (!isOpen) return null;

  const handleConfirm = async () => {
    if (inFlight.current || confirmDisabled) return; // one confirmation = one request
    setError(null);
    let outcome: void | Promise<unknown>;
    try {
      outcome = onConfirm();
    } catch (err) {
      setError(extractApiError(err, t('common.confirmFailed')));
      return;
    }
    if (!outcome || typeof (outcome as Promise<unknown>).then !== 'function') {
      onClose();
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      await outcome;
      inFlight.current = false;
      onClose();
    } catch (err) {
      inFlight.current = false;
      setBusy(false);
      setError(extractApiError(err, t('common.confirmFailed')));
      requestAnimationFrame(() => confirmRef.current?.focus());
    }
  };

  const tone = TONE[variant];
  const confirmVariant = variant === 'danger' ? 'danger' : 'primary';

  return (
    <div
      className="app-chrome fixed inset-0 z-50 flex items-center justify-center bg-overlay/84 backdrop-blur-[3px] animate-fade-in"
      onMouseDown={(e) => { if (e.target === e.currentTarget && variant === 'info') dismiss(); }}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={error ? `${descId} ${errorId}` : descId}
        data-testid="confirm-dialog"
        data-variant={variant}
        className="relative mx-4 w-full max-w-md rounded-xl border border-stroke-strong bg-surface-1 shadow-linear-lg animate-slide-up"
      >
        <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
          <div className="flex items-start gap-3">
            <div className={cn('flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg', tone.box)} aria-hidden>
              {tone.icon}
            </div>
            <h3 id={titleId} className="pt-1 text-small font-strong text-text-primary">{title}</h3>
          </div>
          <IconButton aria-label={t('common.close')} variant="ghost" size="sm" onClick={dismiss} disabled={busy}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>

        <div className="space-y-3 px-5 pb-5 pl-16">
          <div id={descId} className="text-caption text-text-secondary">{description}</div>
          {details ? (
            <div className="rounded-md border border-stroke-line bg-surface-2 px-3 py-2 text-caption text-text-primary">{details}</div>
          ) : null}
          {error ? (
            <p id={errorId} role="alert" data-testid="confirm-dialog-error" className="rounded-md border border-danger/25 bg-danger-bg px-3 py-2 text-caption text-danger">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 rounded-b-xl border-t border-stroke-line bg-surface-2 px-5 py-3">
          <Button ref={cancelRef} variant="secondary" size="sm" onClick={dismiss} disabled={busy} data-testid="confirm-dialog-cancel">
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button
            ref={confirmRef}
            variant={confirmVariant}
            size="sm"
            onClick={() => void handleConfirm()}
            loading={busy}
            disabled={confirmDisabled}
            data-testid="confirm-dialog-confirm"
          >
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The exact objects an action applies to — named, so a delete is never blind. */
export function ConfirmTargets({ names, max = 5 }: { names: string[]; max?: number }) {
  const { t } = useI18n();
  if (names.length === 0) return null;
  const shown = names.slice(0, max);
  return (
    <ul className="space-y-0.5" data-testid="confirm-dialog-targets">
      {shown.map((n, i) => (
        <li key={`${n}-${i}`} className="truncate font-emphasis">{n}</li>
      ))}
      {names.length > max ? (
        <li className="text-text-tertiary">{t('common.confirmTargets.more', { count: names.length - max })}</li>
      ) : null}
    </ul>
  );
}
