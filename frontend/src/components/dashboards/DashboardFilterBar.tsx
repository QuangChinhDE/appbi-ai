'use client';

import React, { useState, useMemo } from 'react';
import { Plus, X, Filter, ChevronDown, ChevronRight, Search, Link2, Check, RotateCcw, Calendar } from 'lucide-react';
import {
  BaseFilter,
  FilterOperator,
  FilterType,
  DatePreset,
  DATE_PRESET_LABELS,
  computeDatePresetRange,
  ColumnInfo,
  getColumnDisplayLabel,
  getColumnKey,
  getFilterDisplayLabel,
  getFilterKey,
} from '@/lib/filters';
import { DateInput } from '@/components/ui/DateInput';

// ─── Type badge helpers ────────────────────────────────────────
const TYPE_BADGE: Record<FilterType, string> = { text: 'T', number: '#', date: '📅', dropdown: '≡' };
const TYPE_CLR: Record<FilterType, string> = {
  text:     'text-sky-500',
  number:   'text-violet-500',
  date:     'text-teal-500',
  dropdown: 'text-gray-500',
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
}

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
}: DashboardFilterBarProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [addingField, setAddingField] = useState(false);
  const [addFilterSearch, setAddFilterSearch] = useState('');
  const [searchTerms, setSearchTerms] = useState<Record<string, string>>({});

  // How many filters have a non-empty value?
  const activeCount = filters.filter(f => {
    if (Array.isArray(f.value)) return f.value.length > 0;
    return f.value !== '' && f.value !== null && f.value !== undefined;
  }).length;

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

  const addableColumns = useMemo(
    () => availableColumns.filter((column) => column.sharedAcrossDataset !== false || column.type === 'date'),
    [availableColumns],
  );

  const matchingAvailableColumns = useMemo(
    () => addableColumns.filter((column) => {
      if (!normalizedAddFilterSearch) return true;
      const haystack = [
        getColumnDisplayLabel(column),
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
    const sameTypeCount = column.type === 'date' && !column.semanticField
      ? columns.filter(c => c.type === 'date' && getColumnKey(c) !== columnKey && !usedFields.has(getColumnKey(c))).length
      : 0;

    return (
      <button
        key={columnKey}
        onClick={() => addFilter(columnKey)}
        className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 flex items-center justify-between group"
      >
        <span className="flex items-center gap-2 min-w-0">
          <span className={`text-xs font-mono w-4 text-center ${TYPE_CLR[column.type]}`}>
            {TYPE_BADGE[column.type]}
          </span>
          <span className="text-gray-700 group-hover:text-blue-700 truncate">{getColumnDisplayLabel(column)}</span>
        </span>
        <span className="flex items-center gap-2 pl-2">
          {sameTypeCount > 0 && (
            <span className="flex items-center gap-0.5 text-xs text-teal-500" title={`Will auto-link ${sameTypeCount} other date column(s)`}>
              <Link2 className="w-3 h-3" />
              +{sameTypeCount}
            </span>
          )}
          <span className="text-xs text-gray-400">
            {getCoverageLabel(column)}
          </span>
        </span>
      </button>
    );
  };

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div className="bg-white rounded-lg border border-gray-200 mb-6 shadow-sm">
      {/* ── Header bar ────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 px-4 py-2.5">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center gap-1.5 text-sm font-medium text-gray-700 hover:text-gray-900"
        >
          <Filter className="w-4 h-4 text-blue-500" />
          <span>Filters</span>
          {activeCount > 0 && (
            <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full font-semibold">
              {activeCount}
            </span>
          )}
          {isExpanded
            ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
            : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
        </button>

        {hasPendingChanges && (
          <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
            Draft changes
          </span>
        )}

        {/* Collapsed summary chips */}
        {!isExpanded && activeCount > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap flex-1 ml-2">
            {filters
              .filter(f => Array.isArray(f.value) ? f.value.length > 0 : !!f.value)
              .map(f => (
                <span
                  key={f.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 border border-blue-200 text-blue-700 text-xs rounded-full"
                >
                  <span className="font-semibold">{getFilterDisplayLabel(f)}</span>
                  {f.datePreset && f.datePreset !== 'custom' && (
                    <span className="opacity-70">{DATE_PRESET_LABELS[f.datePreset]}</span>
                  )}
                  {f.linkedFields && f.linkedFields.length > 0 && (
                    <Link2 className="w-3 h-3 text-blue-400" />
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
              className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          )}

          {onApply && (
            <button
              onClick={onApply}
              disabled={!hasPendingChanges || isApplying}
              className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
            >
              <Check className="h-3 w-3" />
              {isApplying ? 'Applying...' : 'Apply'}
            </button>
          )}

          {filters.length > 0 && (
            <button
              onClick={() => onFiltersChange([])}
              className="text-xs text-gray-400 hover:text-red-500 transition-colors"
            >
              Clear all
            </button>
          )}

          {/* Add filter dropdown */}
          <div className="relative">
            <button
              onClick={() => {
                const next = !addingField;
                setAddingField(next);
                if (!next) {
                  setAddFilterSearch('');
                }
              }}
              disabled={addableColumns.length === 0}
              title={addableColumns.length === 0 ? 'No dashboard filter fields available' : undefined}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Plus className="w-3 h-3" />
              Add Filter
            </button>

            {addingField && addableColumns.length > 0 && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => {
                  setAddingField(false);
                  setAddFilterSearch('');
                }} />
                <div className="absolute right-0 top-full mt-1 z-20 bg-white border border-gray-200 rounded-lg shadow-lg w-80 max-h-[28rem] overflow-y-auto">
                  <div className="p-2 border-b border-gray-100">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Add a filter</p>
                  </div>
                  {addableColumns.length > 8 && (
                    <div className="p-2 border-b border-gray-100">
                      <div className="relative">
                        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                        <input
                          type="text"
                          value={addFilterSearch}
                          onChange={(e) => setAddFilterSearch(e.target.value)}
                          placeholder="Search fields..."
                          className="w-full pl-7 pr-2 py-1.5 text-xs border border-gray-200 rounded focus:ring-1 focus:ring-blue-400 focus:border-blue-400 outline-none bg-white"
                        />
                      </div>
                    </div>
                  )}

                  {/* ── Date filter section ─────────────────────────── */}
                  {(() => {
                    const dateColumns = matchingAvailableColumns.filter(c => c.type === 'date');
                    const fieldColumns = matchingAvailableColumns.filter(c => c.type !== 'date');
                    return (
                      <>
                        {dateColumns.length > 0 && (
                          <div className="py-1 border-b border-gray-100">
                            <div className="px-3 py-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-teal-600">
                              <Calendar className="w-3 h-3" />
                              Filter theo Ngày
                            </div>
                            {dateColumns.map(renderColumnOption)}
                          </div>
                        )}
                        {fieldColumns.length > 0 && (
                          <div className="py-1">
                            <div className="px-3 py-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                              <Filter className="w-3 h-3" />
                              Filter theo Trường
                            </div>
                            {fieldColumns.map(renderColumnOption)}
                          </div>
                        )}
                      </>
                    );
                  })()}

                  {matchingAvailableColumns.length === 0 && (
                    addableColumns.length === 0 ? (
                      <div className="px-3 py-3 text-xs text-gray-400">
                        <p className="font-medium text-gray-500">No dashboard filter fields available.</p>
                        <p className="mt-1">Use chart-level filters for fields that only affect individual charts.</p>
                      </div>
                    ) : (
                      <p className="px-3 py-3 text-xs text-gray-400 italic">
                        No matching shared fields
                      </p>
                    )
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Filter cards ──────────────────────────────────────────── */}
      {isExpanded && filters.length > 0 && (
        <div className="px-3 pb-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {filters.map(f => (
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
              onClear={() => clearFilter(f.id)}
              onRemove={() => removeFilter(f.id)}
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {isExpanded && filters.length === 0 && (
        <div className="px-4 py-5 text-center border-t border-gray-100">
          {addableColumns.length > 0 ? (
            <p className="text-sm text-gray-400">
              No filters added. Click <strong>Add Filter</strong> to filter all charts in this dashboard.
            </p>
          ) : (
            <p className="text-sm text-gray-400">
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
  onClear: () => void;
  onRemove: () => void;
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
  onClear,
  onRemove,
}: FilterCardProps) {
  const [showLinked, setShowLinked] = useState(false);

  const isMultiSelect = f.operator === 'in' || f.operator === 'not_in';
  const selected: string[] = isMultiSelect && Array.isArray(f.value) ? f.value : [];
  const hasValue = isMultiSelect ? selected.length > 0
    : f.operator === 'between'
      ? (Array.isArray(f.value) && (f.value[0] || f.value[1]))
      : (f.value !== '' && f.value !== null && f.value !== undefined);

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

  return (
    <div className="border border-gray-200 rounded-lg bg-gray-50/70 overflow-hidden flex flex-col">
      {/* Card header */}
      <div className="flex items-center justify-between px-3 py-2 bg-white border-b border-gray-100">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`text-xs font-mono ${TYPE_CLR[f.type]}`}>
            {TYPE_BADGE[f.type]}
          </span>
          <span className="text-sm font-semibold text-gray-800 truncate">{getFilterDisplayLabel(f)}</span>
          {selected.length > 0 && (
            <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full font-semibold flex-shrink-0">
              {selected.length}
            </span>
          )}
          {/* Chart coverage badge */}
          {filterChartCount > 0 && (
            <span
              className={`px-1.5 py-0.5 text-xs rounded-full flex-shrink-0 ${
                linkedCount > 0
                  ? 'bg-teal-100 text-teal-700'
                  : 'bg-gray-100 text-gray-500'
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
            <button onClick={onClear} className="text-xs text-gray-400 hover:text-gray-600">
              Clear
            </button>
          )}
          <button
            onClick={onRemove}
            className="p-0.5 text-gray-400 hover:text-red-500 transition-colors"
            title="Remove filter"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Card body */}
      <div className="px-3 py-2 flex-1">
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
          />
        ) : f.type === 'number' ? (
          <NumberBody filter={f} onUpdateValue={onUpdateValue} onUpdateOperator={onUpdateOperator} />
        ) : f.type === 'date' ? (
          <DateBody filter={f} onUpdateValue={onUpdateValue} onUpdateOperator={onUpdateOperator} onUpdateDatePreset={onUpdateDatePreset} />
        ) : null}
      </div>

      {/* ── Linked columns section ────────────────────────────────── */}
      {hasLinkableColumns && (
        <div className="border-t border-gray-100">
          <button
            onClick={() => setShowLinked(!showLinked)}
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-50/80 transition-colors"
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
              <p className="text-xs text-gray-400 mb-1">
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
                      isLinked ? 'bg-teal-50 text-teal-800' : 'hover:bg-gray-100 text-gray-600'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isLinked}
                      onChange={() => onToggleLinkedField(columnKey)}
                      className="w-3.5 h-3.5 rounded border-gray-300 text-teal-600 focus:ring-teal-500 focus:ring-1"
                    />
                    <span className={`font-mono text-xs ${TYPE_CLR[col.type]}`}>
                      {TYPE_BADGE[col.type]}
                    </span>
                    <span className="truncate flex-1">{getColumnDisplayLabel(col)}</span>
                    {count > 0 && (
                      <span className="text-xs text-gray-400 flex-shrink-0">
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
}: {
  values: string[];
  filteredValues: string[];
  selected: string[];
  search: string;
  onSearchChange: (s: string) => void;
  onToggleValue: (val: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
}) {
  return (
    <div>
      {/* Search */}
      {values.length > 8 && (
        <div className="relative mb-2">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="Search values…"
            className="w-full pl-7 pr-2 py-1 text-xs border border-gray-200 rounded focus:ring-1 focus:ring-blue-400 focus:border-blue-400 outline-none bg-white"
          />
        </div>
      )}

      {/* Select / Deselect all */}
      {values.length > 1 && !search && (
        <div className="flex items-center gap-2 mb-1.5 pb-1.5 border-b border-gray-100">
          <button onClick={onSelectAll} className="text-xs text-blue-600 hover:text-blue-800">
            Select all
          </button>
          <span className="text-gray-300">|</span>
          <button onClick={onDeselectAll} className="text-xs text-gray-500 hover:text-gray-700">
            Deselect all
          </button>
        </div>
      )}

      {/* Checkboxes */}
      <div className="max-h-48 overflow-y-auto space-y-0.5">
        {filteredValues.length === 0 ? (
          <p className="text-xs text-gray-400 italic py-1">{values.length === 0 ? 'Loading values…' : 'No match'}</p>
        ) : (
          filteredValues.map(val => {
            const checked = selected.includes(val);
            return (
              <label
                key={val}
                className={`flex items-center gap-2 px-1.5 py-1 rounded cursor-pointer text-xs ${
                  checked ? 'bg-blue-50 text-blue-800' : 'hover:bg-gray-100 text-gray-700'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleValue(val)}
                  className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 focus:ring-1"
                />
                <span className="truncate flex-1">{val || '(empty)'}</span>
              </label>
            );
          })
        )}
      </div>

      {search && filteredValues.length < values.length && (
        <p className="text-xs text-gray-400 mt-1">
          {filteredValues.length} of {values.length}
        </p>
      )}
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
        className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-white focus:ring-1 focus:ring-blue-400 outline-none"
      >
        <option value="eq">= equals</option>
        <option value="neq">≠ not equals</option>
        <option value="gt">&gt; greater than</option>
        <option value="gte">≥ greater or equal</option>
        <option value="lt">&lt; less than</option>
        <option value="lte">≤ less or equal</option>
        <option value="between">↔ between</option>
      </select>
      {f.operator === 'between' ? (
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            value={Array.isArray(f.value) ? f.value[0] ?? '' : ''}
            onChange={e => onUpdateValue([e.target.value, Array.isArray(f.value) ? f.value[1] ?? '' : ''])}
            placeholder="Min"
            className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 bg-white focus:ring-1 focus:ring-blue-400 outline-none"
          />
          <span className="text-gray-400 text-xs">–</span>
          <input
            type="number"
            value={Array.isArray(f.value) ? f.value[1] ?? '' : ''}
            onChange={e => onUpdateValue([Array.isArray(f.value) ? f.value[0] ?? '' : '', e.target.value])}
            placeholder="Max"
            className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 bg-white focus:ring-1 focus:ring-blue-400 outline-none"
          />
        </div>
      ) : (
        <input
          type="number"
          value={typeof f.value === 'number' ? f.value : f.value ?? ''}
          onChange={e => onUpdateValue(e.target.value === '' ? '' : Number(e.target.value))}
          placeholder="Enter value…"
          className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-white focus:ring-1 focus:ring-blue-400 outline-none"
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
        className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-white focus:ring-1 focus:ring-teal-400 outline-none font-medium text-teal-700"
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
            className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-white focus:ring-1 focus:ring-blue-400 outline-none"
          >
            <option value="between">↔ between dates</option>
            <option value="eq">= on date</option>
            <option value="gt">&gt; after</option>
            <option value="gte">≥ on or after</option>
            <option value="lt">&lt; before</option>
            <option value="lte">≤ on or before</option>
          </select>
          {f.operator === 'between' ? (
            <div className="space-y-1.5">
              <DateInput
                value={Array.isArray(f.value) ? f.value[0] ?? '' : ''}
                onChange={d => onUpdateValue([d, Array.isArray(f.value) ? f.value[1] ?? '' : ''])}
                placeholder="Từ ngày DD/MM/YYYY"
              />
              <DateInput
                value={Array.isArray(f.value) ? f.value[1] ?? '' : ''}
                onChange={d => onUpdateValue([Array.isArray(f.value) ? f.value[0] ?? '' : '', d])}
                placeholder="Đến ngày DD/MM/YYYY"
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
        <p className="text-[11px] text-gray-500">
          {f.value[0]} → {f.value[1]}
        </p>
      )}
    </div>
  );
}
