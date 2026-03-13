'use client';

import { Plus, X } from 'lucide-react';

export interface Filter {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'notContains' | 'in' | 'notIn';
  value: string;
}

interface FilterBuilderProps {
  filters: Filter[];
  onChange: (filters: Filter[]) => void;
  availableFields: string[];
}

export function FilterBuilder({ filters, onChange, availableFields }: FilterBuilderProps) {
  const addFilter = () => {
    onChange([
      ...filters,
      { field: availableFields[0] || '', operator: 'eq', value: '' }
    ]);
  };

  const removeFilter = (index: number) => {
    onChange(filters.filter((_, i) => i !== index));
  };

  const updateFilter = (index: number, updates: Partial<Filter>) => {
    onChange(
      filters.map((filter, i) => 
        i === index ? { ...filter, ...updates } : filter
      )
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold text-gray-700 uppercase">Filters</h3>
        <button
          onClick={addFilter}
          className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1"
          disabled={!availableFields.length}
        >
          <Plus className="w-3 h-3" />
          Add Filter
        </button>
      </div>

      <div className="space-y-2">
        {filters.map((filter, index) => (
          <div key={index} className="flex items-center gap-2">
            <select
              value={filter.field}
              onChange={(e) => updateFilter(index, { field: e.target.value })}
              className="flex-1 text-sm border border-gray-300 rounded px-2 py-1 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              {availableFields.map((field) => (
                <option key={field} value={field}>
                  {field}
                </option>
              ))}
            </select>

            <select
              value={filter.operator}
              onChange={(e) => updateFilter(index, { operator: e.target.value as Filter['operator'] })}
              className="text-sm border border-gray-300 rounded px-2 py-1 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="eq">=</option>
              <option value="neq">!=</option>
              <option value="gt">&gt;</option>
              <option value="lt">&lt;</option>
              <option value="gte">&gt;=</option>
              <option value="lte">&lt;=</option>
              <option value="contains">contains</option>
              <option value="notContains">not contains</option>
              <option value="in">in</option>
              <option value="notIn">not in</option>
            </select>

            <input
              type="text"
              value={filter.value}
              onChange={(e) => updateFilter(index, { value: e.target.value })}
              placeholder="Value"
              className="flex-1 text-sm border border-gray-300 rounded px-2 py-1 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />

            <button
              onClick={() => removeFilter(index)}
              className="text-gray-400 hover:text-red-600"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>

      {filters.length === 0 && (
        <p className="text-xs text-gray-500 italic">No filters applied</p>
      )}
    </div>
  );
}
