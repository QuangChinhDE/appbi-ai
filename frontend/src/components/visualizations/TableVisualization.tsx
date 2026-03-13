'use client';

import React from 'react';
import clsx from 'clsx';
import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import { SortConfig, ConditionalFormatRule } from '@/types/api';
import { getCellStyle } from '@/lib/exploreAggregations';

export interface TableVisualizationProps {
  data: Record<string, any>[];
  columns?: string[];
  maxRows?: number;
  className?: string;
  // Explore 2.0 features
  sorts?: SortConfig[];
  onSortChange?: (sorts: SortConfig[]) => void;
  conditionalFormatting?: ConditionalFormatRule[];
  onRowClick?: (row: any) => void; // Drilldown trigger
  enableDrilldown?: boolean;
}

export function TableVisualization({ 
  data, 
  columns, 
  maxRows = 200, 
  className,
  sorts = [],
  onSortChange,
  conditionalFormatting = [],
  onRowClick,
  enableDrilldown = false
}: TableVisualizationProps) {
  const rows = data ?? [];
  const cols = columns ?? (rows.length > 0 ? Object.keys(rows[0]) : []);

  if (cols.length === 0 || rows.length === 0) {
    return (
      <div className={clsx("bg-white rounded-lg shadow-sm ring-1 ring-gray-200 p-8", className)}>
        <div className="text-center text-sm text-gray-500">
          No data to display.
        </div>
      </div>
    );
  }

  const displayRows = rows.slice(0, maxRows);
  
  // Handle column header click for sorting
  const handleHeaderClick = (column: string) => {
    if (!onSortChange) return;
    
    const existingSort = sorts.find(s => s.field === column);
    let newSorts: SortConfig[];
    
    if (!existingSort) {
      // Add new sort (ascending) with highest priority (index 0)
      newSorts = [
        { field: column, direction: 'asc', index: 0 },
        ...sorts.map(s => ({ ...s, index: s.index + 1 }))
      ];
    } else if (existingSort.direction === 'asc') {
      // Change to descending
      newSorts = sorts.map(s => 
        s.field === column ? { ...s, direction: 'desc' as const } : s
      );
    } else {
      // Remove sort
      newSorts = sorts
        .filter(s => s.field !== column)
        .map((s, idx) => ({ ...s, index: idx }));
    }
    
    onSortChange(newSorts);
  };
  
  // Get sort indicator for a column
  const getSortIndicator = (column: string) => {
    const sort = sorts.find(s => s.field === column);
    if (!sort) {
      return onSortChange ? <ArrowUpDown className="h-3 w-3 text-gray-400" /> : null;
    }
    
    const Icon = sort.direction === 'asc' ? ArrowUp : ArrowDown;
    const priority = sorts.length > 1 ? ` (${sort.index + 1})` : '';
    
    return (
      <span className="inline-flex items-center ml-1">
        <Icon className="h-3 w-3 text-blue-600" />
        {priority && <span className="text-[10px] text-blue-600">{priority}</span>}
      </span>
    );
  };

  return (
    <div className={clsx("bg-white rounded-lg shadow-sm ring-1 ring-gray-200 overflow-auto", className)}>
      <div className="max-h-[480px] overflow-auto">
        <table className="min-w-full text-sm border-collapse">
          <thead className="bg-gray-50 sticky top-0 z-10">
            <tr>
              {cols.map((col) => (
                <th 
                  key={col} 
                  className={clsx(
                    "px-4 py-3 text-left font-semibold text-gray-700 border-b-2 border-gray-200 whitespace-nowrap",
                    onSortChange && "cursor-pointer hover:bg-gray-100 select-none"
                  )}
                  onClick={() => handleHeaderClick(col)}
                >
                  <div className="flex items-center">
                    <span>{col}</span>
                    {getSortIndicator(col)}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, i) => (
              <tr 
                key={i} 
                className={clsx(
                  "transition-colors",
                  i % 2 === 0 ? "bg-white" : "bg-gray-50",
                  enableDrilldown && onRowClick && "cursor-pointer hover:bg-blue-50"
                )}
                onClick={() => enableDrilldown && onRowClick?.(row)}
              >
                {cols.map((col) => {
                  const cellValue = row[col];
                  const style = getCellStyle(cellValue, col, conditionalFormatting);
                  
                  return (
                    <td 
                      key={col} 
                      className="px-4 py-2.5 border-b border-gray-100"
                      style={style}
                    >
                      {formatCellValue(cellValue)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      
      {rows.length > maxRows && (
        <div className="px-4 py-2 bg-gray-50 border-t border-gray-200 text-xs text-gray-500 text-center">
          Showing {maxRows} of {rows.length} rows
        </div>
      )}
    </div>
  );
}

function formatCellValue(value: any): string {
  if (value === null || value === undefined) {
    return '';
  }
  
  if (typeof value === 'number') {
    // Format numbers with thousands separator
    return value.toLocaleString();
  }
  
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  
  return String(value);
}
