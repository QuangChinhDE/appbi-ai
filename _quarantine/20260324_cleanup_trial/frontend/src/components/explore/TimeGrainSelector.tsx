/**
 * Time Grain Selector Component
 * Allows users to set time granularity for date dimensions
 */
'use client';

import React from 'react';

interface TimeGrainSelectorProps {
  dateDimensions: string[];
  timeGrains: Record<string, string>;
  onTimeGrainChange: (dimension: string, grain: string | null) => void;
}

const GRAIN_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'Year' },
];

export function TimeGrainSelector({ dateDimensions, timeGrains, onTimeGrainChange }: TimeGrainSelectorProps) {
  if (dateDimensions.length === 0) {
    return null;
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
      <h3 className="text-sm font-semibold text-gray-900 mb-3">Time Granularity</h3>
      
      <div className="space-y-3">
        {dateDimensions.map((dim) => (
          <div key={dim} className="flex items-center gap-2">
            <span className="text-xs text-gray-700 flex-1 truncate">{dim}</span>
            <select
              value={timeGrains[dim] || ''}
              onChange={(e) => onTimeGrainChange(dim, e.target.value || null)}
              className="px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {GRAIN_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}
