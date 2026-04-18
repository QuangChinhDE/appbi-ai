/**
 * Dataset Detail Page - Shows dataset with sidebar tables and grid preview
 */
'use client';

import React, { useState, useMemo, useCallback, startTransition } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  Plus,
  Search,
  Calendar,
  Database,
  RefreshCw,
  ChevronLeft,
  ChevronDown,
  Loader2,
  Columns,
  Trash2,
  AlertTriangle,
  X,
  Pencil,
  ChevronLeft as ChevronLeftPag,
  ChevronRight,
  ShieldCheck,
  Sigma,
} from 'lucide-react';
import {
  useDataset,
  useTablePreview,
  useUpdateDataset,
  useUpdateTable,
  useRemoveTable,
  type CalendarDimensionSettings,
  type DatasetTable,
} from '@/hooks/use-datasets';
import { DatasetTableGrid } from '@/components/datasets/DatasetTableGrid';
import { AddTableModal } from '@/components/datasets/AddTableModalV2';
import { ManageColumnsDrawer } from '@/components/datasets/ManageColumnsDrawer';
import { AddColumnModal, buildFNS, type LookupTableOption } from '@/components/datasets/AddColumnModal';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { DatasetQualityPanel } from '@/components/datasets/DatasetQualityPanel';
import { DataModelCanvas } from '@/components/datasets/DataModelCanvas';
import { ModelViewEditPanel } from '@/components/datasets/ModelViewEditPanel';
import type { Transformation } from '@/hooks/use-datasets';
import type { DatasetModelView } from '@/hooks/use-dataset-model';
import { toast } from '@/lib/toast';

// Inline Excel formula evaluator (mirrors AddColumnModal's evalExcelFormula)
function evalExcelFormulaInPage(
  formula: string,
  row: Record<string, any>,
  fns: Record<string, Function>
): { ok: true; value: any } | { ok: false; error: string } {
  try {
    const colMap: Record<string, string> = {};
    let idx = 0;
    let expr = formula.replace(/\[([^\]]+)\]/g, (_m: string, name: string) => {
      const key = `__COL${idx++}__`;
      colMap[key] = name;
      return key;
    });
    const strings: string[] = [];
    expr = expr.replace(/"([^"]*)"/g, (_m: string, s: string) => {
      strings.push(s);
      return `__STR${strings.length - 1}__`;
    });
    expr = expr
      .replace(/<>/g, '!==')
      .replace(/(?<![<>!=])=(?![>=])/g, '===')
      .replace(/&/g, '+')
      .replace(/\bTRUE\b/gi, 'true')
      .replace(/\bFALSE\b/gi, 'false');
    expr = expr.replace(/\b([A-Z][A-Z0-9_]*)\s*\(/g, (m: string, name: string) => {
      if (name in fns) return `__FN.${name}(`;
      return m;
    });
    expr = expr.replace(/__STR(\d+)__/g, (_m: string, i: string) => JSON.stringify(strings[Number(i)]));
    for (const [key, colName] of Object.entries(colMap)) {
      expr = expr.replace(new RegExp(key, 'g'), `__ROW[${JSON.stringify(colName)}]`);
    }
    // eslint-disable-next-line no-new-func
    const fn = new Function('__ROW', '__FN', `return (${expr});`);
    return { ok: true, value: fn(row, fns) };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

function formatTypeToBackendType(formatType: string): string | null {
  if (formatType === 'number' || formatType === 'currency' || formatType === 'percentage') return 'float';
  if (formatType === 'date') return 'date';
  if (formatType === 'datetime') return 'datetime';
  if (formatType === 'text') return 'string';
  return null;
}

function extractDatasetErrorMessage(error: any, fallback: string): string {
  const detail = error?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (detail?.message) return detail.message;
  return error?.message || fallback;
}

const DEFAULT_CALENDAR_SETTINGS: CalendarDimensionSettings = {
  enabled: false,
  start_date: '2000-01-01',
  end_date: '2100-12-31',
  timezone: 'UTC',
  week_start_day: 'monday',
  fiscal_year_start_month: 1,
  auto_join_temporal_columns: true,
  excluded_auto_joins: [],
};

const CALENDAR_REQUIRES_DATASOURCE_MESSAGE =
  'Add at least one source or SQL table backed by a datasource before creating the Standard Date table.';

const LOOKUP_TABLE_IDENTIFIER_PREFIX = 'dataset-table://';

function buildLookupTableIdentifier(tableId: number): string {
  return `${LOOKUP_TABLE_IDENTIFIER_PREFIX}${tableId}`;
}

function getDatasetCalendarSettings(dataset: {
  settings?: { calendar_dimension?: Partial<CalendarDimensionSettings> };
} | null | undefined): CalendarDimensionSettings {
  return {
    ...DEFAULT_CALENDAR_SETTINGS,
    ...(dataset?.settings?.calendar_dimension ?? {}),
  };
}

function isGeneratedCalendarTable(table: Pick<DatasetTable, 'source_kind'> | null | undefined): boolean {
  return table?.source_kind === 'generated_calendar';
}

function isCalculatedTable(table: Pick<DatasetTable, 'source_kind'> | null | undefined): boolean {
  return table?.source_kind === 'derived_table';
}

type TableGroupKey = 'calendar' | 'source' | 'calculated';
type DatasetDetailTab = 'tables' | 'quality' | 'model';

function getTableGroupKey(table: Pick<DatasetTable, 'source_kind'> | null | undefined): TableGroupKey {
  if (isGeneratedCalendarTable(table)) return 'calendar';
  if (isCalculatedTable(table)) return 'calculated';
  return 'source';
}

function getTableGroupLabel(group: TableGroupKey): string {
  if (group === 'calendar') return 'Calendar';
  if (group === 'calculated') return 'Calculated';
  return 'Source';
}

function getTableGroupEmptyMessage(group: TableGroupKey): string {
  if (group === 'calendar') return 'No calendar table yet';
  if (group === 'calculated') return 'No calculated tables yet';
  return 'No source tables yet';
}

function getTableBadgeLabel(table: Pick<DatasetTable, 'source_kind'> | null | undefined): string {
  const group = getTableGroupKey(table);
  if (group === 'calendar') return 'Date';
  if (group === 'calculated') return 'Calculated';
  return 'Source';
}

function resolveDatasetDetailTab(tab: string | null): DatasetDetailTab {
  if (tab === 'quality' || tab === 'catalog') return 'quality';
  if (tab === 'model') return 'model';
  return 'tables';
}

function getTableIcon(table: Pick<DatasetTable, 'source_kind'> | null | undefined): React.ReactNode {
  if (isGeneratedCalendarTable(table)) {
    return <Calendar className="h-4 w-4 flex-shrink-0 text-brand" />;
  }
  if (isCalculatedTable(table)) {
    return <Sigma className="h-4 w-4 flex-shrink-0 text-brand" />;
  }
  return <Database className="h-4 w-4 flex-shrink-0 text-text-quaternary" />;
}

function getTableGroupIcon(group: TableGroupKey): React.ReactNode {
  if (group === 'calendar') return <Calendar className="h-4 w-4 text-brand" />;
  if (group === 'calculated') return <Sigma className="h-4 w-4 text-brand" />;
  return <Database className="h-4 w-4 text-text-tertiary" />;
}

function getTablePrimaryName(table: Partial<DatasetTable> | null | undefined): string {
  return table?.display_name || table?.source_table_name || 'Untitled table';
}

function getTableSecondaryName(table: Partial<DatasetTable> | null | undefined): string | null {
  if (!table) return null;
  if (isGeneratedCalendarTable(table as DatasetTable)) return 'Standard Date table';
  if (isCalculatedTable(table as DatasetTable)) return 'Calculated table';
  if (table.source_kind === 'sql_query') return 'Datasource SQL query';
  if (table.display_name && table.source_table_name) return table.source_table_name;
  return null;
}

function getDeleteConstraintMeta(constraint: any): {
  badge: string;
  className: string;
  title: string;
  description: string;
} {
  if (constraint?.type === 'chart' || constraint?.type === 'chart_filter') {
    return {
      badge: 'Chart',
      className: 'text-danger bg-danger/15',
      title: constraint?.object_label || (constraint?.name ? `Chart "${constraint.name}"` : 'Chart dependency'),
      description: constraint?.detail || 'This chart still depends on the table you are trying to delete.',
    };
  }
  if (constraint?.type === 'dashboard_filter') {
    return {
      badge: 'Filter',
      className: 'text-brand bg-brand/15',
      title: constraint?.object_label || (constraint?.name ? `Dashboard "${constraint.name}"` : 'Dashboard filter'),
      description: constraint?.detail || (
        constraint?.field
          ? `Filter "${constraint.field}" still references this table.`
          : 'A dashboard filter still references this table.'
      ),
    };
  }
  if (constraint?.type === 'public_link_filter') {
    return {
      badge: 'Public',
      className: 'text-brand bg-brand/15',
      title: constraint?.object_label || (constraint?.name ? `Public link "${constraint.name}"` : 'Public link'),
      description: constraint?.detail || (
        constraint?.field
          ? `Filter "${constraint.field}" still references this table.`
          : 'A public filter still references this table.'
      ),
    };
  }
  if (constraint?.type === 'calculated_table') {
    return {
      badge: 'Calculated',
      className: 'text-brand bg-brand/15',
      title: constraint?.object_label || (
        constraint?.table_name ? `Calculated table "${constraint.table_name}"` : 'Calculated table dependency'
      ),
      description: constraint?.detail || 'Its SQL still depends on this table.',
    };
  }
  return {
    badge: 'Lookup',
    className: 'text-warning bg-warning/15',
    title: constraint?.object_label || (
      constraint?.table_name
        ? `Table "${constraint.table_name}"`
        : 'Lookup dependency'
    ),
    description: constraint?.detail || (
      constraint?.column
        ? `Column "${constraint.column}" still references this table.`
        : 'A lookup formula still references this table.'
    ),
  };
}

interface CalendarDimensionModalProps {
  isOpen: boolean;
  isSaving: boolean;
  isExisting: boolean;
  draft: CalendarDimensionSettings;
  canEdit: boolean;
  onDraftChange: (updater: (current: CalendarDimensionSettings) => CalendarDimensionSettings) => void;
  onClose: () => void;
  onSave: () => void;
  onRemove: () => void;
}

function CalendarDimensionModal({
  isOpen,
  isSaving,
  isExisting,
  draft,
  canEdit,
  onDraftChange,
  onClose,
  onSave,
  onRemove,
}: CalendarDimensionModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/84 p-4 backdrop-blur-[2px]">
      <div className="w-full max-w-lg rounded-xl border border-[rgb(var(--border-strong))] bg-surface-1 shadow-linear-lg">
        <div className="border-b px-6 py-4">
          <h2 className="text-xl font-semibold text-text-primary">
            {isExisting ? 'Calendar Dimension' : 'Add Calendar Dimension'}
          </h2>
          <p className="mt-1 text-sm text-text-tertiary">
            {isExisting
              ? 'Update the standard Date table for this dataset.'
              : 'Create a standard Date table and auto-connect temporal columns when needed.'}
          </p>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-2 block text-sm font-medium text-text-secondary">Start date</label>
              <input
                type="date"
                value={draft.start_date}
                onChange={(e) => onDraftChange((current) => ({
                  ...current,
                  enabled: true,
                  start_date: e.target.value,
                }))}
                className="w-full rounded-md border border-[rgb(var(--border-strong))] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                disabled={!canEdit || isSaving}
              />
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium text-text-secondary">End date</label>
              <input
                type="date"
                value={draft.end_date}
                onChange={(e) => onDraftChange((current) => ({
                  ...current,
                  enabled: true,
                  end_date: e.target.value,
                }))}
                className="w-full rounded-md border border-[rgb(var(--border-strong))] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                disabled={!canEdit || isSaving}
              />
            </div>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-text-secondary">Week starts on</label>
            <select
              value={draft.week_start_day}
              onChange={(e) => onDraftChange((current) => ({
                ...current,
                enabled: true,
                week_start_day: e.target.value as CalendarDimensionSettings['week_start_day'],
              }))}
              className="w-full rounded-md border border-[rgb(var(--border-strong))] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              disabled={!canEdit || isSaving}
            >
              <option value="monday">Monday</option>
              <option value="sunday">Sunday</option>
            </select>
          </div>

          <label className="flex items-start gap-3 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
            <input
              type="checkbox"
              checked={draft.auto_join_temporal_columns}
              onChange={(e) => onDraftChange((current) => ({
                ...current,
                enabled: true,
                auto_join_temporal_columns: e.target.checked,
              }))}
              className="mt-1 h-4 w-4 rounded border-[rgb(var(--border-strong))] text-brand focus:ring-brand"
              disabled={!canEdit || isSaving}
            />
            <div>
              <div className="text-sm font-medium text-text-primary">Auto-connect time columns</div>
              <p className="mt-1 text-xs text-text-tertiary">
                Automatically link date, datetime, and timestamp columns to this Date table.
              </p>
            </div>
          </label>
        </div>

        <div className="flex items-center justify-between gap-3 border-t bg-surface-2 px-6 py-4">
          <div>
            {isExisting && canEdit && (
              <button
                type="button"
                onClick={onRemove}
                disabled={isSaving}
                className="rounded-md px-3 py-2 text-sm font-medium text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Remove calendar
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-2"
              disabled={isSaving}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSave}
              className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!canEdit || isSaving}
            >
              {isSaving
                ? (isExisting ? 'Saving...' : 'Creating...')
                : (isExisting ? 'Save changes' : 'Create calendar')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DatasetDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const datasetId = params?.id ? Number(params.id) : null;
  const paramTab = searchParams.get('tab');

  const [selectedTableId, setSelectedTableId] = useState<number | null>(null);
  const [previewLimit, setPreviewLimit] = useState(100);
  const [page, setPage] = useState(1);
  const [editingTable, setEditingTable] = useState<any | null>(null);
  const [tableModalMode, setTableModalMode] = useState<'source' | 'calculated'>('source');
  const [isAddTableModalOpen, setIsAddTableModalOpen] = useState(false);
  const [isManageColumnsOpen, setIsManageColumnsOpen] = useState(false);
  const [isAddColumnModalOpen, setIsAddColumnModalOpen] = useState(false);
  const [editingColumnStep, setEditingColumnStep] = useState<Transformation | null>(null);
  const [tableSearchQuery, setTableSearchQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<TableGroupKey, boolean>>({
    calendar: false,
    source: false,
    calculated: false,
  });
  const [tableToDelete, setTableToDelete] = useState<{ id: number; name: string } | null>(null);
  const [deleteConstraints, setDeleteConstraints] = useState<any[] | null>(null);
  const [isDeletingTable, setIsDeletingTable] = useState(false);
  const [selectedView, setSelectedView] = useState<DatasetModelView | null>(null);
  const [activeTab, setActiveTabState] = useState<DatasetDetailTab>(() => resolveDatasetDetailTab(paramTab));

  // Tab routing via searchParam — ?tab=tables|quality|model
  // backward compat: ?tab=catalog → quality
  React.useEffect(() => {
    const nextTab = resolveDatasetDetailTab(paramTab);
    setActiveTabState((current) => (current === nextTab ? current : nextTab));
  }, [paramTab]);

  const syncTabInUrl = useCallback((tab: DatasetDetailTab) => {
    if (typeof window === 'undefined') return;
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('tab', tab);
    window.history.replaceState(window.history.state, '', nextUrl.toString());
  }, []);

  const setActiveTab = useCallback((tab: DatasetDetailTab) => {
    if (tab === activeTab) return;
    if (tab !== 'model') setSelectedView(null);
    startTransition(() => setActiveTabState(tab));
    syncTabInUrl(tab);
  }, [activeTab, syncTabInUrl]);
  const [calendarDraft, setCalendarDraft] = useState<CalendarDimensionSettings>(DEFAULT_CALENDAR_SETTINGS);
  const [isCalendarModalOpen, setIsCalendarModalOpen] = useState(false);

  // Fetch dataset with tables
  const { 
    data: dataset, 
    isLoading: loadingDataset,
    error: datasetError,
    refetch: refetchDataset,
  } = useDataset(datasetId);

  const resPerms = getResourcePermissions(dataset?.user_permission);

  // Fetch table preview
  const previewOffset = (page - 1) * previewLimit;
  const {
    data: previewData,
    isLoading: loadingPreview,
    error: previewError,
    refetch: refetchPreview,
  } = useTablePreview(
    datasetId,
    selectedTableId,
    { limit: previewLimit, offset: previewOffset },
    { enabled: activeTab === 'tables' }
  );

  const updateDatasetMutation = useUpdateDataset();
  const datasetCalendarSettings = useMemo(
    () => getDatasetCalendarSettings(dataset),
    [dataset],
  );

  React.useEffect(() => {
    // Only sync draft from server when the modal is closed to avoid
    // overwriting user edits during background refetches.
    if (!isCalendarModalOpen) {
      setCalendarDraft(datasetCalendarSettings);
    }
  }, [datasetCalendarSettings, isCalendarModalOpen]);

  // Filter tables by search
  const filteredTables = useMemo(() => {
    if (!dataset?.tables) return [];
    if (!tableSearchQuery) return dataset.tables;
    
    const query = tableSearchQuery.toLowerCase();
    return dataset.tables.filter((table: any) => 
      table.display_name?.toLowerCase().includes(query) ||
      table.source_kind?.toLowerCase().includes(query) ||
      (table.source_table_name ?? '').toLowerCase().includes(query)
    );
  }, [dataset?.tables, tableSearchQuery]);

  const groupedTables = useMemo<Record<TableGroupKey, DatasetTable[]>>(() => {
    const groups: Record<TableGroupKey, DatasetTable[]> = {
      calendar: [],
      source: [],
      calculated: [],
    };
    for (const table of filteredTables as DatasetTable[]) {
      groups[getTableGroupKey(table)].push(table);
    }
    return groups;
  }, [filteredTables]);

  const groupCounts = useMemo<Record<TableGroupKey, number>>(() => {
    const counts: Record<TableGroupKey, number> = {
      calendar: 0,
      source: 0,
      calculated: 0,
    };
    for (const table of dataset?.tables ?? []) {
      counts[getTableGroupKey(table)] += 1;
    }
    return counts;
  }, [dataset?.tables]);

  // Auto-select table: prefer ?table= URL param, then first table
  React.useEffect(() => {
    if (dataset?.tables && dataset.tables.length > 0 && !selectedTableId) {
      const fromUrl = searchParams.get('table');
      const urlId = fromUrl ? Number(fromUrl) : null;
      const match = urlId && dataset.tables.find((t: any) => t.id === urlId);
      setSelectedTableId(match ? urlId : dataset.tables[0].id);
    }
  }, [dataset?.tables, selectedTableId, searchParams]);

  // Reset to page 1 when switching table or changing page size
  React.useEffect(() => {
    setPage(1);
  }, [selectedTableId, previewLimit]);

  // Update table mutation
  const updateTableMutation = useUpdateTable();
  const removeTableMutation = useRemoveTable();

  const replaceTableInUrl = useCallback((tableId: number) => {
    if (typeof window === 'undefined') return;
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('table', String(tableId));
    window.history.replaceState(window.history.state, '', nextUrl.toString());
  }, []);

  const clearTableInUrl = useCallback(() => {
    if (typeof window === 'undefined') return;
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete('table');
    window.history.replaceState(window.history.state, '', nextUrl.toString());
  }, []);

  const toggleGroup = useCallback((group: TableGroupKey) => {
    setCollapsedGroups((current) => ({
      ...current,
      [group]: !current[group],
    }));
  }, []);

  const openSourceTableModal = useCallback(() => {
    setEditingTable(null);
    setTableModalMode('source');
    setIsAddTableModalOpen(true);
  }, []);

  const openCalculatedTableModal = useCallback(() => {
    setEditingTable(null);
    setTableModalMode('calculated');
    setIsAddTableModalOpen(true);
  }, []);

  const openEditTableModal = useCallback((table: DatasetTable) => {
    setEditingTable(table);
    setTableModalMode(isCalculatedTable(table) ? 'calculated' : 'source');
    setIsAddTableModalOpen(true);
  }, []);

  // Handle table addition success — select and surface the latest new table in the URL
  const handleTableAddSuccess = (created?: { id: number } | { id: number }[]) => {
    refetchDataset();
    const latestCreated = Array.isArray(created) ? created[created.length - 1] : created;
    if (latestCreated?.id) {
      startTransition(() => setSelectedTableId(latestCreated.id));
      replaceTableInUrl(latestCreated.id);
    }
  };

  // Handle transformations save
  const handleSaveTransformations = async (transformations: Transformation[]) => {
    if (!datasetId || !selectedTableId) return;

    await updateTableMutation.mutateAsync({
      datasetId,
      tableId: selectedTableId,
      input: { transformations },
    });
  };

  // Handle table deletion with dependency check
  const handleDeleteTable = async () => {
    if (!datasetId || !tableToDelete) return;
    setIsDeletingTable(true);
    try {
      await removeTableMutation.mutateAsync({
        datasetId,
        tableId: tableToDelete.id,
      });

      const refreshResult = await refetchDataset();
      const remainingTables = refreshResult.data?.tables ?? [];

      if (selectedTableId === tableToDelete.id) {
        const fallbackTable = remainingTables[0] ?? null;
        startTransition(() => setSelectedTableId(fallbackTable?.id ?? null));
        if (fallbackTable?.id) replaceTableInUrl(fallbackTable.id);
        else clearTableInUrl();
      }
      setTableToDelete(null);
      setDeleteConstraints(null);
    } catch (err: any) {
      const data = err?.response?.data;
      if (data?.detail?.constraints) {
        setDeleteConstraints(data.detail.constraints);
      } else {
        toast.error(data?.detail?.message ?? data?.detail ?? 'Không thể xóa bảng.');
        setTableToDelete(null);
      }
    } finally {
      setIsDeletingTable(false);
    }
  };

  // Handle full format change (decimal places, separator, etc.) — persists to DB
  const handleColumnFormatChange = async (colName: string, fmt: Record<string, any> | null) => {
    if (!datasetId || !selectedTableId) return;
    const currentFormats: Record<string, any> = (selectedTable as any)?.column_formats ?? {};
    const currentOverrides: Record<string, string> = (selectedTable as any)?.type_overrides ?? {};
    const updatedFormats: Record<string, any> = { ...currentFormats };
    if (fmt === null) delete updatedFormats[colName];
    else updatedFormats[colName] = fmt;

    const nextBackendType =
      fmt === null || jsFormulaColumnNames.has(colName)
        ? null
        : formatTypeToBackendType(String(fmt.formatType ?? 'default'));

    const updatedOverrides: Record<string, string> = { ...currentOverrides };
    if (nextBackendType === null) delete updatedOverrides[colName];
    else updatedOverrides[colName] = nextBackendType;

    const overrideChanged = (currentOverrides[colName] ?? null) !== nextBackendType;

    try {
      await updateTableMutation.mutateAsync({
        datasetId,
        tableId: selectedTableId,
        input: {
          column_formats: updatedFormats,
          type_overrides: updatedOverrides,
        },
      });
    } catch (error: any) {
      const message = extractDatasetErrorMessage(error, 'Khong the cap nhat dinh dang cot');
      toast.error(message);
      throw new Error(message);
    }
  };

  // Handle deleting a computed column directly from the grid format popover
  const handleDeleteColumn = async (colName: string) => {
    if (!datasetId || !selectedTableId || !selectedTable) return;
    const existing: Transformation[] = selectedTable.transformations || [];
    const updated = existing.filter(
      (t) =>
        !(
          (t.type === 'js_formula' || t.type === 'add_column') &&
          t.params?.newField === colName
        )
    );
    // Also remove from select_columns list if present
    const withSelectFixed = updated.map((t) => {
      if (t.type === 'select_columns' && Array.isArray(t.params?.columns)) {
        return { ...t, params: { ...t.params, columns: t.params.columns.filter((c: string) => c !== colName) } };
      }
      return t;
    });
    await updateTableMutation.mutateAsync({
      datasetId,
      tableId: selectedTableId,
      input: { transformations: withSelectFixed },
    });
  };

  // Handle editing an existing computed column's formula
  const handleEditColumn = (colName: string) => {
    if (!selectedTable) return;
    const step = (selectedTable.transformations ?? []).find(
      (t) => t.type === 'js_formula' && t.params?.newField === colName
    ) ?? null;
    setEditingColumnStep(step);
    setIsAddColumnModalOpen(true);
  };

  const selectedTable = dataset?.tables?.find((t: any) => t.id === selectedTableId);
  const calendarTable = dataset?.tables?.find((table: any) => isGeneratedCalendarTable(table)) as DatasetTable | undefined;
  const calendarEnabled = Boolean(datasetCalendarSettings.enabled && calendarTable);
  const canCreateCalendarDimension = Boolean(
    (dataset?.tables ?? []).some((table: any) => !isGeneratedCalendarTable(table) && table?.datasource_id != null),
  );
  const selectedTableIsGenerated = isGeneratedCalendarTable(selectedTable as DatasetTable | undefined);
  const selectedTableTitle = getTablePrimaryName(selectedTable);
  const selectedTableSubtitle = getTableSecondaryName(selectedTable);

  const openCalendarModal = () => {
    if (!calendarEnabled && !canCreateCalendarDimension) {
      toast.error(CALENDAR_REQUIRES_DATASOURCE_MESSAGE);
      return;
    }
    setCalendarDraft({
      ...datasetCalendarSettings,
      enabled: true,
    });
    setIsCalendarModalOpen(true);
  };

  const handleSaveCalendarSettings = async () => {
    if (!datasetId) return;
    if (!calendarEnabled && !canCreateCalendarDimension) {
      toast.error(CALENDAR_REQUIRES_DATASOURCE_MESSAGE);
      return;
    }
    if (calendarDraft.start_date && calendarDraft.end_date && calendarDraft.start_date > calendarDraft.end_date) {
      toast.error('Start date must be before end date.');
      return;
    }
    try {
      await updateDatasetMutation.mutateAsync({
        id: datasetId,
        input: {
          settings: {
            calendar_dimension: {
              ...calendarDraft,
              enabled: true,
            },
          },
        },
      });
      const refreshResult = await refetchDataset();
      const nextCalendarTable = refreshResult.data?.tables?.find((table: any) =>
        isGeneratedCalendarTable(table),
      ) as DatasetTable | undefined;
      if (nextCalendarTable?.id) {
        startTransition(() => setSelectedTableId(nextCalendarTable.id));
        replaceTableInUrl(nextCalendarTable.id);
      }
      setIsCalendarModalOpen(false);
      toast.success(calendarEnabled ? 'Calendar dimension updated' : 'Calendar dimension created');
    } catch (error: any) {
      toast.error(extractDatasetErrorMessage(error, 'Khong the cap nhat calendar settings'));
    }
  };

  const handleRemoveCalendarDimension = async () => {
    if (!datasetId) return;
    try {
      await updateDatasetMutation.mutateAsync({
        id: datasetId,
        input: {
          settings: {
            calendar_dimension: {
              ...datasetCalendarSettings,
              enabled: false,
            },
          },
        },
      });
      const refreshResult = await refetchDataset();
      const remainingTables = refreshResult.data?.tables ?? [];
      if (selectedTableIsGenerated) {
        const fallbackTable = remainingTables.find((table: any) => !isGeneratedCalendarTable(table));
        startTransition(() => setSelectedTableId(fallbackTable?.id ?? null));
        if (fallbackTable?.id) replaceTableInUrl(fallbackTable.id);
        else clearTableInUrl();
      }
      setIsCalendarModalOpen(false);
      toast.success('Calendar dimension removed');
    } catch (error: any) {
      toast.error(extractDatasetErrorMessage(error, 'Khong the xoa calendar dimension'));
    }
  };

  // Names of columns produced by js_formula OR add_column transformations (deletable in drawer)
  const computedColumnNames = useMemo(() => {
    return (selectedTable?.transformations ?? [])
      .filter((t: any) =>
        (t.type === 'js_formula' || t.type === 'add_column') &&
        t.enabled !== false &&
        t.params?.newField
      )
      .map((t: any) => t.params.newField as string);
  }, [selectedTable?.transformations]);

  const jsFormulaColumnNames = useMemo(() => {
    return new Set(
      (selectedTable?.transformations ?? [])
        .filter((t: any) => t.type === 'js_formula' && t.enabled !== false && t.params?.newField)
        .map((t: any) => t.params.newField as string)
    );
  }, [selectedTable?.transformations]);

  /**
   * Lookup data for cross-table LOOKUP() use in formulas.
   * We keep backward-compatible aliases (display/source name) while also
   * exposing a stable identifier so renames do not break new formulas.
   */
  const lookupTables = useMemo<LookupTableOption[]>(() => {
    const result: LookupTableOption[] = [];
    for (const t of dataset?.tables ?? []) {
      if (t.id === selectedTableId) continue; // skip current table
      const rows: Record<string, any>[] = (t as any).sample_cache ?? [];
      if (rows.length === 0) continue;
      result.push({
        identifier: buildLookupTableIdentifier(t.id),
        label: getTablePrimaryName(t),
        rowCount: rows.length,
      });
    }
    return result;
  }, [dataset?.tables, selectedTableId]);

  const datasetLookupData = useMemo(() => {
    const result: Record<string, Record<string, any>[]> = {};
    for (const t of dataset?.tables ?? []) {
      if (t.id === selectedTableId) continue; // skip current table
      const rows: Record<string, any>[] = (t as any).sample_cache ?? [];
      if (rows.length === 0) continue;

      const aliases = new Set<string>([
        buildLookupTableIdentifier(t.id),
        String((t as any).display_name || '').trim(),
        String((t as any).source_table_name || '').trim(),
      ]);
      aliases.forEach((alias) => {
        if (alias) result[alias] = rows;
      });
    }
    return result;
  }, [dataset?.tables, selectedTableId]);

  // Apply js_formula transformations client-side on top of server preview rows
  const computedPreviewData = useMemo(() => {
    if (!previewData) return previewData;
    const jsSteps = (selectedTable?.transformations ?? []).filter(
      (t: any) => t.type === 'js_formula' && t.enabled !== false && t.params?.newField && (t.params?.code || t.params?.formula)
    );
    if (jsSteps.length === 0) return previewData;

    const formulaHelpers = buildFNS(datasetLookupData);
    const compiledSteps = jsSteps.map((step: any) => {
      const { code, formula, newField } = step.params as { code?: string; formula?: string; newField: string };
      let codeExecutor: ((row: Record<string, any>, idx: number) => any) | null = null;
      if (code) {
        const body = code.trim().includes('return') ? code : `return (${code})`;
        // eslint-disable-next-line no-new-func
        codeExecutor = new Function('$row', '$index', body) as (row: Record<string, any>, idx: number) => any;
      }

      return {
        formula,
        newField,
        codeExecutor,
      };
    });

    const augmentedRows = previewData.rows.map((row, idx) => {
      const out = { ...row };
      for (const step of compiledSteps) {
        try {
          const { formula, newField, codeExecutor } = step;
          if (formula) {
            const result = evalExcelFormulaInPage(formula, out, formulaHelpers);
            if (result.ok) out[newField] = result.value;
          } else if (codeExecutor) {
            out[newField] = codeExecutor(out, idx);
          }
        } catch {
          // leave column as undefined on error
        }
      }
      return out;
    });

    const addedCols = compiledSteps.map((step) => ({ name: step.newField, type: 'string', nullable: true }));
    return {
      ...previewData,
      rows: augmentedRows,
      columns: [...previewData.columns, ...addedCols],
    };
  }, [previewData, selectedTable?.transformations, datasetLookupData]);

  /**
   * Column groups for the formula modal:
   * - Group 1: current table's columns (from computedPreviewData)
   * - Group N: each other table with cached columns (columns_cache)
   */
  const modalColumnGroups = useMemo(() => {
    const currentCols = (computedPreviewData?.columns ?? []).map((c) => c.name);
    const groups: { sourceLabel: string; columns: string[] }[] = [
      { sourceLabel: (selectedTable as any)?.display_name || (selectedTable as any)?.source_table_name || 'Bảng hiện tại', columns: currentCols },
    ];
    for (const t of dataset?.tables ?? []) {
      if (t.id === selectedTableId) continue;
      const label = (t as any).display_name || (t as any).source_table_name || String(t.id);
      const cachedCols: string[] = ((t as any).columns_cache?.columns ?? []).map((c: any) => c.name);
      if (cachedCols.length > 0) {
        groups.push({ sourceLabel: `${label} (lookup)`, columns: cachedCols });
      }
    }
    return groups.filter((g) => g.columns.length > 0);
  }, [computedPreviewData?.columns, dataset?.tables, selectedTableId, selectedTable]);

  if (loadingDataset) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-brand mx-auto mb-3" />
          <p className="text-text-secondary">Loading dataset...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (datasetError || !dataset) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-md">
          <div className="text-danger mb-3">
            <svg className="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-text-primary mb-2">Dataset not found</h2>
          <p className="text-text-secondary mb-4">
            {datasetError instanceof Error ? datasetError.message : 'Could not load dataset'}
          </p>
          <button
            onClick={() => router.push('/datasets')}
            className="px-4 py-2 bg-brand text-white rounded-md hover:bg-brand-hover transition-colors"
          >
            Back to Datasets
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Single top header: 1 dòng, compact ── */}
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4">
        {/* Breadcrumb */}
        <button
          onClick={() => router.push('/datasets')}
          className="flex items-center gap-1 text-sm text-text-tertiary hover:text-text-primary transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          Datasets
        </button>
        <span className="text-text-quaternary">/</span>
        <span className="text-sm font-medium text-text-primary truncate max-w-[200px]">{dataset.name}</span>

        {/* Divider */}
        <div className="w-px h-5 bg-surface-3 mx-1" />

        {/* Tab navigation */}
        <div className="inline-flex rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-0.5">
          <button
            onClick={() => setActiveTab('tables')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              activeTab === 'tables'
                ? 'bg-surface-1 text-brand shadow-linear-sm'
                : 'text-text-tertiary hover:bg-surface-1'
            }`}
          >
            <Database className="h-3.5 w-3.5" />
            Tables
          </button>
          <button
            onClick={() => setActiveTab('quality')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              activeTab === 'quality'
                ? 'bg-surface-1 text-brand shadow-linear-sm'
                : 'text-text-tertiary hover:bg-surface-1'
            }`}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Quality
          </button>
          <button
            onClick={() => setActiveTab('model')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              activeTab === 'model'
                ? 'bg-surface-1 text-brand shadow-linear-sm'
                : 'text-text-tertiary hover:bg-surface-1'
            }`}
          >
            <Sigma className="h-3.5 w-3.5" />
            Model
          </button>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Table-level actions — chỉ hiện ở tab Tables khi có table được chọn */}
        {activeTab === 'tables' && selectedTable && !selectedTableIsGenerated && (
          <div className="flex items-center gap-1">
            {resPerms.canEdit && (
              <button
                onClick={() => setIsManageColumnsOpen(true)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-2 rounded transition-colors"
              >
                <Columns className="w-3.5 h-3.5" />
                Columns
              </button>
            )}
            {resPerms.canEdit && (
              <button
                onClick={() => setIsAddColumnModalOpen(true)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-white bg-brand hover:bg-brand-hover rounded transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Column
              </button>
            )}
            <div className="w-px h-4 bg-surface-3 mx-1" />
            <label className="flex items-center gap-1.5 text-xs text-text-tertiary">
              Rows:
              <select
                value={previewLimit}
                onChange={(e) => { setPreviewLimit(Number(e.target.value)); setPage(1); }}
                className="px-1.5 py-0.5 border border-[rgb(var(--border-strong))] rounded text-xs focus:outline-none focus:ring-1 focus:ring-brand"
              >
                <option value={10}>10</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
                <option value={200}>200</option>
                <option value={500}>500</option>
                <option value={1000}>1000</option>
              </select>
            </label>
            <button
              onClick={() => refetchPreview()}
              disabled={loadingPreview}
              className="p-1 text-text-quaternary hover:text-text-secondary hover:bg-surface-2 rounded transition-colors disabled:opacity-40"
              title="Refresh preview"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingPreview ? 'animate-spin' : ''}`} />
            </button>
          </div>
        )}
      </div>

      {/* ── Body: sidebar + content (sidebar chỉ khi tab=tables) ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar — chỉ render khi tab Tables */}
        {activeTab === 'tables' && (
          <div className="flex w-72 shrink-0 flex-col overflow-hidden border-r bg-surface-1">
            {/* Search */}
            <div className="px-3 py-2 border-b">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-quaternary" />
                <input
                  type="text"
                  placeholder="Search tables..."
                  value={tableSearchQuery}
                  onChange={(e) => setTableSearchQuery(e.target.value)}
                  className="w-full pl-8 pr-3 py-1.5 text-xs border border-[rgb(var(--border-line))] rounded-md focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </div>
            </div>

            {/* Table Groups */}
            <div className="flex-1 overflow-y-auto p-2">
              {tableSearchQuery && filteredTables.length === 0 ? (
                <div className="rounded-lg border border-dashed border-[rgb(var(--border-line))] px-4 py-6 text-center text-xs text-text-tertiary">
                  No tables match your search
                </div>
              ) : (
                <div className="space-y-2">
                  {(['calendar', 'source', 'calculated'] as TableGroupKey[]).map((group) => {
                    const tablesInGroup = groupedTables[group];
                    const totalCount = groupCounts[group];
                    const isCollapsed = collapsedGroups[group];
                    const shouldRenderGroup = tableSearchQuery ? tablesInGroup.length > 0 : true;
                    if (!shouldRenderGroup) return null;

                    return (
                      <div key={group} className="overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-1">
                        <div className="flex items-center justify-between gap-2 border-b border-[rgb(var(--border-line))] px-2.5 py-2">
                          <button
                            type="button"
                            onClick={() => toggleGroup(group)}
                            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                          >
                            <span className="text-text-quaternary">
                              {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                            </span>
                            {getTableGroupIcon(group)}
                            <span className="text-xs font-semibold text-text-primary">{getTableGroupLabel(group)}</span>
                            <span className="text-xs text-text-quaternary">
                              {tableSearchQuery ? `${tablesInGroup.length}` : `${totalCount}`}
                            </span>
                          </button>

                          {resPerms.canEdit && (
                            group === 'calendar' ? (
                              <button
                                type="button"
                                onClick={openCalendarModal}
                                disabled={!calendarEnabled && !canCreateCalendarDimension}
                                title={!calendarEnabled && !canCreateCalendarDimension ? CALENDAR_REQUIRES_DATASOURCE_MESSAGE : undefined}
                                className="inline-flex items-center gap-1 rounded border border-[rgb(var(--border-line))] px-2 py-0.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                <Plus className="h-3 w-3" />
                                {calendarEnabled ? 'Edit' : 'Add'}
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={group === 'source' ? openSourceTableModal : openCalculatedTableModal}
                                className="inline-flex items-center gap-1 rounded border border-[rgb(var(--border-line))] px-2 py-0.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface-2"
                              >
                                <Plus className="h-3 w-3" />
                                Add
                              </button>
                            )
                          )}
                        </div>

                        {!isCollapsed && (
                          <div className="p-1.5">
                            {tablesInGroup.length === 0 ? (
                              <div className="rounded border border-dashed border-[rgb(var(--border-line))] px-3 py-4 text-center text-[11px] text-text-quaternary">
                                {getTableGroupEmptyMessage(group)}
                              </div>
                            ) : (
                              <div className="space-y-0.5">
                                {tablesInGroup.map((table: DatasetTable) => (
                                  <div
                                    key={table.id}
                                    className={`group relative flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors cursor-pointer ${
                                      selectedTableId === table.id
                                        ? 'bg-brand/10 text-brand'
                                        : 'text-text-primary hover:bg-surface-2'
                                    }`}
                                    onClick={() => {
                                      startTransition(() => setSelectedTableId(table.id));
                                      replaceTableInUrl(table.id);
                                    }}
                                  >
                                    {getTableIcon(table)}
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate text-xs font-medium leading-tight">
                                        {getTablePrimaryName(table)}
                                      </div>
                                      {getTableSecondaryName(table) && (
                                        <div className="truncate text-[11px] text-text-quaternary leading-tight">
                                          {getTableSecondaryName(table)}
                                        </div>
                                      )}
                                    </div>
                                    {resPerms.canEdit && !isGeneratedCalendarTable(table) && (
                                      <button
                                        onClick={(e) => { e.stopPropagation(); openEditTableModal(table); }}
                                        className="opacity-0 group-hover:opacity-100 rounded p-0.5 text-text-quaternary hover:bg-brand/15 hover:text-brand transition-opacity"
                                        title="Edit table"
                                      >
                                        <Pencil className="h-3 w-3" />
                                      </button>
                                    )}
                                    {resPerms.canDelete && (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setDeleteConstraints(null);
                                          setTableToDelete({
                                            id: table.id,
                                            name: table.display_name || table.source_table_name || `Table ${table.id}`,
                                          });
                                        }}
                                        className="opacity-0 group-hover:opacity-100 rounded p-0.5 text-text-quaternary hover:bg-danger/15 hover:text-danger transition-opacity"
                                        title="Delete table"
                                      >
                                        <Trash2 className="h-3 w-3" />
                                      </button>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Main Content ── */}
        <div className="flex-1 flex flex-col bg-surface-2 overflow-hidden">
          {activeTab === 'model' ? (
            <div className="flex-1 overflow-hidden flex flex-row">
              {/* ERD canvas — takes remaining width */}
              <div className="flex-1 overflow-hidden min-w-0">
                <DataModelCanvas
                  datasetId={datasetId!}
                  datasetName={dataset.name}
                  tables={dataset.tables ?? []}
                  canEdit={resPerms.canEdit}
                  selectedViewId={selectedView?.id ?? null}
                  onSelectView={(view) => setSelectedView((prev) => prev?.id === view.id ? null : view)}
                />
              </div>
              {/* Side panel — 520px, only when a view is selected */}
              {selectedView && (
                <div className="w-[520px] shrink-0 overflow-hidden flex flex-col">
                  <ModelViewEditPanel
                    datasetId={datasetId!}
                    view={selectedView}
                    tables={dataset.tables ?? []}
                    canEdit={resPerms.canEdit}
                  />
                </div>
              )}
            </div>
          ) : activeTab === 'quality' ? (
            <DatasetQualityPanel
              datasetId={datasetId!}
              tables={dataset.tables ?? []}
              canEdit={resPerms.canEdit}
            />
          ) : dataset.tables.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center max-w-md px-4">
                <div className="text-text-quaternary mb-4">
                  <Database className="w-14 h-14 mx-auto" />
                </div>
                <h2 className="text-lg font-semibold text-text-primary mb-2">No tables yet</h2>
                <p className="text-sm text-text-tertiary mb-6">
                  Use the add actions in the sidebar to create a source table, a calculated table, or a Date table.
                </p>
              </div>
            </div>
          ) : selectedTable ? (
            <>
              {/* Grid Body */}
              <div className="flex-1 overflow-auto p-4">
                {previewError && (previewError as any)?.response?.status === 422 ? (
                  <div className="flex items-center justify-center h-full">
                    <div className="text-center max-w-sm">
                      <AlertTriangle className="w-10 h-10 text-warning mx-auto mb-3" />
                      <h3 className="text-base font-semibold text-text-primary mb-1">Chưa sync</h3>
                      <p className="text-sm text-text-secondary mb-4">
                        Bảng này chưa được đồng bộ vào DuckDB. Nếu bạn vừa chạy Sync, hãy đợi vài giây — trang sẽ tự động cập nhật khi sync xong.
                      </p>
                      <button
                        onClick={() => refetchPreview()}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-brand text-white text-sm font-medium rounded-lg hover:bg-brand-hover"
                      >
                        <RefreshCw className="w-4 h-4" />
                        Thử lại ngay
                      </button>
                    </div>
                  </div>
                ) : (
                  <DatasetTableGrid
                    columns={computedPreviewData?.columns || []}
                    rows={computedPreviewData?.rows || []}
                    isLoading={loadingPreview}
                    error={previewError ? extractDatasetErrorMessage(previewError, 'Cannot load table preview') : null}
                    onRetry={() => refetchPreview()}
                    onAddColumn={resPerms.canEdit && !selectedTableIsGenerated ? () => setIsAddColumnModalOpen(true) : undefined}
                    onDeleteColumn={resPerms.canEdit && !selectedTableIsGenerated ? handleDeleteColumn : undefined}
                    onEditColumn={resPerms.canEdit && !selectedTableIsGenerated ? handleEditColumn : undefined}
                    computedColumns={computedColumnNames}
                    typeOverrides={(selectedTable as any)?.type_overrides}
                    columnFormatsDb={(selectedTable as any)?.column_formats}
                    onColumnFormatChange={handleColumnFormatChange}
                  />
                )}
              </div>

              {/* Pagination Bar */}
              {!loadingPreview && previewData && !((previewError as any)?.response?.status === 422) && (
                <div className="flex flex-shrink-0 items-center justify-between border-t bg-surface-1 px-4 py-2 text-xs text-text-tertiary">
                  <span>
                    {previewData.rows.length === 0
                      ? 'Không có dữ liệu'
                      : `Dòng ${previewOffset + 1}–${previewOffset + previewData.rows.length}`}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page === 1}
                      className="p-1 border rounded disabled:opacity-40 hover:bg-surface-2 transition-colors"
                      title="Trang trước"
                    >
                      <ChevronLeftPag className="w-3.5 h-3.5" />
                    </button>
                    <span className="px-1.5 font-medium">Trang {page}</span>
                    <button
                      onClick={() => setPage((p) => p + 1)}
                      disabled={!previewData.has_more}
                      className="p-1 border rounded disabled:opacity-40 hover:bg-surface-2 transition-colors"
                      title="Trang tiếp"
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>

      <CalendarDimensionModal
        isOpen={isCalendarModalOpen}
        isSaving={updateDatasetMutation.isPending}
        isExisting={calendarEnabled}
        draft={calendarDraft}
        canEdit={resPerms.canEdit}
        onDraftChange={(updater) => setCalendarDraft((current) => updater(current))}
        onClose={() => setIsCalendarModalOpen(false)}
        onSave={handleSaveCalendarSettings}
        onRemove={handleRemoveCalendarDimension}
      />

      {/* Add Table Modal */}
      <AddTableModal
        datasetId={datasetId!}
        isOpen={isAddTableModalOpen}
        onClose={() => { setIsAddTableModalOpen(false); setEditingTable(null); }}
        onSuccess={handleTableAddSuccess}
        existingTable={editingTable}
        createMode={tableModalMode}
        availableTables={dataset?.tables ?? []}
      />

      {/* Manage Columns Drawer */}
      {selectedTable && !selectedTableIsGenerated && (
        <ManageColumnsDrawer
          table={selectedTable}
          allColumns={(computedPreviewData?.columns || []).map((c) => c.name)}
          computedColumns={computedColumnNames}
          isOpen={isManageColumnsOpen}
          onClose={() => setIsManageColumnsOpen(false)}
          onSave={handleSaveTransformations}
        />
      )}

      {/* Add Column Modal */}
      {selectedTable && !selectedTableIsGenerated && (
        <AddColumnModal
          table={selectedTable}
          allColumns={(computedPreviewData?.columns || []).map((c) => c.name)}
          columnGroups={modalColumnGroups}
          previewRows={computedPreviewData?.rows || []}
          lookupData={datasetLookupData}
          lookupTables={lookupTables}
          isOpen={isAddColumnModalOpen}
          onClose={() => { setIsAddColumnModalOpen(false); setEditingColumnStep(null); }}
          onSave={handleSaveTransformations}
          editingStep={editingColumnStep}
        />
      )}

      {/* Delete Table Modal */}
      {tableToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay/84 p-4 backdrop-blur-[2px]">
          <div className="w-full max-w-md rounded-xl border border-[rgb(var(--border-strong))] bg-surface-1 p-6 shadow-linear-lg">
            {deleteConstraints ? (
              // ---- Constraint error view ----
              <>
                <div className="flex items-start gap-3 mb-4">
                  <AlertTriangle className="w-6 h-6 text-danger flex-shrink-0 mt-0.5" />
                  <div>
                    <h2 className="text-lg font-semibold text-text-primary">Không thể xóa bảng</h2>
                    <p className="text-sm text-text-secondary mt-1">
                      Bảng <span className="font-medium">&ldquo;{tableToDelete.name}&rdquo;</span> đang được sử dụng bởi:
                    </p>
                  </div>
                </div>
                <ul className="mb-6 space-y-2">
                  {deleteConstraints.map((c: any, i: number) => (
                    <li key={i} className="flex items-start gap-3 rounded-lg bg-danger/10 px-3 py-3 text-sm">
                      <span className={`mt-0.5 text-xs font-semibold uppercase rounded px-1.5 py-0.5 ${getDeleteConstraintMeta(c).className}`}>
                        {getDeleteConstraintMeta(c).badge}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-text-primary">{getDeleteConstraintMeta(c).title}</div>
                        <div className="mt-0.5 text-text-secondary">{getDeleteConstraintMeta(c).description}</div>
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-text-tertiary mb-4">
                  Hãy xóa hoặc cập nhật các ràng buộc trên trước khi xóa bảng này.
                </p>
                <div className="flex justify-end">
                  <button
                    onClick={() => { setTableToDelete(null); setDeleteConstraints(null); }}
                    className="px-4 py-2 bg-surface-2 hover:bg-surface-3 text-text-secondary rounded-lg text-sm font-medium"
                  >
                    Đóng
                  </button>
                </div>
              </>
            ) : (
              // ---- Confirmation view ----
              <>
                <div className="flex items-start gap-3 mb-4">
                  <Trash2 className="w-6 h-6 text-danger flex-shrink-0 mt-0.5" />
                  <div>
                    <h2 className="text-lg font-semibold text-text-primary">Xóa bảng?</h2>
                    <p className="text-sm text-text-secondary mt-1">
                      Bạn có chắc muốn xóa bảng <span className="font-medium">&ldquo;{tableToDelete.name}&rdquo;</span>? Hành động này không thể hoàn tác.
                    </p>
                  </div>
                </div>
                <div className="flex justify-end gap-3">
                  <button
                    onClick={() => setTableToDelete(null)}
                    disabled={isDeletingTable}
                    className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary disabled:opacity-50"
                  >
                    Hủy
                  </button>
                  <button
                    onClick={handleDeleteTable}
                    disabled={isDeletingTable}
                    className="px-4 py-2 bg-danger hover:bg-danger/90 text-white text-sm font-medium rounded-lg disabled:opacity-50 flex items-center gap-2"
                  >
                    {isDeletingTable && <Loader2 className="w-4 h-4 animate-spin" />}
                    Xóa bảng
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}


    </div>
  );
}
