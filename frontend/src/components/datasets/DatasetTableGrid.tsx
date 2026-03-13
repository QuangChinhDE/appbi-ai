/**
 * DatasetTableGrid - NocoDB-style grid component for table data preview
 */
'use client';

import React from 'react';
import { Hash } from 'lucide-react';

export interface DatasetTableGridProps {
  columns: { name: string; type: string }[];
  rows: Record<string, any>[];
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onAddColumn?: () => void;
  onRemoveColumn?: (columnName: string) => void;
}

export function DatasetTableGrid({
  columns,
  rows,
  isLoading = false,
  error = null,
  onRetry,
  onAddColumn,
  onRemoveColumn,
}: DatasetTableGridProps) {
  const renderCellValue = (value: any): string => {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (value instanceof Date) return value.toLocaleString();
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  if (isLoading) {
    return (
      <div className="border rounded-lg overflow-hidden bg-white">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50 sticky top-0 z-10">
              <tr>
                <th className="w-16 px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r">#</th>
                {[1, 2, 3, 4, 5].map((i) => (
                  <th key={i} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    <div className="h-4 bg-gray-200 rounded animate-pulse w-24"></div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {[1, 2, 3, 4, 5].map((rowIdx) => (
                <tr key={rowIdx}>
                  <td className="w-16 px-4 py-3 text-sm text-gray-400 border-r">
                    <div className="h-4 bg-gray-100 rounded animate-pulse w-8"></div>
                  </td>
                  {[1, 2, 3, 4, 5].map((colIdx) => (
                    <td key={colIdx} className="px-4 py-3 text-sm">
                      <div className="h-4 bg-gray-100 rounded animate-pulse"></div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border rounded-lg overflow-hidden bg-white p-8">
        <div className="text-center">
          <div className="text-red-600 mb-2">
            <svg className="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-gray-900 mb-1">Failed to load data</h3>
          <p className="text-sm text-gray-500 mb-4">{error}</p>
          {onRetry && (
            <button onClick={onRetry} className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors">
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="border rounded-lg overflow-hidden bg-white p-12">
        <div className="text-center">
          <div className="text-gray-400 mb-3">
            <svg className="w-16 h-16 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-gray-900 mb-1">No data</h3>
          <p className="text-sm text-gray-500">This table has no rows</p>
        </div>
      </div>
    );
  }

  return (
    <div className="border rounded-lg overflow-hidden bg-white">
      <div className="overflow-x-auto max-h-[calc(100vh-250px)]">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50 sticky top-0 z-10">
            <tr>
              <th className="w-16 px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider border-r bg-gray-50">
                <Hash className="w-4 h-4" />
              </th>
              {columns.map((column) => (
                <th key={column.name} className="px-4 py-3 text-left text-xs font-medium text-gray-700 uppercase tracking-wider bg-gray-50 group" title={`${column.name} (${column.type})`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="truncate">{column.name}</span>
                      <span className="text-gray-400 text-[10px] font-normal normal-case">{column.type}</span>
                    </div>
                    {onRemoveColumn && (
                      <button onClick={() => onRemoveColumn(column.name)} className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-all" title={`Remove ${column.name}`}>
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                </th>
              ))}
              {onAddColumn && (
                <th className="w-16 px-4 py-3 bg-gray-50 border-l">
                  <button onClick={onAddColumn} className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors" title="Add column">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                  </button>
                </th>
              )}
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="hover:bg-gray-50 transition-colors">
                <td className="w-16 px-4 py-3 text-sm text-gray-400 border-r font-mono">{rowIndex + 1}</td>
                {columns.map((column) => {
                  const value = row[column.name];
                  const displayValue = renderCellValue(value);
                  const isLong = displayValue.length > 50;
                  return (
                    <td key={`${rowIndex}-${column.name}`} className="px-4 py-3 text-sm text-gray-900" title={isLong ? displayValue : undefined}>
                      <div className="max-w-xs truncate">{displayValue}</div>
                    </td>
                  );
                })}
                {onAddColumn && <td className="w-16 px-4 py-3 border-l"></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t bg-gray-50 px-4 py-2">
        <p className="text-xs text-gray-500">Showing {rows.length} {rows.length === 1 ? 'row' : 'rows'}</p>
      </div>
    </div>
  );
}
