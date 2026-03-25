'use client';

import React, { useState } from 'react';
import { Filter, X, Plus } from 'lucide-react';
import type { ColumnMetadata } from '@/types/api';
import { ExploreFilter, FilterType, getFilterTypeForColumn, getDistinctValues } from '@/types/filters';
import { v4 as uuidv4 } from 'uuid';

interface FilterPanelV2Props {
  columns?: ColumnMetadata[];
  filters: ExploreFilter[];
  onChange: (filters: ExploreFilter[]) => void;
  latestDataSample?: Record<string, any>[];
}

export function FilterPanelV2({
  columns = [],
  filters,
  onChange,
  latestDataSample = [],
}: FilterPanelV2Props) {
  const [selectedField, setSelectedField] = useState<string>('');

  const availableFields = columns;

  const handleAddFilter = () => {
    if (!selectedField) return;

    const column = availableFields.find(c => c.name === selectedField);
    if (!column) return;

    const filterType = getFilterTypeForColumn(column.type);
    
    let defaultValue: any;
    let defaultOperator: any;

    switch (filterType) {
      case 'date':
        defaultValue = [null, null];
        defaultOperator = 'between';
        break;
      case 'dropdown':
        defaultValue = [];
        defaultOperator = 'in';
        break;
      case 'number':
        defaultValue = null;
        defaultOperator = 'eq';
        break;
      case 'text':
        defaultValue = '';
        defaultOperator = 'contains';
        break;
    }

    const newFilter: ExploreFilter = {
      id: uuidv4(),
      field: selectedField,
      type: filterType,
      operator: defaultOperator,
      value: defaultValue,
      label: selectedField,
    };

    onChange([...filters, newFilter]);
    setSelectedField('');
  };

  const handleUpdateFilter = (id: string, updates: Partial<ExploreFilter>) => {
    onChange(filters.map(f => f.id === id ? { ...f, ...updates } : f));
  };

  const handleRemoveFilter = (id: string) => {
    onChange(filters.filter(f => f.id !== id));
  };

  const renderDateFilter = (filter: ExploreFilter) => {
    const [start, end] = filter.value ?? [null, null];

    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700">{filter.field}</span>
          <button
            onClick={() => handleRemoveFilter(filter.id)}
            className="text-gray-400 hover:text-red-600 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex gap-2 items-center">
          <input
            type="date"
            value={start ?? ''}
            onChange={(e) => handleUpdateFilter(filter.id, { 
              value: [e.target.value || null, end] 
            })}
            className="flex-1 px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Start date"
          />
          <span className="text-xs text-gray-500">to</span>
          <input
            type="date"
            value={end ?? ''}
            onChange={(e) => handleUpdateFilter(filter.id, { 
              value: [start, e.target.value || null] 
            })}
            className="flex-1 px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="End date"
          />
        </div>
      </div>
    );
  };

  const renderDropdownFilter = (filter: ExploreFilter) => {
    const options = latestDataSample.length > 0 
      ? getDistinctValues(filter.field, latestDataSample) 
      : [];

    const selectedValues = filter.value ?? [];

    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700">{filter.field}</span>
          <button
            onClick={() => handleRemoveFilter(filter.id)}
            className="text-gray-400 hover:text-red-600 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {options.length > 0 ? (
          <select
            multiple
            value={selectedValues}
            onChange={(e) => {
              const selected = Array.from(e.target.selectedOptions).map(o => o.value);
              handleUpdateFilter(filter.id, { value: selected });
            }}
            className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-[100px]"
          >
            {options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        ) : (
          <div className="text-xs text-gray-500 italic p-2 bg-gray-50 rounded border border-gray-200">
            No data available. Run query first to see filter options.
          </div>
        )}
        {selectedValues.length > 0 && (
          <div className="text-xs text-gray-600">
            Selected: {selectedValues.length} value(s)
          </div>
        )}
      </div>
    );
  };

  const renderNumberFilter = (filter: ExploreFilter) => {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700">{filter.field}</span>
          <button
            onClick={() => handleRemoveFilter(filter.id)}
            className="text-gray-400 hover:text-red-600 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex gap-2">
          <select
            value={filter.operator}
            onChange={(e) => handleUpdateFilter(filter.id, { operator: e.target.value as any })}
            className="px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="eq">=</option>
            <option value="neq">≠</option>
            <option value="gt">&gt;</option>
            <option value="gte">≥</option>
            <option value="lt">&lt;</option>
            <option value="lte">≤</option>
          </select>
          <input
            type="number"
            value={filter.value ?? ''}
            onChange={(e) => handleUpdateFilter(filter.id, { value: e.target.value ? Number(e.target.value) : null })}
            className="flex-1 px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Value"
          />
        </div>
      </div>
    );
  };

  const renderTextFilter = (filter: ExploreFilter) => {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700">{filter.field}</span>
          <button
            onClick={() => handleRemoveFilter(filter.id)}
            className="text-gray-400 hover:text-red-600 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex gap-2">
          <select
            value={filter.operator}
            onChange={(e) => handleUpdateFilter(filter.id, { operator: e.target.value as any })}
            className="px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="contains">contains</option>
            <option value="eq">equals</option>
            <option value="starts_with">starts with</option>
          </select>
          <input
            type="text"
            value={filter.value ?? ''}
            onChange={(e) => handleUpdateFilter(filter.id, { value: e.target.value })}
            className="flex-1 px-2 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Value"
          />
        </div>
      </div>
    );
  };

  return (
    <div className="bg-white rounded-lg shadow-sm ring-1 ring-gray-200 p-4">
      <div className="flex items-center gap-2 mb-4">
        <Filter className="h-5 w-5 text-gray-600" />
        <h3 className="text-sm font-semibold text-gray-900">Filters ({filters.length})</h3>
      </div>

      {/* Existing filters */}
      {filters.length > 0 && (
        <div className="space-y-4 mb-4">
          {filters.map(filter => {
            switch (filter.type) {
              case 'date':
                return <div key={filter.id}>{renderDateFilter(filter)}</div>;
              case 'dropdown':
                return <div key={filter.id}>{renderDropdownFilter(filter)}</div>;
              case 'number':
                return <div key={filter.id}>{renderNumberFilter(filter)}</div>;
              case 'text':
                return <div key={filter.id}>{renderTextFilter(filter)}</div>;
              default:
                return null;
            }
          })}
        </div>
      )}

      {/* Add filter */}
      <div className="pt-4 border-t border-gray-200">
        <div className="flex gap-2">
          <select
            value={selectedField}
            onChange={(e) => setSelectedField(e.target.value)}
            className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Select field...</option>
            {availableFields.map(col => (
              <option key={col.name} value={col.name}>
                {col.name} ({col.type})
              </option>
            ))}
          </select>
          <button
            onClick={handleAddFilter}
            disabled={!selectedField}
            className="flex items-center gap-1 px-3 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Plus className="h-4 w-4" />
            <span className="text-sm">Add</span>
          </button>
        </div>
      </div>

      {filters.length === 0 && (
        <div className="text-center py-6 text-sm text-gray-500">
          No filters applied. Add a filter to refine your data.
        </div>
      )}
    </div>
  );
}
