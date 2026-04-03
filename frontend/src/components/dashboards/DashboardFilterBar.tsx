'use client';

import React, { useState, useMemo } from 'react';
import { Plus, X, Filter, ChevronDown, ChevronRight, Search, Link2 } from 'lucide-react';
import { BaseFilter, FilterOperator, FilterType, ColumnInfo } from '@/lib/filters';
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
  /** Distinct values per column, keyed by column name */
  distinctValues: Record<string, string[]>;
  filters: BaseFilter[];
  onFiltersChange: (filters: BaseFilter[]) => void;
}

export function DashboardFilterBar({
  columns,
  columnChartCount,
  distinctValues,
  filters,
  onFiltersChange,
}: DashboardFilterBarProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [addingField, setAddingField] = useState(false);
  const [searchTerms, setSearchTerms] = useState<Record<string, string>>({});

  // How many filters have a non-empty value?
  const activeCount = filters.filter(f => {
    if (Array.isArray(f.value)) return f.value.length > 0;
    return f.value !== '' && f.value !== null && f.value !== undefined;
  }).length;

  // Set of all fields currently used by filters (primary only)
  const usedFields = useMemo(
    () => new Set(filters.map(f => f.field)),
    [filters],
  );

  // Columns not yet added as filters
  const availableColumns = useMemo(
    () => columns.filter(c => !usedFields.has(c.name)),
    [columns, usedFields],
  );

  // ── Mutators ───────────────────────────────────────────────────
  const addFilter = (fieldName: string) => {
    const col = columns.find(c => c.name === fieldName);
    if (!col) return;
    if (usedFields.has(fieldName)) return;

    const isMultiSelect = col.type === 'text' || col.type === 'dropdown';

    // Auto-link: for date columns, auto-link ALL other date columns on the dashboard
    let linkedFields: string[] | undefined;
    if (col.type === 'date') {
      linkedFields = columns
        .filter(c => c.type === 'date' && c.name !== fieldName && !usedFields.has(c.name))
        .map(c => c.name);
      if (!linkedFields.length) linkedFields = undefined;
    }

    const newFilter: BaseFilter = {
      id:           `gf-${Date.now()}`,
      field:        fieldName,
      linkedFields,
      type:         col.type,
      operator:     isMultiSelect ? 'in' : col.type === 'date' ? 'between' : 'gte',
      value:        isMultiSelect ? [] : col.type === 'date' ? ['', ''] : '',
    };
    onFiltersChange([...filters, newFilter]);
    setAddingField(false);
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
    onFiltersChange(filters.map(f => f.id === filterId ? { ...f, value } : f));

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
    const fields = [f.field, ...(f.linkedFields ?? [])];
    let total = 0;
    for (const field of fields) {
      total += columnChartCount.get(field) ?? 0;
    }
    const maxPossible = Math.max(...Array.from(columnChartCount.values()), 0);
    return Math.min(total, maxPossible || total);
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
                  <span className="font-semibold">{f.field}</span>
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
              onClick={() => setAddingField(!addingField)}
              disabled={availableColumns.length === 0}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Plus className="w-3 h-3" />
              Add Filter
            </button>

            {addingField && availableColumns.length > 0 && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setAddingField(false)} />
                <div className="absolute right-0 top-full mt-1 z-20 bg-white border border-gray-200 rounded-lg shadow-lg w-72 max-h-80 overflow-y-auto">
                  <div className="p-2 border-b border-gray-100">
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Select a field</p>
                    <p className="text-xs text-gray-400 mt-0.5">Date fields auto-link across all charts</p>
                  </div>
                  {availableColumns.map(col => {
                    const count = columnChartCount.get(col.name) ?? 0;
                    const sameTypeCount = col.type === 'date'
                      ? columns.filter(c => c.type === 'date' && c.name !== col.name && !usedFields.has(c.name)).length
                      : 0;
                    return (
                      <button
                        key={col.name}
                        onClick={() => addFilter(col.name)}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 flex items-center justify-between group"
                      >
                        <span className="flex items-center gap-2">
                          <span className={`text-xs font-mono w-4 text-center ${TYPE_CLR[col.type]}`}>
                            {TYPE_BADGE[col.type]}
                          </span>
                          <span className="text-gray-700 group-hover:text-blue-700">{col.name}</span>
                        </span>
                        <span className="flex items-center gap-2">
                          {sameTypeCount > 0 && (
                            <span className="flex items-center gap-0.5 text-xs text-teal-500" title={`Will auto-link ${sameTypeCount} other date column(s)`}>
                              <Link2 className="w-3 h-3" />
                              +{sameTypeCount}
                            </span>
                          )}
                          {count > 0 && (
                            <span className="text-xs text-gray-400">
                              {count} chart{count !== 1 ? 's' : ''}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
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
          <p className="text-sm text-gray-400">
            No filters added. Click <strong>Add Filter</strong> to filter dashboard data.
          </p>
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
    () => allColumns.filter(c =>
      c.type === f.type &&
      c.name !== f.field &&
      !usedFields.has(c.name)
    ),
    [allColumns, f.type, f.field, usedFields],
  );

  // Merge distinct values from primary + linked fields
  const mergedValues = useMemo(() => {
    const primary = allDistinctValues[f.field] ?? [];
    if (!f.linkedFields?.length) return primary;
    const set = new Set(primary);
    f.linkedFields.forEach(lf => {
      (allDistinctValues[lf] ?? []).forEach(v => set.add(v));
    });
    return Array.from(set).sort();
  }, [f.field, f.linkedFields, allDistinctValues]);

  const filteredValues = useMemo(() => {
    if (!search) return mergedValues;
    const q = search.toLowerCase();
    return mergedValues.filter(v => v.toLowerCase().includes(q));
  }, [mergedValues, search]);

  const linkedCount = f.linkedFields?.length ?? 0;
  const hasLinkableColumns = linkableColumns.length > 0;

  return (
    <div className="border border-gray-200 rounded-lg bg-gray-50/70 overflow-hidden flex flex-col">
      {/* Card header */}
      <div className="flex items-center justify-between px-3 py-2 bg-white border-b border-gray-100">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={`text-xs font-mono ${TYPE_CLR[f.type]}`}>
            {TYPE_BADGE[f.type]}
          </span>
          <span className="text-sm font-semibold text-gray-800 truncate">{f.field}</span>
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
                ? `Linked to ${linkedCount} other column(s) — applies to more charts`
                : `Applies to ${filterChartCount} chart(s)`
              }
            >
              {linkedCount > 0 && <Link2 className="w-3 h-3 inline mr-0.5" />}
              {filterChartCount} chart{filterChartCount !== 1 ? 's' : ''}
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
          <DateBody filter={f} onUpdateValue={onUpdateValue} onUpdateOperator={onUpdateOperator} />
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
                const isLinked = f.linkedFields?.includes(col.name) ?? false;
                const count = columnChartCount.get(col.name) ?? 0;
                return (
                  <label
                    key={col.name}
                    className={`flex items-center gap-2 px-1.5 py-1 rounded cursor-pointer text-xs ${
                      isLinked ? 'bg-teal-50 text-teal-800' : 'hover:bg-gray-100 text-gray-600'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isLinked}
                      onChange={() => onToggleLinkedField(col.name)}
                      className="w-3.5 h-3.5 rounded border-gray-300 text-teal-600 focus:ring-teal-500 focus:ring-1"
                    />
                    <span className={`font-mono text-xs ${TYPE_CLR[col.type]}`}>
                      {TYPE_BADGE[col.type]}
                    </span>
                    <span className="truncate flex-1">{col.name}</span>
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
    </div>
  );
}
