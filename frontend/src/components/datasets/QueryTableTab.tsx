/**
 * QueryTableTab - Create tables from SQL queries
 */
'use client';

import React, { useState } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { useDataSources } from '@/hooks/use-datasources';
import type { AddTableInput } from '@/hooks/use-dataset-workspaces';

interface QueryTableTabProps {
  onAddTable: (input: AddTableInput) => Promise<void>;
  isLoading: boolean;
}

export function QueryTableTab({ onAddTable, isLoading }: QueryTableTabProps) {
  const [selectedDatasourceId, setSelectedDatasourceId] = useState<number | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [query, setQuery] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const { data: datasources, isLoading: loadingDatasources } = useDataSources();

  const validateQuery = (sql: string): string | null => {
    const trimmed = sql.trim();
    
    if (!trimmed) {
      return 'Query cannot be empty';
    }
    
    if (!trimmed.toLowerCase().startsWith('select')) {
      return 'Query must start with SELECT';
    }
    
    // Check for dangerous keywords
    const dangerous = ['delete', 'drop', 'truncate', 'alter', 'create', 'insert', 'update'];
    const upperQuery = trimmed.toUpperCase();
    for (const keyword of dangerous) {
      const pattern = new RegExp(`\\b${keyword.toUpperCase()}\\b`);
      if (pattern.test(upperQuery)) {
        return `Dangerous keyword not allowed: ${keyword.toUpperCase()}`;
      }
    }
    
    // Check for semicolons
    if (trimmed.includes(';')) {
      return 'Multiple statements not allowed (no semicolons)';
    }
    
    // Check for comments
    if (trimmed.includes('--') || trimmed.includes('/*')) {
      return 'SQL comments not allowed';
    }
    
    return null;
  };

  const handleQueryChange = (value: string) => {
    setQuery(value);
    // Clear validation error when user types
    if (validationError) {
      setValidationError(null);
    }
  };

  const handleAdd = async () => {
    if (!selectedDatasourceId || !displayName.trim() || !query.trim()) return;

    // Validate query
    const error = validateQuery(query);
    if (error) {
      setValidationError(error);
      return;
    }

    await onAddTable({
      datasource_id: selectedDatasourceId,
      source_kind: 'sql_query',
      source_query: query.trim(),
      display_name: displayName.trim(),
      enabled: true,
    });
  };

  const canAdd = selectedDatasourceId && displayName.trim() && query.trim() && !isLoading;

  return (
    <div className="p-6 space-y-6">
      {/* Datasource selector */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Select Datasource *
        </label>
        <select
          value={selectedDatasourceId || ''}
          onChange={(e) => setSelectedDatasourceId(Number(e.target.value) || null)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={loadingDatasources || isLoading}
        >
          <option value="">Choose a datasource...</option>
          {datasources?.map((ds) => (
            <option key={ds.id} value={ds.id}>
              {ds.name} ({ds.type})
            </option>
          ))}
        </select>
        <p className="text-xs text-gray-500 mt-1">
          The query will be executed against this datasource
        </p>
      </div>

      {/* Display name */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Display Name *
        </label>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="e.g., Monthly Sales Report"
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={isLoading}
        />
        <p className="text-xs text-gray-500 mt-1">
          This name will be shown in the workspace
        </p>
      </div>

      {/* SQL Query */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          SQL Query *
        </label>
        <textarea
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder={`SELECT 
  order_id,
  customer_name,
  total_amount,
  order_date
FROM orders
WHERE order_date >= '2024-01-01'`}
          className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 font-mono text-sm h-64 resize-y ${
            validationError
              ? 'border-red-300 focus:ring-red-500'
              : 'border-gray-300 focus:ring-blue-500'
          }`}
          disabled={isLoading}
        />
        
        {validationError && (
          <div className="mt-2 flex items-start gap-2 text-red-600 text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{validationError}</span>
          </div>
        )}
        
        <div className="mt-2 space-y-1">
          <p className="text-xs text-gray-500">
            • Only SELECT statements are allowed
          </p>
          <p className="text-xs text-gray-500">
            • No multiple statements (semicolons), comments, or dangerous keywords
          </p>
          <p className="text-xs text-gray-500">
            • Query will be wrapped as a subquery: SELECT * FROM (your_query) AS custom_query
          </p>
        </div>
      </div>

      {/* Action button */}
      <div className="flex justify-end pt-4 border-t">
        <button
          onClick={handleAdd}
          disabled={!canAdd}
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
          Add Table from Query
        </button>
      </div>
    </div>
  );
}
