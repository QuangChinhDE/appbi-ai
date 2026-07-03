'use client';

/**
 * Lineage & Impact tab — source → table → chart → dashboard, plus per-table
 * impact ("this table feeds N charts on M dashboards"). Built from relations
 * AppBI already owns (Chart.dataset_table_id + DashboardChart), so it's
 * end-to-end without stitching external tools. Backed by /observability/lineage.
 */
import { useEffect, useMemo, useState } from 'react';
import { Database, GitBranch, BarChart3, LayoutDashboard, AlertTriangle, ArrowRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useDatasets } from '@/hooks/use-datasets';
import { fmtNumber } from './ui';
import { getLineage, type Lineage, type LineageNode } from '@/lib/observability';

export function LineageTab({ datasetId: fixedDatasetId }: { datasetId?: number } = {}) {
  const { data: datasets = [] } = useDatasets();
  const [datasetId, setDatasetId] = useState<number | null>(fixedDatasetId ?? null);
  const [lineage, setLineage] = useState<Lineage | null>(null);
  const [loading, setLoading] = useState(false);
  const locked = fixedDatasetId != null;

  // auto-select first dataset (only in standalone/global mode)
  useEffect(() => {
    if (locked) { setDatasetId(fixedDatasetId!); return; }
    if (datasetId == null && datasets.length) setDatasetId(datasets[0].id);
  }, [datasets, datasetId, locked, fixedDatasetId]);

  useEffect(() => {
    if (datasetId == null) return;
    setLoading(true);
    getLineage(datasetId).then(setLineage).catch(() => setLineage(null)).finally(() => setLoading(false));
  }, [datasetId]);

  const cols = useMemo(() => {
    const nodes = lineage?.nodes ?? [];
    return {
      source: nodes.filter((n) => n.type === 'source'),
      table: nodes.filter((n) => n.type === 'table'),
      chart: nodes.filter((n) => n.type === 'chart'),
      dashboard: nodes.filter((n) => n.type === 'dashboard'),
    };
  }, [lineage]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        {!locked && (
          <select value={datasetId ?? ''} onChange={(e) => setDatasetId(e.target.value ? Number(e.target.value) : null)}
            className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-caption text-text-primary focus:border-brand focus:outline-none">
            <option value="">— Chọn dataset —</option>
            {datasets.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        )}
        {lineage?.impact && (
          <div className="flex items-center gap-2 text-caption text-text-tertiary">
            <span className="inline-flex items-center gap-1"><BarChart3 className="h-3.5 w-3.5" />{lineage.impact.charts} biểu đồ</span>
            <span className="inline-flex items-center gap-1"><LayoutDashboard className="h-3.5 w-3.5" />{lineage.impact.dashboards} dashboard</span>
          </div>
        )}
      </div>

      {loading ? (
        <p className="py-10 text-center text-caption text-text-tertiary">Đang tải…</p>
      ) : !lineage || !lineage.dataset ? (
        <p className="py-10 text-center text-caption text-text-tertiary">Chọn một dataset để xem dòng dữ liệu.</p>
      ) : (
        <>
          {/* Columnar lineage flow */}
          <div className="overflow-x-auto rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
            <div className="flex min-w-[680px] items-stretch gap-2">
              <LineageColumn title="Nguồn" icon={Database} nodes={cols.source} />
              <Arrow />
              <LineageColumn title="Bảng" icon={GitBranch} nodes={cols.table} highlightIncidents />
              <Arrow />
              <LineageColumn title="Biểu đồ" icon={BarChart3} nodes={cols.chart} />
              <Arrow />
              <LineageColumn title="Dashboard" icon={LayoutDashboard} nodes={cols.dashboard} />
            </div>
          </div>

          {/* Per-table impact */}
          <div className="overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1">
            <div className="border-b border-[rgb(var(--border-line))] px-4 py-3">
              <h3 className="text-caption font-strong text-text-primary">Tác động theo bảng</h3>
              <p className="text-tiny text-text-quaternary">Bảng lỗi ảnh hưởng tới biểu đồ/dashboard nào — ưu tiên sửa nơi lan rộng nhất.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="app-list-table w-full divide-y divide-[rgb(var(--border-line))]">
                <thead className="bg-surface-2"><tr>
                  <th className="app-list-header w-[28%]">Bảng</th>
                  <th className="app-list-header">Nguồn</th>
                  <th className="app-list-header">Dòng</th>
                  <th className="app-list-header">Biểu đồ</th>
                  <th className="app-list-header">Dashboard</th>
                  <th className="app-list-header">Sự cố mở</th>
                </tr></thead>
                <tbody className="divide-y divide-[rgb(var(--border-line))]">
                  {lineage.tables.map((t) => (
                    <tr key={t.tableId} className={cn('hover:bg-surface-2', t.openIncidents > 0 && 'bg-danger/5')}>
                      <td className="app-list-cell font-emphasis text-text-primary">{t.name}</td>
                      <td className="app-list-cell text-caption text-text-tertiary">{t.source ?? '—'}</td>
                      <td className="app-list-cell text-caption text-text-tertiary">{fmtNumber(t.rows)}</td>
                      <td className="app-list-cell text-caption text-text-tertiary">{t.chartCount}</td>
                      <td className="app-list-cell">
                        {t.dashboardCount === 0 ? <span className="text-tiny text-text-quaternary">—</span> : (
                          <span className="text-caption text-text-tertiary" title={t.dashboards.map((d) => d.name).join(', ')}>{t.dashboardCount} dashboard</span>
                        )}
                      </td>
                      <td className="app-list-cell">
                        {t.openIncidents > 0
                          ? <span className="inline-flex items-center gap-1 text-caption font-emphasis text-danger"><AlertTriangle className="h-3.5 w-3.5" />{t.openIncidents}</span>
                          : <span className="text-tiny text-success">0</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Arrow() {
  return <div className="flex items-center px-1 text-text-quaternary"><ArrowRight className="h-4 w-4" /></div>;
}

function LineageColumn({ title, icon: Icon, nodes, highlightIncidents }: {
  title: string; icon: typeof Database; nodes: LineageNode[]; highlightIncidents?: boolean;
}) {
  return (
    <div className="flex-1">
      <div className="mb-2 flex items-center gap-1.5 text-tiny font-emphasis uppercase tracking-wide text-text-quaternary">
        <Icon className="h-3.5 w-3.5" />{title} ({nodes.length})
      </div>
      <div className="space-y-1.5">
        {nodes.length === 0 && <div className="rounded-lg border border-dashed border-[rgb(var(--border-line))] px-3 py-2 text-tiny text-text-quaternary">—</div>}
        {nodes.map((n) => (
          <div key={n.id} className={cn('rounded-lg border px-3 py-2 text-caption',
            highlightIncidents && (n.openIncidents ?? 0) > 0
              ? 'border-danger/40 bg-danger/5 text-danger'
              : 'border-[rgb(var(--border-line))] bg-surface-2 text-text-secondary')}>
            <div className="truncate" title={n.label}>{n.label}</div>
            {highlightIncidents && (n.openIncidents ?? 0) > 0 && (
              <div className="mt-0.5 inline-flex items-center gap-1 text-tiny"><AlertTriangle className="h-3 w-3" />{n.openIncidents} sự cố</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
