'use client';

import React, { useState, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2 } from 'lucide-react';
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
import { LeftPanel } from './LeftPanel';
import { DataSourcePicker } from './DataSourcePicker';
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
      label: `Cột ${idx}`,
      type: 'raw',
      width: 120,
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

  const handleHeaderLinesChange = useCallback(
    (lines: HeaderLine[]) => {
      updateDef({ header: { ...definition.header, title: definition.header?.title ?? '', lines } });
    },
    [definition.header, updateDef],
  );

  const handleHeaderTitleChange = useCallback(
    (title: string, meta?: string) => {
      updateDef({ header: { ...definition.header, title, meta } });
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

  const rowCount = previewData?.rows?.length ?? 0;
  const totalRows = previewData?.total ?? 0;

  return (
    <div className="flex h-full flex-col bg-surface-2">
      {/* ── Top Nav ── */}
      <div className="flex h-11 shrink-0 items-center border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 gap-3">
        <button
          onClick={() => router.push('/templates')}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-text-tertiary hover:bg-surface-2 hover:text-text-secondary transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Templates</span>
        </button>

        <div className="h-4 w-px bg-surface-3" />

        <span className="text-sm font-semibold text-text-primary truncate max-w-[280px]">
          {template.name}
        </span>

        {hasChanges && (
          <span className="inline-flex items-center rounded-full bg-warning/10 border border-warning/30 px-2 py-0.5 text-[10px] font-medium text-warning">
            Chưa lưu
          </span>
        )}

        <div className="flex-1" />

        <button
          onClick={onSave}
          disabled={!hasChanges || isSaving || !canEdit}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isSaving ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Đang lưu…
            </>
          ) : (
            'Lưu'
          )}
        </button>
      </div>

      {/* ── Main layout: Left Panel + Canvas ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Panel */}
        <LeftPanel
          definition={definition}
          selectedColumn={selectedColumn}
          availableColumns={availableColumns}
          previewData={previewData}
          isLoadingData={isLoadingData}
          rowCount={rowCount}
          totalRows={totalRows}
          canEdit={canEdit}
          onOpenDataSourcePicker={() => setShowDataSourcePicker(true)}
          onColumnChange={updateColumn}
          onRemoveColumn={removeColumn}
          onSelectColumn={setSelectedColumnId}
          onAddColumn={addColumn}
          onReorderColumns={reorderColumns}
          onGroupByChange={setGroupBy}
          onHeaderLinesChange={handleHeaderLinesChange}
          onHeaderTitleChange={handleHeaderTitleChange}
          onFooterChange={handleFooterChange}
          onColumnGroupsChange={handleColumnGroupsChange}
          onExportExcel={handleExportExcel}
          onExportPDF={handleExportPDF}
        />

        {/* Canvas */}
        <BuilderCanvas
          definition={definition}
          selectedColumnId={selectedColumnId}
          onSelectColumn={setSelectedColumnId}
          onLayoutChange={setLayout}
          onThemeChange={handleThemeChange}
          onHeaderLinesChange={handleHeaderLinesChange}
          onHeaderTitleChange={handleHeaderTitleChange}
          onFooterChange={handleFooterChange}
          onAddColumn={addColumn}
          previewData={previewData}
          isLoadingData={isLoadingData}
          canEdit={canEdit}
          printRef={printRef}
        />
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
