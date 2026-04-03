'use client';

import { useState, useMemo } from 'react';
import { Plus, Trash2, ChevronDown } from 'lucide-react';
import { getFilterTypeForColumn, getDistinctValues, type FilterType } from '@/lib/filters';
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
  ],
  number: [
    { value: 'eq',         label: 'Equals' },
    { value: 'neq',        label: 'Not equals' },
    { value: 'between',    label: 'Is between' },
    { value: 'gt',         label: 'Greater than' },
    { value: 'gte',        label: 'Greater or equal' },
    { value: 'lt',         label: 'Less than' },
    { value: 'lte',        label: 'Less or equal' },
  ],
  text: [
    { value: 'contains',      label: 'Contains' },
    { value: 'eq',            label: 'Equals' },
    { value: 'neq',           label: 'Not equals' },
    { value: 'starts_with',   label: 'Starts with' },
    { value: 'not_contains',  label: 'Does not contain' },
  ],
  dropdown: [
    { value: 'in',     label: 'Is any of' },
    { value: 'not_in', label: 'Is not any of' },
    { value: 'eq',     label: 'Is exactly' },
    { value: 'neq',    label: 'Is not' },
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
interface ColInfo { name: string; type: string }

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
  // ── Legacy prop (backward compat) ──────────────────────────────────────────
  availableFields?: string[];
}

// ── Main component ────────────────────────────────────────────────────────────
export function FilterBuilder({
  filters, onChange, columns, dataRows = [], availableFields,
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
    <div className="space-y-2">
      {filters.map((filter, idx) => {
        const col = cols.find(c => c.name === filter.field);
        const colType: FilterType = col ? resolveType(col, dataRows) : 'text';
        const ops = OPERATORS_BY_TYPE[colType];
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
            onChangeField={v => changeField(idx, v)}
            onChangeOperator={v => changeOperator(idx, v)}
            onChangeValue={v => changeValue(idx, v)}
            onRemove={() => removeFilter(idx)}
          />
        );
      })}

      {filters.length === 0 && (
        <p className="text-xs text-gray-400 italic py-0.5">No filters — chart shows all data.</p>
      )}

      <button
        onClick={addFilter}
        disabled={!cols.length}
        className="flex items-center gap-1 text-xs text-orange-600 hover:text-orange-700 font-medium disabled:opacity-40"
      >
        <Plus className="w-3 h-3" /> Add Filter
      </button>
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
  onChangeField: (v: string) => void;
  onChangeOperator: (v: string) => void;
  onChangeValue: (v: any) => void;
  onRemove: () => void;
}

function FilterRow({
  filter, colType, operators, fieldOptions, distinctValues,
  onChangeField, onChangeOperator, onChangeValue, onRemove,
}: FilterRowProps) {
  const [dropOpen, setDropOpen] = useState(false);
  const selectedVals: string[] = Array.isArray(filter.value) ? filter.value : [];

  const toggleVal = (v: string) => {
    const next = selectedVals.includes(v)
      ? selectedVals.filter(x => x !== v)
      : [...selectedVals, v];
    onChangeValue(next);
  };

  return (
    <div className="bg-gray-50 rounded-lg border border-gray-200 p-2.5 space-y-2">

      {/* Field + type badge + remove */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-gray-400 w-4 text-center flex-shrink-0" title={colType}>
          {TYPE_ICON[colType]}
        </span>
        <select
          value={filter.field}
          onChange={e => onChangeField(e.target.value)}
          className="flex-1 px-2 py-1 border border-gray-200 rounded text-xs bg-white focus:ring-1 focus:ring-blue-400 focus:border-blue-400 outline-none"
        >
          {fieldOptions.map(f => (
            <option key={f.name} value={f.name}>{f.name}</option>
          ))}
        </select>
        <button onClick={onRemove} title="Remove filter"
          className="p-0.5 text-gray-400 hover:text-red-500 flex-shrink-0">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Operator */}
      <select
        value={filter.operator}
        onChange={e => onChangeOperator(e.target.value)}
        className="w-full px-2 py-1 border border-gray-200 rounded text-xs bg-white focus:ring-1 focus:ring-blue-400 focus:border-blue-400 outline-none"
      >
        {operators.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>

      {/* ── DATE inputs ─────────────────────────────────────────────────────── */}
      {colType === 'date' && filter.operator === 'between' && (
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <p className="text-[10px] text-gray-400 mb-0.5">Từ ngày</p>
            <DateInput
              value={Array.isArray(filter.value) ? filter.value[0] ?? '' : ''}
              onChange={d => onChangeValue([d, Array.isArray(filter.value) ? filter.value[1] ?? '' : ''])}
            />
          </div>
          <div>
            <p className="text-[10px] text-gray-400 mb-0.5">Đến ngày</p>
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
            <p className="text-[10px] text-gray-400 mb-0.5">Min</p>
            <input type="number"
              value={Array.isArray(filter.value) ? filter.value[0] ?? '' : ''}
              onChange={e => onChangeValue([e.target.value, Array.isArray(filter.value) ? filter.value[1] ?? '' : ''])}
              className="w-full px-2 py-1 border border-gray-200 rounded text-xs bg-white focus:ring-1 focus:ring-blue-400 outline-none"
            />
          </div>
          <div>
            <p className="text-[10px] text-gray-400 mb-0.5">Max</p>
            <input type="number"
              value={Array.isArray(filter.value) ? filter.value[1] ?? '' : ''}
              onChange={e => onChangeValue([Array.isArray(filter.value) ? filter.value[0] ?? '' : '', e.target.value])}
              className="w-full px-2 py-1 border border-gray-200 rounded text-xs bg-white focus:ring-1 focus:ring-blue-400 outline-none"
            />
          </div>
        </div>
      )}
      {colType === 'number' && filter.operator !== 'between' && (
        <input type="number"
          value={filter.value ?? ''}
          onChange={e => onChangeValue(e.target.value === '' ? '' : Number(e.target.value))}
          placeholder="Enter number…"
          className="w-full px-2 py-1 border border-gray-200 rounded text-xs bg-white focus:ring-1 focus:ring-blue-400 outline-none"
        />
      )}

      {/* ── TEXT input ───────────────────────────────────────────────────────── */}
      {colType === 'text' && (
        <input type="text"
          value={typeof filter.value === 'string' ? filter.value : ''}
          onChange={e => onChangeValue(e.target.value)}
          placeholder="Enter value…"
          className="w-full px-2 py-1 border border-gray-200 rounded text-xs bg-white focus:ring-1 focus:ring-blue-400 outline-none"
        />
      )}

      {/* ── DROPDOWN multi-select ─────────────────────────────────────────────── */}
      {colType === 'dropdown' && (filter.operator === 'in' || filter.operator === 'not_in') && (
        <div className="relative">
          <button type="button" onClick={() => setDropOpen(o => !o)}
            className="w-full flex items-center justify-between px-2 py-1 border border-gray-200 rounded text-xs bg-white focus:ring-1 focus:ring-blue-400 outline-none"
          >
            <span className={selectedVals.length === 0 ? 'text-gray-400' : 'text-gray-700'}>
              {selectedVals.length === 0
                ? 'Choose values…'
                : selectedVals.length === 1
                  ? selectedVals[0]
                  : `${selectedVals.length} selected`}
            </span>
            <ChevronDown className={`w-3 h-3 text-gray-400 transition-transform ${dropOpen ? 'rotate-180' : ''}`} />
          </button>
          {dropOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setDropOpen(false)} />
              <div className="absolute left-0 right-0 top-full mt-0.5 z-20 bg-white border border-gray-200 rounded-md shadow-lg max-h-48 overflow-y-auto">
                {distinctValues.length === 0
                  ? <p className="text-xs text-gray-400 px-3 py-2 italic">No values in sample data</p>
                  : distinctValues.map(v => (
                    <label key={v}
                      className={`flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-xs hover:bg-gray-50 ${selectedVals.includes(v) ? 'bg-blue-50 text-blue-800' : 'text-gray-700'}`}
                    >
                      <input type="checkbox" checked={selectedVals.includes(v)} onChange={() => toggleVal(v)}
                        className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 focus:ring-1" />
                      <span className="truncate">{v || '(empty)'}</span>
                    </label>
                  ))
                }
              </div>
            </>
          )}
          {selectedVals.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {selectedVals.map(v => (
                <span key={v}
                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-blue-100 text-blue-700 text-[10px] rounded-full"
                >
                  {v}
                  <button onClick={() => toggleVal(v)} className="hover:text-blue-900 ml-0.5">×</button>
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
              className="w-full px-2 py-1 border border-gray-200 rounded text-xs bg-white focus:ring-1 focus:ring-blue-400 outline-none"
            >
              <option value="">— select value —</option>
              {distinctValues.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          )
          : (
            <input type="text" value={typeof filter.value === 'string' ? filter.value : ''}
              onChange={e => onChangeValue(e.target.value)}
              placeholder="Enter value…"
              className="w-full px-2 py-1 border border-gray-200 rounded text-xs bg-white focus:ring-1 focus:ring-blue-400 outline-none"
            />
          )
      )}
    </div>
  );
}
