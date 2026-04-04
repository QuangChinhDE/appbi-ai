/**
 * AddTableModal v2.0 - Add or edit tables (physical or query-based)
 *
 * Add mode:  two tabs (From Table / From Query), full interactive form
 * Edit mode: single tab (matching source_kind, same visual style), pre-filled fields
 */
'use client';

import React, { useState } from 'react';
import { X, Database, Code, Loader2, AlertCircle } from 'lucide-react';
import { useDataSources } from '@/hooks/use-datasources';
import { useAddTableToDataset, useUpdateTable } from '@/hooks/use-datasets';
import type { AddTableInput, DatasetTable } from '@/hooks/use-datasets';
import { PhysicalTableTab } from './PhysicalTableTab';
import { QueryTableTab } from './QueryTableTab';

interface AddTableModalProps {
  datasetId: number;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (created?: DatasetTable) => void;
  existingTable?: DatasetTable | null;
}

type TabType = 'physical' | 'query';

// ─── Inline edit forms ─────────────────────────────────────────────────────────

function EditPhysicalForm({
  existingTable,
  datasourceName,
  isLoading,
  saveError,
  onSave,
}: {
  existingTable: DatasetTable;
  datasourceName: string;
  isLoading: boolean;
  saveError: string | null;
  onSave: (displayName: string) => void;
}) {
  const [displayName, setDisplayName] = useState(existingTable.display_name || '');

  return (
    <div className="p-6 space-y-6">
      {/* Datasource — read-only display, same label as PhysicalTableTab */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Select Datasource *</label>
        <input
          type="text"
          value={datasourceName}
          readOnly
          className="w-full px-3 py-2 border border-gray-200 rounded-md bg-gray-50 text-gray-500 cursor-not-allowed"
        />
      </div>

      {/* Selected table — same area as the table list, read-only */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Select Table *</label>
        <div className="border border-gray-200 rounded-md bg-gray-50 px-4 py-3 flex items-center gap-2">
          <Database className="w-4 h-4 text-blue-500 flex-shrink-0" />
          <span className="font-medium text-gray-700">{existingTable.source_table_name}</span>
        </div>
      </div>

      {/* Display name */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Display Name *</label>
        <input
          type="text"
          value={displayName}
          onChange={e => setDisplayName(e.target.value)}
          placeholder="e.g., Orders"
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={isLoading}
          autoFocus
        />
        <p className="text-xs text-gray-500 mt-1">This name will be shown in the dataset</p>
      </div>

      {saveError && (
        <div className="flex items-start gap-2 text-red-600 text-sm">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{saveError}</span>
        </div>
      )}

      <div className="flex justify-end pt-4 border-t">
        <button
          onClick={() => onSave(displayName)}
          disabled={isLoading || !displayName.trim()}
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
          Lưu thay đổi
        </button>
      </div>
    </div>
  );
}

// ─── Main modal ───────────────────────────────────────────────────────────────

export function AddTableModal({ datasetId, isOpen, onClose, onSuccess, existingTable }: AddTableModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>('physical');
  const [saveError, setSaveError] = useState<string | null>(null);
  const addTableMutation = useAddTableToDataset();
  const updateTableMutation = useUpdateTable();
  const isEditMode = !!existingTable;
  const isPending = addTableMutation.isPending || updateTableMutation.isPending;

  const { data: datasources } = useDataSources();
  const datasourceName = existingTable
    ? datasources?.find(d => d.id === existingTable.datasource_id)?.name ?? `Datasource #${existingTable.datasource_id}`
    : '';

  React.useEffect(() => {
    if (!isOpen) {
      setActiveTab('physical');
      setSaveError(null);
    }
  }, [isOpen]);

  const handleAddTable = async (input: AddTableInput) => {
    const created = await addTableMutation.mutateAsync({ datasetId, input });
    onSuccess?.(created);
    onClose();
  };

  const handleEditSave = async (displayName: string, sourceQuery?: string) => {
    if (!existingTable) return;
    setSaveError(null);
    try {
      await updateTableMutation.mutateAsync({
        datasetId,
        tableId: existingTable.id,
        input: {
          display_name: displayName,
          ...(sourceQuery !== undefined && { source_query: sourceQuery }),
        },
      });
      onSuccess?.();
      onClose();
    } catch (err: any) {
      const msg = err?.response?.data?.detail ?? err?.message ?? 'Lưu thất bại, thử lại.';
      setSaveError(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
  };

  if (!isOpen) return null;

  const editTabIcon = existingTable?.source_kind === 'sql_query'
    ? <Code className="w-4 h-4" />
    : <Database className="w-4 h-4" />;
  const editTabLabel = existingTable?.source_kind === 'sql_query' ? 'From Query' : 'From Table';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">
              {isEditMode ? 'Chỉnh sửa bảng' : 'Add Table'}
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              {isEditMode
                ? `Đang chỉnh sửa: ${existingTable?.display_name || existingTable?.source_table_name}`
                : 'Add a table from a physical datasource table or custom SQL query'}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors" disabled={isPending}>
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs row */}
        <div className="flex border-b px-6">
          {isEditMode ? (
            /* Edit: single locked tab matching source_kind */
            <div className="flex items-center gap-2 px-4 py-3 border-b-2 border-blue-500 text-blue-600">
              {editTabIcon}
              <span className="font-medium">{editTabLabel}</span>
            </div>
          ) : (
            /* Add: two switchable tabs */
            <>
              <button
                onClick={() => setActiveTab('physical')}
                className={`flex items-center gap-2 px-4 py-3 border-b-2 transition-colors ${
                  activeTab === 'physical'
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
                disabled={isPending}
              >
                <Database className="w-4 h-4" />
                <span className="font-medium">From Table</span>
              </button>
              <button
                onClick={() => setActiveTab('query')}
                className={`flex items-center gap-2 px-4 py-3 border-b-2 transition-colors ${
                  activeTab === 'query'
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
                disabled={isPending}
              >
                <Code className="w-4 h-4" />
                <span className="font-medium">From Query</span>
              </button>
            </>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {isEditMode && existingTable ? (
            existingTable.source_kind === 'sql_query' ? (
              <QueryTableTab
                onSave={(name, q) => handleEditSave(name, q)}
                isLoading={isPending}
                lockDatasource={true}
                lockedDatasourceName={datasourceName}
                initialDatasourceId={existingTable.datasource_id}
                initialDisplayName={existingTable.display_name || ''}
                initialQuery={existingTable.source_query || ''}
                saveError={saveError}
              />
            ) : (
              <EditPhysicalForm
                existingTable={existingTable}
                datasourceName={datasourceName}
                isLoading={isPending}
                saveError={saveError}
                onSave={(name) => handleEditSave(name)}
              />
            )
          ) : activeTab === 'physical' ? (
            <PhysicalTableTab onAddTable={handleAddTable} isLoading={isPending} />
          ) : (
            <QueryTableTab onAddTable={handleAddTable} isLoading={isPending} />
          )}
        </div>
      </div>
    </div>
  );
}
