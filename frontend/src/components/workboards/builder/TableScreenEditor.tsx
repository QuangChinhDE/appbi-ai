/**
 * TableScreenEditor — single editor for the unified ``table`` screen kind.
 *
 * Replaces the previous ListScreenEditor + GridScreenEditor split: one
 * screen now covers both pure read-only browsing and inline-edit
 * spreadsheet entry, with the ``editable_columns`` picker driving which
 * cells accept input at runtime.
 *
 * Inspectors:
 * - Visible columns / Editable columns / Required columns
 * - Row behaviour (allow add/delete)
 * - Settings (page size, default sort)
 * - Default values applied on insert
 * - Footer totals (sum/avg/min/max/count)
 * - Filters / Computed columns / Lookup columns / Empty state
 *
 * RLS is configured on the shared "Permissions" tab — same as form.
 */
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  Calculator,
  CalendarDays,
  Check,
  ChevronRight,
  Columns3,
  Filter,
  Image as ImageIcon,
  LayoutGrid,
  Link2,
  ListFilter,
  MapPinned,
  PencilLine,
  Plus,
  Rows3,
  ScanLine,
  Settings2,
  Sigma,
  Palette,
  Trash2,
} from 'lucide-react';

import {
  BUILDER_GRID_2,
  BuilderEmptyHint,
  BuilderIconButton,
  BuilderInspectorPanel,
  BuilderNavigator,
  BuilderNavigatorGroup,
  BuilderNavigatorItem,
  BuilderObjectEditor,
  BuilderTableMissingBanner,
  DataSourcePicker,
} from './BuilderChrome';
import { MultiColumnPicker, SingleColumnPicker } from './BuilderValueControls';
import JsFormulaEditor from './JsFormulaEditor';
import type {
  CellFormat,
  TableComputedColumnSpec,
  TableLookupColumnSpec,
  TableRollupColumnSpec,
  TableRollupAgg,
  FormatRuleSpec,
  FormatRuleColor,
  TableColumnMetaSpec,
  TableInputType,
  TableScreenSpecBuilt,
  TableTotalsKind,
  TableFilterSpec,
  PosCartConfigSpec,
  PosCartHeaderInputSpec,
  ScreenSpec,
  ScreenAction,
} from './types';
import { INPUT, Lbl } from './ScreenEditor';
import { useI18n } from '@/providers/LanguageProvider';

interface DatasetTableInfo {
  id: number;
  display_name: string;
  source_table_name: string;
  columns: { name: string; type?: string }[];
}

interface Props {
  screen: ScreenSpec;
  allScreens: ScreenSpec[];
  tables: DatasetTableInfo[];
  onChange: (next: ScreenSpec) => void;
}

type TableSpec = TableScreenSpecBuilt;
type ActiveItem =
  | 'columns'
  | 'editable'
  | 'behaviour'
  | 'settings'
  | 'defaults'
  | 'totals'
  | 'column_groups'
  | 'row_merge'
  | 'column_meta'
  | 'detail_panel'
  | 'empty'
  | 'display'
  | 'pos_cart'
  | 'format_rules'
  | 'kpi'
  | 'row_actions'
  | 'bulk_actions'
  | `filter:${number}`
  | `computed:${number}`
  | `lookup:${number}`
  | `rollup:${number}`;

// Display-mode cards shown at the top of the Structure › Display-mode overview.
// Same data, different render — the card grid replaces the old <select>.
const DISPLAY_MODE_OPTIONS: Array<{
  value: 'table' | 'gallery' | 'calendar' | 'route_map';
  labelKey: string;
  descKey: string;
  icon: React.ElementType;
}> = [
  { value: 'table', labelKey: 'workboards.table.displayMode.table', descKey: 'workboards.table.displayMode.tableDesc', icon: LayoutGrid },
  { value: 'gallery', labelKey: 'workboards.table.displayMode.gallery', descKey: 'workboards.table.displayMode.galleryDesc', icon: ImageIcon },
  { value: 'calendar', labelKey: 'workboards.table.displayMode.calendar', descKey: 'workboards.table.displayMode.calendarDesc', icon: CalendarDays },
  { value: 'route_map', labelKey: 'workboards.table.displayMode.routeMap', descKey: 'workboards.table.displayMode.routeMapDesc', icon: MapPinned },
];

// Quick-link cards under "Các cấu hình chính" — jump to the main config objects.
// `tableOnly` shortcuts only make sense for the classic Table grid; they are
// hidden when Gallery / Calendar / Route map is the active display mode.
const CONFIG_SHORTCUTS: Array<{
  key: ActiveItem;
  labelKey: string;
  descKey: string;
  icon: React.ElementType;
  tableOnly?: boolean;
}> = [
  { key: 'columns', labelKey: 'workboards.table.shortcut.fields', descKey: 'workboards.table.shortcut.fieldsDesc', icon: Columns3 },
  { key: 'editable', labelKey: 'workboards.table.shortcut.editableFields', descKey: 'workboards.table.shortcut.editableFieldsDesc', icon: PencilLine },
  { key: 'settings', labelKey: 'workboards.table.shortcut.filtersSorting', descKey: 'workboards.table.shortcut.filtersSortingDesc', icon: Filter },
  { key: 'column_meta', labelKey: 'workboards.table.shortcut.columnPresentation', descKey: 'workboards.table.shortcut.columnPresentationDesc', icon: Settings2, tableOnly: true },
  { key: 'column_groups', labelKey: 'workboards.table.shortcut.headerGroups', descKey: 'workboards.table.shortcut.headerGroupsDesc', icon: Columns3, tableOnly: true },
  { key: 'row_merge', labelKey: 'workboards.table.shortcut.rowMerge', descKey: 'workboards.table.shortcut.rowMergeDesc', icon: Rows3, tableOnly: true },
  { key: 'format_rules', labelKey: 'workboards.table.shortcut.conditionalFormatting', descKey: 'workboards.table.shortcut.conditionalFormattingDesc', icon: Palette, tableOnly: true },
  { key: 'totals', labelKey: 'workboards.table.shortcut.footerTotals', descKey: 'workboards.table.shortcut.footerTotalsDesc', icon: Sigma, tableOnly: true },
  { key: 'kpi', labelKey: 'workboards.table.shortcut.kpiTiles', descKey: 'workboards.table.shortcut.kpiTilesDesc', icon: LayoutGrid },
];

function DisplayModeCard({
  active,
  label,
  desc,
  icon: Icon,
  onClick,
}: {
  active: boolean;
  label: string;
  desc: string;
  icon: React.ElementType;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative flex flex-col gap-2 rounded-xl border p-4 text-left transition-colors ${
        active
          ? 'border-brand bg-brand/5 ring-1 ring-brand/40'
          : 'border-[rgb(var(--border-line))] bg-surface-1 hover:border-brand/40 hover:bg-surface-2'
      }`}
    >
      <span
        className={`absolute right-3 top-3 flex h-4 w-4 items-center justify-center rounded-full border ${
          active ? 'border-brand bg-brand text-white' : 'border-[rgb(var(--border-strong))]'
        }`}
      >
        {active && <Check className="h-2.5 w-2.5" />}
      </span>
      <span
        className={`inline-flex h-9 w-9 items-center justify-center rounded-lg ${
          active ? 'bg-brand/15 text-brand' : 'bg-surface-2 text-text-tertiary'
        }`}
      >
        <Icon className="h-5 w-5" />
      </span>
      <span className="text-caption font-semibold text-text-primary">{label}</span>
      <span className="text-tiny leading-relaxed text-text-tertiary">{desc}</span>
    </button>
  );
}

function ConfigShortcutCard({
  label,
  desc,
  icon: Icon,
  onClick,
}: {
  label: string;
  desc: string;
  icon: React.ElementType;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-start gap-3 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3 text-left transition-colors hover:border-brand/40 hover:bg-surface-2"
    >
      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand/10 text-brand">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-caption font-medium text-text-primary">{label}</span>
        <span className="block text-tiny leading-relaxed text-text-tertiary">{desc}</span>
      </span>
      <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-text-quaternary" />
    </button>
  );
}

// A typed sub-section under the single "Derived data" navigator group —
// keeps Computed / Lookup / Roll-up visually under one hierarchy while each
// keeps its own count + add button.
function DerivedSubGroup({
  label,
  count,
  onAdd,
  addTitle,
  addDisabled = false,
  children,
}: {
  label: string;
  count: number;
  onAdd: () => void;
  addTitle: string;
  addDisabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 pl-2">
        <h4 className="text-tiny font-medium text-text-tertiary">
          {label} ({count})
        </h4>
        <button
          type="button"
          onClick={onAdd}
          disabled={addDisabled}
          className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
          title={addTitle}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function displayModeLabel(
  mode: 'table' | 'gallery' | 'calendar' | 'route_map' | undefined,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const option = DISPLAY_MODE_OPTIONS.find((item) => item.value === (mode || 'table'));
  return option ? t(option.labelKey) : t('workboards.table.displayMode.table');
}

const EMPTY_TABLE: TableSpec = {
  columns: [],
  editable_columns: [],
  filters: [],
  page_size: 100,
  // Fail-safe: writes OFF by default (matches the new-table-screen defaults in
  // WorkboardBuilder.addScreen). A table only accepts add/delete once the
  // builder explicitly turns them on.
  allow_add_row: false,
  allow_delete_row: false,
  required_columns: [],
  default_values: {},
  computed_columns: [],
  lookup_columns: [],
  totals: {},
};

const CELL_FORMATS: Array<{ value: CellFormat; labelKey: string }> = [
  { value: 'text', labelKey: 'workboards.table.format.text' },
  { value: 'number', labelKey: 'workboards.table.format.number' },
  { value: 'integer', labelKey: 'workboards.table.format.integer' },
  { value: 'currency', labelKey: 'workboards.table.format.currency' },
  { value: 'percent', labelKey: 'workboards.table.format.percent' },
  { value: 'date', labelKey: 'workboards.table.format.date' },
  { value: 'datetime', labelKey: 'workboards.table.format.datetime' },
];

const TOTALS_KINDS: Array<{ value: TableTotalsKind; labelKey: string }> = [
  { value: 'sum', labelKey: 'workboards.table.agg.sum' },
  { value: 'avg', labelKey: 'workboards.table.agg.avg' },
  { value: 'min', labelKey: 'workboards.table.agg.min' },
  { value: 'max', labelKey: 'workboards.table.agg.max' },
  { value: 'count', labelKey: 'workboards.table.agg.countNonEmpty' },
];

/** Model-driven VLOOKUP suggestions. Reads the dataset semantic model's
 * relationships (same endpoint the form-field lookup editor uses) so the
 * builder doesn't have to re-pick table + match columns by hand — building
 * the Model once now pays off for table VLOOKUP columns too. */
function LookupModelSuggestions({
  fromTableId,
  onApply,
}: {
  fromTableId?: number | null;
  onApply: (s: {
    target_table_id: number;
    from_column: string;
    to_column: string;
    label?: string | null;
  }) => void;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(false);
  const [deep, setDeep] = useState(false);
  useEffect(() => {
    if (!fromTableId) {
      setItems([]);
      return;
    }
    setLoading(true);
    fetch(
      `/api/v1/workboard-relationships?from_table_id=${fromTableId}${deep ? '&deep_scan=true' : ''}`,
      { credentials: 'include' },
    )
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [fromTableId, deep]);

  if (!fromTableId) return null;
  if (loading) {
    return <p className="text-caption text-text-tertiary">{t('workboards.table.lookup.loadingSuggestions')}</p>;
  }
  return (
    <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-caption font-emphasis text-text-secondary">{t('workboards.table.lookup.modelSuggestions')}</span>
        {!deep && (
          <button
            type="button"
            onClick={() => setDeep(true)}
            className="text-caption text-brand hover:underline"
            title={t('workboards.table.lookup.deepScanTitle')}
          >
            {t('workboards.table.lookup.deepScan')}
          </button>
        )}
      </div>
      {!items.length ? (
        <p className="text-caption text-text-tertiary">
          {deep
            ? t('workboards.table.lookup.noDeepSuggestions')
            : t('workboards.table.lookup.noSuggestions')}
        </p>
      ) : (
      <div className="space-y-1.5">
        {items.map((s, i) => {
          const disp = String(s.target_table_display || t('workboards.table.lookup.relatedTable'));
          const fromCol = String(s.from_column || '');
          const toCol = String(s.to_column || '');
          const labelCol =
            (s.suggested_label_columns as string[] | undefined)?.[0] || null;
          return (
            <button
              key={i}
              type="button"
              onClick={() =>
                onApply({
                  target_table_id: Number(s.target_table_id),
                  from_column: fromCol,
                  to_column: toCol,
                  label: labelCol,
                })
              }
              className="w-full rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-3 py-2 text-left text-caption hover:border-brand"
            >
              <span className="font-emphasis text-text-primary">{t('workboards.table.lookup.useTable', { table: disp })}</span>
              <span className="block text-text-tertiary">
                {t('workboards.table.lookup.match')}: <code className="font-mono">{fromCol} = {toCol}</code>
                {labelCol ? (
                  <>
                    {' '}· {t('workboards.table.lookup.take')}: <code className="font-mono">{labelCol}</code>
                  </>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      )}
    </div>
  );
}

export default function TableScreenEditor({ screen, allScreens, tables, onChange }: Props) {
  const { t } = useI18n();
  const tableSpec = screen.table || EMPTY_TABLE;
  const filters = useMemo(() => tableSpec.filters || [], [tableSpec.filters]);
  const computed = useMemo(
    () => tableSpec.computed_columns || [],
    [tableSpec.computed_columns],
  );
  const lookups = useMemo(
    () => tableSpec.lookup_columns || [],
    [tableSpec.lookup_columns],
  );
  const rollups = useMemo(
    () => tableSpec.rollup_columns || [],
    [tableSpec.rollup_columns],
  );
  const formatRules = useMemo(
    () => tableSpec.format_rules || [],
    [tableSpec.format_rules],
  );
  const rowActions = useMemo(
    () => tableSpec.row_actions || [],
    [tableSpec.row_actions],
  );
  const relatedRecordTargets = useMemo(
    () =>
      allScreens.flatMap((candidate) =>
        candidate.kind === 'form' &&
        candidate.table_id === screen.table_id &&
        candidate.form?.related_records
          ? candidate.form.related_records.map((relation) => ({
              parentScreenId: candidate.id,
              parentTitle: candidate.title,
              relation,
            }))
          : [],
      ),
    [allScreens, screen.table_id],
  );
  const totals = tableSpec.totals || {};
  const boundTable = tables.find((table) => table.id === screen.table_id);
  const tableCols = boundTable?.columns ?? [];
  const columnNames = tableCols.map((column) => column.name);
  const tableMissing = !!screen.table_id && !boundTable;
  const [activeItem, setActiveItem] = useState<ActiveItem>('display');

  // All column identifiers visible to formula scope: regular + lookup +
  // computed (so a downstream formula can reference an upstream one).
  const allReferenceableColumns = useMemo(
    () => [
      ...columnNames,
      ...lookups.map((l) => l.name),
      ...rollups.map((r) => r.name),
      ...computed.map((c) => c.name),
    ],
    [columnNames, lookups, rollups, computed],
  );

  const activeComputedIndex = activeItem.startsWith('computed:')
    ? Number(activeItem.slice('computed:'.length))
    : -1;
  const activeLookupIndex = activeItem.startsWith('lookup:')
    ? Number(activeItem.slice('lookup:'.length))
    : -1;
  const activeRollupIndex = activeItem.startsWith('rollup:')
    ? Number(activeItem.slice('rollup:'.length))
    : -1;

  useEffect(() => {
    if (activeItem.startsWith('computed:') && activeComputedIndex >= computed.length) {
      setActiveItem(computed.length > 0 ? `computed:${computed.length - 1}` : 'columns');
    }
    if (activeItem.startsWith('lookup:') && activeLookupIndex >= lookups.length) {
      setActiveItem(lookups.length > 0 ? `lookup:${lookups.length - 1}` : 'columns');
    }
    if (activeItem.startsWith('rollup:') && activeRollupIndex >= rollups.length) {
      setActiveItem(rollups.length > 0 ? `rollup:${rollups.length - 1}` : 'columns');
    }
  }, [
    activeComputedIndex,
    activeItem,
    activeLookupIndex,
    activeRollupIndex,
    computed.length,
    lookups.length,
    rollups.length,
  ]);

  const updateTable = (patch: Partial<TableSpec>) =>
    onChange({ ...screen, table: { ...tableSpec, ...patch } });

  // Grid-layout settings (column presentation, header groups, row merge,
  // conditional formatting, footer totals, POS) only make sense for the
  // classic Table grid — Gallery / Calendar / Route map render differently,
  // so we don't promote those objects when another display mode is active.
  const isTableMode = (tableSpec.display_mode || 'table') === 'table';

  const addFilter = () => {
    if (columnNames.length === 0) return;
    const next: TableFilterSpec[] = [
      ...filters,
      { column: columnNames[0], kind: 'text', label: '' },
    ];
    updateTable({ filters: next });
    // Filters live inline in the unified "Filters & sorting" inspector now.
    setActiveItem('settings');
  };

  const updateFilter = (idx: number, patch: Partial<TableFilterSpec>) => {
    const next = [...filters];
    next[idx] = { ...next[idx], ...patch };
    updateTable({ filters: next });
  };

  const removeFilter = (idx: number) => {
    const next = filters.filter((_, index) => index !== idx);
    updateTable({ filters: next });
  };

  // ── Computed columns ─────────────────────────────────────────────────
  const addComputed = () => {
    const baseName = `computed_${computed.length + 1}`;
    let name = baseName;
    let suffix = 1;
    const taken = new Set(allReferenceableColumns);
    while (taken.has(name)) {
      suffix += 1;
      name = `${baseName}_${suffix}`;
    }
    const next: TableComputedColumnSpec[] = [
      ...computed,
      { name, label: '', formula: '', format: null },
    ];
    // Auto-add the new column to the visible list so the user sees what
    // they're configuring without an extra "Show this column" click.
    const nextVisible = tableSpec.columns.includes(name)
      ? tableSpec.columns
      : [...tableSpec.columns, name];
    updateTable({ computed_columns: next, columns: nextVisible });
    setActiveItem(`computed:${next.length - 1}`);
  };

  const updateComputed = (idx: number, patch: Partial<TableComputedColumnSpec>) => {
    const next = [...computed];
    const prev = next[idx];
    next[idx] = { ...prev, ...patch };
    // If the user renamed the column, update the columns array + totals key.
    let nextColumns = tableSpec.columns;
    let nextTotals = totals;
    if (patch.name && patch.name !== prev.name) {
      nextColumns = nextColumns.map((c) => (c === prev.name ? patch.name! : c));
      if (totals[prev.name]) {
        nextTotals = { ...totals };
        nextTotals[patch.name] = nextTotals[prev.name];
        delete nextTotals[prev.name];
      }
    }
    updateTable({
      computed_columns: next,
      columns: nextColumns,
      totals: nextTotals,
    });
  };

  const removeComputed = (idx: number) => {
    const removed = computed[idx];
    const next = computed.filter((_, index) => index !== idx);
    const nextColumns = tableSpec.columns.filter((c) => c !== removed?.name);
    const nextTotals = { ...totals };
    if (removed) delete nextTotals[removed.name];
    updateTable({
      computed_columns: next,
      columns: nextColumns,
      totals: nextTotals,
    });
    if (activeComputedIndex === idx) {
      setActiveItem(
        next.length > 0
          ? `computed:${Math.max(0, Math.min(idx, next.length - 1))}`
          : 'columns',
      );
    } else if (activeComputedIndex > idx) {
      setActiveItem(`computed:${activeComputedIndex - 1}`);
    }
  };

  // ── Lookup columns ───────────────────────────────────────────────────
  const addLookup = () => {
    const baseName = `lookup_${lookups.length + 1}`;
    let name = baseName;
    let suffix = 1;
    const taken = new Set(allReferenceableColumns);
    while (taken.has(name)) {
      suffix += 1;
      name = `${baseName}_${suffix}`;
    }
    const firstTable = tables[0];
    const next: TableLookupColumnSpec[] = [
      ...lookups,
      {
        name,
        label: '',
        from_table_id: firstTable?.id ?? 0,
        match_column_local: columnNames[0] || '',
        match_column_remote: firstTable?.columns[0]?.name || '',
        return_column: firstTable?.columns[0]?.name || '',
        format: null,
      },
    ];
    // Auto-add the new column to the visible list, same as computed columns —
    // the user just declared it, so showing it by default matches intent.
    const nextVisible = tableSpec.columns.includes(name)
      ? tableSpec.columns
      : [...tableSpec.columns, name];
    updateTable({ lookup_columns: next, columns: nextVisible });
    setActiveItem(`lookup:${next.length - 1}`);
  };

  const updateLookup = (idx: number, patch: Partial<TableLookupColumnSpec>) => {
    const next = [...lookups];
    const prev = next[idx];
    next[idx] = { ...prev, ...patch };
    let nextColumns = tableSpec.columns;
    let nextTotals = totals;
    if (patch.name && patch.name !== prev.name) {
      nextColumns = nextColumns.map((c) => (c === prev.name ? patch.name! : c));
      if (totals[prev.name]) {
        nextTotals = { ...totals };
        nextTotals[patch.name] = nextTotals[prev.name];
        delete nextTotals[prev.name];
      }
    }
    updateTable({
      lookup_columns: next,
      columns: nextColumns,
      totals: nextTotals,
    });
  };

  const removeLookup = (idx: number) => {
    const removed = lookups[idx];
    const next = lookups.filter((_, index) => index !== idx);
    const nextColumns = tableSpec.columns.filter((c) => c !== removed?.name);
    const nextTotals = { ...totals };
    if (removed) delete nextTotals[removed.name];
    updateTable({
      lookup_columns: next,
      columns: nextColumns,
      totals: nextTotals,
    });
    if (activeLookupIndex === idx) {
      setActiveItem(
        next.length > 0
          ? `lookup:${Math.max(0, Math.min(idx, next.length - 1))}`
          : 'columns',
      );
    } else if (activeLookupIndex > idx) {
      setActiveItem(`lookup:${activeLookupIndex - 1}`);
    }
  };

  // ── Roll-up columns (aggregate a child table up to this row) ──────────
  const addRollup = () => {
    const baseName = `rollup_${rollups.length + 1}`;
    let name = baseName;
    let suffix = 1;
    const taken = new Set(allReferenceableColumns);
    while (taken.has(name)) {
      suffix += 1;
      name = `${baseName}_${suffix}`;
    }
    const firstTable = tables[0];
    const next: TableRollupColumnSpec[] = [
      ...rollups,
      {
        name,
        label: '',
        from_table_id: firstTable?.id ?? 0,
        match_column_local: columnNames[0] || '',
        match_column_remote: firstTable?.columns[0]?.name || '',
        agg: 'count',
        value_column: null,
        format: null,
      },
    ];
    const nextVisible = tableSpec.columns.includes(name)
      ? tableSpec.columns
      : [...tableSpec.columns, name];
    updateTable({ rollup_columns: next, columns: nextVisible });
    setActiveItem(`rollup:${next.length - 1}`);
  };

  const updateRollup = (idx: number, patch: Partial<TableRollupColumnSpec>) => {
    const next = [...rollups];
    const prev = next[idx];
    next[idx] = { ...prev, ...patch };
    let nextColumns = tableSpec.columns;
    let nextTotals = totals;
    if (patch.name && patch.name !== prev.name) {
      nextColumns = nextColumns.map((c) => (c === prev.name ? patch.name! : c));
      if (totals[prev.name]) {
        nextTotals = { ...totals };
        nextTotals[patch.name] = nextTotals[prev.name];
        delete nextTotals[prev.name];
      }
    }
    updateTable({ rollup_columns: next, columns: nextColumns, totals: nextTotals });
  };

  const removeRollup = (idx: number) => {
    const removed = rollups[idx];
    const next = rollups.filter((_, index) => index !== idx);
    const nextColumns = tableSpec.columns.filter((c) => c !== removed?.name);
    const nextTotals = { ...totals };
    if (removed) delete nextTotals[removed.name];
    updateTable({
      rollup_columns: next,
      columns: nextColumns,
      totals: nextTotals,
    });
    if (activeRollupIndex === idx) {
      setActiveItem(
        next.length > 0
          ? `rollup:${Math.max(0, Math.min(idx, next.length - 1))}`
          : 'columns',
      );
    } else if (activeRollupIndex > idx) {
      setActiveItem(`rollup:${activeRollupIndex - 1}`);
    }
  };

  // ── Conditional formatting rules ─────────────────────────────────────
  const addFormatRule = () => {
    const next: FormatRuleSpec[] = [
      ...formatRules,
      { when: '', color: 'amber', columns: [], icon: null, label: null },
    ];
    updateTable({ format_rules: next });
    setActiveItem('format_rules');
  };

  const updateFormatRule = (idx: number, patch: Partial<FormatRuleSpec>) => {
    const next = formatRules.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    updateTable({ format_rules: next });
  };

  const removeFormatRule = (idx: number) => {
    updateTable({ format_rules: formatRules.filter((_, i) => i !== idx) });
  };

  // ── Row actions (per-row buttons that navigate carrying row values) ──
  const addRowAction = () => {
    const existing = new Set(rowActions.map((a) => a.id));
    let n = rowActions.length + 1;
    let id = `action_${n}`;
    while (existing.has(id)) {
      n += 1;
      id = `action_${n}`;
    }
    const next: ScreenAction[] = [
      ...rowActions,
      {
        id,
        label: t('workboards.table.defaultOpenLabel'),
        style: 'secondary',
        action_type: 'navigate',
        go_to_screen: null,
        carry: [],
        visible_for_roles: [],
      },
    ];
    updateTable({ row_actions: next });
    setActiveItem('row_actions');
  };

  const updateRowAction = (idx: number, patch: Partial<ScreenAction>) => {
    const next = rowActions.map((a, i) => (i === idx ? { ...a, ...patch } : a));
    updateTable({ row_actions: next });
  };

  const removeRowAction = (idx: number) => {
    updateTable({ row_actions: rowActions.filter((_, i) => i !== idx) });
  };

  // ── Bulk actions (select many rows → gộp nhóm / điều phối) ──
  // The advanced server recipe (`steps`) + simple write targets are round-tripped;
  // the builder edits the surface knobs (totals, capacity check, pickers, route).
  const bulkActions = tableSpec.bulk_actions || [];
  const updateBulk = (idx: number, patch: Partial<NonNullable<TableSpec['bulk_actions']>[number]>) => {
    updateTable({ bulk_actions: bulkActions.map((a, i) => (i === idx ? { ...a, ...patch } : a)) });
  };
  const removeBulk = (idx: number) => {
    updateTable({ bulk_actions: bulkActions.filter((_, i) => i !== idx) });
  };
  const addBulk = () => {
    const existing = new Set(bulkActions.map((a) => a.id));
    let n = bulkActions.length + 1;
    let id = `bulk_${n}`;
    while (existing.has(id)) {
      n += 1;
      id = `bulk_${n}`;
    }
    const other = allScreens.find((s) => s.id !== screen.id);
    updateTable({
      bulk_actions: [
        ...bulkActions,
        {
          id,
          label: t('workboards.table.defaultBulkActionLabel'),
          style: 'primary',
          // Simple-mode write targets — BE requires these (non-empty) when `steps`
          // is empty; defaulted so it saves, the author points them at the real
          // parent screen/columns.
          parent_screen_id: other?.id || '',
          parent_code_column: columnNames[0] || '',
          set_column: columnNames[0] || '',
          code_prefix: 'GRP',
          min_selection: 1,
          preview_aggregates: [],
          constraints: [],
          resource_inputs: [],
        },
      ],
    });
    setActiveItem('bulk_actions');
  };

  const toggleColumnVisible = (column: string) => {
    if (tableSpec.columns.includes(column)) {
      updateTable({ columns: tableSpec.columns.filter((c) => c !== column) });
    } else {
      updateTable({ columns: [...tableSpec.columns, column] });
    }
  };

  const renderInspector = () => {
    if (activeItem === 'columns') {
      // Pickable column set = regular DB columns + every derived column the
      // builder has declared (computed / lookup / roll-up), so the user can
      // drag any of them into the visible list without leaving this inspector.
      const pickable = [
        ...columnNames,
        ...computed.map((c) => c.name),
        ...lookups.map((l) => l.name),
        ...rollups.map((r) => r.name),
      ];
      return (
        <BuilderInspectorPanel
          icon={<Columns3 className="h-4 w-4" />}
          title={t('workboards.table.visibleColumnsTitle')}
          subtitle={t('workboards.table.visibleColumnsSubtitle')}
        >
          {pickable.length === 0 ? (
            <BuilderEmptyHint className="text-left">
              {t('workboards.table.noColumnsDataSource')}
            </BuilderEmptyHint>
          ) : (
            <>
              <MultiColumnPicker
                sourceColumns={pickable}
                value={tableSpec.columns}
                onChange={(columns) => {
                  // Drop editable_columns / required_columns that are no
                  // longer visible. Computed/lookup names never end up
                  // editable or required (the inspectors that manage them
                  // already strip them on add).
                  const visible = new Set(columns);
                  updateTable({
                    columns,
                    editable_columns: (tableSpec.editable_columns || []).filter((c) =>
                      visible.has(c),
                    ),
                    required_columns: (tableSpec.required_columns || []).filter((c) =>
                      visible.has(c),
                    ),
                  });
                }}
                placeholder={t('workboards.table.pickColumnsPlaceholder')}
              />
              {(computed.length > 0 || lookups.length > 0 || rollups.length > 0) && (
                <p className="mt-2 text-caption text-text-tertiary">
                  {t('workboards.table.derivedColumnsHint')}
                </p>
              )}
            </>
          )}
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'editable') {
      const derived = new Set([
        ...computed.map((c) => c.name),
        ...lookups.map((l) => l.name),
      ]);
      const editableCandidates = tableSpec.columns.filter((c) => !derived.has(c));
      return (
        <BuilderInspectorPanel
          icon={<PencilLine className="h-4 w-4" />}
          title={t('workboards.table.editableColumnsTitle')}
          subtitle={t('workboards.table.editableColumnsSubtitle')}
        >
          {editableCandidates.length === 0 ? (
            <BuilderEmptyHint className="text-left">
              {t('workboards.table.noEditableCandidates')}
            </BuilderEmptyHint>
          ) : (
            <MultiColumnPicker
              sourceColumns={editableCandidates}
              value={(tableSpec.editable_columns || []).filter((c) => !derived.has(c))}
              onChange={(editable_columns) => updateTable({ editable_columns })}
              placeholder={t('workboards.table.noEditableColumns')}
            />
          )}
          <p className="mt-2 text-caption text-text-tertiary">
            {t('workboards.table.roleWriteHint')}
          </p>
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'behaviour') {
      return (
        <BuilderInspectorPanel
          icon={<Settings2 className="h-4 w-4" />}
          title={t('workboards.table.rowBehaviourTitle')}
          subtitle={t('workboards.table.rowBehaviourSubtitle')}
        >
          <div className="space-y-3">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={tableSpec.allow_add_row !== false}
                onChange={(event) =>
                  updateTable({ allow_add_row: event.target.checked })
                }
                className="mt-0.5"
              />
              <span className="text-caption text-text-secondary">
                <span className="font-emphasis text-text-primary">
                  {t('workboards.table.allowAddingRows')}
                </span>
                <span className="ml-1 text-text-tertiary">
                  {t('workboards.table.allowAddingRowsHint')}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={tableSpec.allow_delete_row !== false}
                onChange={(event) =>
                  updateTable({ allow_delete_row: event.target.checked })
                }
                className="mt-0.5"
              />
              <span className="text-caption text-text-secondary">
                <span className="font-emphasis text-text-primary">
                  {t('workboards.table.allowDeletingRows')}
                </span>
                <span className="ml-1 text-text-tertiary">
                  {t('workboards.table.allowDeletingRowsHint')}
                </span>
              </span>
            </label>
          </div>

          {/* ── Row lock (per-row edit/delete lock) ─────────────────────── */}
          {(() => {
            const rl = tableSpec.row_lock || null;
            const mode: 'off' | 'whole' | 'condition' = !rl
              ? 'off'
              : rl.lock_if === 'true'
                ? 'whole'
                : 'condition';
            const roles = (rl?.editable_by_roles || []).map((r) => r.toLowerCase());
            const setLock = (patch: Partial<NonNullable<typeof rl>>) =>
              updateTable({
                row_lock: {
                  lock_if: '',
                  editable_by_roles: [],
                  lock_delete: true,
                  ...(rl || {}),
                  ...patch,
                },
              });
            const changeMode = (next: 'off' | 'whole' | 'condition') => {
              if (next === 'off') return updateTable({ row_lock: null });
              if (next === 'whole')
                return updateTable({
                  row_lock: {
                    lock_if: 'true',
                    editable_by_roles: rl?.editable_by_roles ?? ['admin'],
                    lock_delete: rl?.lock_delete !== false,
                    message: rl?.message ?? null,
                  },
                });
              return updateTable({
                row_lock: {
                  lock_if: rl && rl.lock_if !== 'true' ? rl.lock_if : '',
                  editable_by_roles: rl?.editable_by_roles ?? [],
                  lock_delete: rl?.lock_delete !== false,
                  message: rl?.message ?? null,
                },
              });
            };
            const toggleRole = (role: string) => {
              const has = roles.includes(role);
              setLock({
                editable_by_roles: has
                  ? (rl?.editable_by_roles || []).filter((r) => r.toLowerCase() !== role)
                  : [...(rl?.editable_by_roles || []), role],
              });
            };
            return (
              <div className="mt-5 border-t border-[rgb(var(--border-line))] pt-4">
                <div className="mb-1 text-caption font-emphasis text-text-primary">
                  {t('workboards.table.rowLockTitle')}
                </div>
                <p className="mb-2 text-tiny text-text-tertiary">
                  {t('workboards.table.rowLockSubtitle')}
                </p>
                <select
                  value={mode}
                  onChange={(e) => changeMode(e.target.value as 'off' | 'whole' | 'condition')}
                  className={INPUT}
                >
                  <option value="off">{t('workboards.table.rowLockOff')}</option>
                  <option value="whole">{t('workboards.table.rowLockWhole')}</option>
                  <option value="condition">{t('workboards.table.rowLockCondition')}</option>
                </select>

                {mode !== 'off' ? (
                  <div className="mt-3 space-y-3">
                    {mode === 'condition' ? (
                      <div className="space-y-2">
                        <div className="text-tiny font-medium text-text-secondary">
                          {t('workboards.table.rowLockColumn')}
                        </div>
                        <select
                          value=""
                          onChange={(e) => {
                            if (e.target.value) setLock({ lock_if: `[${e.target.value}]` });
                          }}
                          className={INPUT}
                        >
                          <option value="">—</option>
                          {columnNames.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                        <input
                          value={rl?.lock_if || ''}
                          onChange={(e) => setLock({ lock_if: e.target.value })}
                          placeholder="[trang_thai]=='Đã duyệt'"
                          className={`${INPUT} font-mono`}
                        />
                        <p className="text-tiny text-text-tertiary">
                          {t('workboards.table.rowLockExprHint')}
                        </p>
                      </div>
                    ) : (
                      <p className="text-tiny text-text-tertiary">
                        {t('workboards.table.rowLockWholeHint')}
                      </p>
                    )}

                    <div>
                      <div className="mb-1 text-tiny font-medium text-text-secondary">
                        {t('workboards.table.rowLockRoles')}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {['admin', 'user'].map((role) => {
                          const on = roles.includes(role);
                          return (
                            <button
                              key={role}
                              type="button"
                              onClick={() => toggleRole(role)}
                              className={`rounded-full border px-2 py-0.5 text-tiny ${
                                on
                                  ? 'border-brand-500 bg-brand-50 text-brand-700'
                                  : 'border-[rgb(var(--border-line))] text-text-secondary hover:bg-surface-2'
                              }`}
                            >
                              {role}
                            </button>
                          );
                        })}
                      </div>
                      <p className="mt-1 text-tiny text-text-tertiary">
                        {t('workboards.table.rowLockRolesHint')}
                      </p>
                    </div>

                    <label className="flex items-center gap-2 text-tiny text-text-secondary">
                      <input
                        type="checkbox"
                        checked={rl?.lock_delete !== false}
                        onChange={(e) => setLock({ lock_delete: e.target.checked })}
                        className="h-3.5 w-3.5"
                      />
                      {t('workboards.table.rowLockDelete')}
                    </label>

                    <input
                      value={rl?.message || ''}
                      onChange={(e) => setLock({ message: e.target.value || null })}
                      placeholder={t('workboards.table.rowLockMessage')}
                      className={INPUT}
                    />
                  </div>
                ) : null}
              </div>
            );
          })()}
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'settings') {
      return (
        <BuilderInspectorPanel
          icon={<Filter className="h-4 w-4" />}
          title={t('workboards.table.filtersSortingTitle')}
          subtitle={t('workboards.table.filtersSortingSubtitle')}
        >
          <div className="space-y-5">
            {/* Pre-set filters — the slicers rendered above the table. */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <div className="text-caption font-emphasis text-text-secondary">
                  {t('workboards.table.filtersCount', { count: filters.length })}
                </div>
                <button
                  type="button"
                  onClick={addFilter}
                  disabled={columnNames.length === 0}
                  className="inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-tiny text-text-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Plus className="h-3.5 w-3.5" /> {t('workboards.table.addFilter')}
                </button>
              </div>
              {filters.length === 0 ? (
                <BuilderEmptyHint className="text-left">
                  {t('workboards.table.noPresetFilters')}
                </BuilderEmptyHint>
              ) : (
                <div className="space-y-2">
                  {filters.map((filter, index) => (
                    <div
                      key={index}
                      className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3"
                    >
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-caption font-medium text-text-primary">
                          {filter.label?.trim() || filter.column || t('workboards.table.filterFallback')}
                        </span>
                        <BuilderIconButton
                          onClick={() => removeFilter(index)}
                          title={t('workboards.table.deleteFilter')}
                          variant="danger"
                        >
                          <Trash2 className="h-3.5 w-3.5 text-danger" />
                        </BuilderIconButton>
                      </div>
                      <div className={BUILDER_GRID_2}>
                        <Lbl label={t('workboards.table.column')}>
                          <SingleColumnPicker
                            sourceColumns={columnNames}
                            value={filter.column}
                            onChange={(next) =>
                              updateFilter(index, { column: next || '' })
                            }
                          />
                        </Lbl>
                        <Lbl label={t('workboards.table.filterKind')}>
                          <select
                            value={filter.kind}
                            onChange={(event) =>
                              updateFilter(index, {
                                kind: event.target.value as TableFilterSpec['kind'],
                              })
                            }
                            className={INPUT}
                          >
                            <option value="text">{t('workboards.table.filterText')}</option>
                            <option value="select">{t('workboards.table.filterSelect')}</option>
                            <option value="date_range">{t('workboards.table.filterDateRange')}</option>
                            <option value="number_range">{t('workboards.table.filterNumberRange')}</option>
                          </select>
                        </Lbl>
                        <Lbl label={t('workboards.table.displayLabel')}>
                          <input
                            value={filter.label || ''}
                            onChange={(event) =>
                              updateFilter(index, { label: event.target.value })
                            }
                            className={INPUT}
                            placeholder={filter.column}
                          />
                        </Lbl>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Sorting & paging. */}
            <div className="border-t border-[rgb(var(--border-line))] pt-4">
              <div className="mb-2 text-caption font-emphasis text-text-secondary">
                {t('workboards.table.sortingPaging')}
              </div>
              <div className={BUILDER_GRID_2}>
                <Lbl label={t('workboards.table.rowsPerPage')}>
                  <input
                    type="number"
                    min={10}
                    max={500}
                    value={tableSpec.page_size ?? 100}
                    onChange={(event) =>
                      updateTable({
                        page_size: Math.min(
                          500,
                          Math.max(10, Number(event.target.value) || 100),
                        ),
                      })
                    }
                    className={INPUT}
                  />
                </Lbl>
                <Lbl label={t('workboards.table.defaultSortColumn')}>
                  <SingleColumnPicker
                    sourceColumns={columnNames}
                    value={tableSpec.default_sort_column || null}
                    onChange={(next) => updateTable({ default_sort_column: next || null })}
                    placeholder={t('workboards.table.noDefaultSort')}
                  />
                </Lbl>
                <Lbl label={t('workboards.table.defaultSortDirection')}>
                  <select
                    value={tableSpec.default_sort_direction || 'desc'}
                    onChange={(event) =>
                      updateTable({
                        default_sort_direction:
                          (event.target.value as 'asc' | 'desc') || 'desc',
                      })
                    }
                    className={INPUT}
                  >
                    <option value="desc">{t('workboards.table.descending')}</option>
                    <option value="asc">{t('workboards.table.ascending')}</option>
                  </select>
                </Lbl>
              </div>
            </div>
          </div>
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'defaults') {
      return (
        <BuilderInspectorPanel
          icon={<Plus className="h-4 w-4" />}
          title={t('workboards.table.newRowDefaultsTitle')}
          subtitle={t('workboards.table.newRowDefaultsSubtitle')}
        >
          <div className="space-y-4">
            <Lbl label={t('workboards.table.requiredColumns')}>
              {tableSpec.columns.length === 0 ? (
                <BuilderEmptyHint className="text-left">
                  {t('workboards.table.pickVisibleColumnsFirst')}
                </BuilderEmptyHint>
              ) : (
                <MultiColumnPicker
                  sourceColumns={tableSpec.columns}
                  value={tableSpec.required_columns || []}
                  onChange={(required_columns) => updateTable({ required_columns })}
                  placeholder={t('workboards.table.noRequiredColumns')}
                />
              )}
            </Lbl>
            <DefaultValuesEditor
              defaults={tableSpec.default_values || {}}
              columns={tableSpec.columns}
              onChange={(default_values) => updateTable({ default_values })}
            />
          </div>
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'empty') {
      return (
        <BuilderInspectorPanel
          icon={<ListFilter className="h-4 w-4" />}
          title={t('workboards.table.emptyStateTitle')}
          subtitle={t('workboards.table.emptyStateSubtitle')}
        >
          <Lbl label={t('workboards.table.emptyStateMessage')}>
            <input
              value={tableSpec.empty_state_message || ''}
              onChange={(event) =>
                updateTable({ empty_state_message: event.target.value })
              }
              className={INPUT}
              placeholder={t('workboards.table.emptyStatePlaceholder')}
            />
          </Lbl>
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'row_actions') {
      const navScreens = allScreens.filter((s) => s.id !== screen.id);
      return (
        <BuilderInspectorPanel
          icon={<ChevronRight className="h-4 w-4" />}
          title={t('workboards.table.rowActionsTitle')}
          subtitle={t('workboards.table.rowActionsSubtitle')}
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-caption font-emphasis text-text-secondary">
                {t('workboards.table.actionsCount', { count: rowActions.length })}
              </div>
              <button
                type="button"
                onClick={addRowAction}
                className="inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-tiny text-text-secondary hover:bg-surface-2"
              >
                <Plus className="h-3.5 w-3.5" /> {t('workboards.table.addAction')}
              </button>
            </div>

            {rowActions.length === 0 ? (
              <BuilderEmptyHint className="text-left">
                {t('workboards.table.noRowActionsHint')}
              </BuilderEmptyHint>
            ) : (
              <div className="space-y-3">
                {rowActions.map((action, index) => (
                  <div
                    key={index}
                    className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3"
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-caption font-medium text-text-primary">
                        {action.label?.trim() || t('workboards.table.actionFallback')}
                      </span>
                      <BuilderIconButton
                        onClick={() => removeRowAction(index)}
                        title={t('workboards.table.deleteAction')}
                        variant="danger"
                      >
                        <Trash2 className="h-3.5 w-3.5 text-danger" />
                      </BuilderIconButton>
                    </div>
                    <div className="space-y-3">
                      <div className={BUILDER_GRID_2}>
                        <Lbl label={t('workboards.table.buttonLabel')}>
                          <input
                            value={action.label || ''}
                            onChange={(e) => updateRowAction(index, { label: e.target.value })}
                            className={INPUT}
                            placeholder={t('workboards.table.buttonLabelPlaceholder')}
                          />
                        </Lbl>
                        <Lbl label={t('workboards.table.buttonStyle')}>
                          <select
                            value={action.style || 'secondary'}
                            onChange={(e) =>
                              updateRowAction(index, {
                                style: e.target.value as NonNullable<ScreenAction['style']>,
                              })
                            }
                            className={INPUT}
                          >
                            <option value="primary">{t('workboards.table.style.primary')}</option>
                            <option value="secondary">{t('workboards.table.style.secondary')}</option>
                            <option value="ghost">{t('workboards.table.style.ghost')}</option>
                            <option value="danger">{t('workboards.table.style.danger')}</option>
                          </select>
                        </Lbl>
                        <Lbl label={t('workboards.table.actionType')}>
                          <select
                            value={action.action_type || 'navigate'}
                            onChange={(e) =>
                              updateRowAction(index, {
                                action_type: e.target.value as NonNullable<
                                  ScreenAction['action_type']
                                >,
                                ...(e.target.value === 'navigate'
                                  ? { relation_id: null, parent_screen_id: null }
                                  : { go_to_screen: null, carry: [] }),
                              })
                            }
                            className={INPUT}
                          >
                            <option value="navigate">{t('workboards.table.actionNavigate')}</option>
                            <option value="open_related_records">{t('workboards.table.actionOpenRelated')}</option>
                          </select>
                        </Lbl>
                        {(action.action_type || 'navigate') === 'open_related_records' ? (
                          <Lbl label={t('workboards.table.relation')}>
                            <select
                              value={
                                action.parent_screen_id && action.relation_id
                                  ? `${action.parent_screen_id}::${action.relation_id}`
                                  : ''
                              }
                              onChange={(event) => {
                                const [parentScreenId, relationId] =
                                  event.target.value.split('::');
                                updateRowAction(index, {
                                  parent_screen_id: parentScreenId || null,
                                  relation_id: relationId || null,
                                });
                              }}
                              className={INPUT}
                            >
                              <option value="">{t('workboards.table.pickRelation')}</option>
                              {relatedRecordTargets.map(({ parentScreenId, parentTitle, relation }) => (
                                <option
                                  key={`${parentScreenId}:${relation.id}`}
                                  value={`${parentScreenId}::${relation.id}`}
                                >
                                  {relation.label || relation.id} ({parentTitle})
                                </option>
                              ))}
                            </select>
                          </Lbl>
                        ) : (
                          <Lbl label={t('workboards.table.goToScreen')}>
                            <select
                              value={action.go_to_screen || ''}
                              onChange={(e) =>
                                updateRowAction(index, { go_to_screen: e.target.value || null })
                              }
                              className={INPUT}
                            >
                              <option value="">{t('workboards.table.none')}</option>
                              {navScreens.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.title}
                                </option>
                              ))}
                            </select>
                          </Lbl>
                        )}
                        <Lbl label={t('workboards.table.confirmMessageOptional')}>
                          <input
                            value={action.confirm_message || ''}
                            onChange={(e) =>
                              updateRowAction(index, {
                                confirm_message: e.target.value || null,
                              })
                            }
                            className={INPUT}
                            placeholder={t('workboards.table.confirmMessagePlaceholder')}
                          />
                        </Lbl>
                      </div>
                      {(action.action_type || 'navigate') === 'navigate' && action.go_to_screen && (
                        <Lbl label={t('workboards.table.carryColumns')}>
                          {columnNames.length > 0 ? (
                            <MultiColumnPicker
                              sourceColumns={columnNames}
                              value={action.carry || []}
                              onChange={(carry) => updateRowAction(index, { carry })}
                              placeholder={t('workboards.table.carryColumnsPlaceholder')}
                            />
                          ) : (
                            <input
                              value={(action.carry || []).join(', ')}
                              onChange={(e) =>
                                updateRowAction(index, {
                                  carry: e.target.value
                                    .split(',')
                                    .map((s) => s.trim())
                                    .filter(Boolean),
                                })
                              }
                              className={INPUT}
                              placeholder="e.g. id, ma_don"
                            />
                          )}
                        </Lbl>
                      )}
                      <Lbl label={t('workboards.table.visibleForRolesOptional')}>
                        <input
                          value={(action.visible_for_roles || []).join(', ')}
                          onChange={(e) =>
                            updateRowAction(index, {
                              visible_for_roles: e.target.value
                                .split(',')
                                .map((s) => s.trim())
                                .filter(Boolean),
                            })
                          }
                          className={INPUT}
                          placeholder={t('workboards.table.allRolesPlaceholder')}
                        />
                      </Lbl>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'bulk_actions') {
      const otherScreens = allScreens.filter((s) => s.id !== screen.id);
      const AGG_OPTS = ['sum', 'count', 'avg', 'min', 'max'] as const;
      return (
        <BuilderInspectorPanel
          icon={<ChevronRight className="h-4 w-4" />}
          title={t('workboards.table.bulk.title')}
          subtitle={t('workboards.table.bulk.subtitle')}
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-caption font-emphasis text-text-secondary">
                {t('workboards.table.actionsCount', { count: bulkActions.length })}
              </div>
              <button
                type="button"
                onClick={addBulk}
                className="inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-tiny text-text-secondary hover:bg-surface-2"
              >
                <Plus className="h-3.5 w-3.5" /> {t('workboards.table.addAction')}
              </button>
            </div>

            {bulkActions.length === 0 ? (
              <BuilderEmptyHint className="text-left">
                {t('workboards.table.bulk.emptyHint')}
              </BuilderEmptyHint>
            ) : (
              <div className="space-y-4">
                {bulkActions.map((action, index) => {
                  const aggs = action.preview_aggregates || [];
                  const cons = action.constraints || [];
                  const ress = action.resource_inputs || [];
                  const advanced = Array.isArray(action.steps) && action.steps.length > 0;
                  return (
                    <div key={index} className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-caption font-medium text-text-primary">
                          {action.label?.trim() || t('workboards.table.actionFallback')}
                          {advanced ? (
                            <span className="ml-1 text-tiny text-text-tertiary">
                              · {t('workboards.table.advanced')}
                            </span>
                          ) : null}
                        </span>
                        <BuilderIconButton onClick={() => removeBulk(index)} title={t('workboards.table.bulk.deleteAction')} variant="danger">
                          <Trash2 className="h-3.5 w-3.5 text-danger" />
                        </BuilderIconButton>
                      </div>

                      <div className="space-y-3">
                        <div className={BUILDER_GRID_2}>
                          <Lbl label={t('workboards.table.buttonLabel')}>
                            <input value={action.label || ''} onChange={(e) => updateBulk(index, { label: e.target.value })} className={INPUT} placeholder={t('workboards.table.bulk.buttonLabelPlaceholder')} />
                          </Lbl>
                          <Lbl label={t('workboards.table.buttonStyle')}>
                            <select value={action.style || 'primary'} onChange={(e) => updateBulk(index, { style: e.target.value as NonNullable<TableSpec['bulk_actions']>[number]['style'] })} className={INPUT}>
                              <option value="primary">{t('workboards.table.style.primary')}</option>
                              <option value="secondary">{t('workboards.table.style.secondary')}</option>
                              <option value="ghost">{t('workboards.table.style.ghost')}</option>
                              <option value="danger">{t('workboards.table.style.danger')}</option>
                            </select>
                          </Lbl>
                          <Lbl label={t('workboards.table.iconOptional')}>
                            <input value={action.icon || ''} onChange={(e) => updateBulk(index, { icon: e.target.value || null })} className={INPUT} placeholder="🚚" />
                          </Lbl>
                          <Lbl label={t('workboards.table.minRows')}>
                            <input type="number" min={1} value={action.min_selection ?? 1} onChange={(e) => updateBulk(index, { min_selection: Math.max(1, Number(e.target.value) || 1) })} className={INPUT} />
                          </Lbl>
                        </div>

                        <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2/40 p-2.5">
                          <div className="mb-1.5 flex items-center justify-between">
                            <div className="text-tiny font-emphasis text-text-secondary">{t('workboards.table.bulk.constraintsTitle')}</div>
                            <button type="button" onClick={() => updateBulk(index, { constraints: [...cons, { agg_column: columnNames[0] || '', agg: 'sum', op: '<=', limit: null, limit_from_resource: ress[0]?.id || null }] })} className="text-tiny text-brand hover:underline">+ {t('workboards.table.add')}</button>
                          </div>
                          {cons.length === 0 ? (
                            <p className="text-tiny text-text-tertiary">{t('workboards.table.bulk.noConstraintsHint')}</p>
                          ) : (
                            <div className="space-y-2">
                              {cons.map((c, ci) => {
                                const setC = (patch: Partial<typeof c>) => updateBulk(index, { constraints: cons.map((x, xi) => (xi === ci ? { ...x, ...patch } : x)) });
                                return (
                                  <div key={ci} className="rounded border border-[rgb(var(--border-line))] bg-surface-1 p-2">
                                    <div className="mb-1 flex items-center justify-between">
                                      <span className="text-tiny text-text-tertiary">#{ci + 1}</span>
                                      <button type="button" onClick={() => updateBulk(index, { constraints: cons.filter((_, xi) => xi !== ci) })} className="text-tiny text-danger hover:underline">{t('workboards.table.delete')}</button>
                                    </div>
                                    <div className={BUILDER_GRID_2}>
                                      <Lbl label={t('workboards.table.bulk.constraintColumn')}>
                                        <SingleColumnPicker sourceColumns={columnNames} value={c.agg_column || null} onChange={(next) => setC({ agg_column: next || '' })} />
                                      </Lbl>
                                      <Lbl label={t('workboards.table.aggregate')}>
                                        <select value={c.agg || 'sum'} onChange={(e) => setC({ agg: e.target.value as typeof c.agg })} className={INPUT}>{AGG_OPTS.map((a) => <option key={a} value={a}>{a}</option>)}</select>
                                      </Lbl>
                                      <Lbl label={t('workboards.table.compare')}>
                                        <select value={c.op || '<='} onChange={(e) => setC({ op: e.target.value as typeof c.op })} className={INPUT}>{(['<=', '<', '>=', '>'] as const).map((o) => <option key={o} value={o}>{o}</option>)}</select>
                                      </Lbl>
                                      <Lbl label={t('workboards.table.labelOptional')}>
                                        <input value={c.label || ''} onChange={(e) => setC({ label: e.target.value || null })} className={INPUT} placeholder={t('workboards.table.bulk.constraintLabelPlaceholder')} />
                                      </Lbl>
                                      <Lbl label={t('workboards.table.fixedLimit')}>
                                        <input type="number" value={c.limit ?? ''} onChange={(e) => setC({ limit: e.target.value === '' ? null : Number(e.target.value) })} className={INPUT} placeholder="vd 2500" disabled={!!c.limit_from_resource} />
                                      </Lbl>
                                      <Lbl label={t('workboards.table.bulk.limitFromResource')}>
                                        <select value={c.limit_from_resource || ''} onChange={(e) => setC({ limit_from_resource: e.target.value || null })} className={INPUT}>
                                          <option value="">{t('workboards.table.bulk.useFixedLimit')}</option>
                                          {ress.map((r) => <option key={r.id} value={r.id}>{r.label || r.id}</option>)}
                                        </select>
                                      </Lbl>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2/40 p-2.5">
                          <div className="mb-1.5 flex items-center justify-between">
                            <div className="text-tiny font-emphasis text-text-secondary">{t('workboards.table.bulk.previewAggregatesTitle')}</div>
                            <button type="button" onClick={() => updateBulk(index, { preview_aggregates: [...aggs, { label: '', column: columnNames[0] || '', agg: 'sum', format: 'number' }] })} className="text-tiny text-brand hover:underline">+ {t('workboards.table.add')}</button>
                          </div>
                          {aggs.length === 0 ? (
                            <p className="text-tiny text-text-tertiary">{t('workboards.table.bulk.previewAggregatesHint')}</p>
                          ) : (
                            <div className="space-y-2">
                              {aggs.map((pa, pi) => {
                                const setA = (patch: Partial<typeof pa>) => updateBulk(index, { preview_aggregates: aggs.map((x, xi) => (xi === pi ? { ...x, ...patch } : x)) });
                                return (
                                  <div key={pi} className="grid grid-cols-[1fr_1fr_auto_auto] items-end gap-2">
                                    <Lbl label={t('workboards.table.label')}><input value={pa.label || ''} onChange={(e) => setA({ label: e.target.value })} className={INPUT} placeholder={t('workboards.table.bulk.previewAggregateLabelPlaceholder')} /></Lbl>
                                    <Lbl label={t('workboards.table.column')}><SingleColumnPicker sourceColumns={columnNames} value={pa.column || null} onChange={(next) => setA({ column: next || '' })} /></Lbl>
                                    <Lbl label={t('workboards.table.aggregate')}><select value={pa.agg || 'sum'} onChange={(e) => setA({ agg: e.target.value as typeof pa.agg })} className={INPUT}>{AGG_OPTS.map((a) => <option key={a} value={a}>{a}</option>)}</select></Lbl>
                                    <button type="button" onClick={() => updateBulk(index, { preview_aggregates: aggs.filter((_, xi) => xi !== pi) })} className="mb-1 text-tiny text-danger hover:underline">{t('workboards.table.delete')}</button>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2/40 p-2.5">
                          <div className="mb-1.5 flex items-center justify-between">
                            <div className="text-tiny font-emphasis text-text-secondary">{t('workboards.table.bulk.resourcesTitle')}</div>
                            <button type="button" onClick={() => updateBulk(index, { resource_inputs: [...ress, { id: `res_${ress.length + 1}`, label: '', source_screen_id: otherScreens[0]?.id || '', value_column: '', label_column: null, capacity_column: null, required: true }] })} className="text-tiny text-brand hover:underline">+ {t('workboards.table.add')}</button>
                          </div>
                          {ress.length === 0 ? (
                            <p className="text-tiny text-text-tertiary">{t('workboards.table.bulk.resourcesHint')}</p>
                          ) : (
                            <div className="space-y-2">
                              {ress.map((r, ri) => {
                                const setR = (patch: Partial<typeof r>) => updateBulk(index, { resource_inputs: ress.map((x, xi) => (xi === ri ? { ...x, ...patch } : x)) });
                                return (
                                  <div key={ri} className="rounded border border-[rgb(var(--border-line))] bg-surface-1 p-2">
                                    <div className="mb-1 flex items-center justify-between">
                                      <span className="text-tiny text-text-tertiary">{r.id}</span>
                                      <button type="button" onClick={() => updateBulk(index, { resource_inputs: ress.filter((_, xi) => xi !== ri) })} className="text-tiny text-danger hover:underline">{t('workboards.table.delete')}</button>
                                    </div>
                                    <div className={BUILDER_GRID_2}>
                                      <Lbl label={t('workboards.table.bulk.resourcePickerLabel')}><input value={r.label || ''} onChange={(e) => setR({ label: e.target.value })} className={INPUT} placeholder={t('workboards.table.bulk.resourcePickerPlaceholder')} /></Lbl>
                                      <Lbl label={t('workboards.table.bulk.sourceScreen')}><select value={r.source_screen_id || ''} onChange={(e) => setR({ source_screen_id: e.target.value })} className={INPUT}><option value="">{t('workboards.table.pickScreen')}</option>{otherScreens.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></Lbl>
                                      <Lbl label={t('workboards.table.valueColumn')}><input value={r.value_column || ''} onChange={(e) => setR({ value_column: e.target.value })} className={INPUT} placeholder="MaXe" /></Lbl>
                                      <Lbl label={t('workboards.table.displayColumnOptional')}><input value={r.label_column || ''} onChange={(e) => setR({ label_column: e.target.value || null })} className={INPUT} placeholder="BienSo" /></Lbl>
                                      <Lbl label={t('workboards.table.bulk.capacityColumn')}><input value={r.capacity_column || ''} onChange={(e) => setR({ capacity_column: e.target.value || null })} className={INPUT} placeholder="TaiTrongToiDaKg" /></Lbl>
                                      <label className="flex items-center gap-2 self-end pb-1 text-caption text-text-secondary"><input type="checkbox" checked={r.required !== false} onChange={(e) => setR({ required: e.target.checked })} /> {t('workboards.table.required')}</label>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2/40 p-2.5">
                          <div className="flex items-center justify-between">
                            <div className="text-tiny font-emphasis text-text-secondary">{t('workboards.table.bulk.routePreviewTitle')}</div>
                            {action.route_preview ? (
                              <button type="button" onClick={() => updateBulk(index, { route_preview: null })} className="text-tiny text-danger hover:underline">{t('workboards.table.off')}</button>
                            ) : (
                              <button type="button" onClick={() => updateBulk(index, { route_preview: { lat_column: columnNames[0] || '', lng_column: columnNames[0] || '', line_mode: 'road' } })} className="text-tiny text-brand hover:underline">+ {t('workboards.table.on')}</button>
                            )}
                          </div>
                          {action.route_preview ? (
                            <div className={`mt-2 ${BUILDER_GRID_2}`}>
                              <Lbl label={t('workboards.table.latColumn')}><SingleColumnPicker sourceColumns={columnNames} value={action.route_preview.lat_column || null} onChange={(next) => updateBulk(index, { route_preview: { ...action.route_preview!, lat_column: next || '' } })} /></Lbl>
                              <Lbl label={t('workboards.table.lngColumn')}><SingleColumnPicker sourceColumns={columnNames} value={action.route_preview.lng_column || null} onChange={(next) => updateBulk(index, { route_preview: { ...action.route_preview!, lng_column: next || '' } })} /></Lbl>
                              <Lbl label={t('workboards.table.orderColumnOptional')}><SingleColumnPicker sourceColumns={columnNames} value={action.route_preview.order_column || null} onChange={(next) => updateBulk(index, { route_preview: { ...action.route_preview!, order_column: next || null } })} /></Lbl>
                            </div>
                          ) : null}
                        </div>

                        {advanced ? (
                          <p className="rounded-md bg-surface-2/60 px-2.5 py-2 text-tiny text-text-tertiary">
                            {t('workboards.table.bulk.advancedFlow', { count: action.steps!.length })}
                          </p>
                        ) : (
                          <div className={BUILDER_GRID_2}>
                            <Lbl label={t('workboards.table.bulk.parentScreen')}><select value={action.parent_screen_id || ''} onChange={(e) => updateBulk(index, { parent_screen_id: e.target.value })} className={INPUT}><option value="">{t('workboards.table.pickScreen')}</option>{otherScreens.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></Lbl>
                            <Lbl label={t('workboards.table.bulk.parentCodeColumn')}><input value={action.parent_code_column || ''} onChange={(e) => updateBulk(index, { parent_code_column: e.target.value })} className={INPUT} placeholder="ma_chuyen" /></Lbl>
                            <Lbl label={t('workboards.table.bulk.selectedRowFkColumn')}><SingleColumnPicker sourceColumns={columnNames} value={action.set_column || null} onChange={(next) => updateBulk(index, { set_column: next || '' })} /></Lbl>
                            <Lbl label={t('workboards.table.bulk.codePrefix')}><input value={action.code_prefix || ''} onChange={(e) => updateBulk(index, { code_prefix: e.target.value })} className={INPUT} placeholder="CX" /></Lbl>
                          </div>
                        )}

                        <Lbl label={t('workboards.table.visibleForRolesOptional')}>
                          <input value={(action.visible_for_roles || []).join(', ')} onChange={(e) => updateBulk(index, { visible_for_roles: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} className={INPUT} placeholder={t('workboards.table.allRolesPlaceholder')} />
                        </Lbl>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'pos_cart') {
      const pos = (tableSpec.pos_cart || null) as PosCartConfigSpec | null;
      const ownCols = (tables.find((t) => t.id === screen.table_id)?.columns || []).map((c) => c.name);
      const catCols = pos
        ? (tables.find((t) => t.id === pos.catalog_table_id)?.columns || []).map((c) => c.name)
        : [];
      const setPos = (patch: Partial<PosCartConfigSpec>) =>
        updateTable({ pos_cart: { ...(pos as PosCartConfigSpec), ...patch } });
      const ColSel = ({
        value,
        onPick,
        cols,
        allowBlank = true,
      }: {
        value?: string | null;
        onPick: (v: string) => void;
        cols: string[];
        allowBlank?: boolean;
      }) => (
        <select value={value || ''} onChange={(e) => onPick(e.target.value)} className={INPUT}>
          {allowBlank && <option value="">{t('workboards.table.pickColumn')}</option>}
          {cols.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          {value && !cols.includes(value) && (
            <option value={value}>{t('workboards.table.customColumnOption', { column: value })}</option>
          )}
        </select>
      );
      const hdr = pos?.header_inputs || [];
      const setHdr = (next: PosCartHeaderInputSpec[]) => setPos({ header_inputs: next });
      const copyPairs = Object.entries(pos?.catalog_copy || {});
      const setCopy = (pairs: [string, string][]) =>
        setPos({ catalog_copy: Object.fromEntries(pairs.filter(([k]) => k)) });
      return (
        <BuilderInspectorPanel
          icon={<ScanLine className="h-4 w-4" />}
          title={t('workboards.table.pos.title')}
          subtitle={t('workboards.table.pos.subtitle')}
        >
          <div className="space-y-3">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={!!pos}
                onChange={(e) =>
                  updateTable({
                    pos_cart: e.target.checked
                      ? {
                          barcode_column: '',
                          quantity_column: '',
                          catalog_table_id: 0,
                          catalog_match_column: '',
                          catalog_copy: {},
                          header_inputs: [],
                          order_id_prefix: 'PN',
                          submit_label: t('workboards.table.pos.defaultSubmitLabel'),
                          allow_manual_search: true,
                        }
                      : null,
                  })
                }
                className="mt-0.5"
              />
              <span className="text-caption text-text-secondary">
                <span className="font-emphasis text-text-primary">{t('workboards.table.pos.enable')}</span>
                <span className="ml-1 text-text-tertiary">
                  {t('workboards.table.pos.enableHint')}
                </span>
              </span>
            </label>

            {pos && (
              <>
                <Lbl label={t('workboards.table.pos.catalogTable')}>
                  <select
                    value={pos.catalog_table_id || 0}
                    onChange={(e) => setPos({ catalog_table_id: Number(e.target.value) })}
                    className={INPUT}
                  >
                    <option value={0}>{t('workboards.table.pickTable')}</option>
                    {tables.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.display_name}
                      </option>
                    ))}
                  </select>
                </Lbl>
                <div className={BUILDER_GRID_2}>
                  <Lbl label={t('workboards.table.pos.catalogMatchColumn')}>
                    <ColSel value={pos.catalog_match_column} cols={catCols} onPick={(v) => setPos({ catalog_match_column: v })} />
                  </Lbl>
                  <Lbl label={t('workboards.table.pos.catalogLabelColumn')}>
                    <ColSel value={pos.catalog_label_column} cols={catCols} onPick={(v) => setPos({ catalog_label_column: v })} />
                  </Lbl>
                  <Lbl label={t('workboards.table.pos.catalogPriceColumn')}>
                    <ColSel value={pos.catalog_price_column} cols={catCols} onPick={(v) => setPos({ catalog_price_column: v })} />
                  </Lbl>
                  <Lbl label={t('workboards.table.pos.lineBarcodeColumn')}>
                    <ColSel value={pos.barcode_column} cols={ownCols} onPick={(v) => setPos({ barcode_column: v })} />
                  </Lbl>
                  <Lbl label={t('workboards.table.pos.lineQuantityColumn')}>
                    <ColSel value={pos.quantity_column} cols={ownCols} onPick={(v) => setPos({ quantity_column: v })} />
                  </Lbl>
                  <Lbl label={t('workboards.table.pos.lineAmountColumn')}>
                    <ColSel value={pos.amount_column} cols={ownCols} onPick={(v) => setPos({ amount_column: v })} />
                  </Lbl>
                  <Lbl label={t('workboards.table.pos.orderIdColumn')}>
                    <ColSel value={pos.order_id_column} cols={ownCols} onPick={(v) => setPos({ order_id_column: v })} />
                  </Lbl>
                  <Lbl label={t('workboards.table.pos.orderIdPrefix')}>
                    <input value={pos.order_id_prefix || ''} onChange={(e) => setPos({ order_id_prefix: e.target.value })} className={INPUT} placeholder="PN" />
                  </Lbl>
                  <Lbl label={t('workboards.table.pos.lineDateColumn')}>
                    <ColSel value={pos.date_column} cols={ownCols} onPick={(v) => setPos({ date_column: v })} />
                  </Lbl>
                </div>

                <div className="rounded-md border border-border-subtle p-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-caption font-emphasis text-text-primary">{t('workboards.table.pos.catalogCopyTitle')}</span>
                    <BuilderIconButton title={t('workboards.table.add')} onClick={() => setCopy([...(copyPairs as [string, string][]), ['', '']])}>
                      <Plus className="h-3.5 w-3.5" />
                    </BuilderIconButton>
                  </div>
                  {copyPairs.length === 0 && (
                    <p className="text-tiny text-text-tertiary">{t('workboards.table.pos.catalogCopyHint')}</p>
                  )}
                  {copyPairs.map(([lineCol, catCol], i) => (
                    <div key={i} className="mb-1 flex items-center gap-1">
                      <ColSel value={lineCol} cols={ownCols} onPick={(v) => { const p = [...copyPairs] as [string, string][]; p[i] = [v, catCol]; setCopy(p); }} />
                      <span className="text-text-tertiary">←</span>
                      <ColSel value={catCol} cols={catCols} onPick={(v) => { const p = [...copyPairs] as [string, string][]; p[i] = [lineCol, v]; setCopy(p); }} />
                      <BuilderIconButton title={t('workboards.table.delete')} variant="danger" onClick={() => setCopy((copyPairs as [string, string][]).filter((_, idx) => idx !== i))}>
                        <Trash2 className="h-3.5 w-3.5 text-danger" />
                      </BuilderIconButton>
                    </div>
                  ))}
                </div>

                <div className="rounded-md border border-border-subtle p-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-caption font-emphasis text-text-primary">{t('workboards.table.pos.headerInputsTitle')}</span>
                    <BuilderIconButton title={t('workboards.table.add')} onClick={() => setHdr([...hdr, { column: '', label: '', kind: 'text', options: [], required: false, write_to_line: true }])}>
                      <Plus className="h-3.5 w-3.5" />
                    </BuilderIconButton>
                  </div>
                  {hdr.map((h, i) => (
                    <div key={i} className="mb-2 space-y-1 rounded border border-border-subtle p-1.5">
                        <div className={BUILDER_GRID_2}>
                          <ColSel value={h.column} cols={ownCols} onPick={(v) => setHdr(hdr.map((x, idx) => (idx === i ? { ...x, column: v } : x)))} />
                          <input value={h.label} onChange={(e) => setHdr(hdr.map((x, idx) => (idx === i ? { ...x, label: e.target.value } : x)))} className={INPUT} placeholder={t('workboards.table.pos.headerLabelPlaceholder')} />
                          <select value={h.kind || 'text'} onChange={(e) => setHdr(hdr.map((x, idx) => (idx === i ? { ...x, kind: e.target.value as 'text' | 'select' | 'date' } : x)))} className={INPUT}>
                            <option value="text">{t('workboards.table.input.text')}</option>
                            <option value="select">{t('workboards.table.input.select')}</option>
                            <option value="date">{t('workboards.table.input.date')}</option>
                          </select>
                          <input value={(h.options || []).join(', ')} onChange={(e) => setHdr(hdr.map((x, idx) => (idx === i ? { ...x, options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } : x)))} className={INPUT} placeholder={t('workboards.table.pos.optionsPlaceholder')} />
                        </div>
                        <div className="flex items-center gap-3 text-tiny">
                          <label className="flex items-center gap-1"><input type="checkbox" checked={!!h.required} onChange={(e) => setHdr(hdr.map((x, idx) => (idx === i ? { ...x, required: e.target.checked } : x)))} /> {t('workboards.table.required')}</label>
                          <label className="flex items-center gap-1"><input type="checkbox" checked={h.write_to_line !== false} onChange={(e) => setHdr(hdr.map((x, idx) => (idx === i ? { ...x, write_to_line: e.target.checked } : x)))} /> {t('workboards.table.pos.writeToLine')}</label>
                          <BuilderIconButton title={t('workboards.table.delete')} variant="danger" onClick={() => setHdr(hdr.filter((_, idx) => idx !== i))}>
                            <Trash2 className="h-3.5 w-3.5 text-danger" />
                          </BuilderIconButton>
                      </div>
                    </div>
                  ))}
                </div>

                <div className={BUILDER_GRID_2}>
                  <Lbl label={t('workboards.table.pos.submitLabel')}>
                    <input value={pos.submit_label || ''} onChange={(e) => setPos({ submit_label: e.target.value })} className={INPUT} placeholder={t('workboards.table.pos.defaultSubmitLabel')} />
                  </Lbl>
                  <Lbl label={t('workboards.table.pos.afterSubmitScreen')}>
                    <input value={pos.after_submit_screen || ''} onChange={(e) => setPos({ after_submit_screen: e.target.value })} className={INPUT} placeholder="vd: phieu_nhap" />
                  </Lbl>
                  <Lbl label={t('workboards.table.pos.headerScreen')}>
                    <input value={pos.header_screen_id || ''} onChange={(e) => setPos({ header_screen_id: e.target.value })} className={INPUT} placeholder={t('workboards.table.pos.headerScreenPlaceholder')} />
                  </Lbl>
                  <Lbl label={t('workboards.table.pos.carryColumns')}>
                    <input value={(pos.after_submit_carry || []).join(', ')} onChange={(e) => setPos({ after_submit_carry: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} className={INPUT} placeholder="ma_don, loai, ma_kho" />
                  </Lbl>
                  <Lbl label={t('workboards.table.pos.emptyHint')}>
                    <input value={pos.empty_hint || ''} onChange={(e) => setPos({ empty_hint: e.target.value })} className={INPUT} />
                  </Lbl>
                </div>
                <label className="flex items-center gap-2 text-caption text-text-secondary">
                  <input type="checkbox" checked={pos.allow_manual_search !== false} onChange={(e) => setPos({ allow_manual_search: e.target.checked })} />
                  {t('workboards.table.pos.allowManualSearch')}
                </label>
              </>
            )}
          </div>
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'display') {
      const mode = tableSpec.display_mode || 'table';
      const gc = tableSpec.gallery_config || { image_column: '' };
      const updateGallery = (patch: Partial<NonNullable<TableSpec['gallery_config']>>) =>
        updateTable({ gallery_config: { ...gc, ...patch } });
      const cal = tableSpec.calendar_config || { date_column: '' };
      const updateCalendar = (patch: Partial<NonNullable<TableSpec['calendar_config']>>) =>
        updateTable({ calendar_config: { ...cal, ...patch } });
      const routeMap = tableSpec.route_map_config || {
        lat_column: '',
        lng_column: '',
        basemap: 'streets',
        line_mode: 'road',
        route_provider: 'osrm',
        route_profile: 'driving',
        fallback_line_mode: 'straight',
        show_side_panel: true,
      };
      const updateRouteMap = (patch: Partial<NonNullable<TableSpec['route_map_config']>>) =>
        updateTable({ route_map_config: { ...routeMap, ...patch } });
      const visibleCols = tableSpec.columns || [];
      return (
        <BuilderInspectorPanel
          icon={<LayoutGrid className="h-4 w-4" />}
          title={t('workboards.table.displayModeTitle')}
          subtitle={t('workboards.table.displayModeSubtitle')}
        >
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {DISPLAY_MODE_OPTIONS.map((opt) => (
              <DisplayModeCard
                key={opt.value}
                active={mode === opt.value}
                label={t(opt.labelKey)}
                desc={t(opt.descKey)}
                icon={opt.icon}
                onClick={() => updateTable({ display_mode: opt.value })}
              />
            ))}
          </div>
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2.5 text-caption text-text-secondary">
            <LayoutGrid className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
            <span>
              {t('workboards.table.currentStructure')}{' '}
              <strong className="text-text-primary">
                {displayModeLabel(mode, t)}
              </strong>
              . {t('workboards.table.currentStructureHelp')}
            </span>
          </div>

          {mode === 'calendar' && (
            <div className="mt-3 space-y-3">
              {visibleCols.length === 0 ? (
                <BuilderEmptyHint className="text-left">
                  {t('workboards.table.display.calendarNeedsVisibleColumns')}
                </BuilderEmptyHint>
              ) : (
                <>
                  <Lbl label={t('workboards.table.display.calendarDateColumn')}>
                    <SingleColumnPicker
                      sourceColumns={visibleCols}
                      value={cal.date_column || null}
                      onChange={(next) => updateCalendar({ date_column: next || '' })}
                      placeholder={t('workboards.table.display.calendarDatePlaceholder')}
                    />
                  </Lbl>
                  <Lbl label={t('workboards.table.display.calendarTitleColumn')}>
                    <SingleColumnPicker
                      sourceColumns={visibleCols}
                      value={cal.title_column || null}
                      onChange={(next) => updateCalendar({ title_column: next || null })}
                      placeholder={t('workboards.table.display.defaultPrimaryKeyPlaceholder')}
                    />
                  </Lbl>
                  <Lbl label={t('workboards.table.display.calendarColorColumn')}>
                    <SingleColumnPicker
                      sourceColumns={visibleCols}
                      value={cal.color_column || null}
                      onChange={(next) => updateCalendar({ color_column: next || null })}
                      placeholder={t('workboards.table.none')}
                    />
                  </Lbl>
                </>
              )}
            </div>
          )}

          {mode === 'gallery' && (
            <div className="mt-3 space-y-3">
              {visibleCols.length === 0 ? (
                <BuilderEmptyHint className="text-left">
                  {t('workboards.table.display.galleryNeedsVisibleColumns')}
                </BuilderEmptyHint>
              ) : (
                <>
                  <Lbl label={t('workboards.table.display.galleryImageColumn')}>
                    <SingleColumnPicker
                      sourceColumns={visibleCols}
                      value={gc.image_column || null}
                      onChange={(next) => updateGallery({ image_column: next || '' })}
                      placeholder={t('workboards.table.display.galleryImagePlaceholder')}
                    />
                  </Lbl>
                  <Lbl label={t('workboards.table.display.galleryTitleColumn')}>
                    <SingleColumnPicker
                      sourceColumns={visibleCols}
                      value={gc.title_column || null}
                      onChange={(next) => updateGallery({ title_column: next || null })}
                      placeholder={t('workboards.table.none')}
                    />
                  </Lbl>
                  <Lbl label={t('workboards.table.display.gallerySubtitleColumn')}>
                    <SingleColumnPicker
                      sourceColumns={visibleCols}
                      value={gc.subtitle_column || null}
                      onChange={(next) => updateGallery({ subtitle_column: next || null })}
                      placeholder={t('workboards.table.none')}
                    />
                  </Lbl>
                  <Lbl label={t('workboards.table.display.galleryGroupColumn')}>
                    <SingleColumnPicker
                      sourceColumns={visibleCols}
                      value={gc.group_by_column || null}
                      onChange={(next) => updateGallery({ group_by_column: next || null })}
                      placeholder={t('workboards.table.display.noGrouping')}
                    />
                  </Lbl>
                  <Lbl label={t('workboards.table.display.cardsPerRow')}>
                    <input
                      type="number"
                      min={1}
                      max={6}
                      value={gc.columns_per_row ?? 3}
                      onChange={(event) =>
                        updateGallery({
                          columns_per_row: Math.min(Math.max(Number(event.target.value) || 3, 1), 6),
                        })
                      }
                      className={INPUT}
                    />
                  </Lbl>
                </>
              )}
            </div>
          )}

          {mode === 'route_map' && (
            <div className="mt-3 space-y-3">
              {visibleCols.length === 0 ? (
                <BuilderEmptyHint className="text-left">
                  {t('workboards.table.display.routeNeedsVisibleColumns')}
                </BuilderEmptyHint>
              ) : (
                <>
                  <div className="rounded-lg border border-teal-100 bg-teal-50 px-3 py-2 text-xs text-teal-800">
                    {t('workboards.table.display.routeHelp')}
                  </div>
                  <div className={BUILDER_GRID_2}>
                    <Lbl label={t('workboards.table.latColumn')}>
                      <SingleColumnPicker
                        sourceColumns={visibleCols}
                        value={routeMap.lat_column || null}
                        onChange={(next) => updateRouteMap({ lat_column: next || '' })}
                        placeholder={t('workboards.table.display.routeLatPlaceholder')}
                      />
                    </Lbl>
                    <Lbl label={t('workboards.table.lngColumn')}>
                      <SingleColumnPicker
                        sourceColumns={visibleCols}
                        value={routeMap.lng_column || null}
                        onChange={(next) => updateRouteMap({ lng_column: next || '' })}
                        placeholder={t('workboards.table.display.routeLngPlaceholder')}
                      />
                    </Lbl>
                  </div>
                  <div className={BUILDER_GRID_2}>
                    <Lbl label={t('workboards.table.display.markerLabelColumn')}>
                      <SingleColumnPicker
                        sourceColumns={visibleCols}
                        value={routeMap.title_column || null}
                        onChange={(next) => updateRouteMap({ title_column: next || null })}
                        placeholder={t('workboards.table.display.routeMarkerPlaceholder')}
                      />
                    </Lbl>
                    <Lbl label={t('workboards.table.display.routeGroupColumn')}>
                      <SingleColumnPicker
                        sourceColumns={visibleCols}
                        value={routeMap.route_id_column || null}
                        onChange={(next) => updateRouteMap({ route_id_column: next || null })}
                        placeholder={t('workboards.table.display.routeGroupPlaceholder')}
                      />
                    </Lbl>
                  </div>
                  <div className={BUILDER_GRID_2}>
                    <Lbl label={t('workboards.table.display.pointOrderColumn')}>
                      <SingleColumnPicker
                        sourceColumns={visibleCols}
                        value={routeMap.order_column || null}
                        onChange={(next) => updateRouteMap({ order_column: next || null })}
                        placeholder={t('workboards.table.display.pointOrderPlaceholder')}
                      />
                    </Lbl>
                    <Lbl label={t('workboards.table.display.vehicleColumn')}>
                      <SingleColumnPicker
                        sourceColumns={visibleCols}
                        value={routeMap.vehicle_column || null}
                        onChange={(next) => updateRouteMap({ vehicle_column: next || null })}
                        placeholder={t('workboards.table.display.vehiclePlaceholder')}
                      />
                    </Lbl>
                  </div>
                  <Lbl label={t('workboards.table.display.pointSubtitleColumns')}>
                    <MultiColumnPicker
                      sourceColumns={visibleCols}
                      value={routeMap.subtitle_columns || []}
                      onChange={(next) => updateRouteMap({ subtitle_columns: next })}
                    />
                  </Lbl>
                  <div className={BUILDER_GRID_2}>
                    <Lbl label={t('workboards.table.display.weightColumn')}>
                      <SingleColumnPicker
                        sourceColumns={visibleCols}
                        value={routeMap.weight_column || null}
                        onChange={(next) => updateRouteMap({ weight_column: next || null })}
                        placeholder={t('workboards.table.none')}
                      />
                    </Lbl>
                    <Lbl label={t('workboards.table.valueColumn')}>
                      <SingleColumnPicker
                        sourceColumns={visibleCols}
                        value={routeMap.value_column || null}
                        onChange={(next) => updateRouteMap({ value_column: next || null })}
                        placeholder={t('workboards.table.none')}
                      />
                    </Lbl>
                  </div>
                  <div className={BUILDER_GRID_2}>
                    <Lbl label={t('workboards.table.display.deadlineColumn')}>
                      <SingleColumnPicker
                        sourceColumns={visibleCols}
                        value={routeMap.deadline_column || null}
                        onChange={(next) => updateRouteMap({ deadline_column: next || null })}
                        placeholder={t('workboards.table.none')}
                      />
                    </Lbl>
                    <Lbl label={t('workboards.table.display.statusColumn')}>
                      <SingleColumnPicker
                        sourceColumns={visibleCols}
                        value={routeMap.status_column || null}
                        onChange={(next) => updateRouteMap({ status_column: next || null })}
                        placeholder={t('workboards.table.none')}
                      />
                    </Lbl>
                  </div>
                  <div className={BUILDER_GRID_2}>
                    <Lbl label={t('workboards.table.display.routeLineMode')}>
                      <select
                        value={routeMap.line_mode || 'road'}
                        onChange={(event) => updateRouteMap({ line_mode: event.target.value as 'straight' | 'road' })}
                        className={INPUT}
                      >
                        <option value="road">{t('workboards.table.display.routeLineRoad')}</option>
                        <option value="straight">{t('workboards.table.display.routeLineStraight')}</option>
                      </select>
                    </Lbl>
                    <Lbl label={t('workboards.table.display.basemap')}>
                      <select
                        value={routeMap.basemap || 'streets'}
                        onChange={(event) => updateRouteMap({ basemap: event.target.value as 'satellite' | 'streets' | 'light' })}
                        className={INPUT}
                      >
                        <option value="streets">{t('workboards.table.display.basemapStreets')}</option>
                        <option value="light">{t('workboards.table.display.basemapLight')}</option>
                        <option value="satellite">{t('workboards.table.display.basemapSatellite')}</option>
                      </select>
                    </Lbl>
                  </div>
                  <div className={BUILDER_GRID_2}>
                    <Lbl label={t('workboards.table.display.sidePanelTitle')}>
                      <input
                        value={routeMap.side_panel_title || ''}
                        onChange={(event) => updateRouteMap({ side_panel_title: event.target.value || null })}
                        className={INPUT}
                        placeholder={t('workboards.table.display.sidePanelTitlePlaceholder')}
                      />
                    </Lbl>
                  </div>
                  <label className="flex items-center gap-2 text-caption text-text-secondary">
                    <input
                      type="checkbox"
                      checked={routeMap.show_side_panel !== false}
                      onChange={(event) => updateRouteMap({ show_side_panel: event.target.checked })}
                    />
                    {t('workboards.table.display.showSidePanel')}
                  </label>

                  <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3">
                    <div className="mb-1 flex items-center justify-between">
                      <div className="text-caption font-emphasis text-text-secondary">
                        {t('workboards.table.display.selectionBudgetTitle')}
                      </div>
                      {routeMap.selection_budget ? (
                        <button
                          type="button"
                          onClick={() => updateRouteMap({ selection_budget: null })}
                          className="text-tiny text-danger hover:underline"
                        >
                          {t('workboards.table.delete')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            updateRouteMap({
                              selection_budget: { value_column: columnNames[0] || '', block_when_over: true },
                            })
                          }
                          className="text-tiny text-brand hover:underline"
                        >
                          + {t('workboards.table.on')}
                        </button>
                      )}
                    </div>
                    {routeMap.selection_budget ? (
                      <div className="space-y-3">
                        <p className="text-tiny text-text-tertiary">
                          {t('workboards.table.display.selectionBudgetHelp')}
                          {routeMap.selection_budget.block_when_over !== false
                            ? ` + ${t('workboards.table.display.blockConfirmSuffix')}`
                            : ''}
                          .
                        </p>
                        <div className={BUILDER_GRID_2}>
                          <Lbl label={t('workboards.table.display.selectionValueColumn')}>
                            <SingleColumnPicker
                              sourceColumns={columnNames}
                              value={routeMap.selection_budget.value_column || null}
                              onChange={(next) =>
                                updateRouteMap({
                                  selection_budget: { ...routeMap.selection_budget!, value_column: next || '' },
                                })
                              }
                            />
                          </Lbl>
                          <Lbl label={t('workboards.table.display.selectionLimit')}>
                            <input
                              value={routeMap.selection_budget.limit || ''}
                              onChange={(e) =>
                                updateRouteMap({
                                  selection_budget: { ...routeMap.selection_budget!, limit: e.target.value || null },
                                })
                              }
                              className={INPUT}
                              placeholder={t('workboards.table.display.selectionLimitPlaceholder')}
                            />
                          </Lbl>
                          <Lbl label={t('workboards.table.unit')}>
                            <input
                              value={routeMap.selection_budget.unit || ''}
                              onChange={(e) =>
                                updateRouteMap({
                                  selection_budget: { ...routeMap.selection_budget!, unit: e.target.value || null },
                                })
                              }
                              className={INPUT}
                              placeholder="kg"
                            />
                          </Lbl>
                          <Lbl label={t('workboards.table.label')}>
                            <input
                              value={routeMap.selection_budget.label || ''}
                              onChange={(e) =>
                                updateRouteMap({
                                  selection_budget: { ...routeMap.selection_budget!, label: e.target.value || null },
                                })
                              }
                              className={INPUT}
                              placeholder={t('workboards.table.display.selectionLabelPlaceholder')}
                            />
                          </Lbl>
                        </div>
                        <label className="flex items-center gap-2 text-caption text-text-secondary">
                          <input
                            type="checkbox"
                            checked={routeMap.selection_budget.block_when_over !== false}
                            onChange={(e) =>
                              updateRouteMap({
                                selection_budget: { ...routeMap.selection_budget!, block_when_over: e.target.checked },
                              })
                            }
                          />
                          {t('workboards.table.display.blockWhenOver')}
                        </label>
                        <div className={BUILDER_GRID_2}>
                          <Lbl label={t('workboards.table.display.actionScreenOptional')}>
                            <select
                              value={routeMap.selection_budget.action_go_to_screen || ''}
                              onChange={(e) =>
                                updateRouteMap({
                                  selection_budget: {
                                    ...routeMap.selection_budget!,
                                    action_go_to_screen: e.target.value || null,
                                  },
                                })
                              }
                              className={INPUT}
                            >
                              <option value="">{t('workboards.table.none')}</option>
                              {allScreens
                                .filter((s) => s.id !== screen.id)
                                .map((s) => (
                                  <option key={s.id} value={s.id}>
                                    {s.title}
                                  </option>
                                ))}
                            </select>
                          </Lbl>
                          <Lbl label={t('workboards.table.display.actionLabel')}>
                            <input
                              value={routeMap.selection_budget.action_label || ''}
                              onChange={(e) =>
                                updateRouteMap({
                                  selection_budget: { ...routeMap.selection_budget!, action_label: e.target.value || null },
                                })
                              }
                              className={INPUT}
                              placeholder={t('workboards.table.display.actionLabelPlaceholder')}
                            />
                          </Lbl>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          )}

          <div className="mt-5 border-t border-[rgb(var(--border-line))] pt-4">
            <h3 className="mb-1 text-caption font-emphasis text-text-primary">
              {t('workboards.table.shortcutsFor')}{' '}
              {displayModeLabel(mode, t)}
            </h3>
            <p className="mb-3 text-tiny text-text-tertiary">
              {t('workboards.table.shortcutsHelp')}
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {CONFIG_SHORTCUTS.filter((c) => isTableMode || !c.tableOnly).map((c) => (
                <ConfigShortcutCard
                  key={c.key}
                  label={t(c.labelKey)}
                  desc={t(c.descKey)}
                  icon={c.icon}
                  onClick={() => setActiveItem(c.key)}
                />
              ))}
            </div>
          </div>
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'kpi') {
      return (
        <BuilderInspectorPanel
          icon={<LayoutGrid className="h-4 w-4" />}
          title={t('workboards.table.kpiTilesTitle')}
          subtitle={t('workboards.table.kpiTilesSubtitle')}
        >
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-caption font-medium text-text-secondary">{t('workboards.table.kpiTilesList')}</div>
              <button
                type="button"
                onClick={() =>
                  updateTable({
                    stat_tiles: [
                      ...(tableSpec.stat_tiles || []),
                      { label: '', column: '', agg: 'sum' },
                    ],
                  })
                }
                className="inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs text-text-secondary hover:bg-surface-2"
              >
                <Plus className="h-3.5 w-3.5" /> {t('workboards.table.addKpiTile')}
              </button>
            </div>
            {(tableSpec.stat_tiles || []).length === 0 ? (
              <BuilderEmptyHint className="text-left">
                {t('workboards.table.noKpiTiles')}
              </BuilderEmptyHint>
            ) : (
              (tableSpec.stat_tiles || []).map((tile, idx) => {
                const updateTile = (patch: Partial<NonNullable<TableSpec['stat_tiles']>[number]>) =>
                  updateTable({
                    stat_tiles: (tableSpec.stat_tiles || []).map((t, i) =>
                      i === idx ? { ...t, ...patch } : t,
                    ),
                  });
                return (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      value={tile.label}
                      onChange={(event) => updateTile({ label: event.target.value })}
                      placeholder={t('workboards.table.kpiLabelPlaceholder')}
                      className={INPUT}
                    />
                    <SingleColumnPicker
                      sourceColumns={tableSpec.columns || []}
                      value={tile.column || null}
                      onChange={(next) => updateTile({ column: next || '' })}
                      placeholder={t('workboards.table.pickColumnPlaceholder')}
                    />
                    <select
                      value={tile.agg || 'sum'}
                      onChange={(event) =>
                        updateTile({ agg: event.target.value as NonNullable<TableSpec['stat_tiles']>[number]['agg'] })
                      }
                      className={INPUT}
                    >
                      <option value="sum">sum</option>
                      <option value="avg">avg</option>
                      <option value="min">min</option>
                      <option value="max">max</option>
                      <option value="count">count</option>
                    </select>
                    <input
                      value={tile.unit || ''}
                      onChange={(event) => updateTile({ unit: event.target.value || null })}
                      placeholder={t('workboards.table.unitPlaceholder')}
                      className={`${INPUT} w-20`}
                    />
                    <button
                      type="button"
                      onClick={() =>
                        updateTable({
                          stat_tiles: (tableSpec.stat_tiles || []).filter((_, i) => i !== idx),
                        })
                      }
                      className="shrink-0 text-rose-600"
                      title={t('workboards.table.deleteKpiTile')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'totals') {
      // Footer aggregations. Every visible column is eligible; values are
      // restricted to the small ``TableTotalsKind`` set.
      return (
        <BuilderInspectorPanel
          icon={<Sigma className="h-4 w-4" />}
          title={t('workboards.table.totals.title')}
          subtitle={t('workboards.table.totals.subtitle')}
        >
          {tableSpec.columns.length === 0 ? (
            <BuilderEmptyHint className="text-left">
              {t('workboards.table.pickVisibleColumnsFirst')}
            </BuilderEmptyHint>
          ) : (
            <div className="space-y-1.5">
              {tableSpec.columns.map((col) => {
                const current = totals[col];
                return (
                  <div key={col} className="flex items-center gap-2">
                    <span className="w-40 truncate text-caption text-text-secondary">
                      {col}
                    </span>
                    <select
                      value={current ?? ''}
                      onChange={(event) => {
                        const next = { ...totals };
                        const v = event.target.value;
                        if (!v) delete next[col];
                        else next[col] = v as TableTotalsKind;
                        updateTable({ totals: next });
                      }}
                      className={`${INPUT} flex-1`}
                    >
                      <option value="">{t('workboards.table.none')}</option>
                      {TOTALS_KINDS.map((k) => (
                        <option key={k.value} value={k.value}>
                          {t(k.labelKey)}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-3 text-caption text-text-tertiary">
            {t('workboards.table.totals.help')}
          </p>
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'column_groups') {
      const groups = tableSpec.column_groups || [];
      const addGroup = () =>
        updateTable({ column_groups: [...groups, { label: '', columns: [] }] });
      const updateGroup = (idx: number, patch: Partial<{ label: string; columns: string[] }>) => {
        const next = groups.map((g, i) => (i === idx ? { ...g, ...patch } : g));
        updateTable({ column_groups: next });
      };
      const removeGroup = (idx: number) => {
        const next = groups.filter((_, i) => i !== idx);
        updateTable({ column_groups: next });
      };
      const assigned = new Set<string>();
      groups.forEach((g, i) => g.columns.forEach((c) => assigned.add(`${c}:${i}`)));
      const availableFor = (idx: number) =>
        tableSpec.columns.filter((c) => {
          for (let i = 0; i < groups.length; i += 1) {
            if (i !== idx && groups[i].columns.includes(c)) return false;
          }
          return true;
        });
      return (
        <BuilderInspectorPanel
          icon={<Columns3 className="h-4 w-4" />}
          title={t('workboards.table.headerGroups.title')}
          subtitle={t('workboards.table.headerGroups.subtitle')}
        >
          {tableSpec.columns.length === 0 ? (
            <BuilderEmptyHint className="text-left">
              {t('workboards.table.pickVisibleColumnsFirst')}
            </BuilderEmptyHint>
          ) : (
            <div className="space-y-3">
              {groups.length === 0 ? (
                <BuilderEmptyHint className="text-left">
                  {t('workboards.table.headerGroups.emptyHint')}
                </BuilderEmptyHint>
              ) : (
                groups.map((group, idx) => (
                  <div
                    key={idx}
                    className="space-y-2 rounded border border-[rgb(var(--border-line))] bg-surface-1 p-2"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        value={group.label}
                        onChange={(event) => updateGroup(idx, { label: event.target.value })}
                        className={`${INPUT} flex-1`}
                        placeholder={t('workboards.table.headerGroups.labelPlaceholder')}
                      />
                      <BuilderIconButton
                        onClick={() => removeGroup(idx)}
                        title={t('workboards.table.headerGroups.removeGroup')}
                        variant="danger"
                      >
                        <Trash2 className="h-3 w-3 text-danger" />
                      </BuilderIconButton>
                    </div>
                    <MultiColumnPicker
                      sourceColumns={availableFor(idx)}
                      value={group.columns}
                      onChange={(columns) => updateGroup(idx, { columns })}
                      placeholder={t('workboards.table.headerGroups.columnsPlaceholder')}
                    />
                  </div>
                ))
              )}
              <button
                type="button"
                onClick={addGroup}
                className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-1.5 text-caption hover:bg-surface-2"
              >
                + {t('workboards.table.headerGroups.addGroup')}
              </button>
              <p className="text-caption text-text-tertiary">
                {t('workboards.table.headerGroups.help')}
                {Array.from(assigned).length > 0 ? (
                  <>
                    <br />{t('workboards.table.headerGroups.assignedCount', { count: Array.from(assigned).length })}
                  </>
                ) : null}
              </p>
            </div>
          )}
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'row_merge') {
      const groupBy = tableSpec.group_by || [];
      const editableSet = new Set(tableSpec.editable_columns || []);
      const candidates = tableSpec.columns.filter((c) => !editableSet.has(c));
      return (
        <BuilderInspectorPanel
          icon={<Rows3 className="h-4 w-4" />}
          title={t('workboards.table.rowMerge.title')}
          subtitle={t('workboards.table.rowMerge.subtitle')}
        >
          {candidates.length === 0 ? (
            <BuilderEmptyHint className="text-left">
              {t('workboards.table.rowMerge.noCandidates')}
            </BuilderEmptyHint>
          ) : (
            <MultiColumnPicker
              sourceColumns={candidates}
              value={groupBy}
              onChange={(value) => updateTable({ group_by: value })}
              placeholder={t('workboards.table.rowMerge.columnsPlaceholder')}
            />
          )}
          <p className="mt-2 text-caption text-text-tertiary">
            {t('workboards.table.rowMerge.help')}
          </p>
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'column_meta') {
      const meta = tableSpec.column_metadata || {};
      const editableSet = new Set(tableSpec.editable_columns || []);
      const update = (col: string, patch: Partial<TableColumnMetaSpec>) => {
        const next = { ...meta, [col]: { ...(meta[col] || {}), ...patch } };
        updateTable({ column_metadata: next });
      };
      const TABLE_INPUT_TYPES: Array<{ value: TableInputType; labelKey: string }> = [
        { value: 'text', labelKey: 'workboards.table.input.text' },
        { value: 'number', labelKey: 'workboards.table.input.number' },
        { value: 'currency', labelKey: 'workboards.table.input.currency' },
        { value: 'percent', labelKey: 'workboards.table.input.percent' },
        { value: 'date', labelKey: 'workboards.table.input.date' },
        { value: 'datetime', labelKey: 'workboards.table.input.datetime' },
        { value: 'time', labelKey: 'workboards.table.input.time' },
        { value: 'checkbox', labelKey: 'workboards.table.input.checkbox' },
        { value: 'select', labelKey: 'workboards.table.input.select' },
        { value: 'enum_list', labelKey: 'workboards.table.input.multiSelect' },
        { value: 'rating', labelKey: 'workboards.table.input.rating' },
        { value: 'color', labelKey: 'workboards.table.input.color' },
        { value: 'slider', labelKey: 'workboards.table.input.slider' },
      ];
      return (
        <BuilderInspectorPanel
          icon={<Settings2 className="h-4 w-4" />}
          title={t('workboards.table.columnMeta.title')}
          subtitle={t('workboards.table.columnMeta.subtitle')}
        >
          {tableSpec.columns.length === 0 ? (
            <BuilderEmptyHint className="text-left">
              {t('workboards.table.pickVisibleColumnsFirst')}
            </BuilderEmptyHint>
          ) : (
            <div className="space-y-2">
              {tableSpec.columns.map((col) => {
                const m = meta[col] || {};
                return (
                  <div key={col} className="space-y-1 rounded border border-[rgb(var(--border-line))] bg-surface-1 p-2">
                    <div className="text-caption font-emphasis text-text-primary">{col}</div>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        value={m.label || ''}
                        onChange={(event) => update(col, { label: event.target.value })}
                        placeholder={t('workboards.table.columnMeta.friendlyLabel')}
                        className={INPUT}
                      />
                      <input
                        type="number"
                        value={m.width_px ?? ''}
                        onChange={(event) => {
                          const v = event.target.value;
                          update(col, { width_px: v ? Number(v) : null });
                        }}
                        placeholder={t('workboards.table.columnMeta.widthPx')}
                        className={INPUT}
                      />
                      <select
                        value={m.format || ''}
                        onChange={(event) =>
                          update(col, {
                            format: (event.target.value || null) as CellFormat | null,
                          })
                        }
                        className={INPUT}
                      >
                        <option value="">{t('workboards.table.columnMeta.pickFormat')}</option>
                        {CELL_FORMATS.map((f) => (
                          <option key={f.value} value={f.value}>
                            {t(f.labelKey)}
                          </option>
                        ))}
                      </select>
                      <select
                        value={m.align || ''}
                        onChange={(event) =>
                          update(col, {
                            align: (event.target.value || null) as 'left' | 'center' | 'right' | null,
                          })
                        }
                        className={INPUT}
                      >
                        <option value="">{t('workboards.table.columnMeta.pickAlign')}</option>
                        <option value="left">{t('workboards.table.align.left')}</option>
                        <option value="center">{t('workboards.table.align.center')}</option>
                        <option value="right">{t('workboards.table.align.right')}</option>
                      </select>
                    </div>
                    {editableSet.has(col) && (
                      <div className="mt-1 space-y-2 rounded bg-surface-2 p-2">
                        <div className="grid grid-cols-2 gap-2">
                          <Lbl label={t('workboards.table.columnMeta.inputType')}>
                            <select
                              value={m.input_type || ''}
                              onChange={(event) =>
                                update(col, {
                                  input_type: (event.target.value || null) as TableInputType | null,
                                })
                              }
                              className={INPUT}
                            >
                              <option value="">{t('workboards.table.columnMeta.defaultTextInput')}</option>
                              {TABLE_INPUT_TYPES.map((input) => (
                                <option key={input.value} value={input.value}>
                                  {t(input.labelKey)}
                                </option>
                              ))}
                            </select>
                          </Lbl>
                          {m.input_type === 'currency' && (
                            <Lbl label={t('workboards.table.columnMeta.currencyCode')}>
                              <input
                                value={m.currency_code || ''}
                                onChange={(event) =>
                                  update(col, { currency_code: event.target.value || null })
                                }
                                className={INPUT}
                                placeholder="VND"
                              />
                            </Lbl>
                          )}
                          {m.input_type === 'rating' && (
                            <Lbl label={t('workboards.table.columnMeta.maxStars')}>
                              <input
                                type="number"
                                min={1}
                                max={10}
                                value={m.max_stars ?? 5}
                                onChange={(event) =>
                                  update(col, { max_stars: Number(event.target.value) || 5 })
                                }
                                className={INPUT}
                              />
                            </Lbl>
                          )}
                        </div>
                        {m.input_type === 'slider' && (
                          <div className="grid grid-cols-3 gap-2">
                            <input
                              type="number"
                              value={m.min_value ?? 0}
                              onChange={(event) => update(col, { min_value: Number(event.target.value) })}
                              className={INPUT}
                              placeholder="min"
                            />
                            <input
                              type="number"
                              value={m.max_value ?? 100}
                              onChange={(event) => update(col, { max_value: Number(event.target.value) })}
                              className={INPUT}
                              placeholder="max"
                            />
                            <input
                              type="number"
                              step="any"
                              value={m.step ?? 1}
                              onChange={(event) => update(col, { step: Number(event.target.value) || 1 })}
                              className={INPUT}
                              placeholder="step"
                            />
                          </div>
                        )}
                        {(m.input_type === 'select' || m.input_type === 'enum_list') && (
                          <Lbl label={t('workboards.table.columnMeta.options')}>
                            <textarea
                              value={(m.options || [])
                                .map((o) => `${o.label}|${String(o.value)}`)
                                .join('\n')}
                              onChange={(event) =>
                                update(col, {
                                  options: event.target.value
                                    .split('\n')
                                    .map((ln) => ln.trim())
                                    .filter(Boolean)
                                    .map((ln) => {
                                      const [label, value] = ln.split('|');
                                      return { label: label.trim(), value: (value ?? label).trim() };
                                    }),
                                })
                              }
                              rows={3}
                              className={INPUT}
                              placeholder={t('workboards.table.columnMeta.optionsPlaceholder')}
                            />
                          </Lbl>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'detail_panel') {
      const panel = tableSpec.detail_panel || { enabled: true };
      const updatePanel = (patch: Partial<typeof panel>) =>
        updateTable({ detail_panel: { ...panel, ...patch } });
      const allCols = [
        ...tableSpec.columns,
        ...columnNames.filter((c) => !tableSpec.columns.includes(c)),
      ];
      const sections = panel.sections || {};
      const sectionNames = Object.keys(sections);
      return (
        <BuilderInspectorPanel
          icon={<PencilLine className="h-4 w-4" />}
          title={t('workboards.table.detail.title')}
          subtitle={t('workboards.table.detail.subtitle')}
        >
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={panel.enabled !== false}
              onChange={(event) => updatePanel({ enabled: event.target.checked })}
            />
            <span className="text-caption text-text-secondary">
              <span className="font-emphasis text-text-primary">{t('workboards.table.detail.enable')}</span>
              <span className="ml-1 text-text-tertiary">
                {t('workboards.table.detail.enableHint')}
              </span>
            </span>
          </label>
          {panel.enabled !== false && (
            <div className="mt-3 space-y-3">
              <Lbl label={t('workboards.table.detail.panelTitle')}>
                <input
                  value={panel.title || ''}
                  onChange={(event) => updatePanel({ title: event.target.value })}
                  className={INPUT}
                  placeholder={t('workboards.table.detail.panelTitlePlaceholder')}
                />
              </Lbl>
              <Lbl label={t('workboards.table.detail.columns')}>
                <MultiColumnPicker
                  sourceColumns={allCols}
                  value={panel.columns || []}
                  onChange={(value) => updatePanel({ columns: value })}
                  placeholder={t('workboards.table.detail.columnsPlaceholder')}
                />
              </Lbl>
              <Lbl label={t('workboards.table.detail.editableColumns')}>
                <MultiColumnPicker
                  sourceColumns={(panel.columns && panel.columns.length > 0 ? panel.columns : allCols).filter(
                    (c) =>
                      !computed.some((cc) => cc.name === c) &&
                      !lookups.some((ll) => ll.name === c),
                  )}
                  value={panel.editable_columns || []}
                  onChange={(value) => updatePanel({ editable_columns: value })}
                  placeholder={t('workboards.table.detail.editablePlaceholder')}
                />
              </Lbl>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-caption font-emphasis text-text-secondary">
                    {t('workboards.table.detail.sections')}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const baseName = t('workboards.table.detail.defaultSection');
                      let name = baseName;
                      let suffix = 1;
                      while (name in sections) {
                        suffix += 1;
                        name = `${baseName} ${suffix}`;
                      }
                      updatePanel({ sections: { ...sections, [name]: [] } });
                    }}
                    className="text-caption text-brand hover:underline"
                  >
                    + {t('workboards.table.detail.addSection')}
                  </button>
                </div>
                {sectionNames.length === 0 ? (
                  <BuilderEmptyHint className="text-left">
                    {t('workboards.table.detail.noSections')}
                  </BuilderEmptyHint>
                ) : (
                  <div className="space-y-2">
                    {sectionNames.map((sectionName) => (
                      <div
                        key={sectionName}
                        className="space-y-2 rounded border border-[rgb(var(--border-line))] bg-surface-1 p-2"
                      >
                        <div className="flex items-center gap-2">
                          <input
                            value={sectionName}
                            onChange={(event) => {
                              const newName = event.target.value;
                              if (!newName || newName === sectionName) return;
                              const next: Record<string, string[]> = {};
                              for (const [k, v] of Object.entries(sections)) {
                                next[k === sectionName ? newName : k] = v;
                              }
                              updatePanel({ sections: next });
                            }}
                            className={`${INPUT} flex-1`}
                          />
                          <BuilderIconButton
                            onClick={() => {
                              const next = { ...sections };
                              delete next[sectionName];
                              updatePanel({ sections: next });
                            }}
                            title={t('workboards.table.detail.removeSection')}
                            variant="danger"
                          >
                            <Trash2 className="h-3 w-3 text-danger" />
                          </BuilderIconButton>
                        </div>
                        <MultiColumnPicker
                          sourceColumns={allCols}
                          value={sections[sectionName] || []}
                          onChange={(value) => {
                            const next = { ...sections, [sectionName]: value };
                            updatePanel({ sections: next });
                          }}
                          placeholder={t('workboards.table.detail.sectionColumnsPlaceholder')}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </BuilderInspectorPanel>
      );
    }

    if (activeItem.startsWith('computed:')) {
      const col = computed[activeComputedIndex];
      if (!col) return null;
      // Surface columns with their source so the user can see "↗ from
      // <table>.<col>" on lookup entries and ƒ on computed ones.
      const jsAvailableColumns = [
        ...tableCols.map((column) => ({
          name: column.name,
          source: 'db' as const,
          label: column.type,
        })),
        ...lookups.map((l) => {
          const remoteTable = tables.find((t) => t.id === l.from_table_id);
          return {
            name: l.name,
            source: 'lookup' as const,
            origin: remoteTable
              ? `${remoteTable.display_name}.${l.return_column || '?'}`
              : 'no table',
          };
        }),
        ...computed
          .filter((c) => c.name !== col.name)
          .map((c) => ({
            name: c.name,
            source: 'computed' as const,
            label: c.label?.trim() || undefined,
          })),
      ];
      return (
        <BuilderInspectorPanel
          icon={<Calculator className="h-4 w-4" />}
          title={col.label?.trim() || col.name}
          subtitle={t('workboards.table.computed.subtitle')}
          action={
            <BuilderIconButton
              onClick={() => removeComputed(activeComputedIndex)}
              title={t('workboards.table.derived.deleteColumn')}
              variant="danger"
            >
              <Trash2 className="h-3.5 w-3.5 text-danger" />
            </BuilderIconButton>
          }
        >
          <div className="space-y-3">
            <div className={BUILDER_GRID_2}>
              <Lbl label={t('workboards.table.derived.columnName')}>
                <input
                  value={col.name}
                  onChange={(event) => {
                    const raw = event.target.value;
                    const cleaned = raw.replace(/[^A-Za-z0-9_]/g, '_');
                    updateComputed(activeComputedIndex, { name: cleaned });
                  }}
                  className={`${INPUT} font-mono`}
                />
              </Lbl>
              <Lbl label={t('workboards.table.derived.displayLabel')}>
                <input
                  value={col.label || ''}
                  onChange={(event) =>
                    updateComputed(activeComputedIndex, { label: event.target.value })
                  }
                  className={INPUT}
                  placeholder={col.name}
                />
              </Lbl>
              <Lbl label={t('workboards.table.derived.format')}>
                <select
                  value={col.format || ''}
                  onChange={(event) =>
                    updateComputed(activeComputedIndex, {
                      format: (event.target.value || null) as CellFormat | null,
                    })
                  }
                  className={INPUT}
                >
                  <option value="">{t('workboards.table.auto')}</option>
                  {CELL_FORMATS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {t(f.labelKey)}
                    </option>
                  ))}
                </select>
              </Lbl>
            </div>

            <Lbl label={t('workboards.table.computed.formula')}>
              <JsFormulaEditor
                value={col.formula}
                onChange={(formula) =>
                  updateComputed(activeComputedIndex, { formula })
                }
                availableColumns={jsAvailableColumns}
              />
            </Lbl>
            {!tableSpec.columns.includes(col.name) ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-0 px-3 py-2">
                <span className="text-caption text-text-tertiary">
                  {t('workboards.table.derived.hiddenFromTable')}
                </span>
                <button
                  type="button"
                  onClick={() => toggleColumnVisible(col.name)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-brand/30 bg-brand/10 px-2.5 text-caption font-emphasis text-brand hover:bg-brand/15"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t('workboards.table.derived.showColumn')}
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-success/20 bg-success/5 px-3 py-2">
                <span className="text-caption font-emphasis text-success">
                  {t('workboards.table.derived.visibleInTable')}
                </span>
                <button
                  type="button"
                  onClick={() => toggleColumnVisible(col.name)}
                  className="text-caption text-text-tertiary hover:text-text-primary"
                >
                  {t('workboards.table.derived.hide')}
                </button>
              </div>
            )}
          </div>
        </BuilderInspectorPanel>
      );
    }

    if (activeItem.startsWith('lookup:')) {
      const col = lookups[activeLookupIndex];
      if (!col) return null;
      const remoteTable = tables.find((t) => t.id === col.from_table_id);
      const remoteColumns = remoteTable?.columns.map((c) => c.name) ?? [];
      return (
        <BuilderInspectorPanel
          icon={<Link2 className="h-4 w-4" />}
          title={col.label?.trim() || col.name}
          subtitle={t('workboards.table.lookup.subtitle')}
          action={
            <BuilderIconButton
              onClick={() => removeLookup(activeLookupIndex)}
              title={t('workboards.table.derived.deleteColumn')}
              variant="danger"
            >
              <Trash2 className="h-3.5 w-3.5 text-danger" />
            </BuilderIconButton>
          }
        >
          <div className="space-y-3">
            <LookupModelSuggestions
              fromTableId={screen.table_id}
              onApply={(s) =>
                updateLookup(activeLookupIndex, {
                  from_table_id: s.target_table_id,
                  match_column_local: s.from_column,
                  match_column_remote: s.to_column,
                  return_column: s.label || s.to_column,
                })
              }
            />
            <div className={BUILDER_GRID_2}>
              <Lbl label={t('workboards.table.derived.columnName')}>
                <input
                  value={col.name}
                  onChange={(event) => {
                    const cleaned = event.target.value.replace(/[^A-Za-z0-9_]/g, '_');
                    updateLookup(activeLookupIndex, { name: cleaned });
                  }}
                  className={`${INPUT} font-mono`}
                />
              </Lbl>
              <Lbl label={t('workboards.table.derived.displayLabel')}>
                <input
                  value={col.label || ''}
                  onChange={(event) =>
                    updateLookup(activeLookupIndex, { label: event.target.value })
                  }
                  className={INPUT}
                  placeholder={col.name}
                />
              </Lbl>
              <Lbl label={t('workboards.table.lookup.linkedTable')}>
                <select
                  value={col.from_table_id || 0}
                  onChange={(event) =>
                    updateLookup(activeLookupIndex, {
                      from_table_id: Number(event.target.value) || 0,
                    })
                  }
                  className={INPUT}
                >
                  <option value="">{t('workboards.table.pickTable')}</option>
                  {tables.map((table) => (
                    <option key={table.id} value={table.id}>
                      {table.display_name}
                    </option>
                  ))}
                </select>
              </Lbl>
              <Lbl label={t('workboards.table.derived.format')}>
                <select
                  value={col.format || ''}
                  onChange={(event) =>
                    updateLookup(activeLookupIndex, {
                      format: (event.target.value || null) as CellFormat | null,
                    })
                  }
                  className={INPUT}
                >
                  <option value="">{t('workboards.table.auto')}</option>
                  {CELL_FORMATS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {t(f.labelKey)}
                    </option>
                  ))}
                </select>
              </Lbl>
              <Lbl label={t('workboards.table.lookup.matchThisTable')}>
                <SingleColumnPicker
                  sourceColumns={columnNames}
                  value={col.match_column_local || null}
                  onChange={(next) =>
                    updateLookup(activeLookupIndex, { match_column_local: next || '' })
                  }
                />
              </Lbl>
              <Lbl label={t('workboards.table.lookup.matchLinkedTable')}>
                <SingleColumnPicker
                  sourceColumns={remoteColumns}
                  value={col.match_column_remote || null}
                  onChange={(next) =>
                    updateLookup(activeLookupIndex, { match_column_remote: next || '' })
                  }
                />
              </Lbl>
              <Lbl label={t('workboards.table.lookup.returnColumn')}>
                <SingleColumnPicker
                  sourceColumns={remoteColumns}
                  value={col.return_column || null}
                  onChange={(next) =>
                    updateLookup(activeLookupIndex, { return_column: next || '' })
                  }
                />
              </Lbl>
            </div>
            {!tableSpec.columns.includes(col.name) ? (
              <button
                type="button"
                onClick={() => toggleColumnVisible(col.name)}
                className="text-caption text-brand hover:underline"
              >
                + {t('workboards.table.derived.showColumnInTable')}
              </button>
            ) : (
              <p className="text-caption text-text-tertiary">
                ✓ {t('workboards.table.derived.visibleInTable')}.{' '}
                <button
                  type="button"
                  onClick={() => toggleColumnVisible(col.name)}
                  className="text-brand hover:underline"
                >
                  {t('workboards.table.derived.hide')}
                </button>
              </p>
            )}
            <p className="text-caption text-text-tertiary">
              {t('workboards.table.lookup.help')}
            </p>
          </div>
        </BuilderInspectorPanel>
      );
    }

    if (activeItem.startsWith('rollup:')) {
      const col = rollups[activeRollupIndex];
      if (!col) return null;
      const remoteTable = tables.find((t) => t.id === col.from_table_id);
      const remoteColumns = remoteTable?.columns.map((c) => c.name) ?? [];
      const needsValueColumn = (col.agg || 'count') !== 'count';
      return (
        <BuilderInspectorPanel
          icon={<Sigma className="h-4 w-4" />}
          title={col.label?.trim() || col.name}
          subtitle={t('workboards.table.rollup.subtitle')}
          action={
            <BuilderIconButton
              onClick={() => removeRollup(activeRollupIndex)}
              title={t('workboards.table.derived.deleteColumn')}
              variant="danger"
            >
              <Trash2 className="h-3.5 w-3.5 text-danger" />
            </BuilderIconButton>
          }
        >
          <div className="space-y-3">
            <div className={BUILDER_GRID_2}>
              <Lbl label={t('workboards.table.derived.columnName')}>
                <input
                  value={col.name}
                  onChange={(event) => {
                    const cleaned = event.target.value.replace(/[^A-Za-z0-9_]/g, '_');
                    updateRollup(activeRollupIndex, { name: cleaned });
                  }}
                  className={`${INPUT} font-mono`}
                />
              </Lbl>
              <Lbl label={t('workboards.table.derived.displayLabel')}>
                <input
                  value={col.label || ''}
                  onChange={(event) =>
                    updateRollup(activeRollupIndex, { label: event.target.value })
                  }
                  className={INPUT}
                  placeholder={col.name}
                />
              </Lbl>
              <Lbl label={t('workboards.table.rollup.childTable')}>
                <select
                  value={col.from_table_id || 0}
                  onChange={(event) =>
                    updateRollup(activeRollupIndex, {
                      from_table_id: Number(event.target.value) || 0,
                    })
                  }
                  className={INPUT}
                >
                  <option value="">{t('workboards.table.pickTable')}</option>
                  {tables.map((table) => (
                    <option key={table.id} value={table.id}>
                      {table.display_name}
                    </option>
                  ))}
                </select>
              </Lbl>
              <Lbl label={t('workboards.table.aggregate')}>
                <select
                  value={col.agg || 'count'}
                  onChange={(event) =>
                    updateRollup(activeRollupIndex, {
                      agg: event.target.value as TableRollupAgg,
                    })
                  }
                  className={INPUT}
                >
                  <option value="count">{t('workboards.table.rollup.countChildren')}</option>
                  <option value="sum">{t('workboards.table.agg.sum')}</option>
                  <option value="avg">{t('workboards.table.agg.avg')}</option>
                  <option value="min">{t('workboards.table.agg.min')}</option>
                  <option value="max">{t('workboards.table.agg.max')}</option>
                </select>
              </Lbl>
              <Lbl label={t('workboards.table.lookup.matchThisTable')}>
                <SingleColumnPicker
                  sourceColumns={columnNames}
                  value={col.match_column_local || null}
                  onChange={(next) =>
                    updateRollup(activeRollupIndex, { match_column_local: next || '' })
                  }
                />
              </Lbl>
              <Lbl label={t('workboards.table.rollup.matchChildTable')}>
                <SingleColumnPicker
                  sourceColumns={remoteColumns}
                  value={col.match_column_remote || null}
                  onChange={(next) =>
                    updateRollup(activeRollupIndex, { match_column_remote: next || '' })
                  }
                />
              </Lbl>
              {needsValueColumn ? (
                <Lbl label={t('workboards.table.rollup.valueColumnChild')}>
                  <SingleColumnPicker
                    sourceColumns={remoteColumns}
                    value={col.value_column || null}
                    onChange={(next) =>
                      updateRollup(activeRollupIndex, { value_column: next || null })
                    }
                  />
                </Lbl>
              ) : null}
              <Lbl label={t('workboards.table.derived.format')}>
                <select
                  value={col.format || ''}
                  onChange={(event) =>
                    updateRollup(activeRollupIndex, {
                      format: (event.target.value || null) as CellFormat | null,
                    })
                  }
                  className={INPUT}
                >
                  <option value="">{t('workboards.table.auto')}</option>
                  {CELL_FORMATS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {t(f.labelKey)}
                    </option>
                  ))}
                </select>
              </Lbl>
            </div>
            {needsValueColumn && !col.value_column ? (
              <p className="text-caption text-amber-600">
                {t('workboards.table.rollup.pickNumericColumn', { agg: col.agg || 'count' })}
              </p>
            ) : null}
            <p className="text-caption text-text-tertiary">
              {t('workboards.table.rollup.help', { agg: col.agg || 'count' })}
            </p>
          </div>
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'format_rules') {
      const FMT_COLORS: Array<{ value: FormatRuleColor; labelKey: string; dot: string }> = [
        { value: 'green', labelKey: 'workboards.table.color.green', dot: 'bg-emerald-500' },
        { value: 'amber', labelKey: 'workboards.table.color.amber', dot: 'bg-amber-500' },
        { value: 'red', labelKey: 'workboards.table.color.red', dot: 'bg-rose-500' },
        { value: 'blue', labelKey: 'workboards.table.color.blue', dot: 'bg-sky-500' },
        { value: 'violet', labelKey: 'workboards.table.color.violet', dot: 'bg-violet-500' },
        { value: 'slate', labelKey: 'workboards.table.color.slate', dot: 'bg-slate-400' },
      ];
      return (
        <BuilderInspectorPanel
          icon={<Palette className="h-4 w-4" />}
          title={t('workboards.table.formatRules.title')}
          subtitle={t('workboards.table.formatRules.subtitle')}
          action={
            <BuilderIconButton onClick={addFormatRule} title={t('workboards.table.formatRules.addRule')}>
              <Plus className="h-3.5 w-3.5" />
            </BuilderIconButton>
          }
        >
          {formatRules.length === 0 ? (
            <BuilderEmptyHint>
              {t('workboards.table.formatRules.emptyPrefix')}{' '}
              <code>{'{{row.san_luong}} < 100'}</code>{' '}
              {t('workboards.table.formatRules.emptySuffix')}
            </BuilderEmptyHint>
          ) : (
            <div className="space-y-4">
              {formatRules.map((rule, idx) => (
                <div
                  key={idx}
                  className="space-y-3 rounded-lg border border-border-subtle p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-caption font-medium text-text-secondary">
                      {t('workboards.table.formatRules.ruleNumber', { number: idx + 1 })}
                    </span>
                    <BuilderIconButton
                      onClick={() => removeFormatRule(idx)}
                      title={t('workboards.table.formatRules.deleteRule')}
                      variant="danger"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-danger" />
                    </BuilderIconButton>
                  </div>
                  <Lbl label={t('workboards.table.formatRules.expression')}>
                    <input
                      value={rule.when}
                      onChange={(event) =>
                        updateFormatRule(idx, { when: event.target.value })
                      }
                      className={`${INPUT} font-mono`}
                      placeholder="{{row.san_luong}} < 100"
                    />
                  </Lbl>
                  <div className={BUILDER_GRID_2}>
                    <Lbl label={t('workboards.table.formatRules.color')}>
                      <select
                        value={rule.color || 'amber'}
                        onChange={(event) =>
                          updateFormatRule(idx, {
                            color: event.target.value as FormatRuleColor,
                          })
                        }
                        className={INPUT}
                      >
                        {FMT_COLORS.map((c) => (
                          <option key={c.value} value={c.value}>
                            {t(c.labelKey)}
                          </option>
                        ))}
                      </select>
                    </Lbl>
                    <Lbl label={t('workboards.table.formatRules.iconOptional')}>
                      <input
                        value={rule.icon || ''}
                        onChange={(event) =>
                          updateFormatRule(idx, { icon: event.target.value || null })
                        }
                        className={INPUT}
                        placeholder="⚠️"
                      />
                    </Lbl>
                  </div>
                  <Lbl label={t('workboards.table.formatRules.applyColumns')}>
                    <MultiColumnPicker
                      sourceColumns={allReferenceableColumns}
                      value={rule.columns || []}
                      onChange={(next) => updateFormatRule(idx, { columns: next })}
                    />
                  </Lbl>
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 text-caption text-text-tertiary">
            {t('workboards.table.formatRules.helpPrefix')}{' '}
            <code>{'{{row.cot}}'}</code>
            {t('workboards.table.formatRules.helpSuffix')}
          </p>
        </BuilderInspectorPanel>
      );
    }

    return null;
  };

  return (
    <div className="space-y-4">
      <DataSourcePicker
        tableId={screen.table_id}
        tables={tables}
        onChange={(nextId) => onChange({ ...screen, table_id: nextId })}
      />

      {tableMissing ? (
        <BuilderTableMissingBanner tableId={screen.table_id} />
      ) : !screen.table_id ? (
        <BuilderEmptyHint className="text-left">
          {t('workboards.table.pickDataSourceFirst')}
        </BuilderEmptyHint>
      ) : null}

      <BuilderObjectEditor>
        <BuilderNavigator
          title={t('workboards.table.navigator.title')}
          description={t('workboards.table.navigator.description')}
        >
          <BuilderNavigatorGroup title={t('workboards.table.navigator.structure')}>
            <BuilderNavigatorItem
              icon={<LayoutGrid className="h-3.5 w-3.5" />}
              label={t('workboards.table.displayModeTitle')}
              subtitle={displayModeLabel(tableSpec.display_mode || 'table', t)}
              active={activeItem === 'display'}
              onClick={() => setActiveItem('display')}
            />
          </BuilderNavigatorGroup>

          <BuilderNavigatorGroup title={t('workboards.table.navigator.content')}>
            <BuilderNavigatorItem
              icon={<Columns3 className="h-3.5 w-3.5" />}
              label={t('workboards.table.shortcut.fields')}
              subtitle={t('workboards.table.selectedCount', { count: tableSpec.columns.length })}
              active={activeItem === 'columns'}
              onClick={() => setActiveItem('columns')}
            />
            <BuilderNavigatorItem
              icon={<Filter className="h-3.5 w-3.5" />}
              label={t('workboards.table.filtersSortingTitle')}
              subtitle={t('workboards.table.filtersPageSubtitle', {
                count: filters.length,
                pageSize: tableSpec.page_size ?? 100,
              })}
              active={activeItem === 'settings'}
              onClick={() => setActiveItem('settings')}
            />
          </BuilderNavigatorGroup>

          <BuilderNavigatorGroup title={t('workboards.table.navigator.interaction')}>
            <BuilderNavigatorItem
              icon={<PencilLine className="h-3.5 w-3.5" />}
              label={t('workboards.table.shortcut.editableFields')}
              subtitle={t('workboards.table.editableOfTotal', {
                editable: (tableSpec.editable_columns || []).length,
                total: tableSpec.columns.length,
              })}
              active={activeItem === 'editable'}
              onClick={() => setActiveItem('editable')}
            />
            <BuilderNavigatorItem
              icon={<Settings2 className="h-3.5 w-3.5" />}
              label={t('workboards.table.rowBehaviourTitle')}
              subtitle={t('workboards.table.rowBehaviourState', {
                add: tableSpec.allow_add_row !== false ? t('workboards.table.on') : t('workboards.table.off'),
                delete: tableSpec.allow_delete_row !== false ? t('workboards.table.on') : t('workboards.table.off'),
              })}
              active={activeItem === 'behaviour'}
              onClick={() => setActiveItem('behaviour')}
            />
            <BuilderNavigatorItem
              icon={<Plus className="h-3.5 w-3.5" />}
              label={t('workboards.table.newRowDefaultsTitle')}
              subtitle={t('workboards.table.requiredPresetSubtitle', {
                required: (tableSpec.required_columns || []).length,
                presets: Object.keys(tableSpec.default_values || {}).length,
              })}
              active={activeItem === 'defaults'}
              onClick={() => setActiveItem('defaults')}
            />
            <BuilderNavigatorItem
              icon={<PencilLine className="h-3.5 w-3.5" />}
              label={t('workboards.table.detailPanelTitle')}
              subtitle={
                tableSpec.detail_panel?.enabled === false
                  ? t('workboards.table.disabled')
                  : (tableSpec.detail_panel?.editable_columns || []).length > 0
                    ? t('workboards.table.editableCount', { count: (tableSpec.detail_panel?.editable_columns || []).length })
                    : t('workboards.table.readOnly')
              }
              active={activeItem === 'detail_panel'}
              onClick={() => setActiveItem('detail_panel')}
            />
            <BuilderNavigatorItem
              icon={<ChevronRight className="h-3.5 w-3.5" />}
              label={t('workboards.table.rowActionsTitle')}
              subtitle={
                rowActions.length === 0
                  ? t('workboards.table.noActions')
                  : t('workboards.table.actionsCount', { count: rowActions.length })
              }
              active={activeItem === 'row_actions'}
              onClick={() => setActiveItem('row_actions')}
            />
            <BuilderNavigatorItem
              icon={<ChevronRight className="h-3.5 w-3.5" />}
              label={t('workboards.table.bulkActionsTitle')}
              subtitle={bulkActions.length === 0 ? t('workboards.table.noneYet') : t('workboards.table.actionsCount', { count: bulkActions.length })}
              active={activeItem === 'bulk_actions'}
              onClick={() => setActiveItem('bulk_actions')}
            />
          </BuilderNavigatorGroup>

          <BuilderNavigatorGroup title={t('workboards.table.navigator.presentation')}>
            {isTableMode && (
              <>
            <BuilderNavigatorItem
              icon={<Settings2 className="h-3.5 w-3.5" />}
              label={t('workboards.table.shortcut.columnPresentation')}
              subtitle={
                Object.keys(tableSpec.column_metadata || {}).length === 0
                  ? t('workboards.table.defaultLabels')
                  : t('workboards.table.customCount', { count: Object.keys(tableSpec.column_metadata || {}).length })
              }
              active={activeItem === 'column_meta'}
              onClick={() => setActiveItem('column_meta')}
            />
            <BuilderNavigatorItem
              icon={<Columns3 className="h-3.5 w-3.5" />}
              label={t('workboards.table.shortcut.headerGroups')}
              subtitle={
                (tableSpec.column_groups || []).length === 0
                  ? t('workboards.table.noGroups')
                  : t('workboards.table.groupsCount', { count: (tableSpec.column_groups || []).length })
              }
              active={activeItem === 'column_groups'}
              onClick={() => setActiveItem('column_groups')}
            />
            <BuilderNavigatorItem
              icon={<Rows3 className="h-3.5 w-3.5" />}
              label={t('workboards.table.shortcut.rowMerge')}
              subtitle={
                (tableSpec.group_by || []).length === 0
                  ? t('workboards.table.noMerging')
                  : t('workboards.table.mergeBy', { columns: (tableSpec.group_by || []).join(', ') })
              }
              active={activeItem === 'row_merge'}
              onClick={() => setActiveItem('row_merge')}
            />
            <BuilderNavigatorItem
              icon={<Palette className="h-3.5 w-3.5" />}
              label={t('workboards.table.shortcut.conditionalFormatting')}
              subtitle={
                formatRules.length === 0
                  ? t('workboards.table.noRules')
                  : t('workboards.table.rulesCount', { count: formatRules.length })
              }
              active={activeItem === 'format_rules'}
              onClick={() => setActiveItem('format_rules')}
            />
              </>
            )}
            <BuilderNavigatorItem
              icon={<ListFilter className="h-3.5 w-3.5" />}
              label={t('workboards.table.emptyStateTitle')}
              subtitle={tableSpec.empty_state_message ? t('workboards.table.customMessage') : t('workboards.table.defaultMessage')}
              active={activeItem === 'empty'}
              onClick={() => setActiveItem('empty')}
            />
          </BuilderNavigatorGroup>

          <BuilderNavigatorGroup title={t('workboards.table.navigator.summary')}>
            {isTableMode && (
            <BuilderNavigatorItem
              icon={<Sigma className="h-3.5 w-3.5" />}
              label={t('workboards.table.shortcut.footerTotals')}
              subtitle={
                Object.keys(totals).length === 0
                  ? t('workboards.table.noTotals')
                  : t('workboards.table.columnsCount', { count: Object.keys(totals).length })
              }
              active={activeItem === 'totals'}
              onClick={() => setActiveItem('totals')}
            />
            )}
            <BuilderNavigatorItem
              icon={<LayoutGrid className="h-3.5 w-3.5" />}
              label={t('workboards.table.kpiTilesTitle')}
              subtitle={
                (tableSpec.stat_tiles || []).length === 0
                  ? t('workboards.table.noTiles')
                  : t('workboards.table.tilesCount', { count: (tableSpec.stat_tiles || []).length })
              }
              active={activeItem === 'kpi'}
              onClick={() => setActiveItem('kpi')}
            />
          </BuilderNavigatorGroup>

          {isTableMode && (
            <BuilderNavigatorGroup title={t('workboards.table.navigator.specialized')}>
              <BuilderNavigatorItem
                icon={<ScanLine className="h-3.5 w-3.5" />}
                label={t('workboards.table.posCartTitle')}
                subtitle={tableSpec.pos_cart ? t('workboards.table.on') : t('workboards.table.off')}
                active={activeItem === 'pos_cart'}
                onClick={() => setActiveItem('pos_cart')}
              />
            </BuilderNavigatorGroup>
          )}

          <section>
            <h3 className="mb-1.5 text-tiny font-emphasis uppercase tracking-wider text-text-quaternary">
              {t('workboards.table.navigator.derivedData')}
            </h3>
            <div className="space-y-3">
              <DerivedSubGroup
                label={t('workboards.table.derived.computed')}
                count={computed.length}
                onAdd={addComputed}
                addTitle={t('workboards.table.derived.addComputed')}
                addDisabled={columnNames.length === 0}
              >
                {computed.length === 0 ? (
                  <BuilderEmptyHint className="px-3 py-3">
                    {t('workboards.table.derived.noFormulaColumns')}
                  </BuilderEmptyHint>
                ) : (
                  computed.map((col, index) => (
                    <BuilderNavigatorItem
                      key={`${col.name}:${index}`}
                      icon={<Calculator className="h-3.5 w-3.5" />}
                      label={col.label?.trim() || col.name}
                      subtitle={col.formula.trim() ? col.formula.slice(0, 40) : t('workboards.table.derived.noFormulaYet')}
                      active={activeItem === `computed:${index}`}
                      onClick={() => setActiveItem(`computed:${index}`)}
                      action={
                        <BuilderIconButton
                          onClick={() => removeComputed(index)}
                          title={t('workboards.table.derived.deleteColumn')}
                          variant="danger"
                        >
                          <Trash2 className="h-3 w-3 text-danger" />
                        </BuilderIconButton>
                      }
                    />
                  ))
                )}
              </DerivedSubGroup>

              <DerivedSubGroup
                label={t('workboards.table.derived.lookup')}
                count={lookups.length}
                onAdd={addLookup}
                addTitle={t('workboards.table.derived.addLookup')}
                addDisabled={tables.length === 0}
              >
                {lookups.length === 0 ? (
                  <BuilderEmptyHint className="px-3 py-3">
                    {t('workboards.table.derived.noLookupColumns')}
                  </BuilderEmptyHint>
                ) : (
                  lookups.map((col, index) => {
                    const remoteTable = tables.find((t) => t.id === col.from_table_id);
                    return (
                      <BuilderNavigatorItem
                        key={`${col.name}:${index}`}
                        icon={<Link2 className="h-3.5 w-3.5" />}
                        label={col.label?.trim() || col.name}
                        subtitle={
                          remoteTable
                            ? `${remoteTable.display_name}.${col.return_column || '?'}`
                            : t('workboards.table.derived.noTableSelected')
                        }
                        active={activeItem === `lookup:${index}`}
                        onClick={() => setActiveItem(`lookup:${index}`)}
                        action={
                          <BuilderIconButton
                            onClick={() => removeLookup(index)}
                            title={t('workboards.table.derived.deleteColumn')}
                            variant="danger"
                          >
                            <Trash2 className="h-3 w-3 text-danger" />
                          </BuilderIconButton>
                        }
                      />
                    );
                  })
                )}
              </DerivedSubGroup>

              <DerivedSubGroup
                label={t('workboards.table.derived.rollup')}
                count={rollups.length}
                onAdd={addRollup}
                addTitle={t('workboards.table.derived.addRollup')}
                addDisabled={tables.length === 0}
              >
                {rollups.length === 0 ? (
                  <BuilderEmptyHint className="px-3 py-3">
                    {t('workboards.table.derived.noRollupColumns')}
                  </BuilderEmptyHint>
                ) : (
                  rollups.map((col, index) => {
                    const remoteTable = tables.find((t) => t.id === col.from_table_id);
                    return (
                      <BuilderNavigatorItem
                        key={`${col.name}:${index}`}
                        icon={<Sigma className="h-3.5 w-3.5" />}
                        label={col.label?.trim() || col.name}
                        subtitle={
                          remoteTable
                            ? `${col.agg || 'count'}(${remoteTable.display_name})`
                            : t('workboards.table.derived.noTableSelected')
                        }
                        active={activeItem === `rollup:${index}`}
                        onClick={() => setActiveItem(`rollup:${index}`)}
                        action={
                          <BuilderIconButton
                            onClick={() => removeRollup(index)}
                            title={t('workboards.table.derived.deleteColumn')}
                            variant="danger"
                          >
                            <Trash2 className="h-3 w-3 text-danger" />
                          </BuilderIconButton>
                        }
                      />
                    );
                  })
                )}
              </DerivedSubGroup>
            </div>
          </section>
        </BuilderNavigator>

        {renderInspector()}
      </BuilderObjectEditor>
    </div>
  );
}

function DefaultValuesEditor({
  defaults,
  columns,
  onChange,
}: {
  defaults: Record<string, unknown>;
  columns: string[];
  onChange: (next: Record<string, unknown>) => void;
}) {
  const { t } = useI18n();
  const entries = Object.entries(defaults);
  const available = columns.filter((c) => !(c in defaults));
  const [picked, setPicked] = useState<string>(available[0] || '');

  useEffect(() => {
    if (!picked && available.length > 0) setPicked(available[0]);
    if (picked && !available.includes(picked)) setPicked(available[0] || '');
  }, [picked, available]);

  const setValue = (col: string, val: string) => {
    onChange({ ...defaults, [col]: val });
  };

  const removeValue = (col: string) => {
    const next = { ...defaults };
    delete next[col];
    onChange(next);
  };

  const addValue = () => {
    if (!picked) return;
    onChange({ ...defaults, [picked]: '' });
  };

  return (
    <div className="space-y-2">
      <div className="text-caption font-emphasis text-text-secondary">
        {t('workboards.table.defaults.title')}
      </div>
      <p className="text-caption text-text-tertiary">
        {t('workboards.table.defaults.help')}{' '}
        <code className="rounded bg-surface-2 px-1">{'{{app_user.username}}'}</code>,{' '}
        <code className="rounded bg-surface-2 px-1">{'{{today}}'}</code>,{' '}
        <code className="rounded bg-surface-2 px-1">{'{{now}}'}</code>.
      </p>
      {entries.length === 0 ? (
        <BuilderEmptyHint className="text-left">{t('workboards.table.defaults.empty')}</BuilderEmptyHint>
      ) : (
        <div className="space-y-1.5">
          {entries.map(([col, val]) => (
            <div key={col} className="flex items-center gap-2">
              <span className="w-40 truncate rounded bg-surface-2 px-2 py-1 text-caption text-text-secondary">
                {col}
              </span>
              <input
                value={typeof val === 'string' ? val : String(val ?? '')}
                onChange={(event) => setValue(col, event.target.value)}
                className={`${INPUT} flex-1`}
                placeholder={t('workboards.table.defaults.valuePlaceholder')}
              />
              <BuilderIconButton
                onClick={() => removeValue(col)}
                title={t('workboards.table.defaults.removeDefault')}
                variant="danger"
              >
                <Trash2 className="h-3 w-3 text-danger" />
              </BuilderIconButton>
            </div>
          ))}
        </div>
      )}
      {available.length > 0 ? (
        <div className="flex items-center gap-2 pt-1">
          <select
            value={picked}
            onChange={(event) => setPicked(event.target.value)}
            className={INPUT}
          >
            {available.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={addValue}
            disabled={!picked}
            className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-1 text-caption hover:bg-surface-2 disabled:opacity-50"
          >
            {t('workboards.table.defaults.addDefault')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
