/**
 * GridScreenEditor — spreadsheet-style screen configuration.
 *
 * Mirrors the ListScreenEditor surface (columns / filters / paging) but
 * adds: editable-columns picker, allow add/delete toggles, required
 * columns and per-column default values applied when adding a new row.
 *
 * RLS is configured on the shared "Permissions" tab — same as form/list.
 */
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  Calculator,
  Columns3,
  Filter,
  Link2,
  ListFilter,
  PencilLine,
  Plus,
  Rows3,
  Settings2,
  Sigma,
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
  DataSourcePicker,
} from './BuilderChrome';
import { MultiColumnPicker, SingleColumnPicker } from './BuilderValueControls';
import FormulaInput from './FormulaInput';
import type {
  CellFormat,
  GridComputedColumnSpec,
  GridLookupColumnSpec,
  GridScreenSpecBuilt,
  GridTotalsKind,
  ListFilterSpec,
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

type GridSpec = GridScreenSpecBuilt;
type ActiveItem =
  | 'columns'
  | 'editable'
  | 'behaviour'
  | 'settings'
  | 'defaults'
  | 'totals'
  | 'empty'
  | `filter:${number}`
  | `computed:${number}`
  | `lookup:${number}`;

const EMPTY_GRID: GridSpec = {
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

const TOTALS_KINDS: Array<{ value: GridTotalsKind; label: string }> = [
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Average' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
  { value: 'count', label: 'Count (non-empty)' },
];

const FILTER_KIND_LABEL: Record<ListFilterSpec['kind'], string> = {
  text: 'Text search',
  select: 'Single select',
  date_range: 'Date range',
  number_range: 'Number range',
};

export default function GridScreenEditor({ screen, tables, onChange }: Props) {
  const grid = screen.grid || EMPTY_GRID;
  const filters = grid.filters || [];
  const computed = grid.computed_columns || [];
  const lookups = grid.lookup_columns || [];
  const totals = grid.totals || {};
  const tableCols = tables.find((table) => table.id === screen.table_id)?.columns ?? [];
  const columnNames = tableCols.map((column) => column.name);
  const [activeItem, setActiveItem] = useState<ActiveItem>('columns');

  // All column identifiers visible to formula scope: regular + lookup +
  // computed (so a downstream formula can reference an upstream one).
  const allReferenceableColumns = useMemo(
    () => [
      ...columnNames,
      ...lookups.map((l) => l.name),
      ...computed.map((c) => c.name),
    ],
    [columnNames, lookups, computed],
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
  }, [
    activeComputedIndex,
    activeFilterIndex,
    activeItem,
    activeLookupIndex,
    computed.length,
    filters.length,
    lookups.length,
  ]);

  const updateGrid = (patch: Partial<GridSpec>) =>
    onChange({ ...screen, grid: { ...grid, ...patch } });

  const addFilter = () => {
    if (columnNames.length === 0) return;
    const next: ListFilterSpec[] = [
      ...filters,
      { column: columnNames[0], kind: 'text', label: '' },
    ];
    updateGrid({ filters: next });
    setActiveItem(`filter:${next.length - 1}`);
  };

  const updateFilter = (idx: number, patch: Partial<ListFilterSpec>) => {
    const next = [...filters];
    next[idx] = { ...next[idx], ...patch };
    updateGrid({ filters: next });
  };

  const removeFilter = (idx: number) => {
    const next = filters.filter((_, index) => index !== idx);
    updateGrid({ filters: next });
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
    const next: GridComputedColumnSpec[] = [
      ...computed,
      { name, label: '', formula: '', format: null },
    ];
    updateGrid({ computed_columns: next });
    setActiveItem(`computed:${next.length - 1}`);
  };

  const updateComputed = (idx: number, patch: Partial<GridComputedColumnSpec>) => {
    const next = [...computed];
    const prev = next[idx];
    next[idx] = { ...prev, ...patch };
    // If the user renamed the column, update the columns array + totals key.
    let nextColumns = grid.columns;
    let nextTotals = totals;
    if (patch.name && patch.name !== prev.name) {
      nextColumns = nextColumns.map((c) => (c === prev.name ? patch.name! : c));
      if (totals[prev.name]) {
        nextTotals = { ...totals };
        nextTotals[patch.name] = nextTotals[prev.name];
        delete nextTotals[prev.name];
      }
    }
    updateGrid({
      computed_columns: next,
      columns: nextColumns,
      totals: nextTotals,
    });
  };

  const removeComputed = (idx: number) => {
    const removed = computed[idx];
    const next = computed.filter((_, index) => index !== idx);
    const nextColumns = grid.columns.filter((c) => c !== removed?.name);
    const nextTotals = { ...totals };
    if (removed) delete nextTotals[removed.name];
    updateGrid({
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
    const next: GridLookupColumnSpec[] = [
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
    updateGrid({ lookup_columns: next });
    setActiveItem(`lookup:${next.length - 1}`);
  };

  const updateLookup = (idx: number, patch: Partial<GridLookupColumnSpec>) => {
    const next = [...lookups];
    const prev = next[idx];
    next[idx] = { ...prev, ...patch };
    let nextColumns = grid.columns;
    let nextTotals = totals;
    if (patch.name && patch.name !== prev.name) {
      nextColumns = nextColumns.map((c) => (c === prev.name ? patch.name! : c));
      if (totals[prev.name]) {
        nextTotals = { ...totals };
        nextTotals[patch.name] = nextTotals[prev.name];
        delete nextTotals[prev.name];
      }
    }
    updateGrid({
      lookup_columns: next,
      columns: nextColumns,
      totals: nextTotals,
    });
  };

  const removeLookup = (idx: number) => {
    const removed = lookups[idx];
    const next = lookups.filter((_, index) => index !== idx);
    const nextColumns = grid.columns.filter((c) => c !== removed?.name);
    const nextTotals = { ...totals };
    if (removed) delete nextTotals[removed.name];
    updateGrid({
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

  const toggleColumnVisible = (column: string) => {
    if (grid.columns.includes(column)) {
      updateGrid({ columns: grid.columns.filter((c) => c !== column) });
    } else {
      updateGrid({ columns: [...grid.columns, column] });
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
          subtitle="Pick which columns the grid shows. Order controls table order."
        >
          {pickable.length === 0 ? (
            <BuilderEmptyHint className="text-left">
              No data source selected, or the table has no columns.
            </BuilderEmptyHint>
          ) : (
            <>
              <MultiColumnPicker
                sourceColumns={pickable}
                value={grid.columns}
                onChange={(columns) => {
                  // Drop editable_columns / required_columns that are no
                  // longer visible. Computed/lookup names never end up
                  // editable or required (the inspectors that manage them
                  // already strip them on add).
                  const visible = new Set(columns);
                  updateGrid({
                    columns,
                    editable_columns: (grid.editable_columns || []).filter((c) =>
                      visible.has(c),
                    ),
                    required_columns: (grid.required_columns || []).filter((c) =>
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
      const editableCandidates = grid.columns.filter((c) => !derived.has(c));
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
              value={(grid.editable_columns || []).filter((c) => !derived.has(c))}
              onChange={(editable_columns) => updateGrid({ editable_columns })}
              placeholder="No editable columns - grid is read-only."
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
                checked={grid.allow_add_row !== false}
                onChange={(event) =>
                  updateGrid({ allow_add_row: event.target.checked })
                }
                className="mt-0.5"
              />
              <span className="text-caption text-text-secondary">
                <span className="font-emphasis text-text-primary">
                  Allow adding rows
                </span>
                <span className="ml-1 text-text-tertiary">
                  - shows an &quot;Add row&quot; button at the bottom of the grid.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={grid.allow_delete_row !== false}
                onChange={(event) =>
                  updateGrid({ allow_delete_row: event.target.checked })
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
          subtitle="Default row count and row ordering for this grid."
        >
          <div className={BUILDER_GRID_2}>
            <Lbl label="Rows per page">
              <input
                type="number"
                min={10}
                max={500}
                value={grid.page_size ?? 100}
                onChange={(event) =>
                  updateGrid({
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
                value={grid.default_sort_column || null}
                onChange={(next) => updateGrid({ default_sort_column: next || null })}
                placeholder="No default sort"
              />
            </Lbl>
            <Lbl label="Default sort direction">
              <select
                value={grid.default_sort_direction || 'desc'}
                onChange={(event) =>
                  updateGrid({
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
              {grid.columns.length === 0 ? (
                <BuilderEmptyHint className="text-left">
                  Pick visible columns first.
                </BuilderEmptyHint>
              ) : (
                <MultiColumnPicker
                  sourceColumns={grid.columns}
                  value={grid.required_columns || []}
                  onChange={(required_columns) => updateGrid({ required_columns })}
                  placeholder="No required columns."
                />
              )}
            </Lbl>
            <DefaultValuesEditor
              defaults={grid.default_values || {}}
              columns={grid.columns}
              onChange={(default_values) => updateGrid({ default_values })}
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
              value={grid.empty_state_message || ''}
              onChange={(event) =>
                updateGrid({ empty_state_message: event.target.value })
              }
              className={INPUT}
              placeholder="e.g. No matching rows. Tap + to add one."
            />
          </Lbl>
        </BuilderInspectorPanel>
      );
    }

    if (activeItem === 'totals') {
      // Footer aggregations. Every visible column is eligible; values are
      // restricted to the small ``GridTotalsKind`` set.
      return (
        <BuilderInspectorPanel
          icon={<Sigma className="h-4 w-4" />}
          title="Footer totals"
          subtitle="Aggregate columns into a footer row (current page only)."
        >
          {grid.columns.length === 0 ? (
            <BuilderEmptyHint className="text-left">
              Pick visible columns first.
            </BuilderEmptyHint>
          ) : (
            <div className="space-y-1.5">
              {grid.columns.map((col) => {
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
                        else next[col] = v as GridTotalsKind;
                        updateGrid({ totals: next });
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

    if (activeItem.startsWith('computed:')) {
      const col = computed[activeComputedIndex];
      if (!col) return null;
      // Scope columns the formula may reference: regular DB columns +
      // earlier computed columns + lookup columns. Excluding the current
      // formula's own name prevents trivial `total = total + 1` loops.
      const scope = allReferenceableColumns.filter((name) => name !== col.name);
      const allLookups = [
        ...columnNames,
        ...computed.slice(0, activeComputedIndex).map((c) => c.name),
        ...lookups.map((l) => l.name),
      ];
      return (
        <BuilderInspectorPanel
          icon={<Calculator className="h-4 w-4" />}
          title={col.label?.trim() || col.name}
          subtitle="Per-row computed column (read-only at runtime)"
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
                    // Normalise to a safe identifier: letters/digits/underscore.
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
              <FormulaInput
                value={col.formula}
                onChange={(formula) =>
                  updateComputed(activeComputedIndex, { formula })
                }
                availableColumns={allLookups.length > 0 ? allLookups : scope}
                placeholder="e.g. IF(qty > 0, price * qty, 0)"
              />
            </Lbl>
            {!grid.columns.includes(col.name) ? (
              <button
                type="button"
                onClick={() => toggleColumnVisible(col.name)}
                className="text-caption text-brand hover:underline"
              >
                + Show this column in the grid
              </button>
            ) : (
              <p className="text-caption text-text-tertiary">
                ✓ Visible in the grid.{' '}
                <button
                  type="button"
                  onClick={() => toggleColumnVisible(col.name)}
                  className="text-brand hover:underline"
                >
                  Hide
                </button>
              </p>
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
              <Lbl label="Match on (this grid)">
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
            {!grid.columns.includes(col.name) ? (
              <button
                type="button"
                onClick={() => toggleColumnVisible(col.name)}
                className="text-caption text-brand hover:underline"
              >
                + Show this column in the grid
              </button>
            ) : (
              <p className="text-caption text-text-tertiary">
                ✓ Visible in the grid.{' '}
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
                    kind: event.target.value as ListFilterSpec['kind'],
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

      {!screen.table_id ? (
        <BuilderEmptyHint className="text-left">
          Pick a primary data source before configuring columns or filters.
        </BuilderEmptyHint>
      ) : null}

      <BuilderObjectEditor>
        <BuilderNavigator
          title="Grid objects"
          description="Configure the visible columns, which ones are editable, and pre-set filters."
        >
          <BuilderNavigatorGroup title="Table">
            <BuilderNavigatorItem
              icon={<Columns3 className="h-3.5 w-3.5" />}
              label="Visible columns"
              subtitle={`${grid.columns.length} selected`}
              active={activeItem === 'columns'}
              onClick={() => setActiveItem('columns')}
            />
            <BuilderNavigatorItem
              icon={<PencilLine className="h-3.5 w-3.5" />}
              label="Editable columns"
              subtitle={`${(grid.editable_columns || []).length} of ${grid.columns.length}`}
              active={activeItem === 'editable'}
              onClick={() => setActiveItem('editable')}
            />
            <BuilderNavigatorItem
              icon={<Settings2 className="h-3.5 w-3.5" />}
              label="Row behaviour"
              subtitle={`Add: ${grid.allow_add_row !== false ? 'on' : 'off'} - Delete: ${
                grid.allow_delete_row !== false ? 'on' : 'off'
              }`}
              active={activeItem === 'behaviour'}
              onClick={() => setActiveItem('behaviour')}
            />
            <BuilderNavigatorItem
              icon={<Rows3 className="h-3.5 w-3.5" />}
              label="Paging and sorting"
              subtitle={`${grid.page_size ?? 100} rows/page${
                grid.default_sort_column ? ` - ${grid.default_sort_column}` : ''
              }`}
              active={activeItem === 'settings'}
              onClick={() => setActiveItem('settings')}
            />
            <BuilderNavigatorItem
              icon={<Plus className="h-3.5 w-3.5" />}
              label="New row defaults"
              subtitle={`${(grid.required_columns || []).length} required - ${
                Object.keys(grid.default_values || {}).length
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
              subtitle={grid.empty_state_message ? 'Custom message' : 'Default message'}
              active={activeItem === 'empty'}
              onClick={() => setActiveItem('empty')}
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
