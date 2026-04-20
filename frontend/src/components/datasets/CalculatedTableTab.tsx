'use client';

import React, { useMemo, useRef, useState } from 'react';
import { AlertCircle, Loader2, Sigma, TableProperties } from 'lucide-react';

import type { AddTableInput, DatasetTable } from '@/hooks/use-datasets';
import { buildDatasetTableAliasMap } from '@/lib/dataset-table-aliases';
import { SqlEditor } from '@/components/ui/SqlEditor';

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

  const aliasByTableId = useMemo(() => buildDatasetTableAliasMap(availableTables), [availableTables]);

  // Collect alias names for SQL autocomplete
  const aliasNames = useMemo(() => {
    return availableTables
      .filter((t) => excludeTableId == null || t.id !== excludeTableId)
      .map((t) => aliasByTableId[t.id])
      .filter(Boolean) as string[];
  }, [aliasByTableId, availableTables, excludeTableId]);

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
    setQuery((current) => {
      const trimmed = current.trim();
      return trimmed ? `${current} ${alias}` : alias;
    });
    setValidationError(null);
  };

  const validateQuery = (sql: string): string | null => {
    const trimmed = sql.trim();
    if (!trimmed) return 'SQL is required';
    const normalized = trimmed.toLowerCase();
    if (!(normalized.startsWith('select') || normalized.startsWith('with'))) {
      return 'Calculated table SQL must start with SELECT or WITH';
    }
    if (trimmed.includes(';')) return 'Only one SQL statement is allowed';
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
          <label className="mb-2 block text-sm font-medium text-text-secondary">Calculated table name *</label>
          <input
            type="text"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="e.g. Monthly Revenue"
            className="w-full rounded-md border border-[rgb(var(--border-strong))] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
            disabled={isLoading}
          />
          <p className="mt-1 text-xs text-text-tertiary">This is the name shown inside the dataset.</p>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="block text-sm font-medium text-text-secondary">Dataset SQL *</label>
            <span className="text-xs text-text-tertiary">Use only tables from this dataset</span>
          </div>
          <SqlEditor
            value={query}
            onChange={(val) => {
              setQuery(val);
              setValidationError(null);
            }}
            dialect="postgresql"
            placeholder={`WITH agg AS (\n  SELECT * FROM ${exampleAlias}\n)\nSELECT * FROM agg`}
            disabled={isLoading}
            height="320px"
            hasError={!!validationError}
            tables={aliasNames}
          />
          {validationError && (
            <div className="mt-2 flex items-start gap-2 text-sm text-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{validationError}</span>
            </div>
          )}
          <div className="mt-2 space-y-1 text-xs text-text-tertiary">
            <p>
              Use the aliases from the right panel, for example <code>{exampleAlias}</code>.
            </p>
            <p>Only SELECT/WITH queries are allowed. Supports comments and line numbers.</p>
          </div>
        </div>

        <div className="flex justify-end border-t pt-4">
          {saveError && (
            <div className="mr-4 flex flex-1 items-start gap-2 text-sm text-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="font-medium">Lỗi từ CSDL:</span>
                <pre className="mt-1 whitespace-pre-wrap break-words rounded bg-danger/5 px-2 py-1.5 text-xs font-mono">{saveError}</pre>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="flex items-center gap-2 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
            {onSave ? 'Save changes' : 'Create calculated table'}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2">
        <div className="border-b border-[rgb(var(--border-line))] px-4 py-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <TableProperties className="h-4 w-4 text-brand" />
            Dataset tables
          </div>
          <p className="mt-1 text-xs text-text-tertiary">Click an alias to insert it into the SQL editor.</p>
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tables or aliases..."
            className="mt-3 w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
            disabled={isLoading}
          />
        </div>

        <div className="max-h-[28rem] space-y-2 overflow-y-auto px-3 py-3">
          {referenceTables.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-5 text-sm text-text-tertiary">
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
                  className="w-full rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-3 text-left transition-colors hover:border-brand/40 hover:bg-brand/15"
                  disabled={isLoading}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-text-primary">{table.display_name}</div>
                      <div className="mt-1 truncate font-mono text-xs text-brand">{alias}</div>
                      <div className="mt-1 truncate text-xs text-text-tertiary">{getTableSecondaryLabel(table)}</div>
                    </div>
                    <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
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
