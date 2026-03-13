/**
 * Workspace Detail Page - Shows workspace with sidebar tables and grid preview
 */
'use client';

import React, { useState, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { 
  Plus, 
  Search, 
  Database, 
  RefreshCw, 
  ChevronLeft,
  MoreVertical,
  Loader2,
  Columns,
} from 'lucide-react';
import { useWorkspace, useTablePreview, useUpdateTable } from '@/hooks/use-dataset-workspaces';
import { DatasetTableGrid } from '@/components/datasets/DatasetTableGrid';
import { AddTableModal } from '@/components/datasets/AddTableModalV2';
import { ManageColumnsDrawer } from '@/components/datasets/ManageColumnsDrawer';
import { AddColumnModal } from '@/components/datasets/AddColumnModal';
import type { Transformation } from '@/hooks/use-dataset-workspaces';

export default function WorkspaceDetailPage() {
  const params = useParams();
  const router = useRouter();
  const workspaceId = params?.id ? Number(params.id) : null;
  
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null);
  const [previewLimit, setPreviewLimit] = useState(200);
  const [isAddTableModalOpen, setIsAddTableModalOpen] = useState(false);
  const [isManageColumnsOpen, setIsManageColumnsOpen] = useState(false);
  const [isAddColumnModalOpen, setIsAddColumnModalOpen] = useState(false);
  const [tableSearchQuery, setTableSearchQuery] = useState('');

  // Fetch workspace with tables
  const { 
    data: workspace, 
    isLoading: loadingWorkspace,
    error: workspaceError,
    refetch: refetchWorkspace,
  } = useWorkspace(workspaceId);

  // Fetch table preview
  const {
    data: previewData,
    isLoading: loadingPreview,
    error: previewError,
    refetch: refetchPreview,
  } = useTablePreview(workspaceId, selectedTableId, { limit: previewLimit });

  // Filter tables by search
  const filteredTables = useMemo(() => {
    if (!workspace?.tables) return [];
    if (!tableSearchQuery) return workspace.tables;
    
    const query = tableSearchQuery.toLowerCase();
    return workspace.tables.filter((table: any) => 
      table.display_name?.toLowerCase().includes(query) ||
      table.source_table_name.toLowerCase().includes(query)
    );
  }, [workspace?.tables, tableSearchQuery]);

  // Auto-select first table when tables load
  React.useEffect(() => {
    if (workspace?.tables && workspace.tables.length > 0 && !selectedTableId) {
      setSelectedTableId(workspace.tables[0].id);
    }
  }, [workspace?.tables, selectedTableId]);

  // Update table mutation
  const updateTableMutation = useUpdateTable();

  // Handle table addition success
  const handleTableAddSuccess = () => {
    refetchWorkspace();
    // Auto-select newly added table (will be last in list after refetch)
    setTimeout(() => {
      if (workspace?.tables && workspace.tables.length > 0) {
        setSelectedTableId(workspace.tables[workspace.tables.length - 1].id);
      }
    }, 500);
  };

  // Handle transformations save
  const handleSaveTransformations = async (transformations: Transformation[]) => {
    if (!workspaceId || !selectedTableId) return;

    await updateTableMutation.mutateAsync({
      workspaceId,
      tableId: selectedTableId,
      input: { transformations },
    });

    // Refresh preview to show updated data
    refetchPreview();
    refetchWorkspace();
  };

  // Handle remove column
  const handleRemoveColumn = async (columnName: string) => {
    if (!selectedTable || !workspaceId || !selectedTableId) return;

    // Get existing transformations
    const existingTransforms = selectedTable.transformations || [];

    // Get current select_columns transformation
    const selectTransform = existingTransforms.find(
      (t) => t.type === 'select_columns' && t.enabled
    );

    // Get all columns
    const allColumns = previewData?.columns.map(c => c.name) || [];
    
    // Determine selected columns
    let selectedColumns: string[];
    if (selectTransform && selectTransform.params.columns) {
      selectedColumns = selectTransform.params.columns;
    } else {
      selectedColumns = allColumns;
    }

    // Remove the column
    const updatedColumns = selectedColumns.filter(col => col !== columnName);

    if (updatedColumns.length === 0) {
      alert('Cannot remove all columns. At least one column must remain.');
      return;
    }

    // Update transformations
    const filteredTransforms = existingTransforms.filter(
      (t) => t.type !== 'select_columns'
    );

    const newTransform: Transformation = {
      type: 'select_columns',
      enabled: true,
      params: {
        columns: updatedColumns,
      },
    };

    const updatedTransforms = [newTransform, ...filteredTransforms];

    await handleSaveTransformations(updatedTransforms);
  };

  const selectedTable = workspace?.tables?.find((t: any) => t.id === selectedTableId);

  // Loading state
  if (loadingWorkspace) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-3" />
          <p className="text-gray-600">Loading workspace...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (workspaceError || !workspace) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-md">
          <div className="text-red-600 mb-3">
            <svg className="w-12 h-12 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Workspace not found</h2>
          <p className="text-gray-600 mb-4">
            {workspaceError instanceof Error ? workspaceError.message : 'Could not load workspace'}
          </p>
          <button
            onClick={() => router.push('/dataset-workspaces')}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
          >
            Back to Workspaces
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left Sidebar */}
      <div className="w-80 border-r bg-white flex flex-col">
        {/* Sidebar Header */}
        <div className="p-4 border-b">
          <button
            onClick={() => router.push('/dataset-workspaces')}
            className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 mb-3 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            Back to Workspaces
          </button>
          
          <h1 className="text-lg font-semibold text-gray-900 mb-1">
            {workspace.name}
          </h1>
          {workspace.description && (
            <p className="text-sm text-gray-600">{workspace.description}</p>
          )}
        </div>

        {/* Search Tables */}
        <div className="p-4 border-b">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search tables..."
              value={tableSearchQuery}
              onChange={(e) => setTableSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Tables List */}
        <div className="flex-1 overflow-y-auto">
          {filteredTables.length === 0 ? (
            <div className="p-4 text-center text-gray-500 text-sm">
              {tableSearchQuery ? 'No tables match your search' : 'No tables yet'}
            </div>
          ) : (
            <div className="p-2">
              {filteredTables.map((table: any) => (
                <button
                  key={table.id}
                  onClick={() => setSelectedTableId(table.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-left transition-colors ${
                    selectedTableId === table.id
                      ? 'bg-blue-50 text-blue-900'
                      : 'hover:bg-gray-100 text-gray-900'
                  }`}
                >
                  <Database className="w-4 h-4 flex-shrink-0 text-gray-400" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {table.display_name || table.source_table_name}
                    </div>
                    {table.display_name && (
                      <div className="text-xs text-gray-500 truncate">
                        {table.source_table_name}
                      </div>
                    )}
                  </div>
                  <div
                    onClick={(e) => {
                      e.stopPropagation();
                      // TODO: Show menu
                    }}
                    className="p-1 hover:bg-gray-200 rounded opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                  >
                    <MoreVertical className="w-4 h-4 text-gray-400" />
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Add Table Button */}
        <div className="p-4 border-t">
          <button
            onClick={() => setIsAddTableModalOpen(true)}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Table
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col bg-gray-50 overflow-hidden">
        {workspace.tables.length === 0 ? (
          // Empty state - no tables
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-md px-4">
              <div className="text-gray-400 mb-4">
                <Database className="w-16 h-16 mx-auto" />
              </div>
              <h2 className="text-xl font-semibold text-gray-900 mb-2">
                No tables yet
              </h2>
              <p className="text-gray-600 mb-6">
                Add a table from your datasources to get started with this workspace
              </p>
              <button
                onClick={() => setIsAddTableModalOpen(true)}
                className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
              >
                <Plus className="w-5 h-5" />
                Add Table
              </button>
            </div>
          </div>
        ) : selectedTable ? (
          <>
            {/* Top Bar */}
            <div className="bg-white border-b px-6 py-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-semibold text-gray-900">
                    {selectedTable.display_name || selectedTable.source_table_name}
                  </h2>
                  <span className="px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100 rounded">
                    {selectedTable.source_table_name}
                  </span>
                </div>
                
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setIsManageColumnsOpen(true)}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors"
                  >
                    <Columns className="w-4 h-4" />
                    Columns
                  </button>
                  
                  <button
                    onClick={() => setIsAddColumnModalOpen(true)}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    Add Column
                  </button>
                  
                  <div className="w-px h-6 bg-gray-300" />
                  
                  <label className="flex items-center gap-2 text-sm text-gray-600">
                    Limit:
                    <select
                      value={previewLimit}
                      onChange={(e) => setPreviewLimit(Number(e.target.value))}
                      className="px-2 py-1 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                      <option value={200}>200</option>
                      <option value={500}>500</option>
                      <option value={1000}>1000</option>
                    </select>
                  </label>
                  
                  <button
                    onClick={() => refetchPreview()}
                    disabled={loadingPreview}
                    className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded transition-colors disabled:opacity-50"
                    title="Refresh preview"
                  >
                    <RefreshCw className={`w-4 h-4 ${loadingPreview ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>
            </div>

            {/* Grid Body */}
            <div className="flex-1 overflow-auto p-6">
              <DatasetTableGrid
                columns={previewData?.columns || []}
                rows={previewData?.rows || []}
                isLoading={loadingPreview}
                error={previewError instanceof Error ? previewError.message : null}
                onRetry={() => refetchPreview()}
                onAddColumn={() => setIsAddColumnModalOpen(true)}
                onRemoveColumn={handleRemoveColumn}
              />
            </div>
          </>
        ) : null}
      </div>

      {/* Add Table Modal */}
      <AddTableModal
        workspaceId={workspaceId!}
        isOpen={isAddTableModalOpen}
        onClose={() => setIsAddTableModalOpen(false)}
        onSuccess={handleTableAddSuccess}
      />

      {/* Manage Columns Drawer */}
      {selectedTable && (
        <ManageColumnsDrawer
          table={selectedTable}
          allColumns={previewData?.columns || []}
          isOpen={isManageColumnsOpen}
          onClose={() => setIsManageColumnsOpen(false)}
          onSave={handleSaveTransformations}
        />
      )}

      {/* Add Column Modal */}
      {selectedTable && (
        <AddColumnModal
          table={selectedTable}
          isOpen={isAddColumnModalOpen}
          onClose={() => setIsAddColumnModalOpen(false)}
          onSave={handleSaveTransformations}
        />
      )}
    </div>
  );
}
