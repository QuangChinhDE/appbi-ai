'use client';

import { Plus, Trash2 } from 'lucide-react';

export interface Filter {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'notContains' | 'in' | 'notIn';
  value: string;
}

const OPERATOR_OPTIONS: { value: Filter['operator']; label: string }[] = [
  { value: 'eq',          label: '= equals' },
  { value: 'neq',         label: '≠ not equals' },
  { value: 'gt',          label: '> greater than' },
  { value: 'gte',         label: '≥ greater or equal' },
  { value: 'lt',          label: '< less than' },
  { value: 'lte',         label: '≤ less or equal' },
  { value: 'contains',    label: 'contains' },
  { value: 'notContains', label: 'not contains' },
  { value: 'in',          label: 'in (comma-sep)' },
  { value: 'notIn',       label: 'not in (comma-sep)' },
];

interface FilterBuilderProps {
  filters: Filter[];
  onChange: (filters: Filter[]) => void;
  availableFields: string[];
}

export function FilterBuilder({ filters, onChange, availableFields }: FilterBuilderProps) {
  const addFilter = () => {
    onChange([...filters, { field: availableFields[0] || '', operator: 'eq', value: '' }]);
  };

  const removeFilter = (index: number) => {
    onChange(filters.filter((_, i) => i !== index));
  };

  const updateFilter = (index: number, updates: Partial<Filter>) => {
    onChange(filters.map((f, i) => (i === index ? { ...f, ...updates } : f)));
  };

  return (
    <div className="space-y-2">
      {filters.map((filter, index) => (
        <div key={index} className="bg-gray-50 rounded border border-gray-200 p-2 space-y-1.5">
          <div className="flex items-center gap-1">
            <select
              value={filter.field}
              onChange={(e) => updateFilter(index, { field: e.target.value })}
              className="flex-1 px-2 py-1 border border-gray-200 rounded text-xs"
            >
              {availableFields.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
            <button
              onClick={() => removeFilter(index)}
              className="text-gray-400 hover:text-red-500 p-0.5 flex-shrink-0"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
          <select
            value={filter.operator}
            onChange={(e) => updateFilter(index, { operator: e.target.value as Filter['operator'] })}
            className="w-full px-2 py-1 border border-gray-200 rounded text-xs"
          >
            {OPERATOR_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <input
            type="text"
            value={filter.value}
            onChange={(e) => updateFilter(index, { value: e.target.value })}
            placeholder="Value"
            className="w-full px-2 py-1 border border-gray-200 rounded text-xs"
          />
        </div>
      ))}

      {filters.length === 0 && (
        <p className="text-xs text-gray-500 italic">No filters applied</p>
      )}

      <button
        onClick={addFilter}
        disabled={!availableFields.length}
        className="flex items-center gap-1 text-xs text-orange-600 hover:text-orange-700 font-medium disabled:opacity-40"
      >
        <Plus className="w-3 h-3" /> Add Filter
      </button>
    </div>
  );
}
