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
      <div className="flex items-center gap-4 text-caption text-text-tertiary">
        <div className="flex items-center gap-1.5">
          <Hash className="w-3.5 h-3.5" />
          <span>{rowCount} rows</span>
        </div>
        {executionTimeMs !== undefined && (
          <div className="flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" />
            <span>{executionTimeMs}ms</span>
          </div>
        )}
      </div>

      <div className="border border-[rgb(var(--border-line))] rounded-lg overflow-hidden bg-surface-1">
        <div className="overflow-x-auto max-h-96">
          <table className="min-w-full">
            <thead className="bg-surface-2 sticky top-0">
              <tr>
                {columns.map((col) => (
                  <th
                    key={col}
                    className="px-4 py-2 text-left text-tiny font-emphasis text-text-tertiary uppercase tracking-wider border-b border-[rgb(var(--border-line))]"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.length === 0 ? (
                <tr>
                  <td
                    colSpan={columns.length}
                    className="px-4 py-10 text-center text-caption text-text-tertiary"
                  >
                    No results found
                  </td>
                </tr>
              ) : (
                data.map((row, idx) => (
                  <tr
                    key={idx}
                    className="hover:bg-surface-2 border-b border-[rgb(var(--border-line))] last:border-b-0 transition-colors"
                  >
                    {columns.map((col) => (
                      <td
                        key={col}
                        className="px-4 py-2 text-caption text-text-primary whitespace-nowrap"
                      >
                        {row[col] === null ? (
                          <span className="text-text-quaternary italic">null</span>
                        ) : typeof row[col] === 'object' ? (
                          <span className="text-text-tertiary font-mono text-tiny">
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
