'use client';

import React, { useState } from 'react';
import { Database, Table2, Columns3, ChevronRight, X, Loader2 } from 'lucide-react';
import { useDatasets, useDatasetTables } from '@/hooks/use-datasets';
import type { DataFieldBinding } from '@/types/template';

interface DataFieldPickerProps {
  onSelect: (binding: DataFieldBinding) => void;
  onCancel: () => void;
}

type Step = 'dataset' | 'table' | 'column';

export function DataFieldPicker({ onSelect, onCancel }: DataFieldPickerProps) {
  const [step, setStep] = useState<Step>('dataset');
  const [datasetId, setDatasetId] = useState<number | null>(null);
  const [datasetName, setDatasetName] = useState('');
  const [tableId, setTableId] = useState<number | null>(null);
  const [tableName, setTableName] = useState('');

  const { data: datasets, isLoading: loadingDatasets } = useDatasets();
  const { data: tables, isLoading: loadingTables } = useDatasetTables(datasetId);

  const selectedTable = tables?.find((t) => t.id === tableId);
  const columns: string[] = selectedTable?.columns_cache
    ? (Array.isArray(selectedTable.columns_cache)
        ? selectedTable.columns_cache.map((c: any) => c.name ?? c)
        : Object.keys(selectedTable.columns_cache))
    : [];

  const handlePickDataset = (id: number, name: string) => {
    setDatasetId(id);
    setDatasetName(name);
    setStep('table');
  };

  const handlePickTable = (id: number, name: string) => {
    setTableId(id);
    setTableName(name);
    setStep('column');
  };

  const handlePickColumn = (col: string) => {
    onSelect({
      type: 'field',
      datasetId: datasetId!,
      tableId: tableId!,
      column: col,
      label: `${tableName}.${col}`,
    });
  };

  return (
    <div className="w-72 rounded-lg border border-gray-200 bg-white shadow-xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
        <div className="flex items-center gap-2 text-xs">
          <button
            onClick={() => { if (step === 'table') setStep('dataset'); else if (step === 'column') setStep('table'); }}
            disabled={step === 'dataset'}
            className="text-blue-600 hover:underline disabled:text-gray-400 disabled:no-underline"
          >
            {step === 'dataset' ? 'Pick a field' : step === 'table' ? datasetName : `${datasetName} / ${tableName}`}
          </button>
        </div>
        <button onClick={onCancel} className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* List */}
      <div className="max-h-56 overflow-y-auto p-1">
        {step === 'dataset' && (
          loadingDatasets ? (
            <div className="flex items-center justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-gray-400" /></div>
          ) : (datasets ?? []).length === 0 ? (
            <p className="py-4 text-center text-xs text-gray-400">No datasets available</p>
          ) : (
            (datasets ?? []).map((ds) => (
              <button
                key={ds.id}
                onClick={() => handlePickDataset(ds.id, ds.name)}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700"
              >
                <Database className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                <span className="flex-1 truncate">{ds.name}</span>
                <ChevronRight className="h-3.5 w-3.5 text-gray-300" />
              </button>
            ))
          )
        )}

        {step === 'table' && (
          loadingTables ? (
            <div className="flex items-center justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-gray-400" /></div>
          ) : (tables ?? []).length === 0 ? (
            <p className="py-4 text-center text-xs text-gray-400">No tables in this dataset</p>
          ) : (
            (tables ?? []).map((t) => (
              <button
                key={t.id}
                onClick={() => handlePickTable(t.id, t.display_name)}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700"
              >
                <Table2 className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                <span className="flex-1 truncate">{t.display_name}</span>
                <ChevronRight className="h-3.5 w-3.5 text-gray-300" />
              </button>
            ))
          )
        )}

        {step === 'column' && (
          columns.length === 0 ? (
            <p className="py-4 text-center text-xs text-gray-400">No columns detected</p>
          ) : (
            columns.map((col) => (
              <button
                key={col}
                onClick={() => handlePickColumn(col)}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700"
              >
                <Columns3 className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                <span className="flex-1 truncate font-mono text-xs">{col}</span>
              </button>
            ))
          )
        )}
      </div>
    </div>
  );
}
