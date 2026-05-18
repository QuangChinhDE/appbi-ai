'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, ChevronDown, Info, Loader2, Search } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { getFilterTypeForColumn, getDistinctValues, type FilterType } from '@/lib/filters';
import { fetchDatasetModelDistinctValues, modelKeys } from '@/hooks/use-dataset-model';
import { DateInput } from '@/components/ui/DateInput';

// ── Filter type ──────────────────────────────────────────────────────────────
// Operator superset — includes all operators from both classic and new modes.
// explore-utils.applyFilters handles the evaluation.
export interface Filter {
  field: string;
  operator: string; // see OPERATORS_BY_TYPE
  value: any;       // string | number | [lo, hi] | string[]
}

// Threshold: if a text column has ≤ MAX_DROPDOWN_VALS distinct values in the
// sample rows, show a multi-select dropdown instead of a free-text input.
const MAX_DROPDOWN_VALS = 80;

// ── Per-type operator menus ───────────────────────────────────────────────────
const OPERATORS_BY_TYPE: Record<FilterType, { value: string; label: string }[]> = {
  date: [
    { value: 'between',    label: 'Is between' },
    { value: 'gte',        label: 'On or after' },
    { value: 'lte',        label: 'On or before' },
    { value: 'eq',         label: 'Exactly on' },
    { value: 'gt',         label: 'After' },
    { value: 'lt',         label: 'Before' },
    { value: 'is_null',    label: 'Is empty' },
    { value: 'is_not_null',label: 'Is not empty' },
  ],
  number: [
    { value: 'eq',         label: 'Equals' },
    { value: 'neq',        label: 'Not equals' },
    { value: 'between',    label: 'Is between' },
    { value: 'gt',         label: 'Greater than' },
    { value: 'gte',        label: 'Greater or equal' },
    { value: 'lt',         label: 'Less than' },
    { value: 'lte',        label: 'Less or equal' },
    { value: 'is_null',    label: 'Is empty' },
    { value: 'is_not_null',label: 'Is not empty' },
  ],
  text: [
    { value: 'contains',      label: 'Contains' },
    { value: 'eq',            label: 'Equals' },
    { value: 'neq',           label: 'Not equals' },
    { value: 'starts_with',   label: 'Starts with' },
    { value: 'not_contains',  label: 'Does not contain' },
    { value: 'is_null',       label: 'Is empty' },
    { value: 'is_not_null',   label: 'Is not empty' },
  ],
  dropdown: [
    { value: 'in',     label: 'Is any of' },
    { value: 'not_in', label: 'Is not any of' },
    { value: 'eq',     label: 'Is exactly' },
    { value: 'neq',    label: 'Is not' },
    { value: 'is_null',    label: 'Is empty' },
    { value: 'is_not_null',label: 'Is not empty' },
  ],
};

const DEFAULT_OP: Record<FilterType, string> = {
  date:     'between',
  number:   'eq',
  text:     'contains',
  dropdown: 'in',
};

const TYPE_ICON: Record<FilterType, string> = {
  date:     '📅',
  number:   '#',
  text:     'T',
  dropdown: '≡',
};

function defaultValue(colType: FilterType, op: string): any {
  if (op === 'between') return ['', ''];
  if (op === 'in' || op === 'not_in') return [];
  return '';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
interface ColInfo {
  name: string;
  type: string;
  /** Optional friendly label declared on the semantic dimension. When set,
   *  the picker shows this instead of a humanised version of the bare key. */
  label?: string;
  /** Optional view name for qualified `view.field` columns. */
  viewName?: string;
  /** Optional view display label — defaults to humanised viewName. */
  viewLabel?: string;
}

/**
 * Phase-15.21: humanise a column key for picker display. Strips any
 * `view.` qualifier prefix and Title-Cases the bare segment so DA sees
 * "Role Pic Bc" instead of `dataset_table_320.role_pic_bc`. Keeps ALL-
 * CAPS tokens (IDs, ISO codes) unchanged.
 */
function humaniseFieldKey(name: string): string {
  const bare = name.includes('.') ? name.split('.').slice(-1)[0] : name;
  if (!bare) return name;
  const cleaned = bare.replace(/[_-]+/g, ' ').trim();
  if (!cleaned) return bare;
  return cleaned
    .split(/\s+/)
    .map((token) => {
      if (/^[A-Z0-9]{2,}$/.test(token)) return token;
      if (/^id$/i.test(token)) return 'ID';
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join(' ');
}

function resolveViewLabel(col: ColInfo): string {
  if (col.viewLabel?.trim()) return col.viewLabel.trim();
  if (col.viewName?.trim()) return humaniseFieldKey(col.viewName);
  if (col.name.includes('.')) {
    const viewPart = col.name.split('.', 1)[0];
    if (viewPart) return humaniseFieldKey(viewPart);
  }
  return 'Base';
}

function resolveColLabel(col: ColInfo): string {
  if (col.label?.trim()) return col.label.trim();
  return humaniseFieldKey(col.name);
}

/** Resolve UI FilterType for a column, factoring in actual data cardinality. */
function resolveType(col: ColInfo, rows: Record<string, any>[]): FilterType {
  const schemaType = getFilterTypeForColumn(col.type); // 'date' | 'number' | 'dropdown'
  if (schemaType === 'date' || schemaType === 'number') return schemaType;
  // For text/dropdown columns: check actual cardinality from sample data
  if (rows.length > 0) {
    const vals = getDistinctValues(col.name, rows);
    if (vals.length > 0 && vals.length <= MAX_DROPDOWN_VALS) return 'dropdown';
    if (vals.length > MAX_DROPDOWN_VALS) return 'text';
  }
  return schemaType; // 'dropdown' as default when no data yet
}

// ── Props ─────────────────────────────────────────────────────────────────────
interface FilterBuilderProps {
  filters: Filter[];
  onChange: (filters: Filter[]) => void;
  /** Pass columns with type info for smart operator/input selection */
  columns?: ColInfo[];
  /** Sample rows from the table — used to populate dropdown values */
  dataRows?: Record<string, any>[];
  /** Phase-15.21: when set, qualified `view.field` filters fetch distinct
   *  values from the BE semantic engine on dropdown open (instead of
   *  relying on a row-sample lookup that misses cross-table columns). */
  datasetId?: number | null;
  // ── Legacy prop (backward compat) ──────────────────────────────────────────
  availableFields?: string[];
  /** When true, all controls are disabled (view-only mode). */
  readOnly?: boolean;
}

// ── Main component ────────────────────────────────────────────────────────────
export function FilterBuilder({
  filters, onChange, columns, dataRows = [], datasetId, availableFields, readOnly,
}: FilterBuilderProps) {
  // Build column list — prefer columns with type info, fall back to string[]
  const cols: ColInfo[] = useMemo(() => {
    if (columns && columns.length > 0) return columns;
    return (availableFields ?? []).map(f => ({ name: f, type: '' }));
  }, [columns, availableFields]);

  const addFilter = () => {
    if (!cols.length) return;
    const col = cols[0];
    const colType = resolveType(col, dataRows);
    const op = DEFAULT_OP[colType];
    onChange([...filters, { field: col.name, operator: op, value: defaultValue(colType, op) }]);
  };

  const removeFilter = (idx: number) => onChange(filters.filter((_, i) => i !== idx));

  const changeField = (idx: number, fieldName: string) => {
    const col = cols.find(c => c.name === fieldName);
    if (!col) return;
    const colType = resolveType(col, dataRows);
    const op = DEFAULT_OP[colType];
    onChange(filters.map((f, i) => i === idx
      ? { field: fieldName, operator: op, value: defaultValue(colType, op) }
      : f
    ));
  };

  const changeOperator = (idx: number, op: string) => {
    const f = filters[idx];
    const col = cols.find(c => c.name === f.field);
    const colType = col ? resolveType(col, dataRows) : 'text';
    onChange(filters.map((fi, i) => i === idx
      ? { ...fi, operator: op, value: defaultValue(colType as FilterType, op) }
      : fi
    ));
  };

  const changeValue = (idx: number, value: any) =>
    onChange(filters.map((f, i) => i === idx ? { ...f, value } : f));

  return (
    <div className={`space-y-2${readOnly ? ' pointer-events-none opacity-60' : ''}`}>
      {filters.map((filter, idx) => {
        const col = cols.find(c => c.name === filter.field);
        const colType: FilterType = col ? resolveType(col, dataRows) : 'text';
        const ops = OPERATORS_BY_TYPE[colType];
        // Phase-15.21: try local sample first. For qualified `view.field`
        // refs (cross-table after Hướng A) the local rows are keyed by
        // bare column name, so `row[view.field]` returns undefined and
        // the distinct set comes back empty — DA sees "No values in
        // sample data" with no way to pick. FilterRow lazy-fetches from
        // BE in that case (see useDistinctValuesQuery inside FilterRow).
        const distinctVals = (colType === 'dropdown')
          ? getDistinctValues(filter.field, dataRows)
          : [];
        return (
          <FilterRow
            key={idx}
            filter={filter}
            colType={colType}
            operators={ops}
            fieldOptions={cols}
            distinctValues={distinctVals}
            datasetId={datasetId ?? null}
            onChangeField={v => changeField(idx, v)}
            onChangeOperator={v => changeOperator(idx, v)}
            onChangeValue={v => changeValue(idx, v)}
            onRemove={() => removeFilter(idx)}
          />
        );
      })}

      {filters.length === 0 && (
        <span className="group/help relative inline-flex items-center gap-1 text-xs text-text-quaternary italic py-0.5 cursor-default">
          No filters
          <Info className="h-3 w-3 text-text-quaternary transition-colors group-hover/help:text-brand" />
          <span className="pointer-events-none absolute left-0 top-full z-50 mt-1 hidden w-56 rounded-md bg-surface-inverse px-2.5 py-2 text-[11px] font-normal not-italic tracking-normal text-white shadow-lg group-hover/help:block">
            Chart shows all data when no filters are applied.
          </span>
        </span>
      )}

      {!readOnly && (
        <button
          onClick={addFilter}
          disabled={!cols.length}
          className="flex items-center gap-1 text-xs text-warning hover:text-warning font-medium disabled:opacity-40"
        >
          <Plus className="w-3 h-3" /> Add Filter
        </button>
      )}
    </div>
  );
}

// ── FieldPickerLite ──────────────────────────────────────────────────────────
//
// Phase-15.21: replaces the previous plain `<select>` whose `<option>`s
// rendered the raw qualified key (e.g. `dataset_table_320.role_pic_bc`).
// Mirrors the chart-config FieldPicker UX so DA gets the same affordances
// — search input + grouping by view + humanised labels — without the
// chart-config–specific extras (JOIN cue, agg dropdown, declaredMeasureRefs).
//
// Kept inline rather than imported from ExploreChartConfig because that
// picker is wrapped in FieldPickerContext, expects MetricConfig-shaped
// options, and pulls in agg-validity helpers that aren't relevant to a
// filter slot.
function FieldPickerLite({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: ColInfo[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);

  const selected = options.find((o) => o.name === value);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const buckets = new Map<string, { viewLabel: string; items: ColInfo[] }>();
    for (const opt of options) {
      const label = resolveColLabel(opt);
      const viewLabel = resolveViewLabel(opt);
      const viewKey = opt.viewName || (opt.name.includes('.') ? opt.name.split('.', 1)[0] : '__base__');
      if (q) {
        const haystack = `${label} ${opt.name} ${opt.type} ${viewLabel}`.toLowerCase();
        if (!haystack.includes(q)) continue;
      }
      let bucket = buckets.get(viewKey);
      if (!bucket) {
        bucket = { viewLabel, items: [] };
        buckets.set(viewKey, bucket);
      }
      bucket.items.push(opt);
    }
    for (const bucket of buckets.values()) {
      bucket.items.sort((a, b) => resolveColLabel(a).localeCompare(resolveColLabel(b)));
    }
    return Array.from(buckets.values()).sort((a, b) => a.viewLabel.localeCompare(b.viewLabel));
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const totalCount = groups.reduce((sum, g) => sum + g.items.length, 0);

  return (
    <div ref={containerRef} className="relative flex-1 min-w-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setOpen((o) => !o);
          setQuery('');
        }}
        className={`flex w-full items-center justify-between gap-1.5 rounded border bg-surface-1 px-2 py-1 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          open
            ? 'border-brand/40 ring-1 ring-brand/30'
            : 'border-[rgb(var(--border-line))] hover:bg-surface-2'
        }`}
        title={selected?.name}
      >
        <span className="min-w-0 flex-1 truncate">
          {selected ? (
            <>
              <span className="font-medium text-text-secondary">{resolveColLabel(selected)}</span>
              <span className="ml-1.5 text-[10px] text-text-quaternary">· {resolveViewLabel(selected)}</span>
            </>
          ) : (
            <span className="text-text-quaternary">Choose field…</span>
          )}
        </span>
        <ChevronDown className={`h-3 w-3 shrink-0 text-text-quaternary transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-0.5 overflow-hidden rounded-md border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg">
          <div className="border-b border-[rgb(var(--border-line))] p-1.5">
            <div className="flex items-center gap-1.5 rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1">
              <Search className="h-3 w-3 shrink-0 text-text-quaternary" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search fields…"
                className="min-w-0 flex-1 bg-transparent text-xs text-text-secondary outline-none placeholder:text-text-quaternary"
              />
              <span className="text-[10px] text-text-quaternary">
                {totalCount} field{totalCount === 1 ? '' : 's'}
              </span>
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto py-0.5">
            {groups.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs italic text-text-quaternary">
                No fields match
              </div>
            ) : (
              groups.map((group) => (
                <div key={group.viewLabel} className="border-b border-[rgb(var(--border-line))] last:border-b-0">
                  <div className="sticky top-0 z-10 flex items-center justify-between bg-surface-2 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
                    <span className="truncate normal-case tracking-normal">{group.viewLabel}</span>
                    <span className="text-text-quaternary">{group.items.length}</span>
                  </div>
                  {group.items.map((opt) => {
                    const active = opt.name === value;
                    return (
                      <button
                        key={opt.name}
                        type="button"
                        onClick={() => {
                          onChange(opt.name);
                          setOpen(false);
                        }}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left transition-colors ${
                          active ? 'bg-brand/10' : 'hover:bg-surface-2'
                        }`}
                        title={opt.name}
                      >
                        <span className={`min-w-0 flex-1 truncate text-xs font-medium ${active ? 'text-brand' : 'text-text-secondary'}`}>
                          {resolveColLabel(opt)}
                        </span>
                        <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-quaternary">
                          {opt.type || 'field'}
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

// ── FilterRow ─────────────────────────────────────────────────────────────────
interface FilterRowProps {
  filter: Filter;
  colType: FilterType;
  operators: { value: string; label: string }[];
  fieldOptions: ColInfo[];
  distinctValues: string[];
  datasetId: number | null;
  onChangeField: (v: string) => void;
  onChangeOperator: (v: string) => void;
  onChangeValue: (v: any) => void;
  onRemove: () => void;
}

function FilterRow({
  filter, colType, operators, fieldOptions, distinctValues,
  datasetId,
  onChangeField, onChangeOperator, onChangeValue, onRemove,
}: FilterRowProps) {
  const [dropOpen, setDropOpen] = useState(false);
  const selectedVals: string[] = Array.isArray(filter.value) ? filter.value : [];

  // Phase-15.21: lazy-fetch distinct values from the BE semantic engine
  // when (a) the local sample-derived list is empty, (b) the field is a
  // qualified `view.field` ref (the case that breaks the row-sample
  // lookup — cross-table columns aren't in single-table preview rows),
  // and (c) DA has actually opened the dropdown. `useQuery` caches the
  // result keyed by (datasetId, field) so repeated opens are free.
  const isQualifiedField = filter.field.includes('.');
  const shouldFetchRemote = Boolean(
    datasetId
    && isQualifiedField
    && colType === 'dropdown'
    && (filter.operator === 'in' || filter.operator === 'not_in')
    && distinctValues.length === 0
    && dropOpen,
  );
  const remoteDistinctQuery = useQuery({
    queryKey: datasetId
      ? [...modelKeys.distinct(datasetId, filter.field)]
      : ['filter-builder-disabled-distinct-query'],
    queryFn: () => fetchDatasetModelDistinctValues(datasetId!, filter.field, 200),
    enabled: shouldFetchRemote,
    staleTime: 5 * 60 * 1000,
  });
  const remoteDistinctValues = remoteDistinctQuery.data?.values ?? [];
  const effectiveDistinctValues = distinctValues.length > 0
    ? distinctValues
    : remoteDistinctValues;

  const toggleVal = (v: string) => {
    const next = selectedVals.includes(v)
      ? selectedVals.filter(x => x !== v)
      : [...selectedVals, v];
    onChangeValue(next);
  };

  return (
    <div className="bg-surface-2 rounded-lg border border-[rgb(var(--border-line))] p-2.5 space-y-2">

      {/* Field + type badge + remove */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-text-quaternary w-4 text-center flex-shrink-0" title={colType}>
          {TYPE_ICON[colType]}
        </span>
        <FieldPickerLite
          value={filter.field}
          options={fieldOptions}
          onChange={onChangeField}
        />
        <button onClick={onRemove} title="Remove filter"
          className="p-0.5 text-text-quaternary hover:text-danger flex-shrink-0">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Operator */}
      <select
        value={filter.operator}
        onChange={e => onChangeOperator(e.target.value)}
        className="w-full px-2 py-1 border border-[rgb(var(--border-line))] rounded text-xs bg-surface-1 focus:ring-1 focus:ring-brand focus:border-brand/50 outline-none"
      >
        {operators.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {/* Null operators take no value input */}
      {(filter.operator === 'is_null' || filter.operator === 'is_not_null') ? null : (
      <>

      {/* ── DATE inputs ─────────────────────────────────────────────────────── */}
      {colType === 'date' && filter.operator === 'between' && (
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <p className="text-[10px] text-text-quaternary mb-0.5">From date</p>
            <DateInput
              value={Array.isArray(filter.value) ? filter.value[0] ?? '' : ''}
              onChange={d => onChangeValue([d, Array.isArray(filter.value) ? filter.value[1] ?? '' : ''])}
            />
          </div>
          <div>
            <p className="text-[10px] text-text-quaternary mb-0.5">To date</p>
            <DateInput
              value={Array.isArray(filter.value) ? filter.value[1] ?? '' : ''}
              onChange={d => onChangeValue([Array.isArray(filter.value) ? filter.value[0] ?? '' : '', d])}
            />
          </div>
        </div>
      )}
      {colType === 'date' && filter.operator !== 'between' && (
        <DateInput
          value={typeof filter.value === 'string' ? filter.value : ''}
          onChange={d => onChangeValue(d)}
        />
      )}

      {/* ── NUMBER inputs ────────────────────────────────────────────────────── */}
      {colType === 'number' && filter.operator === 'between' && (
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <p className="text-[10px] text-text-quaternary mb-0.5">Min</p>
            <input type="number"
              value={Array.isArray(filter.value) ? filter.value[0] ?? '' : ''}
              onChange={e => onChangeValue([e.target.value, Array.isArray(filter.value) ? filter.value[1] ?? '' : ''])}
              className="w-full px-2 py-1 border border-[rgb(var(--border-line))] rounded text-xs bg-surface-1 focus:ring-1 focus:ring-brand outline-none"
            />
          </div>
          <div>
            <p className="text-[10px] text-text-quaternary mb-0.5">Max</p>
            <input type="number"
              value={Array.isArray(filter.value) ? filter.value[1] ?? '' : ''}
              onChange={e => onChangeValue([Array.isArray(filter.value) ? filter.value[0] ?? '' : '', e.target.value])}
              className="w-full px-2 py-1 border border-[rgb(var(--border-line))] rounded text-xs bg-surface-1 focus:ring-1 focus:ring-brand outline-none"
            />
          </div>
        </div>
      )}
      {colType === 'number' && filter.operator !== 'between' && (
        <input type="number"
          value={filter.value ?? ''}
          onChange={e => onChangeValue(e.target.value === '' ? '' : Number(e.target.value))}
          placeholder="Enter number…"
          className="w-full px-2 py-1 border border-[rgb(var(--border-line))] rounded text-xs bg-surface-1 focus:ring-1 focus:ring-brand outline-none"
        />
      )}

      {/* ── TEXT input ───────────────────────────────────────────────────────── */}
      {colType === 'text' && (
        <input type="text"
          value={typeof filter.value === 'string' ? filter.value : ''}
          onChange={e => onChangeValue(e.target.value)}
          placeholder="Enter value…"
          className="w-full px-2 py-1 border border-[rgb(var(--border-line))] rounded text-xs bg-surface-1 focus:ring-1 focus:ring-brand outline-none"
        />
      )}

      {/* ── DROPDOWN multi-select ─────────────────────────────────────────────── */}
      {colType === 'dropdown' && (filter.operator === 'in' || filter.operator === 'not_in') && (
        <div className="relative">
          <button type="button" onClick={() => setDropOpen(o => !o)}
            className="w-full flex items-center justify-between px-2 py-1 border border-[rgb(var(--border-line))] rounded text-xs bg-surface-1 focus:ring-1 focus:ring-brand outline-none"
          >
            <span className={selectedVals.length === 0 ? 'text-text-quaternary' : 'text-text-secondary'}>
              {selectedVals.length === 0
                ? 'Choose values…'
                : selectedVals.length === 1
                  ? selectedVals[0]
                  : `${selectedVals.length} selected`}
            </span>
            <ChevronDown className={`w-3 h-3 text-text-quaternary transition-transform ${dropOpen ? 'rotate-180' : ''}`} />
          </button>
          {dropOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setDropOpen(false)} />
              <div className="absolute left-0 right-0 top-full mt-0.5 z-20 bg-surface-1 border border-[rgb(var(--border-line))] rounded-md shadow-linear-lg max-h-48 overflow-y-auto">
                {/* Phase-15.21: when the local row-sample lookup came up
                    empty for a qualified field, the BE query is in flight
                    — surface the loading state so DA isn't staring at
                    "No values" while waiting. */}
                {shouldFetchRemote && remoteDistinctQuery.isLoading ? (
                  <div className="flex items-center gap-1.5 px-3 py-2 text-xs italic text-text-quaternary">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Loading distinct values from semantic engine…
                  </div>
                ) : shouldFetchRemote && remoteDistinctQuery.isError ? (
                  <p className="px-3 py-2 text-xs italic text-danger">
                    Could not load distinct values. Check that the field is reachable from the chart's base view.
                  </p>
                ) : effectiveDistinctValues.length === 0 ? (
                  <p className="text-xs text-text-quaternary px-3 py-2 italic">No values in sample data</p>
                ) : (
                  effectiveDistinctValues.map(v => (
                    <label key={v}
                      className={`flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-xs hover:bg-surface-2 ${selectedVals.includes(v) ? 'bg-brand/10 text-brand' : 'text-text-secondary'}`}
                    >
                      <input type="checkbox" checked={selectedVals.includes(v)} onChange={() => toggleVal(v)}
                        className="w-3.5 h-3.5 rounded border-[rgb(var(--border-strong))] text-brand focus:ring-brand focus:ring-1" />
                      <span className="truncate">{v || '(empty)'}</span>
                    </label>
                  ))
                )}
              </div>
            </>
          )}
          {selectedVals.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {selectedVals.map(v => (
                <span key={v}
                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-brand/15 text-brand text-[10px] rounded-full"
                >
                  {v}
                  <button onClick={() => toggleVal(v)} className="hover:text-brand ml-0.5">×</button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {colType === 'dropdown' && filter.operator !== 'in' && filter.operator !== 'not_in' && (
        distinctValues.length > 0
          ? (
            <select value={typeof filter.value === 'string' ? filter.value : ''}
              onChange={e => onChangeValue(e.target.value)}
              className="w-full px-2 py-1 border border-[rgb(var(--border-line))] rounded text-xs bg-surface-1 focus:ring-1 focus:ring-brand outline-none"
            >
              <option value="">— select value —</option>
              {distinctValues.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          )
          : (
            <input type="text" value={typeof filter.value === 'string' ? filter.value : ''}
              onChange={e => onChangeValue(e.target.value)}
              placeholder="Enter value…"
              className="w-full px-2 py-1 border border-[rgb(var(--border-line))] rounded text-xs bg-surface-1 focus:ring-1 focus:ring-brand outline-none"
            />
          )
      )}
      </>
      )}
    </div>
  );
}
