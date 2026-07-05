'use client';

/**
 * Monitors tab — the heart of Observability. Two monitor families:
 *   • Native health monitors (freshness / volume / schema) → /observability/monitors
 *   • Anomaly metrics (the Phase-4 z-score engine)         → /anomaly/metrics
 * Both run on the daily scheduler; both can be run on demand.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus, Play, Trash2, Clock, BarChart3, GitBranch, Activity, Loader2, Search, Power,
} from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/common/Modal';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { useDatasets, useDataset } from '@/hooks/use-datasets';
import { useI18n } from '@/providers/LanguageProvider';
import { StatusPill, relativeTime, fmtNumber } from './ui';
import {
  listMonitors, createMonitor, deleteMonitor, runMonitor, updateMonitor,
  listAnomalyMetrics, createAnomalyMetric, deleteAnomalyMetric, toggleAnomalyMetric,
  type Monitor, type MonitorKind, type AnomalyMetric,
} from '@/lib/observability';

type CreateType = MonitorKind | 'anomaly';

const KIND_META: Record<CreateType, { labelKey: string; icon: typeof Clock; descKey: string }> = {
  freshness: { labelKey: 'observability.monitors.kind.freshness.label', icon: Clock, descKey: 'observability.monitors.kind.freshness.desc' },
  volume: { labelKey: 'observability.monitors.kind.volume.label', icon: BarChart3, descKey: 'observability.monitors.kind.volume.desc' },
  schema: { labelKey: 'observability.monitors.kind.schema.label', icon: GitBranch, descKey: 'observability.monitors.kind.schema.desc' },
  anomaly: { labelKey: 'observability.monitors.kind.anomaly.label', icon: Activity, descKey: 'observability.monitors.kind.anomaly.desc' },
};

function tableColumns(table: any): string[] {
  const cols = table?.columns_cache?.columns;
  return Array.isArray(cols) ? cols.map((c: any) => c?.name).filter(Boolean) : [];
}

export function MonitorsTab({ datasetId }: { datasetId?: number } = {}) {
  const { t, locale } = useI18n();
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [metrics, setMetrics] = useState<AnomalyMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  // In dataset-scoped mode, filter the (per-user) anomaly metrics down to this
  // dataset's tables.
  const { data: scopedDataset } = useDataset(datasetId ?? null);
  const scopedTableIds = useMemo(
    () => new Set((scopedDataset?.tables ?? []).map((t: any) => t.id)),
    [scopedDataset],
  );

  const reload = useCallback(() => {
    setLoading(true);
    return Promise.all([listMonitors(datasetId), listAnomalyMetrics()])
      .then(([m, a]) => {
        setMonitors(m);
        setMetrics(datasetId != null ? a.filter((x) => scopedTableIds.has(x.dataset_table_id)) : a);
      })
      .catch(() => { setMonitors([]); setMetrics([]); })
      .finally(() => setLoading(false));
  }, [datasetId, scopedTableIds]);
  useEffect(() => { reload(); }, [reload]);

  const onRunMonitor = async (m: Monitor) => {
    setRunningId(`m${m.id}`);
    try { await runMonitor(m.id); await reload(); toast.success(t('observability.monitors.toast.runSuccess')); }
    catch { toast.error(t('observability.monitors.toast.runFailed')); }
    finally { setRunningId(null); }
  };
  const onDeleteMonitor = async (m: Monitor) => {
    if (!confirm(t('observability.monitors.confirm.deleteMonitor', { name: m.name }))) return;
    try { await deleteMonitor(m.id); await reload(); } catch { toast.error(t('observability.monitors.toast.deleteFailed')); }
  };
  const onToggleMonitor = async (m: Monitor) => {
    try { await updateMonitor(m.id, { isActive: !m.isActive }); await reload(); } catch { toast.error(t('observability.monitors.toast.updateFailed')); }
  };
  const onDeleteMetric = async (a: AnomalyMetric) => {
    if (!confirm(t('observability.monitors.confirm.deleteMetric', { name: a.metric_column }))) return;
    try { await deleteAnomalyMetric(a.id); await reload(); } catch { toast.error(t('observability.monitors.toast.deleteFailed')); }
  };
  const onToggleMetric = async (a: AnomalyMetric) => {
    try { await toggleAnomalyMetric(a.id); await reload(); } catch { toast.error(t('observability.monitors.toast.updateFailed')); }
  };

  const needle = q.trim().toLowerCase();
  const fMonitors = monitors.filter((m) => !needle || m.name.toLowerCase().includes(needle) || (m.tableName || '').toLowerCase().includes(needle));
  const fMetrics = metrics.filter((a) => !needle || a.metric_column.toLowerCase().includes(needle));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('observability.monitors.search')} leadingIcon={<Search />} className="w-64" />
        <Button variant="primary" leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>{t('observability.action.addMonitor')}</Button>
      </div>

      {loading ? (
        <p className="py-10 text-center text-caption text-text-tertiary">{t('observability.loading')}</p>
      ) : (monitors.length === 0 && metrics.length === 0) ? (
        <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-6 py-14 text-center">
          <Activity className="mx-auto mb-4 h-12 w-12 text-text-quaternary" />
          <h3 className="mb-1 text-small font-strong text-text-primary">{t('observability.monitors.empty.title')}</h3>
          <p className="mb-5 text-caption text-text-tertiary">{t('observability.monitors.empty.body')}</p>
          <Button variant="primary" leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>{t('observability.action.addMonitor')}</Button>
        </div>
      ) : (
        <>
          {/* Native health monitors */}
          {fMonitors.length > 0 && (
            <Section title={t('observability.monitors.section.health.title')} subtitle={t('observability.monitors.section.health.subtitle')}>
              <table className="app-list-table w-full divide-y divide-[rgb(var(--border-line))]">
                <thead className="bg-surface-2"><tr>
                  <th className="app-list-header w-[30%]">{t('observability.monitors.header.monitor')}</th>
                  <th className="app-list-header">{t('observability.monitors.header.type')}</th>
                  <th className="app-list-header">{t('observability.monitors.header.table')}</th>
                  <th className="app-list-header">{t('observability.monitors.header.status')}</th>
                  <th className="app-list-header">{t('observability.monitors.header.value')}</th>
                  <th className="app-list-header">{t('observability.monitors.header.lastCheck')}</th>
                  <th className="app-list-header text-right">{t('observability.monitors.header.actions')}</th>
                </tr></thead>
                <tbody className="divide-y divide-[rgb(var(--border-line))]">
                  {fMonitors.map((m) => {
                    const Meta = KIND_META[m.kind];
                    return (
                      <tr key={m.id} className={cn('hover:bg-surface-2', !m.isActive && 'opacity-50')}>
                        <td className="app-list-cell font-emphasis text-text-primary">{m.name}</td>
                        <td className="app-list-cell"><span className="inline-flex items-center gap-1 text-caption text-text-secondary"><Meta.icon className="h-3.5 w-3.5" />{t(Meta.labelKey)}</span></td>
                        <td className="app-list-cell text-caption text-text-tertiary">{m.tableName ?? '—'}</td>
                        <td className="app-list-cell"><StatusPill status={m.lastStatus} /></td>
                        <td className="app-list-cell text-caption text-text-tertiary">{monitorValueLabel(m, t, locale)}</td>
                        <td className="app-list-cell text-tiny text-text-quaternary">{relativeTime(m.lastCheckedAt, t, locale)}</td>
                        <td className="app-list-cell">
                          <div className="flex items-center justify-end gap-1.5">
                            <IconBtn title={t('observability.action.runNow')} onClick={() => onRunMonitor(m)} loading={runningId === `m${m.id}`}><Play className="h-3.5 w-3.5" /></IconBtn>
                            <IconBtn title={m.isActive ? t('observability.action.pause') : t('observability.action.enable')} onClick={() => onToggleMonitor(m)}><Power className={cn('h-3.5 w-3.5', m.isActive ? 'text-success' : 'text-text-quaternary')} /></IconBtn>
                            <IconBtn title={t('observability.action.delete')} onClick={() => onDeleteMonitor(m)}><Trash2 className="h-3.5 w-3.5 text-danger" /></IconBtn>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Section>
          )}

          {/* Anomaly metrics */}
          {fMetrics.length > 0 && (
            <Section title={t('observability.monitors.section.anomaly.title')} subtitle={t('observability.monitors.section.anomaly.subtitle')}>
              <table className="app-list-table w-full divide-y divide-[rgb(var(--border-line))]">
                <thead className="bg-surface-2"><tr>
                  <th className="app-list-header w-[26%]">{t('observability.monitors.header.metric')}</th>
                  <th className="app-list-header">{t('observability.monitors.header.aggregation')}</th>
                  <th className="app-list-header">{t('observability.monitors.header.timeColumn')}</th>
                  <th className="app-list-header">{t('observability.monitors.header.zThreshold')}</th>
                  <th className="app-list-header">{t('observability.monitors.header.frequency')}</th>
                  <th className="app-list-header">{t('observability.monitors.header.status')}</th>
                  <th className="app-list-header text-right">{t('observability.monitors.header.actions')}</th>
                </tr></thead>
                <tbody className="divide-y divide-[rgb(var(--border-line))]">
                  {fMetrics.map((a) => (
                    <tr key={a.id} className={cn('hover:bg-surface-2', !a.is_active && 'opacity-50')}>
                      <td className="app-list-cell font-emphasis text-text-primary">{a.metric_column}</td>
                      <td className="app-list-cell text-caption text-text-tertiary uppercase">{a.aggregation}</td>
                      <td className="app-list-cell text-caption text-text-tertiary">{a.time_column ?? '—'}</td>
                      <td className="app-list-cell text-caption text-text-tertiary">{a.threshold_z_score}</td>
                      <td className="app-list-cell text-caption text-text-tertiary">{frequencyLabel(a.check_frequency, t)}</td>
                      <td className="app-list-cell">{a.is_active ? <StatusPill status="ok" /> : <span className="text-tiny text-text-quaternary">{t('observability.status.paused')}</span>}</td>
                      <td className="app-list-cell">
                        <div className="flex items-center justify-end gap-1.5">
                          <IconBtn title={a.is_active ? t('observability.action.pause') : t('observability.action.enable')} onClick={() => onToggleMetric(a)}><Power className={cn('h-3.5 w-3.5', a.is_active ? 'text-success' : 'text-text-quaternary')} /></IconBtn>
                          <IconBtn title={t('observability.action.delete')} onClick={() => onDeleteMetric(a)}><Trash2 className="h-3.5 w-3.5 text-danger" /></IconBtn>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}
        </>
      )}

      {creating && <CreateMonitorModal lockedDatasetId={datasetId} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); reload(); }} />}
    </div>
  );
}

function monitorValueLabel(m: Monitor, t: (key: string, values?: Record<string, string | number>) => string, locale: string): string {
  if (m.lastValue == null) return '—';
  if (m.kind === 'freshness') return t('observability.monitors.value.lagHours', { value: m.lastValue });
  if (m.kind === 'volume') return t('observability.monitors.value.rows', { value: fmtNumber(m.lastValue, locale) });
  if (m.kind === 'schema') return t('observability.monitors.value.columns', { value: m.lastValue });
  return String(m.lastValue);
}

function frequencyLabel(value: string, t: (key: string, values?: Record<string, string | number>) => string): string {
  if (value === 'daily') return t('observability.frequency.daily');
  return value;
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
      <div className="border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-3">
        <h3 className="text-caption font-strong text-text-primary">{title}</h3>
        {subtitle && <p className="text-tiny text-text-quaternary">{subtitle}</p>}
      </div>
      <div className="app-list-table-wrap overflow-x-auto">{children}</div>
    </div>
  );
}

function IconBtn({ children, title, onClick, loading }: { children: React.ReactNode; title: string; onClick: () => void; loading?: boolean }) {
  return (
    <button title={title} onClick={onClick} disabled={loading}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[rgb(var(--border-line))] text-text-tertiary hover:bg-surface-2 disabled:opacity-50">
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : children}
    </button>
  );
}

// ── Create modal ──────────────────────────────────────────────────────────────
function CreateMonitorModal({ onClose, onCreated, lockedDatasetId }: { onClose: () => void; onCreated: () => void; lockedDatasetId?: number }) {
  const { t } = useI18n();
  const [type, setType] = useState<CreateType>('freshness');
  const { data: datasets = [] } = useDatasets();
  const [datasetId, setDatasetId] = useState<number | null>(lockedDatasetId ?? null);
  const { data: dataset } = useDataset(datasetId);
  const [tableId, setTableId] = useState<number | null>(null);
  const [column, setColumn] = useState('');
  const [timeColumn, setTimeColumn] = useState('');
  const [aggregation, setAggregation] = useState('sum');
  const [maxLagHours, setMaxLagHours] = useState(24);
  const [zThreshold, setZThreshold] = useState(3);
  const [minRows, setMinRows] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  const tables = dataset?.tables ?? [];
  const selectedTable = tables.find((t: any) => t.id === tableId);
  const columns = useMemo(() => tableColumns(selectedTable), [selectedTable]);

  useEffect(() => { setTableId(null); }, [datasetId]);
  useEffect(() => { setColumn(''); setTimeColumn(''); }, [tableId]);

  const needsTimeCol = type === 'freshness' || type === 'anomaly';
  const needsMetricCol = type === 'anomaly';
  const canSubmit = tableId != null && (!needsTimeCol || timeColumn) && (!needsMetricCol || column);

  const submit = async () => {
    if (!canSubmit || tableId == null) return;
    setSubmitting(true);
    try {
      if (type === 'anomaly') {
        await createAnomalyMetric({
          dataset_table_id: tableId, metric_column: column, aggregation,
          time_column: timeColumn, threshold_z_score: zThreshold, check_frequency: 'daily',
        });
      } else {
        const config: Record<string, any> = {};
        if (type === 'freshness') config.max_lag_hours = maxLagHours;
        if (type === 'freshness') config.time_column = timeColumn;
        if (type === 'volume') { config.z_threshold = zThreshold; if (minRows) config.min_rows = Number(minRows); }
        await createMonitor({ dataset_table_id: tableId, kind: type, config });
      }
      toast.success(t('observability.monitors.toast.createSuccess'));
      onCreated();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail ?? t('observability.monitors.toast.createFailed'));
    } finally { setSubmitting(false); }
  };

  return (
    <Modal isOpen onClose={onClose} title={t('observability.monitors.modal.title')} size="lg"
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t('observability.action.cancel')}</Button>
        <Button variant="primary" disabled={!canSubmit || submitting} onClick={submit} leadingIcon={submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>{t('observability.action.create')}</Button>
      </>}>
      <div className="space-y-4">
        {/* type picker */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(Object.keys(KIND_META) as CreateType[]).map((k) => {
            const Meta = KIND_META[k];
            return (
              <button key={k} onClick={() => setType(k)}
                className={cn('flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors',
                  type === k ? 'border-brand bg-brand/10' : 'border-[rgb(var(--border-line))] hover:bg-surface-2')}>
                <Meta.icon className={cn('h-4 w-4', type === k ? 'text-brand' : 'text-text-tertiary')} />
                <span className="text-caption font-emphasis text-text-primary">{t(Meta.labelKey)}</span>
              </button>
            );
          })}
        </div>
        <p className="text-tiny text-text-quaternary">{t(KIND_META[type].descKey)}</p>

        {/* dataset + table */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t('observability.monitors.field.dataset')}>
            <NativeSelect value={datasetId ?? ''} disabled={!!lockedDatasetId} onChange={(v) => setDatasetId(v ? Number(v) : null)}>
              <option value="">{t('observability.monitors.placeholder.selectDataset')}</option>
              {datasets.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </NativeSelect>
          </Field>
          <Field label={t('observability.monitors.field.table')}>
            <NativeSelect value={tableId ?? ''} disabled={!datasetId} onChange={(v) => setTableId(v ? Number(v) : null)}>
              <option value="">{t('observability.monitors.placeholder.selectTable')}</option>
              {tables.map((t: any) => <option key={t.id} value={t.id}>{t.display_name || t.source_table_name}</option>)}
            </NativeSelect>
          </Field>
        </div>

        {/* metric column (anomaly) */}
        {needsMetricCol && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('observability.monitors.field.metricColumn')}>
              <NativeSelect value={column} disabled={!tableId} onChange={setColumn}>
                <option value="">{t('observability.monitors.placeholder.selectColumn')}</option>
                {columns.map((c) => <option key={c} value={c}>{c}</option>)}
              </NativeSelect>
            </Field>
            <Field label={t('observability.monitors.field.aggregation')}>
              <NativeSelect value={aggregation} onChange={setAggregation}>
                {['sum', 'avg', 'count', 'count_distinct', 'min', 'max'].map((a) => <option key={a} value={a}>{a.toUpperCase()}</option>)}
              </NativeSelect>
            </Field>
          </div>
        )}

        {/* time column */}
        {needsTimeCol && (
          <Field label={t('observability.monitors.field.timeColumn')}>
            <NativeSelect value={timeColumn} disabled={!tableId} onChange={setTimeColumn}>
              <option value="">{t('observability.monitors.placeholder.selectTimeColumn')}</option>
              {columns.map((c) => <option key={c} value={c}>{c}</option>)}
            </NativeSelect>
          </Field>
        )}

        {/* thresholds */}
        {type === 'freshness' && (
          <Field label={t('observability.monitors.field.maxLagHours')}>
            <Input type="number" size="sm" value={maxLagHours} onChange={(e) => setMaxLagHours(Number(e.target.value))} />
          </Field>
        )}
        {(type === 'volume' || type === 'anomaly') && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('observability.monitors.field.zThreshold')}><Input type="number" step="0.5" size="sm" value={zThreshold} onChange={(e) => setZThreshold(Number(e.target.value))} /></Field>
            {type === 'volume' && <Field label={t('observability.monitors.field.minRows')}><Input type="number" size="sm" value={minRows} onChange={(e) => setMinRows(e.target.value)} placeholder={t('observability.monitors.placeholder.minRows')} /></Field>}
          </div>
        )}
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-tiny font-emphasis text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

function NativeSelect({ value, onChange, disabled, children }: { value: string | number; onChange: (v: string) => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-caption text-text-primary focus:border-brand focus:outline-none disabled:opacity-50">
      {children}
    </select>
  );
}
