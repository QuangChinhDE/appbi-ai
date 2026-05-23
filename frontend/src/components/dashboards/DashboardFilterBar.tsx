'use client';

import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Plus, X, Filter, ChevronDown, ChevronRight, Search, Link2, Check, RotateCcw, Calendar, Pencil, ToggleLeft, ToggleRight } from 'lucide-react';
import {
  BaseFilter,
  FilterOperator,
  FilterType,
  DatePreset,
  DATE_PRESET_LABELS,
  computeDatePresetRange,
  ColumnInfo,
  getColumnContextLabel,
  getColumnDisplayLabel,
  getColumnGroupLabel,
  getColumnKey,
  getFilterDisplayLabel,
  getFilterKey,
  isFilterValueActive,
} from '@/lib/filters';
import { DateInput } from '@/components/ui/DateInput';

// ─── Type badge helpers ────────────────────────────────────────
const TYPE_BADGE: Record<FilterType, string> = { text: 'T', number: '#', date: 'D', dropdown: '=' };
const TYPE_CLR: Record<FilterType, string> = {
  text:     'text-sky-500',
  number:   'text-brand',
  date:     'text-teal-500',
  dropdown: 'text-text-tertiary',
};
// Pill-style badge (replaces cramped monospace single-char). Used in card
// headers + linked-field rows. Dropdown rows keep the compact char.
const TYPE_PILL: Record<FilterType, string> = {
  text:     'bg-sky-50 text-sky-600 ring-1 ring-sky-100',
  number:   'bg-brand-soft text-brand ring-1 ring-brand/15',
  date:     'bg-teal-50 text-teal-600 ring-1 ring-teal-100',
  dropdown: 'bg-surface-2 text-text-tertiary ring-1 ring-[rgb(var(--border-line))]',
};
const TYPE_LABEL: Record<FilterType, string> = {
  text:     'Text',
  number:   'Num',
  date:     'Date',
  dropdown: 'List',
};

interface DashboardFilterBarProps {
  columns: ColumnInfo[];
  columnChartCount: Map<string, number>;
  /** Distinct values per column, keyed by stable column key */
  distinctValues: Record<string, string[]>;
  filters: BaseFilter[];
  onFiltersChange: (filters: BaseFilter[]) => void;
  hasPendingChanges?: boolean;
  onApply?: () => void;
  onReset?: () => void;
  isApplying?: boolean;
  initialExpanded?: boolean;
  /** When true, strips the outer card wrapper — use when embedded inside another card. */
  embedded?: boolean;
  /** Slicer mode (Looker/PowerBI parity): DA defines the slot inventory, viewer
   * can only change values within those slots. Hides Add Filter / per-card Remove
   * / Clear-all controls. Used on public-link viewer page. */
  lockSlots?: boolean;
}

type AddFilterColumnGroup = {
  key: string;
  label: string;
  columns: ColumnInfo[];
};

export function DashboardFilterBar({
  columns,
  columnChartCount,
  distinctValues,
  filters,
  onFiltersChange,
  hasPendingChanges = false,
  onApply,
  onReset,
  isApplying = false,
  initialExpanded = true,
  embedded = false,
  lockSlots = false,
}: DashboardFilterBarProps) {
  const [isExpanded, setIsExpanded] = useState(initialExpanded);
  const [addingField, setAddingField] = useState(false);
  const [addFilterSearch, setAddFilterSearch] = useState('');
  const [searchTerms, setSearchTerms] = useState<Record<string, string>>({});
  const addFilterSearchRef = useRef<HTMLInputElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; right: number } | null>(null);

  // Compute fixed position when dropdown opens so it escapes overflow-hidden parents
  useEffect(() => {
    if (addingField && addButtonRef.current) {
      const rect = addButtonRef.current.getBoundingClientRect();
      setDropdownPos({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    }
  }, [addingField]);

  // Auto-focus search input whenever the dropdown opens
  useEffect(() => {
    if (addingField) {
      // Short timeout so the DOM element is mounted before we focus
      const t = setTimeout(() => addFilterSearchRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [addingField]);

  // How many filters have a non-empty value?
  const activeCount = filters.filter(isFilterValueActive).length;

  // Set of all fields currently used by filters (primary only)
  const usedFields = useMemo(
    () => new Set(filters.map(f => getFilterKey(f))),
    [filters],
  );

  // Columns not yet added as filters
  const availableColumns = useMemo(
    () => columns.filter(c => !usedFields.has(getColumnKey(c))),
    [columns, usedFields],
  );

  const normalizedAddFilterSearch = addFilterSearch.trim().toLowerCase();

  // A column is offerable as a dashboard filter when at least one chart in
  // the dashboard can apply it. Charts that don't reach the field are simply
  // skipped at query time. Date columns are always offered (legacy auto-link
  // behavior for non-semantic date fields still applies).
  const addableColumns = useMemo(
    () => availableColumns.filter((column) =>
      column.type === 'date' || (column.chartCoverage ?? 0) > 0,
    ),
    [availableColumns],
  );

  const matchingAvailableColumns = useMemo(
    () => addableColumns.filter((column) => {
      if (!normalizedAddFilterSearch) return true;
      const haystack = [
        getColumnDisplayLabel(column),
        getColumnGroupLabel(column),
        column.name,
        column.semanticField,
      ]
        .filter((value): value is string => Boolean(value))
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalizedAddFilterSearch);
    }),
    [addableColumns, normalizedAddFilterSearch],
  );

  const groupColumnsByTable = (sourceColumns: ColumnInfo[]): AddFilterColumnGroup[] => {
    const groups = new Map<string, AddFilterColumnGroup>();
    for (const column of sourceColumns) {
      const semanticView = String(column.semanticField ?? '').split('.')[0]?.trim();
      const label = getColumnGroupLabel(column);
      const key = `${column.datasetId ?? 'global'}:${semanticView || label}`;
      const existing = groups.get(key);
      if (existing) {
        existing.columns.push(column);
      } else {
        groups.set(key, { key, label, columns: [column] });
      }
    }
    return Array.from(groups.values());
  };

  // ── Mutators ───────────────────────────────────────────────────
  const addFilter = (columnKey: string, preset?: DatePreset) => {
    const col = columns.find(c => getColumnKey(c) === columnKey);
    if (!col) return;
    if (usedFields.has(columnKey)) return;

    const isMultiSelect = col.type === 'text' || col.type === 'dropdown';

    let linkedFields = col.defaultLinkedFields ? [...col.defaultLinkedFields] : undefined;

    // Auto-link legacy non-semantic date columns when no explicit linked targets are provided.
    if (!linkedFields?.length && col.type === 'date' && !col.semanticField) {
      linkedFields = columns
        .filter(c => c.type === 'date' && getColumnKey(c) !== columnKey && !usedFields.has(getColumnKey(c)))
        .map(c => getColumnKey(c));
      if (!linkedFields.length) linkedFields = undefined;
    }

    const datePreset = col.type === 'date' ? (preset ?? 'this_month') : undefined;
    const dateValue = datePreset && datePreset !== 'custom' ? computeDatePresetRange(datePreset) : ['', ''];

    const newFilter: BaseFilter = {
      id:           `gf-${Date.now()}`,
      field:        col.name,
      fieldKey:     columnKey,
      semanticField: col.semanticField,
      datasetId:    col.datasetId,
      linkedFields,
      type:         col.type,
      operator:     isMultiSelect ? 'in' : col.type === 'date' ? 'between' : 'gte',
      value:        isMultiSelect ? [] : col.type === 'date' ? dateValue : '',
      label:        getColumnDisplayLabel(col),
      datePreset,
    };
    onFiltersChange([...filters, newFilter]);
    setAddingField(false);
    setAddFilterSearch('');
    setIsExpanded(true);
  };

  const removeFilter = (id: string) => {
    onFiltersChange(filters.filter(f => f.id !== id));
    setSearchTerms(prev => { const n = { ...prev }; delete n[id]; return n; });
  };

  const clearFilter = (id: string) => {
    onFiltersChange(filters.map(f => {
      if (f.id !== id) return f;
      if (f.operator === 'in' || f.operator === 'not_in') return { ...f, value: [] };
      if (f.operator === 'between') return { ...f, value: ['', ''] };
      return { ...f, value: '' };
    }));
  };

  const toggleValue = (filterId: string, val: string) => {
    onFiltersChange(filters.map(f => {
      if (f.id !== filterId) return f;
      const cur: string[] = Array.isArray(f.value) ? f.value : [];
      return { ...f, value: cur.includes(val) ? cur.filter(v => v !== val) : [...cur, val] };
    }));
  };

  const selectAll = (filterId: string, vals: string[]) =>
    onFiltersChange(filters.map(f => f.id === filterId ? { ...f, value: [...vals] } : f));

  const deselectAll = (filterId: string) =>
    onFiltersChange(filters.map(f => f.id === filterId ? { ...f, value: [] } : f));

  const updateValue = (filterId: string, value: any) =>
    onFiltersChange(filters.map(f => f.id === filterId ? { ...f, value, datePreset: f.type === 'date' ? 'custom' : f.datePreset } : f));

  const updateDatePreset = (filterId: string, preset: DatePreset) =>
    onFiltersChange(filters.map(f => {
      if (f.id !== filterId) return f;
      if (preset === 'custom') return { ...f, datePreset: 'custom' };
      return { ...f, datePreset: preset, operator: 'between' as FilterOperator, value: computeDatePresetRange(preset) };
    }));

  const updateOperator = (filterId: string, operator: FilterOperator) =>
    onFiltersChange(filters.map(f => {
      if (f.id !== filterId) return f;
      if (operator === 'between') return { ...f, operator, value: ['', ''] };
      if (operator === 'in' || operator === 'not_in') return { ...f, operator, value: [] };
      return { ...f, operator, value: '' };
    }));

  // Phase-15.78 — user-editable label. BaseFilter.label already takes
  // priority in getFilterDisplayLabel; this just exposes the UI to set
  // it. Empty/whitespace clears the override so the auto-derived label
  // (semantic measure name → friendly field name → raw column) comes
  // back.
  const updateLabel = (filterId: string, label: string) =>
    onFiltersChange(filters.map(f => {
      if (f.id !== filterId) return f;
      const next = label.trim();
      return { ...f, label: next || undefined };
    }));

  // Phase-15.78 — toggle dropdown mode (multi vs single). Operator is
  // the source of truth: `in` = multi, `eq` = single. Switching modes
  // coerces the value: array → first element when going single, scalar
  // → [scalar] when going multi. Same field, same dataset, different
  // affordance — slicers without a multi-select count box are the
  // PowerBI default.
  const switchDropdownMode = (filterId: string, mode: 'multi' | 'single') =>
    onFiltersChange(filters.map(f => {
      if (f.id !== filterId) return f;
      const isCurrentlyMulti = f.operator === 'in' || f.operator === 'not_in';
      const wantsMulti = mode === 'multi';
      if (isCurrentlyMulti === wantsMulti) return f;
      if (wantsMulti) {
        const cur = typeof f.value === 'string' && f.value !== '' ? [f.value] : [];
        return { ...f, operator: 'in' as FilterOperator, value: cur };
      }
      const first = Array.isArray(f.value) && f.value.length > 0 ? String(f.value[0]) : '';
      return { ...f, operator: 'eq' as FilterOperator, value: first };
    }));

  const toggleLinkedField = (filterId: string, columnName: string) => {
    onFiltersChange(filters.map(f => {
      if (f.id !== filterId) return f;
      const current = f.linkedFields ?? [];
      const next = current.includes(columnName)
        ? current.filter(n => n !== columnName)
        : [...current, columnName];
      return { ...f, linkedFields: next.length ? next : undefined };
    }));
  };

  // Compute total chart coverage per filter (primary + linked fields)
  const getFilterChartCount = (f: BaseFilter): number => {
    const fields = [getFilterKey(f), ...(f.linkedFields ?? [])];
    const primaryColumn = columns.find((column) => getColumnKey(column) === getFilterKey(f));
    let total = 0;
    for (const field of fields) {
      total += columnChartCount.get(field) ?? 0;
    }
    const maxPossible = primaryColumn?.datasetChartCount ?? Math.max(...Array.from(columnChartCount.values()), 0);
    return Math.min(total, maxPossible || total);
  };

  const getCoverageLabel = (column: ColumnInfo) => {
    const covered = column.chartCoverage ?? columnChartCount.get(getColumnKey(column)) ?? 0;
    if (column.datasetChartCount && column.datasetChartCount > 0) {
      return `${covered}/${column.datasetChartCount} charts`;
    }
    return `${covered} chart${covered !== 1 ? 's' : ''}`;
  };

  const renderColumnOption = (column: ColumnInfo) => {
    const columnKey = getColumnKey(column);
    const label = getColumnDisplayLabel(column);
    const sameTypeCount = column.type === 'date' && !column.semanticField
      ? columns.filter(c => c.type === 'date' && getColumnKey(c) !== columnKey && !usedFields.has(getColumnKey(c))).length
      : 0;

    return (
      <button
        key={columnKey}
        onClick={() => addFilter(columnKey)}
        title={column.semanticField ?? column.key ?? column.name}
        className="w-full text-left px-3 py-2 text-sm hover:bg-brand/15 flex items-center justify-between gap-3 group"
      >
        <span className="flex items-start gap-2 min-w-0">
          <span className={`text-xs font-mono w-4 text-center ${TYPE_CLR[column.type]}`}>
            {TYPE_BADGE[column.type]}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-text-secondary group-hover:text-brand">{label}</span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {sameTypeCount > 0 && (
            <span className="flex items-center gap-0.5 text-xs text-teal-500" title={`Will auto-link ${sameTypeCount} other date column(s)`}>
              <Link2 className="w-3 h-3" />
              +{sameTypeCount}
            </span>
          )}
          <span className="text-xs text-text-quaternary">
            {getCoverageLabel(column)}
          </span>
        </span>
      </button>
    );
  };

  const renderColumnGroups = (groups: AddFilterColumnGroup[]) => (
    <>
      {groups.map((group) => (
        <div key={group.key} className="py-1">
          <div className="sticky top-[49px] z-10 border-y border-[rgb(var(--border-line))] bg-surface-2/95 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary backdrop-blur">
            {group.label}
          </div>
          {group.columns.map(renderColumnOption)}
        </div>
      ))}
    </>
  );

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div className={embedded ? 'border-t border-[rgba(255,255,255,0.06)]' : 'mb-4 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm'}>
      {/* ── Header bar ────────────────────────────────────────────── */}
      <div className={`flex items-center gap-2 ${embedded ? 'px-3 py-1.5' : 'px-4 py-2.5'}`}>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary"
        >
          <Filter className="w-4 h-4 text-brand" />
          <span>Filters</span>
          {activeCount > 0 && (
            <span className="px-1.5 py-0.5 bg-brand/15 text-brand text-xs rounded-full font-semibold">
              {activeCount}
            </span>
          )}
          {isExpanded
            ? <ChevronDown className="w-3.5 h-3.5 text-text-quaternary" />
            : <ChevronRight className="w-3.5 h-3.5 text-text-quaternary" />}
        </button>

        {hasPendingChanges && (
          // Phase-15.78 — make pending-changes signal louder. Tester
          // reported users tweak a filter and walk away thinking it
          // applied. Pulse + amber stripe + explicit "unapplied" wording
          // catches the eye without blocking other dashboard controls.
          <span
            className="inline-flex items-center gap-1 rounded-full border-2 border-amber-400 bg-amber-100 px-2.5 py-0.5 text-[11px] font-semibold text-amber-900 shadow-sm animate-pulse"
            title="You have filter changes that haven't been applied yet. Click Apply to update the dashboard."
          >
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
            Unapplied changes
          </span>
        )}

        {/* Collapsed summary chips */}
        {!isExpanded && activeCount > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap flex-1 ml-2">
            {filters
              .filter(isFilterValueActive)
              .map(f => (
                <span
                  key={f.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-brand/10 border border-brand/30 text-brand text-xs rounded-full"
                >
                  <span className="font-semibold">{getFilterDisplayLabel(f)}</span>
                  {f.datePreset && f.datePreset !== 'custom' && (
                    <span className="opacity-70">{DATE_PRESET_LABELS[f.datePreset]}</span>
                  )}
                  {f.linkedFields && f.linkedFields.length > 0 && (
                    <Link2 className="w-3 h-3 text-brand" />
                  )}
                  {Array.isArray(f.value) && f.value.length > 0 && (
                    <span className="opacity-70">({f.value.length})</span>
                  )}
                </span>
              ))}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {hasPendingChanges && onReset && (
            <button
              onClick={onReset}
              className="inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-line))] px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-surface-2"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          )}

          {onApply && (
            <button
              onClick={onApply}
              disabled={!hasPendingChanges || isApplying}
              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-white transition-shadow disabled:cursor-not-allowed disabled:bg-brand/40 ${
                hasPendingChanges && !isApplying
                  ? 'bg-brand hover:bg-brand-hover ring-2 ring-brand/30 ring-offset-1 shadow-md'
                  : 'bg-brand hover:bg-brand-hover'
              }`}
            >
              <Check className="h-3 w-3" />
              {isApplying ? 'Applying...' : 'Apply'}
            </button>
          )}

          {!lockSlots && filters.length > 0 && (
            <button
              onClick={() => onFiltersChange([])}
              className="text-xs text-text-quaternary hover:text-danger transition-colors"
            >
              Clear all
            </button>
          )}

          {/* Add filter dropdown */}
          {!lockSlots && (
          <div className="relative">
            <button
              ref={addButtonRef}
              onClick={() => {
                const next = !addingField;
                setAddingField(next);
                if (!next) {
                  setAddFilterSearch('');
                }
              }}
              disabled={addableColumns.length === 0}
              title={addableColumns.length === 0 ? 'No dashboard filter fields available' : undefined}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-brand border border-brand/40 rounded-md hover:bg-brand/15 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Plus className="w-3 h-3" />
              Add Filter
            </button>

            {addingField && addableColumns.length > 0 && (
              <>
                <div className="fixed inset-0 z-[9998]" onClick={() => {
                  setAddingField(false);
                  setAddFilterSearch('');
                }} />
                <div
                  className="fixed z-[9999] max-h-[min(32rem,70vh)] w-96 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg"
                  style={dropdownPos ? { top: dropdownPos.top, right: dropdownPos.right } : { top: 0, right: 0 }}
                >
                  {/* Search — always visible, auto-focused */}
                  <div className="sticky top-0 z-20 border-b border-[rgb(var(--border-line))] bg-surface-1 p-2">
                    <div className="relative">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-quaternary" />
                      <input
                        ref={addFilterSearchRef}
                        type="text"
                        value={addFilterSearch}
                        onChange={(e) => setAddFilterSearch(e.target.value)}
                        placeholder="Search table or field..."
                        className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 py-1.5 pl-7 pr-2 text-xs outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand"
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            setAddingField(false);
                            setAddFilterSearch('');
                          } else if (e.key === 'Enter' && matchingAvailableColumns.length > 0) {
                            addFilter(getColumnKey(matchingAvailableColumns[0]));
                          }
                        }}
                      />
                    </div>
                  </div>

                  {/* ── Date filter section ─────────────────────────── */}
                  {(() => {
                    const dateColumns = matchingAvailableColumns.filter(c => c.type === 'date');
                    const fieldColumns = matchingAvailableColumns.filter(c => c.type !== 'date');
                    const dateGroups = groupColumnsByTable(dateColumns);
                    const fieldGroups = groupColumnsByTable(fieldColumns);
                    return (
                      <>
                        {dateColumns.length > 0 && (
                          <div className="py-1 border-b border-[rgb(var(--border-line))]">
                            <div className="px-3 py-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-teal-600">
                              <Calendar className="w-3 h-3" />
                              Date filters
                            </div>
                            {renderColumnGroups(dateGroups)}
                          </div>
                        )}
                        {fieldColumns.length > 0 && (
                          <div className="py-1">
                            <div className="px-3 py-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-quaternary">
                              <Filter className="w-3 h-3" />
                              Field filters
                            </div>
                            {renderColumnGroups(fieldGroups)}
                          </div>
                        )}
                      </>
                    );
                  })()}

                  {matchingAvailableColumns.length === 0 && (
                    addableColumns.length === 0 ? (
                      <div className="px-3 py-3 text-xs text-text-quaternary">
                        <p className="font-medium text-text-tertiary">No dashboard filter fields available.</p>
                        <p className="mt-1">Use chart-level filters for fields that only affect individual charts.</p>
                      </div>
                    ) : (
                      <p className="px-3 py-3 text-xs text-text-quaternary italic">
                        No matching shared fields
                      </p>
                    )
                  )}
                </div>
              </>
            )}
          </div>
          )}
        </div>
      </div>

      {/* ── Filter cards ──────────────────────────────────────────── */}
      {isExpanded && filters.length > 0 && (
        <div className="px-3 pb-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {filters.map(f => {
            // Conflict-detection signal: when the user picks values that have
            // no intersection (e.g. Role=SDR & Phòng=BE.E), the cascading
            // distinct query returns []. Surfacing the names of the other
            // active filters here lets the user know which combo is empty
            // instead of silently rendering "Loading values…".
            const otherActiveFilters = filters.filter(
              (other) => other.id !== f.id && isFilterValueActive(other),
            );
            return (
              <FilterCard
                key={f.id}
                filter={f}
                allColumns={columns}
                allDistinctValues={distinctValues}
                usedFields={usedFields}
                columnChartCount={columnChartCount}
                filterChartCount={getFilterChartCount(f)}
                search={searchTerms[f.id] ?? ''}
                onSearchChange={s => setSearchTerms(prev => ({ ...prev, [f.id]: s }))}
                onToggleValue={val => toggleValue(f.id, val)}
                onSelectAll={vals => selectAll(f.id, vals)}
                onDeselectAll={() => deselectAll(f.id)}
                onUpdateValue={v => updateValue(f.id, v)}
                onUpdateOperator={op => updateOperator(f.id, op)}
                onUpdateDatePreset={preset => updateDatePreset(f.id, preset)}
                onToggleLinkedField={col => toggleLinkedField(f.id, col)}
                onUpdateLabel={l => updateLabel(f.id, l)}
                onSwitchDropdownMode={m => switchDropdownMode(f.id, m)}
                onClear={() => clearFilter(f.id)}
                onRemove={() => removeFilter(f.id)}
                conflictingFilterLabels={otherActiveFilters.map((other) => getFilterDisplayLabel(other))}
                lockSlots={lockSlots}
              />
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {isExpanded && filters.length === 0 && (
        <div className="px-4 py-5 text-center border-t border-[rgb(var(--border-line))]">
          {addableColumns.length > 0 ? (
            <p className="text-sm text-text-quaternary">
              No filters added. Click <strong>Add Filter</strong> to filter all charts in this dashboard.
            </p>
          ) : (
            <p className="text-sm text-text-quaternary">
              No shared dashboard filters are available here. Use chart-level filters for chart-specific analysis.
            </p>
          )}
          {columns.filter(c => c.type === 'date').length > 1 && (
            <p className="text-xs text-teal-500 mt-1">
              <Link2 className="w-3 h-3 inline mr-1" />
              Tip: Adding a date filter will auto-link all date columns across charts.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Individual filter card with cross-chart linking
// ═══════════════════════════════════════════════════════════════════
interface FilterCardProps {
  filter: BaseFilter;
  allColumns: ColumnInfo[];
  allDistinctValues: Record<string, string[]>;
  usedFields: Set<string>;
  columnChartCount: Map<string, number>;
  filterChartCount: number;
  search: string;
  onSearchChange: (s: string) => void;
  onToggleValue: (val: string) => void;
  onSelectAll: (vals: string[]) => void;
  onDeselectAll: () => void;
  onUpdateValue: (value: any) => void;
  onUpdateOperator: (op: FilterOperator) => void;
  onUpdateDatePreset: (preset: DatePreset) => void;
  onToggleLinkedField: (columnName: string) => void;
  /** Phase-15.78: persist a user-friendly label override. */
  onUpdateLabel: (label: string) => void;
  /** Phase-15.78: switch dropdown filters between multi (`in`) and single (`eq`). */
  onSwitchDropdownMode: (mode: 'multi' | 'single') => void;
  onClear: () => void;
  onRemove: () => void;
  /** Labels of other filters currently constraining the distinct-values query
   * for this card. Used to render a conflict banner when the cascading
   * dropdown returns no values. */
  conflictingFilterLabels?: string[];
  /** Slicer-mode flag from parent: hides per-card remove (X) button. */
  lockSlots?: boolean;
}

function FilterCard({
  filter: f,
  allColumns,
  allDistinctValues,
  usedFields,
  columnChartCount,
  filterChartCount,
  search,
  onSearchChange,
  onToggleValue,
  onSelectAll,
  onDeselectAll,
  onUpdateValue,
  onUpdateOperator,
  onUpdateDatePreset,
  onToggleLinkedField,
  onUpdateLabel,
  onSwitchDropdownMode,
  onClear,
  onRemove,
  conflictingFilterLabels,
  lockSlots = false,
}: FilterCardProps) {
  const [showLinked, setShowLinked] = useState(false);
  const [isEditingLabel, setIsEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(f.label ?? '');

  const isMultiSelect = f.operator === 'in' || f.operator === 'not_in';
  const selected: string[] = isMultiSelect && Array.isArray(f.value) ? f.value : [];
  const hasValue = isFilterValueActive(f);
  // text + dropdown-typed filters can toggle multi/single (number/date keep
  // their operator-driven UI). String fields are the common slicer case.
  const supportsDropdownModeToggle = f.type === 'dropdown' || f.type === 'text';

  // Columns of the same type that could be linked (not the primary, not used as separate filters)
  const linkableColumns = useMemo(
    () => (
      f.semanticField
        ? []
        : allColumns.filter(c =>
            !c.semanticField &&
            c.type === f.type &&
            getColumnKey(c) !== getFilterKey(f) &&
            !usedFields.has(getColumnKey(c))
          )
    ),
    [allColumns, f, usedFields],
  );

  // Merge distinct values from primary + linked fields
  const mergedValues = useMemo(() => {
    const primary = allDistinctValues[getFilterKey(f)] ?? [];
    if (!f.linkedFields?.length) return primary;
    const set = new Set(primary);
    f.linkedFields.forEach(lf => {
      (allDistinctValues[lf] ?? []).forEach(v => set.add(v));
    });
    return Array.from(set).sort();
  }, [f, allDistinctValues]);

  const filteredValues = useMemo(() => {
    if (!search) return mergedValues;
    const q = search.toLowerCase();
    return mergedValues.filter(v => v.toLowerCase().includes(q));
  }, [mergedValues, search]);

  const linkedCount = f.linkedFields?.length ?? 0;
  const hasLinkableColumns = linkableColumns.length > 0;
  const primaryColumn = useMemo(
    () => allColumns.find((column) => getColumnKey(column) === getFilterKey(f)),
    [allColumns, f],
  );
  const filterCoverageLabel = primaryColumn?.datasetChartCount
    ? `${filterChartCount}/${primaryColumn.datasetChartCount} charts`
    : `${filterChartCount} chart${filterChartCount !== 1 ? 's' : ''}`;
  const contextLabel = primaryColumn ? getColumnContextLabel(primaryColumn) : getColumnContextLabel({
    name: f.field,
    key: f.fieldKey,
    semanticField: f.semanticField,
    datasetId: f.datasetId,
  });

  return (
    <div className="bi-fade-in border border-[rgb(var(--border-line))] rounded-lg bg-surface-2/70 overflow-hidden flex flex-col">
      {/* Card header */}
      <div className="flex items-center justify-between border-b border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`bi-filter-chip ${TYPE_PILL[f.type]}`} title={`Type: ${TYPE_LABEL[f.type]}`}>
            {TYPE_LABEL[f.type]}
          </span>
          {isEditingLabel ? (
            // Phase-15.78 — inline label editor. Tester report (X.1):
            // users were stuck reading raw column names like
            // customer_acquisition_channel; this lets them rename to
            // "Kênh mua hàng" or similar, persisted on the filter.
            <input
              autoFocus
              value={labelDraft}
              onChange={e => setLabelDraft(e.target.value)}
              onBlur={() => { onUpdateLabel(labelDraft); setIsEditingLabel(false); }}
              onKeyDown={e => {
                if (e.key === 'Enter') { onUpdateLabel(labelDraft); setIsEditingLabel(false); }
                if (e.key === 'Escape') { setLabelDraft(f.label ?? ''); setIsEditingLabel(false); }
              }}
              placeholder={getFilterDisplayLabel(f)}
              className="text-sm font-semibold text-text-primary bg-surface-2 border border-brand/40 rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-brand min-w-0 max-w-[12rem]"
            />
          ) : (
            <button
              onClick={() => { setLabelDraft(f.label ?? ''); setIsEditingLabel(true); }}
              title={f.label ? 'Click to rename — clears to default if empty' : 'Click to set a custom label'}
              className="group/label inline-flex items-center gap-1 min-w-0"
            >
              <span className="text-sm font-semibold text-text-primary truncate">
                {getFilterDisplayLabel(f)}
              </span>
              <Pencil className="w-3 h-3 text-text-quaternary opacity-0 group-hover/label:opacity-100 transition-opacity flex-shrink-0" />
            </button>
          )}
          {contextLabel && (
            <span className="hidden max-w-[9rem] truncate text-xs text-text-quaternary sm:inline">
              {contextLabel}
            </span>
          )}
          {selected.length > 0 && (
            <span className="px-1.5 py-0.5 bg-brand/15 text-brand text-xs rounded-full font-semibold flex-shrink-0">
              {selected.length}
            </span>
          )}
          {/* Chart coverage badge */}
          {filterChartCount > 0 && (
            <span
              className={`px-1.5 py-0.5 text-xs rounded-full flex-shrink-0 ${
                linkedCount > 0
                  ? 'bg-teal-100 text-teal-700'
                  : 'bg-surface-2 text-text-tertiary'
              }`}
              title={linkedCount > 0
                ? `Linked to ${linkedCount} other column(s) - applies to more charts`
                : `Applies to ${filterCoverageLabel}`
              }
            >
              {linkedCount > 0 && <Link2 className="w-3 h-3 inline mr-0.5" />}
              {filterCoverageLabel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {hasValue && (
            <button onClick={onClear} className="text-xs text-text-quaternary hover:text-text-secondary">
              Clear
            </button>
          )}
          {!lockSlots && (
            <button
              onClick={onRemove}
              className="p-0.5 text-text-quaternary hover:text-danger transition-colors"
              title="Remove filter"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Card body */}
      <div className="px-3 py-2 flex-1">
        {/* Phase-15.78 — multi/single mode toggle for dropdown/text filters.
            Operator `in` → multi-select checklist (legacy behaviour);
            `eq` → single-select dropdown (PowerBI-style). Hidden on
            number/date because they have their own operator UI. */}
        {supportsDropdownModeToggle && (
          <div className="mb-2 flex items-center gap-1 text-[11px] text-text-tertiary">
            <span className="opacity-70">Mode:</span>
            <button
              type="button"
              onClick={() => onSwitchDropdownMode(isMultiSelect ? 'single' : 'multi')}
              className="inline-flex items-center gap-1 rounded border border-[rgb(var(--border-line))] bg-surface-1 px-1.5 py-0.5 hover:bg-surface-2 transition-colors"
              title={isMultiSelect ? 'Click to switch to single-select' : 'Click to switch to multi-select'}
            >
              {isMultiSelect
                ? <><ToggleRight className="w-3.5 h-3.5 text-brand" /> Multi</>
                : <><ToggleLeft className="w-3.5 h-3.5 text-text-quaternary" /> Single</>}
            </button>
          </div>
        )}
        {isMultiSelect ? (
          <MultiSelectBody
            values={mergedValues}
            filteredValues={filteredValues}
            selected={selected}
            search={search}
            onSearchChange={onSearchChange}
            onToggleValue={onToggleValue}
            onSelectAll={() => onSelectAll(mergedValues)}
            onDeselectAll={onDeselectAll}
            conflictingFilterLabels={conflictingFilterLabels}
          />
        ) : supportsDropdownModeToggle ? (
          // Phase-15.78 — single-select dropdown for `eq` operator on
          // text/dropdown columns. One radio active at a time; clears
          // the value when the user picks "(none)".
          <SingleSelectBody
            values={mergedValues}
            filteredValues={filteredValues}
            selectedValue={typeof f.value === 'string' ? f.value : ''}
            search={search}
            onSearchChange={onSearchChange}
            onSelect={val => onUpdateValue(val)}
            onClear={() => onUpdateValue('')}
            conflictingFilterLabels={conflictingFilterLabels}
          />
        ) : f.type === 'number' ? (
          <NumberBody filter={f} onUpdateValue={onUpdateValue} onUpdateOperator={onUpdateOperator} />
        ) : f.type === 'date' ? (
          <DateBody filter={f} onUpdateValue={onUpdateValue} onUpdateOperator={onUpdateOperator} onUpdateDatePreset={onUpdateDatePreset} />
        ) : null}
      </div>

      {/* ── Linked columns section ────────────────────────────────── */}
      {hasLinkableColumns && (
        <div className="border-t border-[rgb(var(--border-line))]">
          <button
            onClick={() => setShowLinked(!showLinked)}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-tertiary hover:text-text-secondary hover:bg-surface-2/80 transition-colors"
          >
            <Link2 className="w-3 h-3" />
            <span>
              Link columns
              {linkedCount > 0 && (
                <span className="ml-1 text-teal-600 font-semibold">({linkedCount} linked)</span>
              )}
            </span>
            {showLinked
              ? <ChevronDown className="w-3 h-3 ml-auto" />
              : <ChevronRight className="w-3 h-3 ml-auto" />}
          </button>

          {showLinked && (
            <div className="px-3 pb-2 space-y-0.5">
              <p className="text-xs text-text-quaternary mb-1">
                Same filter value will apply to checked columns across charts:
              </p>
              {linkableColumns.map(col => {
                const columnKey = getColumnKey(col);
                const isLinked = f.linkedFields?.includes(columnKey) ?? false;
                const count = columnChartCount.get(columnKey) ?? 0;
                return (
                  <label
                    key={columnKey}
                    className={`flex items-center gap-2 px-1.5 py-1 rounded cursor-pointer text-xs ${
                      isLinked ? 'bg-teal-50 text-teal-800' : 'hover:bg-surface-2 text-text-secondary'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isLinked}
                      onChange={() => onToggleLinkedField(columnKey)}
                      className="w-3.5 h-3.5 rounded border-[rgb(var(--border-strong))] text-teal-600 focus:ring-teal-500 focus:ring-1"
                    />
                    <span className={`font-mono text-xs ${TYPE_CLR[col.type]}`}>
                      {TYPE_BADGE[col.type]}
                    </span>
                    <span className="truncate flex-1">{getColumnDisplayLabel(col)}</span>
                    {count > 0 && (
                      <span className="text-xs text-text-quaternary flex-shrink-0">
                        {count} chart{count !== 1 ? 's' : ''}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Single-select dropdown (PowerBI radio-style slicer) ─────────
// Phase-15.78 — alternate body for `eq` operator on dropdown/text filters.
// One value at a time, radio buttons, with the same cascading distinct
// query + conflict banner UX as MultiSelectBody.
function SingleSelectBody({
  values,
  filteredValues,
  selectedValue,
  search,
  onSearchChange,
  onSelect,
  onClear,
  conflictingFilterLabels,
}: {
  values: string[];
  filteredValues: string[];
  selectedValue: string;
  search: string;
  onSearchChange: (s: string) => void;
  onSelect: (val: string) => void;
  onClear: () => void;
  conflictingFilterLabels?: string[];
}) {
  const showConflictBanner =
    values.length === 0
    && (conflictingFilterLabels?.length ?? 0) > 0;
  return (
    <div>
      {showConflictBanner && (
        <div className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
          <p className="font-medium">No values match current filter combination.</p>
          <p className="mt-0.5 text-amber-700">
            Try relaxing: {conflictingFilterLabels!.slice(0, 3).join(', ')}
            {conflictingFilterLabels!.length > 3 ? ` (+${conflictingFilterLabels!.length - 3} more)` : ''}
          </p>
        </div>
      )}
      {values.length > 8 && (
        <div className="relative mb-2">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-quaternary" />
          <input
            type="text"
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Search values..."
            className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 py-1 pl-7 pr-2 text-xs outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand"
          />
        </div>
      )}
      {selectedValue && (
        <div className="flex items-center gap-2 mb-1.5 pb-1.5 border-b border-[rgb(var(--border-line))]">
          <button onClick={onClear} className="text-xs text-text-tertiary hover:text-text-secondary">
            Clear selection
          </button>
        </div>
      )}
      <div className="max-h-48 overflow-y-auto space-y-0.5">
        {filteredValues.length === 0 ? (
          <p className="text-xs text-text-quaternary italic py-1">
            {values.length === 0
              ? (showConflictBanner ? 'No matching values' : 'Loading values...')
              : 'No match'}
          </p>
        ) : (
          filteredValues.map(val => {
            const checked = selectedValue === val;
            return (
              <label
                key={val}
                className={`flex items-center gap-2 px-1.5 py-1 rounded cursor-pointer text-xs ${
                  checked ? 'bg-brand/10 text-brand' : 'hover:bg-surface-2 text-text-secondary'
                }`}
              >
                <input
                  type="radio"
                  checked={checked}
                  onChange={() => onSelect(val)}
                  className="w-3.5 h-3.5 border-[rgb(var(--border-strong))] text-brand focus:ring-brand focus:ring-1"
                />
                <span className="truncate flex-1">{val || '(empty)'}</span>
              </label>
            );
          })
        )}
      </div>
      {search && filteredValues.length < values.length && (
        <p className="text-xs text-text-quaternary mt-1">
          {filteredValues.length} of {values.length}
        </p>
      )}
    </div>
  );
}

// ── Multi-select checklist (PowerBI Basic Filter) ───────────────
function MultiSelectBody({
  values,
  filteredValues,
  selected,
  search,
  onSearchChange,
  onToggleValue,
  onSelectAll,
  onDeselectAll,
  conflictingFilterLabels,
}: {
  values: string[];
  filteredValues: string[];
  selected: string[];
  search: string;
  onSearchChange: (s: string) => void;
  onToggleValue: (val: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  conflictingFilterLabels?: string[];
}) {
  // When the cascading distinct query yields no values BUT other filters
  // are constraining it, surface the combination explicitly so the user
  // knows which filter to relax. Without this signal the user just sees
  // "Loading values…" and assumes the filter is broken.
  const showConflictBanner =
    values.length === 0
    && (conflictingFilterLabels?.length ?? 0) > 0;
  return (
    <div>
      {showConflictBanner && (
        <div className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
          <p className="font-medium">No values match current filter combination.</p>
          <p className="mt-0.5 text-amber-700">
            Try relaxing: {conflictingFilterLabels!.slice(0, 3).join(', ')}
            {conflictingFilterLabels!.length > 3 ? ` (+${conflictingFilterLabels!.length - 3} more)` : ''}
          </p>
        </div>
      )}
      {/* Search */}
      {values.length > 8 && (
        <div className="relative mb-2">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-quaternary" />
          <input
            type="text"
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Search values..."
            className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 py-1 pl-7 pr-2 text-xs outline-none focus:border-brand/50 focus:ring-1 focus:ring-brand"
          />
        </div>
      )}

      {/* Select / Deselect all */}
      {values.length > 1 && !search && (
        <div className="flex items-center gap-2 mb-1.5 pb-1.5 border-b border-[rgb(var(--border-line))]">
          <button onClick={onSelectAll} className="text-xs text-brand hover:text-brand">
            Select all
          </button>
          <span className="text-text-quaternary">|</span>
          <button onClick={onDeselectAll} className="text-xs text-text-tertiary hover:text-text-secondary">
            Deselect all
          </button>
        </div>
      )}

      {/* Checkboxes */}
      <div className="max-h-48 overflow-y-auto space-y-0.5">
        {filteredValues.length === 0 ? (
          <p className="text-xs text-text-quaternary italic py-1">
            {values.length === 0
              ? (showConflictBanner ? 'No matching values' : 'Loading values...')
              : 'No match'}
          </p>
        ) : (
          filteredValues.map(val => {
            const checked = selected.includes(val);
            return (
              <label
                key={val}
                className={`flex items-center gap-2 px-1.5 py-1 rounded cursor-pointer text-xs ${
                  checked ? 'bg-brand/10 text-brand' : 'hover:bg-surface-2 text-text-secondary'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleValue(val)}
                  className="w-3.5 h-3.5 rounded border-[rgb(var(--border-strong))] text-brand focus:ring-brand focus:ring-1"
                />
                <span className="truncate flex-1">{val || '(empty)'}</span>
              </label>
            );
          })
        )}
      </div>

      {search && filteredValues.length < values.length && (
        <p className="text-xs text-text-quaternary mt-1">
          {filteredValues.length} of {values.length}
        </p>
      )}
    </div>
  );
}

// ── Number range body (between operator) ────────────────────────
// Phase-15.78 — paired range sliders + number inputs for the between
// operator. Sliders give visual feedback while typing into either
// input still lets the user pin precise bounds. Slider scale is
// auto-derived from the current values (with a 10× padding for
// headroom) so the bar isn't dead before the user types numbers; if
// they want a wider range, they just type larger numbers into the
// inputs and the slider re-scales next render.
function NumberRangeBody({
  filter: f,
  onUpdateValue,
}: {
  filter: BaseFilter;
  onUpdateValue: (v: any) => void;
}) {
  const [lo, hi] = Array.isArray(f.value)
    ? [f.value[0] ?? '', f.value[1] ?? '']
    : ['', ''];
  const loNum = lo !== '' && lo != null ? Number(lo) : NaN;
  const hiNum = hi !== '' && hi != null ? Number(hi) : NaN;

  // Derive slider scale. If both bounds typed, scale spans them with
  // generous headroom either side; otherwise default 0–100. When the
  // user types out-of-range numbers, the slider thumb sits at the edge
  // and the inputs remain the source of truth.
  const hasBoth = Number.isFinite(loNum) && Number.isFinite(hiNum);
  const span = hasBoth ? Math.max(Math.abs(hiNum - loNum), 1) : 100;
  const min = hasBoth ? Math.min(loNum, hiNum) - span : 0;
  const max = hasBoth ? Math.max(loNum, hiNum) + span : 100;
  const step = span > 100 ? Math.max(1, Math.round(span / 100)) : span > 10 ? 1 : 0.1;

  const updateLo = (next: string | number) => {
    const value = typeof next === 'number' ? String(next) : next;
    onUpdateValue([value, hi]);
  };
  const updateHi = (next: string | number) => {
    const value = typeof next === 'number' ? String(next) : next;
    onUpdateValue([lo, value]);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          value={lo}
          onChange={e => updateLo(e.target.value)}
          placeholder="Min"
          className="flex-1 rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
        />
        <span className="text-text-quaternary text-xs">–</span>
        <input
          type="number"
          value={hi}
          onChange={e => updateHi(e.target.value)}
          placeholder="Max"
          className="flex-1 rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
        />
      </div>
      <div className="space-y-1 pt-1">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(loNum) ? loNum : min}
          onChange={e => updateLo(Number(e.target.value))}
          className="w-full accent-brand"
          title={`Min: ${Number.isFinite(loNum) ? loNum : '(not set)'}`}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(hiNum) ? hiNum : max}
          onChange={e => updateHi(Number(e.target.value))}
          className="w-full accent-brand"
          title={`Max: ${Number.isFinite(hiNum) ? hiNum : '(not set)'}`}
        />
        {!hasBoth && (
          <p className="text-[10px] text-text-quaternary leading-tight">
            Type Min &amp; Max to enable visual range; sliders re-scale automatically.
          </p>
        )}
      </div>
    </div>
  );
}

// ── Number filter body ──────────────────────────────────────────
function NumberBody({
  filter: f,
  onUpdateValue,
  onUpdateOperator,
}: {
  filter: BaseFilter;
  onUpdateValue: (v: any) => void;
  onUpdateOperator: (op: FilterOperator) => void;
}) {
  return (
    <div className="space-y-2">
      <select
        value={f.operator}
        onChange={e => onUpdateOperator(e.target.value as FilterOperator)}
        className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
      >
        <option value="eq">= equals</option>
        <option value="neq">≠ not equals</option>
        <option value="gt">&gt; greater than</option>
        <option value="gte">≥ greater or equal</option>
        <option value="lt">&lt; less than</option>
        <option value="lte">≤ less or equal</option>
        <option value="between">↔ between</option>
        <option value="is_null">∅ is empty</option>
        <option value="is_not_null">≠∅ is not empty</option>
      </select>
      {f.operator === 'is_null' || f.operator === 'is_not_null' ? null : f.operator === 'between' ? (
        <NumberRangeBody filter={f} onUpdateValue={onUpdateValue} />
      ) : (
        <input
          type="number"
          value={typeof f.value === 'number' ? f.value : f.value ?? ''}
          onChange={e => onUpdateValue(e.target.value === '' ? '' : Number(e.target.value))}
          placeholder="Enter value..."
          className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
        />
      )}
    </div>
  );
}

// ── Date filter body ────────────────────────────────────────────
function DateBody({
  filter: f,
  onUpdateValue,
  onUpdateOperator,
  onUpdateDatePreset,
}: {
  filter: BaseFilter;
  onUpdateValue: (v: any) => void;
  onUpdateOperator: (op: FilterOperator) => void;
  onUpdateDatePreset: (preset: DatePreset) => void;
}) {
  const activePreset = f.datePreset ?? 'custom';
  const isCustom = activePreset === 'custom';

  return (
    <div className="space-y-2">
      {/* ── Date preset selector ──────────────────────────── */}
      <select
        value={activePreset}
        onChange={e => onUpdateDatePreset(e.target.value as DatePreset)}
        className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs font-medium text-teal-700 outline-none focus:ring-1 focus:ring-teal-400"
      >
        {(Object.entries(DATE_PRESET_LABELS) as [DatePreset, string][]).map(([key, label]) => (
          <option key={key} value={key}>{label}</option>
        ))}
      </select>

      {/* ── Operator + manual date inputs (only when custom) ── */}
      {isCustom && (
        <>
          <select
            value={f.operator}
            onChange={e => onUpdateOperator(e.target.value as FilterOperator)}
            className="w-full rounded border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-brand"
          >
            <option value="between">↔ between dates</option>
            <option value="eq">= on date</option>
            <option value="gt">&gt; after</option>
            <option value="gte">≥ on or after</option>
            <option value="lt">&lt; before</option>
            <option value="lte">≤ on or before</option>
            <option value="is_null">∅ is empty</option>
            <option value="is_not_null">≠∅ is not empty</option>
          </select>
          {f.operator === 'is_null' || f.operator === 'is_not_null' ? null : f.operator === 'between' ? (
            <div className="space-y-1.5">
              <DateInput
                value={Array.isArray(f.value) ? f.value[0] ?? '' : ''}
                onChange={d => onUpdateValue([d, Array.isArray(f.value) ? f.value[1] ?? '' : ''])}
                placeholder="From date DD/MM/YYYY"
              />
              <DateInput
                value={Array.isArray(f.value) ? f.value[1] ?? '' : ''}
                onChange={d => onUpdateValue([Array.isArray(f.value) ? f.value[0] ?? '' : '', d])}
                placeholder="To date DD/MM/YYYY"
              />
            </div>
          ) : (
            <DateInput
              value={typeof f.value === 'string' ? f.value : ''}
              onChange={d => onUpdateValue(d)}
              placeholder="DD/MM/YYYY"
            />
          )}
        </>
      )}

      {/* ── Computed range preview (non-custom) ──────────── */}
      {!isCustom && Array.isArray(f.value) && f.value[0] && (
        <p className="text-[11px] text-text-tertiary">
          {f.value[0]} → {f.value[1]}
        </p>
      )}
    </div>
  );
}
