/**
 * Sort Controls Component
 * Allows users to define sorting with multiple fields
 */
'use client';

import React from 'react';
import { X, Plus } from 'lucide-react';

interface SortDefinition {
  field: string;
  direction: 'asc' | 'desc';
}

interface SortControlsProps {
  availableFields: string[];
  sorts: SortDefinition[];
  onSortsChange: (sorts: SortDefinition[]) => void;
}

export function SortControls({ availableFields, sorts, onSortsChange }: SortControlsProps) {
  const addSort = () => {
    if (availableFields.length > 0) {
      onSortsChange([...sorts, { field: availableFields[0], direction: 'desc' }]);
    }
  };

  const removeSort = (index: number) => {
    onSortsChange(sorts.filter((_, i) => i !== index));
  };

  const updateSort = (index: number, updates: Partial<SortDefinition>) => {
    const newSorts = [...sorts];
    newSorts[index] = { ...newSorts[index], ...updates };
    onSortsChange(newSorts);
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900">Sort</h3>
        <button
          onClick={addSort}
          disabled={availableFields.length === 0}
          className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 rounded disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus className="w-3 h-3" />
          Add
        </button>
      </div>

      <div className="space-y-2">
        {sorts.length === 0 ? (
          <p className="text-xs text-gray-500 italic">No sorting applied</p>
        ) : (
          sorts.map((sort, index) => (
            <div key={index} className="flex items-center gap-2">
              <select
                value={sort.field}
                onChange={(e) => updateSort(index, { field: e.target.value })}
                className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {availableFields.map((field) => (
                  <option key={field} value={field}>
                    {field}
                  </option>
                ))}
              </select>
              
              <select
                value={sort.direction}
                onChange={(e) => updateSort(index, { direction: e.target.value as 'asc' | 'desc' })}
                className="px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="asc">↑ Asc</option>
                <option value="desc">↓ Desc</option>
              </select>
              
              <button
                onClick={() => removeSort(index)}
                className="p-1 text-gray-400 hover:text-red-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
