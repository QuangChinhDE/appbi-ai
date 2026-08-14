'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Link2, Copy, Check, Trash2, Globe, Filter, Plus, X,
  Eye, EyeOff, Clock, Loader2, ArrowLeft, Lock, Code2, Sparkles,
  Search, ChevronDown,
} from 'lucide-react';
import { dashboardApi, PublicLink } from '@/lib/api/dashboards';
import { chartApi } from '@/lib/api/charts';
import { useFilterDistinctValues } from '@/hooks/use-filter-distinct-values';
import { toast } from '@/lib/toast';
import {
  buildPublicLinkTheme,
  describePublicLinkAppearance,
  normalizePublicLinkAppearance,
} from '@/lib/public-link-appearance';
import { PublicLinkAppearanceEditor } from '@/components/common/PublicLinkAppearanceEditor';
import { PublicLinkAiBotEditor } from '@/components/common/PublicLinkAiBotEditor';
import {
  getFilterDisplayLabel,
  inferColumnTypeFromData,
  type BaseFilter,
  type ColumnInfo,
} from '@/lib/filters';
import type { PublicLinkAppearanceConfig } from '@/types/api';
import { AppModalShell } from '@/components/common/AppModalShell';
import { Button, IconButton } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';

interface PublicLinksManagerProps {
  dashboardId: number;
  dashboardName: string;
  availableColumns?: ColumnInfo[];
  columnChartCount?: Map<string, number>;
  distinctValues?: Record<string, string[]>;
  onClose: () => void;
}

type ModalView = 'list' | 'create' | 'edit';

const DEFAULT_APPEARANCE = normalizePublicLinkAppearance(null);

// Chip-style value editor for a locked/hidden link field (Metabase-like).
// Renders current values as removable chips + an input to add more (Enter or
// comma commits; Backspace on empty removes the last). Always stores an array.
function LinkValueChips({
  value,
  suggestions,
  listId,
  onChange,
}: {
  value: any;
  suggestions: string[];
  listId: string;
  onChange: (next: string[]) => void;
}) {
  const arr: string[] = Array.isArray(value)
    ? value.map((v) => String(v)).filter((v) => v.trim() !== '')
    : (value != null && String(value).trim() !== '' ? [String(value)] : []);
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    raw.split(',').map((s) => s.trim()).filter(Boolean).forEach((t) => {
      if (!arr.includes(t)) arr.push(t);
    });
    onChange([...arr]);
    setDraft('');
  };
  const removeAt = (i: number) => onChange(arr.filter((_, j) => j !== i));
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-1.5 py-1 focus-within:ring-1 focus-within:ring-brand">
      {arr.map((v, i) => (
        <span key={`${v}-${i}`} className="inline-flex items-center gap-1 rounded bg-brand/15 px-1.5 py-0.5 text-tiny text-brand">
          {v}
          <button type="button" onClick={() => removeAt(i)} className="rounded hover:text-danger" title="Bỏ giá trị">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        list={listId}
        onChange={(e) => {
          const v = e.target.value;
          if (v.includes(',')) add(v); else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); add(draft); }
          else if (e.key === 'Backspace' && !draft && arr.length) removeAt(arr.length - 1);
        }}
        onBlur={() => { if (draft.trim()) add(draft); }}
        placeholder={arr.length ? 'thêm…' : 'nhập giá trị rồi Enter…'}
        className="min-w-[90px] flex-1 bg-transparent px-1 py-0.5 text-caption outline-none"
      />
      <datalist id={listId}>
        {suggestions.slice(0, 50).map((v) => <option key={v} value={v} />)}
      </datalist>
    </div>
  );
}

type FieldTypeFilter = ColumnInfo['type'] | 'all';

function getColumnLabel(column: ColumnInfo): string {
  return column.label || column.name;
}

function getColumnSource(column: ColumnInfo): string {
  if (column.tableLabel) return column.tableLabel;
  if (column.datasetName) return column.datasetName;
  if (column.semanticField?.includes('.')) {
    return column.semanticField.split('.').slice(0, -1).join('.');
  }
  return 'Field khác';
}

function getColumnTechnicalName(column: ColumnInfo): string {
  if (column.semanticField && column.semanticField !== column.name) return column.semanticField;
  return column.name;
}

function getColumnTypeLabel(type: ColumnInfo['type']): string {
  switch (type) {
    case 'date':
      return 'Date';
    case 'number':
      return 'Number';
    case 'dropdown':
      return 'List';
    default:
      return 'Text';
  }
}

function getColumnCoverage(column: ColumnInfo, chartCount: Map<string, number>): number {
  return column.chartCoverage ?? chartCount.get(column.name) ?? 0;
}

function PublicLinkFieldPicker({
  columns,
  chartCount,
  loading,
  entryKey,
  onAdd,
}: {
  columns: ColumnInfo[];
  chartCount: Map<string, number>;
  loading: boolean;
  entryKey: (entry: { field: string; semanticField?: string; datasetId?: number }) => string;
  onAdd: (column: ColumnInfo) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<FieldTypeFilter>('all');
  const uniqueColumns = useMemo(() => {
    const seen = new Set<string>();
    const result: ColumnInfo[] = [];
    for (const column of columns) {
      const key = entryKey({
        field: column.name,
        semanticField: column.semanticField,
        datasetId: column.datasetId,
      });
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(column);
    }
    return result;
  }, [columns, entryKey]);
  const disabled = loading || uniqueColumns.length === 0;
  const typeFilters: Array<{ value: FieldTypeFilter; label: string }> = [
    { value: 'all', label: 'Tất cả' },
    { value: 'dropdown', label: 'List' },
    { value: 'text', label: 'Text' },
    { value: 'number', label: 'Number' },
    { value: 'date', label: 'Date' },
  ];

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const buckets = new Map<string, { source: string; maxCoverage: number; items: ColumnInfo[] }>();

    for (const column of uniqueColumns) {
      if (typeFilter !== 'all' && column.type !== typeFilter) continue;
      const label = getColumnLabel(column);
      const source = getColumnSource(column);
      const technicalName = getColumnTechnicalName(column);
      const searchable = [
        label,
        source,
        technicalName,
        column.name,
        column.datasetName,
        column.tableLabel,
        column.type,
      ].filter(Boolean).join(' ').toLowerCase();
      if (needle && !searchable.includes(needle)) continue;

      const coverage = getColumnCoverage(column, chartCount);
      const bucket = buckets.get(source) ?? { source, maxCoverage: 0, items: [] };
      bucket.maxCoverage = Math.max(bucket.maxCoverage, coverage);
      bucket.items.push(column);
      buckets.set(source, bucket);
    }

    for (const bucket of buckets.values()) {
      bucket.items.sort((a, b) => {
        const coverageDiff = getColumnCoverage(b, chartCount) - getColumnCoverage(a, chartCount);
        if (coverageDiff !== 0) return coverageDiff;
        return getColumnLabel(a).localeCompare(getColumnLabel(b));
      });
    }

    return Array.from(buckets.values()).sort((a, b) => {
      if (b.maxCoverage !== a.maxCoverage) return b.maxCoverage - a.maxCoverage;
      return a.source.localeCompare(b.source);
    });
  }, [chartCount, query, typeFilter, uniqueColumns]);

  const resultCount = groups.reduce((sum, group) => sum + group.items.length, 0);

  const addColumn = (column: ColumnInfo) => {
    onAdd(column);
    setOpen(false);
    setQuery('');
    setTypeFilter('all');
  };

  return (
    <div className="mt-3 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2">
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        onClick={() => {
          if (!disabled) setOpen((value) => !value);
        }}
        className={cn(
          'flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
          open ? 'bg-surface-1' : 'hover:bg-surface-1',
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          {loading ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-text-quaternary" />
          ) : (
            <Plus className="h-4 w-4 shrink-0 text-brand" />
          )}
          <span className="min-w-0">
            <span className="block truncate text-caption font-emphasis text-text-primary">
              {loading ? 'Đang tải field...' : uniqueColumns.length > 0 ? 'Thêm field khác' : 'Không còn field để thêm'}
            </span>
            <span className="block truncate text-tiny text-text-quaternary">
              {uniqueColumns.length > 0 ? `${uniqueColumns.length} field khả dụng` : 'Các field hiện có đã nằm trong cấu hình link'}
            </span>
          </span>
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-text-quaternary transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="border-t border-[rgb(var(--border-line))] p-3">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 py-2">
              <Search className="h-4 w-4 shrink-0 text-text-quaternary" />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Tìm theo tên cột, bảng, dataset..."
                className="min-w-0 flex-1 bg-transparent text-caption text-text-secondary outline-none placeholder:text-text-quaternary"
              />
              <span className="shrink-0 text-tiny text-text-quaternary">{resultCount}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {typeFilters.map((item) => {
                const active = typeFilter === item.value;
                return (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setTypeFilter(item.value)}
                    className={cn(
                      'rounded-md border px-2 py-1 text-tiny font-medium transition-colors',
                      active
                        ? 'border-brand/40 bg-brand/15 text-brand'
                        : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-tertiary hover:text-text-secondary',
                    )}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-3 max-h-80 overflow-y-auto rounded-md border border-[rgb(var(--border-line))] bg-surface-1">
            {groups.length === 0 ? (
              <div className="px-3 py-6 text-center text-caption text-text-quaternary">
                Không tìm thấy field phù hợp.
              </div>
            ) : (
              groups.map((group) => (
                <div key={group.source} className="border-b border-[rgb(var(--border-line))] last:border-b-0">
                  <div className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-surface-2 px-3 py-1.5 text-tiny font-emphasis text-text-tertiary">
                    <span className="truncate">{group.source}</span>
                    <span className="shrink-0 text-text-quaternary">{group.items.length}</span>
                  </div>
                  {group.items.map((column, index) => {
                    const coverage = getColumnCoverage(column, chartCount);
                    const columnKey = entryKey({
                      field: column.name,
                      semanticField: column.semanticField,
                      datasetId: column.datasetId,
                    });
                    return (
                      <button
                        key={`${columnKey}-${index}`}
                        type="button"
                        title={getColumnTechnicalName(column)}
                        onClick={() => addColumn(column)}
                        className="group flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-2"
                      >
                        <span className="min-w-0">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-caption font-emphasis text-text-primary">
                              {getColumnLabel(column)}
                            </span>
                            <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-quaternary">
                              {getColumnTypeLabel(column.type)}
                            </span>
                          </span>
                          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-tiny text-text-quaternary">
                            <span className="truncate">{getColumnTechnicalName(column)}</span>
                            {coverage > 0 && <span className="shrink-0">{coverage} chart</span>}
                            {column.sharedAcrossDataset && <span className="shrink-0">toàn dataset</span>}
                          </span>
                        </span>
                        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[rgb(var(--border-line))] bg-surface-1 text-text-quaternary transition-colors group-hover:border-brand/40 group-hover:text-brand">
                          <Plus className="h-3.5 w-3.5" />
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function PublicLinksManager({
  dashboardId,
  dashboardName,
  availableColumns: propColumns,
  columnChartCount: propChartCount,
  distinctValues: propDistinctValues,
  onClose,
}: PublicLinksManagerProps) {
  const [links, setLinks] = useState<PublicLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  const [columns, setColumns] = useState<ColumnInfo[]>(propColumns ?? []);
  const [chartCount, setChartCount] = useState<Map<string, number>>(propChartCount ?? new Map());
  const [dv, setDv] = useState<Record<string, string[]>>(propDistinctValues ?? {});
  const [columnsLoading, setColumnsLoading] = useState(false);

  // Phase-E THẬT (PBI-parity rework) — inherited entries from the
  // owning dashboard. Each one renders a 3-radio Show / Lock-with-value
  // / Hide row. See docs/filter-semantics.md §2.3 and the wireframe
  // confirmed by the user (Slicer #1 + Filter #2 sections).
  const [inheritedSlicers, setInheritedSlicers] = useState<BaseFilter[]>([]);
  const [inheritedFilters, setInheritedFilters] = useState<BaseFilter[]>([]);
  // Per-inherited-entry action; keyed by stable fieldKey or field.
  // `action: 'show'` → don't add anything to link.filters_config
  //                    (viewer sees the entry exactly as the dashboard
  //                    set it).
  // `action: 'lock'` → write {field, operator, value, hidden: false}
  //                    using the override value the author entered.
  // `action: 'limit'`→ write {field, operator:'in', value, limit: true}.
  //                    Slicer stays INTERACTIVE on the public link but the
  //                    viewer can only pick within this allow-list (e.g. 3 of
  //                    5 RCs). BE bounds data + dropdown server-side.
  // `action: 'hide'` → write {field, hidden: true} so the BE merger
  //                    drops the field entirely.
  type LinkEntryAction = { action: 'show' | 'lock' | 'limit' | 'hide'; value?: any };
  const [linkActions, setLinkActions] = useState<Record<string, LinkEntryAction>>({});

  const [view, setView] = useState<ModalView>('list');
  const [editingLink, setEditingLink] = useState<PublicLink | null>(null);
  // Whether this report has a MATERIALIZED source (BigQuery w/ materialization).
  // Only then does the snapshot-freshness TTL selector make sense — otherwise the
  // report is live/cached and we hide it. Fetched once when the modal opens.
  const [snapshotEnabled, setSnapshotEnabled] = useState(false);
  useEffect(() => {
    // The manager is a modal mounted on open — fetch the report's snapshot mode
    // once so the appearance editor can show the TTL selector only when a
    // materialized (snapshot) source actually backs the report.
    let cancelled = false;
    dashboardApi
      .getSnapshotInfo(dashboardId)
      .then((info) => { if (!cancelled) setSnapshotEnabled(info?.mode === 'snapshot'); })
      .catch(() => { if (!cancelled) setSnapshotEnabled(false); });
    return () => { cancelled = true; };
  }, [dashboardId]);

  const [formName, setFormName] = useState('');
  // Unified-table rework (2026-06-18) — the link's filter UI is now ONE
  // table: every shareable field is a row with a Show / Lock / Hide
  // choice (state in `linkActions`). `extraRows` holds fields that are
  // NOT inherited dashboard slicers/filters but the author chose to gate
  // anyway (replaces the old "Access filters" escape-hatch + "Hidden
  // fields" sections, which overlapped and confused authors). Each is a
  // BaseFilter carrying field/semanticField/datasetId identity.
  const [extraRows, setExtraRows] = useState<BaseFilter[]>([]);
  const [formAppearance, setFormAppearance] = useState<PublicLinkAppearanceConfig>(DEFAULT_APPEARANCE);
  const [formPassword, setFormPassword] = useState('');
  const [passwordEnabled, setPasswordEnabled] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [changePassword, setChangePassword] = useState(false);
  const [previewMode, setPreviewMode] = useState<'public' | 'embed'>('public');
  // Create/Edit form is split into 3 intent-based tabs so the modal isn't
  // one long scroll: appearance (look/behaviour), data (link filters),
  // security (password + share URLs). The preview panel stays on the right.
  const [formTab, setFormTab] = useState<'appearance' | 'data' | 'security' | 'aibot'>('appearance');

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [copiedEmbedId, setCopiedEmbedId] = useState<number | null>(null);
  const [copiedSnippetId, setCopiedSnippetId] = useState<number | null>(null);

  const getEmbedUrl = (link: PublicLink) => `${origin.replace(/\/$/, '')}/embed/${link.token}`;

  const getIframeSnippet = (link: PublicLink) =>
    `<iframe\n  src="${getEmbedUrl(link)}"\n  loading="lazy"\n  style="width:100%;min-height:680px;border:0;border-radius:24px;background:#f8fafc;"\n  referrerpolicy="strict-origin-when-cross-origin"\n  title="${link.name.replace(/"/g, '&quot;')}"\n></iframe>`;

  const copyText = (text: string, onDone: () => void) => {
    navigator.clipboard.writeText(text).then(onDone).catch(() => toast.error('Failed to copy'));
  };

  const fetchColumnData = useCallback(async () => {
    // Always refresh inherited entries from BE even when the parent
    // pre-supplied columns — slicers_config + filters_config travel
    // on the dashboard object, not on the column list.
    try {
      const dash = await dashboardApi.getById(dashboardId);
      const dashSlicers = Array.isArray((dash as any).slicers_config)
        ? ((dash as any).slicers_config as BaseFilter[]) : [];
      const dashFilters = Array.isArray((dash as any).filters_config)
        ? ((dash as any).filters_config as BaseFilter[]) : [];
      // Also surface PER-PAGE slicers + filters so the link modal lists EVERY
      // gateable field — a slicer set to "Trang này" or a page-level filter
      // used to be invisible here (only addable via "+ Thêm field"). Tag each
      // with its page name for the row badge. Link RLS is field-wide, so a
      // field appearing on several pages is shown once (dedup in unifiedRows).
      const pageSlicers: BaseFilter[] = [];
      const pageFilters: BaseFilter[] = [];
      for (const pg of ((dash as any).pages_config || [])) {
        if (!pg || typeof pg !== 'object') continue;
        const pname = (pg.name || pg.id || '') as string;
        for (const s of (pg.slicers || [])) {
          if (s && typeof s === 'object' && (s as any).field) pageSlicers.push({ ...(s as any), _pageName: pname });
        }
        for (const f of (pg.filters || [])) {
          if (f && typeof f === 'object' && (f as any).field) pageFilters.push({ ...(f as any), _pageName: pname });
        }
      }
      setInheritedSlicers([...dashSlicers, ...pageSlicers]);
      setInheritedFilters([...dashFilters, ...pageFilters]);
    } catch {
      // non-critical — section just renders empty
    }

    if ((propColumns?.length ?? 0) > 0) return;
    setColumnsLoading(true);
    try {
      const dash = await dashboardApi.getById(dashboardId);
      const charts = dash.dashboard_charts ?? [];
      if (!charts.length) return;

      const colMap = new Map<string, ColumnInfo>();
      const countMap = new Map<string, Set<number>>();
      const dvMap = new Map<string, Set<string>>();

      await Promise.all(
        charts.map(async (dc) => {
          try {
            const resp = await chartApi.getData(dc.chart_id, undefined, 'dashboard');
            const rows = resp?.data ?? [];
            if (!rows.length) return;

            const fields = Object.keys(rows[0]);
            for (const field of fields) {
              if (!colMap.has(field)) {
                colMap.set(field, { name: field, type: inferColumnTypeFromData(field, rows) });
              }
              if (!countMap.has(field)) countMap.set(field, new Set());
              countMap.get(field)?.add(dc.chart_id);

              if (!dvMap.has(field)) dvMap.set(field, new Set());
              const set = dvMap.get(field);
              for (const row of rows) {
                const val = row[field];
                if (val !== null && val !== undefined && String(val) !== '') {
                  set?.add(String(val));
                }
              }
            }
          } catch {
            // skip failed charts
          }
        }),
      );

      const totalCharts = charts.length;
      const sortedCols = Array.from(colMap.values())
        .map((column) => {
          const coverage = countMap.get(column.name)?.size ?? 0;
          return {
            ...column,
            chartCoverage: coverage,
            datasetChartCount: totalCharts,
            sharedAcrossDataset: totalCharts > 0 && coverage === totalCharts,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      setColumns(sortedCols);
      setChartCount(new Map(Array.from(countMap.entries()).map(([k, s]) => [k, s.size])));
      const result: Record<string, string[]> = {};
      dvMap.forEach((set, field) => { result[field] = Array.from(set).sort(); });
      setDv(result);
    } catch {
      // non-critical
    } finally {
      setColumnsLoading(false);
    }
  }, [dashboardId, propColumns]);

  const fetchLinks = useCallback(async () => {
    try {
      const data = await dashboardApi.listPublicLinks(dashboardId);
      setLinks(data);
    } catch {
      toast.error('Failed to load public links');
    } finally {
      setLoading(false);
    }
  }, [dashboardId]);

  useEffect(() => {
    fetchLinks();
    fetchColumnData();
  }, [fetchLinks, fetchColumnData]);

  const activeColumns: ColumnInfo[] = (propColumns?.length ?? 0) > 0 ? propColumns ?? [] : columns;
  const baseDistinctValues: Record<string, string[]> = Object.keys(propDistinctValues ?? {}).length > 0
    ? propDistinctValues ?? {}
    : dv;
  // Distinct-value targets: every gateable field, NOT just author-added extra
  // rows. The old code passed only `extraRows`, so locking/limiting an
  // INHERITED slicer (e.g. an RLS column "RC" that is a slicer but not a
  // chart dimension) left its value picker empty — the author couldn't see
  // RC01/RC02/… to choose. Feed inherited slicers + filters too so
  // useFilterDistinctValues fetches their full domain from
  // /datasets/{id}/model/distinct-values.
  const distinctFilterTargets = useMemo(
    () => [...inheritedSlicers, ...inheritedFilters, ...extraRows],
    [inheritedSlicers, inheritedFilters, extraRows],
  );
  const { distinctValues: activeDistinctValues } =
    useFilterDistinctValues(activeColumns, distinctFilterTargets, baseDistinctValues);

  // ── Unified link-filter table ─────────────────────────────────────
  // Stable identity for a row, mirroring the BE dedupe shape
  // (semanticField first, then bare field, then datasetId).
  const entryKey = useCallback((entry: { field: string; semanticField?: string; datasetId?: number }): string => {
    const sem = (entry.semanticField || '').toLowerCase();
    const ds = entry.datasetId ?? '';
    return sem ? `${ds}|${sem}` : `${ds}|${entry.field.toLowerCase()}`;
  }, []);

  // Source classification + the default action a row starts on.
  type LinkRowSource = 'slicer' | 'filter' | 'extra';
  interface LinkFieldRow {
    key: string;
    field: string;
    semanticField?: string;
    datasetId?: number;
    label: string;
    value?: any;
    source: LinkRowSource;
    dashboardMode?: string; // for filter-pane rows: the dashboard publicMode
    pageName?: string;      // set when the row came from a per-page slicer/filter
  }
  const defaultActionForRow = useCallback((row: LinkFieldRow): LinkEntryAction['action'] => {
    if (row.source === 'extra') return 'lock';
    if (row.source === 'slicer') return 'show';
    // filter-pane row inherits the dashboard's publicMode intent
    const mode = (row.dashboardMode || 'visible').toLowerCase();
    return mode === 'hidden' ? 'hide' : mode === 'locked' ? 'lock' : 'show';
  }, []);

  // Build the single list of rows: inherited slicers (#1) + inherited
  // filter-pane entries (#2) + author-added extra gates (#3). De-duped
  // by field key; an inherited row wins over an extra one on the same
  // field so the author never sees the same field twice.
  const unifiedRows = useMemo<LinkFieldRow[]>(() => {
    const rows: LinkFieldRow[] = [];
    const seen = new Set<string>();
    const push = (entry: BaseFilter, source: LinkRowSource) => {
      const key = entryKey(entry as any);
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({
        key,
        field: entry.field,
        semanticField: entry.semanticField,
        datasetId: entry.datasetId,
        label: (entry as any).label || entry.semanticField || entry.field,
        value: entry.value,
        source,
        dashboardMode: (entry as any).publicMode,
        pageName: (entry as any)._pageName || undefined,
      });
    };
    for (const s of inheritedSlicers) push(s, 'slicer');
    for (const f of inheritedFilters) push(f, 'filter');
    for (const x of extraRows) push(x, 'extra');
    return rows;
  }, [inheritedSlicers, inheritedFilters, extraRows, entryKey]);

  // The action actually in effect for a row (explicit choice or default).
  const effectiveAction = useCallback((row: LinkFieldRow): LinkEntryAction['action'] =>
    linkActions[row.key]?.action ?? defaultActionForRow(row),
  [linkActions, defaultActionForRow]);

  // Columns the author can still ADD as an extra gate (not already a row).
  const addableColumns = useMemo(() => {
    const present = new Set(unifiedRows.map((r) => r.key));
    return activeColumns.filter((c) => !present.has(entryKey({
      field: c.name, semanticField: c.semanticField, datasetId: c.datasetId,
    })));
  }, [activeColumns, unifiedRows, entryKey]);

  const addExtraField = useCallback((column: ColumnInfo) => {
    const newRow = {
      id: `link-extra-${entryKey({
        field: column.name,
        semanticField: column.semanticField,
        datasetId: column.datasetId,
      })}`,
      field: column.name,
      fieldKey: column.key,
      semanticField: column.semanticField,
      datasetId: column.datasetId,
      linkedFields: column.defaultLinkedFields,
      label: column.label || column.name,
      type: column.type,
      operator: 'in',
      value: [],
    } as BaseFilter;
    const key = entryKey(newRow);
    setExtraRows((prev) => (
      prev.some((row) => entryKey(row) === key) ? prev : [...prev, newRow]
    ));
    setLinkActions((prev) => ({
      ...prev,
      [key]: prev[key] ?? { action: 'lock', value: undefined },
    }));
  }, [entryKey]);

  const requiresPasswordValue = passwordEnabled && (
    view === 'create'
    || changePassword
    || !editingLink?.has_password
  );
  const isPasswordFormValid = !requiresPasswordValue || formPassword.trim().length > 0;
  const previewTheme = useMemo(() => buildPublicLinkTheme(formAppearance), [formAppearance]);
  const previewAppearance = previewTheme.appearance;
  const previewLinkName = formName.trim() || dashboardName;
  const previewTitle = previewAppearance.headline ?? previewLinkName;
  // How many fields this link actually gates (lock or hide), for the
  // summary chip. 'show' rows inherit the dashboard and don't count.
  const configuredAccessFilterCount = useMemo(
    () => unifiedRows.filter((row) => effectiveAction(row) !== 'show').length,
    [unifiedRows, effectiveAction],
  );

  const resolvePasswordPayload = (): { password?: string; validationError?: string } => {
    const trimmedPassword = formPassword.trim();

    if (view === 'create') {
      if (!passwordEnabled) return {};
      if (!trimmedPassword) {
        return { validationError: 'Please enter a password or choose no password' };
      }
      return { password: trimmedPassword };
    }

    if (!editingLink) return {};

    if (!changePassword) {
      return {};
    }

    if (!passwordEnabled) {
      return editingLink.has_password ? { password: '' } : {};
    }

    if (!trimmedPassword) {
      return { validationError: 'Please enter a password' };
    }

    return { password: trimmedPassword };
  };

  const handleCreate = async () => {
    if (!formName.trim()) {
      toast.error('Please enter a name');
      return;
    }
    const { password, validationError } = resolvePasswordPayload();
    if (validationError) {
      toast.error(validationError);
      return;
    }
    const emptyCreate = emptyEnforcedRows();
    if (emptyCreate.length) {
      toast.error(`Chọn giá trị cho field đang Khoá/Ẩn (${emptyCreate.join(', ')}), hoặc chuyển về 👁 Hiện.`);
      return;
    }
    setCreating(true);
    try {
      const link = await dashboardApi.createPublicLink(dashboardId, {
        name: formName.trim(),
        // Unified table → one entry per gated field (see buildLinkFiltersPayload).
        filters_config: buildLinkFiltersPayload(linkActions, unifiedRows),
        appearance_config: formAppearance,
        password,
      });
      setLinks((prev) => [link, ...prev]);
      resetForm();
      setView('list');
      toast.success('Public link created');
    } catch {
      toast.error('Failed to create link');
    } finally {
      setCreating(false);
    }
  };

  const handleUpdate = async () => {
    if (!editingLink) return;
    const { password, validationError } = resolvePasswordPayload();
    if (validationError) {
      toast.error(validationError);
      return;
    }
    const emptyUpdate = emptyEnforcedRows();
    if (emptyUpdate.length) {
      toast.error(`Chọn giá trị cho field đang Khoá/Ẩn (${emptyUpdate.join(', ')}), hoặc chuyển về 👁 Hiện.`);
      return;
    }
    setSaving(true);
    try {
      const passwordField: { password?: string } = {};
      if (password !== undefined) {
        passwordField.password = password;
      }
      const updated = await dashboardApi.updatePublicLink(dashboardId, editingLink.id, {
        name: formName.trim() || undefined,
        // Unified table → one entry per gated field (see buildLinkFiltersPayload).
        filters_config: buildLinkFiltersPayload(linkActions, unifiedRows),
        appearance_config: formAppearance,
        ...passwordField,
      });
      setLinks((prev) => prev.map((link) => (link.id === editingLink.id ? updated : link)));
      resetForm();
      setView('list');
      toast.success('Link updated');
    } catch {
      toast.error('Failed to update link');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (link: PublicLink, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const updated = await dashboardApi.updatePublicLink(dashboardId, link.id, {
        is_active: !link.is_active,
      });
      setLinks((prev) => prev.map((item) => (item.id === link.id ? updated : item)));
      toast.success(updated.is_active ? 'Link activated' : 'Link deactivated');
    } catch {
      toast.error('Failed to toggle link');
    }
  };

  const handleDelete = async (link: PublicLink, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await dashboardApi.deletePublicLink(dashboardId, link.id);
      setLinks((prev) => prev.filter((item) => item.id !== link.id));
      toast.success('Link deleted');
    } catch {
      toast.error('Failed to delete link');
    }
  };

  const openEdit = (link: PublicLink) => {
    setEditingLink(link);
    setFormName(link.name);
    // Parse the link's filters_config into per-row actions + any extra
    // (non-inherited) rows so the unified table re-renders the saved state.
    {
      const raw = (link.filters_config ?? []) as any[];
      const parsed = parseExistingLinkFilters(
        raw,
        [...inheritedSlicers, ...inheritedFilters],
      );
      setLinkActions(parsed.actions);
      setExtraRows(parsed.extra);
    }
    setFormAppearance({
      ...normalizePublicLinkAppearance(link.appearance_config),
      // normalizePublicLinkAppearance strips AI bot fields (they are not in
      // NormalizedPublicLinkAppearanceConfig). Restore them from the raw config.
      ai_bot_enabled: link.appearance_config?.ai_bot_enabled,
      ai_bot_provider: link.appearance_config?.ai_bot_provider,
      ai_bot_model: link.appearance_config?.ai_bot_model,
      ai_bot_web_search_enabled: link.appearance_config?.ai_bot_web_search_enabled,
      ai_bot_report_context_note: link.appearance_config?.ai_bot_report_context_note,
      // ai_bot_key is stripped by backend response (security). Use
      // ai_bot_key_configured to show "key is set" indicator in the editor.
      ai_bot_key: undefined,
      ai_bot_key_configured: link.appearance_config?.ai_bot_key_configured,
    });
    setFormPassword('');
    setPasswordEnabled(link.has_password);
    setShowPassword(false);
    setChangePassword(false);
    setPreviewMode('public');
    setFormTab('appearance');
    setView('edit');
  };

  const openCreate = () => {
    resetForm();
    setView('create');
  };

  const resetForm = () => {
    setFormName('');
    setExtraRows([]);
    setLinkActions({});
    setFormAppearance(DEFAULT_APPEARANCE);
    setFormPassword('');
    setPasswordEnabled(false);
    setShowPassword(false);
    setChangePassword(false);
    setPreviewMode('public');
    setFormTab('appearance');
    setEditingLink(null);
  };

  // Serialize the unified rows + their per-row actions into the BE wire
  // shape for `DashboardPublicLink.filters_config`. One row → at most one
  // entry: 'show' inherits (no entry), 'hide' → {…, hidden:true}, 'lock'
  // → a value-bearing entry. See docs/filter-semantics.md §2.3.
  const buildLinkFiltersPayload = (
    actions: Record<string, LinkEntryAction>,
    rows: LinkFieldRow[],
  ): any[] => {
    const out: any[] = [];
    for (const row of rows) {
      const action = actions[row.key]?.action ?? defaultActionForRow(row);
      if (action === 'show') continue;
      // 'lock'/'hide'/'limit' all ENFORCE a value (PBI parity). 'hide' adds
      // `hidden:true` so the public viewer suppresses its banner/control;
      // 'limit' adds `limit:true` so the BE bounds (intersects) the viewer's
      // pick to this allow-list while KEEPING the slicer interactive. Use the
      // author's override value, falling back to the dashboard's saved value.
      // Align operator with value shape: an array value forces in/not_in
      // (a scalar `eq` over a list emits invalid SQL `WHERE field = ('A','B')`).
      const overrideValue = actions[row.key]?.value !== undefined ? actions[row.key]?.value : row.value;
      const inheritedOp = (row as any).operator || 'in';
      // A 'limit' allow-list is inherently a multi-value IN set.
      const effectiveOp = action === 'limit'
        ? 'in'
        : Array.isArray(overrideValue)
          ? (inheritedOp === 'not_in' ? 'not_in' : 'in')
          : inheritedOp;
      out.push({
        field: row.field,
        semanticField: row.semanticField,
        datasetId: row.datasetId,
        operator: effectiveOp,
        value: overrideValue,
        ...(action === 'hide' ? { hidden: true } : {}),
        ...(action === 'limit' ? { limit: true } : {}),
      });
    }
    return out;
  };

  // Validate-on-save: a 'lock'/'hide' row with NO value enforces nothing at the
  // BE (the merge drops empty entries) yet would strip the field's control +
  // same-field page filter — silently widening what the viewer sees past the
  // page scope (the dashboard-53 empty-lock leak). Mirrors the BE single source
  // of truth `filter_layered_merge.link_entry_has_value`. Returns the labels of
  // offending rows so the author can fix them or switch back to 👁 Hiện.
  const emptyEnforcedRows = (): string[] => {
    const isEmpty = (v: any): boolean => {
      if (Array.isArray(v)) return v.length === 0;
      if (v && typeof v === 'object') return Object.keys(v).length === 0;
      return v === null || v === undefined || String(v).trim() === '';
    };
    const bad: string[] = [];
    for (const row of unifiedRows) {
      const action = linkActions[row.key]?.action ?? defaultActionForRow(row);
      if (action === 'show') continue;
      // 'limit' needs ≥1 allowed value too — an empty allow-list bounds
      // nothing (would silently behave like 👁 Hiện = full domain).
      const overrideValue = linkActions[row.key]?.value !== undefined
        ? linkActions[row.key]?.value
        : (row as any).value;
      if (isEmpty(overrideValue)) bad.push((row as any).label || row.field);
    }
    return bad;
  };

  // Parse an existing link.filters_config back into per-row actions +
  // the set of extra (non-inherited) rows that must still render. An
  // entry that matches an inherited slicer/filter becomes an action on
  // that row; anything else becomes an extra row carrying its identity.
  const parseExistingLinkFilters = (
    raw: any[],
    inherited: BaseFilter[],
  ): { actions: Record<string, LinkEntryAction>; extra: BaseFilter[] } => {
    const inheritedByKey = new Map<string, BaseFilter>();
    for (const e of inherited) inheritedByKey.set(entryKey(e), e);
    const actions: Record<string, LinkEntryAction> = {};
    const extra: BaseFilter[] = [];
    for (const entry of raw || []) {
      if (!entry || typeof entry !== 'object') continue;
      const key = entryKey(entry);
      const isHidden = entry.hidden === true;
      const isLimit = entry.limit === true && !isHidden;
      // hide + lock + limit all carry a value (PBI: hide also enforces;
      // limit is the interactive allow-list).
      actions[key] = {
        action: isHidden ? 'hide' : isLimit ? 'limit' : 'lock',
        value: entry.value,
      };
      if (!inheritedByKey.has(key)) {
        // Non-inherited gate — keep it as a visible row so the author
        // can see and change it (was the old "Access filters" / "Hidden
        // fields" leftover).
        extra.push(entry as BaseFilter);
      }
    }
    return { actions, extra };
  };

  const goBack = () => {
    resetForm();
    setView('list');
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    const d = new Date(dateStr);
    return d.toLocaleDateString('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatFilterSummary = (filters: BaseFilter[] | null): string => {
    if (!filters?.length) return 'No filters, all data is visible.';
    const names = filters.map((filter) => getFilterDisplayLabel(filter)).join(', ');
    return `Filtered by ${names}`;
  };

  const renderConfiguratorPreview = () => {
    const showEmbedHeader = true;
    const previewUrl = previewMode === 'public'
      ? `${origin.replace(/\/$/, '')}/d/${editingLink?.token ?? 'preview-token'}`
      : `${origin.replace(/\/$/, '')}/embed/${editingLink?.token ?? 'preview-token'}`;

    return (
      <div className="space-y-4 lg:sticky lg:top-0">
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-tiny font-strong uppercase tracking-[0.14em] text-text-quaternary">Preview before publish</p>
              <p className="mt-1 text-caption text-text-tertiary">Switch between the full public page and iframe embed surface.</p>
            </div>
            <div className="flex items-center rounded-full border border-[rgb(var(--border-line))] bg-surface-2 p-1">
              <button
                type="button"
                onClick={() => setPreviewMode('public')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-tiny font-emphasis transition-colors',
                  previewMode === 'public'
                    ? 'bg-brand text-text-inverse shadow-linear-sm'
                    : 'text-text-tertiary hover:text-text-secondary',
                )}
              >
                <Globe className="h-3.5 w-3.5" />
                Public page
              </button>
              <button
                type="button"
                onClick={() => setPreviewMode('embed')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-tiny font-emphasis transition-colors',
                  previewMode === 'embed'
                    ? 'bg-brand text-text-inverse shadow-linear-sm'
                    : 'text-text-tertiary hover:text-text-secondary',
                )}
              >
                <Code2 className="h-3.5 w-3.5" />
                Embed
              </button>
            </div>
          </div>

          <div className="mt-4 overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
            <div className="flex items-center gap-2 border-b border-[rgb(var(--border-line))] px-4 py-2.5" style={previewTheme.topBarStyle}>
              <span className="h-2.5 w-2.5 rounded-full bg-danger/60" />
              <span className="h-2.5 w-2.5 rounded-full bg-warning/60" />
              <span className="h-2.5 w-2.5 rounded-full bg-success/60" />
              <span className="ml-2 min-w-0 truncate text-tiny text-text-tertiary">{previewUrl}</span>
            </div>

            {previewMode === 'public' ? (
              <div className="space-y-4 p-4" style={previewTheme.pageStyle}>
                <div className="rounded-xl border p-3" style={previewTheme.panelStyle}>
                  <div className="flex flex-col gap-3">
                    <h4 className="truncate text-small font-strong tracking-tight text-text-primary">{previewTitle}</h4>

                    <div className="flex flex-wrap gap-2">
                      <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={previewTheme.accentPillStyle}>
                        Compact report rail
                      </span>
                      {previewAppearance.show_page_tabs && (
                        <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={previewTheme.neutralPillStyle}>
                          Page tabs visible
                        </span>
                      )}
                      <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={previewTheme.neutralPillStyle}>
                        {previewAppearance.allow_viewer_filters ? 'Viewer filters enabled' : 'Viewer filters hidden'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border p-3" style={previewTheme.canvasFrameStyle}>
                  <div className="rounded-lg p-3" style={previewTheme.canvasInnerStyle}>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="h-28 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1" />
                      <div className="h-28 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1" />
                      <div className="h-36 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 sm:col-span-2" />
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3 p-4" style={previewTheme.pageStyle}>
                <div className="overflow-hidden rounded-xl border" style={previewTheme.shellStyle}>
                  {showEmbedHeader ? (
                    <div className="border-b px-4 py-3" style={previewTheme.panelStyle}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h4 className="truncate text-small font-strong text-text-primary">{previewTitle}</h4>
                        </div>
                        <span className="rounded-full border px-2.5 py-1 text-tiny font-emphasis" style={previewTheme.neutralPillStyle}>
                          Compact viewer rail
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="border-b px-4 py-3 text-tiny text-text-tertiary" style={previewTheme.panelStyle}>
                      Embed header hidden, report starts immediately with controls and canvas.
                    </div>
                  )}

                  <div className="border-b px-4 py-3" style={previewTheme.panelStyle}>
                    <div className="flex flex-wrap gap-2">
                      {previewAppearance.show_page_tabs && (
                        <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={previewTheme.accentPillStyle}>
                          Tabs
                        </span>
                      )}
                      <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={previewTheme.neutralPillStyle}>
                        {previewAppearance.allow_viewer_filters ? 'Interactive filters' : 'Locked view'}
                      </span>
                    </div>
                  </div>

                  <div className="p-3">
                    <div className="rounded-xl border p-3" style={previewTheme.canvasFrameStyle}>
                      <div className="rounded-lg p-3" style={previewTheme.canvasInnerStyle}>
                        <div className="grid gap-3">
                          <div className="h-24 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1" />
                          <div className="h-36 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
          <p className="text-tiny font-strong uppercase tracking-[0.14em] text-text-quaternary">Publishing summary</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
              <p className="text-tiny font-emphasis text-text-tertiary">Access scope</p>
              <p className="mt-1 text-caption font-strong text-text-primary">
                {configuredAccessFilterCount > 0 ? `${configuredAccessFilterCount} access filter${configuredAccessFilterCount === 1 ? '' : 's'}` : 'All dashboard data'}
              </p>
            </div>
            <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
              <p className="text-tiny font-emphasis text-text-tertiary">Viewer controls</p>
              <p className="mt-1 text-caption font-strong text-text-primary">
                {previewAppearance.allow_viewer_filters ? 'Interactive' : 'Read-only without filter controls'}
              </p>
            </div>
            <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
              <p className="text-tiny font-emphasis text-text-tertiary">Viewer layout</p>
              <p className="mt-1 text-caption font-strong text-text-primary">Compact control rail + full-width canvas</p>
            </div>
            <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
              <p className="text-tiny font-emphasis text-text-tertiary">Security</p>
              <p className="mt-1 text-caption font-strong text-text-primary">{passwordEnabled ? 'Password required' : 'Open link access'}</p>
            </div>
          </div>
        </div>

      </div>
    );
  };

  // Share outputs (page URL + embed URL/snippet) — only meaningful once a
  // link exists. Lives in the "Bảo mật & Chia sẻ" tab.
  const renderShareOutputs = () => {
    if (!(view === 'edit' && editingLink?.is_active)) return null;
    return (
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
        <div className="flex items-center gap-2 text-text-primary">
          <Link2 className="h-4 w-4 text-brand" />
          <h3 className="text-small font-strong">Link chia sẻ</h3>
        </div>
        <p className="mt-2 text-caption leading-6 text-text-tertiary">
          Link trang công khai và mã nhúng iframe cho link này.
        </p>
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
            <Link2 className="h-4 w-4 text-text-quaternary" />
            <span className="min-w-0 flex-1 truncate text-tiny font-mono text-text-tertiary">
              {origin.replace(/\/$/, '')}/d/{editingLink!.token}
            </span>
            <IconButton
              aria-label="Copy page URL"
              variant="ghost"
              size="sm"
              onClick={() => {
                copyText(`${origin.replace(/\/$/, '')}/d/${editingLink!.token}`, () => {
                  setCopiedId(editingLink!.id);
                  setTimeout(() => setCopiedId(null), 2000);
                });
              }}
            >
              {copiedId === editingLink!.id ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
            </IconButton>
          </div>

          <div className="flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
            <Code2 className="h-4 w-4 text-text-quaternary" />
            <span className="min-w-0 flex-1 truncate text-tiny font-mono text-text-tertiary">
              {getEmbedUrl(editingLink!)}
            </span>
            <IconButton
              aria-label="Copy embed URL"
              variant="ghost"
              size="sm"
              onClick={() => {
                copyText(getEmbedUrl(editingLink!), () => {
                  setCopiedEmbedId(editingLink!.id);
                  setTimeout(() => setCopiedEmbedId(null), 2000);
                });
              }}
            >
              {copiedEmbedId === editingLink!.id ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
            </IconButton>
            <Button
              variant="secondary"
              size="xs"
              onClick={() => {
                copyText(getIframeSnippet(editingLink!), () => {
                  setCopiedSnippetId(editingLink!.id);
                  setTimeout(() => setCopiedSnippetId(null), 2000);
                });
              }}
            >
              {copiedSnippetId === editingLink!.id ? 'Copied' : '</>'}
            </Button>
          </div>
        </div>
      </div>
    );
  };

  const renderLinkCard = (link: PublicLink) => {
    const appearanceSummary = describePublicLinkAppearance(link.appearance_config);
    const theme = buildPublicLinkTheme(link.appearance_config);
    const appearance = theme.appearance;
    const previewTitle = appearance.headline ?? link.name;

    return (
      <div
        key={link.id}
        onClick={() => openEdit(link)}
        className="cursor-pointer rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4 shadow-linear-sm transition hover:shadow-linear"
      >
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr),320px]">
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-small font-strong text-text-primary">{link.name}</h3>
                  {!link.is_active && (
                    <Badge variant="neutral" size="sm">Inactive</Badge>
                  )}
                  {link.has_password && (
                    <Badge variant="warning" size="sm">
                      <Lock className="h-3 w-3" />
                      Password
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-caption text-text-tertiary">{formatFilterSummary((link.filters_config ?? []) as BaseFilter[])}</p>
              </div>

              <div className="flex items-center gap-1">
                <IconButton
                  aria-label={link.is_active ? 'Deactivate' : 'Activate'}
                  variant="ghost"
                  size="sm"
                  onClick={(event) => handleToggleActive(link, event)}
                >
                  {link.is_active ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </IconButton>
                <IconButton
                  aria-label="Delete"
                  variant="ghost"
                  size="sm"
                  onClick={(event) => handleDelete(link, event)}
                  className="hover:text-danger"
                >
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={theme.accentPillStyle}>
                {appearanceSummary.presetLabel}
              </span>
              <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={theme.neutralPillStyle}>
                {appearanceSummary.accentLabel}
              </span>
              {!appearance.allow_viewer_filters && (
                <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={theme.neutralPillStyle}>
                  Filters hidden
                </span>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-3">
                <p className="flex items-center gap-1 text-tiny font-emphasis text-text-tertiary">
                  <Eye className="h-3.5 w-3.5" />
                  Views
                </p>
                <p className="mt-2 text-body font-strong text-text-primary">{link.access_count}</p>
              </div>
              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-3">
                <p className="flex items-center gap-1 text-tiny font-emphasis text-text-tertiary">
                  <Clock className="h-3.5 w-3.5" />
                  Last access
                </p>
                <p className="mt-2 text-caption font-emphasis text-text-secondary">{formatDate(link.last_accessed_at)}</p>
              </div>
              <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-3">
                <p className="text-tiny font-emphasis text-text-tertiary">Created</p>
                <p className="mt-2 text-caption font-emphasis text-text-secondary">{formatDate(link.created_at)}</p>
              </div>
            </div>

            {link.is_active && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
                  <Link2 className="h-4 w-4 text-text-quaternary" />
                  <span className="min-w-0 flex-1 truncate text-tiny font-mono text-text-tertiary">
                    {origin.replace(/\/$/, '')}/d/{link.token}
                  </span>
                  <IconButton
                    aria-label="Copy page URL"
                    variant="ghost"
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation();
                      copyText(`${origin.replace(/\/$/, '')}/d/${link.token}`, () => {
                        setCopiedId(link.id);
                        setTimeout(() => setCopiedId(null), 2000);
                      });
                    }}
                  >
                    {copiedId === link.id ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                  </IconButton>
                </div>

                <div className="flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
                  <Code2 className="h-4 w-4 text-text-quaternary" />
                  <span className="min-w-0 flex-1 truncate text-tiny font-mono text-text-tertiary">
                    {origin.replace(/\/$/, '')}/embed/{link.token}
                  </span>
                  <IconButton
                    aria-label="Copy embed URL"
                    variant="ghost"
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation();
                      copyText(getEmbedUrl(link), () => {
                        setCopiedEmbedId(link.id);
                        setTimeout(() => setCopiedEmbedId(null), 2000);
                      });
                    }}
                  >
                    {copiedEmbedId === link.id ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                  </IconButton>
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={(event) => {
                      event.stopPropagation();
                      copyText(getIframeSnippet(link), () => {
                        setCopiedSnippetId(link.id);
                        setTimeout(() => setCopiedSnippetId(null), 2000);
                      });
                    }}
                  >
                    {copiedSnippetId === link.id ? 'Copied' : '</>'}
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div
            className="overflow-hidden rounded-xl border"
            style={theme.heroStyle}
          >
            <div className="space-y-4 p-5">
              <h4 className="text-body font-strong tracking-tight text-text-primary">{previewTitle}</h4>
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={theme.accentPillStyle}>
                  Compact rail
                </span>
                {appearance.show_page_tabs && (
                  <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={theme.neutralPillStyle}>
                    Tabs on
                  </span>
                )}
                <span className="rounded-full border px-3 py-1 text-tiny font-emphasis" style={theme.neutralPillStyle}>
                  {appearance.allow_viewer_filters ? 'Viewer filters on' : 'Viewer filters off'}
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="h-20 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1" />
                <div className="h-20 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1" />
                <div className="h-24 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 sm:col-span-2" />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const shellTitle = view === 'list' ? 'Public Links' : view === 'create' ? 'Create Public Link' : 'Edit Public Link';
  const shellDescription = (
    <span className="flex items-center gap-2">
      {view !== 'list' && (
        <button
          onClick={goBack}
          className="inline-flex items-center gap-1 text-caption text-text-tertiary hover:text-text-secondary"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </button>
      )}
      <span>{dashboardName}</span>
    </span>
  );

  const footer = view === 'create' ? (
    <>
      <Button variant="ghost" onClick={goBack}>Cancel</Button>
      <Button
        variant="primary"
        onClick={handleCreate}
        disabled={creating || !formName.trim() || !isPasswordFormValid}
        loading={creating}
        leadingIcon={!creating && <Plus className="h-4 w-4" />}
      >
        {creating ? 'Creating…' : 'Create link'}
      </Button>
    </>
  ) : view === 'edit' ? (
    <>
      <Button variant="ghost" onClick={goBack}>Cancel</Button>
      <Button
        variant="primary"
        onClick={handleUpdate}
        disabled={saving || !formName.trim() || !isPasswordFormValid}
        loading={saving}
        leadingIcon={!saving && <Check className="h-4 w-4" />}
      >
        {saving ? 'Saving…' : 'Save changes'}
      </Button>
    </>
  ) : undefined;

  return (
    <AppModalShell
      onClose={onClose}
      title={shellTitle}
      description={shellDescription}
      icon={<Globe className="h-4 w-4" />}
      maxWidthClass="max-w-[96rem]"
      panelClassName="h-[94vh] max-h-[94vh]"
      bodyClassName="p-0"
      footer={footer}
    >
      <div className={view === 'list' ? 'h-full overflow-y-auto' : 'h-full overflow-hidden'}>
        {view === 'list' && (
          <div className="p-6">
            <div className="grid gap-6 xl:grid-cols-[320px,minmax(0,1fr)]">
              <div className="space-y-3">
                <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
                  <div className="flex items-center gap-2 text-text-primary">
                    <Sparkles className="h-4 w-4 text-brand" />
                    <h3 className="text-small font-strong">Viewer presentation</h3>
                  </div>
                  <p className="mt-2 text-caption leading-6 text-text-tertiary">
                    Each link now keeps only the settings people actually notice: title, tone, and whether tabs or viewer filters are available.
                    The shared viewer itself stays compact and fixed so the report content gets maximum space.
                  </p>
                  <Button
                    variant="primary"
                    fullWidth
                    className="mt-5"
                    onClick={openCreate}
                    leadingIcon={<Plus className="h-4 w-4" />}
                  >
                    Create new public link
                  </Button>
                </div>

                <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
                  <p className="text-tiny font-strong uppercase tracking-[0.14em] text-text-quaternary">Tips</p>
                  <div className="mt-3 space-y-3 text-caption text-text-tertiary">
                    <p>Use the headline to rename the same dashboard for different audiences without cloning it.</p>
                    <p>Keep tabs on only when the dashboard really has multiple pages worth switching between.</p>
                    <p>Turn viewer filters off for locked executive views, and keep them on when viewers need light exploration.</p>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                {loading ? (
                  <div className="flex items-center justify-center rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-16 text-caption text-text-tertiary">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Loading public links...
                  </div>
                ) : links.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-6 py-16 text-center">
                    <Globe className="mx-auto h-10 w-10 text-text-quaternary" />
                    <p className="mt-4 text-small font-strong text-text-secondary">No public links yet</p>
                    <p className="mt-2 text-caption text-text-tertiary">
                      Create a link to publish this dashboard with its own filters and presentation settings.
                    </p>
                  </div>
                ) : (
                  links.map(renderLinkCard)
                )}
              </div>
            </div>
          </div>
        )}

        {(view === 'create' || view === 'edit') && (
          <div className="flex h-full flex-col p-6">
            <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-[minmax(0,1fr),520px]">
              <div className="min-h-0 space-y-4 overflow-y-auto pr-1 lg:pr-3">
                <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
                  <div className="flex items-center gap-2 text-text-primary">
                    <Globe className="h-4 w-4 text-brand" />
                    <h3 className="text-small font-strong">Link identity</h3>
                  </div>
                  <p className="mt-2 text-caption leading-6 text-text-tertiary">
                    Name the audience-facing link first. This name is also the default fallback title if you leave the presentation headline empty.
                  </p>
                  <label className="mb-1.5 mt-4 block text-label font-emphasis text-text-secondary">Link name</label>
                  <Input
                    type="text"
                    value={formName}
                    onChange={(event) => setFormName(event.target.value)}
                    placeholder='e.g. "CEO View", "Sales Team", "Quarterly Briefing"'
                    autoFocus
                  />
                  <p className="mt-2 text-caption leading-6 text-text-tertiary">
                    Use a descriptive name so you can distinguish audience-specific links later.
                  </p>
                </div>

                {/* Intent tabs (2026-06-18) — split the long form by purpose
                    so the modal isn't one 9-section scroll. */}
                <div className="flex items-center gap-1 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-1">
                  {([
                    { id: 'appearance', label: 'Giao diện' },
                    { id: 'data', label: 'Dữ liệu (Filter)' },
                    { id: 'aibot', label: 'AI Bot' },
                    { id: 'security', label: 'Bảo mật & Chia sẻ' },
                  ] as const).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setFormTab(t.id)}
                      className={cn(
                        'flex-1 rounded-md px-3 py-1.5 text-caption font-emphasis transition-colors',
                        formTab === t.id
                          ? 'bg-brand text-text-inverse shadow-linear-sm'
                          : 'text-text-tertiary hover:text-text-secondary',
                      )}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {formTab === 'appearance' && (
                  <PublicLinkAppearanceEditor
                    value={formAppearance}
                    dashboardName={dashboardName}
                    onChange={setFormAppearance}
                    snapshotEnabled={snapshotEnabled}
                  />
                )}

                {formTab === 'aibot' && (
                  <PublicLinkAiBotEditor
                    value={formAppearance}
                    onChange={setFormAppearance}
                    dashboardId={dashboardId}
                    linkId={editingLink?.id ?? null}
                  />
                )}

                {/* Dữ liệu tab — unified link-filter table (2026-06-18 rework).
                    ONE surface: every shareable field is a row with Show /
                    Lock / Hide, replacing the old three overlapping sections
                    (3-radio + "Access filters" escape-hatch + "Hidden
                    fields"). BE link_locked is the outermost gate, then
                    page/dashboard filters, then the viewer's slicer. See
                    docs/filter-semantics.md §2.3 + §3. */}
                {formTab === 'data' && (
                <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
                  <div className="flex items-center gap-2 text-text-primary">
                    <Filter className="h-4 w-4 text-brand" />
                    <h3 className="text-small font-strong">Filter cho link này</h3>
                  </div>
                  <p className="mt-2 text-caption leading-6 text-text-tertiary">
                    Mỗi field 1 hành vi: <span className="font-emphasis text-success">👁 Hiện</span> — viewer thấy & chỉnh; <span className="font-emphasis text-warning">🔒 Khoá</span> — ép giá trị (viewer thấy read-only); <span className="font-emphasis text-text-secondary">🚫 Ẩn</span> — ép giá trị nhưng viewer KHÔNG thấy gì.
                  </p>
                  {/* Live preview of what the viewer ends up seeing + the merge order. */}
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-surface-2 px-3 py-2 text-tiny">
                    <span className="text-text-tertiary">Người xem sẽ thấy:</span>
                    <span className="text-success">👁 {unifiedRows.filter((r) => effectiveAction(r) === 'show').length} control</span>
                    <span className="text-brand">🎯 {unifiedRows.filter((r) => effectiveAction(r) === 'limit').length} giới hạn</span>
                    <span className="text-warning">🔒 {unifiedRows.filter((r) => effectiveAction(r) === 'lock').length} khoá</span>
                    <span className="text-text-secondary">🚫 {unifiedRows.filter((r) => effectiveAction(r) === 'hide').length} ẩn</span>
                  </div>
                  <p className="mt-1.5 text-tiny text-text-quaternary">
                    Thứ tự lọc: <span className="text-text-secondary">🔒 Khoá link</span> → <span className="text-text-secondary">🎯 Giới hạn</span> → <span className="text-text-secondary">Filter trang</span> → <span className="text-text-secondary">Slicer người xem</span>.
                  </p>

                  <div className="mt-4 space-y-4">
                    {columnsLoading && unifiedRows.length === 0 ? (
                      <div className="flex items-center justify-center rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-8 text-caption text-text-tertiary">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Đang tải field…
                      </div>
                    ) : unifiedRows.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-[rgb(var(--border-strong))] bg-surface-2 px-4 py-6 text-center text-tiny text-text-tertiary">
                        Chưa có field nào để cấu hình. Thêm chart/slicer vào dashboard trước, hoặc thêm field bên dưới.
                      </p>
                    ) : (
                      ([
                        { key: 'slicer', title: 'Slicer' },
                        { key: 'filter', title: 'Filter trang / dashboard' },
                        { key: 'extra', title: 'Thêm thủ công' },
                      ] as const).map((grp) => {
                        const groupRows = unifiedRows.filter((r) => r.source === grp.key);
                        if (groupRows.length === 0) return null;
                        return (
                          <div key={grp.key}>
                            <div className="mb-1.5 text-tiny font-emphasis uppercase tracking-wide text-text-quaternary">{grp.title}</div>
                            <div className="space-y-2">
                              {groupRows.map((row) => {
                                const action = effectiveAction(row);
                                // lock/hide/limit all need a value editor below.
                                const enforces = action === 'lock' || action === 'hide' || action === 'limit';
                                const lockValue = linkActions[row.key]?.value ?? (enforces ? row.value : undefined);
                                const scopeBadge = row.source === 'extra' ? 'thủ công' : (row.pageName ? row.pageName : 'mọi trang');
                                const seg = [
                                  { opt: 'show' as const, label: '👁 Hiện', on: 'bg-success/15 text-success' },
                                  { opt: 'limit' as const, label: '🎯 Giới hạn', on: 'bg-brand/15 text-brand' },
                                  { opt: 'lock' as const, label: '🔒 Khoá', on: 'bg-warning/15 text-warning' },
                                  { opt: 'hide' as const, label: '🚫 Ẩn', on: 'bg-[rgba(255,255,255,0.10)] text-text-secondary' },
                                ];
                                return (
                                  <div key={row.key} className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-2.5">
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="flex min-w-0 items-center gap-2">
                                        <span className="truncate font-emphasis text-caption text-text-primary">{row.label}</span>
                                        <span className="shrink-0 rounded bg-surface-1 px-1.5 py-0.5 text-[10px] text-text-quaternary">{scopeBadge}</span>
                                      </div>
                                      <div className="flex shrink-0 items-center gap-1">
                                        <div className="inline-flex rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-0.5 text-tiny">
                                          {seg.map(({ opt, label, on }) => (
                                            <button
                                              key={opt}
                                              type="button"
                                              onClick={() => setLinkActions((prev) => ({
                                                ...prev,
                                                [row.key]: { action: opt, value: (opt === 'lock' || opt === 'hide' || opt === 'limit') ? (prev[row.key]?.value ?? row.value) : undefined },
                                              }))}
                                              className={`rounded px-2 py-1 font-medium transition-colors ${action === opt ? on : 'text-text-quaternary hover:text-text-secondary'}`}
                                            >
                                              {label}
                                            </button>
                                          ))}
                                        </div>
                                        {row.source === 'extra' && (
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setExtraRows((prev) => prev.filter((r) => entryKey(r as any) !== row.key));
                                              setLinkActions((prev) => { const n = { ...prev }; delete n[row.key]; return n; });
                                            }}
                                            className="rounded p-0.5 text-text-quaternary hover:text-danger"
                                            title="Bỏ field"
                                          >
                                            <X className="h-3.5 w-3.5" />
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                    {enforces && (
                                      <div className="mt-2">
                                        <LinkValueChips
                                          value={lockValue}
                                          listId={`vals-${row.key}`}
                                          suggestions={activeDistinctValues[row.field] ?? activeDistinctValues[row.semanticField ?? ''] ?? []}
                                          onChange={(next) => setLinkActions((prev) => ({ ...prev, [row.key]: { action, value: next } }))}
                                        />
                                        <p className="mt-1 text-tiny text-text-quaternary">
                                          {action === 'hide'
                                            ? 'Dữ liệu vẫn bị lọc theo giá trị này; viewer KHÔNG thấy control/banner.'
                                            : action === 'limit'
                                              ? 'Viewer thấy slicer tương tác nhưng CHỈ chọn được trong các giá trị này (vd 3/5 RC).'
                                              : 'Viewer thấy banner read-only với giá trị này. Để trống = dùng giá trị dashboard.'}
                                        </p>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>

                  {(activeColumns.length > 0 || columnsLoading) && (
                    <PublicLinkFieldPicker
                      columns={addableColumns}
                      chartCount={chartCount}
                      loading={columnsLoading}
                      entryKey={entryKey}
                      onAdd={addExtraField}
                    />
                  )}
                </div>
                )}

                {formTab === 'security' && (
                <>
                <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
                  <div className="flex items-center gap-2 text-text-primary">
                    <Lock className="h-4 w-4 text-warning" />
                    <h3 className="text-small font-strong">Password protection</h3>
                  </div>
                  <p className="mt-2 text-caption leading-6 text-text-tertiary">
                    Public and embed links do not require an AppBI account. Add a password only if viewers need a second gate.
                  </p>

                  {view === 'edit' && editingLink?.has_password && !changePassword ? (
                    <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-warning/20 bg-warning/10 px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-caption font-emphasis text-warning">Password is set</p>
                        <p className="text-tiny text-warning/80">Sessions expire after 2 hours.</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setChangePassword(true);
                            setPasswordEnabled(true);
                            setFormPassword('');
                          }}
                        >
                          Change
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setChangePassword(true);
                            setPasswordEnabled(false);
                            setFormPassword('');
                          }}
                          className="hover:text-danger"
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-4 space-y-3">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <button
                          type="button"
                          onClick={() => {
                            setPasswordEnabled(false);
                            setFormPassword('');
                            if (view === 'edit' && editingLink?.has_password) {
                              setChangePassword(true);
                            } else {
                              setChangePassword(false);
                            }
                          }}
                          className={cn(
                            'rounded-lg border px-4 py-3 text-left transition-colors',
                            !passwordEnabled
                              ? 'border-brand bg-brand text-text-inverse shadow-linear-sm'
                              : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:border-[rgb(var(--border-strong))] hover:bg-surface-2',
                          )}
                        >
                          <p className="text-caption font-strong">No password</p>
                          <p className={cn('mt-1 text-tiny leading-5', !passwordEnabled ? 'text-text-inverse/80' : 'text-text-tertiary')}>
                            Open immediately with the public or embed link.
                          </p>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setPasswordEnabled(true);
                            if (view === 'edit') {
                              setChangePassword(true);
                            }
                          }}
                          className={cn(
                            'rounded-lg border px-4 py-3 text-left transition-colors',
                            passwordEnabled
                              ? 'border-brand bg-brand text-text-inverse shadow-linear-sm'
                              : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:border-[rgb(var(--border-strong))] hover:bg-surface-2',
                          )}
                        >
                          <p className="text-caption font-strong">Require password</p>
                          <p className={cn('mt-1 text-tiny leading-5', passwordEnabled ? 'text-text-inverse/80' : 'text-text-tertiary')}>
                            Viewers only need the link password, not an AppBI login.
                          </p>
                        </button>
                      </div>

                      {passwordEnabled && (
                        <Input
                          type={showPassword ? 'text' : 'password'}
                          value={formPassword}
                          onChange={(event) => setFormPassword(event.target.value)}
                          placeholder="Enter password"
                          trailingIcon={
                            <button
                              type="button"
                              onClick={() => setShowPassword((current) => !current)}
                              className="text-text-quaternary hover:text-text-secondary pointer-events-auto"
                            >
                              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </button>
                          }
                        />
                      )}

                      {view === 'edit' && changePassword && (
                        <Button
                          variant="link"
                          size="sm"
                          onClick={() => {
                            setChangePassword(false);
                            setFormPassword('');
                            setPasswordEnabled(Boolean(editingLink?.has_password));
                          }}
                        >
                          Cancel password change
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                {renderShareOutputs()}
                </>
                )}
              </div>

              <div className="min-h-0 overflow-y-auto pl-0 lg:pl-1">
                {renderConfiguratorPreview()}
              </div>
            </div>
          </div>
        )}

        {view === 'list' && (
          <div className="border-t border-[rgb(var(--border-line))] px-6 py-4">
            <p className="text-center text-tiny text-text-tertiary">
              Click any link card to edit its filters, password, or presentation. Deactivated links return 404.
            </p>
          </div>
        )}
      </div>
    </AppModalShell>
  );
}
