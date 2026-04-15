'use client';

import React, { useState, useMemo } from 'react';
import { Loader2, Database, Table2, X, Search } from 'lucide-react';
import { useDatasets, useDataset, type DatasetTable } from '@/hooks/use-datasets';
import type { TemplateDataSource } from '@/types/template';

interface DataSourcePickerProps {
  current?: TemplateDataSource;
  onSelect: (ds: TemplateDataSource) => void;
  onClose: () => void;
}

export function DataSourcePicker({ current, onSelect, onClose }: DataSourcePickerProps) {
  const [selectedDatasetId, setSelectedDatasetId] = useState<number | null>(
    current?.datasetId ?? null,
  );
  const [search, setSearch] = useState('');

  const { data: datasets, isLoading: datasetsLoading } = useDatasets();
  const { data: datasetDetail, isLoading: tablesLoading } = useDataset(selectedDatasetId);

  const tables = datasetDetail?.tables as DatasetTable[] | undefined;

  const filteredDatasets = useMemo(() => {
    if (!datasets) return [];
    if (!search) return datasets;
    const q = search.toLowerCase();
    return datasets.filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        (d.description ?? '').toLowerCase().includes(q),
    );
  }, [datasets, search]);

  const handleSelectTable = (table: DatasetTable) => {
    const ds = datasets?.find((d) => d.id === selectedDatasetId);
    onSelect({
      datasetId: selectedDatasetId!,
      tableId: table.id,
      datasetName: ds?.name,
      tableName: table.display_name,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-xl" style={{ maxHeight: '80vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-blue-600" />
            <span className="text-base font-semibold text-gray-900">Bind Data Source</span>
          </div>
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 border-b border-gray-200 px-6 py-2">
          <Search className="h-4 w-4 text-gray-400" />
          <input
            autoFocus
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-gray-400"
            placeholder="Search datasets..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* 2-column layout */}
        <div className="flex flex-1 overflow-hidden" style={{ minHeight: 300 }}>
          {/* Left: datasets */}
          <div className="w-1/2 overflow-y-auto border-r border-gray-200">
            <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              Datasets
            </div>
            {datasetsLoading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
              </div>
            )}
            {filteredDatasets.map((ds) => (
              <div
                key={ds.id}
                onClick={() => setSelectedDatasetId(ds.id)}
                className={`cursor-pointer border-b border-gray-100 px-3 py-2 transition-colors ${
                  selectedDatasetId === ds.id
                    ? 'bg-blue-50 border-l-[3px] border-l-blue-600'
                    : 'border-l-[3px] border-l-transparent hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <Database className={`h-3.5 w-3.5 shrink-0 ${selectedDatasetId === ds.id ? 'text-blue-600' : 'text-gray-400'}`} />
                  <span className="truncate text-xs font-medium text-gray-900">{ds.name}</span>
                </div>
                {ds.description && (
                  <p className="mt-0.5 truncate text-[10px] text-gray-500">{ds.description}</p>
                )}
              </div>
            ))}
            {!datasetsLoading && filteredDatasets.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-gray-400">No datasets found</div>
            )}
          </div>

          {/* Right: tables */}
          <div className="w-1/2 overflow-y-auto">
            <div className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              Tables
            </div>
            {!selectedDatasetId && (
              <div className="px-3 py-6 text-center text-xs text-gray-400">
                Select a dataset to see its tables
              </div>
            )}
            {tablesLoading && selectedDatasetId && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
              </div>
            )}
            {tables?.filter((t) => t.enabled).map((table) => {
              const isCurrent =
                current?.datasetId === selectedDatasetId && current?.tableId === table.id;

              return (
                <div
                  key={table.id}
                  onClick={() => handleSelectTable(table)}
                  className={`cursor-pointer border-b border-gray-100 px-3 py-2 transition-colors hover:bg-gray-50 ${
                    isCurrent ? 'bg-blue-50' : ''
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <Table2 className="h-3.5 w-3.5 shrink-0 text-blue-500" />
                    <span className="truncate text-xs font-medium text-gray-900">{table.display_name}</span>
                    {isCurrent && (
                      <span className="ml-auto rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-medium text-blue-700">
                        bound
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex gap-2 text-[10px] text-gray-500">
                    <span>{table.source_kind}</span>
                    {table.columns_cache && (
                      <span>{Object.keys(table.columns_cache).length} columns</span>
                    )}
                  </div>
                  {table.columns_cache && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {Object.keys(table.columns_cache).slice(0, 8).map((colName) => (
                        <span
                          key={colName}
                          className="rounded bg-gray-100 px-1.5 py-px text-[9px] font-mono text-gray-600"
                        >
                          {colName}
                        </span>
                      ))}
                      {Object.keys(table.columns_cache).length > 8 && (
                        <span className="text-[9px] text-gray-400">
                          +{Object.keys(table.columns_cache).length - 8} more
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-gray-200 bg-gray-50 px-6 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-gray-300 px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
