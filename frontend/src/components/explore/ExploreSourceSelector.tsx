/**
 * ExploreSourceSelector - Selects workspace and table for exploration
 */
'use client';

import React from 'react';
import { Database, Table as TableIcon, ChevronDown } from 'lucide-react';
import { useWorkspaces, useWorkspace } from '@/hooks/use-dataset-workspaces';

interface ExploreSourceSelectorProps {
  selectedWorkspaceId: number | null;
  selectedTableId: number | null;
  previewLimit: number;
  onWorkspaceChange: (workspaceId: number | null) => void;
  onTableChange: (tableId: number | null) => void;
  onLimitChange: (limit: number) => void;
}

export function ExploreSourceSelector({
  selectedWorkspaceId,
  selectedTableId,
  previewLimit,
  onWorkspaceChange,
  onTableChange,
  onLimitChange,
}: ExploreSourceSelectorProps) {
  const { data: workspaces = [], isLoading: loadingWorkspaces } = useWorkspaces();
  const { data: workspace } = useWorkspace(selectedWorkspaceId);

  const handleWorkspaceChange = (workspaceId: string) => {
    const id = workspaceId ? Number(workspaceId) : null;
    onWorkspaceChange(id);
    onTableChange(null); // Reset table selection
  };

  const handleTableChange = (tableId: string) => {
    const id = tableId ? Number(tableId) : null;
    onTableChange(id);
  };

  return (
    <div className="space-y-4">
      {/* Workspace Selector */}
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-2 flex items-center gap-2">
          <Database className="w-3.5 h-3.5" />
          Workspace
        </label>
        <div className="relative">
          <select
            value={selectedWorkspaceId || ''}
            onChange={(e) => handleWorkspaceChange(e.target.value)}
            disabled={loadingWorkspaces}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white appearance-none pr-10"
          >
            <option value="">Select workspace...</option>
            {workspaces.map((ws: any) => (
              <option key={ws.id} value={ws.id}>
                {ws.name}
              </option>
            ))}
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        </div>
      </div>

      {/* Table Selector */}
      {selectedWorkspaceId && (
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-2 flex items-center gap-2">
            <TableIcon className="w-3.5 h-3.5" />
            Table
          </label>
          <div className="relative">
            <select
              value={selectedTableId || ''}
              onChange={(e) => handleTableChange(e.target.value)}
              disabled={!workspace?.tables?.length}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white appearance-none pr-10"
            >
              <option value="">Select table...</option>
              {workspace?.tables?.map((table: any) => (
                <option key={table.id} value={table.id}>
                  {table.display_name || table.source_table_name}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          </div>
          {workspace && workspace.tables?.length === 0 && (
            <p className="text-xs text-gray-500 mt-1">
              No tables in this workspace. Add tables first.
            </p>
          )}
        </div>
      )}

      {/* Preview Limit */}
      {selectedTableId && (
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-2">
            Preview Limit
          </label>
          <select
            value={previewLimit}
            onChange={(e) => onLimitChange(Number(e.target.value))}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
          >
            <option value={100}>100 rows</option>
            <option value={200}>200 rows</option>
            <option value={500}>500 rows</option>
            <option value={1000}>1000 rows</option>
            <option value={5000}>5000 rows</option>
          </select>
        </div>
      )}
    </div>
  );
}
