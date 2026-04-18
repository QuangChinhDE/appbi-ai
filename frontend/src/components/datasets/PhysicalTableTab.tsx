/**
 * PhysicalTableTab - Select physical tables from datasources (Add mode only)
 */
'use client';

import React, { useState, useMemo } from 'react';
import { Search, Database, CheckSquare, Loader2, ChevronDown, ChevronRight, Square } from 'lucide-react';
import { useDataSources } from '@/hooks/use-datasources';
import { useDatasourceTables } from '@/hooks/use-datasets';
import type { DatasourceTable, AddTableInput } from '@/hooks/use-datasets';

interface PhysicalTableTabProps {
  onAddTable: (input: AddTableInput | AddTableInput[]) => Promise<void>;
  isLoading: boolean;
}

function buildDefaultDisplayName(tableName: string): string {
  const shortName = tableName.split('.').pop() || tableName;
  return shortName.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function PhysicalTableTab({ onAddTable, isLoading }: PhysicalTableTabProps) {
  const [selectedDatasourceId, setSelectedDatasourceId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTables, setSelectedTables] = useState<string[]>([]);

  const { data: datasources, isLoading: loadingDatasources } = useDataSources();
  const { data: tables, isLoading: loadingTables } = useDatasourceTables(
    selectedDatasourceId,
    searchQuery || undefined
  );

  const filteredTables = useMemo(() => {
    if (!tables) return [];
    if (!searchQuery) return tables;
    const query = searchQuery.toLowerCase();
    return tables.filter((table: DatasourceTable) =>
      table.name.toLowerCase().includes(query) ||
      table.schema?.toLowerCase().includes(query)
    );
  }, [tables, searchQuery]);

  // Group tables by schema for better navigation
  const groupedTables = useMemo(() => {
    const groups: Record<string, DatasourceTable[]> = {};
    for (const t of filteredTables) {
      const key = t.schema || 'default';
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    }
    // Sort schemas alphabetically, tables within each schema too
    return Object.entries(groups)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([schema, tbs]) => ({
        schema,
        tables: tbs.sort((a, b) => a.name.localeCompare(b.name)),
      }));
  }, [filteredTables]);

  const [collapsedSchemas, setCollapsedSchemas] = useState<Set<string>>(new Set());
  const toggleSchema = (schema: string) =>
    setCollapsedSchemas(prev => {
      const next = new Set(prev);
      next.has(schema) ? next.delete(schema) : next.add(schema);
      return next;
    });

  const selectedTableSet = useMemo(() => new Set(selectedTables), [selectedTables]);

  const updateTableSelection = (tableName: string, selected: boolean) => {
    setSelectedTables((current) => {
      if (selected) {
        if (current.includes(tableName)) return current;
        return [...current, tableName];
      }
      return current.filter((name) => name !== tableName);
    });
  };

  const handleToggleTable = (tableName: string) => {
    updateTableSelection(tableName, !selectedTableSet.has(tableName));
  };

  const handleSelectAllFiltered = () => {
    if (filteredTables.length === 0) return;

    setSelectedTables((current) => {
      const next = new Set(current);
      filteredTables.forEach((table) => next.add(table.name));
      return Array.from(next);
    });
  };

  const handleClearSelection = () => {
    setSelectedTables([]);
  };

  const handleAdd = async () => {
    if (!selectedDatasourceId || selectedTables.length === 0) return;

    const payload = selectedTables.map((tableName) => ({
      datasource_id: selectedDatasourceId,
      source_kind: 'physical_table' as const,
      source_table_name: tableName,
      display_name: buildDefaultDisplayName(tableName),
      enabled: true,
    }));

    await onAddTable(payload.length === 1 ? payload[0] : payload);
  };

  const allVisibleSelected = filteredTables.length > 0 && filteredTables.every((table) => selectedTableSet.has(table.name));
  const canAdd = Boolean(
    selectedDatasourceId
      && selectedTables.length > 0
      && !isLoading
  );

  return (
    <div className="p-6 space-y-6">
      {/* Datasource selector */}
      <div>
        <label className="block text-sm font-medium text-text-secondary mb-2">Select Datasource *</label>
        <select
          value={selectedDatasourceId || ''}
          onChange={(e) => {
            setSelectedDatasourceId(Number(e.target.value) || null);
            setSelectedTables([]);
            setSearchQuery('');
          }}
          className="w-full px-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
          disabled={loadingDatasources || isLoading}
        >
          <option value="">Choose a datasource...</option>
          {datasources?.map((ds) => (
            <option key={ds.id} value={ds.id}>
              {ds.name} ({ds.type})
            </option>
          ))}
        </select>
      </div>

      {/* Table search and list */}
      {selectedDatasourceId && (
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <label className="block text-sm font-medium text-text-secondary">Select Tables *</label>
              <p className="mt-1 text-xs text-text-tertiary">Choose one or multiple tables from the datasource.</p>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={handleSelectAllFiltered}
                disabled={isLoading || loadingTables || filteredTables.length === 0 || allVisibleSelected}
                className="rounded-md border border-[rgb(var(--border-line))] px-2.5 py-1.5 text-text-secondary transition-colors hover:border-brand/40 hover:text-brand disabled:cursor-not-allowed disabled:opacity-50"
              >
                Select all visible
              </button>
              <button
                type="button"
                onClick={handleClearSelection}
                disabled={isLoading || selectedTables.length === 0}
                className="rounded-md border border-[rgb(var(--border-line))] px-2.5 py-1.5 text-text-secondary transition-colors hover:border-brand/40 hover:text-brand disabled:cursor-not-allowed disabled:opacity-50"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-text-quaternary w-4 h-4" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search tables..."
              className="w-full pl-10 pr-3 py-2 border border-[rgb(var(--border-strong))] rounded-md focus:outline-none focus:ring-2 focus:ring-brand"
              disabled={isLoading}
            />
          </div>

          <div className="border border-[rgb(var(--border-strong))] rounded-md max-h-80 overflow-y-auto">
            {loadingTables ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-text-quaternary" />
              </div>
            ) : filteredTables.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-text-tertiary">
                <Database className="w-8 h-8 mb-2 text-text-quaternary" />
                <p>No tables found</p>
              </div>
            ) : (
              <div>
                {/* Table count badge */}
                <div className="sticky top-0 bg-surface-2 border-b border-[rgb(var(--border-line))] px-3 py-1.5 text-xs text-text-tertiary font-medium z-10">
                  {filteredTables.length} table{filteredTables.length !== 1 ? 's' : ''}
                  {groupedTables.length > 1 ? ` in ${groupedTables.length} schemas` : ''}
                  {searchQuery && ` matching "${searchQuery}"`}
                  {selectedTables.length > 0 && ` • ${selectedTables.length} selected`}
                </div>
                {groupedTables.map(({ schema, tables: schemaTables }) => {
                  const isCollapsed = collapsedSchemas.has(schema);
                  return (
                    <div key={schema}>
                      {/* Schema header — collapsible */}
                      {groupedTables.length > 1 && (
                        <button
                          type="button"
                          onClick={() => toggleSchema(schema)}
                          className="w-full flex items-center gap-1.5 px-3 py-1.5 bg-surface-2 border-b border-[rgb(var(--border-line))] text-xs font-semibold text-text-secondary hover:bg-surface-2 transition-colors sticky top-7 z-[5]"
                        >
                          {isCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                          <Database className="w-3 h-3 text-text-quaternary" />
                          {schema}
                          <span className="ml-auto text-text-quaternary font-normal">{schemaTables.length}</span>
                        </button>
                      )}
                      {!isCollapsed && (
                        <div className="divide-y divide-[rgb(var(--border-line))]">
                          {schemaTables.map((table) => {
                            const shortName = table.name.includes('.') ? table.name.split('.').pop()! : table.name;
                            return (
                              <button
                                key={table.name}
                                type="button"
                                onClick={() => handleToggleTable(table.name)}
                                className={`w-full px-4 py-2.5 text-left hover:bg-brand/15 transition-colors flex items-center gap-2 ${
                                  selectedTableSet.has(table.name) ? 'bg-brand/10 border-l-2 border-brand' : ''
                                }`}
                                disabled={isLoading}
                              >
                                {selectedTableSet.has(table.name) ? (
                                  <CheckSquare className="w-4 h-4 text-brand flex-shrink-0" />
                                ) : (
                                  <Square className="w-4 h-4 text-text-quaternary flex-shrink-0" />
                                )}
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm font-medium text-text-primary truncate">{shortName}</div>
                                  {groupedTables.length <= 1 && table.schema && (
                                    <div className="text-xs text-text-quaternary">{table.schema}</div>
                                  )}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="sticky bottom-0 z-10 -mx-6 mt-6 flex items-center justify-between gap-3 border-t border-[rgb(var(--border-line))] bg-surface-1/95 px-6 py-4 backdrop-blur supports-[backdrop-filter]:bg-surface-1/80">
        <div className="min-w-0 text-sm text-text-tertiary">
          {selectedTables.length > 0
            ? `${selectedTables.length} table${selectedTables.length !== 1 ? 's' : ''} selected`
            : 'Select at least one table to continue.'}
        </div>
        <button
          type="button"
          onClick={handleAdd}
          disabled={!canAdd}
          className="px-4 py-2 bg-brand text-white rounded-md hover:bg-brand-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
          {selectedTables.length > 1 ? `Add ${selectedTables.length} Tables` : 'Add Table'}
        </button>
      </div>
    </div>
  );
}
