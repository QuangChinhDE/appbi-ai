'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ChevronLeft, Save, Eye, Edit2, Loader2, Printer, Check, X,
  Upload, FileDown, FileText,
} from 'lucide-react';
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';

import { useReportTemplate, useUpdateReportTemplate } from '@/hooks/use-report-templates';
import { useTemplatePreviewData } from '@/hooks/use-template-preview-data';
import { reportTemplateApi } from '@/lib/api/report-templates';
import type { TemplateBlock, TemplateFilter } from '@/types/template';
import { BlockPalette, type BlockTypeDef } from '@/components/templates/BlockPalette';
import { BlockSettings } from '@/components/templates/BlockSettings';
import { TemplateCanvas } from '@/components/templates/TemplateCanvas';
import { TemplatePreview } from '@/components/templates/TemplatePreview';
import { TableEditor } from '@/components/templates/TableEditor';
import { TemplateFilterEditor } from '@/components/templates/TemplateFilterEditor';
import { TemplateFilterBar, type FilterValues } from '@/components/templates/TemplateFilterBar';
import { AppModalShell } from '@/components/common/AppModalShell';
import { useI18n } from '@/providers/LanguageProvider';
import type { TableConfig } from '@/types/template';
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

  const [viewState, setViewState] = useState<ViewState>('edit');
  const [blocks, setBlocks] = useState<TemplateBlock[]>([]);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [pageSize, setPageSize] = useState('A4');
  const [orientation, setOrientation] = useState('portrait');
  const [description, setDescription] = useState('');
  const [bottomPanelOpen, setBottomPanelOpen] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [filters, setFilters] = useState<TemplateFilter[]>([]);
  const [filterValues, setFilterValues] = useState<FilterValues>({});

  // Rename modal state
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [editedName, setEditedName] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewData = useTemplatePreviewData(
    blocks,
    viewState === 'preview',
    filters,
    filterValues,
  );

  const resPerms = getResourcePermissions(template?.user_permission);
  const canEdit = resPerms.canEdit;

  // Sync from server when loaded
  useEffect(() => {
    if (template) {
      setBlocks(template.blocks ?? []);
      setFilters((template.filters ?? []) as TemplateFilter[]);
      setPageSize(template.page_size ?? 'A4');
      setOrientation(template.orientation ?? 'portrait');
      setDescription(template.description ?? '');
      setHasChanges(false);
    }
  }, [template]);

  const selectedBlock = blocks.find((b) => b.id === selectedBlockId) ?? null;

  // ── Block operations ────────────────────────────────────────────────

  const handleAddBlock = useCallback((typeDef: BlockTypeDef) => {
    const bottomY = blocks.reduce((max, b) => Math.max(max, b.layout.y + b.layout.height), 24);

    const newBlock: TemplateBlock = {
      id: uuidv4(),
      type: typeDef.type as TemplateBlock['type'],
      layout: {
        x: 24,
        y: bottomY + 16,
        width: typeDef.defaultW,
        height: typeDef.defaultH,
      },
      config: {},
    };
    setBlocks((prev) => [...prev, newBlock]);
    setSelectedBlockId(newBlock.id);
    setHasChanges(true);
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

  const handleTableConfigChange = useCallback((config: TableConfig) => {
    if (!selectedBlockId) return;
    setBlocks((prev) =>
      prev.map((b) =>
        b.id === selectedBlockId ? { ...b, config: { ...b.config, ...config } } : b,
      ),
    );
    setHasChanges(true);
  }, [selectedBlockId]);

  const handleBlockConfigChange = useCallback((updated: TemplateBlock) => {
    setBlocks((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
    setHasChanges(true);
  }, []);

  // ── Save ────────────────────────────────────────────────────────────

  const handleSave = async () => {
    try {
      await updateMutation.mutateAsync({
        id: templateId,
        data: {
          blocks,
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

  // ── Import Excel ────────────────────────────────────────────────────

  const handleImportExcel = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setIsImporting(true);
    try {
      const uploadFile = await normalizeExcelImportFile(file);
      const importedBlocks = await reportTemplateApi.importExcel(uploadFile);
      if (!importedBlocks.length) {
        toast.warning('No content found in the Excel file');
        return;
      }
      setBlocks(importedBlocks as TemplateBlock[]);
      setSelectedBlockId(null);
      setHasChanges(true);
      toast.success(`Imported ${importedBlocks.length} block(s) from Excel`);
    } catch (error: any) {
      toast.error(`Import failed: ${error?.response?.data?.detail || error.message}`);
    } finally {
      setIsImporting(false);
    }
  };

  // ── Export Excel ────────────────────────────────────────────────────

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

  // ── Loading ─────────────────────────────────────────────────────────

  if (isLoading || !template) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col">
      {/* ── Header bar — matches app contract (h-11, slate border) ── */}
      <div className="shrink-0 flex items-center gap-2 border-b border-slate-200 bg-white px-4 h-11">
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

        <div className="w-px h-5 bg-gray-200 mx-1 shrink-0" />

        {/* Segmented tab control — app contract */}
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5 shrink-0">
          <button
            onClick={() => setViewState('edit')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              viewState === 'edit'
                ? 'bg-white text-blue-700 shadow-sm'
                : 'text-slate-500 hover:bg-white/60'
            }`}
          >
            <Edit2 className="h-3 w-3" />
            Edit
          </button>
          <button
            onClick={() => setViewState('preview')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              viewState === 'preview'
                ? 'bg-white text-blue-700 shadow-sm'
                : 'text-slate-500 hover:bg-white/60'
            }`}
          >
            <Eye className="h-3 w-3" />
            Preview
          </button>
        </div>

        <div className="flex-1" />

        {/* Action buttons */}
        <div className="flex items-center gap-1.5 shrink-0">
          {viewState === 'preview' && (
            <>
              <button
                onClick={() => window.print()}
                disabled={previewData.isLoading}
                className="inline-flex items-center gap-1.5 rounded border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                <Printer className="h-3.5 w-3.5" />
                Print
              </button>
              <button
                onClick={handleExportExcel}
                disabled={isExporting || previewData.isLoading}
                className="inline-flex items-center gap-1.5 rounded border border-gray-300 bg-white px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                {isExporting
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <FileDown className="h-3.5 w-3.5" />
                }
                Export Excel
              </button>
            </>
          )}

          <button
            onClick={handleSave}
            disabled={!hasChanges || updateMutation.isPending || !canEdit}
            className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {updateMutation.isPending
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Save className="h-3.5 w-3.5" />
            }
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
            {isImporting
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Upload className="h-3.5 w-3.5" />
            }
            Import
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      {viewState === 'edit' ? (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex flex-1 overflow-hidden">
            {/* Left panel */}
            <div className="w-64 shrink-0 overflow-y-auto border-r border-gray-200 bg-gray-50 p-4 space-y-6">
              {canEdit && <BlockPalette onAddBlock={handleAddBlock} />}
              <TemplateFilterEditor
                filters={filters}
                onChange={(f) => { setFilters(f); setHasChanges(true); }}
                disabled={!canEdit}
              />
              {selectedBlock && (
                <BlockSettings
                  block={selectedBlock}
                  onChange={handleBlockConfigChange}
                  onClose={() => setSelectedBlockId(null)}
                />
              )}
            </div>

            {/* Canvas */}
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

          {/* Bottom panel — Table Editor */}
          {selectedBlock?.type === 'table' && (
            <div className="shrink-0 border-t border-gray-200 bg-white">
              <button
                onClick={() => setBottomPanelOpen(!bottomPanelOpen)}
                className="flex w-full items-center justify-between px-4 py-2 text-xs font-semibold uppercase tracking-wider text-gray-500 hover:bg-gray-50"
              >
                <span>Table Editor — {(selectedBlock.config as any).heading || 'Untitled table'}</span>
                <span className="text-gray-400">{bottomPanelOpen ? '▼' : '▲'}</span>
              </button>
              {bottomPanelOpen && (
                <div className="max-h-[320px] overflow-auto p-4">
                  <TableEditor
                    config={selectedBlock.config as TableConfig}
                    onChange={handleTableConfigChange}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Filter bar */}
          <TemplateFilterBar
            filters={filters}
            values={filterValues}
            onChange={setFilterValues}
          />

          <div className="flex-1 overflow-y-auto print:overflow-visible">
            {(previewData.isLoading || previewData.hasError || previewData.truncatedSources > 0) && (
              <div className="sticky top-0 z-10 border-b border-gray-200 bg-white/95 px-6 py-3 text-sm print:hidden">
                {previewData.isLoading && previewData.sourceCount > 0 && (
                  <div className="flex items-center gap-2 text-gray-600">
                    <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
                    Loading live dataset values for preview...
                  </div>
                )}
                {!previewData.isLoading && previewData.hasError && (
                  <div className="text-amber-700">
                    Some bound data could not be loaded. Placeholder labels will remain where data is unavailable.
                    {previewData.errorMessages[0] ? ` ${previewData.errorMessages[0]}` : ''}
                  </div>
                )}
                {!previewData.isLoading && previewData.truncatedSources > 0 && !previewData.hasError && (
                  <div className="text-gray-600">
                    Preview shows up to 1 000 rows per bound table. Large datasets may be truncated.
                  </div>
                )}
              </div>
            )}
            <TemplatePreview
              blocks={previewData.blocks}
              pageSize={pageSize}
              orientation={orientation}
            />
          </div>
        </div>
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
