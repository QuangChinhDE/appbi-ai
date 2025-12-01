/**
 * Reusable Result Table Component
 * Displays query execution results
 */
'use client';

import { Clock, Hash } from 'lucide-react';

interface ResultTableProps {
  columns: string[];
  data: Record<string, any>[];
  rowCount: number;
  executionTimeMs?: number;
}

export default function ResultTable({
  columns,
  data,
  rowCount,
  executionTimeMs,
}: ResultTableProps) {
  return (
    <div className="space-y-3">
      {/* Metadata */}
      <div className="flex items-center gap-4 text-sm text-gray-600">
        <div className="flex items-center gap-1">
          <Hash className="w-4 h-4" />
          <span>{rowCount} rows</span>
        </div>
        {executionTimeMs !== undefined && (
          <div className="flex items-center gap-1">
            <Clock className="w-4 h-4" />
            <span>{executionTimeMs}ms</span>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="border border-gray-200 rounded-md overflow-hidden">
        <div className="overflow-x-auto max-h-96">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                {columns.map((col) => (
                  <th
                    key={col}
                    className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {data.length === 0 ? (
                <tr>
                  <td
                    colSpan={columns.length}
                    className="px-4 py-8 text-center text-gray-500"
                  >
                    No results found
                  </td>
                </tr>
              ) : (
                data.map((row, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    {columns.map((col) => (
                      <td key={col} className="px-4 py-2 text-sm text-gray-900 whitespace-nowrap">
                        {row[col] === null ? (
                          <span className="text-gray-400 italic">null</span>
                        ) : typeof row[col] === 'object' ? (
                          <span className="text-gray-600 font-mono text-xs">
                            {JSON.stringify(row[col])}
                          </span>
                        ) : (
                          String(row[col])
                        )}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
