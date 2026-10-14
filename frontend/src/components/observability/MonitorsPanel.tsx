'use client';

/**
 * Automatic checks — the freshness / volume / schema monitors of one dataset,
 * per table: what is checked, its latest result, and (for dataset editors) the
 * switch and settings to change it. Quality rules (column-level) stay in the
 * Data Quality panel below; both fold into the same incident feed.
 *
 * A check that never ran is "Not run yet", never a pass.
 */
import { useCallback, useEffect, useState } from 'react';
import { Clock, Rows3, Columns3, Loader2, Play, Settings2, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import { StatusPill, relativeTime, LoadErrorState } from './ui';
import {
  getMonitors, saveMonitor, deleteMonitor, scanDataset, loadErrorOf, apiErrorMessage,
  type LoadError, type Monitor, type MonitorKind, type MonitorSetup, type MonitorTable, type Severity,
} from '@/lib/observability';

const KINDS: { kind: MonitorKind; icon: typeof Clock }[] = [
  { kind: 'freshness', icon: Clock },
  { kind: 'volume', icon: Rows3 },
  { kind: 'schema', icon: Columns3 },
];

export function MonitorsPanel({ datasetId, onChanged }: { datasetId: number; onChanged?: () => void }) {
  const { t, locale } = useI18n();
  const [data, setData] = useState<MonitorSetup | null>(null);
  const [error, setError] = useState<LoadError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [editing, setEditing] = useState<{ table: MonitorTable; kind: MonitorKind; monitor?: Monitor } | null>(null);
  const [removing, setRemoving] = useState<Monitor | null>(null);

  const reload = useCallback(() => {
    setError(null);
    return getMonitors(datasetId).then(setData).catch((e) => { setData(null); setError(loadErrorOf(e)); });
  }, [datasetId]);
  useEffect(() => { reload(); }, [reload]);

  if (error) return <LoadErrorState error={error} onRetry={reload} compact testId="obs-monitors-error" />;
  if (!data) return <p className="py-6 text-center text-caption text-text-tertiary" role="status">{t('observability.loading')}</p>;

  const canConfigure = data.capabilities.configure;
  const monitorOf = (tableId: number, kind: MonitorKind) => data.monitors.find((m) => m.tableId === tableId && m.kind === kind);

  const save = async (table: MonitorTable, kind: MonitorKind, body: { config?: Record<string, any>; severity?: Severity; is_active?: boolean }) => {
    setBusy(`${table.tableId}:${kind}`);
    try {
      await saveMonitor(datasetId, { table_id: table.tableId, kind, ...body });
      toast.success(t(body.is_active === false ? 'observability.monitors.toast.paused' : 'observability.monitors.toast.saved'));
      await reload();
      onChanged?.();
      return true;
    } catch (e) {
      toast.error(apiErrorMessage(e) ?? t('observability.monitors.toast.saveFailed'));
      return false;
    } finally { setBusy(null); }
  };

  const enable = (table: MonitorTable, kind: MonitorKind) => {
    const m = monitorOf(table.tableId, kind);
    if (kind === 'freshness' && !m) { setEditing({ table, kind }); return; }   // needs a time column
    save(table, kind, { config: m?.config ?? {}, severity: m?.severity ?? 'warning', is_active: true });
  };

  const runNow = async () => {
    setScanning(true);
    try {
      const r = await scanDataset(datasetId);
      if (r.status === 'partial') toast.warning(t('observability.monitors.toast.scanPartial', { errors: r.errors.length }));
      else toast.success(t('observability.monitors.toast.scanDone', { breached: r.breached, incidents: r.new_incidents }));
      await reload();
      onChanged?.();
    } catch (e: any) {
      toast.error(e?.response?.status === 409 ? t('observability.toast.scanBusy') : (apiErrorMessage(e) ?? t('observability.toast.scanFailed')));
    } finally { setScanning(false); }
  };

  return (
    <section className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1" aria-labelledby="obs-auto-checks" data-testid="obs-monitors">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[rgb(var(--border-line))] px-4 py-3">
        <div>
          <h2 id="obs-auto-checks" className="text-small font-strong text-text-primary">{t('observability.monitors.title')}</h2>
          <p className="text-tiny text-text-tertiary">{t('observability.monitors.subtitle')}</p>
        </div>
        {data.capabilities.scan && (
          <Button size="sm" variant="secondary" disabled={scanning} onClick={runNow} data-testid="obs-run-checks"
            leadingIcon={scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}>
            {scanning ? t('observability.action.scanning') : t('observability.action.runChecks')}
          </Button>
        )}
      </div>
      {data.tables.length === 0 ? (
        <p className="px-4 py-6 text-center text-caption text-text-tertiary">{t('observability.monitors.noTables')}</p>
      ) : (
        <ul className="divide-y divide-[rgb(var(--border-line))]">
          {data.tables.map((table) => (
            <li key={table.tableId} className="px-4 py-3">
              <p className="mb-2 text-caption font-emphasis text-text-primary">{table.name}</p>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                {KINDS.map(({ kind, icon: Icon }) => {
                  const m = monitorOf(table.tableId, kind);
                  const supported = table.kinds.includes(kind);
                  const on = !!m?.isActive;
                  const key = `${table.tableId}:${kind}`;
                  return (
                    <div key={kind} data-testid={`obs-monitor-${table.tableId}-${kind}`} data-state={!supported ? 'unsupported' : on ? (m?.lastStatus ?? 'not_run') : 'off'}
                      className={cn('rounded-lg border border-[rgb(var(--border-line))] p-3', !on && 'bg-surface-2')}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 text-caption font-emphasis text-text-secondary">
                          <Icon className="h-3.5 w-3.5" aria-hidden />{t(`observability.pillar.${kind}`)}
                        </span>
                        {on ? (m?.lastStatus ? <StatusPill status={m.lastStatus} />
                          : <span className="rounded-full bg-surface-2 px-2 py-0.5 text-tiny text-text-tertiary">{t('observability.monitors.notRun')}</span>)
                          : <span className="text-tiny text-text-quaternary">{supported ? t('observability.monitors.off') : t('observability.monitors.unsupported')}</span>}
                      </div>
                      <p className="mt-1 min-h-[2rem] text-tiny text-text-tertiary">{describe(t, kind, m)}</p>
                      {on && m?.lastCheckedAt && (
                        <p className="text-tiny text-text-quaternary">{t('observability.monitors.checkedAt', { time: relativeTime(m.lastCheckedAt, t, locale) })}</p>
                      )}
                      {canConfigure && supported && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          {on ? (
                            <>
                              {kind !== 'schema' && (
                                <Button size="sm" variant="ghost" leadingIcon={<Settings2 className="h-3.5 w-3.5" />} onClick={() => setEditing({ table, kind, monitor: m })}>{t('observability.action.configure')}</Button>
                              )}
                              <Button size="sm" variant="ghost" disabled={busy === key} onClick={() => save(table, kind, { config: m!.config, severity: m!.severity, is_active: false })}>{t('observability.action.pause')}</Button>
                            </>
                          ) : (
                            <Button size="sm" variant="secondary" disabled={busy === key || (kind === 'freshness' && table.timeColumns.length === 0)}
                              title={kind === 'freshness' && table.timeColumns.length === 0 ? t('observability.monitors.noTimeColumn') : undefined}
                              onClick={() => enable(table, kind)}>{t('observability.action.enable')}</Button>
                          )}
                          {m && (
                            <button className="ml-auto rounded p-1 text-text-quaternary hover:text-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                              aria-label={t('observability.monitors.remove', { kind: t(`observability.pillar.${kind}`) })} onClick={() => setRemoving(m)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      )}
      {!canConfigure && <p className="border-t border-[rgb(var(--border-line))] px-4 py-2 text-tiny text-text-quaternary">{t('observability.monitors.readOnly')}</p>}

      {editing && (
        <MonitorEditor key={`${editing.table.tableId}:${editing.kind}`} {...editing}
          onCancel={() => setEditing(null)}
          onSave={async (config, severity) => { if (await save(editing.table, editing.kind, { config, severity, is_active: true })) setEditing(null); }} />
      )}
      <ConfirmDialog
        isOpen={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          try { await deleteMonitor(removing.id); toast.success(t('observability.monitors.toast.removed')); await reload(); onChanged?.(); }
          catch (e) { toast.error(apiErrorMessage(e) ?? t('observability.monitors.toast.saveFailed')); }
        }}
        title={t('observability.monitors.removeTitle')}
        description={t('observability.monitors.removeBody')}
        confirmLabel={t('observability.action.delete')}
      />
    </section>
  );
}

function describe(t: (k: string, v?: Record<string, any>) => string, kind: MonitorKind, m?: Monitor) {
  if (!m) return t(`observability.monitors.explain.${kind}`);
  const c = m.config || {};
  const d = m.lastDetail || {};
  if (kind === 'freshness') {
    const base = t('observability.monitors.freshnessRule', { column: c.time_column, hours: c.max_lag_hours });
    return d.lag_hours != null ? `${base} · ${t('observability.monitors.freshnessNow', { hours: d.lag_hours })}` : base;
  }
  if (kind === 'volume') {
    if (d.learning) return t('observability.monitors.volumeLearning');
    return d.row_count != null ? t('observability.monitors.volumeNow', { rows: d.row_count, expected: d.expected ?? '—' }) : t('observability.monitors.explain.volume');
  }
  if (d.error) return String(d.error);
  if (d.removed?.length || d.added?.length) return t('observability.monitors.schemaChanged', { added: (d.added || []).length, removed: (d.removed || []).length });
  return t('observability.monitors.explain.schema');
}

function MonitorEditor({ table, kind, monitor, onCancel, onSave }: {
  table: MonitorTable; kind: MonitorKind; monitor?: Monitor;
  onCancel: () => void; onSave: (config: Record<string, any>, severity: Severity) => void;
}) {
  const { t } = useI18n();
  const c = monitor?.config ?? {};
  const [timeColumn, setTimeColumn] = useState<string>(c.time_column ?? table.timeColumns[0] ?? '');
  const [lag, setLag] = useState<string>(String(c.max_lag_hours ?? 24));
  const [z, setZ] = useState<string>(String(c.z_threshold ?? 3));
  const [minRows, setMinRows] = useState<string>(c.min_rows != null ? String(c.min_rows) : '');
  const [severity, setSeverity] = useState<Severity>(monitor?.severity ?? 'warning');
  const submit = () => {
    if (kind === 'freshness') onSave({ time_column: timeColumn, max_lag_hours: Number(lag) }, severity);
    else onSave({ z_threshold: Number(z), ...(minRows !== '' ? { min_rows: Number(minRows) } : {}) }, severity);
  };
  const field = 'w-full rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-caption text-text-primary focus:border-brand focus:outline-none';
  return (
    <div className="border-t border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3" role="group" aria-label={t('observability.monitors.editTitle', { kind: t(`observability.pillar.${kind}`), table: table.name })}>
      <p className="mb-2 text-caption font-emphasis text-text-primary">{t('observability.monitors.editTitle', { kind: t(`observability.pillar.${kind}`), table: table.name })}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {kind === 'freshness' ? (
          <>
            <label className="text-tiny text-text-tertiary">{t('observability.monitors.field.timeColumn')}
              <select className={field} value={timeColumn} onChange={(e) => setTimeColumn(e.target.value)}>
                {table.timeColumns.map((col) => <option key={col} value={col}>{col}</option>)}
              </select>
            </label>
            <label className="text-tiny text-text-tertiary">{t('observability.monitors.field.maxLag')}
              <Input size="sm" type="number" min={0.1} step="0.5" value={lag} onChange={(e) => setLag(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            <label className="text-tiny text-text-tertiary">{t('observability.monitors.field.sensitivity')}
              <Input size="sm" type="number" min={1} max={10} step="0.5" value={z} onChange={(e) => setZ(e.target.value)} />
            </label>
            <label className="text-tiny text-text-tertiary">{t('observability.monitors.field.minRows')}
              <Input size="sm" type="number" min={0} value={minRows} onChange={(e) => setMinRows(e.target.value)} />
            </label>
          </>
        )}
        <label className="text-tiny text-text-tertiary">{t('observability.monitors.field.severity')}
          <select className={field} value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
            {(['info', 'warning', 'critical'] as Severity[]).map((s) => <option key={s} value={s}>{t(`observability.severity.${s}`)}</option>)}
          </select>
        </label>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>{t('observability.action.cancel')}</Button>
        <Button size="sm" variant="primary" onClick={submit} disabled={kind === 'freshness' && !timeColumn}>{t('observability.action.save')}</Button>
      </div>
    </div>
  );
}
