'use client';

import React from 'react';
import { Filter, X } from 'lucide-react';
import { Dataset } from '@/types/api';

export interface SimpleFilter {
  field: string;
  operator: 'eq' | 'contains' | 'gt' | 'lt' | 'gte' | 'lte';
  value: string | number;
}

interface FilterPanelProps {
  dataset: Dataset | undefined;
  filters: SimpleFilter[];
  onFiltersChange: (filters: SimpleFilter[]) => void;
}

export function FilterPanel({
  dataset,
  filters,
  onFiltersChange,
}: FilterPanelProps) {
  const [selectedField, setSelectedField] = React.useState<string>('');

  const fields = dataset?.columns?.map(col => col.name) || [];

  const addFilter = () => {
    if (selectedField && !filters.find(f => f.field === selectedField)) {
      onFiltersChange([
        ...filters,
        { field: selectedField, operator: 'contains', value: '' }
      ]);
      setSelectedField('');
    }
  };

  const updateFilter = (index: number, updates: Partial<SimpleFilter>) => {
    const newFilters = [...filters];
    newFilters[index] = { ...newFilters[index], ...updates };
    onFiltersChange(newFilters);
  };

  const removeFilter = (index: number) => {
    onFiltersChange(filters.filter((_, i) => i !== index));
  };

  const getFieldType = (fieldName: string): string => {
    const col = dataset?.columns?.find(c => c.name === fieldName);
    return col?.type || 'string';
  };

  const getOperatorsForType = (type: string): Array<{ value: SimpleFilter['operator']; label: string }> => {
    const numericTypes = ['number', 'integer', 'float', 'double', 'numeric', 'FLOAT', 'INTEGER', 'NUMERIC'];
    
    if (numericTypes.includes(type)) {
      return [
        { value: 'eq', label: '=' },
        { value: 'gt', label: '>' },
        { value: 'lt', label: '<' },
        { value: 'gte', label: '>=' },
        { value: 'lte', label: '<=' },
      ];
    }
    
    return [
      { value: 'eq', label: 'equals' },
      { value: 'contains', label: 'contains' },
    ];
  };

  return (
    <div className="bg-white rounded-lg shadow-sm ring-1 ring-gray-200 p-4">
      <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center">
        <Filter className="h-4 w-4 mr-2 text-gray-500" />
        Filters ({filters.length})
      </h3>

      {/* Active Filters */}
      <div className="space-y-3 mb-4">
        {filters.map((filter, index) => {
          const fieldType = getFieldType(filter.field);
          const operators = getOperatorsForType(fieldType);
          
          return (
            <div key={index} className="p-3 bg-gray-50 rounded-md">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700">{filter.field}</span>
                <button
                  onClick={() => removeFilter(index)}
                  className="text-gray-400 hover:text-red-600 transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              
              <div className="flex gap-2">
                <select
                  value={filter.operator}
                  onChange={(e) => updateFilter(index, { operator: e.target.value as SimpleFilter['operator'] })}
                  className="px-2 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {operators.map(op => (
                    <option key={op.value} value={op.value}>
                      {op.label}
                    </option>
                  ))}
                </select>
                
                <input
                  type={fieldType.includes('number') || fieldType.includes('integer') || fieldType.includes('float') ? 'number' : 'text'}
                  value={filter.value}
                  onChange={(e) => updateFilter(index, { value: e.target.value })}
                  placeholder="Enter value..."
                  className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Add Filter */}
      {fields.length > 0 && (
        <div className="flex gap-2">
          <select
            value={selectedField}
            onChange={(e) => setSelectedField(e.target.value)}
            className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">Add filter...</option>
            {fields
              .filter(f => !filters.find(filter => filter.field === f))
              .map(field => (
                <option key={field} value={field}>
                  {field}
                </option>
              ))}
          </select>
          <button
            onClick={addFilter}
            disabled={!selectedField}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Add
          </button>
        </div>
      )}

      {fields.length === 0 && (
        <p className="text-xs text-gray-500 italic">No fields available</p>
      )}
    </div>
  );
}
