'use client';

/**
 * Usage & Resource tab (BI Observability) — the differentiator vs pure
 * data-observability tools: AppBI owns the BI layer, so it can show consumption
 * (charts/dashboards depending on each dataset), resource footprint (rows/
 * bytes), staleness, and "unused" datasets nobody consumes. Backed by
 * /observability/usage.
 */
import { useEffect, useMemo, useState } from 'react';
import { Database, BarChart3, LayoutDashboard, AlertTriangle, Archive, HardDrive } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useI18n } from '@/providers/LanguageProvider';
import { fmtNumber, fmtBytes, relativeTime } from './ui';
import { getUsage, type UsageRow } from '@/lib/observability';

export function UsageTab() {
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [onlyUnused, setOnlyUnused] = useState(false);

  useEffect(() => {
    setLoading(true);
    getUsage().then(setRows).catch(() => setRows([])).finally(() => setLoading(false));
  }, []);

  const totals = useMemo(() => ({
    datasets: rows.length,
    rows: rows.reduce((a, r) => a + (r.rows || 0), 0),
    bytes: rows.reduce((a, r) => a + (r.sizeBytes || 0), 0),
    charts: rows.reduce((a, r) => a + r.chartCount, 0),
    unused: rows.filter((r) => r.unused).length,
  }), [rows]);

  const view = onlyUnused ? rows.filter((r) => r.unused) : rows;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat icon={Database} label={t('observability.usage.stat.datasets')} value={fmtNumber(totals.datasets, locale)} />
        <Stat icon={HardDrive} label={t('observability.usage.stat.totalSize')} value={fmtBytes(totals.bytes, locale)} helper={t('observability.usage.stat.rowsHelper', { count: fmtNumber(totals.rows, locale) })} />
        <Stat icon={BarChart3} label={t('observability.usage.stat.consumedCharts')} value={fmtNumber(totals.charts, locale)} />
        <Stat icon={Archive} label={t('observability.usage.stat.unusedDatasets')} value={fmtNumber(totals.unused, locale)} tone={totals.unused > 0 ? 'warning' : 'default'} />
      </div>

      <div className="flex items-center gap-2">
        <button onClick={() => setOnlyUnused(false)} className={cn('rounded-full border px-2.5 py-0.5 text-tiny font-emphasis', !onlyUnused ? 'border-brand bg-brand/10 text-brand' : 'border-[rgb(var(--border-line))] text-text-tertiary')}>{t('observability.usage.filter.all')}</button>
        <button onClick={() => setOnlyUnused(true)} className={cn('rounded-full border px-2.5 py-0.5 text-tiny font-emphasis', onlyUnused ? 'border-warning bg-warning/10 text-warning' : 'border-[rgb(var(--border-line))] text-text-tertiary')}>{t('observability.usage.filter.onlyUnused')}{totals.unused ? ` (${totals.unused})` : ''}</button>
      </div>

      {loading ? (
        <p className="py-10 text-center text-caption text-text-tertiary">{t('observability.loading')}</p>
      ) : view.length === 0 ? (
        <p className="py-10 text-center text-caption text-text-tertiary">{onlyUnused ? t('observability.usage.empty.unused') : t('observability.usage.empty.all')}</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
          <div className="overflow-x-auto">
            <table className="app-list-table w-full divide-y divide-[rgb(var(--border-line))]">
              <thead className="bg-surface-2"><tr>
                <th className="app-list-header w-[26%]">{t('observability.usage.header.dataset')}</th>
                <th className="app-list-header">{t('observability.usage.header.tables')}</th>
                <th className="app-list-header">{t('observability.usage.header.rows')}</th>
                <th className="app-list-header">{t('observability.usage.header.size')}</th>
                <th className="app-list-header">{t('observability.usage.header.consumption')}</th>
                <th className="app-list-header">{t('observability.usage.header.refreshed')}</th>
                <th className="app-list-header">{t('observability.usage.header.monitors')}</th>
              </tr></thead>
              <tbody className="divide-y divide-[rgb(var(--border-line))]">
                {view.map((r) => (
                  <tr key={r.datasetId} className={cn('hover:bg-surface-2', r.unused && 'bg-warning/5')}>
                    <td className="app-list-cell">
                      <span className="flex items-center gap-2">
                        <span className="font-emphasis text-text-primary">{r.dataset}</span>
                        {r.unused && <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-1.5 py-0.5 text-tiny text-warning"><Archive className="h-3 w-3" />{t('observability.usage.badge.unused')}</span>}
                      </span>
                    </td>
                    <td className="app-list-cell text-caption text-text-tertiary">{r.tables}</td>
                    <td className="app-list-cell text-caption text-text-tertiary">{fmtNumber(r.rows, locale)}</td>
                    <td className="app-list-cell text-caption text-text-tertiary">{fmtBytes(r.sizeBytes, locale)}</td>
                    <td className="app-list-cell">
                      <span className="flex items-center gap-3 text-caption text-text-tertiary">
                        <span className="inline-flex items-center gap-1"><BarChart3 className="h-3.5 w-3.5" />{r.chartCount}</span>
                        <span className="inline-flex items-center gap-1"><LayoutDashboard className="h-3.5 w-3.5" />{r.dashboardCount}</span>
                      </span>
                    </td>
                    <td className="app-list-cell text-tiny text-text-quaternary">{relativeTime(r.lastRefresh, t, locale)}</td>
                    <td className="app-list-cell">
                      <span className="flex items-center gap-2 text-caption">
                        <span className="text-text-tertiary">{t('observability.usage.monitorCount', { count: r.monitors })}</span>
                        {r.openIncidents > 0 && <span className="inline-flex items-center gap-1 font-emphasis text-danger"><AlertTriangle className="h-3.5 w-3.5" />{r.openIncidents}</span>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value, helper, tone }: {
  icon: typeof Database; label: string; value: string; helper?: string; tone?: 'default' | 'warning';
}) {
  return (
    <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
      <div className="mb-1 flex items-center gap-1.5 text-tiny text-text-quaternary"><Icon className="h-3.5 w-3.5" />{label}</div>
      <div className={cn('text-h2 font-emphasis', tone === 'warning' ? 'text-warning' : 'text-text-primary')}>{value}</div>
      {helper && <div className="text-tiny text-text-quaternary">{helper}</div>}
    </div>
  );
}
