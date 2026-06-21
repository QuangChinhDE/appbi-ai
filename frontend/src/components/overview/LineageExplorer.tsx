'use client';

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  ChevronDown,
  ClipboardList,
  Database,
  ExternalLink,
  LayoutDashboard,
  Maximize2,
  Minimize2,
  Plug,
  Search,
  Table2,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/utils';
import type { Dataset } from '@/hooks/use-datasets';
import type { Chart, Dashboard, DataSource } from '@/types/api';
import type { Workboard } from '@/lib/api/workboards';
import {
  buildLineageGraph,
  keyOf,
  resolveVisibleKeys,
  type EdgeType,
  type LineageFilters,
  type LineageKind,
  type LineageNode,
  type LineageRef,
} from '@/lib/lineage';

interface LineageExplorerProps {
  dataSources: DataSource[];
  datasets: Dataset[];
  charts: Chart[];
  dashboards: Dashboard[];
  workboards: Workboard[];
  canViewWorkboards: boolean;
  vi: boolean;
  onOpen: (ref: LineageRef) => void;
}

const COLUMN_META: Array<{ kind: LineageKind; en: string; vi: string; icon: LucideIcon }> = [
  { kind: 'source', en: 'Sources', vi: 'Nguồn', icon: Plug },
  { kind: 'dataset', en: 'Datasets', vi: 'Dataset', icon: Database },
  { kind: 'chart', en: 'Charts', vi: 'Chart', icon: BarChart3 },
  { kind: 'dashboard', en: 'Dashboards', vi: 'Dashboard', icon: LayoutDashboard },
];

const EDGE_COLOR: Record<EdgeType, string> = {
  'source-table': '#22c55e',
  'table-dataset': '#8b5cf6',
  'source-dataset': '#22c55e',
  'dataset-chart': '#3b82f6',
  'chart-dashboard': '#f97316',
  'dataset-workboard': '#14b8a6',
};

// Relationship tabs shown in the drill-down detail (keeps the Table granularity).
const EDGE_LABEL: Array<{ type: EdgeType; en: string; vi: string; dashed?: boolean }> = [
  { type: 'source-table', en: 'Source → Table', vi: 'Nguồn → Bảng' },
  { type: 'table-dataset', en: 'Table → Dataset', vi: 'Bảng → Dataset' },
  { type: 'dataset-chart', en: 'Dataset → Chart', vi: 'Dataset → Chart' },
  { type: 'chart-dashboard', en: 'Chart → Dashboard', vi: 'Chart → Dashboard' },
  { type: 'dataset-workboard', en: 'Dataset → Workboard', vi: 'Dataset → Workboard', dashed: true },
];

const KIND_ICON: Record<LineageKind, LucideIcon> = {
  source: Plug,
  table: Table2,
  dataset: Database,
  chart: BarChart3,
  dashboard: LayoutDashboard,
  workboard: ClipboardList,
};

const UNFILTERED_CAP = 40; // cap big columns when nothing is selected (columns scroll inside the fixed-height board)
const BOARD_HEIGHT = 560;

interface Geom {
  d: string;
  type: EdgeType;
  active: boolean;
}

export function LineageExplorer({
  dataSources,
  datasets,
  charts,
  dashboards,
  workboards,
  canViewWorkboards,
  vi,
  onOpen,
}: LineageExplorerProps) {
  const graph = useMemo(
    () => buildLineageGraph({ dataSources, datasets, charts, dashboards, workboards }),
    [dataSources, datasets, charts, dashboards, workboards],
  );

  const [filters, setFilters] = useState<LineageFilters>({});
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  const visibleKeys = useMemo(
    () => resolveVisibleKeys(graph, filters, query),
    [graph, filters, query],
  );

  const highlightKeys = useMemo(
    () => (selected ? graph.connectedKeys(selected) : null),
    [graph, selected],
  );

  const hasFilter = Boolean(query || filters.source || filters.dataset || filters.chart || filters.dashboard || filters.workboard);

  // Nodes to render per column (respect filter; cap big columns when unfiltered).
  const renderColumns = useMemo(() => {
    const pick = (nodes: LineageNode[]): { nodes: LineageNode[]; hidden: number } => {
      let list = nodes;
      if (visibleKeys) list = nodes.filter((n) => visibleKeys.has(n.key));
      if (!visibleKeys && list.length > UNFILTERED_CAP) {
        return { nodes: list.slice(0, UNFILTERED_CAP), hidden: list.length - UNFILTERED_CAP };
      }
      return { nodes: list, hidden: 0 };
    };
    return {
      source: pick(graph.columns.source),
      table: pick(graph.columns.table),
      dataset: pick(graph.columns.dataset),
      chart: pick(graph.columns.chart),
      dashboard: pick(graph.columns.dashboard),
      workboard: pick(graph.columns.workboard),
    };
  }, [graph, visibleKeys]);

  const renderedKeys = useMemo(() => {
    const set = new Set<string>();
    Object.values(renderColumns).forEach((c) => c.nodes.forEach((n) => set.add(n.key)));
    return set;
  }, [renderColumns]);

  // --- SVG connector geometry, measured from the DOM ---
  const boardRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const nodeEls = useRef<Map<string, HTMLElement>>(new Map());
  const [geoms, setGeoms] = useState<Geom[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });

  const setNodeEl = useCallback((key: string, el: HTMLElement | null) => {
    if (el) nodeEls.current.set(key, el);
    else nodeEls.current.delete(key);
  }, []);

  const recompute = useCallback(() => {
    const content = contentRef.current;
    if (!content) return;
    const origin = content.getBoundingClientRect();
    const next: Geom[] = [];
    for (const edge of graph.edges) {
      if (!renderedKeys.has(edge.from) || !renderedKeys.has(edge.to)) continue;
      const a = nodeEls.current.get(edge.from);
      const b = nodeEls.current.get(edge.to);
      if (!a || !b) continue;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const x1 = ra.right - origin.left;
      const y1 = ra.top - origin.top + ra.height / 2;
      const x2 = rb.left - origin.left;
      const y2 = rb.top - origin.top + rb.height / 2;
      const dx = Math.max(24, (x2 - x1) * 0.45);
      const active = !highlightKeys || (highlightKeys.has(edge.from) && highlightKeys.has(edge.to));
      next.push({
        d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
        type: edge.type,
        active,
      });
    }
    setGeoms(next);
    setSize({ w: content.scrollWidth, h: content.scrollHeight });
  }, [graph.edges, renderedKeys, highlightKeys]);

  useLayoutEffect(() => {
    // measure after paint settles
    const raf = requestAnimationFrame(recompute);
    return () => cancelAnimationFrame(raf);
  }, [recompute, renderColumns, fullscreen]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => recompute());
    ro.observe(content);
    return () => ro.disconnect();
  }, [recompute]);

  const setFilter = (key: keyof LineageFilters, value: string) => {
    setSelected(null);
    setFilters((prev) => ({ ...prev, [key]: value ? Number(value) : undefined }));
  };
  const clearAll = () => {
    setFilters({});
    setQuery('');
    setSelected(null);
  };

  const options = (kind: LineageKind) =>
    graph.columns[kind].map((n) => ({ value: String(n.id), label: n.name }));

  const nodeState = (key: string): 'normal' | 'active' | 'dim' => {
    if (!highlightKeys) return 'normal';
    return highlightKeys.has(key) ? 'active' : 'dim';
  };

  const selectedNode = selected ? graph.nodeByKey.get(selected) ?? null : null;

  return (
    <section
      className={cn(
        'rounded-xl border border-[rgb(var(--border-line))] bg-surface-1',
        fullscreen ? 'fixed inset-3 z-50 flex flex-col overflow-hidden shadow-linear-lg' : '',
      )}
    >
      {/* Header + filter bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[rgb(var(--border-line))] p-3">
        <div className="w-44">
          <Input
            size="sm"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={vi ? 'Tìm theo tên…' : 'Search by name…'}
            leadingIcon={<Search />}
          />
        </div>
        <FilterSelect placeholder={vi ? 'Mọi nguồn' : 'All sources'} icon={Plug} value={filters.source} options={options('source')} onChange={(v) => setFilter('source', v)} />
        <FilterSelect placeholder={vi ? 'Mọi dataset' : 'All datasets'} icon={Database} value={filters.dataset} options={options('dataset')} onChange={(v) => setFilter('dataset', v)} />
        <FilterSelect placeholder={vi ? 'Mọi chart' : 'All charts'} icon={BarChart3} value={filters.chart} options={options('chart')} onChange={(v) => setFilter('chart', v)} />
        <FilterSelect placeholder={vi ? 'Mọi dashboard' : 'All dashboards'} icon={LayoutDashboard} value={filters.dashboard} options={options('dashboard')} onChange={(v) => setFilter('dashboard', v)} />
        {canViewWorkboards && (
          <FilterSelect placeholder={vi ? 'Mọi workboard' : 'All workboards'} icon={ClipboardList} value={filters.workboard} options={options('workboard')} onChange={(v) => setFilter('workboard', v)} />
        )}
        {hasFilter && (
          <button type="button" onClick={clearAll} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-tiny text-text-tertiary hover:bg-surface-2 hover:text-text-secondary">
            <X className="h-3 w-3" /> {vi ? 'Xóa lọc' : 'Clear all'}
          </button>
        )}
        <button
          type="button"
          onClick={() => setFullscreen((v) => !v)}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-strong))] px-2 py-1 text-tiny font-emphasis text-text-secondary hover:bg-surface-2"
        >
          {fullscreen ? <Minimize2 className="h-3 w-3" /> : <Maximize2 className="h-3 w-3" />}
          {fullscreen ? (vi ? 'Thu nhỏ' : 'Exit') : (vi ? 'Toàn màn hình' : 'Full screen')}
        </button>
      </div>

      <div className={cn('p-3', fullscreen && 'min-h-0 flex-1 overflow-auto')}>
        {/* Board with SVG connectors — fills width, fixed height, scrolls internally */}
        <div
          ref={boardRef}
          className="relative overflow-y-auto overflow-x-auto rounded-lg border border-[rgb(var(--border-line))] bg-surface-0/40"
          style={{ height: fullscreen ? 'calc(100vh - 180px)' : BOARD_HEIGHT }}
        >
          <div ref={contentRef} className="relative w-full min-w-[680px] p-3">
            <svg
              className="pointer-events-none absolute inset-0"
              width={size.w || '100%'}
              height={size.h || '100%'}
              style={{ zIndex: 0 }}
            >
              {geoms.map((g, i) => (
                <path
                  key={i}
                  d={g.d}
                  fill="none"
                  stroke={EDGE_COLOR[g.type]}
                  strokeWidth={g.active ? 2 : 1.25}
                  strokeOpacity={g.active ? 0.9 : 0.14}
                  strokeDasharray={g.type === 'dataset-workboard' ? '5 4' : undefined}
                />
              ))}
            </svg>

            <div className="relative flex gap-6 lg:gap-10 xl:gap-14" style={{ zIndex: 1 }}>
            {COLUMN_META.map((meta) => (
              <LineageColumn
                key={meta.kind}
                meta={meta}
                vi={vi}
                total={graph.counts[meta.kind]}
                data={renderColumns[meta.kind]}
                nodeState={nodeState}
                setNodeEl={setNodeEl}
                onSelect={setSelected}
                selected={selected}
              />
            ))}
            {canViewWorkboards && (
              <LineageColumn
                meta={{ kind: 'workboard', en: 'Workboards', vi: 'Workboard', icon: ClipboardList }}
                vi={vi}
                total={graph.counts.workboard}
                data={renderColumns.workboard}
                nodeState={nodeState}
                setNodeEl={setNodeEl}
                onSelect={setSelected}
                selected={selected}
              />
            )}
            </div>
          </div>
        </div>
      </div>

      {/* Drill-down */}
      {selectedNode && (
        <DrillDown
          node={selectedNode}
          graph={graph}
          datasets={datasets}
          dataSources={dataSources}
          dashboards={dashboards}
          workboards={workboards}
          vi={vi}
          onOpen={onOpen}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

function FilterSelect({
  placeholder,
  icon: Icon,
  value,
  options,
  onChange,
}: {
  placeholder: string;
  icon: LucideIcon;
  value?: number;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="relative">
      <Icon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
      <select
        value={value ? String(value) : ''}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'h-8 w-36 appearance-none rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 pl-7 pr-7 text-caption',
          'focus:outline-none focus:shadow-focus-brand',
          value ? 'text-text-primary' : 'text-text-tertiary',
        )}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
    </div>
  );
}

function LineageColumn({
  meta,
  vi,
  total,
  data,
  nodeState,
  setNodeEl,
  onSelect,
  selected,
}: {
  meta: { kind: LineageKind; en: string; vi: string; icon: LucideIcon };
  vi: boolean;
  total: number;
  data: { nodes: LineageNode[]; hidden: number };
  nodeState: (key: string) => 'normal' | 'active' | 'dim';
  setNodeEl: (key: string, el: HTMLElement | null) => void;
  onSelect: (key: string) => void;
  selected: string | null;
}) {
  const Icon = meta.icon;
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="sticky top-0 z-10 mb-2 flex items-center gap-1.5 rounded-md bg-surface-1/95 px-1 py-1.5 backdrop-blur-sm">
        <Icon className="h-3.5 w-3.5 text-text-tertiary" />
        <span className="text-caption font-strong text-text-primary">{vi ? meta.vi : meta.en}</span>
        <span className="ml-auto rounded-full bg-surface-2 px-1.5 text-tiny text-text-tertiary">{total}</span>
      </div>
      <div className="flex flex-col gap-3">
        {data.nodes.length === 0 ? (
          <p className="text-tiny text-text-quaternary">—</p>
        ) : (
          data.nodes.map((node) => {
            const state = nodeState(node.key);
            const isSel = selected === node.key;
            return (
              <button
                key={node.key}
                type="button"
                ref={(el) => setNodeEl(node.key, el)}
                onClick={() => onSelect(node.key)}
                title={node.name}
                className={cn(
                  'flex items-center gap-2 rounded-lg border bg-surface-0 px-2 py-1.5 text-left transition-all',
                  isSel
                    ? 'border-brand ring-1 ring-brand'
                    : state === 'active'
                      ? 'border-brand/50 bg-brand/5'
                      : 'border-[rgb(var(--border-line))] hover:border-[rgb(var(--border-strong))] hover:bg-surface-2',
                  state === 'dim' && !isSel && 'opacity-30 hover:opacity-100',
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                <span className="min-w-0">
                  <span className="block truncate text-tiny font-emphasis text-text-primary">{node.name}</span>
                  {node.sub && <span className="block truncate text-[10px] text-text-quaternary">{node.sub}</span>}
                </span>
              </button>
            );
          })
        )}
        {data.hidden > 0 && (
          <span className="text-[10px] text-text-quaternary">
            +{data.hidden} {vi ? 'mục nữa — lọc để xem' : 'more — filter to see'}
          </span>
        )}
      </div>
    </div>
  );
}

function DrillDown({
  node,
  graph,
  datasets,
  dataSources,
  dashboards,
  workboards,
  vi,
  onOpen,
  onClose,
}: {
  node: LineageNode;
  graph: ReturnType<typeof buildLineageGraph>;
  datasets: Dataset[];
  dataSources: DataSource[];
  dashboards: Dashboard[];
  workboards: Workboard[];
  vi: boolean;
  onOpen: (ref: LineageRef) => void;
  onClose: () => void;
}) {
  const chain = useMemo(() => graph.connectedKeys(node.key), [graph, node.key]);
  const impact = useMemo(() => graph.impactOf(node.key), [graph, node.key]);
  const Icon = KIND_ICON[node.kind];

  // Detailed relationship tables within the chain, grouped by edge type.
  const tables = useMemo(() => {
    const datasetById = new Map(datasets.map((d) => [d.id, d]));
    const dashboardById = new Map(dashboards.map((d) => [d.id, d]));
    const workboardById = new Map(workboards.map((w) => [w.id, w]));
    const owner = (email?: string | null) => (email ? email.split('@')[0] : '—');
    const idOf = (k: string) => Number(k.split(':')[1]);
    const n = (k: string) => graph.nodeByKey.get(k);

    const out: Record<EdgeType, { headers: string[]; rows: string[][] }> = {
      'source-table': { headers: vi ? ['Nguồn', 'Loại', 'Bảng'] : ['Source', 'Type', 'Table'], rows: [] },
      'table-dataset': { headers: vi ? ['Bảng', 'Nguồn', 'Dataset', 'Chủ', 'Cập nhật'] : ['Table', 'Source', 'Dataset', 'Owner', 'Updated'], rows: [] },
      'source-dataset': { headers: vi ? ['Nguồn', 'Dataset'] : ['Source', 'Dataset'], rows: [] },
      'dataset-chart': { headers: vi ? ['Dataset', 'Chart', 'Loại'] : ['Dataset', 'Chart', 'Type'], rows: [] },
      'chart-dashboard': { headers: vi ? ['Chart', 'Dashboard', 'Cập nhật'] : ['Chart', 'Dashboard', 'Updated'], rows: [] },
      'dataset-workboard': { headers: vi ? ['Dataset', 'Workboard', 'Trạng thái', 'Cập nhật'] : ['Dataset', 'Workboard', 'Status', 'Updated'], rows: [] },
    };

    for (const e of graph.edges) {
      if (!chain.has(e.from) || !chain.has(e.to)) continue;
      const f = n(e.from);
      const t = n(e.to);
      if (!f || !t) continue;
      if (e.type === 'source-table') {
        out[e.type].rows.push([f.name, f.sub ?? '—', t.name]);
      } else if (e.type === 'table-dataset') {
        const ds = datasetById.get(idOf(e.to));
        out[e.type].rows.push([f.name, f.sub ?? '—', t.name, owner(ds?.owner_email), fmt(ds?.updated_at, vi)]);
      } else if (e.type === 'dataset-chart') {
        out[e.type].rows.push([f.name, t.name, t.sub ?? '—']);
      } else if (e.type === 'chart-dashboard') {
        const db = dashboardById.get(idOf(e.to));
        out[e.type].rows.push([f.name, t.name, fmt(db?.updated_at, vi)]);
      } else if (e.type === 'dataset-workboard') {
        const wb = workboardById.get(idOf(e.to));
        out[e.type].rows.push([f.name, t.name, wb?.is_published ? (vi ? 'Đã publish' : 'Published') : (vi ? 'Nháp' : 'Draft'), fmt(wb?.updated_at, vi)]);
      }
    }
    return out;
  }, [graph, chain, datasets, dashboards, workboards, vi]);

  const [tab, setTab] = useState<EdgeType>('source-table');
  const availableTabs = EDGE_LABEL.filter((e) => tables[e.type].rows.length > 0);
  const activeTab = availableTabs.some((t) => t.type === tab) ? tab : availableTabs[0]?.type ?? 'source-table';

  const details = useMemo(() => {
    const out: Array<{ label: string; value: string }> = [];
    if (node.kind === 'dataset') {
      const d = datasets.find((x) => x.id === node.id);
      if (d) {
        if (d.description) out.push({ label: vi ? 'Mô tả' : 'Description', value: d.description });
        if (d.owner_email) out.push({ label: vi ? 'Chủ sở hữu' : 'Owner', value: d.owner_email });
        out.push({ label: vi ? 'Cập nhật' : 'Updated', value: fmt(d.updated_at, vi) });
      }
    } else if (node.kind === 'source') {
      const s = dataSources.find((x) => x.id === node.id);
      if (s) {
        out.push({ label: vi ? 'Loại' : 'Type', value: node.sub ?? String(s.type) });
        if (s.owner_email) out.push({ label: vi ? 'Chủ sở hữu' : 'Owner', value: s.owner_email });
      }
    } else if (node.kind === 'dashboard') {
      const d = dashboards.find((x) => x.id === node.id);
      if (d) out.push({ label: vi ? 'Cập nhật' : 'Updated', value: fmt(d.updated_at, vi) });
    } else if (node.kind === 'workboard') {
      const w = workboards.find((x) => x.id === node.id);
      if (w) {
        out.push({ label: vi ? 'Trạng thái' : 'Status', value: w.is_published ? (vi ? 'Đã publish' : 'Published') : (vi ? 'Nháp' : 'Draft') });
        out.push({ label: vi ? 'Cập nhật' : 'Updated', value: fmt(w.updated_at, vi) });
      }
    }
    return out;
  }, [node, datasets, dataSources, dashboards, workboards, vi]);

  return (
    <div className="border-t border-[rgb(var(--border-line))] p-3">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand/10 text-brand">
          <Icon className="h-4 w-4" />
        </span>
        <span className="text-caption font-strong text-text-primary">
          {vi ? 'Chi tiết' : 'Drill-down'}: {node.name}
        </span>
        <button
          type="button"
          onClick={() => onOpen({ kind: node.kind, id: node.id })}
          className="ml-2 inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-strong))] px-2 py-1 text-tiny font-emphasis text-text-secondary hover:bg-surface-2"
        >
          <ExternalLink className="h-3 w-3" /> {vi ? 'Mở' : 'Open'}
        </button>
        <button type="button" onClick={onClose} className="ml-auto rounded-md p-1 text-text-quaternary hover:bg-surface-2 hover:text-text-secondary">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        {/* Relationship tabs */}
        <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-2.5">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {availableTabs.length === 0 ? (
              <span className="text-tiny text-text-quaternary">{vi ? 'Không có quan hệ.' : 'No relationships.'}</span>
            ) : (
              availableTabs.map((t) => (
                <button
                  key={t.type}
                  type="button"
                  onClick={() => setTab(t.type)}
                  className={cn(
                    'rounded-md px-2 py-1 text-tiny font-emphasis transition-colors',
                    activeTab === t.type ? 'bg-brand/10 text-brand' : 'text-text-tertiary hover:bg-surface-2',
                  )}
                >
                  {(vi ? t.vi : t.en)} ({tables[t.type].rows.length})
                </button>
              ))
            )}
          </div>
          {availableTabs.length > 0 && (
            <div className="max-h-64 overflow-auto rounded-md border border-[rgb(var(--border-line))]">
              <table className="w-full text-tiny">
                <thead className="sticky top-0 bg-surface-2">
                  <tr>
                    {tables[activeTab].headers.map((h) => (
                      <th key={h} className="px-2.5 py-1.5 text-left font-emphasis uppercase tracking-[0.06em] text-text-quaternary">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tables[activeTab].rows.map((row, i) => (
                    <tr key={i} className="border-t border-[rgb(var(--border-line))] hover:bg-surface-2">
                      {row.map((cell, j) => (
                        <td
                          key={j}
                          className={cn('max-w-[200px] truncate px-2.5 py-1.5', j === 0 ? 'font-emphasis text-text-primary' : 'text-text-secondary')}
                          title={cell}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Details + impact */}
        <div className="space-y-3">
          {details.length > 0 && (
            <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-2.5">
              <h4 className="mb-1.5 text-tiny font-emphasis uppercase tracking-[0.08em] text-text-tertiary">
                {vi ? 'Thông tin' : 'Details'}
              </h4>
              <dl className="space-y-1">
                {details.map((d) => (
                  <div key={d.label} className="flex gap-2 text-tiny">
                    <dt className="w-20 shrink-0 text-text-quaternary">{d.label}</dt>
                    <dd className="min-w-0 flex-1 truncate text-text-secondary" title={d.value}>{d.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-0 p-2.5">
            <h4 className="mb-2 text-tiny font-emphasis uppercase tracking-[0.08em] text-text-tertiary">
              {vi ? 'Ảnh hưởng (xuôi dòng)' : 'Impact (downstream)'}
            </h4>
            <div className="grid grid-cols-3 gap-2 text-center">
              <ImpactStat icon={BarChart3} value={impact.charts} label={vi ? 'Chart' : 'Charts'} />
              <ImpactStat icon={LayoutDashboard} value={impact.dashboards} label={vi ? 'Dashboard' : 'Dashboards'} />
              <ImpactStat icon={ClipboardList} value={impact.workboards} label={vi ? 'Workboard' : 'Workboards'} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ImpactStat({ icon: Icon, value, label }: { icon: LucideIcon; value: number; label: string }) {
  return (
    <div className="rounded-md bg-surface-2 py-2">
      <Icon className="mx-auto mb-1 h-3.5 w-3.5 text-text-tertiary" />
      <div className="text-small font-strong text-text-primary">{value}</div>
      <div className="text-[10px] text-text-quaternary">{label}</div>
    </div>
  );
}

function fmt(value: string | undefined, vi: boolean): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(vi ? 'vi-VN' : 'en-US', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
