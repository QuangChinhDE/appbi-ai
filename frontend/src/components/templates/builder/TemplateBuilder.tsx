'use client';

import React, { useState, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Database, Loader2, FileDown, Printer } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import type {
  TemplateDefinition,
  TemplateColumn,
  TemplateDataSource,
  LayoutType,
  ReportTemplate,
  HeaderLine,
  TemplateFooter,
  ColumnGroup,
  TemplateTheme,
} from '@/types/template';
import { useTemplateData } from '@/hooks/use-template-data';
import { useDataset } from '@/hooks/use-datasets';
import { BuilderCanvas } from './BuilderCanvas';
import { ColumnProperties } from './ColumnProperties';
import { DataSourcePicker } from './DataSourcePicker';
import { Tooltip } from './Tooltip';
import { exportToExcel } from './export-excel';

interface TemplateBuilderProps {
  template: ReportTemplate;
  definition: TemplateDefinition;
  onDefinitionChange: (def: TemplateDefinition) => void;
  onSave: () => void;
  isSaving: boolean;
  hasChanges: boolean;
  canEdit: boolean;
}

export function TemplateBuilder({
  template,
  definition,
  onDefinitionChange,
  onSave,
  isSaving,
  hasChanges,
  canEdit,
}: TemplateBuilderProps) {
  const router = useRouter();

  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);
  const [showDataSourcePicker, setShowDataSourcePicker] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);

  const { data: previewData, isLoading: isLoadingData } = useTemplateData(definition.dataSource);
  const { data: datasetDetail } = useDataset(definition.dataSource?.datasetId ?? null);

  // Extract available columns from columns_cache for the bound table
  const availableColumns = useMemo(() => {
    if (!datasetDetail?.tables || !definition.dataSource?.tableId) return undefined;
    const table = (datasetDetail.tables as any[]).find(
      (t: any) => t.id === definition.dataSource!.tableId,
    );
    const cache = table?.columns_cache;
    if (cache?.columns && Array.isArray(cache.columns)) {
      return cache.columns as Array<{ name: string; type: string; nullable?: boolean }>;
    }
    return undefined;
  }, [datasetDetail, definition.dataSource?.tableId]);

  const selectedColumn = useMemo(
    () => definition.columns.find((c) => c.id === selectedColumnId) ?? null,
    [definition.columns, selectedColumnId],
  );

  /* ── Definition mutation helpers ────────────────────────── */

  const updateDef = useCallback(
    (patch: Partial<TemplateDefinition>) => {
      onDefinitionChange({ ...definition, ...patch });
    },
    [definition, onDefinitionChange],
  );

  const setLayout = useCallback(
    (layout: LayoutType) => updateDef({ layout }),
    [updateDef],
  );

  const setGroupBy = useCallback(
    (groupBy: string | undefined) => updateDef({ groupBy }),
    [updateDef],
  );

  const addColumn = useCallback(() => {
    const id = uuidv4();
    const idx = definition.columns.length + 1;
    const col: TemplateColumn = {
      id,
      key: `col_${idx}`,
      label: `Column ${idx}`,
      type: 'raw',
      width: 100,
      align: 'left',
      format: 'text',
      visible: true,
    };
    updateDef({ columns: [...definition.columns, col] });
    setSelectedColumnId(id);
  }, [definition.columns, updateDef]);

  const updateColumn = useCallback(
    (updated: TemplateColumn) => {
      updateDef({
        columns: definition.columns.map((c) =>
          c.id === updated.id ? updated : c,
        ),
      });
    },
    [definition.columns, updateDef],
  );

  const removeColumn = useCallback(
    (id: string) => {
      updateDef({ columns: definition.columns.filter((c) => c.id !== id) });
      if (selectedColumnId === id) setSelectedColumnId(null);
    },
    [definition.columns, selectedColumnId, updateDef],
  );

  const reorderColumns = useCallback(
    (fromIdx: number, toIdx: number) => {
      const cols = [...definition.columns];
      const [moved] = cols.splice(fromIdx, 1);
      cols.splice(toIdx, 0, moved);
      updateDef({ columns: cols });
    },
    [definition.columns, updateDef],
  );

  const handleDataSourceChange = useCallback(
    (ds: TemplateDataSource) => {
      updateDef({ dataSource: ds });
      setShowDataSourcePicker(false);
    },
    [updateDef],
  );

  const handleHeaderChange = useCallback(
    (title: string, meta?: string) => {
      updateDef({ header: { ...definition.header, title, meta } });
    },
    [definition.header, updateDef],
  );

  const handleHeaderLinesChange = useCallback(
    (lines: HeaderLine[]) => {
      updateDef({ header: { ...definition.header, title: definition.header?.title ?? '', lines } });
    },
    [definition.header, updateDef],
  );

  const handleFooterChange = useCallback(
    (footer: TemplateFooter) => {
      updateDef({ footer });
    },
    [updateDef],
  );

  const handleColumnGroupsChange = useCallback(
    (columnGroups: ColumnGroup[]) => {
      updateDef({ columnGroups: columnGroups.length > 0 ? columnGroups : undefined });
    },
    [updateDef],
  );

  const handleThemeChange = useCallback(
    (theme: TemplateTheme | undefined) => {
      updateDef({ theme });
    },
    [updateDef],
  );

  /* ── Export handlers ────────────────────────────────────── */

  const handleExportExcel = useCallback(() => {
    if (!previewData?.rows) return;
    exportToExcel(definition, previewData.rows, template.name);
  }, [definition, previewData, template.name]);

  const handleExportPDF = useCallback(() => {
    const el = printRef.current;
    if (!el) return;
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    printWindow.document.write(`
      <!DOCTYPE html>
      <html><head>
        <title>${template.name}</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: system-ui, -apple-system, sans-serif; padding: 20px; }
          table { border-collapse: collapse; width: 100%; }
          td, th { border: 1px solid #d1d5db; padding: 4px 8px; font-size: 11px; }
          th { background: #f3f4f6; font-weight: 600; }
          .print-area { background: white; }
          @media print { body { padding: 0; } }
        </style>
      </head><body>
        ${el.innerHTML}
      </body></html>
    `);
    printWindow.document.close();
    setTimeout(() => { printWindow.print(); }, 300);
  }, [template.name]);

  /* ── Row count for status bar ──────────────────────────── */

  const rowCount = previewData?.rows?.length ?? 0;
  const totalRows = previewData?.total ?? 0;

  return (
    <div className="flex h-full flex-col bg-gray-50">
      {/* ── Top Nav ── */}
      <div className="flex h-12 shrink-0 items-center border-b border-gray-200 bg-white px-6 gap-4">
        <button
          onClick={() => router.push('/templates')}
          className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Templates
        </button>

        <span className="text-sm font-medium text-gray-900 truncate max-w-[200px]">
          {template.name}
        </span>

        <div className="flex-1" />

        {definition.dataSource ? (
          <button
            onClick={() => setShowDataSourcePicker(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-50 border border-blue-200 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 transition-colors"
          >
            <Database className="h-3.5 w-3.5" />
            {definition.dataSource.datasetName ?? 'Dataset'} → {definition.dataSource.tableName ?? 'Table'}
          </button>
        ) : (
          <button
            onClick={() => setShowDataSourcePicker(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 transition-colors"
          >
            <Database className="h-3.5 w-3.5" />
            Bind Dataset
          </button>
        )}

        <button
          onClick={onSave}
          disabled={!hasChanges || isSaving || !canEdit}
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : hasChanges ? 'Save' : 'Saved'}
        </button>
      </div>

      {/* ── Main 2-column layout ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Center canvas */}
        <BuilderCanvas
          definition={definition}
          selectedColumnId={selectedColumnId}
          onSelectColumn={setSelectedColumnId}
          onLayoutChange={setLayout}
          onGroupByChange={setGroupBy}
          onHeaderChange={handleHeaderChange}
          onHeaderLinesChange={handleHeaderLinesChange}
          onFooterChange={handleFooterChange}
          onColumnGroupsChange={handleColumnGroupsChange}
          onThemeChange={handleThemeChange}
          onAddColumn={addColumn}
          onReorderColumns={reorderColumns}
          previewData={previewData}
          isLoadingData={isLoadingData}
          canEdit={canEdit}
          printRef={printRef}
        />

        {/* Right sidebar */}
        <ColumnProperties
          column={selectedColumn}
          columns={definition.columns}
          dataSource={definition.dataSource}
          availableColumns={availableColumns}
          onColumnChange={updateColumn}
          onRemoveColumn={removeColumn}
          onSelectColumn={setSelectedColumnId}
          onAddColumn={addColumn}
          canEdit={canEdit}
        />
      </div>

      {/* ── Status Bar ── */}
      <div className="flex h-7 shrink-0 items-center border-t border-gray-200 bg-white px-6 gap-4 text-[11px] text-gray-400">
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: definition.dataSource ? '#22c55e' : '#fbbf24' }}
          />
          {definition.dataSource ? 'DB connected' : 'No data source'}
        </span>
        {isLoadingData && <span>Loading data…</span>}
        {!isLoadingData && previewData && (
          <span>{rowCount}{totalRows > rowCount ? ` / ${totalRows}` : ''} rows</span>
        )}
        <span>Layout: {definition.layout}{definition.groupBy ? ` · group by ${definition.groupBy}` : ''}</span>
        <div className="flex-1" />
        <Tooltip content="Xuất dữ liệu ra file Excel (.xlsx) theo cấu trúc template hiện tại" position="top">
          <button
            onClick={handleExportExcel}
            disabled={!previewData?.rows?.length}
            className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <FileDown className="h-3 w-3" />
            Export Excel
          </button>
        </Tooltip>
        <Tooltip content="In hoặc xuất PDF qua trình duyệt (Ctrl+P)" position="top">
          <button
            onClick={handleExportPDF}
            className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700"
          >
            <Printer className="h-3 w-3" />
            Export PDF
          </button>
        </Tooltip>
      </div>

      {/* ── Data Source Picker Modal ── */}
      {showDataSourcePicker && (
        <DataSourcePicker
          current={definition.dataSource}
          onSelect={handleDataSourceChange}
          onClose={() => setShowDataSourcePicker(false)}
        />
      )}
    </div>
  );
}
