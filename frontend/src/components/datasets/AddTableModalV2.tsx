'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Code, Database, Loader2, Sigma, X } from 'lucide-react';

import { useDataSources } from '@/hooks/use-datasources';
import { useAddTableToDataset, useUpdateTable } from '@/hooks/use-datasets';
import type { AddTableInput, DatasetTable } from '@/hooks/use-datasets';
import { CalculatedTableTab } from './CalculatedTableTab';
import { PhysicalTableTab } from './PhysicalTableTab';
import { QueryTableTab } from './QueryTableTab';

interface AddTableModalProps {
  datasetId: number;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (created?: DatasetTable) => void;
  existingTable?: DatasetTable | null;
  createMode?: 'source' | 'calculated';
  availableTables?: DatasetTable[];
}

type SourceTab = 'physical' | 'query';

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

  useEffect(() => {
    setDisplayName(existingTable.display_name || '');
  }, [existingTable.display_name]);

  return (
    <div className="space-y-6 p-6">
      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700">Datasource</label>
        <input
          type="text"
          value={datasourceName}
          readOnly
          className="w-full cursor-not-allowed rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-500"
        />
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700">Selected table</label>
        <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-4 py-3">
          <Database className="h-4 w-4 flex-shrink-0 text-blue-500" />
          <span className="font-medium text-gray-700">{existingTable.source_table_name}</span>
        </div>
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700">Display name *</label>
        <input
          type="text"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="e.g. Orders"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          disabled={isLoading}
          autoFocus
        />
        <p className="mt-1 text-xs text-gray-500">This is the name shown inside the dataset.</p>
      </div>

      {saveError && (
        <div className="flex items-start gap-2 text-sm text-red-600">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{saveError}</span>
        </div>
      )}

      <div className="flex justify-end border-t pt-4">
        <button
          type="button"
          onClick={() => onSave(displayName)}
          disabled={isLoading || !displayName.trim()}
          className="flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
          Save changes
        </button>
      </div>
    </div>
  );
}

function getEditHeader(table: DatasetTable | null | undefined): { icon: React.ReactNode; label: string } {
  if (table?.source_kind === 'sql_query') {
    return { icon: <Code className="h-4 w-4" />, label: 'SQL Query' };
  }
  if (table?.source_kind === 'derived_table') {
    return { icon: <Sigma className="h-4 w-4" />, label: 'Calculated Table' };
  }
  return { icon: <Database className="h-4 w-4" />, label: 'Source Table' };
}

export function AddTableModal({
  datasetId,
  isOpen,
  onClose,
  onSuccess,
  existingTable = null,
  createMode = 'source',
  availableTables = [],
}: AddTableModalProps) {
  const [activeSourceTab, setActiveSourceTab] = useState<SourceTab>('physical');
  const [saveError, setSaveError] = useState<string | null>(null);

  const addTableMutation = useAddTableToDataset();
  const updateTableMutation = useUpdateTable();
  const isEditMode = Boolean(existingTable);
  const isPending = addTableMutation.isPending || updateTableMutation.isPending;

  const { data: datasources } = useDataSources();
  const datasourceName = existingTable
    ? (
        existingTable.datasource_id != null
          ? datasources?.find((datasource) => datasource.id === existingTable.datasource_id)?.name
            ?? `Datasource #${existingTable.datasource_id}`
          : 'Dataset internal table'
      )
    : '';

  const effectiveCreateMode = useMemo<'source' | 'calculated'>(() => {
    if (!isEditMode) return createMode;
    if (existingTable?.source_kind === 'derived_table') return 'calculated';
    return 'source';
  }, [createMode, existingTable?.source_kind, isEditMode]);

  useEffect(() => {
    if (!isOpen) {
      setActiveSourceTab('physical');
      setSaveError(null);
    }
  }, [isOpen]);

  const handleAddTable = async (input: AddTableInput) => {
    setSaveError(null);
    try {
      const created = await addTableMutation.mutateAsync({ datasetId, input });
      onSuccess?.(created);
      onClose();
    } catch (error: any) {
      const message = error?.response?.data?.detail ?? error?.message ?? 'Could not create table.';
      setSaveError(typeof message === 'string' ? message : JSON.stringify(message));
    }
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
          ...(sourceQuery !== undefined ? { source_query: sourceQuery } : {}),
        },
      });
      onSuccess?.();
      onClose();
    } catch (error: any) {
      const message = error?.response?.data?.detail ?? error?.message ?? 'Could not save changes.';
      setSaveError(typeof message === 'string' ? message : JSON.stringify(message));
    }
  };

  if (!isOpen) return null;

  const editHeader = getEditHeader(existingTable);
  const modalTitle = isEditMode
    ? 'Edit table'
    : (effectiveCreateMode === 'calculated' ? 'Add calculated table' : 'Add table');
  const modalDescription = isEditMode
    ? `Editing: ${existingTable?.display_name || existingTable?.source_table_name || 'Table'}`
    : effectiveCreateMode === 'calculated'
      ? 'Create a calculated table from SQL that references other tables in this dataset.'
      : 'Add a source table from a datasource table or a datasource SQL query.';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b px-6 py-4">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">{modalTitle}</h2>
            <p className="mt-1 text-sm text-gray-500">{modalDescription}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            disabled={isPending}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex border-b px-6">
          {isEditMode ? (
            <div className="flex items-center gap-2 border-b-2 border-blue-500 px-4 py-3 text-blue-600">
              {editHeader.icon}
              <span className="font-medium">{editHeader.label}</span>
            </div>
          ) : effectiveCreateMode === 'source' ? (
            <>
              <button
                type="button"
                onClick={() => setActiveSourceTab('physical')}
                className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                  activeSourceTab === 'physical'
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
                disabled={isPending}
              >
                <Database className="h-4 w-4" />
                From Table
              </button>
              <button
                type="button"
                onClick={() => setActiveSourceTab('query')}
                className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                  activeSourceTab === 'query'
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
                disabled={isPending}
              >
                <Code className="h-4 w-4" />
                From SQL Query
              </button>
            </>
          ) : (
            <div className="flex items-center gap-2 border-b-2 border-blue-500 px-4 py-3 text-blue-600">
              <Sigma className="h-4 w-4" />
              <span className="font-medium">Calculated Table</span>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {isEditMode && existingTable ? (
            existingTable.source_kind === 'sql_query' ? (
              <QueryTableTab
                onSave={(displayName, sqlQuery) => handleEditSave(displayName, sqlQuery)}
                isLoading={isPending}
                lockDatasource={true}
                lockedDatasourceName={datasourceName}
                initialDatasourceId={existingTable.datasource_id ?? undefined}
                initialDisplayName={existingTable.display_name || ''}
                initialQuery={existingTable.source_query || ''}
                saveError={saveError}
              />
            ) : existingTable.source_kind === 'derived_table' ? (
              <CalculatedTableTab
                onSave={(displayName, sqlQuery) => handleEditSave(displayName, sqlQuery)}
                isLoading={isPending}
                availableTables={availableTables}
                excludeTableId={existingTable.id}
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
                onSave={(displayName) => handleEditSave(displayName)}
              />
            )
          ) : effectiveCreateMode === 'calculated' ? (
            <CalculatedTableTab
              onAddTable={handleAddTable}
              isLoading={isPending}
              availableTables={availableTables}
              saveError={saveError}
            />
          ) : activeSourceTab === 'physical' ? (
            <PhysicalTableTab onAddTable={handleAddTable} isLoading={isPending} />
          ) : (
            <QueryTableTab onAddTable={handleAddTable} isLoading={isPending} saveError={saveError} />
          )}
        </div>
      </div>
    </div>
  );
}
