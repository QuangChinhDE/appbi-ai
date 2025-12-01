/**
 * Query Runner Component
 * Ad-hoc SQL query execution with results display
 */
'use client';

import { useState } from 'react';
import { DataSource, QueryExecuteResponse } from '@/types/api';
import { Play, Loader2, Clock, Hash } from 'lucide-react';

interface QueryRunnerProps {
  dataSources: DataSource[];
  onExecute: (params: {
    data_source_id: number;
    sql_query: string;
    limit: number;
    timeout_seconds: number;
  }) => void;
  result: QueryExecuteResponse | null;
  isExecuting: boolean;
  error: string | null;
}

export default function QueryRunner({
  dataSources,
  onExecute,
  result,
  isExecuting,
  error,
}: QueryRunnerProps) {
  const [selectedDataSourceId, setSelectedDataSourceId] = useState<number | null>(
    dataSources[0]?.id || null
  );
  const [sqlQuery, setSqlQuery] = useState('SELECT * FROM ');
  const [limit, setLimit] = useState(100);
  const [timeout, setTimeout] = useState(30);

  const handleExecute = () => {
    if (!selectedDataSourceId || !sqlQuery.trim()) return;
    onExecute({
      data_source_id: selectedDataSourceId,
      sql_query: sqlQuery,
      limit,
      timeout_seconds: timeout,
    });
  };

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="space-y-3">
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Data Source
            </label>
            <select
              value={selectedDataSourceId || ''}
              onChange={(e) => setSelectedDataSourceId(Number(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={dataSources.length === 0}
            >
              <option value="">Select a data source...</option>
              {dataSources.map((ds) => (
                <option key={ds.id} value={ds.id}>
                  {ds.name} ({ds.type})
                </option>
              ))}
            </select>
          </div>
          <div className="w-32">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Limit
            </label>
            <input
              type="number"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              min={1}
              max={10000}
            />
          </div>
          <div className="w-32">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Timeout (s)
            </label>
            <input
              type="number"
              value={timeout}
              onChange={(e) => setTimeout(Number(e.target.value))}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              min={1}
              max={300}
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            SQL Query
          </label>
          <textarea
            value={sqlQuery}
            onChange={(e) => setSqlQuery(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
            rows={6}
            placeholder="SELECT * FROM table_name WHERE condition"
          />
          <p className="text-xs text-gray-500 mt-1">
            Only SELECT queries are allowed for safety
          </p>
        </div>

        <button
          onClick={handleExecute}
          disabled={!selectedDataSourceId || !sqlQuery.trim() || isExecuting}
          className="px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {isExecuting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Executing...
            </>
          ) : (
            <>
              <Play className="w-4 h-4" />
              Run Query
            </>
          )}
        </button>
      </div>

      {/* Error Display */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-md">
          <p className="text-sm text-red-800 font-medium mb-1">Query Error</p>
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Results Display */}
      {result && (
        <div className="space-y-3">
          <div className="flex items-center gap-4 text-sm text-gray-600">
            <div className="flex items-center gap-1">
              <Hash className="w-4 h-4" />
              <span>{result.row_count} rows</span>
            </div>
            <div className="flex items-center gap-1">
              <Clock className="w-4 h-4" />
              <span>{result.execution_time_ms}ms</span>
            </div>
          </div>

          <div className="border border-gray-200 rounded-md overflow-hidden">
            <div className="overflow-x-auto max-h-96">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    {result.columns.map((col) => (
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
                  {result.data.length === 0 ? (
                    <tr>
                      <td
                        colSpan={result.columns.length}
                        className="px-4 py-8 text-center text-gray-500"
                      >
                        No results found
                      </td>
                    </tr>
                  ) : (
                    result.data.map((row, idx) => (
                      <tr key={idx} className="hover:bg-gray-50">
                        {result.columns.map((col) => (
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
      )}
    </div>
  );
}
