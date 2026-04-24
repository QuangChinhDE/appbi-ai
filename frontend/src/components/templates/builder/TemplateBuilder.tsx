'use client';

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, PencilLine, LayoutTemplate } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import type {
  TemplateActiveFilterValue,
  TemplateDefinition,
  TemplateColumn,
  TemplateDataSource,
  LayoutType,
  ReportTemplate,
  HeaderLine,
  TemplateFooter,
  ColumnGroup,
  TemplateTheme,
  TemplateFilter,
} from '@/types/template';
import { useTemplateData } from '@/hooks/use-template-data';
import { useDataset } from '@/hooks/use-datasets';
import { reportTemplateApi } from '@/lib/api/report-templates';
import { toast } from '@/lib/toast';
import { BuilderCanvas } from './BuilderCanvas';
import { LeftPanel } from './LeftPanel';
import { DataSourcePicker } from './DataSourcePicker';
import { TemplateEntryGrid } from './TemplateEntryGrid';

interface TemplateBuilderProps {
  template: ReportTemplate;
  definition: TemplateDefinition;
  templateFilters: TemplateFilter[];
  onDefinitionChange: (def: TemplateDefinition) => void;
  onTemplateFiltersChange: (filters: TemplateFilter[]) => void;
  onSave: () => void;
  isSaving: boolean;
  hasChanges: boolean;
  canEdit: boolean;
}

export function TemplateBuilder({
  template,
  definition,
  templateFilters,
  onDefinitionChange,
  onTemplateFiltersChange,
  onSave,
  isSaving,
  hasChanges,
  canEdit,
}: TemplateBuilderProps) {
  const router = useRouter();

  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);
  const [showDataSourcePicker, setShowDataSourcePicker] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<'design' | 'entry'>('design');
  const [activeFilters, setActiveFilters] = useState<TemplateActiveFilterValue[]>([]);
  const [entryRows, setEntryRows] = useState<Record<string, any>[]>([]);
  const [isSavingEntry, setIsSavingEntry] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);

  const {
    data: previewData,
    isLoading: isLoadingData,
    formulaErrors,
    previewErrorMessage,
    refetch: refetchPreviewData,
  } = useTemplateData({
    templateId: template.id,
    dataSource: definition.dataSource,
    columns: definition.columns,
    templateFilters,
    activeFilters,
  });
  const { data: datasetDetail } = useDataset(definition.dataSource?.datasetId ?? null);

  useEffect(() => {
    setActiveFilters((current) => {
      const currentMap = new Map(current.map((item) => [item.filterId, item.value]));
      return templateFilters.map((filter) => ({
        filterId: filter.id,
        value: currentMap.has(filter.id) ? currentMap.get(filter.id) : (filter.defaultValue ?? ''),
      }));
    });
  }, [templateFilters]);

  useEffect(() => {
    setEntryRows(Array.isArray(previewData?.rows) ? previewData.rows.map((row) => ({ ...row })) : []);
  }, [previewData]);

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
      onTemplateFiltersChange(
        templateFilters.map((filter) => ({
          ...filter,
          datasetId: ds.datasetId,
          tableId: ds.tableId,
        })),
      );
      setShowDataSourcePicker(false);
    },
    [onTemplateFiltersChange, templateFilters, updateDef],
  );

  const handleActiveFilterChange = useCallback((filterId: string, value: string) => {
    setActiveFilters((current) => {
      const found = current.some((item) => item.filterId === filterId);
      if (!found) {
        return [...current, { filterId, value }];
      }
      return current.map((item) => item.filterId === filterId ? { ...item, value } : item);
    });
  }, []);

  const handleResetFilters = useCallback(() => {
    setActiveFilters(templateFilters.map((filter) => ({
      filterId: filter.id,
      value: filter.defaultValue ?? '',
    })));
  }, [templateFilters]);

  const getActiveFilterValue = useCallback(
    (filterId: string) => activeFilters.find((item) => item.filterId === filterId)?.value ?? '',
    [activeFilters],
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

  const handleExportExcel = useCallback(async () => {
    try {
      await reportTemplateApi.exportExcel(template.id, activeFilters, template.name, {
        blocks: definition,
        filters: templateFilters,
      });
    } catch (error: any) {
      toast.error(error?.response?.data?.detail || error?.message || 'Failed to export template');
    }
  }, [activeFilters, definition, template.id, template.name, templateFilters]);

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
  const runtimeFilters = useMemo(
    () => templateFilters.filter(
      (filter) =>
        !definition.dataSource ||
        ((filter.datasetId === definition.dataSource.datasetId) && (filter.tableId === definition.dataSource.tableId)),
    ),
    [definition.dataSource, templateFilters],
  );
  const hasActiveRuntimeFilters = useMemo(
    () => runtimeFilters.some((filter) => String(getActiveFilterValue(filter.id) ?? '').trim() !== ''),
    [getActiveFilterValue, runtimeFilters],
  );

  const handleSaveEntryRows = useCallback(async () => {
    try {
      setIsSavingEntry(true);
      await reportTemplateApi.saveManualData(template.id, entryRows, definition);
      toast.success('Template data saved');
      await refetchPreviewData();
    } catch (error: any) {
      toast.error(error?.response?.data?.detail || error?.message || 'Failed to save template data');
    } finally {
      setIsSavingEntry(false);
    }
  }, [definition, entryRows, refetchPreviewData, template.id]);

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

        <div className="flex items-center gap-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 p-0.5">
          <button
            onClick={() => setWorkspaceMode('design')}
            className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              workspaceMode === 'design'
                ? 'bg-surface-1 text-brand shadow-linear-sm'
                : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            <LayoutTemplate className="h-3.5 w-3.5" />
            Design
          </button>
          <button
            onClick={() => setWorkspaceMode('entry')}
            className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              workspaceMode === 'entry'
                ? 'bg-surface-1 text-brand shadow-linear-sm'
                : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            <PencilLine className="h-3.5 w-3.5" />
            Entry
          </button>
        </div>

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

      {runtimeFilters.length > 0 && (
        <div className="flex flex-wrap items-end gap-3 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-3">
          <div className="mr-2 min-w-[140px]">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-text-quaternary">Runtime Filters</p>
            <p className="text-[11px] text-text-quaternary">Use comma-separated values for `in`, `not_in`, and `between`.</p>
          </div>
          {runtimeFilters.map((filter) => (
            <label key={filter.id} className="flex min-w-[180px] flex-col gap-1">
              <span className="text-[11px] font-medium text-text-secondary">{filter.label || filter.column}</span>
              <input
                value={String(getActiveFilterValue(filter.id) ?? '')}
                onChange={(e) => handleActiveFilterChange(filter.id, e.target.value)}
                placeholder={filter.defaultValue || filter.column}
                className="rounded-md border border-[rgb(var(--border-strong))] bg-surface-2 px-2.5 py-1.5 text-xs text-text-secondary outline-none focus:ring-2 focus:ring-brand"
              />
            </label>
          ))}
          <button
            onClick={handleResetFilters}
            className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-3"
          >
            Reset filters
          </button>
        </div>
      )}

      {/* ── Main layout: Left Panel + Canvas ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Panel */}
        <LeftPanel
          definition={definition}
          templateFilters={templateFilters}
          selectedColumn={selectedColumn}
          availableColumns={availableColumns}
          previewData={previewData}
          formulaErrors={formulaErrors}
          previewErrorMessage={previewErrorMessage}
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
          onTemplateFiltersChange={onTemplateFiltersChange}
          onExportExcel={handleExportExcel}
          onExportPDF={handleExportPDF}
        />

        {/* Canvas */}
        {workspaceMode === 'entry' ? (
          <TemplateEntryGrid
            definition={definition}
            rows={entryRows}
            canEdit={canEdit}
            hasActiveFilters={hasActiveRuntimeFilters}
            hasMoreRows={Boolean(previewData?.has_more)}
            isSaving={isSavingEntry}
            onRowsChange={setEntryRows}
            onSave={handleSaveEntryRows}
          />
        ) : (
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
        )}
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
