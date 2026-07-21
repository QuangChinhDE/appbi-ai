'use client';

/**
 * Persistent, server-driven sync-progress popup for the Dataset page.
 *
 * Server-driven (reads publish-status directly, not a per-session flag) so it
 * AUTO-REOPENS after a tab reload while a sync runs. Two states:
 *   - COMPACT (default): a small bar showing the OVERALL % of total rows (from
 *     the previous sync's row counts — no extra COUNT/scan). Only the % + bar
 *     move, so it never "jumps" during a heavy load. Click to expand.
 *   - EXPANDED: per-table progress (which table + its %), the edit-lock note,
 *     a minimize (—) back to compact, and the Stop control (Stop lives only here).
 * Stop cancels the sync; the previous COMPLETE snapshot keeps serving (reports
 * never break). Scoped to the Dataset page (mounted there, position:fixed).
 */

import { useEffect, useRef, useState } from 'react';
import {
  Loader2, X, Check, StopCircle, CheckCircle2, AlertTriangle, Minus, Database, ChevronUp,
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

  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Terminal card only if we saw this run active in-session (so a stale 'done'
  // left in the server dict never auto-pops after a fresh reload).
  const sawActiveRef = useRef(false);
  const [showTerminal, setShowTerminal] = useState(false);
  useEffect(() => {
    if (isActive) { sawActiveRef.current = true; setShowTerminal(false); }
    else if (isTerminal && sawActiveRef.current) { setShowTerminal(true); }
  }, [isActive, isTerminal]);

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

  // ── overall % of total rows (denominator = Σ previous-sync row counts) ──
  // Numerator + denominator MUST cover the same tables, else a table with rows
  // but no estimate (e.g. the generated calendar) inflates the % past 100. So
  // only tables that HAVE an estimate count toward the row-%; if none do (first
  // sync), fall back to tables-done / tables-total.
  const tables = progress?.tables ?? [];
  const built = progress?.built ?? 0;
  const total = progress?.total ?? 0;
  const estTables = tables.filter((tb) => tb.rows_total_est != null && tb.rows_total_est > 0);
  const totalEst = estTables.reduce((s, tb) => s + (tb.rows_total_est as number), 0);
  const rowsDoneEst = estTables.reduce((s, tb) => s + (tb.rows_done || 0), 0);
  const rawPct = totalEst > 0
    ? Math.round((rowsDoneEst / totalEst) * 100)
    : (total > 0 ? Math.round((built / total) * 100) : 0);
  // Cap at 99 while still working (100 only at 'done'); floor a hair so the bar is visible.
  const pct = phase === 'done' ? 100 : Math.min(99, Math.max(0, rawPct));

  const title = phase === 'stopping' ? t('datasets.sync.phaseStopping')
    : phase === 'validating' ? t('datasets.sync.phaseValidating')
    : t('datasets.sync.progressTitle');

  // ── Terminal card (small) ──
  if (showTerminal) {
    return (
      <div className="fixed bottom-4 right-4 z-[60] w-72 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-3.5 shadow-xl">
        <div className="flex items-start gap-2.5">
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

  // ── COMPACT (default): small bar, overall % only — stable, no per-row jitter ──
  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        title={t('datasets.sync.progressTitle')}
        className="fixed bottom-4 right-4 z-[60] w-64 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-2.5 text-left shadow-lg transition-colors hover:bg-surface-2"
      >
        <div className="mb-1.5 flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-brand" />
          <span className="truncate text-caption font-emphasis text-text-primary">{title}</span>
          <span className="ml-auto shrink-0 text-caption tabular-nums text-text-secondary">{pct}%</span>
          <ChevronUp className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-surface-3">
          <div className="h-full rounded-full bg-brand transition-all duration-500"
            style={{ width: `${Math.max(3, pct)}%` }} />
        </div>
      </button>
    );
  }

  // ── EXPANDED: per-table detail + minimize + Stop ──
  const rowsCell = (tb: (typeof tables)[number]) => {
    const done = tb.rows_done.toLocaleString();
    if (tb.rows_total_est != null && tb.rows_total_est > 0) {
      const tp = tb.state === 'done' ? 100
        : Math.min(99, Math.round((tb.rows_done / tb.rows_total_est) * 100));
      return `${tp}% · ${done}`;
    }
    return tb.state === 'done' ? done : (tb.rows_done > 0 ? done : '');
  };

  return (
    <div className="fixed bottom-4 right-4 z-[60] w-96 max-w-[calc(100vw-2rem)] rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-xl">
      <div className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] px-4 py-3">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand" />
        <span className="text-small font-emphasis text-text-primary">{title}</span>
        <span className="ml-auto text-caption tabular-nums text-text-secondary">
          {pct}% · {t('datasets.sync.tablesProgress', { built: String(built), total: String(total) })}
        </span>
        <button onClick={() => setExpanded(false)} title={t('datasets.sync.hide')}
          className="ml-1 text-text-tertiary hover:text-text-primary">
          <Minus className="h-4 w-4" />
        </button>
      </div>

      <div className="px-4 py-3">
        <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
          <div className="h-full rounded-full bg-brand transition-all duration-500" style={{ width: `${Math.max(3, pct)}%` }} />
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
                  {(rowActive || tb.state === 'done') ? rowsCell(tb) : ''}
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
          <Button
            variant="secondary" size="xs"
            leadingIcon={<StopCircle className="h-3.5 w-3.5" />}
            disabled={phase === 'stopping' || stop.isPending}
            onClick={() => setConfirming(true)}
          >
            {phase === 'stopping' ? t('datasets.sync.phaseStopping') : t('datasets.sync.stop')}
          </Button>
        )}
      </div>
    </div>
  );
}
