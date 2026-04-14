'use client';

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ChevronLeft, Save, Eye, Edit2, Loader2, Printer, Check, X,
  Upload, FileDown, FileText, Filter, Grid3X3,
} from 'lucide-react';
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';

import { useReportTemplate, useUpdateReportTemplate } from '@/hooks/use-report-templates';
import { useTemplatePreviewData } from '@/hooks/use-template-preview-data';
import { useSpreadsheetPreviewData } from '@/hooks/use-spreadsheet-preview-data';
import { reportTemplateApi } from '@/lib/api/report-templates';
import type { TemplateBlock, TemplateFilter, SheetData } from '@/types/template';
import { isSheetData, createDefaultSheet } from '@/types/template';

// New spreadsheet components
import { SpreadsheetEditor } from '@/components/templates/SpreadsheetEditor';
import { SpreadsheetPreview } from '@/components/templates/SpreadsheetPreview';

// Legacy block components
import { BlockPalette, type BlockTypeDef } from '@/components/templates/BlockPalette';
import { BlockSettings } from '@/components/templates/BlockSettings';
import { TableBlockSettingsModal } from '@/components/templates/TableBlockSettingsModal';
import { TemplateCanvas } from '@/components/templates/TemplateCanvas';
import { TemplatePreview } from '@/components/templates/TemplatePreview';

// Shared components
import { TemplateFilterEditor } from '@/components/templates/TemplateFilterEditor';
import { TemplateFilterBar, type FilterValues } from '@/components/templates/TemplateFilterBar';
import { AppModalShell } from '@/components/common/AppModalShell';
import { useI18n } from '@/providers/LanguageProvider';
import { getResourcePermissions } from '@/hooks/use-resource-permission';

type ViewState = 'edit' | 'preview';

async function normalizeExcelImportFile(file: File): Promise<File> {
  if (/\.xlsx$/i.test(file.name)) {
    return file;
  }

  if (!/\.xls$/i.test(file.name)) {
    throw new Error('Only .xlsx or .xls files are supported.');
  }

  const XLSX = await import('xlsx');
  const workbook = XLSX.read(await file.arrayBuffer(), {
    type: 'array',
    cellStyles: true,
  });
  const normalizedBuffer = XLSX.write(workbook, {
    type: 'array',
    bookType: 'xlsx',
  });
  const normalizedName = file.name.replace(/\.xls$/i, '.xlsx');

  return new File(
    [normalizedBuffer],
    normalizedName,
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  );
}

export default function TemplateDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { t } = useI18n();
  const templateId = Number(params.id);

  const { data: template, isLoading } = useReportTemplate(templateId);
  const updateMutation = useUpdateReportTemplate();

  /* ── Shared state ────────────────────────────────────────── */

  const [viewState, setViewState] = useState<ViewState>('edit');
  const [hasChanges, setHasChanges] = useState(false);
  const [pageSize, setPageSize] = useState('A4');
  const [orientation, setOrientation] = useState('portrait');
  const [description, setDescription] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [filters, setFilters] = useState<TemplateFilter[]>([]);
  const [filterValues, setFilterValues] = useState<FilterValues>({});
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [editedName, setEditedName] = useState('');
  const [showFilterModal, setShowFilterModal] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ── Format detection: spreadsheet (v2) vs legacy blocks ── */

  const [sheetData, setSheetData] = useState<SheetData | null>(null);
  const [blocks, setBlocks] = useState<TemplateBlock[]>([]);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [showTableModal, setShowTableModal] = useState(false);

  const useSpreadsheet = sheetData !== null;

  const resPerms = getResourcePermissions(template?.user_permission);
  const canEdit = resPerms.canEdit;

  // ── Sync from server ──────────────────────────────────────

  useEffect(() => {
    if (template) {
      const raw = template.blocks;
      if (isSheetData(raw)) {
        setSheetData(raw);
        setBlocks([]);
      } else {
        const arr = (raw as TemplateBlock[]) ?? [];
        if (arr.length === 0) {
          // Empty template → auto-create spreadsheet
          setSheetData(createDefaultSheet(template.page_size ?? 'A4', template.orientation ?? 'portrait'));
          setBlocks([]);
        } else {
          // Legacy blocks
          setBlocks(arr);
          setSheetData(null);
        }
      }
      setFilters((template.filters ?? []) as TemplateFilter[]);
      setPageSize(template.page_size ?? 'A4');
      setOrientation(template.orientation ?? 'portrait');
      setDescription(template.description ?? '');
      setHasChanges(false);
    }
  }, [template]);

  /* ── Preview data hooks (only the active format's hook runs) ── */

  const legacyPreviewData = useTemplatePreviewData(
    blocks,
    !useSpreadsheet && viewState === 'preview',
    filters,
    filterValues,
  );

  const sheetPreviewData = useSpreadsheetPreviewData(
    sheetData ?? { version: 2, colCount: 0, rowCount: 0, colWidths: [], rowHeights: [], cells: {}, merges: [] },
    useSpreadsheet && viewState === 'preview',
    filters,
    filterValues,
  );

  const previewLoading = useSpreadsheet ? sheetPreviewData.isLoading : legacyPreviewData.isLoading;
  const previewHasError = useSpreadsheet ? sheetPreviewData.hasError : legacyPreviewData.hasError;
  const previewErrorMessages = useSpreadsheet ? sheetPreviewData.errorMessages : legacyPreviewData.errorMessages;
  const previewTruncated = useSpreadsheet ? sheetPreviewData.truncatedSources : legacyPreviewData.truncatedSources;
  const previewSourceCount = useSpreadsheet ? sheetPreviewData.sourceCount : legacyPreviewData.sourceCount;

  /* ── Spreadsheet handlers ──────────────────────────────────── */

  const handleSheetChange = useCallback((updated: SheetData) => {
    setSheetData(updated);
    setHasChanges(true);
  }, []);

  // Convert legacy blocks to spreadsheet
  const handleConvertToSpreadsheet = useCallback(() => {
    const sheet = createDefaultSheet(pageSize, orientation);
    setSheetData(sheet);
    setBlocks([]);
    setSelectedBlockId(null);
    setHasChanges(true);
    toast.success('Converted to spreadsheet format');
  }, [pageSize, orientation]);

  /* ── Legacy block handlers ─────────────────────────────────── */

  const selectedBlock = blocks.find((b) => b.id === selectedBlockId) ?? null;

  const handleAddBlock = useCallback((typeDef: BlockTypeDef) => {
    const bottomY = blocks.reduce((max, b) => Math.max(max, b.layout.y + b.layout.height), 24);
    const newBlock: TemplateBlock = {
      id: uuidv4(),
      type: typeDef.type as TemplateBlock['type'],
      layout: { x: 24, y: bottomY + 16, width: typeDef.defaultW, height: typeDef.defaultH },
      config: {},
    };
    setBlocks((prev) => [...prev, newBlock]);
    setSelectedBlockId(newBlock.id);
    setHasChanges(true);
    if (typeDef.type === 'table') setShowTableModal(true);
  }, [blocks]);

  const handleRemoveBlock = useCallback((id: string) => {
    setBlocks((prev) => prev.filter((b) => b.id !== id));
    if (selectedBlockId === id) setSelectedBlockId(null);
    setHasChanges(true);
  }, [selectedBlockId]);

  const handleDuplicateBlock = useCallback((id: string) => {
    const original = blocks.find((b) => b.id === id);
    if (!original) return;
    const dup: TemplateBlock = {
      ...original,
      id: uuidv4(),
      layout: { ...original.layout, x: original.layout.x + 20, y: original.layout.y + 20 },
    };
    setBlocks((prev) => [...prev, dup]);
    setSelectedBlockId(dup.id);
    setHasChanges(true);
  }, [blocks]);

  const handleBlocksChange = useCallback((updated: TemplateBlock[]) => {
    setBlocks(updated);
    setHasChanges(true);
  }, []);

  const handleBlockConfigChange = useCallback((updated: TemplateBlock) => {
    setBlocks((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
    setHasChanges(true);
  }, []);

  /* ── Save ────────────────────────────────────────────────── */

  const handleSave = async () => {
    try {
      await updateMutation.mutateAsync({
        id: templateId,
        data: {
          blocks: useSpreadsheet ? sheetData! : blocks,
          filters,
          page_size: pageSize,
          orientation,
          description: description.trim() || undefined,
        },
      });
      setHasChanges(false);
      toast.success('Template saved');
    } catch (error: any) {
      toast.error(`Failed to save: ${error.message}`);
    }
  };

  const handleSaveName = async () => {
    if (!editedName.trim()) return;
    try {
      await updateMutation.mutateAsync({ id: templateId, data: { name: editedName.trim() } });
      setShowRenameModal(false);
      toast.success('Name updated');
    } catch (error: any) {
      toast.error(`Failed to update name: ${error.message}`);
    }
  };

  /* ── Import / Export Excel ─────────────────────────────────── */

  const handleImportExcel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setIsImporting(true);
    try {
      const uploadFile = await normalizeExcelImportFile(file);

      if (useSpreadsheet) {
        // Import as SheetData (v2 spreadsheet format)
        const sheet = await reportTemplateApi.importExcel(uploadFile, 'sheet');
        if (!sheet || !sheet.version) {
          toast.warning('No content found in the Excel file');
          return;
        }
        setSheetData(sheet as SheetData);
        setBlocks([]);
        setHasChanges(true);
        toast.success('Imported Excel into spreadsheet');
      } else {
        // Import as legacy blocks
        const importedBlocks = await reportTemplateApi.importExcel(uploadFile, 'blocks');
        if (!importedBlocks.length) {
          toast.warning('No content found in the Excel file');
          return;
        }
        setBlocks(importedBlocks as TemplateBlock[]);
        setSheetData(null);
        setSelectedBlockId(null);
        setHasChanges(true);
        toast.success(`Imported ${importedBlocks.length} block(s) from Excel`);
      }
    } catch (error: any) {
      toast.error(`Import failed: ${error?.response?.data?.detail || error.message}`);
    } finally {
      setIsImporting(false);
    }
  };

  const handleExportExcel = async () => {
    setIsExporting(true);
    try {
      const activeFilters = filters
        .filter((f) => filterValues[f.id] != null && filterValues[f.id] !== '')
        .map((f) => ({ filterId: f.id, value: filterValues[f.id] }));
      await reportTemplateApi.exportExcel(templateId, activeFilters, template?.name);
    } catch (error: any) {
      toast.error(`Export failed: ${error?.response?.data?.detail || error.message}`);
    } finally {
      setIsExporting(false);
    }
  };

  /* ── Loading ─────────────────────────────────────────────── */

  if (isLoading || !template) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  /* ── Render ──────────────────────────────────────────────── */

  return (
    <div className="flex h-full flex-col">
      {/* ── Header bar ── */}
      <div className="shrink-0 flex items-center gap-2 border-b border-slate-200 bg-white px-4 h-11 print:hidden">
        {/* Breadcrumb */}
        <button
          onClick={() => router.push('/templates')}
          className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800 transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          <span>Templates</span>
        </button>
        <span className="text-gray-300">/</span>
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm font-medium text-gray-900 truncate max-w-[180px]">
            {template.name}
          </span>
          {canEdit && (
            <button
              onClick={() => { setEditedName(template.name); setShowRenameModal(true); }}
              className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
              title="Rename template"
            >
              <Edit2 className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* Format badge */}
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
          useSpreadsheet ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'
        }`}>
          {useSpreadsheet ? 'Spreadsheet' : 'Legacy'}
        </span>

        <div className="w-px h-5 bg-gray-200 mx-1 shrink-0" />

        {/* Edit / Preview tabs */}
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5 shrink-0">
          <button
            onClick={() => setViewState('edit')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              viewState === 'edit' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:bg-white/60'
            }`}
          >
            <Edit2 className="h-3 w-3" />
            Edit
          </button>
          <button
            onClick={() => setViewState('preview')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              viewState === 'preview' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:bg-white/60'
            }`}
          >
            <Eye className="h-3 w-3" />
            Preview
          </button>
        </div>

        <div className="flex-1" />

        {/* Action buttons */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Filter config (edit mode) */}
          {viewState === 'edit' && canEdit && (
            <button
              onClick={() => setShowFilterModal(true)}
              className="inline-flex items-center gap-1.5 rounded border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <Filter className="h-3.5 w-3.5" />
              Filters
              {filters.length > 0 && (
                <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-blue-100 text-blue-700 text-[10px] font-medium">
                  {filters.length}
                </span>
              )}
            </button>
          )}

          {/* Convert to spreadsheet (legacy only) */}
          {!useSpreadsheet && canEdit && viewState === 'edit' && (
            <button
              onClick={handleConvertToSpreadsheet}
              className="inline-flex items-center gap-1.5 rounded border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700 hover:bg-emerald-100 transition-colors"
            >
              <Grid3X3 className="h-3.5 w-3.5" />
              Switch to Spreadsheet
            </button>
          )}

          {viewState === 'preview' && (
            <>
              <button
                onClick={() => window.print()}
                disabled={previewLoading}
                className="inline-flex items-center gap-1.5 rounded border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                <Printer className="h-3.5 w-3.5" />
                Print
              </button>
              <button
                onClick={handleExportExcel}
                disabled={isExporting || previewLoading}
                className="inline-flex items-center gap-1.5 rounded border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                {isExporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
                Export Excel
              </button>
            </>
          )}

          <button
            onClick={handleSave}
            disabled={!hasChanges || updateMutation.isPending || !canEdit}
            className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {updateMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={handleImportExcel}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isImporting}
            className="inline-flex items-center gap-1.5 rounded border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            {isImporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            Import
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      {viewState === 'edit' ? (
        useSpreadsheet ? (
          /* ─── Spreadsheet editor (new format) ─── */
          <div className="flex-1 overflow-hidden">
            <SpreadsheetEditor
              data={sheetData!}
              onChange={handleSheetChange}
              readOnly={!canEdit}
            />
          </div>
        ) : (
          /* ─── Legacy canvas editor ─── */
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex flex-1 overflow-hidden">
              <div className="w-72 shrink-0 overflow-y-auto border-r border-gray-200 bg-gray-50 p-4 space-y-6">
                {canEdit && <BlockPalette onAddBlock={handleAddBlock} />}
                <TemplateFilterEditor
                  filters={filters}
                  onChange={(f) => { setFilters(f); setHasChanges(true); }}
                  disabled={!canEdit}
                />
                {selectedBlock && selectedBlock.type !== 'table' && (
                  <BlockSettings
                    block={selectedBlock}
                    onChange={handleBlockConfigChange}
                    onClose={() => setSelectedBlockId(null)}
                  />
                )}
                {selectedBlock?.type === 'table' && (
                  <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Table block</p>
                      <button
                        onClick={() => setSelectedBlockId(null)}
                        className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    {(selectedBlock.config as any)?.dataSource && (
                      <p className="text-xs text-gray-500 truncate">
                        {(selectedBlock.config as any).dataSource.datasetName} → {(selectedBlock.config as any).dataSource.tableName}
                      </p>
                    )}
                    <button
                      onClick={() => setShowTableModal(true)}
                      className="w-full inline-flex items-center justify-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700 transition-colors"
                    >
                      Open Table Settings
                    </button>
                  </div>
                )}
              </div>
              <div className="flex-1 overflow-hidden">
                <TemplateCanvas
                  blocks={blocks}
                  selectedBlockId={selectedBlockId}
                  onSelectBlock={setSelectedBlockId}
                  onBlocksChange={handleBlocksChange}
                  onRemoveBlock={handleRemoveBlock}
                  onDuplicateBlock={handleDuplicateBlock}
                  editable={canEdit}
                />
              </div>
            </div>
            {showTableModal && selectedBlock?.type === 'table' && (
              <TableBlockSettingsModal
                block={selectedBlock}
                onChange={handleBlockConfigChange}
                onClose={() => setShowTableModal(false)}
              />
            )}
          </div>
        )
      ) : (
        /* ─── Preview mode ─── */
        <div className="flex flex-1 flex-col overflow-hidden">
          <TemplateFilterBar filters={filters} values={filterValues} onChange={setFilterValues} />

          <div className="template-print-host flex-1 overflow-y-auto print:overflow-visible">
            {(previewLoading || previewHasError || previewTruncated > 0) && (
              <div className="sticky top-0 z-10 border-b border-gray-200 bg-white/95 px-6 py-3 text-sm print:hidden">
                {previewLoading && previewSourceCount > 0 && (
                  <div className="flex items-center gap-2 text-gray-600">
                    <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
                    Loading live dataset values for preview...
                  </div>
                )}
                {!previewLoading && previewHasError && (
                  <div className="text-amber-700">
                    Some bound data could not be loaded. Placeholder labels will remain where data is unavailable.
                    {previewErrorMessages[0] ? ` ${previewErrorMessages[0]}` : ''}
                  </div>
                )}
                {!previewLoading && previewTruncated > 0 && !previewHasError && (
                  <div className="text-gray-600">
                    Preview shows up to 1 000 rows per bound table. Large datasets may be truncated.
                  </div>
                )}
              </div>
            )}

            {useSpreadsheet ? (
              <SpreadsheetPreview
                resolved={sheetPreviewData.resolved}
                pageSize={pageSize}
                orientation={orientation}
              />
            ) : (
              <TemplatePreview
                blocks={legacyPreviewData.blocks}
                pageSize={pageSize}
                orientation={orientation}
              />
            )}
          </div>
        </div>
      )}

      {/* ── Filter config modal (spreadsheet mode) ── */}
      {showFilterModal && (
        <AppModalShell
          title="Template Filters"
          onClose={() => setShowFilterModal(false)}
          maxWidthClass="max-w-lg"
          icon={<Filter className="h-5 w-5" />}
          footer={
            <button
              onClick={() => setShowFilterModal(false)}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Done
            </button>
          }
        >
          <TemplateFilterEditor
            filters={filters}
            onChange={(f) => { setFilters(f); setHasChanges(true); }}
            disabled={!canEdit}
          />
        </AppModalShell>
      )}

      {/* ── Rename modal ── */}
      {showRenameModal && (
        <AppModalShell
          title="Rename template"
          onClose={() => setShowRenameModal(false)}
          maxWidthClass="max-w-sm"
          icon={<FileText className="h-5 w-5" />}
          footer={
            <>
              <button
                onClick={() => setShowRenameModal(false)}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveName}
                disabled={!editedName.trim() || updateMutation.isPending}
                className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {updateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Save
              </button>
            </>
          }
        >
          <input
            autoFocus
            type="text"
            value={editedName}
            onChange={(e) => setEditedName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSaveName(); if (e.key === 'Escape') setShowRenameModal(false); }}
            placeholder="Template name…"
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </AppModalShell>
      )}
    </div>
  );
}
