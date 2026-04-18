'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FileCode2,
  FileSpreadsheet,
  Loader2,
  Sparkles,
  Upload,
} from 'lucide-react';

import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/Button';
import { FieldGroup, Input, Select, Textarea } from '@/components/ui/Input';
import {
  useAnalyzeDashboardHtmlImport,
  useBuildDashboardHtmlImport,
  usePreviewDashboardHtmlImportSource,
} from '@/hooks/use-dashboards';
import { useDatasets, useDatasetTables, useTablePreview } from '@/hooks/use-datasets';
import { summarizeImportedDashboardHtml } from '@/lib/dashboard-html-import';
import { toast } from '@/lib/toast';
import type {
  DashboardHtmlImportAnalyzeResponse,
  DashboardHtmlImportBuildResponse,
  DashboardHtmlImportSourcePreviewResponse,
  DashboardHtmlImportTargetMode,
  DashboardHtmlImportSourceMode,
} from '@/types/dashboard-html-import';

interface DashboardHtmlImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  targetMode: DashboardHtmlImportTargetMode;
  targetDashboardId?: number;
  targetDashboardName?: string;
  onBuilt?: (result: DashboardHtmlImportBuildResponse) => void;
}

function getApiErrorMessage(error: unknown, fallback: string): string {
  const responseError = error as any;
  const detail = responseError?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (typeof responseError?.message === 'string' && responseError.message.trim()) return responseError.message.trim();
  return fallback;
}

function ChartTypeBadge({ value }: { value: string }) {
  return (
    <span className="inline-flex rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-brand">
      {value}
    </span>
  );
}

export function DashboardHtmlImportModal({
  isOpen,
  onClose,
  targetMode,
  targetDashboardId,
  targetDashboardName,
  onBuilt,
}: DashboardHtmlImportModalProps) {
  const router = useRouter();
  const htmlFileInputRef = useRef<HTMLInputElement | null>(null);
  const sourceFileInputRef = useRef<HTMLInputElement | null>(null);

  const [step, setStep] = useState<'configure' | 'preview'>('configure');
  const [htmlInput, setHtmlInput] = useState('');
  const [htmlFilename, setHtmlFilename] = useState('');
  const [sourceMode, setSourceMode] = useState<DashboardHtmlImportSourceMode>('existing_dataset');
  const [selectedDatasetId, setSelectedDatasetId] = useState<number | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourcePreview, setSourcePreview] = useState<DashboardHtmlImportSourcePreviewResponse | null>(null);
  const [activeUploadSheetName, setActiveUploadSheetName] = useState('');
  const [buildName, setBuildName] = useState('');
  const [analysis, setAnalysis] = useState<DashboardHtmlImportAnalyzeResponse | null>(null);
  const [includedBlockIds, setIncludedBlockIds] = useState<string[]>([]);

  const { data: datasets = [] } = useDatasets(0, 200);
  const { data: tables = [] } = useDatasetTables(selectedDatasetId);
  const tablePreviewQuery = useTablePreview(
    selectedDatasetId,
    selectedTableId,
    { limit: 5 },
    { enabled: isOpen && sourceMode === 'existing_dataset' && selectedDatasetId !== null && selectedTableId !== null },
  );
  const analyzeMutation = useAnalyzeDashboardHtmlImport();
  const buildMutation = useBuildDashboardHtmlImport();
  const previewSourceMutation = usePreviewDashboardHtmlImportSource();

  useEffect(() => {
    if (!isOpen) {
      setStep('configure');
      setHtmlInput('');
      setHtmlFilename('');
      setSourceMode('existing_dataset');
      setSelectedDatasetId(null);
      setSelectedTableId(null);
      setSourceFile(null);
      setSourcePreview(null);
      setActiveUploadSheetName('');
      setBuildName('');
      setAnalysis(null);
      setIncludedBlockIds([]);
      analyzeMutation.reset();
      buildMutation.reset();
      previewSourceMutation.reset();
    }
  }, [analyzeMutation, buildMutation, isOpen, previewSourceMutation]);

  useEffect(() => {
    if (!selectedDatasetId) {
      setSelectedTableId(null);
    }
  }, [selectedDatasetId]);

  useEffect(() => {
    if (!tables.length) return;
    if (selectedTableId && tables.some((table) => table.id === selectedTableId)) return;
    setSelectedTableId(tables[0].id);
  }, [selectedTableId, tables]);

  const selectedDataset = useMemo(
    () => datasets.find((dataset) => dataset.id === selectedDatasetId) ?? null,
    [datasets, selectedDatasetId],
  );
  const selectedTable = useMemo(
    () => tables.find((table) => table.id === selectedTableId) ?? null,
    [selectedTableId, tables],
  );
  const selectedPlanCount = includedBlockIds.length;
  const totalPlanCount = analysis?.chart_plans.length ?? 0;
  const sourcePreviewSheetNames = useMemo(
    () => Object.keys(sourcePreview?.sheets ?? {}),
    [sourcePreview],
  );
  const activeUploadSheet = useMemo(() => {
    if (!sourcePreview) return null;
    return sourcePreview.sheets[activeUploadSheetName] ?? sourcePreview.sheets[sourcePreview.default_sheet_name] ?? null;
  }, [activeUploadSheetName, sourcePreview]);

  const handleHtmlFileChange = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      setHtmlInput(text);
      setHtmlFilename(file.name);
      toast.success(`Loaded HTML from ${file.name}`);
    } catch {
      toast.error('Could not read HTML file.');
    }
  };

  const handleSourceFileChange = async (file: File | null) => {
    setSourceFile(file);
    setSourcePreview(null);
    setActiveUploadSheetName('');
    if (!file) return;

    try {
      const preview = await previewSourceMutation.mutateAsync(file);
      setSourcePreview(preview);
      setActiveUploadSheetName(preview.default_sheet_name);
      toast.success(`Loaded ${Object.keys(preview.sheets).length} table preview(s) from ${file.name}`);
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Could not preview the uploaded source file.'));
    }
  };

  const handleAnalyze = async () => {
    const trimmedHtml = htmlInput.trim();
    if (!trimmedHtml) {
      toast.error('HTML import content is required.');
      return;
    }
    if (sourceMode === 'existing_dataset' && !selectedTableId) {
      toast.error('Select a dataset table to map the HTML into native charts.');
      return;
    }
    if (sourceMode === 'upload_excel' && !sourceFile) {
      toast.error('Upload an Excel or CSV source file for this import.');
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    const htmlSummary = summarizeImportedDashboardHtml(trimmedHtml);
    try {
      const result = await analyzeMutation.mutateAsync({
        htmlContent: trimmedHtml,
        htmlSummary,
        sourceMode,
        datasetTableId: sourceMode === 'existing_dataset' ? selectedTableId : null,
        selectedSheetName: sourceMode === 'upload_excel' ? activeUploadSheetName : null,
        excelFile: sourceMode === 'upload_excel' ? sourceFile : null,
      });
      setAnalysis(result);
      setIncludedBlockIds(result.chart_plans.map((plan) => plan.block_id));
      setBuildName((current) => current.trim() || result.suggested_dashboard_name);
      setStep('preview');
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Could not analyze imported HTML.'));
    }
  };

  const handleBuild = async () => {
    if (!analysis) return;
    if (includedBlockIds.length === 0) {
      toast.error('Select at least one mapped chart block to build.');
      return;
    }

    try {
      const result = await buildMutation.mutateAsync({
        analysis,
        sourceMode,
        targetMode,
        targetDashboardId,
        dashboardName: buildName.trim() || analysis.suggested_dashboard_name,
        datasetTableId: sourceMode === 'existing_dataset' ? selectedTableId : null,
        selectedSheetName: sourceMode === 'upload_excel' ? activeUploadSheetName : null,
        includedBlockIds,
        excelFile: sourceMode === 'upload_excel' ? sourceFile : null,
      });

      const typeChangeCount = result.type_changes.length;
      if (typeChangeCount > 0) {
        toast.success(`Imported ${result.created_chart_count} chart(s). ${typeChangeCount} chart(s) were adapted to supported native types.`);
      } else {
        toast.success(`Imported ${result.created_chart_count} chart(s) successfully.`);
      }

      onBuilt?.(result);
      onClose();

      if (targetMode === 'new_dashboard') {
        router.push(`/dashboards/${result.dashboard_id}`);
      }
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Could not build dashboard from the imported HTML.'));
    }
  };

  const togglePlan = (blockId: string) => {
    setIncludedBlockIds((current) => (
      current.includes(blockId)
        ? current.filter((item) => item !== blockId)
        : [...current, blockId]
    ));
  };

  const toggleAllPlans = () => {
    if (!analysis) return;
    setIncludedBlockIds((current) => (
      current.length === analysis.chart_plans.length
        ? []
        : analysis.chart_plans.map((plan) => plan.block_id)
    ));
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={targetMode === 'append_to_dashboard' ? 'Import HTML Into This Dashboard' : 'Import HTML Dashboard'}
      size="full"
      bodyClassName="overflow-hidden p-0"
      contentClassName="max-w-[92rem]"
      footer={
        <>
          {step === 'preview' && (
            <Button variant="ghost" size="sm" onClick={() => setStep('configure')} disabled={buildMutation.isPending}>
              Back
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose} disabled={analyzeMutation.isPending || buildMutation.isPending}>
            Cancel
          </Button>
          {step === 'configure' ? (
            <Button
              variant="primary"
              size="sm"
              onClick={handleAnalyze}
              loading={analyzeMutation.isPending}
            >
              Analyze Import
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              onClick={handleBuild}
              loading={buildMutation.isPending}
            >
              Build Dashboard
            </Button>
          )}
        </>
      }
    >
      <div className="h-full overflow-y-auto px-5 py-4">
      {step === 'configure' ? (
        <div className="space-y-5">
          <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-lg bg-brand/10 p-2 text-brand">
                <Sparkles className="h-4 w-4" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold text-text-primary">
                  HTML is adapted into the native dashboard canvas
                </p>
                <p className="text-caption text-text-tertiary">
                  Import keeps chart order and overall structure, but complex Claude HTML can be converted to the closest supported AppBI chart type when needed.
                </p>
              </div>
            </div>
          </div>

          <FieldGroup
            label="Dashboard HTML"
            required
            description="Paste Claude HTML here, or load a .html file and let the importer summarize the page into chart blocks."
          >
            <Textarea
              value={htmlInput}
              onChange={(event) => setHtmlInput(event.target.value)}
              rows={12}
              placeholder="<html>...</html>"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<FileCode2 className="h-3.5 w-3.5" />}
                onClick={() => htmlFileInputRef.current?.click()}
              >
                Load HTML File
              </Button>
              {htmlFilename && (
                <span className="text-caption text-text-tertiary">
                  {htmlFilename}
                </span>
              )}
              <input
                ref={htmlFileInputRef}
                type="file"
                accept=".html,.htm,text/html"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  void handleHtmlFileChange(file);
                  event.currentTarget.value = '';
                }}
              />
            </div>
          </FieldGroup>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
              <div className="mb-3 flex items-center gap-2">
                <Database className="h-4 w-4 text-brand" />
                <p className="text-sm font-semibold text-text-primary">Choose Source</p>
              </div>
              <div className="space-y-3">
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[rgb(var(--border-line))] p-3">
                  <input
                    type="radio"
                    checked={sourceMode === 'existing_dataset'}
                    onChange={() => setSourceMode('existing_dataset')}
                    className="mt-0.5"
                  />
                  <div>
                    <p className="text-sm font-medium text-text-primary">Use existing dataset table</p>
                    <p className="text-caption text-text-tertiary">Best when the source already exists in AppBI and should stay auto-refreshable.</p>
                  </div>
                </label>
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[rgb(var(--border-line))] p-3">
                  <input
                    type="radio"
                    checked={sourceMode === 'upload_excel'}
                    onChange={() => setSourceMode('upload_excel')}
                    className="mt-0.5"
                  />
                  <div>
                    <p className="text-sm font-medium text-text-primary">Upload Excel / CSV source</p>
                    <p className="text-caption text-text-tertiary">Useful for demo data or when the HTML was designed from a standalone spreadsheet.</p>
                  </div>
                </label>
              </div>

              {sourceMode === 'existing_dataset' ? (
                <div className="mt-4 space-y-3">
                  <FieldGroup label="Dataset">
                    <Select
                      value={selectedDatasetId ?? ''}
                      onChange={(event) => setSelectedDatasetId(event.target.value ? Number(event.target.value) : null)}
                    >
                      <option value="">Select dataset</option>
                      {datasets.map((dataset) => (
                        <option key={dataset.id} value={dataset.id}>
                          {dataset.name}
                        </option>
                      ))}
                    </Select>
                  </FieldGroup>
                  <FieldGroup label="Dataset Table">
                    <Select
                      value={selectedTableId ?? ''}
                      onChange={(event) => setSelectedTableId(event.target.value ? Number(event.target.value) : null)}
                      disabled={!selectedDatasetId}
                    >
                      <option value="">Select table</option>
                      {tables.map((table) => (
                        <option key={table.id} value={table.id}>
                          {table.display_name}
                        </option>
                      ))}
                    </Select>
                  </FieldGroup>
                </div>
              ) : (
                <div className="mt-4 space-y-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    leadingIcon={<Upload className="h-3.5 w-3.5" />}
                    onClick={() => sourceFileInputRef.current?.click()}
                    loading={previewSourceMutation.isPending}
                  >
                    Upload Excel / CSV
                  </Button>
                  {sourceFile && (
                    <div className="rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-caption text-success">
                      {sourceFile.name}
                    </div>
                  )}
                  <input
                    ref={sourceFileInputRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      void handleSourceFileChange(file);
                      event.currentTarget.value = '';
                    }}
                  />
                  <p className="text-caption text-text-tertiary">
                    Every sheet becomes a table during build. The first row of each sheet is treated as that table header.
                  </p>
                </div>
              )}
            </div>

            <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
              <div className="mb-3 flex items-center gap-2">
                {targetMode === 'append_to_dashboard' ? (
                  <FileSpreadsheet className="h-4 w-4 text-brand" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-brand" />
                )}
                <p className="text-sm font-semibold text-text-primary">Build Target</p>
              </div>
              <FieldGroup
                label={targetMode === 'append_to_dashboard' ? 'Imported Page Name' : 'New Dashboard Name'}
                description={targetMode === 'append_to_dashboard'
                  ? `The import will append a new page into ${targetDashboardName ?? 'the current dashboard'}.`
                  : 'The importer creates a new native dashboard from the analyzed chart blocks.'}
              >
                <Input
                  value={buildName}
                  onChange={(event) => setBuildName(event.target.value)}
                  placeholder={targetMode === 'append_to_dashboard' ? 'Imported page name' : 'Imported dashboard name'}
                />
              </FieldGroup>

              {sourceMode === 'existing_dataset' && selectedDataset && selectedTable && (
                <div className="mt-4 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
                  <p className="text-caption font-semibold text-text-primary">
                    {selectedDataset.name} / {selectedTable.display_name}
                  </p>
                  <p className="mt-1 text-caption text-text-tertiary">
                    {tablePreviewQuery.data?.columns.length ?? 0} columns available for chart mapping.
                  </p>
                </div>
              )}

              {sourceMode === 'upload_excel' && (
                <div className="mt-4 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
                  <p className="text-caption font-semibold text-text-primary">Demo-friendly source upload</p>
                  <p className="mt-1 text-caption text-text-tertiary">
                    Uploaded Excel/CSV will be turned into a manual dataset during build so the imported dashboard can run natively in AppBI. All sheets become tables; the selected sheet is used for chart mapping.
                  </p>
                </div>
              )}
            </div>
          </div>

          {sourceMode === 'existing_dataset' && tablePreviewQuery.data && (
            <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
              <div className="mb-3 flex items-center gap-2">
                <Database className="h-4 w-4 text-brand" />
                <p className="text-sm font-semibold text-text-primary">Source Preview</p>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-caption">
                  <thead>
                    <tr className="border-b border-[rgb(var(--border-line))] text-text-tertiary">
                      {tablePreviewQuery.data.columns.slice(0, 6).map((column) => (
                        <th key={column.name} className="px-2 py-1.5 font-medium">
                          {column.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tablePreviewQuery.data.rows.slice(0, 3).map((row, rowIndex) => (
                      <tr key={rowIndex} className="border-b border-[rgb(var(--border-line))]/60">
                        {tablePreviewQuery.data!.columns.slice(0, 6).map((column) => (
                          <td key={column.name} className="px-2 py-1.5 text-text-secondary">
                            {String(row[column.name] ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {sourceMode === 'upload_excel' && sourcePreview && activeUploadSheet && (
            <div className="rounded-xl border border-success/30 bg-success/10 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2 border-b border-success/30">
                <div className="flex items-center gap-2">
                  <FileSpreadsheet className="w-4 h-4 text-success flex-shrink-0" />
                  <span className="text-sm font-medium text-success truncate max-w-[280px]">
                    {sourcePreview.filename || sourceFile?.name}
                  </span>
                  <CheckCircle2 className="w-4 h-4 text-success" />
                  <span className="text-xs text-success">
                    {sourcePreviewSheetNames.length} sheet{sourcePreviewSheetNames.length === 1 ? '' : 's'}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    setSourceFile(null);
                    setSourcePreview(null);
                    setActiveUploadSheetName('');
                    previewSourceMutation.reset();
                  }}
                >
                  Clear
                </Button>
              </div>

              {sourcePreviewSheetNames.length > 1 && (
                <div className="flex overflow-x-auto border-b border-success/30 bg-surface-1">
                  {sourcePreviewSheetNames.map((sheetName) => (
                    <button
                      key={sheetName}
                      type="button"
                      onClick={() => setActiveUploadSheetName(sheetName)}
                      className={`px-4 py-2 text-xs font-medium whitespace-nowrap border-r border-success/20 transition-colors ${
                        activeUploadSheetName === sheetName
                          ? 'bg-success/10 text-success border-b-2 border-b-green-600'
                          : 'text-text-tertiary hover:bg-surface-2'
                      }`}
                    >
                      {sheetName}
                      <span className="ml-1.5 text-text-quaternary">{sourcePreview.sheets[sheetName].rows.length}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="p-3 space-y-3">
                <div className="flex flex-wrap gap-4 text-xs text-success">
                  <span><strong>{activeUploadSheet.columns.length}</strong> columns</span>
                  <span><strong>{activeUploadSheet.rows.length}</strong> data rows</span>
                  <span>Header row = first row of sheet</span>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {activeUploadSheet.columns.map((column) => (
                    <span key={column.name} className="rounded border border-success/30 bg-surface-1 px-2 py-0.5 text-xs text-text-secondary">
                      {column.name}
                      <span className="ml-1 text-text-quaternary">{column.type}</span>
                    </span>
                  ))}
                </div>

                {activeUploadSheet.rows.length > 0 && (
                  <div className="overflow-x-auto rounded border border-success/30 bg-surface-1">
                    <table className="text-xs w-full">
                      <thead className="bg-surface-2">
                        <tr>
                          {activeUploadSheet.columns.map((column) => (
                            <th key={column.name} className="px-3 py-1.5 text-left font-medium text-text-secondary border-b whitespace-nowrap">
                              {column.name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {activeUploadSheet.rows.slice(0, 5).map((row, rowIndex) => (
                          <tr key={rowIndex} className="border-b last:border-0">
                            {activeUploadSheet.columns.map((column) => (
                              <td key={column.name} className="px-3 py-1.5 text-text-secondary whitespace-nowrap max-w-[180px] truncate">
                                {String(row[column.name] ?? '')}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {activeUploadSheet.rows.length > 5 && (
                      <p className="text-xs text-text-quaternary px-3 py-1.5">
                        ... and {activeUploadSheet.rows.length - 5} more rows
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          {analysis && (
            <>
              <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
                <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-text-primary">{analysis.document_title || analysis.suggested_dashboard_name}</p>
                      <p className="mt-1 text-caption text-text-tertiary">
                        {totalPlanCount} chart block(s) detected from imported HTML
                      </p>
                    </div>
                    <Button variant="secondary" size="xs" onClick={toggleAllPlans}>
                      {selectedPlanCount === totalPlanCount ? 'Unselect all' : 'Select all'}
                    </Button>
                  </div>

                  {!!analysis.warnings.length && (
                    <div className="mt-4 space-y-2">
                      {analysis.warnings.map((warning) => (
                        <div key={warning} className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-caption text-warning">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                          <span>{warning}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {analysis.ai_meta?.message && (
                    <div className="mt-4 rounded-lg border border-brand/20 bg-brand/10 px-3 py-2 text-caption text-brand">
                      <span className="font-semibold">AI mapping:</span> {analysis.ai_meta.message}
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
                  <FieldGroup
                    label={targetMode === 'append_to_dashboard' ? 'Imported Page Name' : 'Dashboard Name'}
                    description={targetMode === 'append_to_dashboard'
                      ? `This will append a new page into ${targetDashboardName ?? 'the current dashboard'}.`
                      : 'The analyzed charts will be built into a new dashboard.'}
                  >
                    <Input
                      value={buildName}
                      onChange={(event) => setBuildName(event.target.value)}
                    />
                  </FieldGroup>
                  <div className="mt-4 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3 text-caption text-text-tertiary">
                    <p>
                      Source: {analysis.source_profile.dataset_name || analysis.source_profile.uploaded_filename || 'Imported source'}
                    </p>
                    <p className="mt-1">
                      Table: {analysis.source_profile.dataset_table_name || 'N/A'}
                    </p>
                    {analysis.source_profile.selected_sheet_name && (
                      <p className="mt-1">
                        Mapping sheet: {analysis.source_profile.selected_sheet_name}
                      </p>
                    )}
                    <p className="mt-1">
                      Columns: {analysis.source_profile.columns.length}
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                {analysis.chart_plans.map((plan) => {
                  const checked = includedBlockIds.includes(plan.block_id);
                  return (
                    <label
                      key={plan.block_id}
                      className={`block rounded-xl border p-4 transition-colors ${checked ? 'border-brand/40 bg-brand/10' : 'border-[rgb(var(--border-line))] bg-surface-1'}`}
                    >
                      <div className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => togglePlan(plan.block_id)}
                          className="mt-1"
                        />
                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-semibold text-text-primary">{plan.title}</p>
                            <ChartTypeBadge value={plan.final_chart_type} />
                            {plan.changed_chart_type && plan.requested_chart_type && (
                              <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning">
                                {plan.requested_chart_type}{' -> '}{plan.final_chart_type}
                              </span>
                            )}
                            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-text-tertiary">
                              {Math.round(plan.confidence * 100)}% confidence
                            </span>
                          </div>

                          {!!plan.source_fields_used.length && (
                            <p className="text-caption text-text-tertiary">
                              Fields: {plan.source_fields_used.join(', ')}
                            </p>
                          )}

                          {plan.rationale && (
                            <p className="text-caption text-text-secondary">{plan.rationale}</p>
                          )}

                          {plan.conversion_note && (
                            <div className="rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-caption text-warning">
                              {plan.conversion_note}
                            </div>
                          )}

                          {!!plan.warnings.length && (
                            <div className="space-y-1">
                              {plan.warnings.map((warning) => (
                                <p key={warning} className="text-caption text-warning">
                                  {warning}
                                </p>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>

              {!!analysis.ignored_blocks.length && (
                <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
                  <p className="text-sm font-semibold text-text-primary">Ignored blocks</p>
                  <div className="mt-3 space-y-2">
                    {analysis.ignored_blocks.slice(0, 8).map((block, index) => (
                      <div key={`${block.block_id ?? index}-${index}`} className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2 text-caption text-text-tertiary">
                        <span className="font-semibold text-text-secondary">{block.block_id ?? `block-${index + 1}`}</span>
                        {' '}
                        {block.reason ?? 'Skipped during chart-first import'}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
      </div>

      {(previewSourceMutation.isPending || analyzeMutation.isPending || buildMutation.isPending) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-overlay/45 backdrop-blur-[1px]">
          <div className="rounded-xl border border-[rgb(var(--border-strong))] bg-surface-1 px-5 py-4 shadow-linear-lg">
            <div className="flex items-center gap-3">
              <Loader2 className="h-4 w-4 animate-spin text-brand" />
              <span className="text-sm text-text-primary">
                {previewSourceMutation.isPending
                  ? 'Parsing uploaded source file...'
                  : analyzeMutation.isPending
                    ? 'Analyzing imported HTML...'
                    : 'Building native dashboard...'}
              </span>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
