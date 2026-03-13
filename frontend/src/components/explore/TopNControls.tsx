/**
 * Top N Controls Component
 * Allows users to limit results to top N by a specific field
 */
'use client';

import React from 'react';

interface TopNControlsProps {
  availableFields: string[];
  topN: { field: string; n: number } | null;
  onTopNChange: (topN: { field: string; n: number } | null) => void;
}

export function TopNControls({ availableFields, topN, onTopNChange }: TopNControlsProps) {
  const handleToggle = () => {
    if (topN) {
      onTopNChange(null);
    } else if (availableFields.length > 0) {
      onTopNChange({ field: availableFields[0], n: 10 });
    }
  };

  const handleFieldChange = (field: string) => {
    if (topN) {
      onTopNChange({ ...topN, field });
    }
  };

  const handleNChange = (n: number) => {
    if (topN) {
      onTopNChange({ ...topN, n });
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900">Top N Filter</h3>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={!!topN}
            onChange={handleToggle}
            disabled={availableFields.length === 0}
            className="sr-only peer"
          />
          <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
        </label>
      </div>

      {topN && (
        <div className="space-y-2">
          <div>
            <label className="block text-xs text-gray-600 mb-1">Field</label>
            <select
              value={topN.field}
              onChange={(e) => handleFieldChange(e.target.value)}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {availableFields.map((field) => (
                <option key={field} value={field}>
                  {field}
                </option>
              ))}
            </select>
          </div>
          
          <div>
            <label className="block text-xs text-gray-600 mb-1">Limit</label>
            <input
              type="number"
              min="1"
              max="1000"
              value={topN.n}
              onChange={(e) => handleNChange(parseInt(e.target.value) || 10)}
              className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          
          <p className="text-xs text-gray-500">
            Show only top {topN.n} results by {topN.field}
          </p>
        </div>
      )}
    </div>
  );
}
