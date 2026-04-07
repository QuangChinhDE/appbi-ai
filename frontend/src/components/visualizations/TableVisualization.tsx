'use client';

import React, { useMemo } from 'react';
import clsx from 'clsx';
import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import {
  SortConfig,
  ConditionalFormatRule,
  TableHeatmapRule,
  TableSummaryRowConfig,
} from '@/types/api';
import {
  buildTableHeatmapStats,
  getCellStyle,
  getHeatmapCellStyle,
  parseNumericCellValue,
} from '@/lib/exploreAggregations';

export interface TableVisualizationProps {
  data: Record<string, any>[];
  columns?: string[];
  maxRows?: number;
  className?: string;
  // Explore 2.0 features
  sorts?: SortConfig[];
  onSortChange?: (sorts: SortConfig[]) => void;
  conditionalFormatting?: ConditionalFormatRule[];
  heatmapRules?: TableHeatmapRule[];
  summaryRows?: TableSummaryRowConfig[];
  showSummaryRow?: boolean;
  summaryLabel?: string;
  summaryLabelColumn?: string;
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
  heatmapRules = [],
  summaryRows,
  showSummaryRow,
  summaryLabel = 'Total',
  summaryLabelColumn,
  onRowClick,
  enableDrilldown = false
}: TableVisualizationProps) {
  const rows = data ?? [];
  const cols = columns ?? (rows.length > 0 ? Object.keys(rows[0]) : []);

  if (cols.length === 0 || rows.length === 0) {
    return (
      <div className={clsx("p-8", className)}>
        <div className="text-center text-sm text-gray-500">
          No data to display.
        </div>
      </div>
    );
  }

  const displayRows = rows.slice(0, maxRows);
  const numericColumns = useMemo(
    () => cols.filter((col) => rows.some((row) => parseNumericCellValue(row?.[col]) !== null)),
    [cols, rows],
  );
  const resolvedSummaryLabelColumn = useMemo(() => {
    if (summaryLabelColumn && cols.includes(summaryLabelColumn)) {
      return summaryLabelColumn;
    }

    return cols.find((col) => !numericColumns.includes(col)) ?? '';
  }, [cols, numericColumns, summaryLabelColumn]);
  const heatmapStats = useMemo(
    () => buildTableHeatmapStats(rows, heatmapRules),
    [heatmapRules, rows],
  );
  const resolvedSummaryRows = useMemo<TableSummaryRowConfig[]>(() => {
    if (showSummaryRow === false) {
      return [];
    }

    if (summaryRows && summaryRows.length > 0) {
      return summaryRows;
    }

    if (showSummaryRow) {
      return [{
        label: summaryLabel,
        calculation: 'sum',
        labelColumn: summaryLabelColumn,
      }];
    }

    return [];
  }, [showSummaryRow, summaryRows, summaryLabel, summaryLabelColumn]);
  const summaryRowsData = useMemo(() => {
    if (resolvedSummaryRows.length === 0) {
      return [] as Record<string, any>[];
    }

    return resolvedSummaryRows.map((summaryRow) => {
      const totalRow: Record<string, any> = {};
      const labelColumn = resolveSummaryLabelColumn(
        summaryRow.labelColumn,
        cols,
        numericColumns,
        resolvedSummaryLabelColumn,
      );
      const targetColumns = summaryRow.columns && summaryRow.columns.length > 0
        ? summaryRow.columns.filter((column) => numericColumns.includes(column))
        : numericColumns;

      cols.forEach((col) => {
        if (col === labelColumn) {
          totalRow[col] = summaryRow.label || 'Total';
          return;
        }

        if (!targetColumns.includes(col)) {
          totalRow[col] = '';
          return;
        }

        totalRow[col] = calculateSummaryValue(rows, col, summaryRow.calculation ?? 'sum');
      });

      return totalRow;
    });
  }, [cols, numericColumns, resolvedSummaryLabelColumn, resolvedSummaryRows, rows]);
  
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
    <div className={clsx("h-full overflow-auto", className)}>
      <table className="min-w-full border-separate border-spacing-0 text-sm">
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
                  const heatmapStyle = getHeatmapCellStyle(cellValue, col, heatmapRules, heatmapStats);
                  const conditionalStyle = getCellStyle(cellValue, col, conditionalFormatting, row);
                  const style = Object.keys(conditionalStyle).length > 0 ? conditionalStyle : heatmapStyle;
                  
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
          {summaryRowsData.length > 0 && (
            <tfoot className="sticky bottom-0 z-20 shadow-[0_-10px_20px_rgba(15,23,42,0.08)]">
              {summaryRowsData.map((summaryRow, summaryIndex) => (
                <tr
                  key={`summary-row-${summaryIndex}`}
                  className={clsx(
                    "font-semibold text-slate-900",
                    summaryIndex % 2 === 0 ? "bg-slate-100" : "bg-slate-50",
                  )}
                >
                  {cols.map((col) => (
                    <td
                      key={`summary-${summaryIndex}-${col}`}
                      className={clsx(
                        "px-4 py-2.5 border-b border-slate-200",
                        summaryIndex % 2 === 0 ? "bg-slate-100" : "bg-slate-50",
                        summaryIndex === 0 && "border-t-2 border-slate-300",
                      )}
                    >
                      {formatCellValue(summaryRow[col])}
                    </td>
                  ))}
                </tr>
              ))}
            </tfoot>
          )}
        </table>
      
      {rows.length > maxRows && (
        <div className="px-4 py-2 bg-gray-50 border-t border-gray-200 text-xs text-gray-500 text-center">
          Showing {maxRows} of {rows.length} rows
          {summaryRowsData.length > 0 ? ` | Summary uses all ${rows.length} rows` : ''}
        </div>
      )}
    </div>
  );
}

function resolveSummaryLabelColumn(
  labelColumn: string | undefined,
  columns: string[],
  numericColumns: string[],
  fallbackLabelColumn: string,
): string {
  if (labelColumn && columns.includes(labelColumn)) {
    return labelColumn;
  }

  if (fallbackLabelColumn && columns.includes(fallbackLabelColumn)) {
    return fallbackLabelColumn;
  }

  return columns.find((column) => !numericColumns.includes(column)) ?? columns[0] ?? '';
}

function calculateSummaryValue(
  rows: Record<string, any>[],
  column: string,
  calculation: TableSummaryRowConfig['calculation'],
): number | string {
  const rawValues = rows
    .map((row) => row?.[column])
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== '');
  const numericValues = rawValues
    .map((value) => parseNumericCellValue(value))
    .filter((value): value is number => value !== null);

  switch (calculation) {
    case 'avg':
      return numericValues.length > 0
        ? numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length
        : '';
    case 'count':
      return rawValues.length;
    case 'min':
      return numericValues.length > 0 ? Math.min(...numericValues) : '';
    case 'max':
      return numericValues.length > 0 ? Math.max(...numericValues) : '';
    case 'count_distinct':
      return new Set(rawValues.map((value) => {
        const numericValue = parseNumericCellValue(value);
        return numericValue ?? String(value);
      })).size;
    case 'sum':
    default:
      return numericValues.length > 0
        ? numericValues.reduce((sum, value) => sum + value, 0)
        : '';
  }
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
