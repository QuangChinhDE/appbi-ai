'use client';

/**
 * Refresh history — the outcome log of every Sync & Publish / scheduled refresh
 * for a dataset. The DA opens it to see WHICH runs succeeded / failed, when,
 * how long they took, which generation they produced, and — on failure — WHY.
 * Reads GET /datasets/{id}/refresh-runs (newest first); polls while a run is
 * in flight so a "running" row settles live.
 */
import { useState } from 'react';
import { CheckCircle2, XCircle, Loader2, Ban, History, ChevronDown, ChevronRight } from 'lucide-react';

import { AppModalShell } from '@/components/common/AppModalShell';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { useI18n } from '@/providers/LanguageProvider';
import { useDatasetRefreshRuns, type DatasetRefreshRun } from '@/hooks/use-datasets';

function statusMeta(status: DatasetRefreshRun['status']): {
  variant: BadgeProps['variant'];
  Icon: typeof CheckCircle2;
  key: string;
} {
  switch (status) {
    case 'success':
      return { variant: 'success', Icon: CheckCircle2, key: 'datasets.refreshHistory.statusSuccess' };
    case 'failed':
      return { variant: 'danger', Icon: XCircle, key: 'datasets.refreshHistory.statusFailed' };
    case 'stopped':
      return { variant: 'warning', Icon: Ban, key: 'datasets.refreshHistory.statusStopped' };
    default:
      return { variant: 'info', Icon: Loader2, key: 'datasets.refreshHistory.statusRunning' };
  }
}

function fmtWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString([], {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtDuration(ms: number | null): string {
  if (ms == null || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function RunRow({ run }: { run: DatasetRefreshRun }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const meta = statusMeta(run.status);
  const canExpand = run.status === 'failed' && !!run.error;
  const triggerLabel = run.trigger === 'scheduled'
    ? t('datasets.refreshHistory.triggerScheduled')
    : run.trigger === 'source_change'
      ? t('datasets.refreshHistory.triggerSourceChange')
      : t('datasets.refreshHistory.triggerManual');

  return (
    <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1">
      <button
        type="button"
        disabled={!canExpand}
        onClick={() => canExpand && setOpen((v) => !v)}
        className={`flex w-full items-center gap-3 px-3 py-2.5 text-left ${canExpand ? 'cursor-pointer hover:bg-surface-2' : 'cursor-default'}`}
      >
        <Badge variant={meta.variant} size="sm">
          <meta.Icon className={`mr-1 h-3 w-3 ${run.status === 'running' ? 'animate-spin' : ''}`} />
          {t(meta.key)}
        </Badge>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-text-primary">{fmtWhen(run.started_at || run.created_at)}</span>
          <span className="block truncate text-tiny text-text-quaternary">
            {triggerLabel}
            {run.duration_ms != null && ` · ${fmtDuration(run.duration_ms)}`}
            {run.tables_built != null && ` · ${t('datasets.refreshHistory.tablesN', { count: run.tables_built })}`}
            {run.rows_total != null && ` · ${run.rows_total.toLocaleString()} ${t('datasets.refreshHistory.rows')}`}
          </span>
        </span>
        {canExpand && (
          open ? <ChevronDown className="h-4 w-4 shrink-0 text-text-quaternary" />
               : <ChevronRight className="h-4 w-4 shrink-0 text-text-quaternary" />
        )}
      </button>
      {canExpand && open && (
        <div className="border-t border-[rgb(var(--border-line))] px-3 py-2">
          <span className="mb-1 block text-tiny font-emphasis uppercase tracking-wide text-danger">
            {t('datasets.refreshHistory.errorLabel')}
          </span>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-2 text-tiny text-text-secondary">
            {run.error}
          </pre>
        </div>
      )}
    </div>
  );
}

export function RefreshHistoryModal({ datasetId, onClose }: { datasetId: number; onClose: () => void }) {
  const { t } = useI18n();
  const { data: runs, isLoading } = useDatasetRefreshRuns(datasetId);

  return (
    <AppModalShell
      onClose={onClose}
      title={t('datasets.refreshHistory.title')}
      description={t('datasets.refreshHistory.description')}
      icon={<History className="h-4 w-4" />}
      maxWidthClass="max-w-lg"
      bodyClassName="space-y-2 px-5 py-4"
    >
      {isLoading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-text-tertiary">
          <Loader2 className="h-4 w-4 animate-spin" /> {t('common.loading')}
        </div>
      ) : !runs || runs.length === 0 ? (
        <div className="py-10 text-center text-sm text-text-tertiary">
          {t('datasets.refreshHistory.empty')}
        </div>
      ) : (
        runs.map((run) => <RunRow key={run.id} run={run} />)
      )}
    </AppModalShell>
  );
}
