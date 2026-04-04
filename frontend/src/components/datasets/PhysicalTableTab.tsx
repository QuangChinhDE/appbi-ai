/**
 * PhysicalTableTab - Select physical tables from datasources (Add mode only)
 */
'use client';

import React, { useState, useMemo } from 'react';
import { Search, Database, CheckSquare, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { useDataSources } from '@/hooks/use-datasources';
import { useDatasourceTables } from '@/hooks/use-datasets';
import type { DatasourceTable, AddTableInput } from '@/hooks/use-datasets';

interface PhysicalTableTabProps {
  onAddTable: (input: AddTableInput) => Promise<void>;
  isLoading: boolean;
}

export function PhysicalTableTab({ onAddTable, isLoading }: PhysicalTableTabProps) {
  const [selectedDatasourceId, setSelectedDatasourceId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');

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

  const handleSelectTable = (tableName: string) => {
    setSelectedTable(tableName);
    if (!displayName) {
      const shortName = tableName.split('.').pop() || tableName;
      setDisplayName(shortName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()));
    }
  };

  const handleAdd = async () => {
    if (!selectedDatasourceId || !selectedTable || !displayName.trim()) return;
    await onAddTable({
      datasource_id: selectedDatasourceId,
      source_kind: 'physical_table',
      source_table_name: selectedTable,
      display_name: displayName.trim(),
      enabled: true,
    });
  };

  const canAdd = selectedDatasourceId && selectedTable && displayName.trim() && !isLoading;

  return (
    <div className="p-6 space-y-6">
      {/* Datasource selector */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Select Datasource *</label>
        <select
          value={selectedDatasourceId || ''}
          onChange={(e) => {
            setSelectedDatasourceId(Number(e.target.value) || null);
            setSelectedTable(null);
            setDisplayName('');
          }}
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
      </div>

      {/* Table search and list */}
      {selectedDatasourceId && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Select Table *</label>

          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search tables..."
              className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={isLoading}
            />
          </div>

          <div className="border border-gray-300 rounded-md max-h-80 overflow-y-auto">
            {loadingTables ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
              </div>
            ) : filteredTables.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-gray-500">
                <Database className="w-8 h-8 mb-2 text-gray-400" />
                <p>No tables found</p>
              </div>
            ) : (
              <div>
                {/* Table count badge */}
                <div className="sticky top-0 bg-gray-50 border-b border-gray-200 px-3 py-1.5 text-xs text-gray-500 font-medium z-10">
                  {filteredTables.length} table{filteredTables.length !== 1 ? 's' : ''}
                  {groupedTables.length > 1 ? ` in ${groupedTables.length} schemas` : ''}
                  {searchQuery && ` matching "${searchQuery}"`}
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
                          className="w-full flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-600 hover:bg-gray-100 transition-colors sticky top-7 z-[5]"
                        >
                          {isCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                          <Database className="w-3 h-3 text-gray-400" />
                          {schema}
                          <span className="ml-auto text-gray-400 font-normal">{schemaTables.length}</span>
                        </button>
                      )}
                      {!isCollapsed && (
                        <div className="divide-y divide-gray-100">
                          {schemaTables.map((table) => {
                            const shortName = table.name.includes('.') ? table.name.split('.').pop()! : table.name;
                            return (
                              <button
                                key={table.name}
                                onClick={() => handleSelectTable(table.name)}
                                className={`w-full px-4 py-2.5 text-left hover:bg-blue-50 transition-colors flex items-center gap-2 ${
                                  selectedTable === table.name ? 'bg-blue-50 border-l-2 border-blue-500' : ''
                                }`}
                                disabled={isLoading}
                              >
                                <div className="flex-1 min-w-0">
                                  <div className="text-sm font-medium text-gray-900 truncate">{shortName}</div>
                                  {groupedTables.length <= 1 && table.schema && (
                                    <div className="text-xs text-gray-400">{table.schema}</div>
                                  )}
                                </div>
                                {selectedTable === table.name && (
                                  <CheckSquare className="w-4 h-4 text-blue-600 flex-shrink-0" />
                                )}
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

      {/* Display name */}
      {selectedTable && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">Display Name *</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g., Orders"
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={isLoading}
          />
          <p className="text-xs text-gray-500 mt-1">This name will be shown in the dataset</p>
        </div>
      )}

      {/* Action button */}
      <div className="flex justify-end pt-4 border-t">
        <button
          onClick={handleAdd}
          disabled={!canAdd}
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
          Add Table
        </button>
      </div>
    </div>
  );
}
