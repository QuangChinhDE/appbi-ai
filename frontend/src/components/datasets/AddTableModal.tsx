/**
 * AddTableModal - Modal for adding tables from datasources to workspace
 */
'use client';

import React, { useState, useMemo } from 'react';
import { X, Search, Database, CheckSquare, Square, Loader2 } from 'lucide-react';
import { useDataSources } from '@/hooks/use-datasources';
import { useDatasourceTables, useAddTableToWorkspace } from '@/hooks/use-dataset-workspaces';
import type { DatasourceTable } from '@/hooks/use-dataset-workspaces';

interface AddTableModalProps {
  workspaceId: number;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

interface SelectedTable extends DatasourceTable {
  displayName: string;
}

export function AddTableModal({ workspaceId, isOpen, onClose, onSuccess }: AddTableModalProps) {
  const [selectedDatasourceId, setSelectedDatasourceId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTables, setSelectedTables] = useState<Map<string, SelectedTable>>(new Map());
  
  const { data: datasources, isLoading: loadingDatasources } = useDataSources();
  const { data: tables, isLoading: loadingTables } = useDatasourceTables(
    selectedDatasourceId,
    searchQuery || undefined
  );
  const addTableMutation = useAddTableToWorkspace();

  // Filter tables by search
  const filteredTables = useMemo(() => {
    if (!tables) return [];
    if (!searchQuery) return tables;
    
    const query = searchQuery.toLowerCase();
    return tables.filter((table: DatasourceTable) => 
      table.name.toLowerCase().includes(query) ||
      table.schema?.toLowerCase().includes(query)
    );
  }, [tables, searchQuery]);

  // Reset state when modal closes
  React.useEffect(() => {
    if (!isOpen) {
      setSelectedDatasourceId(null);
      setSearchQuery('');
      setSelectedTables(new Map());
    }
  }, [isOpen]);

  const handleToggleTable = (table: DatasourceTable) => {
    const newSelected = new Map(selectedTables);
    
    if (newSelected.has(table.name)) {
      newSelected.delete(table.name);
    } else {
      // Create display name from table name
      const tableName = table.name.split('.').pop() || table.name;
      const displayName = tableName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      
      newSelected.set(table.name, {
        ...table,
        displayName,
      });
    }
    
    setSelectedTables(newSelected);
  };

  const handleUpdateDisplayName = (tableName: string, displayName: string) => {
    const table = selectedTables.get(tableName);
    if (table) {
      const newSelected = new Map(selectedTables);
      newSelected.set(tableName, { ...table, displayName });
      setSelectedTables(newSelected);
    }
  };

  const handleImport = async () => {
    if (!selectedDatasourceId || selectedTables.size === 0) return;

    const tablesToAdd = Array.from(selectedTables.values());
    const errors: string[] = [];

    // Add tables sequentially
    for (const table of tablesToAdd) {
      try {
        await addTableMutation.mutateAsync({
          workspaceId,
          input: {
            datasource_id: selectedDatasourceId,
            source_table_name: table.name,
            display_name: table.displayName,
            enabled: true,
          },
        });
      } catch (error) {
        errors.push(`${table.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    if (errors.length === 0) {
      onSuccess?.();
      onClose();
    } else {
      alert(`Failed to import some tables:\n${errors.join('\n')}`);
    }
  };

  if (!isOpen) return null;

  const selectedCount = selectedTables.size;
  const canImport = selectedDatasourceId && selectedCount > 0 && !addTableMutation.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Add Tables</h2>
            <p className="text-sm text-gray-500 mt-1">
              Select tables from a datasource to add to this workspace
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            disabled={addTableMutation.isPending}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* Datasource selector */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Select Datasource
            </label>
            <select
              value={selectedDatasourceId || ''}
              onChange={(e) => {
                setSelectedDatasourceId(Number(e.target.value) || null);
                setSelectedTables(new Map());
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={loadingDatasources || addTableMutation.isPending}
            >
              <option value="">Choose a datasource...</option>
              {datasources?.map((ds) => (
                <option key={ds.id} value={ds.id}>
                  {ds.name} ({ds.type})
                </option>
              ))}
            </select>
          </div>

          {/* Search and table list */}
          {selectedDatasourceId && (
            <>
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search tables..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={addTableMutation.isPending}
                />
              </div>

              {/* Table list */}
              <div className="border rounded-md divide-y max-h-64 overflow-y-auto">
                {loadingTables ? (
                  <div className="p-8 text-center text-gray-500">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />
                    Loading tables...
                  </div>
                ) : filteredTables.length === 0 ? (
                  <div className="p-8 text-center text-gray-500">
                    No tables found
                  </div>
                ) : (
                  filteredTables.map((table: DatasourceTable) => {
                    const isSelected = selectedTables.has(table.name);
                    
                    return (
                      <label
                        key={table.name}
                        className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer"
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            handleToggleTable(table);
                          }}
                          className="flex-shrink-0"
                          disabled={addTableMutation.isPending}
                        >
                          {isSelected ? (
                            <CheckSquare className="w-5 h-5 text-blue-600" />
                          ) : (
                            <Square className="w-5 h-5 text-gray-400" />
                          )}
                        </button>
                        
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <Database className="w-4 h-4 text-gray-400 flex-shrink-0" />
                            <span className="text-sm font-medium text-gray-900 truncate">
                              {table.name}
                            </span>
                            <span className="text-xs text-gray-500">
                              {table.table_type}
                            </span>
                          </div>
                        </div>
                      </label>
                    );
                  })
                )}
              </div>

              {/* Selected tables with display name editing */}
              {selectedCount > 0 && (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-gray-700">
                    Selected Tables ({selectedCount})
                  </h3>
                  <div className="space-y-2 max-h-48 overflow-y-auto border rounded-md p-3 bg-gray-50">
                    {Array.from(selectedTables.values()).map((table) => (
                      <div key={table.name} className="flex items-center gap-2">
                        <span className="text-xs text-gray-600 flex-shrink-0 w-32 truncate">
                          {table.name}
                        </span>
                        <span className="text-gray-400">→</span>
                        <input
                          type="text"
                          value={table.displayName}
                          onChange={(e) => handleUpdateDisplayName(table.name, e.target.value)}
                          className="flex-1 px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                          placeholder="Display name"
                          disabled={addTableMutation.isPending}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t bg-gray-50">
          <p className="text-sm text-gray-600">
            {selectedCount > 0 && `${selectedCount} table${selectedCount > 1 ? 's' : ''} selected`}
          </p>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
              disabled={addTableMutation.isPending}
            >
              Cancel
            </button>
            <button
              onClick={handleImport}
              disabled={!canImport}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {addTableMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Importing...
                </>
              ) : (
                'Import Tables'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
