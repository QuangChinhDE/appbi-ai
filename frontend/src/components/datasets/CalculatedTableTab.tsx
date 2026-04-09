'use client';

import React, { useMemo, useRef, useState } from 'react';
import { AlertCircle, Loader2, Sigma, TableProperties } from 'lucide-react';

import type { AddTableInput, DatasetTable } from '@/hooks/use-datasets';
import { buildDatasetTableAliasMap } from '@/lib/dataset-table-aliases';

interface CalculatedTableTabProps {
  onAddTable?: (input: AddTableInput) => Promise<void>;
  onSave?: (displayName: string, query: string) => void;
  isLoading: boolean;
  availableTables: DatasetTable[];
  excludeTableId?: number | null;
  initialDisplayName?: string;
  initialQuery?: string;
  saveError?: string | null;
}

function getTableKindLabel(table: DatasetTable): string {
  if (table.source_kind === 'generated_calendar') return 'Calendar';
  if (table.source_kind === 'derived_table') return 'Calculated';
  if (table.source_kind === 'sql_query') return 'SQL';
  return 'Source';
}

function getTableSecondaryLabel(table: DatasetTable): string {
  if (table.source_kind === 'generated_calendar') return 'Standard Date table';
  if (table.source_kind === 'derived_table') return 'Calculated from dataset SQL';
  if (table.source_kind === 'sql_query') return 'SQL query source';
  return table.source_table_name || 'Imported source table';
}

export function CalculatedTableTab({
  onAddTable,
  onSave,
  isLoading,
  availableTables,
  excludeTableId = null,
  initialDisplayName = '',
  initialQuery = '',
  saveError,
}: CalculatedTableTabProps) {
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [query, setQuery] = useState(initialQuery);
  const [search, setSearch] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const aliasByTableId = useMemo(() => buildDatasetTableAliasMap(availableTables), [availableTables]);

  const referenceTables = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return availableTables
      .filter((table) => excludeTableId == null || table.id !== excludeTableId)
      .filter((table) => {
        if (!normalizedSearch) return true;
        return (
          table.display_name.toLowerCase().includes(normalizedSearch) ||
          (table.source_table_name ?? '').toLowerCase().includes(normalizedSearch) ||
          (aliasByTableId[table.id] ?? '').includes(normalizedSearch)
        );
      });
  }, [aliasByTableId, availableTables, excludeTableId, search]);

  const exampleAlias = referenceTables[0] ? aliasByTableId[referenceTables[0].id] : 'orders';

  const insertAlias = (alias: string) => {
    const textarea = textareaRef.current;
    const nextValue = alias;
    if (!textarea) {
      setQuery((current) => `${current}${current.trim() ? '\n' : ''}${nextValue}`);
      return;
    }

    const start = textarea.selectionStart ?? query.length;
    const end = textarea.selectionEnd ?? query.length;
    const prefix = query.slice(0, start);
    const suffix = query.slice(end);
    const updated = `${prefix}${alias}${suffix}`;
    setQuery(updated);
    setValidationError(null);

    requestAnimationFrame(() => {
      textarea.focus();
      const cursor = start + alias.length;
      textarea.setSelectionRange(cursor, cursor);
    });
  };

  const validateQuery = (sql: string): string | null => {
    const trimmed = sql.trim();
    if (!trimmed) return 'SQL is required';
    const normalized = trimmed.toLowerCase();
    if (!(normalized.startsWith('select') || normalized.startsWith('with'))) {
      return 'Calculated table SQL must start with SELECT or WITH';
    }
    if (trimmed.includes(';')) return 'Only one SQL statement is allowed';
    if (trimmed.includes('--') || trimmed.includes('/*')) return 'SQL comments are not allowed';
    return null;
  };

  const handleSubmit = async () => {
    const cleanedQuery = query.trim();
    const error = validateQuery(cleanedQuery);
    if (error) {
      setValidationError(error);
      return;
    }
    setValidationError(null);

    if (onSave) {
      onSave(displayName.trim(), cleanedQuery);
      return;
    }

    if (onAddTable) {
      await onAddTable({
        datasource_id: null,
        source_kind: 'derived_table',
        source_query: cleanedQuery,
        display_name: displayName.trim(),
        enabled: true,
      });
    }
  };

  const canSubmit = Boolean(displayName.trim() && query.trim()) && !isLoading;

  return (
    <div className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-5">
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">Calculated table name *</label>
          <input
            type="text"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="e.g. Monthly Revenue"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={isLoading}
          />
          <p className="mt-1 text-xs text-gray-500">This is the name shown inside the dataset.</p>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="block text-sm font-medium text-gray-700">Dataset SQL *</label>
            <span className="text-xs text-gray-500">Use only tables from this dataset</span>
          </div>
          <textarea
            ref={textareaRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setValidationError(null);
            }}
            placeholder={`WITH agg AS (\n  SELECT * FROM ${exampleAlias}\n)\nSELECT * FROM agg`}
            className={`h-80 w-full resize-y rounded-md border px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 ${
              validationError ? 'border-red-300 focus:ring-red-500' : 'border-gray-300 focus:ring-blue-500'
            }`}
            disabled={isLoading}
          />
          {validationError && (
            <div className="mt-2 flex items-start gap-2 text-sm text-red-600">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{validationError}</span>
            </div>
          )}
          <div className="mt-2 space-y-1 text-xs text-gray-500">
            <p>
              Use the aliases from the right panel, for example <code>{exampleAlias}</code>.
            </p>
            <p>Only SELECT/WITH queries are allowed in phase 1.</p>
          </div>
        </div>

        <div className="flex justify-end border-t pt-4">
          {saveError && (
            <div className="mr-4 flex flex-1 items-start gap-2 text-sm text-red-600">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{saveError}</span>
            </div>
          )}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            {onSave ? 'Save changes' : 'Create calculated table'}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-gray-50">
        <div className="border-b border-gray-200 px-4 py-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            <TableProperties className="h-4 w-4 text-blue-600" />
            Dataset tables
          </div>
          <p className="mt-1 text-xs text-gray-500">Click an alias to insert it into the SQL editor.</p>
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tables or aliases..."
            className="mt-3 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={isLoading}
          />
        </div>

        <div className="max-h-[28rem] space-y-2 overflow-y-auto px-3 py-3">
          {referenceTables.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 bg-white px-4 py-5 text-sm text-gray-500">
              No dataset tables available for calculated SQL yet.
            </div>
          ) : (
            referenceTables.map((table) => {
              const alias = aliasByTableId[table.id] ?? `table_${table.id}`;
              return (
                <button
                  key={table.id}
                  type="button"
                  onClick={() => insertAlias(alias)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-4 py-3 text-left transition-colors hover:border-blue-300 hover:bg-blue-50"
                  disabled={isLoading}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-gray-900">{table.display_name}</div>
                      <div className="mt-1 truncate font-mono text-xs text-blue-700">{alias}</div>
                      <div className="mt-1 truncate text-xs text-gray-500">{getTableSecondaryLabel(table)}</div>
                    </div>
                    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-600">
                      <Sigma className="h-3 w-3" />
                      {getTableKindLabel(table)}
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
