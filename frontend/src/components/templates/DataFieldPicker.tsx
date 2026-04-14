'use client';

import React, { useState } from 'react';
import { Database, Table2, Columns3, ChevronRight, ChevronLeft, X, Loader2, RefreshCw, Hash } from 'lucide-react';
import { useDatasets, useDatasetTables } from '@/hooks/use-datasets';
import type { DataFieldBinding } from '@/types/template';

interface DataFieldPickerProps {
  onSelect: (binding: DataFieldBinding) => void;
  onCancel: () => void;
}

type Step = 'dataset' | 'table' | 'column' | 'agg';

type AggOption = {
  value: DataFieldBinding['agg'];
  label: string;
  description: string;
};

const AGG_OPTIONS: AggOption[] = [
  { value: 'sum',   label: 'SUM',   description: 'Total of all values' },
  { value: 'avg',   label: 'AVG',   description: 'Average value' },
  { value: 'min',   label: 'MIN',   description: 'Smallest value' },
  { value: 'max',   label: 'MAX',   description: 'Largest value' },
  { value: 'count', label: 'COUNT', description: 'Number of rows' },
  { value: 'first', label: 'FIRST', description: 'Value from first row' },
];

export function DataFieldPicker({ onSelect, onCancel }: DataFieldPickerProps) {
  const [step, setStep] = useState<Step>('dataset');
  const [datasetId, setDatasetId] = useState<number | null>(null);
  const [datasetName, setDatasetName] = useState('');
  const [tableId, setTableId] = useState<number | null>(null);
  const [tableName, setTableName] = useState('');
  const [selectedColumn, setSelectedColumn] = useState<string | null>(null);

  const { data: datasets, isLoading: loadingDatasets } = useDatasets();
  const { data: tables, isLoading: loadingTables } = useDatasetTables(datasetId);

  const selectedTable = tables?.find((t) => t.id === tableId);
  const columns: string[] = (() => {
    const cc = selectedTable?.columns_cache;
    if (!cc) return [];
    if (Array.isArray(cc)) return cc.map((c: any) => c.name ?? c);
    if (cc.columns && Array.isArray(cc.columns))
      return cc.columns.map((c: any) => c.name ?? c).filter(Boolean);
    if (cc.source_columns && Array.isArray(cc.source_columns))
      return cc.source_columns.map(String);
    return [];
  })();

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
    setSelectedColumn(col);
    setStep('agg');
  };

  const handleSelectAgg = (agg: DataFieldBinding['agg'] | undefined) => {
    if (!selectedColumn || !datasetId || !tableId) return;
    const label = agg
      ? `${agg}(${tableName}.${selectedColumn})`
      : `${tableName}.${selectedColumn}`;
    onSelect({
      type: 'field',
      datasetId,
      tableId,
      column: selectedColumn,
      ...(agg ? { agg } : {}),
      label,
    });
  };

  const handleBack = () => {
    if (step === 'table') setStep('dataset');
    else if (step === 'column') setStep('table');
    else if (step === 'agg') setStep('column');
  };

  const breadcrumb = () => {
    if (step === 'dataset') return 'Pick a field';
    if (step === 'table') return datasetName;
    if (step === 'column') return `${datasetName} / ${tableName}`;
    return `${datasetName} / ${tableName} / ${selectedColumn}`;
  };

  return (
    <div className="w-72 rounded-lg border border-gray-200 bg-white shadow-xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
        <div className="flex items-center gap-1.5 text-xs min-w-0">
          {step !== 'dataset' && (
            <button
              onClick={handleBack}
              className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
          )}
          <span className="truncate text-gray-600">{breadcrumb()}</span>
        </div>
        <button onClick={onCancel} className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* List */}
      <div className="max-h-64 overflow-y-auto p-1">

        {/* ── Step: dataset ── */}
        {step === 'dataset' && (
          loadingDatasets ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
            </div>
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

        {/* ── Step: table ── */}
        {step === 'table' && (
          loadingTables ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
            </div>
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

        {/* ── Step: column ── */}
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
                <ChevronRight className="h-3.5 w-3.5 text-gray-300" />
              </button>
            ))
          )
        )}

        {/* ── Step: agg ── */}
        {step === 'agg' && (
          <div className="p-1 space-y-2">
            {/* Row-by-row option */}
            <button
              onClick={() => handleSelectAgg(undefined)}
              className="flex w-full items-start gap-2.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-left hover:bg-amber-100 transition-colors"
            >
              <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
              <div>
                <p className="text-xs font-medium text-amber-800">Row-by-row (repeating)</p>
                <p className="mt-0.5 text-[10px] text-amber-600">Row will repeat for each data row</p>
              </div>
            </button>

            {/* Aggregation options */}
            <div>
              <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Aggregation
              </p>
              <div className="grid grid-cols-2 gap-1">
                {AGG_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => handleSelectAgg(opt.value)}
                    className="flex flex-col items-start rounded border border-gray-200 px-2.5 py-2 text-left hover:border-blue-300 hover:bg-blue-50 transition-colors"
                  >
                    <span className="text-xs font-semibold text-gray-800">{opt.label}</span>
                    <span className="mt-0.5 text-[10px] leading-tight text-gray-400">{opt.description}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
