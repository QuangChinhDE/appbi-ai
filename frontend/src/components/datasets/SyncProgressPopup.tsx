'use client';

/**
 * Persistent, server-driven sync-progress popup for the Dataset page.
 *
 * Unlike the old in-modal waiting view (gated on a per-session `started` flag),
 * this reads publish-status directly, so it AUTO-REOPENS after a tab reload while
 * a sync is still running. Shows per-table progress (rows done / ≈ estimate),
 * and offers:
 *   - Hide  → minimize to a pill; the sync keeps running in the background.
 *   - Stop  → cancel; the previous COMPLETE snapshot keeps serving (correct
 *             last-complete numbers), so reports never break.
 * Scoped to the Dataset page only (mounted there, position:fixed).
 */

import { useEffect, useRef, useState } from 'react';
import {
  Loader2, X, Check, StopCircle, ChevronUp, CheckCircle2,
  AlertTriangle, Minus, Database,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import {
  useDatasetPublishStatus,
  useStopSync,
  type DatasetSyncPhase,
} from '@/hooks/use-datasets';

const ACTIVE_PHASES: DatasetSyncPhase[] = ['syncing', 'validating', 'publishing', 'stopping'];

export function SyncProgressPopup({ datasetId }: { datasetId: number }) {
  const { t } = useI18n();
  const { data: status } = useDatasetPublishStatus(datasetId);
  const stop = useStopSync();

  const progress = status?.progress ?? null;
  const phase = progress?.phase;
  const isActive = !!status?.syncing || (phase ? ACTIVE_PHASES.includes(phase) : false);
  const isTerminal = phase === 'done' || phase === 'stopped' || phase === 'failed';

  // Hide state keyed by the run's started_at — persisted so a reload keeps THIS
  // run minimized, but a NEW run (different started_at) pops back up.
  const hideKey = `syncpopup-hidden-${datasetId}`;
  const [hiddenRun, setHiddenRun] = useState<string | null>(null);
  useEffect(() => {
    try { setHiddenRun(localStorage.getItem(hideKey)); } catch { /* ignore */ }
  }, [hideKey]);
  const runId = progress?.started_at != null ? String(progress.started_at) : null;
  const isHidden = isActive && !!runId && hiddenRun === runId;

  const hide = () => {
    if (!runId) return;
    setHiddenRun(runId);
    try { localStorage.setItem(hideKey, runId); } catch { /* ignore */ }
  };
  const unhide = () => {
    setHiddenRun(null);
    try { localStorage.removeItem(hideKey); } catch { /* ignore */ }
  };

  // Terminal card: show only if we actually saw this run active in-session, so a
  // stale 'done' left in the server dict never auto-pops after a fresh reload.
  const sawActiveRef = useRef(false);
  const [showTerminal, setShowTerminal] = useState(false);
  useEffect(() => {
    if (isActive) { sawActiveRef.current = true; setShowTerminal(false); }
    else if (isTerminal && sawActiveRef.current) { setShowTerminal(true); }
  }, [isActive, isTerminal]);

  const [confirming, setConfirming] = useState(false);
  const doStop = async () => {
    try {
      await stop.mutateAsync(datasetId);
      setConfirming(false);
    } catch (e: any) {
      toast.error(t('datasets.sync.stopToastFailed'), {
        description: e?.response?.data?.detail ?? e?.message,
      });
    }
  };

  if (!isActive && !showTerminal) return null;

  // ── Minimized pill ──
  if (isActive && isHidden) {
    const built = progress?.built ?? 0;
    const total = progress?.total ?? 0;
    return (
      <button
        onClick={unhide}
        className="fixed bottom-4 right-4 z-[60] inline-flex items-center gap-2 rounded-full border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-caption shadow-lg hover:bg-surface-2"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin text-brand" />
        {phase === 'stopping'
          ? t('datasets.sync.pillStopping')
          : t('datasets.sync.pill', { built: String(built), total: String(total) })}
        <ChevronUp className="h-3.5 w-3.5 text-text-tertiary" />
      </button>
    );
  }

  // ── Terminal card ──
  if (showTerminal) {
    return (
      <div className="fixed bottom-4 right-4 z-[60] w-80 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4 shadow-xl">
        <div className="flex items-start gap-3">
          {phase === 'done' ? <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
            : phase === 'stopped' ? <StopCircle className="h-5 w-5 shrink-0 text-text-tertiary" />
            : <AlertTriangle className="h-5 w-5 shrink-0 text-danger" />}
          <div className="min-w-0 flex-1">
            <div className="text-small font-emphasis text-text-primary">
              {phase === 'done' ? t('datasets.sync.doneTitle')
                : phase === 'stopped' ? t('datasets.sync.phaseStopped')
                : t('datasets.sync.failedTitle')}
            </div>
            {phase === 'stopped' && (
              <div className="mt-0.5 text-caption text-text-tertiary">{t('datasets.sync.stoppedNote')}</div>
            )}
            {phase === 'failed' && status?.last_sync_error && (
              <div className="mt-0.5 text-caption text-danger">{status.last_sync_error}</div>
            )}
          </div>
          <button onClick={() => setShowTerminal(false)} className="text-text-tertiary hover:text-text-primary">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  // ── Full active card ──
  const tables = progress?.tables ?? [];
  const built = progress?.built ?? 0;
  const total = progress?.total ?? 0;
  const pct = total > 0 ? Math.round((built / total) * 100) : 8;
  const phaseLabel = phase === 'validating' ? t('datasets.sync.phaseValidating')
    : phase === 'stopping' ? t('datasets.sync.phaseStopping')
    : t('datasets.sync.phaseSyncing');

  const rowsLabel = (tb: (typeof tables)[number]) =>
    tb.rows_total_est != null
      ? t('datasets.sync.rowsOf', { done: tb.rows_done.toLocaleString(), est: tb.rows_total_est.toLocaleString() })
      : t('datasets.sync.rowsDone', { done: tb.rows_done.toLocaleString() });

  return (
    <div className="fixed bottom-4 right-4 z-[60] w-96 max-w-[calc(100vw-2rem)] rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-xl">
      <div className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] px-4 py-3">
        <Loader2 className="h-4 w-4 animate-spin text-brand" />
        <span className="text-small font-emphasis text-text-primary">{t('datasets.sync.progressTitle')}</span>
        <span className="ml-auto text-caption text-text-tertiary">
          {t('datasets.sync.tablesProgress', { built: String(built), total: String(total) })}
        </span>
        <button onClick={hide} title={t('datasets.sync.hide')} className="ml-1 text-text-tertiary hover:text-text-primary">
          <Minus className="h-4 w-4" />
        </button>
      </div>

      <div className="px-4 py-3">
        <div className="mb-2 text-caption text-text-secondary">{phaseLabel}</div>
        <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
          <div className="h-full rounded-full bg-brand transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
        <div className="max-h-52 space-y-1 overflow-y-auto">
          {tables.map((tb) => {
            const rowActive = tb.state === 'active';
            return (
              <div key={String(tb.table_id ?? tb.name)} className="flex items-center gap-2 text-caption">
                {tb.state === 'done' ? <Check className="h-3.5 w-3.5 shrink-0 text-success" />
                  : tb.state === 'skipped' ? <Minus className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                  : rowActive ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-brand" />
                  : <Database className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />}
                <span className={`truncate ${rowActive ? 'font-emphasis text-text-primary' : 'text-text-secondary'}`}>
                  {tb.name}
                </span>
                <span className="ml-auto shrink-0 tabular-nums text-text-tertiary">
                  {(rowActive || tb.state === 'done') ? rowsLabel(tb) : ''}
                </span>
              </div>
            );
          })}
        </div>
        <div className="mt-3 text-tiny text-text-quaternary">{t('datasets.sync.lockEditNote')}</div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-[rgb(var(--border-line))] px-4 py-2.5">
        {confirming ? (
          <>
            <span className="mr-auto text-tiny text-text-secondary">{t('datasets.sync.stopConfirm')}</span>
            <Button variant="secondary" size="xs" onClick={() => setConfirming(false)}>
              {t('datasets.sync.stopConfirmNo')}
            </Button>
            <Button variant="danger" size="xs" disabled={stop.isPending} onClick={doStop}>
              {t('datasets.sync.stopConfirmYes')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="xs" onClick={hide}>{t('datasets.sync.hide')}</Button>
            <Button
              variant="secondary" size="xs"
              leadingIcon={<StopCircle className="h-3.5 w-3.5" />}
              disabled={phase === 'stopping' || stop.isPending}
              onClick={() => setConfirming(true)}
            >
              {phase === 'stopping' ? t('datasets.sync.phaseStopping') : t('datasets.sync.stop')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
