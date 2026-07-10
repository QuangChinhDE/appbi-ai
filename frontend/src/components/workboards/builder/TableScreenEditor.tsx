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
  Columns3,
  Filter,
  LayoutGrid,
  Link2,
  ListFilter,
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
} from './types';
import { INPUT, Lbl } from './ScreenEditor';

interface DatasetTableInfo {
  id: number;
  display_name: string;
  source_table_name: string;
  columns: { name: string; type?: string }[];
}

interface Props {
  screen: ScreenSpec;
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
  | `filter:${number}`
  | `computed:${number}`
  | `lookup:${number}`
  | `rollup:${number}`;

const EMPTY_TABLE: TableSpec = {
  columns: [],
  editable_columns: [],
  filters: [],
  page_size: 100,
  allow_add_row: true,
  allow_delete_row: true,
  required_columns: [],
  default_values: {},
  computed_columns: [],
  lookup_columns: [],
  totals: {},
};

const CELL_FORMATS: Array<{ value: CellFormat; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'integer', label: 'Integer' },
  { value: 'currency', label: 'Currency' },
  { value: 'percent', label: 'Percent' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date + time' },
];

const TOTALS_KINDS: Array<{ value: TableTotalsKind; label: string }> = [
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
  { value: 'count', label: 'Count (non-empty)' },
];

const FILTER_KIND_LABEL: Record<TableFilterSpec['kind'], string> = {
  text: 'Text search',
  select: 'Single select',
  date_range: 'Date range',
  number_range: 'Number range',
};

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
    return <p className="text-caption text-text-tertiary">Đang tải gợi ý quan hệ từ Model…</p>;
  }
  return (
    <div className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-caption font-emphasis text-text-secondary">Gợi ý từ Model</span>
        {!deep && (
          <button
            type="button"
            onClick={() => setDeep(true)}
            className="text-caption text-brand hover:underline"
            title="Quét trùng dữ liệu để tìm cả quan hệ khác tên cột (vd status↔status_code)"
          >
            Tìm thêm (quét dữ liệu)
          </button>
        )}
      </div>
      {!items.length ? (
        <p className="text-caption text-text-tertiary">
          {deep
            ? 'Không tìm thấy quan hệ nào (kể cả quét dữ liệu). Hãy cấu hình thủ công bên dưới.'
            : 'Chưa có quan hệ trong Model. Bấm “Tìm thêm (quét dữ liệu)” hoặc cấu hình thủ công.'}
        </p>
      ) : (
      <div className="space-y-1.5">
        {items.map((s, i) => {
          const disp = String(s.target_table_display || 'Bảng liên quan');
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
              <span className="font-emphasis text-text-primary">Dùng {disp}</span>
              <span className="block text-text-tertiary">
                Khớp: <code className="font-mono">{fromCol} = {toCol}</code>
                {labelCol ? (
                  <>
                    {' '}· Lấy: <code className="font-mono">{labelCol}</code>
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

export default function TableScreenEditor({ screen, tables, onChange }: Props) {
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
  const totals = tableSpec.totals || {};
  const boundTable = tables.find((table) => table.id === screen.table_id);
  const tableCols = boundTable?.columns ?? [];
  const columnNames = tableCols.map((column) => column.name);
  const tableMissing = !!screen.table_id && !boundTable;
  const [activeItem, setActiveItem] = useState<ActiveItem>('columns');

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

  const activeFilterIndex = activeItem.startsWith('filter:')
    ? Number(activeItem.slice('filter:'.length))
    : -1;
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
    if (activeItem.startsWith('filter:') && activeFilterIndex >= filters.length) {
      setActiveItem(filters.length > 0 ? `filter:${filters.length - 1}` : 'columns');
    }
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
    activeFilterIndex,
    activeItem,
    activeLookupIndex,
    activeRollupIndex,
    computed.length,
    filters.length,
    lookups.length,
    rollups.length,
  ]);

  const updateTable = (patch: Partial<TableSpec>) =>
    onChange({ ...screen, table: { ...tableSpec, ...patch } });

  const addFilter = () => {
    if (columnNames.length === 0) return;
    const next: TableFilterSpec[] = [
      ...filters,
      { column: columnNames[0], kind: 'text', label: '' },
    ];
    updateTable({ filters: next });
    setActiveItem(`filter:${next.length - 1}`);
  };

  const updateFilter = (idx: number, patch: Partial<TableFilterSpec>) => {
    const next = [...filters];
    next[idx] = { ...next[idx], ...patch };
    updateTable({ filters: next });
  };

  const removeFilter = (idx: number) => {
    const next = filters.filter((_, index) => index !== idx);
    updateTable({ filters: next });
    if (activeFilterIndex === idx) {
      setActiveItem(
        next.length > 0
          ? `filter:${Math.max(0, Math.min(idx, next.length - 1))}`
          : 'columns',
      );
    } else if (activeFilterIndex > idx) {
      setActiveItem(`filter:${activeFilterIndex - 1}`);
    }
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

  const toggleColumnVisible = (column: string) => {
    if (tableSpec.columns.includes(column)) {
      updateTable({ columns: tableSpec.columns.filter((c) => c !== column) });
    } else {
      updateTable({ columns: [...tableSpec.columns, column] });
    }
  };

  const renderInspector = () => {
    if (activeItem === 'columns') {
      // Pickable column set = regular DB columns + every computed/lookup
      // column the builder has declared, so the user can drag a derived
      // column into the visible list without leaving this inspector.
      const pickable = [
        ...columnNames,
        ...computed.map((c) => c.name),
        ...lookups.map((l) => l.name),
      ];
      return (
        <BuilderInspectorPanel
          icon={<Columns3 className="h-4 w-4" />}
          title="Visible columns"
          subtitle="Pick which columns the table shows. Order controls table order."
        >
          {pickable.length === 0 ? (
            <BuilderEmptyHint className="text-left">
              No data source selected, or the table has no columns.
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
                placeholder="Click to pick columns to display..."
              />
              {(computed.length > 0 || lookups.length > 0) && (
                <p className="mt-2 text-caption text-text-tertiary">
                  Computed and lookup columns appear in this picker too — they
                  render read-only at runtime regardless of the editable list.
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
          title="Editable columns"
          subtitle="Cells in unchecked columns are read-only at runtime."
        >
          {editableCandidates.length === 0 ? (
            <BuilderEmptyHint className="text-left">
              No editable candidates yet. Pick visible columns first (computed
              and lookup columns are always read-only).
            </BuilderEmptyHint>
          ) : (
            <MultiColumnPicker
              sourceColumns={editableCandidates}
              value={(tableSpec.editable_columns || []).filter((c) => !derived.has(c))}
              onChange={(editable_columns) => updateTable({ editable_columns })}
              placeholder="No editable columns - table is read-only."
            />
          )}
          <p className="mt-2 text-caption text-text-tertiary">
            Role-level write permissions (Permissions tab) still apply on top of
            this list.
          </p>
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'behaviour') {
      return (
        <BuilderInspectorPanel
          icon={<Settings2 className="h-4 w-4" />}
          title="Row behaviour"
          subtitle="Show or hide the add row and delete buttons."
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
                  Allow adding rows
                </span>
                <span className="ml-1 text-text-tertiary">
                  - shows an &quot;Add row&quot; button at the bottom of the table.
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
                  Allow deleting rows
                </span>
                <span className="ml-1 text-text-tertiary">
                  - shows a trash icon at the end of each row.
                </span>
              </span>
            </label>
          </div>
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'settings') {
      return (
        <BuilderInspectorPanel
          icon={<Rows3 className="h-4 w-4" />}
          title="Paging and sorting"
          subtitle="Default row count and row ordering for this table."
        >
          <div className={BUILDER_GRID_2}>
            <Lbl label="Rows per page">
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
            <Lbl label="Default sort column">
              <SingleColumnPicker
                sourceColumns={columnNames}
                value={tableSpec.default_sort_column || null}
                onChange={(next) => updateTable({ default_sort_column: next || null })}
                placeholder="No default sort"
              />
            </Lbl>
            <Lbl label="Default sort direction">
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
                <option value="desc">Descending</option>
                <option value="asc">Ascending</option>
              </select>
            </Lbl>
          </div>
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'defaults') {
      return (
        <BuilderInspectorPanel
          icon={<Plus className="h-4 w-4" />}
          title="New row defaults"
          subtitle="Required columns and pre-filled values when a row is added."
        >
          <div className="space-y-4">
            <Lbl label="Required columns">
              {tableSpec.columns.length === 0 ? (
                <BuilderEmptyHint className="text-left">
                  Pick visible columns first.
                </BuilderEmptyHint>
              ) : (
                <MultiColumnPicker
                  sourceColumns={tableSpec.columns}
                  value={tableSpec.required_columns || []}
                  onChange={(required_columns) => updateTable({ required_columns })}
                  placeholder="No required columns."
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
          title="Empty state"
          subtitle="Message shown when no rows match the filters."
        >
          <Lbl label="Empty state message">
            <input
              value={tableSpec.empty_state_message || ''}
              onChange={(event) =>
                updateTable({ empty_state_message: event.target.value })
              }
              className={INPUT}
              placeholder="e.g. No matching rows. Tap + to add one."
            />
          </Lbl>
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
          {allowBlank && <option value="">— chọn cột —</option>}
          {cols.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          {value && !cols.includes(value) && <option value={value}>{value} (tự nhập)</option>}
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
          title="Chế độ POS — quét → giỏ → 1 lần lưu"
          subtitle="Quét mã (camera) dồn vào 1 danh sách như máy tính tiền siêu thị; bấm Lưu mới ghi tất cả xuống dữ liệu 1 lần rồi mở phiếu để in."
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
                          submit_label: 'Lưu & In phiếu',
                          allow_manual_search: true,
                        }
                      : null,
                  })
                }
                className="mt-0.5"
              />
              <span className="text-caption text-text-secondary">
                <span className="font-emphasis text-text-primary">Bật chế độ POS quét</span>
                <span className="ml-1 text-text-tertiary">
                  — thay lưới bảng bằng giao diện quét mã + giỏ hàng.
                </span>
              </span>
            </label>

            {pos && (
              <>
                <Lbl label="Bảng danh mục sản phẩm (catalog)">
                  <select
                    value={pos.catalog_table_id || 0}
                    onChange={(e) => setPos({ catalog_table_id: Number(e.target.value) })}
                    className={INPUT}
                  >
                    <option value={0}>— chọn bảng —</option>
                    {tables.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.display_name}
                      </option>
                    ))}
                  </select>
                </Lbl>
                <div className={BUILDER_GRID_2}>
                  <Lbl label="Cột mã khớp (trong catalog)">
                    <ColSel value={pos.catalog_match_column} cols={catCols} onPick={(v) => setPos({ catalog_match_column: v })} />
                  </Lbl>
                  <Lbl label="Cột tên hàng (catalog)">
                    <ColSel value={pos.catalog_label_column} cols={catCols} onPick={(v) => setPos({ catalog_label_column: v })} />
                  </Lbl>
                  <Lbl label="Cột đơn giá (catalog)">
                    <ColSel value={pos.catalog_price_column} cols={catCols} onPick={(v) => setPos({ catalog_price_column: v })} />
                  </Lbl>
                  <Lbl label="Cột mã trên dòng (ghi xuống)">
                    <ColSel value={pos.barcode_column} cols={ownCols} onPick={(v) => setPos({ barcode_column: v })} />
                  </Lbl>
                  <Lbl label="Cột số lượng (dòng)">
                    <ColSel value={pos.quantity_column} cols={ownCols} onPick={(v) => setPos({ quantity_column: v })} />
                  </Lbl>
                  <Lbl label="Cột thành tiền (dòng)">
                    <ColSel value={pos.amount_column} cols={ownCols} onPick={(v) => setPos({ amount_column: v })} />
                  </Lbl>
                  <Lbl label="Cột số phiếu (sinh tự động)">
                    <ColSel value={pos.order_id_column} cols={ownCols} onPick={(v) => setPos({ order_id_column: v })} />
                  </Lbl>
                  <Lbl label="Tiền tố số phiếu">
                    <input value={pos.order_id_prefix || ''} onChange={(e) => setPos({ order_id_prefix: e.target.value })} className={INPUT} placeholder="PN" />
                  </Lbl>
                  <Lbl label="Cột ngày (dòng)">
                    <ColSel value={pos.date_column} cols={ownCols} onPick={(v) => setPos({ date_column: v })} />
                  </Lbl>
                </div>

                <div className="rounded-md border border-border-subtle p-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-caption font-emphasis text-text-primary">Cột catalog → cột dòng</span>
                    <BuilderIconButton title="Thêm" onClick={() => setCopy([...(copyPairs as [string, string][]), ['', '']])}>
                      <Plus className="h-3.5 w-3.5" />
                    </BuilderIconButton>
                  </div>
                  {copyPairs.length === 0 && (
                    <p className="text-tiny text-text-tertiary">Sao chép tên hàng/ĐVT/đơn giá từ catalog xuống mỗi dòng.</p>
                  )}
                  {copyPairs.map(([lineCol, catCol], i) => (
                    <div key={i} className="mb-1 flex items-center gap-1">
                      <ColSel value={lineCol} cols={ownCols} onPick={(v) => { const p = [...copyPairs] as [string, string][]; p[i] = [v, catCol]; setCopy(p); }} />
                      <span className="text-text-tertiary">←</span>
                      <ColSel value={catCol} cols={catCols} onPick={(v) => { const p = [...copyPairs] as [string, string][]; p[i] = [lineCol, v]; setCopy(p); }} />
                      <BuilderIconButton title="Xoá" variant="danger" onClick={() => setCopy((copyPairs as [string, string][]).filter((_, idx) => idx !== i))}>
                        <Trash2 className="h-3.5 w-3.5 text-danger" />
                      </BuilderIconButton>
                    </div>
                  ))}
                </div>

                <div className="rounded-md border border-border-subtle p-2">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-caption font-emphasis text-text-primary">Trường đầu phiếu (nhập 1 lần)</span>
                    <BuilderIconButton title="Thêm" onClick={() => setHdr([...hdr, { column: '', label: '', kind: 'text', options: [], required: false, write_to_line: true }])}>
                      <Plus className="h-3.5 w-3.5" />
                    </BuilderIconButton>
                  </div>
                  {hdr.map((h, i) => (
                    <div key={i} className="mb-2 space-y-1 rounded border border-border-subtle p-1.5">
                      <div className={BUILDER_GRID_2}>
                        <ColSel value={h.column} cols={ownCols} onPick={(v) => setHdr(hdr.map((x, idx) => (idx === i ? { ...x, column: v } : x)))} />
                        <input value={h.label} onChange={(e) => setHdr(hdr.map((x, idx) => (idx === i ? { ...x, label: e.target.value } : x)))} className={INPUT} placeholder="Nhãn (vd: Loại phiếu)" />
                        <select value={h.kind || 'text'} onChange={(e) => setHdr(hdr.map((x, idx) => (idx === i ? { ...x, kind: e.target.value as 'text' | 'select' | 'date' } : x)))} className={INPUT}>
                          <option value="text">Văn bản</option>
                          <option value="select">Chọn</option>
                          <option value="date">Ngày</option>
                        </select>
                        <input value={(h.options || []).join(', ')} onChange={(e) => setHdr(hdr.map((x, idx) => (idx === i ? { ...x, options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } : x)))} className={INPUT} placeholder="Lựa chọn: A, B, C" />
                      </div>
                      <div className="flex items-center gap-3 text-tiny">
                        <label className="flex items-center gap-1"><input type="checkbox" checked={!!h.required} onChange={(e) => setHdr(hdr.map((x, idx) => (idx === i ? { ...x, required: e.target.checked } : x)))} /> Bắt buộc</label>
                        <label className="flex items-center gap-1"><input type="checkbox" checked={h.write_to_line !== false} onChange={(e) => setHdr(hdr.map((x, idx) => (idx === i ? { ...x, write_to_line: e.target.checked } : x)))} /> Ghi vào dòng</label>
                        <BuilderIconButton title="Xoá" variant="danger" onClick={() => setHdr(hdr.filter((_, idx) => idx !== i))}>
                          <Trash2 className="h-3.5 w-3.5 text-danger" />
                        </BuilderIconButton>
                      </div>
                    </div>
                  ))}
                </div>

                <div className={BUILDER_GRID_2}>
                  <Lbl label="Nút Lưu (nhãn)">
                    <input value={pos.submit_label || ''} onChange={(e) => setPos({ submit_label: e.target.value })} className={INPUT} placeholder="Lưu & In phiếu" />
                  </Lbl>
                  <Lbl label="Mở màn sau khi lưu (id)">
                    <input value={pos.after_submit_screen || ''} onChange={(e) => setPos({ after_submit_screen: e.target.value })} className={INPUT} placeholder="vd: phieu_nhap" />
                  </Lbl>
                  <Lbl label="Màn ghi header phiếu (id)">
                    <input value={pos.header_screen_id || ''} onChange={(e) => setPos({ header_screen_id: e.target.value })} className={INPUT} placeholder="vd: don_header (ghi 1 dòng vào bảng phiếu)" />
                  </Lbl>
                  <Lbl label="Mang theo cột (dấu phẩy)">
                    <input value={(pos.after_submit_carry || []).join(', ')} onChange={(e) => setPos({ after_submit_carry: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} className={INPUT} placeholder="ma_don, loai, ma_kho" />
                  </Lbl>
                  <Lbl label="Gợi ý khi giỏ trống">
                    <input value={pos.empty_hint || ''} onChange={(e) => setPos({ empty_hint: e.target.value })} className={INPUT} />
                  </Lbl>
                </div>
                <label className="flex items-center gap-2 text-caption text-text-secondary">
                  <input type="checkbox" checked={pos.allow_manual_search !== false} onChange={(e) => setPos({ allow_manual_search: e.target.checked })} />
                  Cho tìm sản phẩm bằng ô tìm kiếm (ngoài quét mã)
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
      const visibleCols = tableSpec.columns || [];
      return (
        <BuilderInspectorPanel
          icon={<LayoutGrid className="h-4 w-4" />}
          title="Chế độ hiển thị"
          subtitle="Bảng / lưới thẻ ảnh (Gallery) / lịch (Calendar) — cùng dữ liệu, chỉ khác cách hiển thị."
        >
          <Lbl label="Kiểu hiển thị">
            <select
              value={mode}
              onChange={(event) =>
                updateTable({ display_mode: event.target.value as 'table' | 'gallery' | 'calendar' })
              }
              className={INPUT}
            >
              <option value="table">Bảng (mặc định)</option>
              <option value="gallery">Gallery ảnh</option>
              <option value="calendar">Lịch (Calendar)</option>
            </select>
          </Lbl>

          {mode === 'calendar' && (
            <div className="mt-3 space-y-3">
              {visibleCols.length === 0 ? (
                <BuilderEmptyHint className="text-left">
                  Hãy chọn cột hiển thị trước — Calendar cần một cột ngày.
                </BuilderEmptyHint>
              ) : (
                <>
                  <Lbl label="Cột ngày (bắt buộc)">
                    <SingleColumnPicker
                      sourceColumns={visibleCols}
                      value={cal.date_column || null}
                      onChange={(next) => updateCalendar({ date_column: next || '' })}
                      placeholder="-- cột ngày đặt bản ghi lên lịch --"
                    />
                  </Lbl>
                  <Lbl label="Cột nhãn trên ô ngày (tùy chọn)">
                    <SingleColumnPicker
                      sourceColumns={visibleCols}
                      value={cal.title_column || null}
                      onChange={(next) => updateCalendar({ title_column: next || null })}
                      placeholder="-- mặc định: khoá chính --"
                    />
                  </Lbl>
                  <Lbl label="Cột tô màu chip (tùy chọn, vd trạng thái)">
                    <SingleColumnPicker
                      sourceColumns={visibleCols}
                      value={cal.color_column || null}
                      onChange={(next) => updateCalendar({ color_column: next || null })}
                      placeholder="-- không --"
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
                  Hãy chọn cột hiển thị trước — Gallery lấy ảnh và nhãn từ các cột đang hiển thị.
                </BuilderEmptyHint>
              ) : (
                <>
                  <Lbl label="Cột ảnh (bắt buộc)">
                    <SingleColumnPicker
                      sourceColumns={visibleCols}
                      value={gc.image_column || null}
                      onChange={(next) => updateGallery({ image_column: next || '' })}
                      placeholder="-- cột chứa ảnh (data:image) --"
                    />
                  </Lbl>
                  <Lbl label="Cột tiêu đề thẻ (tùy chọn)">
                    <SingleColumnPicker
                      sourceColumns={visibleCols}
                      value={gc.title_column || null}
                      onChange={(next) => updateGallery({ title_column: next || null })}
                      placeholder="-- không --"
                    />
                  </Lbl>
                  <Lbl label="Cột mô tả phụ (tùy chọn)">
                    <SingleColumnPicker
                      sourceColumns={visibleCols}
                      value={gc.subtitle_column || null}
                      onChange={(next) => updateGallery({ subtitle_column: next || null })}
                      placeholder="-- không --"
                    />
                  </Lbl>
                  <Lbl label="Nhóm theo cột (vd: ngày ghi nhận)">
                    <SingleColumnPicker
                      sourceColumns={visibleCols}
                      value={gc.group_by_column || null}
                      onChange={(next) => updateGallery({ group_by_column: next || null })}
                      placeholder="-- không nhóm --"
                    />
                  </Lbl>
                  <Lbl label="Số thẻ mỗi hàng">
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

          <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-slate-700">Thẻ KPI (trên đầu bảng)</div>
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
                className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
              >
                <Plus className="h-3.5 w-3.5" /> Thêm thẻ
              </button>
            </div>
            {(tableSpec.stat_tiles || []).length === 0 ? (
              <BuilderEmptyHint className="text-left">
                Chưa có thẻ KPI. Thêm để hiện tổng/đếm ngay trên đầu bảng (vd Σ Sản lượng).
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
                      placeholder="Nhãn (Σ Sản lượng)"
                      className={INPUT}
                    />
                    <SingleColumnPicker
                      sourceColumns={tableSpec.columns || []}
                      value={tile.column || null}
                      onChange={(next) => updateTile({ column: next || '' })}
                      placeholder="-- cột --"
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
                      placeholder="đơn vị"
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
                      title="Xoá"
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
          title="Footer totals"
          subtitle="Aggregate columns into a footer row (current page only)."
        >
          {tableSpec.columns.length === 0 ? (
            <BuilderEmptyHint className="text-left">
              Pick visible columns first.
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
                      <option value="">— none —</option>
                      {TOTALS_KINDS.map((k) => (
                        <option key={k.value} value={k.value}>
                          {k.label}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-3 text-caption text-text-tertiary">
            Aggregations run over the rows currently visible (after filters and
            paging). To total across the entire table, build a dataset measure
            and surface it via a dashboard screen.
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
          title="Header groups (multi-level header)"
          subtitle="Merge column headers — like a 'Q1 2026' label spanning the Jan/Feb/Mar columns."
        >
          {tableSpec.columns.length === 0 ? (
            <BuilderEmptyHint className="text-left">
              Pick visible columns first.
            </BuilderEmptyHint>
          ) : (
            <div className="space-y-3">
              {groups.length === 0 ? (
                <BuilderEmptyHint className="text-left">
                  No header groups yet. Add one to merge consecutive columns under
                  a shared label.
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
                        placeholder="e.g. Q1 2026"
                      />
                      <BuilderIconButton
                        onClick={() => removeGroup(idx)}
                        title="Remove group"
                        variant="danger"
                      >
                        <Trash2 className="h-3 w-3 text-danger" />
                      </BuilderIconButton>
                    </div>
                    <MultiColumnPicker
                      sourceColumns={availableFor(idx)}
                      value={group.columns}
                      onChange={(columns) => updateGroup(idx, { columns })}
                      placeholder="Pick the columns this header spans..."
                    />
                  </div>
                ))
              )}
              <button
                type="button"
                onClick={addGroup}
                className="rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-1.5 text-caption hover:bg-surface-2"
              >
                + Add header group
              </button>
              <p className="text-caption text-text-tertiary">
                Each group must contain at least 2 columns and they must be
                contiguous in the visible-columns list. Otherwise the runtime
                skips the group silently.
                {Array.from(assigned).length > 0 ? (
                  <>
                    <br />Currently assigned: {Array.from(assigned).length} cell(s).
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
          title="Row merge (Google-Sheets style)"
          subtitle="When consecutive rows share a value in these columns, the first cell spans the run."
        >
          {candidates.length === 0 ? (
            <BuilderEmptyHint className="text-left">
              No mergeable columns. Editable columns cannot be merged - merge +
              inline edit conflict. Pick a read-only column.
            </BuilderEmptyHint>
          ) : (
            <MultiColumnPicker
              sourceColumns={candidates}
              value={groupBy}
              onChange={(value) => updateTable({ group_by: value })}
              placeholder="Pick columns to merge consecutive identical cells..."
            />
          )}
          <p className="mt-2 text-caption text-text-tertiary">
            Order matters: merging happens left-to-right, so a leading column
            partitions the page first, then later columns merge within each
            partition.
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
      const TABLE_INPUT_TYPES: Array<{ value: TableInputType; label: string }> = [
        { value: 'text', label: 'Text' },
        { value: 'number', label: 'Number' },
        { value: 'currency', label: 'Currency' },
        { value: 'percent', label: 'Percent' },
        { value: 'date', label: 'Date' },
        { value: 'datetime', label: 'Date+time' },
        { value: 'time', label: 'Time' },
        { value: 'checkbox', label: 'Checkbox' },
        { value: 'select', label: 'Select' },
        { value: 'enum_list', label: 'Multi-select' },
        { value: 'rating', label: 'Rating' },
        { value: 'color', label: 'Color' },
        { value: 'slider', label: 'Slider' },
      ];
      return (
        <BuilderInspectorPanel
          icon={<Settings2 className="h-4 w-4" />}
          title="Column presentation"
          subtitle="Friendly labels, widths, formats and alignment — overrides the raw column name."
        >
          {tableSpec.columns.length === 0 ? (
            <BuilderEmptyHint className="text-left">
              Pick visible columns first.
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
                        placeholder="Friendly label"
                        className={INPUT}
                      />
                      <input
                        type="number"
                        value={m.width_px ?? ''}
                        onChange={(event) => {
                          const v = event.target.value;
                          update(col, { width_px: v ? Number(v) : null });
                        }}
                        placeholder="Width px"
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
                        <option value="">— format —</option>
                        {CELL_FORMATS.map((f) => (
                          <option key={f.value} value={f.value}>
                            {f.label}
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
                        <option value="">— align —</option>
                        <option value="left">Left</option>
                        <option value="center">Center</option>
                        <option value="right">Right</option>
                      </select>
                    </div>
                    {editableSet.has(col) && (
                      <div className="mt-1 space-y-2 rounded bg-surface-2 p-2">
                        <div className="grid grid-cols-2 gap-2">
                          <Lbl label="Kiểu ô nhập (khi sửa)">
                            <select
                              value={m.input_type || ''}
                              onChange={(event) =>
                                update(col, {
                                  input_type: (event.target.value || null) as TableInputType | null,
                                })
                              }
                              className={INPUT}
                            >
                              <option value="">Text (mặc định)</option>
                              {TABLE_INPUT_TYPES.map((t) => (
                                <option key={t.value} value={t.value}>
                                  {t.label}
                                </option>
                              ))}
                            </select>
                          </Lbl>
                          {m.input_type === 'currency' && (
                            <Lbl label="Ký hiệu tiền">
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
                            <Lbl label="Số sao">
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
                          <Lbl label="Lựa chọn (mỗi dòng: label|value)">
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
                              placeholder={'Tốt|good\nKhá|ok'}
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
          title="Detail side panel"
          subtitle="Opens when an end user clicks a row. Shows fields hidden from the grid for density."
        >
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={panel.enabled !== false}
              onChange={(event) => updatePanel({ enabled: event.target.checked })}
            />
            <span className="text-caption text-text-secondary">
              <span className="font-emphasis text-text-primary">Enable panel</span>
              <span className="ml-1 text-text-tertiary">
                — when off, clicking a row does nothing (inline-edit only).
              </span>
            </span>
          </label>
          {panel.enabled !== false && (
            <div className="mt-3 space-y-3">
              <Lbl label="Panel title (defaults to screen title)">
                <input
                  value={panel.title || ''}
                  onChange={(event) => updatePanel({ title: event.target.value })}
                  className={INPUT}
                  placeholder="e.g. Đơn hàng"
                />
              </Lbl>
              <Lbl label="Columns shown in the panel (empty = same as table columns)">
                <MultiColumnPicker
                  sourceColumns={allCols}
                  value={panel.columns || []}
                  onChange={(value) => updatePanel({ columns: value })}
                  placeholder="Pick columns to surface in the side panel..."
                />
              </Lbl>
              <Lbl label="Editable from the panel">
                <MultiColumnPicker
                  sourceColumns={(panel.columns && panel.columns.length > 0 ? panel.columns : allCols).filter(
                    (c) =>
                      !computed.some((cc) => cc.name === c) &&
                      !lookups.some((ll) => ll.name === c),
                  )}
                  value={panel.editable_columns || []}
                  onChange={(value) => updatePanel({ editable_columns: value })}
                  placeholder="Empty = panel is read-only (use inline-edit instead)."
                />
              </Lbl>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-caption font-emphasis text-text-secondary">
                    Sections (optional grouping)
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const baseName = 'Section';
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
                    + Add section
                  </button>
                </div>
                {sectionNames.length === 0 ? (
                  <BuilderEmptyHint className="text-left">
                    No sections — every column is shown in one default group.
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
                            title="Remove section"
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
                          placeholder="Pick columns in this section..."
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
          subtitle="JavaScript computed column — evaluated server-side in a QuickJS sandbox (1000ms / row)."
          action={
            <BuilderIconButton
              onClick={() => removeComputed(activeComputedIndex)}
              title="Delete column"
              variant="danger"
            >
              <Trash2 className="h-3.5 w-3.5 text-danger" />
            </BuilderIconButton>
          }
        >
          <div className="space-y-3">
            <div className={BUILDER_GRID_2}>
              <Lbl label="Column name (identifier)">
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
              <Lbl label="Display label">
                <input
                  value={col.label || ''}
                  onChange={(event) =>
                    updateComputed(activeComputedIndex, { label: event.target.value })
                  }
                  className={INPUT}
                  placeholder={col.name}
                />
              </Lbl>
              <Lbl label="Format">
                <select
                  value={col.format || ''}
                  onChange={(event) =>
                    updateComputed(activeComputedIndex, {
                      format: (event.target.value || null) as CellFormat | null,
                    })
                  }
                  className={INPUT}
                >
                  <option value="">— auto —</option>
                  {CELL_FORMATS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </Lbl>
            </div>

            <Lbl label="Formula">
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
                  Hidden from the table.
                </span>
                <button
                  type="button"
                  onClick={() => toggleColumnVisible(col.name)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-brand/30 bg-brand/10 px-2.5 text-caption font-emphasis text-brand hover:bg-brand/15"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Show column
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-success/20 bg-success/5 px-3 py-2">
                <span className="text-caption font-emphasis text-success">
                  Visible in the table
                </span>
                <button
                  type="button"
                  onClick={() => toggleColumnVisible(col.name)}
                  className="text-caption text-text-tertiary hover:text-text-primary"
                >
                  Hide
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
          subtitle="VLOOKUP from a related dataset table (read-only)"
          action={
            <BuilderIconButton
              onClick={() => removeLookup(activeLookupIndex)}
              title="Delete column"
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
              <Lbl label="Column name (identifier)">
                <input
                  value={col.name}
                  onChange={(event) => {
                    const cleaned = event.target.value.replace(/[^A-Za-z0-9_]/g, '_');
                    updateLookup(activeLookupIndex, { name: cleaned });
                  }}
                  className={`${INPUT} font-mono`}
                />
              </Lbl>
              <Lbl label="Display label">
                <input
                  value={col.label || ''}
                  onChange={(event) =>
                    updateLookup(activeLookupIndex, { label: event.target.value })
                  }
                  className={INPUT}
                  placeholder={col.name}
                />
              </Lbl>
              <Lbl label="Linked dataset table">
                <select
                  value={col.from_table_id || 0}
                  onChange={(event) =>
                    updateLookup(activeLookupIndex, {
                      from_table_id: Number(event.target.value) || 0,
                    })
                  }
                  className={INPUT}
                >
                  <option value="">— pick a table —</option>
                  {tables.map((table) => (
                    <option key={table.id} value={table.id}>
                      {table.display_name}
                    </option>
                  ))}
                </select>
              </Lbl>
              <Lbl label="Format">
                <select
                  value={col.format || ''}
                  onChange={(event) =>
                    updateLookup(activeLookupIndex, {
                      format: (event.target.value || null) as CellFormat | null,
                    })
                  }
                  className={INPUT}
                >
                  <option value="">— auto —</option>
                  {CELL_FORMATS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </Lbl>
              <Lbl label="Match on (this table)">
                <SingleColumnPicker
                  sourceColumns={columnNames}
                  value={col.match_column_local || null}
                  onChange={(next) =>
                    updateLookup(activeLookupIndex, { match_column_local: next || '' })
                  }
                />
              </Lbl>
              <Lbl label="Match on (linked table)">
                <SingleColumnPicker
                  sourceColumns={remoteColumns}
                  value={col.match_column_remote || null}
                  onChange={(next) =>
                    updateLookup(activeLookupIndex, { match_column_remote: next || '' })
                  }
                />
              </Lbl>
              <Lbl label="Return column">
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
                + Show this column in the table
              </button>
            ) : (
              <p className="text-caption text-text-tertiary">
                ✓ Visible in the table.{' '}
                <button
                  type="button"
                  onClick={() => toggleColumnVisible(col.name)}
                  className="text-brand hover:underline"
                >
                  Hide
                </button>
              </p>
            )}
            <p className="text-caption text-text-tertiary">
              Lookup runs once per page with a single batched query against the
              linked table. Values are resolved on the server — the runtime
              cannot bypass the RLS of the linked table.
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
          subtitle="Aggregate rows from a related child table (read-only)"
          action={
            <BuilderIconButton
              onClick={() => removeRollup(activeRollupIndex)}
              title="Delete column"
              variant="danger"
            >
              <Trash2 className="h-3.5 w-3.5 text-danger" />
            </BuilderIconButton>
          }
        >
          <div className="space-y-3">
            <div className={BUILDER_GRID_2}>
              <Lbl label="Column name (identifier)">
                <input
                  value={col.name}
                  onChange={(event) => {
                    const cleaned = event.target.value.replace(/[^A-Za-z0-9_]/g, '_');
                    updateRollup(activeRollupIndex, { name: cleaned });
                  }}
                  className={`${INPUT} font-mono`}
                />
              </Lbl>
              <Lbl label="Display label">
                <input
                  value={col.label || ''}
                  onChange={(event) =>
                    updateRollup(activeRollupIndex, { label: event.target.value })
                  }
                  className={INPUT}
                  placeholder={col.name}
                />
              </Lbl>
              <Lbl label="Child dataset table">
                <select
                  value={col.from_table_id || 0}
                  onChange={(event) =>
                    updateRollup(activeRollupIndex, {
                      from_table_id: Number(event.target.value) || 0,
                    })
                  }
                  className={INPUT}
                >
                  <option value="">— pick a table —</option>
                  {tables.map((table) => (
                    <option key={table.id} value={table.id}>
                      {table.display_name}
                    </option>
                  ))}
                </select>
              </Lbl>
              <Lbl label="Aggregate">
                <select
                  value={col.agg || 'count'}
                  onChange={(event) =>
                    updateRollup(activeRollupIndex, {
                      agg: event.target.value as TableRollupAgg,
                    })
                  }
                  className={INPUT}
                >
                  <option value="count">Count (số dòng con)</option>
                  <option value="sum">Sum</option>
                  <option value="avg">Average</option>
                  <option value="min">Min</option>
                  <option value="max">Max</option>
                </select>
              </Lbl>
              <Lbl label="Match on (this table)">
                <SingleColumnPicker
                  sourceColumns={columnNames}
                  value={col.match_column_local || null}
                  onChange={(next) =>
                    updateRollup(activeRollupIndex, { match_column_local: next || '' })
                  }
                />
              </Lbl>
              <Lbl label="Match on (child table)">
                <SingleColumnPicker
                  sourceColumns={remoteColumns}
                  value={col.match_column_remote || null}
                  onChange={(next) =>
                    updateRollup(activeRollupIndex, { match_column_remote: next || '' })
                  }
                />
              </Lbl>
              {needsValueColumn ? (
                <Lbl label="Value column (child)">
                  <SingleColumnPicker
                    sourceColumns={remoteColumns}
                    value={col.value_column || null}
                    onChange={(next) =>
                      updateRollup(activeRollupIndex, { value_column: next || null })
                    }
                  />
                </Lbl>
              ) : null}
              <Lbl label="Format">
                <select
                  value={col.format || ''}
                  onChange={(event) =>
                    updateRollup(activeRollupIndex, {
                      format: (event.target.value || null) as CellFormat | null,
                    })
                  }
                  className={INPUT}
                >
                  <option value="">— auto —</option>
                  {CELL_FORMATS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </Lbl>
            </div>
            {needsValueColumn && !col.value_column ? (
              <p className="text-caption text-amber-600">
                Chọn một cột số ở bảng con để {col.agg}.
              </p>
            ) : null}
            <p className="text-caption text-text-tertiary">
              Roll-up chạy một lần mỗi trang: gom các dòng của bảng con theo khóa
              khớp rồi tính {col.agg || 'count'} bằng máy chủ (tôn trọng RLS của
              bảng con). Ví dụ: đếm số lần ghi nhận, tổng sản lượng theo lô.
            </p>
          </div>
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'format_rules') {
      const FMT_COLORS: Array<{ value: FormatRuleColor; label: string; dot: string }> = [
        { value: 'green', label: 'Xanh lá', dot: 'bg-emerald-500' },
        { value: 'amber', label: 'Vàng', dot: 'bg-amber-500' },
        { value: 'red', label: 'Đỏ', dot: 'bg-rose-500' },
        { value: 'blue', label: 'Xanh dương', dot: 'bg-sky-500' },
        { value: 'violet', label: 'Tím', dot: 'bg-violet-500' },
        { value: 'slate', label: 'Xám', dot: 'bg-slate-400' },
      ];
      return (
        <BuilderInspectorPanel
          icon={<Palette className="h-4 w-4" />}
          title="Định dạng có điều kiện"
          subtitle="Tô màu dòng/ô khi biểu thức đúng — áp cho cả bảng, gallery"
          action={
            <BuilderIconButton onClick={addFormatRule} title="Thêm quy tắc">
              <Plus className="h-3.5 w-3.5" />
            </BuilderIconButton>
          }
        >
          {formatRules.length === 0 ? (
            <BuilderEmptyHint>
              Chưa có quy tắc. Ví dụ: <code>{'{{row.san_luong}} < 100'}</code> → tô
              đỏ dòng sản lượng thấp.
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
                      Quy tắc {idx + 1}
                    </span>
                    <BuilderIconButton
                      onClick={() => removeFormatRule(idx)}
                      title="Xóa quy tắc"
                      variant="danger"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-danger" />
                    </BuilderIconButton>
                  </div>
                  <Lbl label="Biểu thức (khi đúng thì áp dụng)">
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
                    <Lbl label="Màu">
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
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </Lbl>
                    <Lbl label="Biểu tượng (tùy chọn)">
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
                  <Lbl label="Áp cho cột (bỏ trống = cả dòng)">
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
            Biểu thức dùng cùng cú pháp với show_if/valid_if:{' '}
            <code>{'{{row.cot}}'}</code>, AND/OR, so sánh, hàm CONCAT/YEAR…
            Quy tắc đầu tiên khớp sẽ thắng.
          </p>
        </BuilderInspectorPanel>
      );
    }

    if (activeItem.startsWith('filter:')) {
      const filter = filters[activeFilterIndex];
      if (!filter) return null;
      return (
        <BuilderInspectorPanel
          icon={<Filter className="h-4 w-4" />}
          title={filter.label?.trim() || filter.column || 'Filter'}
          subtitle={`${FILTER_KIND_LABEL[filter.kind]} - ${filter.column}`}
          action={
            <BuilderIconButton
              onClick={() => removeFilter(activeFilterIndex)}
              title="Delete filter"
              variant="danger"
            >
              <Trash2 className="h-3.5 w-3.5 text-danger" />
            </BuilderIconButton>
          }
        >
          <div className={BUILDER_GRID_2}>
            <Lbl label="Column">
              <SingleColumnPicker
                sourceColumns={columnNames}
                value={filter.column}
                onChange={(next) =>
                  updateFilter(activeFilterIndex, { column: next || '' })
                }
              />
            </Lbl>
            <Lbl label="Filter kind">
              <select
                value={filter.kind}
                onChange={(event) =>
                  updateFilter(activeFilterIndex, {
                    kind: event.target.value as TableFilterSpec['kind'],
                  })
                }
                className={INPUT}
              >
                <option value="text">Text search</option>
                <option value="select">Single select</option>
                <option value="date_range">Date range</option>
                <option value="number_range">Number range</option>
              </select>
            </Lbl>
            <Lbl label="Display label">
              <input
                value={filter.label || ''}
                onChange={(event) =>
                  updateFilter(activeFilterIndex, { label: event.target.value })
                }
                className={INPUT}
                placeholder={filter.column}
              />
            </Lbl>
          </div>
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
          Pick a primary data source before configuring columns or filters.
        </BuilderEmptyHint>
      ) : null}

      <BuilderObjectEditor>
        <BuilderNavigator
          title="Table objects"
          description="Configure the visible columns, which ones are editable, layout, and pre-set filters."
        >
          <BuilderNavigatorGroup title="Table">
            <BuilderNavigatorItem
              icon={<Columns3 className="h-3.5 w-3.5" />}
              label="Visible columns"
              subtitle={`${tableSpec.columns.length} selected`}
              active={activeItem === 'columns'}
              onClick={() => setActiveItem('columns')}
            />
            <BuilderNavigatorItem
              icon={<PencilLine className="h-3.5 w-3.5" />}
              label="Editable columns"
              subtitle={`${(tableSpec.editable_columns || []).length} of ${tableSpec.columns.length}`}
              active={activeItem === 'editable'}
              onClick={() => setActiveItem('editable')}
            />
            <BuilderNavigatorItem
              icon={<Settings2 className="h-3.5 w-3.5" />}
              label="Row behaviour"
              subtitle={`Add: ${tableSpec.allow_add_row !== false ? 'on' : 'off'} - Delete: ${
                tableSpec.allow_delete_row !== false ? 'on' : 'off'
              }`}
              active={activeItem === 'behaviour'}
              onClick={() => setActiveItem('behaviour')}
            />
            <BuilderNavigatorItem
              icon={<ScanLine className="h-3.5 w-3.5" />}
              label="Chế độ POS (quét → giỏ)"
              subtitle={tableSpec.pos_cart ? 'Đang bật' : 'Tắt'}
              active={activeItem === 'pos_cart'}
              onClick={() => setActiveItem('pos_cart')}
            />
            <BuilderNavigatorItem
              icon={<Rows3 className="h-3.5 w-3.5" />}
              label="Paging and sorting"
              subtitle={`${tableSpec.page_size ?? 100} rows/page${
                tableSpec.default_sort_column ? ` - ${tableSpec.default_sort_column}` : ''
              }`}
              active={activeItem === 'settings'}
              onClick={() => setActiveItem('settings')}
            />
            <BuilderNavigatorItem
              icon={<Plus className="h-3.5 w-3.5" />}
              label="New row defaults"
              subtitle={`${(tableSpec.required_columns || []).length} required - ${
                Object.keys(tableSpec.default_values || {}).length
              } preset`}
              active={activeItem === 'defaults'}
              onClick={() => setActiveItem('defaults')}
            />
            <BuilderNavigatorItem
              icon={<Sigma className="h-3.5 w-3.5" />}
              label="Footer totals"
              subtitle={
                Object.keys(totals).length === 0
                  ? 'No totals'
                  : `${Object.keys(totals).length} column${
                      Object.keys(totals).length === 1 ? '' : 's'
                    }`
              }
              active={activeItem === 'totals'}
              onClick={() => setActiveItem('totals')}
            />
            <BuilderNavigatorItem
              icon={<ListFilter className="h-3.5 w-3.5" />}
              label="Empty state"
              subtitle={tableSpec.empty_state_message ? 'Custom message' : 'Default message'}
              active={activeItem === 'empty'}
              onClick={() => setActiveItem('empty')}
            />
            <BuilderNavigatorItem
              icon={<LayoutGrid className="h-3.5 w-3.5" />}
              label="Chế độ hiển thị"
              subtitle={tableSpec.display_mode === 'gallery' ? 'Gallery ảnh' : 'Bảng'}
              active={activeItem === 'display'}
              onClick={() => setActiveItem('display')}
            />
          </BuilderNavigatorGroup>

          <BuilderNavigatorGroup title="Layout">
            <BuilderNavigatorItem
              icon={<Columns3 className="h-3.5 w-3.5" />}
              label="Header groups"
              subtitle={
                (tableSpec.column_groups || []).length === 0
                  ? 'No groups'
                  : `${(tableSpec.column_groups || []).length} group${
                      (tableSpec.column_groups || []).length === 1 ? '' : 's'
                    }`
              }
              active={activeItem === 'column_groups'}
              onClick={() => setActiveItem('column_groups')}
            />
            <BuilderNavigatorItem
              icon={<Rows3 className="h-3.5 w-3.5" />}
              label="Row merge"
              subtitle={
                (tableSpec.group_by || []).length === 0
                  ? 'No merging'
                  : `By ${(tableSpec.group_by || []).join(', ')}`
              }
              active={activeItem === 'row_merge'}
              onClick={() => setActiveItem('row_merge')}
            />
            <BuilderNavigatorItem
              icon={<Settings2 className="h-3.5 w-3.5" />}
              label="Column presentation"
              subtitle={
                Object.keys(tableSpec.column_metadata || {}).length === 0
                  ? 'Default labels'
                  : `${Object.keys(tableSpec.column_metadata || {}).length} custom`
              }
              active={activeItem === 'column_meta'}
              onClick={() => setActiveItem('column_meta')}
            />
            <BuilderNavigatorItem
              icon={<PencilLine className="h-3.5 w-3.5" />}
              label="Detail panel"
              subtitle={
                tableSpec.detail_panel?.enabled === false
                  ? 'Disabled'
                  : (tableSpec.detail_panel?.editable_columns || []).length > 0
                    ? `${(tableSpec.detail_panel?.editable_columns || []).length} editable`
                    : 'Read-only'
              }
              active={activeItem === 'detail_panel'}
              onClick={() => setActiveItem('detail_panel')}
            />
            <BuilderNavigatorItem
              icon={<Palette className="h-3.5 w-3.5" />}
              label="Định dạng có điều kiện"
              subtitle={
                formatRules.length === 0
                  ? 'No rules'
                  : `${formatRules.length} rule${formatRules.length === 1 ? '' : 's'}`
              }
              active={activeItem === 'format_rules'}
              onClick={() => setActiveItem('format_rules')}
            />
          </BuilderNavigatorGroup>

          <BuilderNavigatorGroup
            title={`Computed columns (${computed.length})`}
            action={
              <button
                type="button"
                onClick={addComputed}
                disabled={columnNames.length === 0}
                className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
                title="Add computed column"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            }
          >
            {computed.length === 0 ? (
              <BuilderEmptyHint className="px-3 py-4">
                No formula columns yet.
              </BuilderEmptyHint>
            ) : (
              computed.map((col, index) => (
                <BuilderNavigatorItem
                  key={`${col.name}:${index}`}
                  icon={<Calculator className="h-3.5 w-3.5" />}
                  label={col.label?.trim() || col.name}
                  subtitle={col.formula.trim() ? col.formula.slice(0, 40) : 'No formula yet'}
                  active={activeItem === `computed:${index}`}
                  onClick={() => setActiveItem(`computed:${index}`)}
                  action={
                    <BuilderIconButton
                      onClick={() => removeComputed(index)}
                      title="Delete column"
                      variant="danger"
                    >
                      <Trash2 className="h-3 w-3 text-danger" />
                    </BuilderIconButton>
                  }
                />
              ))
            )}
          </BuilderNavigatorGroup>

          <BuilderNavigatorGroup
            title={`Lookup columns (${lookups.length})`}
            action={
              <button
                type="button"
                onClick={addLookup}
                disabled={tables.length === 0}
                className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
                title="Add lookup column"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            }
          >
            {lookups.length === 0 ? (
              <BuilderEmptyHint className="px-3 py-4">
                No lookup columns yet.
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
                        : 'No table selected'
                    }
                    active={activeItem === `lookup:${index}`}
                    onClick={() => setActiveItem(`lookup:${index}`)}
                    action={
                      <BuilderIconButton
                        onClick={() => removeLookup(index)}
                        title="Delete column"
                        variant="danger"
                      >
                        <Trash2 className="h-3 w-3 text-danger" />
                      </BuilderIconButton>
                    }
                  />
                );
              })
            )}
          </BuilderNavigatorGroup>

          <BuilderNavigatorGroup
            title={`Roll-up columns (${rollups.length})`}
            action={
              <button
                type="button"
                onClick={addRollup}
                disabled={tables.length === 0}
                className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
                title="Add roll-up column"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            }
          >
            {rollups.length === 0 ? (
              <BuilderEmptyHint className="px-3 py-4">
                Chưa có cột roll-up (gộp bảng con).
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
                        : 'No table selected'
                    }
                    active={activeItem === `rollup:${index}`}
                    onClick={() => setActiveItem(`rollup:${index}`)}
                    action={
                      <BuilderIconButton
                        onClick={() => removeRollup(index)}
                        title="Delete column"
                        variant="danger"
                      >
                        <Trash2 className="h-3 w-3 text-danger" />
                      </BuilderIconButton>
                    }
                  />
                );
              })
            )}
          </BuilderNavigatorGroup>

          <BuilderNavigatorGroup
            title={`Filters (${filters.length})`}
            action={
              <button
                type="button"
                onClick={addFilter}
                disabled={columnNames.length === 0}
                className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-brand disabled:cursor-not-allowed disabled:opacity-40"
                title="Add filter"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            }
          >
            {filters.length === 0 ? (
              <BuilderEmptyHint className="px-3 py-4">No filters yet.</BuilderEmptyHint>
            ) : (
              filters.map((filter, index) => (
                <BuilderNavigatorItem
                  key={`${filter.column}:${index}`}
                  icon={<Filter className="h-3.5 w-3.5" />}
                  label={filter.label?.trim() || filter.column || 'Filter'}
                  subtitle={`${FILTER_KIND_LABEL[filter.kind]} - ${filter.column}`}
                  active={activeItem === `filter:${index}`}
                  onClick={() => setActiveItem(`filter:${index}`)}
                  action={
                    <BuilderIconButton
                      onClick={() => removeFilter(index)}
                      title="Delete filter"
                      variant="danger"
                    >
                      <Trash2 className="h-3 w-3 text-danger" />
                    </BuilderIconButton>
                  }
                />
              ))
            )}
          </BuilderNavigatorGroup>
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
        Default values
      </div>
      <p className="text-caption text-text-tertiary">
        Pre-fill these columns when a new row is added. Supports placeholders:{' '}
        <code className="rounded bg-surface-2 px-1">{'{{app_user.username}}'}</code>,{' '}
        <code className="rounded bg-surface-2 px-1">{'{{today}}'}</code>,{' '}
        <code className="rounded bg-surface-2 px-1">{'{{now}}'}</code>.
      </p>
      {entries.length === 0 ? (
        <BuilderEmptyHint className="text-left">No defaults set yet.</BuilderEmptyHint>
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
                placeholder="value or {{placeholder}}"
              />
              <BuilderIconButton
                onClick={() => removeValue(col)}
                title="Remove default"
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
            Add default
          </button>
        </div>
      ) : null}
    </div>
  );
}
