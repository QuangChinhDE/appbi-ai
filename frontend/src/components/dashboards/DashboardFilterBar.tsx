'use client';

import React, { useState } from 'react';
import { Plus, X, Filter } from 'lucide-react';
import { BaseFilter, FilterOperator, FilterType, ColumnInfo } from '@/lib/filters';

// ─── Operator sets per type ────────────────────────────────────────
const OPERATORS_BY_TYPE: Record<FilterType, { value: FilterOperator; label: string }[]> = {
  text: [
    { value: 'eq',          label: '= equals' },
    { value: 'neq',         label: '≠ not equals' },
    { value: 'contains',    label: '⊃ contains' },
    { value: 'starts_with', label: '^ starts with' },
  ],
  number: [
    { value: 'eq',  label: '= equals' },
    { value: 'neq', label: '≠ not equals' },
    { value: 'gt',  label: '> greater than' },
    { value: 'gte', label: '≥ greater or equal' },
    { value: 'lt',  label: '< less than' },
    { value: 'lte', label: '≤ less or equal' },
  ],
  date: [
    { value: 'eq',  label: '= on date' },
    { value: 'neq', label: '≠ not on date' },
    { value: 'gt',  label: '> after' },
    { value: 'gte', label: '≥ on or after' },
    { value: 'lt',  label: '< before' },
    { value: 'lte', label: '≤ on or before' },
  ],
  dropdown: [
    { value: 'eq',       label: '= equals' },
    { value: 'neq',      label: '≠ not equals' },
    { value: 'contains', label: '⊃ contains' },
  ],
};

const DEFAULT_OPERATOR: Record<FilterType, FilterOperator> = {
  text:     'contains',
  number:   'eq',
  date:     'eq',
  dropdown: 'eq',
};

const INPUT_TYPE_FOR: Record<FilterType, React.InputHTMLAttributes<HTMLInputElement>['type']> = {
  text:     'text',
  number:   'number',
  date:     'date',
  dropdown: 'text',
};

const OPERATOR_SHORT: Partial<Record<FilterOperator, string>> = {
  eq:          '=',
  neq:         '≠',
  contains:    '⊃',
  starts_with: '^',
  gt: '>',  lt: '<',  gte: '≥',  lte: '≤',
  in: 'in', not_in: '!in', between: '↔',
};

const TYPE_BADGE: Record<FilterType, string> = {
  text:     'T',
  number:   '#',
  date:     '📅',
  dropdown: '≡',
};

const TYPE_COLOR: Record<FilterType, string> = {
  text:     'bg-sky-50 text-sky-700 border-sky-200',
  number:   'bg-violet-50 text-violet-700 border-violet-200',
  date:     'bg-teal-50 text-teal-700 border-teal-200',
  dropdown: 'bg-gray-50 text-gray-700 border-gray-200',
};

interface DashboardFilterBarProps {
  /** Typed column list collected from loaded charts */
  columns: ColumnInfo[];
  /** How many charts contain each column name — for tooltip hint */
  columnChartCount: Map<string, number>;
  filters: BaseFilter[];
  onFiltersChange: (filters: BaseFilter[]) => void;
}

export function DashboardFilterBar({ columns, columnChartCount, filters, onFiltersChange }: DashboardFilterBarProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [draftField, setDraftField] = useState('');
  const [draftType, setDraftType] = useState<FilterType>('text');
  const [draftOp, setDraftOp] = useState<FilterOperator>('contains');
  const [draftValue, setDraftValue] = useState('');

  const openAdding = () => {
    const first = columns[0];
    const t = first?.type ?? 'text';
    setDraftField(first?.name ?? '');
    setDraftType(t);
    setDraftOp(DEFAULT_OPERATOR[t]);
    setDraftValue('');
    setIsAdding(true);
  };

  const handleFieldChange = (name: string) => {
    setDraftField(name);
    const col = columns.find(c => c.name === name);
    const t = col?.type ?? 'text';
    setDraftType(t);
    setDraftOp(DEFAULT_OPERATOR[t]);
    setDraftValue('');
  };

  const confirmAdd = () => {
    if (!draftField || draftValue.trim() === '') return;
    const newFilter: BaseFilter = {
      id:       `gf-${Date.now()}`,
      field:    draftField,
      type:     draftType,
      operator: draftOp,
      value:    draftType === 'number' ? Number(draftValue) : draftValue.trim(),
    };
    onFiltersChange([...filters, newFilter]);
    setIsAdding(false);
  };

  const cancelAdd = () => {
    setIsAdding(false);
    setDraftValue('');
  };

  const removeFilter = (id: string) => {
    onFiltersChange(filters.filter(f => f.id !== id));
  };

  const operatorOptions = OPERATORS_BY_TYPE[draftType] ?? OPERATORS_BY_TYPE.text;
  const inputType = INPUT_TYPE_FOR[draftType];

  return (
    <div className="bg-white rounded-lg border border-gray-200 px-4 py-3 mb-6">
      <div className="flex items-center gap-2 flex-wrap min-h-[2rem]">

        {/* Label */}
        <div className="flex items-center gap-1.5 text-sm font-medium text-gray-600 flex-shrink-0 mr-1">
          <Filter className="w-4 h-4 text-orange-500" />
          Dashboard Filters
          {filters.length > 0 && (
            <span className="px-1.5 py-0.5 bg-orange-100 text-orange-700 text-xs rounded-full font-semibold">
              {filters.length}
            </span>
          )}
        </div>

        {/* Empty state hint */}
        {filters.length === 0 && !isAdding && (
          <span className="text-xs text-gray-400 italic">No filters applied</span>
        )}

        {/* Active filter chips */}
        {filters.map(f => {
          const matchCount = columnChartCount.get(f.field) ?? 0;
          return (
            <span
              key={f.id}
              className={`inline-flex items-center gap-1 px-2.5 py-1 border text-xs rounded-full ${TYPE_COLOR[f.type]}`}
              title={`Applies to ${matchCount} chart${matchCount !== 1 ? 's' : ''} with column "${f.field}"`}
            >
              <span className="font-mono text-[0.65rem] opacity-60">{TYPE_BADGE[f.type]}</span>
              <span className="font-semibold">{f.field}</span>
              <span className="font-mono opacity-70">{OPERATOR_SHORT[f.operator] ?? f.operator}</span>
              <span>"{String(f.value)}"</span>
              {matchCount > 0 && (
                <span className="opacity-50 font-normal">·{matchCount}</span>
              )}
              <button
                onClick={() => removeFilter(f.id)}
                className="ml-0.5 opacity-50 hover:opacity-100 hover:text-red-600 transition-colors"
                title="Remove filter"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          );
        })}

        {/* Inline editor */}
        {isAdding ? (
          <div className="flex items-center gap-2 flex-wrap">
            {/* Field picker — always a select */}
            <select
              value={draftField}
              onChange={e => handleFieldChange(e.target.value)}
              disabled={columns.length === 0}
              className="text-sm border border-gray-300 rounded-md px-2 py-1 focus:ring-2 focus:ring-orange-400 focus:outline-none disabled:opacity-50"
            >
              {columns.length === 0
                ? <option value="">Loading columns…</option>
                : columns.map(c => (
                    <option key={c.name} value={c.name}>
                      {TYPE_BADGE[c.type]} {c.name}
                      {(columnChartCount.get(c.name) ?? 0) > 0
                        ? ` (${columnChartCount.get(c.name)} chart${columnChartCount.get(c.name) !== 1 ? 's' : ''})`
                        : ''}
                    </option>
                  ))
              }
            </select>

            {/* Type badge */}
            <span className={`text-xs font-medium px-2 py-1 rounded border ${TYPE_COLOR[draftType]}`}>
              {draftType}
            </span>

            {/* Operator — context-aware */}
            <select
              value={draftOp}
              onChange={e => setDraftOp(e.target.value as FilterOperator)}
              className="text-sm border border-gray-300 rounded-md px-2 py-1 focus:ring-2 focus:ring-orange-400 focus:outline-none"
            >
              {operatorOptions.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>

            {/* Value input — context-aware */}
            <input
              type={inputType}
              value={draftValue}
              onChange={e => setDraftValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') confirmAdd();
                if (e.key === 'Escape') cancelAdd();
              }}
              placeholder={draftType === 'number' ? '0' : draftType === 'date' ? 'YYYY-MM-DD' : 'value…'}
              autoFocus
              className="text-sm border border-gray-300 rounded-md px-2 py-1 w-36 focus:ring-2 focus:ring-orange-400 focus:outline-none"
            />

            <button
              onClick={confirmAdd}
              disabled={!draftField || draftValue.trim() === ''}
              className="px-3 py-1 text-xs font-medium bg-orange-500 text-white rounded-md hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Apply
            </button>
            <button
              onClick={cancelAdd}
              className="px-3 py-1 text-xs font-medium bg-gray-100 text-gray-600 rounded-md hover:bg-gray-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={openAdding}
            disabled={columns.length === 0}
            title={columns.length === 0 ? 'Waiting for chart data to load…' : 'Add a dashboard filter'}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-orange-600 border border-orange-300 rounded-full hover:bg-orange-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add Filter
          </button>
        )}

        {/* Clear all */}
        {filters.length > 0 && !isAdding && (
          <button
            onClick={() => onFiltersChange([])}
            className="ml-auto text-xs text-gray-400 hover:text-gray-700 transition-colors"
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}
