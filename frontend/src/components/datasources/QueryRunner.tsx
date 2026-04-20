/**
 * Query Runner Component
 * Ad-hoc SQL query execution with results display
 */
'use client';

import { useState } from 'react';
import { DataSource, QueryExecuteResponse } from '@/types/api';
import { Play, Loader2, Clock, Hash } from 'lucide-react';
import { SqlEditor, type SqlDialect } from '@/components/ui/SqlEditor';

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

  const selectedDs = dataSources.find(ds => ds.id === selectedDataSourceId);
  const sqlDialect: SqlDialect = (() => {
    switch (selectedDs?.type) {
      case 'bigquery': return 'bigquery';
      case 'mysql': return 'mysql';
      case 'postgresql': return 'postgresql';
      default: return 'standard';
    }
  })();

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
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Data Source
            </label>
            <select
              value={selectedDataSourceId || ''}
              onChange={(e) => setSelectedDataSourceId(Number(e.target.value))}
              className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
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
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Limit
            </label>
            <input
              type="number"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
              min={1}
              max={10000}
            />
          </div>
          <div className="w-32">
            <label className="block text-sm font-medium text-text-secondary mb-1">
              Timeout (s)
            </label>
            <input
              type="number"
              value={timeout}
              onChange={(e) => setTimeout(Number(e.target.value))}
              className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
              min={1}
              max={300}
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1">
            SQL Query
          </label>
          <SqlEditor
            value={sqlQuery}
            onChange={setSqlQuery}
            dialect={sqlDialect}
            placeholder="SELECT * FROM table_name WHERE condition"
            height="200px"
            hasError={!!error}
          />
          <p className="text-xs text-text-tertiary mt-1">
            💡 Only SELECT queries are supported
          </p>
        </div>

        <button
          onClick={handleExecute}
          disabled={!selectedDataSourceId || !sqlQuery.trim() || isExecuting}
          className="px-4 py-2 bg-success text-white rounded-md hover:bg-success/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
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
        <div className="p-4 bg-danger/10 border border-danger/30 rounded-md">
          <p className="text-sm text-danger font-medium mb-1">Query Error</p>
          <p className="text-sm text-danger">{error}</p>
        </div>
      )}

      {/* Results Display */}
      {result && (
        <div className="space-y-3">
          <div className="flex items-center gap-4 text-sm text-text-secondary">
            <div className="flex items-center gap-1">
              <Hash className="w-4 h-4" />
              <span>{result.row_count} rows</span>
            </div>
            <div className="flex items-center gap-1">
              <Clock className="w-4 h-4" />
              <span>{result.execution_time_ms}ms</span>
            </div>
          </div>

          <div className="border border-[rgb(var(--border-line))] rounded-md overflow-hidden">
            <div className="overflow-x-auto max-h-96">
              <table className="min-w-full divide-y divide-[rgb(var(--border-line))]">
                <thead className="bg-surface-2 sticky top-0">
                  <tr>
                    {result.columns.map((col) => (
                      <th
                        key={col}
                        className="px-4 py-2 text-left text-xs font-medium text-text-tertiary uppercase tracking-wider"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[rgb(var(--border-line))] bg-surface-1">
                  {result.data.length === 0 ? (
                    <tr>
                      <td
                        colSpan={result.columns.length}
                        className="px-4 py-8 text-center text-text-tertiary"
                      >
                        No results found
                      </td>
                    </tr>
                  ) : (
                    result.data.map((row, idx) => (
                      <tr key={idx} className="hover:bg-surface-2">
                        {result.columns.map((col) => (
                          <td key={col} className="px-4 py-2 text-sm text-text-primary whitespace-nowrap">
                            {row[col] === null ? (
                              <span className="text-text-quaternary italic">null</span>
                            ) : typeof row[col] === 'object' ? (
                              <span className="text-text-secondary font-mono text-xs">
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
