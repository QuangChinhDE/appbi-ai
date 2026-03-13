/**
 * Pivot Controls Component
 * Allows users to select a dimension to pivot on
 */
'use client';

import React from 'react';

interface PivotControlsProps {
  dimensions: string[];
  selectedPivot: string | null;
  onPivotChange: (dimension: string | null) => void;
}

export function PivotControls({ dimensions, selectedPivot, onPivotChange }: PivotControlsProps) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900">Pivot</h3>
        {selectedPivot && (
          <button
            onClick={() => onPivotChange(null)}
            className="text-xs text-red-600 hover:text-red-700"
          >
            Clear
          </button>
        )}
      </div>
      
      <div className="space-y-2">
        <select
          value={selectedPivot || ''}
          onChange={(e) => onPivotChange(e.target.value || null)}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">No pivot</option>
          {dimensions.map((dim) => (
            <option key={dim} value={dim}>
              {dim}
            </option>
          ))}
        </select>
        
        {selectedPivot && (
          <div className="text-xs text-gray-600 bg-blue-50 px-2 py-1 rounded">
            <span className="font-medium">Pivoting on:</span> {selectedPivot}
          </div>
        )}
        
        <p className="text-xs text-gray-500">
          Pivot turns distinct values of a dimension into columns
        </p>
      </div>
    </div>
  );
}
