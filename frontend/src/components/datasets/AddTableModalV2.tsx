'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Code, Database, Loader2, Sigma } from 'lucide-react';
import { HelpTooltip } from '@/components/ui/HelpTooltip';

import { AppModalShell } from '@/components/common/AppModalShell';
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
        <label className="mb-2 block text-sm font-medium text-text-secondary">Datasource</label>
        <input
          type="text"
          value={datasourceName}
          readOnly
          className="w-full cursor-not-allowed rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-sm text-text-tertiary"
        />
      </div>

      <div>
        <label className="mb-2 block text-sm font-medium text-text-secondary">Selected table</label>
        <div className="flex items-center gap-2 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
          <Database className="h-4 w-4 flex-shrink-0 text-brand" />
          <span className="font-medium text-text-secondary">{existingTable.source_table_name}</span>
        </div>
      </div>

      <div>
        <label className="mb-2 flex items-center text-sm font-medium text-text-secondary">
          Display name *
          <HelpTooltip text="This is the name shown inside the dataset." />
        </label>
        <input
          type="text"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="e.g. Orders"
          className="w-full rounded-md border border-[rgb(var(--border-strong))] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
          disabled={isLoading}
          autoFocus
        />
      </div>

      {saveError && (
        <div className="flex items-start gap-2 text-sm text-danger">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{saveError}</span>
        </div>
      )}

      <div className="flex justify-end border-t pt-4">
        <button
          type="button"
          onClick={() => onSave(displayName)}
          disabled={isLoading || !displayName.trim()}
          className="flex items-center gap-2 rounded-md bg-brand px-4 py-2 text-sm font-medium text-text-inverse transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
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
  const modalIcon = isEditMode
    ? editHeader.icon
    : effectiveCreateMode === 'calculated'
      ? <Sigma className="h-4 w-4" />
      : <Database className="h-4 w-4" />;

  return (
    <AppModalShell
      onClose={onClose}
      closeDisabled={isPending}
      title={modalTitle}
      description={modalDescription}
      icon={modalIcon}
      maxWidthClass="max-w-5xl"
      panelClassName="max-h-[90vh]"
      bodyClassName="flex min-h-0 flex-1 flex-col p-0"
    >
        <div className="flex border-b border-[rgb(var(--border-line))] bg-surface-1 px-6">
          {isEditMode ? (
            <div className="flex items-center gap-2 border-b-2 border-brand px-4 py-3 text-brand">
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
                    ? 'border-brand text-brand'
                    : 'border-transparent text-text-tertiary hover:text-text-secondary'
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
                    ? 'border-brand text-brand'
                    : 'border-transparent text-text-tertiary hover:text-text-secondary'
                }`}
                disabled={isPending}
              >
                <Code className="h-4 w-4" />
                From SQL Query
              </button>
            </>
          ) : (
            <div className="flex items-center gap-2 border-b-2 border-brand px-4 py-3 text-brand">
              <Sigma className="h-4 w-4" />
              <span className="font-medium">Calculated Table</span>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
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
    </AppModalShell>
  );
}
