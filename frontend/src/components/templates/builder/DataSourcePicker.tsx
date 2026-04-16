'use client';

import React, { useState, useMemo } from 'react';
import { Loader2, Database, Table2, X, Search, CheckCircle2 } from 'lucide-react';
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
  const enabledTables = tables?.filter((t) => t.enabled) ?? [];

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

  const getColumnCount = (table: DatasetTable): number => {
    const cache = table.columns_cache as any;
    if (cache?.columns && Array.isArray(cache.columns)) return cache.columns.length;
    if (cache && typeof cache === 'object') return Object.keys(cache).length;
    return 0;
  };

  const getColumnNames = (table: DatasetTable): string[] => {
    const cache = table.columns_cache as any;
    if (cache?.columns && Array.isArray(cache.columns)) {
      return cache.columns.slice(0, 6).map((c: any) => c.name ?? c);
    }
    if (cache && typeof cache === 'object') {
      return Object.keys(cache).slice(0, 6);
    }
    return [];
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div
        className="flex w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        style={{ maxHeight: '82vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <Database className="h-4 w-4 text-blue-600" />
              <span className="text-sm font-semibold text-gray-900">Chọn nguồn dữ liệu</span>
            </div>
            <p className="text-xs text-gray-500">
              Chọn dataset và bảng để template lấy dữ liệu từ đó
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Current binding notice */}
        {current && (
          <div className="flex items-center gap-2 border-b border-blue-100 bg-blue-50 px-5 py-2">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-blue-600" />
            <p className="text-xs text-blue-700">
              Đang dùng: <span className="font-semibold">{current.datasetName}</span>
              {' → '}
              <span className="font-semibold">{current.tableName}</span>
              <span className="text-blue-500"> (click bảng khác để thay đổi)</span>
            </p>
          </div>
        )}

        {/* Search */}
        <div className="flex items-center gap-2 border-b border-gray-200 px-5 py-2.5">
          <Search className="h-4 w-4 shrink-0 text-gray-400" />
          <input
            autoFocus
            className="flex-1 bg-transparent text-sm text-gray-900 outline-none placeholder:text-gray-400"
            placeholder="Tìm dataset theo tên…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-gray-400 hover:text-gray-600">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* 2-column layout */}
        <div className="flex flex-1 overflow-hidden" style={{ minHeight: 300 }}>
          {/* Left: Datasets */}
          <div className="w-2/5 overflow-y-auto border-r border-gray-200">
            <div className="sticky top-0 bg-gray-50 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400 border-b border-gray-200">
              Datasets ({filteredDatasets.length})
            </div>
            {datasetsLoading && (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
              </div>
            )}
            {filteredDatasets.map((ds) => {
              const isSelected = selectedDatasetId === ds.id;
              const isCurrent = current?.datasetId === ds.id;
              return (
                <button
                  key={ds.id}
                  onClick={() => setSelectedDatasetId(ds.id)}
                  className={`flex w-full items-start gap-2 border-b border-gray-100 px-4 py-2.5 text-left transition-colors ${
                    isSelected
                      ? 'bg-blue-50 border-l-2 border-l-blue-600'
                      : 'border-l-2 border-l-transparent hover:bg-gray-50'
                  }`}
                >
                  <Database
                    className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${isSelected ? 'text-blue-600' : 'text-gray-400'}`}
                  />
                  <div className="min-w-0">
                    <p className={`truncate text-xs font-medium ${isSelected ? 'text-blue-800' : 'text-gray-900'}`}>
                      {ds.name}
                    </p>
                    {ds.description && (
                      <p className="mt-0.5 truncate text-[10px] text-gray-500">{ds.description}</p>
                    )}
                  </div>
                  {isCurrent && (
                    <span className="ml-auto shrink-0 rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-medium text-blue-700">
                      đang dùng
                    </span>
                  )}
                </button>
              );
            })}
            {!datasetsLoading && filteredDatasets.length === 0 && (
              <div className="px-4 py-8 text-center text-xs text-gray-400">
                Không tìm thấy dataset
              </div>
            )}
          </div>

          {/* Right: Tables */}
          <div className="flex-1 overflow-y-auto">
            <div className="sticky top-0 bg-gray-50 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400 border-b border-gray-200">
              {selectedDatasetId
                ? `Bảng (${enabledTables.length})`
                : 'Bảng dữ liệu'}
            </div>
            {!selectedDatasetId && (
              <div className="flex flex-col items-center justify-center py-12 text-center px-4">
                <Database className="h-8 w-8 text-gray-300 mb-2" />
                <p className="text-xs text-gray-400">Chọn dataset bên trái để xem các bảng</p>
              </div>
            )}
            {tablesLoading && selectedDatasetId && (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
              </div>
            )}
            {enabledTables.map((table) => {
              const isCurrent =
                current?.datasetId === selectedDatasetId && current?.tableId === table.id;
              const colCount = getColumnCount(table);
              const colNames = getColumnNames(table);

              return (
                <button
                  key={table.id}
                  onClick={() => handleSelectTable(table)}
                  className={`flex w-full flex-col gap-1 border-b border-gray-100 px-4 py-3 text-left transition-colors hover:bg-blue-50 ${
                    isCurrent ? 'bg-blue-50 border-l-2 border-l-blue-600' : 'border-l-2 border-l-transparent'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Table2 className={`h-3.5 w-3.5 shrink-0 ${isCurrent ? 'text-blue-600' : 'text-blue-400'}`} />
                    <span className={`text-xs font-semibold ${isCurrent ? 'text-blue-800' : 'text-gray-900'}`}>
                      {table.display_name}
                    </span>
                    {isCurrent && (
                      <CheckCircle2 className="ml-auto h-3.5 w-3.5 shrink-0 text-blue-600" />
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-gray-400 pl-5">
                    <span>{table.source_kind}</span>
                    {colCount > 0 && <span>{colCount} cột</span>}
                  </div>
                  {colNames.length > 0 && (
                    <div className="flex flex-wrap gap-1 pl-5">
                      {colNames.map((name) => (
                        <span
                          key={name}
                          className="rounded bg-gray-100 px-1.5 py-px text-[9px] font-mono text-gray-600"
                        >
                          {name}
                        </span>
                      ))}
                      {colCount > 6 && (
                        <span className="text-[9px] text-gray-400">+{colCount - 6} more</span>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
            {!tablesLoading && selectedDatasetId && enabledTables.length === 0 && (
              <div className="px-4 py-8 text-center text-xs text-gray-400">
                Dataset này chưa có bảng nào được kích hoạt
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-gray-200 bg-gray-50 px-5 py-3">
          <p className="text-xs text-gray-400">
            {selectedDatasetId && enabledTables.length > 0
              ? 'Click vào bảng để chọn và đóng hộp thoại'
              : 'Chọn dataset → chọn bảng'}
          </p>
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100 transition-colors"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
