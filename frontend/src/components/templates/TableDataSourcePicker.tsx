'use client';

import React, { useState, useMemo, useEffect } from 'react';
import {
  Database, Table2, ChevronDown, Loader2, Check,
  ArrowUp, ArrowDown, GripVertical,
} from 'lucide-react';
import { useDatasets, useDatasetTables } from '@/hooks/use-datasets';
import type {
  TableDataSource,
  TableDataSourceColumn,
  TableConfig,
  TableRowDef,
  TableCellDef,
  DataFieldBinding,
} from '@/types/template';

/* ── Helpers ───────────────────────────────────────────────── */

function generateTableConfig(
  source: TableDataSource,
): Partial<TableConfig> {
  const cols = source.columns;

  const headerCells: TableCellDef[] = cols.map((c) => ({
    value: c.label,
    bold: true,
    align: c.align ?? 'left',
  }));
  const headerRow: TableRowDef = { cells: headerCells, isHeader: true };

  const dataCells: TableCellDef[] = cols.map((c) => ({
    value: {
      type: 'field' as const,
      datasetId: source.datasetId,
      tableId: source.tableId,
      column: c.column,
      label: `${source.tableName ?? 'table'}.${c.column}`,
    } satisfies DataFieldBinding,
    align: c.align ?? 'left',
  }));
  const dataRow: TableRowDef = { cells: dataCells, isHeader: false };

  return {
    columns: cols.length,
    columnWidths: cols.map((c) => c.width ?? Math.max(80, Math.min(200, c.label.length * 10 + 40))),
    rows: [headerRow, dataRow],
    showBorder: true,
    dataSource: source,
  };
}

/* ── Props ─────────────────────────────────────────────────── */

interface TableDataSourcePickerProps {
  current?: TableDataSource;
  onApply: (source: TableDataSource, generatedConfig: Partial<TableConfig>) => void;
}

/* ── Component ─────────────────────────────────────────────── */

export function TableDataSourcePicker({ current, onApply }: TableDataSourcePickerProps) {
  const [datasetId, setDatasetId] = useState<number | null>(current?.datasetId ?? null);
  const [tableId, setTableId] = useState<number | null>(current?.tableId ?? null);
  const [selectedCols, setSelectedCols] = useState<Map<string, TableDataSourceColumn>>(
    () => new Map((current?.columns ?? []).map((c) => [c.column, c])),
  );
  const [colOrder, setColOrder] = useState<string[]>(
    () => (current?.columns ?? []).map((c) => c.column),
  );

  const { data: datasets = [], isLoading: loadingDatasets } = useDatasets();
  const { data: tables, isLoading: loadingTables } = useDatasetTables(datasetId);

  const selectedDataset = datasets.find((ds: any) => ds.id === datasetId);
  const selectedTable = tables?.find((t) => t.id === tableId);

  const availableColumns: string[] = useMemo(() => {
    const cc = selectedTable?.columns_cache;
    if (!cc) return [];
    if (Array.isArray(cc)) return cc.map((c: any) => c.name ?? c);
    if (cc.columns && Array.isArray(cc.columns))
      return cc.columns.map((c: any) => c.name ?? c).filter(Boolean);
    if (cc.source_columns && Array.isArray(cc.source_columns))
      return cc.source_columns.map(String);
    return [];
  }, [selectedTable]);

  // Auto-select all columns when table changes (if no prior selection)
  useEffect(() => {
    if (availableColumns.length > 0 && selectedCols.size === 0) {
      const next = new Map<string, TableDataSourceColumn>();
      availableColumns.forEach((col) => next.set(col, { column: col, label: col }));
      setSelectedCols(next);
      setColOrder(availableColumns);
    }
  }, [availableColumns]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Handlers ─────────────────────────────────────────────── */

  const handleDatasetChange = (val: string) => {
    const id = val ? Number(val) : null;
    setDatasetId(id);
    setTableId(null);
    setSelectedCols(new Map());
    setColOrder([]);
  };

  const handleTableChange = (val: string) => {
    const id = val ? Number(val) : null;
    setTableId(id);
    setSelectedCols(new Map());
    setColOrder([]);
  };

  const toggleColumn = (col: string) => {
    const next = new Map(selectedCols);
    if (next.has(col)) {
      next.delete(col);
      setColOrder((o) => o.filter((c) => c !== col));
    } else {
      next.set(col, { column: col, label: col });
      setColOrder((o) => [...o, col]);
    }
    setSelectedCols(next);
  };

  const selectAll = () => {
    const next = new Map<string, TableDataSourceColumn>();
    availableColumns.forEach((col) => next.set(col, { column: col, label: col }));
    setSelectedCols(next);
    setColOrder(availableColumns);
  };

  const selectNone = () => {
    setSelectedCols(new Map());
    setColOrder([]);
  };

  const moveColumn = (col: string, dir: -1 | 1) => {
    setColOrder((prev) => {
      const idx = prev.indexOf(col);
      if (idx < 0) return prev;
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  const updateColumnLabel = (col: string, label: string) => {
    setSelectedCols((prev) => {
      const next = new Map(prev);
      const existing = next.get(col);
      if (existing) next.set(col, { ...existing, label });
      return next;
    });
  };

  /* ── Apply ────────────────────────────────────────────────── */

  const handleApply = () => {
    if (!datasetId || !tableId || colOrder.length === 0) return;

    const columns: TableDataSourceColumn[] = colOrder
      .map((col) => selectedCols.get(col))
      .filter(Boolean) as TableDataSourceColumn[];

    const datasetName = selectedDataset?.name ?? '';
    const tableName = selectedTable?.display_name ?? '';

    const source: TableDataSource = {
      datasetId,
      tableId,
      datasetName,
      tableName,
      columns,
    };

    onApply(source, generateTableConfig(source));
  };

  const canApply = datasetId != null && tableId != null && colOrder.length > 0;

  /* ── Render ───────────────────────────────────────────────── */

  return (
    <div className="space-y-4">
      {/* ── Step 1: Dataset Dropdown ── */}
      <div>
        <label className="block text-xs font-medium text-gray-700 mb-1.5 flex items-center gap-1.5">
          <Database className="w-3.5 h-3.5" />
          Dataset
        </label>
        <div className="relative">
          <select
            value={datasetId ?? ''}
            onChange={(e) => handleDatasetChange(e.target.value)}
            disabled={loadingDatasets}
            className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white appearance-none pr-8 disabled:opacity-60"
          >
            <option value="">Select dataset...</option>
            {datasets.map((ds: any) => (
              <option key={ds.id} value={ds.id}>{ds.name}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
        </div>
      </div>

      {/* ── Step 2: Table Dropdown ── */}
      {datasetId && (
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1.5 flex items-center gap-1.5">
            <Table2 className="w-3.5 h-3.5" />
            Table
          </label>
          <div className="relative">
            <select
              value={tableId ?? ''}
              onChange={(e) => handleTableChange(e.target.value)}
              disabled={loadingTables || !tables?.length}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white appearance-none pr-8 disabled:opacity-60"
            >
              <option value="">Select table...</option>
              {(tables ?? []).map((t) => (
                <option key={t.id} value={t.id}>{t.display_name}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
          </div>
          {tables && tables.length === 0 && !loadingTables && (
            <p className="text-[10px] text-gray-400 mt-1">No tables in this dataset.</p>
          )}
        </div>
      )}

      {/* ── Step 3: Column Selection ── */}
      {tableId && availableColumns.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-medium text-gray-700">
              Columns
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={selectAll}
                className="text-[10px] font-medium text-blue-600 hover:text-blue-800"
              >
                All
              </button>
              <span className="text-gray-300 text-[10px]">|</span>
              <button
                onClick={selectNone}
                className="text-[10px] font-medium text-gray-500 hover:text-gray-700"
              >
                None
              </button>
              <span className="text-[10px] text-gray-400 ml-1">
                {selectedCols.size}/{availableColumns.length}
              </span>
            </div>
          </div>

          <div className="rounded-lg border border-gray-200 bg-white max-h-48 overflow-y-auto">
            {availableColumns.map((col) => {
              const isSelected = selectedCols.has(col);
              return (
                <label
                  key={col}
                  className={`flex items-center gap-2.5 px-2.5 py-1.5 cursor-pointer transition-colors ${
                    isSelected ? 'bg-blue-50/60' : 'hover:bg-gray-50'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleColumn(col)}
                    className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 h-3.5 w-3.5"
                  />
                  <span className="flex-1 truncate font-mono text-xs text-gray-700">{col}</span>
                  {isSelected && (
                    <span className="shrink-0 text-[9px] font-medium text-blue-500">
                      #{colOrder.indexOf(col) + 1}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Selected columns reorder + rename ── */}
      {colOrder.length > 0 && (
        <div>
          <p className="text-xs font-medium text-gray-700 mb-1.5">
            Column order & headers
          </p>
          <div className="rounded-lg border border-gray-200 bg-white space-y-0">
            {colOrder.map((col, idx) => {
              const entry = selectedCols.get(col);
              if (!entry) return null;
              return (
                <div
                  key={col}
                  className="flex items-center gap-1 border-b border-gray-100 last:border-b-0 px-2 py-1"
                >
                  <GripVertical className="h-3 w-3 shrink-0 text-gray-300" />
                  <span className="text-[9px] font-bold text-gray-400 w-4 text-center shrink-0">
                    {idx + 1}
                  </span>
                  <input
                    type="text"
                    value={entry.label}
                    onChange={(e) => updateColumnLabel(col, e.target.value)}
                    className="flex-1 min-w-0 rounded bg-transparent px-1 py-0.5 text-xs text-gray-700 focus:outline-none focus:bg-blue-50"
                    title={`Header label for ${col}`}
                  />
                  <div className="flex shrink-0">
                    <button
                      onClick={() => moveColumn(col, -1)}
                      disabled={idx === 0}
                      className="rounded p-0.5 text-gray-400 hover:text-gray-600 disabled:opacity-30"
                    >
                      <ArrowUp className="h-2.5 w-2.5" />
                    </button>
                    <button
                      onClick={() => moveColumn(col, 1)}
                      disabled={idx === colOrder.length - 1}
                      className="rounded p-0.5 text-gray-400 hover:text-gray-600 disabled:opacity-30"
                    >
                      <ArrowDown className="h-2.5 w-2.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Apply Button ── */}
      {tableId && (
        <button
          onClick={handleApply}
          disabled={!canApply}
          className="w-full inline-flex items-center justify-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          <Check className="h-3.5 w-3.5" />
          Apply to Table
        </button>
      )}
    </div>
  );
}

export { generateTableConfig };
