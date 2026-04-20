'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Database,
  FileCode2,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  Sparkles,
  Upload,
  Wrench,
  X,
} from 'lucide-react';

import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/Button';
import { FieldGroup, Input, Select, Textarea } from '@/components/ui/Input';
import {
  useAnalyzeDashboardHtmlImport,
  useBuildDashboardHtmlImport,
  useFixDashboardHtmlImportChartPlan,
  usePreviewDashboardHtmlImportSource,
  useValidateDashboardHtmlImportPlans,
} from '@/hooks/use-dashboards';
import { useDatasets, useDatasetTables, useTablePreview } from '@/hooks/use-datasets';
import { summarizeImportedDashboardHtml } from '@/lib/dashboard-html-import';
import { toast } from '@/lib/toast';
import type {
  DashboardHtmlImportAnalyzeResponse,
  DashboardHtmlImportBuildResponse,
  DashboardHtmlImportChartPlan,
  DashboardHtmlImportSourcePreviewResponse,
  DashboardHtmlImportTargetMode,
  DashboardHtmlImportSourceMode,
  DashboardHtmlImportValidationResult,
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
  const [sourceFiles, setSourceFiles] = useState<File[]>([]);
  const [sourcePreviews, setSourcePreviews] = useState<Record<string, DashboardHtmlImportSourcePreviewResponse>>({});
  const [activePreviewFilename, setActivePreviewFilename] = useState('');
  const [activeUploadSheetName, setActiveUploadSheetName] = useState('');
  const [buildName, setBuildName] = useState('');
  const [analysis, setAnalysis] = useState<DashboardHtmlImportAnalyzeResponse | null>(null);
  const [includedBlockIds, setIncludedBlockIds] = useState<string[]>([]);
  const [validationResults, setValidationResults] = useState<Record<string, DashboardHtmlImportValidationResult>>({});
  const [validationRan, setValidationRan] = useState(false);
  const [fixingBlockIds, setFixingBlockIds] = useState<Set<string>>(new Set());
  const [selectedFixBlockIds, setSelectedFixBlockIds] = useState<Set<string>>(new Set());

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
  const validateMutation = useValidateDashboardHtmlImportPlans();
  const fixChartMutation = useFixDashboardHtmlImportChartPlan();

  useEffect(() => {
    if (!isOpen) {
      setStep('configure');
      setHtmlInput('');
      setHtmlFilename('');
      setSourceMode('existing_dataset');
      setSelectedDatasetId(null);
      setSelectedTableId(null);
      setSourceFiles([]);
      setSourcePreviews({});
      setActivePreviewFilename('');
      setActiveUploadSheetName('');
      setBuildName('');
      setAnalysis(null);
      setIncludedBlockIds([]);
      setValidationResults({});
      setValidationRan(false);
      setFixingBlockIds(new Set());
      setSelectedFixBlockIds(new Set());
      analyzeMutation.reset();
      buildMutation.reset();
      previewSourceMutation.reset();
      validateMutation.reset();
      fixChartMutation.reset();
    }
  }, [analyzeMutation, buildMutation, isOpen, previewSourceMutation, validateMutation, fixChartMutation]);

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
  const activePreview = sourcePreviews[activePreviewFilename] ?? null;
  const sourcePreviewFilenames = useMemo(
    () => Object.keys(sourcePreviews),
    [sourcePreviews],
  );
  const sourcePreviewSheetNames = useMemo(
    () => (activePreview ? Object.keys(activePreview.sheets) : []),
    [activePreview],
  );
  const activeUploadSheet = useMemo(() => {
    if (!activePreview) return null;
    return activePreview.sheets[activeUploadSheetName] ?? activePreview.sheets[activePreview.default_sheet_name] ?? null;
  }, [activeUploadSheetName, activePreview]);
  const activeSourceKey = useMemo(() => {
    if (!activePreviewFilename || !activeUploadSheetName) return '';
    return `${activePreviewFilename}::${activeUploadSheetName}`;
  }, [activePreviewFilename, activeUploadSheetName]);

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
    if (!file) return;
    if (sourceFiles.some((f) => f.name === file.name && f.size === file.size)) {
      toast.error(`File "${file.name}" is already added.`);
      return;
    }

    try {
      const preview = await previewSourceMutation.mutateAsync(file);
      setSourceFiles((prev) => [...prev, file]);
      setSourcePreviews((prev) => ({ ...prev, [file.name]: preview }));
      setActivePreviewFilename(file.name);
      setActiveUploadSheetName(preview.default_sheet_name);
      toast.success(`Loaded ${Object.keys(preview.sheets).length} table(s) from ${file.name}`);
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Could not preview the uploaded source file.'));
    }
  };

  const handleRemoveSourceFile = (filename: string) => {
    setSourceFiles((prev) => prev.filter((f) => f.name !== filename));
    setSourcePreviews((prev) => {
      const next = { ...prev };
      delete next[filename];
      return next;
    });
    if (activePreviewFilename === filename) {
      const remaining = sourceFiles.filter((f) => f.name !== filename);
      if (remaining.length > 0) {
        const nextFile = remaining[0].name;
        setActivePreviewFilename(nextFile);
        const nextPreview = sourcePreviews[nextFile];
        setActiveUploadSheetName(nextPreview?.default_sheet_name ?? '');
      } else {
        setActivePreviewFilename('');
        setActiveUploadSheetName('');
      }
    }
  };

  const handleAnalyze = async () => {
    const trimmedHtml = htmlInput.trim();
    if (!trimmedHtml) {
      toast.error('HTML import content is required.');
      return;
    }
    if (sourceMode === 'existing_dataset' && !selectedDatasetId) {
      toast.error('Select a dataset to map the HTML into native charts.');
      return;
    }
    if (sourceMode === 'upload_excel' && sourceFiles.length === 0) {
      toast.error('Upload at least one Excel or CSV source file for this import.');
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
    const htmlSummary = summarizeImportedDashboardHtml(trimmedHtml);
    try {
      const result = await analyzeMutation.mutateAsync({
        htmlContent: trimmedHtml,
        htmlSummary,
        sourceMode,
        datasetId: sourceMode === 'existing_dataset' ? selectedDatasetId : null,
        selectedSheetName: sourceMode === 'upload_excel' && sourceFiles.length === 1 ? activeUploadSheetName : null,
        selectedSourceKey: sourceMode === 'upload_excel' && sourceFiles.length > 1 ? activeSourceKey : null,
        excelFile: sourceMode === 'upload_excel' && sourceFiles.length === 1 ? sourceFiles[0] : null,
        excelFiles: sourceMode === 'upload_excel' && sourceFiles.length > 1 ? sourceFiles : undefined,
      });
      setAnalysis(result);
      setIncludedBlockIds(result.chart_plans.map((plan) => plan.block_id));
      setBuildName((current) => current.trim() || result.suggested_dashboard_name);
      setValidationResults({});
      setValidationRan(false);
      setSelectedFixBlockIds(new Set());
      setStep('preview');

      // Auto-validate when a dataset_id is available
      if (sourceMode === 'existing_dataset' && selectedDatasetId) {
        try {
          const valResp = await validateMutation.mutateAsync({
            analysis: result,
            datasetId: selectedDatasetId,
          });
          const map: Record<string, DashboardHtmlImportValidationResult> = {};
          for (const r of valResp.results) map[r.block_id] = r;
          setValidationResults(map);
          setValidationRan(true);
          const errorCount = valResp.results.filter((r) => r.status === 'error').length;
          if (errorCount > 0) {
            toast.warning(`${errorCount} chart(s) have query issues. You can use AI to fix them.`);
            // Auto-select error charts for easy batch fix
            const errorBlockIds = valResp.results.filter((r) => r.status === 'error').map((r) => r.block_id);
            setSelectedFixBlockIds(new Set(errorBlockIds));
          }
        } catch {
          // non-blocking — user can still build without validation
        }
      }
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Could not analyze imported HTML.'));
    }
  };

  const handleValidate = async () => {
    if (!analysis || !selectedDatasetId) return;
    try {
      const valResp = await validateMutation.mutateAsync({
        analysis,
        datasetId: selectedDatasetId,
      });
      const map: Record<string, DashboardHtmlImportValidationResult> = {};
      for (const r of valResp.results) map[r.block_id] = r;
      setValidationResults(map);
      setValidationRan(true);
      const errorCount = valResp.results.filter((r) => r.status === 'error').length;
      if (errorCount === 0) {
        toast.success('All chart queries validated successfully.');
      } else {
        toast.warning(`${errorCount} chart(s) have query issues.`);
      }
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Validation failed.'));
    }
  };

  const handleFixChart = async (plan: DashboardHtmlImportChartPlan) => {
    if (!analysis) return;
    const validation = validationResults[plan.block_id];
    if (!validation || validation.status !== 'error') return;
    await handleBatchFix(new Set([plan.block_id]));
  };

  const handleBatchFix = async (blockIds?: Set<string>) => {
    if (!analysis) return;
    const idsToFix = blockIds ?? selectedFixBlockIds;
    if (idsToFix.size === 0) return;

    // Track the latest analysis locally to avoid stale React state
    let currentAnalysis = analysis;
    const plansToFix = currentAnalysis.chart_plans.filter(
      (p) => idsToFix.has(p.block_id) && validationResults[p.block_id]?.status === 'error',
    );
    if (plansToFix.length === 0) return;

    for (const plan of plansToFix) {
      setFixingBlockIds((prev) => new Set(prev).add(plan.block_id));
      try {
        const validation = validationResults[plan.block_id];
        const resp = await fixChartMutation.mutateAsync({
          chartPlan: plan,
          errorMessage: validation?.error || 'Unknown error',
          sourceProfile: currentAnalysis.source_profile,
          allSourceProfiles: currentAnalysis.all_source_profiles,
          datasetId: selectedDatasetId,
          calculatedFields: currentAnalysis.calculated_fields,
        });
        const fixedPlan = resp.fixed_plan;
        // Update LOCAL tracking so next iterations and re-validation use the latest
        currentAnalysis = {
          ...currentAnalysis,
          chart_plans: currentAnalysis.chart_plans.map((p) =>
            p.block_id === fixedPlan.block_id ? { ...p, ...fixedPlan } : p,
          ),
        };
        setAnalysis(currentAnalysis);
        // If the backend validated the fix, mark it as OK immediately
        if ((fixedPlan as any).fix_validated) {
          setValidationResults((prev) => ({
            ...prev,
            [fixedPlan.block_id]: { block_id: fixedPlan.block_id, status: 'ok', error: null },
          }));
        } else {
          setValidationResults((prev) => {
            const next = { ...prev };
            delete next[fixedPlan.block_id];
            return next;
          });
        }
        toast.success(`Fixed: ${fixedPlan.fix_note || plan.title}`);
      } catch (error) {
        toast.error(getApiErrorMessage(error, `AI could not fix "${plan.title}".`));
      } finally {
        setFixingBlockIds((prev) => {
          const next = new Set(prev);
          next.delete(plan.block_id);
          return next;
        });
      }
    }

    setSelectedFixBlockIds(new Set());

    // Re-validate with the UPDATED analysis (not the stale closure `analysis`)
    if (selectedDatasetId) {
      try {
        const valResp = await validateMutation.mutateAsync({
          analysis: currentAnalysis,
          datasetId: selectedDatasetId,
        });
        const map: Record<string, DashboardHtmlImportValidationResult> = {};
        for (const r of valResp.results) map[r.block_id] = r;
        setValidationResults(map);
        setValidationRan(true);
        const errorCount = valResp.results.filter((r) => r.status === 'error').length;
        if (errorCount === 0) {
          toast.success('All chart queries validated successfully after fix.');
        } else {
          toast.warning(`${errorCount} chart(s) still have query issues.`);
        }
      } catch (error) {
        toast.error(getApiErrorMessage(error, 'Re-validation failed.'));
      }
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
        datasetId: sourceMode === 'existing_dataset' ? selectedDatasetId : null,
        selectedSheetName: sourceMode === 'upload_excel' && sourceFiles.length === 1 ? activeUploadSheetName : null,
        includedBlockIds,
        excelFile: sourceMode === 'upload_excel' && sourceFiles.length === 1 ? sourceFiles[0] : null,
        excelFiles: sourceMode === 'upload_excel' && sourceFiles.length > 1 ? sourceFiles : undefined,
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
            <Button variant="ghost" size="sm" onClick={() => { setStep('configure'); setAnalysis(null); setValidationResults({}); setValidationRan(false); setSelectedFixBlockIds(new Set()); }} disabled={buildMutation.isPending}>
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
                  {selectedDatasetId && tables.length > 0 && (
                    <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
                      <p className="text-caption font-semibold text-text-primary">
                        {tables.filter((t) => t.source_kind !== 'generated_calendar').length} data table(s)
                      </p>
                      <p className="mt-1 text-caption text-text-tertiary">
                        {tables
                          .filter((t) => t.source_kind !== 'generated_calendar')
                          .map((t) => t.display_name)
                          .join(', ')}
                      </p>
                      <p className="mt-1 text-caption text-text-tertiary">
                        Each chart will be automatically matched to the best-fitting table.
                      </p>
                    </div>
                  )}
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
                    Add Excel / CSV File
                  </Button>
                  {sourceFiles.length > 0 && (
                    <div className="space-y-1.5">
                      {sourceFiles.map((file) => (
                        <div key={file.name} className="flex items-center gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-1.5 text-caption text-success">
                          <FileSpreadsheet className="h-3.5 w-3.5 flex-shrink-0" />
                          <span className="flex-1 truncate">{file.name}</span>
                          <span className="text-success/70">
                            {sourcePreviews[file.name] ? `${Object.keys(sourcePreviews[file.name].sheets).length} sheet(s)` : ''}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleRemoveSourceFile(file.name)}
                            className="rounded p-0.5 text-success/60 hover:bg-success/20 hover:text-success"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <input
                    ref={sourceFileInputRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      const files = event.target.files;
                      if (files) {
                        Array.from(files).forEach((file) => void handleSourceFileChange(file));
                      }
                      event.currentTarget.value = '';
                    }}
                  />
                  <p className="text-caption text-text-tertiary">
                    Upload one or more Excel/CSV files. Every sheet becomes a table during build. Charts are automatically matched to the best source.
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

              {sourceMode === 'existing_dataset' && selectedDataset && (
                <div className="mt-4 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
                  <p className="text-caption font-semibold text-text-primary">
                    {selectedDataset.name}
                  </p>
                  <p className="mt-1 text-caption text-text-tertiary">
                    {tables.filter((t) => t.source_kind !== 'generated_calendar').length} data table(s) — all tables used for chart mapping.
                  </p>
                </div>
              )}

              {sourceMode === 'upload_excel' && (
                <div className="mt-4 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
                  <p className="text-caption font-semibold text-text-primary">Multi-file source upload</p>
                  <p className="mt-1 text-caption text-text-tertiary">
                    Upload one or more Excel/CSV files. All sheets from all files become tables in the dataset. Each chart is automatically matched to the best-fitting source.
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

          {sourceMode === 'upload_excel' && Object.keys(sourcePreviews).length > 0 && activeUploadSheet && (
            <div className="rounded-xl border border-success/30 bg-success/10 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2 border-b border-success/30">
                <div className="flex items-center gap-2">
                  <FileSpreadsheet className="w-4 h-4 text-success flex-shrink-0" />
                  <span className="text-sm font-medium text-success">
                    {sourceFiles.length} file{sourceFiles.length === 1 ? '' : 's'} uploaded
                  </span>
                  <CheckCircle2 className="w-4 h-4 text-success" />
                  <span className="text-xs text-success">
                    {Object.values(sourcePreviews).reduce((sum, p) => sum + Object.keys(p.sheets).length, 0)} total sheet{Object.values(sourcePreviews).reduce((sum, p) => sum + Object.keys(p.sheets).length, 0) === 1 ? '' : 's'}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    setSourceFiles([]);
                    setSourcePreviews({});
                    setActivePreviewFilename('');
                    setActiveUploadSheetName('');
                    previewSourceMutation.reset();
                  }}
                >
                  Clear All
                </Button>
              </div>

              {sourcePreviewFilenames.length > 1 && (
                <div className="flex overflow-x-auto border-b border-success/30 bg-surface-2">
                  {sourcePreviewFilenames.map((filename) => (
                    <button
                      key={filename}
                      type="button"
                      onClick={() => {
                        setActivePreviewFilename(filename);
                        const preview = sourcePreviews[filename];
                        if (preview) setActiveUploadSheetName(preview.default_sheet_name);
                      }}
                      className={`px-4 py-2 text-xs font-medium whitespace-nowrap border-r border-success/20 transition-colors ${
                        activePreviewFilename === filename
                          ? 'bg-brand/10 text-brand border-b-2 border-b-brand'
                          : 'text-text-tertiary hover:bg-surface-2'
                      }`}
                    >
                      {filename}
                      <span className="ml-1.5 text-text-quaternary">{Object.keys(sourcePreviews[filename]?.sheets ?? {}).length} sheets</span>
                    </button>
                  ))}
                </div>
              )}

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
                      <span className="ml-1.5 text-text-quaternary">{activePreview?.sheets[sheetName]?.rows.length ?? 0}</span>
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
                      {sourceFiles.length > 1 && ` (+${sourceFiles.length - 1} more file${sourceFiles.length > 2 ? 's' : ''})`}
                    </p>
                    <p className="mt-1">
                      Table: {analysis.source_profile.dataset_table_name || 'N/A'}
                    </p>
                    {analysis.source_profile.selected_sheet_name && (
                      <p className="mt-1">
                        Primary sheet: {analysis.source_profile.selected_sheet_name}
                      </p>
                    )}
                    <p className="mt-1">
                      Columns: {analysis.source_profile.columns.length}
                    </p>
                  </div>
                </div>
              </div>

              {!!(analysis.calculated_fields?.length) && (
                <div className="rounded-xl border border-brand/20 bg-brand/5 p-4">
                  <p className="text-sm font-semibold text-text-primary">
                    Calculated Fields ({analysis.calculated_fields.length})
                  </p>
                  <p className="text-caption text-text-secondary mt-1">
                    AI-suggested computed columns that will be added to the data model.
                  </p>
                  <div className="mt-3 space-y-2">
                    {analysis.calculated_fields.map((cf) => (
                      <div key={cf.name} className="rounded-lg border border-brand/20 bg-surface-1 px-3 py-2">
                        <p className="text-sm font-semibold text-text-primary">{cf.label || cf.name}</p>
                        <p className="text-caption text-text-tertiary font-mono mt-1">{cf.name} = {cf.expression}</p>
                        {cf.source_key && (
                          <p className="text-caption text-brand/80 mt-1">Source: {cf.source_key}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-3">
                {/* Validation summary bar */}
                {validationRan && (
                  <div className={`flex items-center justify-between rounded-xl border p-3 ${
                    Object.values(validationResults).some((r) => r.status === 'error')
                      ? 'border-danger/30 bg-danger/10'
                      : 'border-success/30 bg-success/10'
                  }`}>
                    <div className="flex items-center gap-2 text-sm">
                      {Object.values(validationResults).some((r) => r.status === 'error') ? (
                        <>
                          <AlertCircle className="h-4 w-4 text-danger" />
                          <span className="text-danger font-medium">
                            {Object.values(validationResults).filter((r) => r.status === 'error').length} chart(s) failed query validation
                          </span>
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="h-4 w-4 text-success" />
                          <span className="text-success font-medium">All chart queries validated successfully</span>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {Object.values(validationResults).some((r) => r.status === 'error') && (
                        <Button
                          variant="secondary"
                          size="xs"
                          leadingIcon={fixingBlockIds.size > 0 ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />}
                          onClick={() => {
                            if (selectedFixBlockIds.size > 0) {
                              handleBatchFix();
                            } else {
                              const errorIds = Object.entries(validationResults)
                                .filter(([, r]) => r.status === 'error')
                                .map(([id]) => id);
                              handleBatchFix(new Set(errorIds));
                            }
                          }}
                          disabled={fixingBlockIds.size > 0}
                        >
                          {fixingBlockIds.size > 0
                            ? `Fixing ${fixingBlockIds.size}...`
                            : selectedFixBlockIds.size > 0
                              ? `Fix Selected (${selectedFixBlockIds.size})`
                              : `Fix All Errors`}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="xs"
                        leadingIcon={<RefreshCw className="h-3 w-3" />}
                        onClick={handleValidate}
                        loading={validateMutation.isPending}
                      >
                        Re-validate
                      </Button>
                    </div>
                  </div>
                )}
                {!validationRan && sourceMode === 'existing_dataset' && selectedDatasetId && (
                  <div className="flex items-center justify-between rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 p-3">
                    <p className="text-caption text-text-tertiary">
                      Run validation to test each chart query against the data source before building.
                    </p>
                    <Button
                      variant="secondary"
                      size="xs"
                      leadingIcon={<CheckCircle2 className="h-3 w-3" />}
                      onClick={handleValidate}
                      loading={validateMutation.isPending}
                    >
                      Validate All
                    </Button>
                  </div>
                )}

                {analysis.chart_plans.map((plan) => {
                  const checked = includedBlockIds.includes(plan.block_id);
                  const validation = validationResults[plan.block_id];
                  const isFixing = fixingBlockIds.has(plan.block_id);
                  const hasError = validation?.status === 'error';
                  return (
                    <label
                      key={plan.block_id}
                      className={`block rounded-xl border p-4 transition-colors ${
                        validation?.status === 'error'
                          ? 'border-danger/40 bg-danger/5'
                          : checked
                            ? 'border-brand/40 bg-brand/10'
                            : 'border-[rgb(var(--border-line))] bg-surface-1'
                      }`}
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
                            {/* Validation status badge */}
                            {validation && (
                              validation.status === 'ok' ? (
                                <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
                                  <CheckCircle2 className="h-3 w-3" /> OK
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-semibold text-danger">
                                  <AlertCircle className="h-3 w-3" /> Error
                                </span>
                              )
                            )}
                            {validateMutation.isPending && !validation && (
                              <Loader2 className="h-3 w-3 animate-spin text-text-tertiary" />
                            )}
                          </div>

                          {!!plan.source_fields_used.length && (
                            <p className="text-caption text-text-tertiary">
                              Fields: {plan.source_fields_used.join(', ')}
                            </p>
                          )}

                          {plan.source_key && (sourceFiles.length > 1 || sourceMode === 'existing_dataset') && (
                            <p className="text-caption text-brand/80">
                              <FileSpreadsheet className="inline h-3 w-3 mr-1 -mt-0.5" />
                              Source: {plan.source_key}
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

                          {/* Validation error + AI fix */}
                          {validation?.status === 'error' && validation.error && (
                            <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2">
                              <p className="text-caption text-danger font-mono break-all">{validation.error}</p>
                              <div className="mt-2 flex items-center gap-2">
                                <label className="flex items-center gap-1.5 text-caption text-text-secondary cursor-pointer" onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    checked={selectedFixBlockIds.has(plan.block_id)}
                                    onChange={(e) => {
                                      e.stopPropagation();
                                      setSelectedFixBlockIds((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(plan.block_id)) next.delete(plan.block_id);
                                        else next.add(plan.block_id);
                                        return next;
                                      });
                                    }}
                                  />
                                  Select for batch fix
                                </label>
                                <Button
                                  variant="secondary"
                                  size="xs"
                                  leadingIcon={isFixing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wrench className="h-3 w-3" />}
                                  onClick={(e) => { e.preventDefault(); handleFixChart(plan); }}
                                  disabled={isFixing || fixingBlockIds.size > 0}
                                >
                                  {isFixing ? 'Fixing...' : 'AI Fix'}
                                </Button>
                              </div>
                            </div>
                          )}

                          {/* Show fix note if AI fixed this plan */}
                          {(plan as any).fix_note && (
                            <div className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-caption text-success">
                              <Wrench className="inline h-3 w-3 mr-1 -mt-0.5" />
                              AI fix: {(plan as any).fix_note}
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

      {(previewSourceMutation.isPending || analyzeMutation.isPending || buildMutation.isPending || validateMutation.isPending) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-overlay/45 backdrop-blur-[1px]">
          <div className="rounded-xl border border-[rgb(var(--border-strong))] bg-surface-1 px-5 py-4 shadow-linear-lg">
            <div className="flex items-center gap-3">
              <Loader2 className="h-4 w-4 animate-spin text-brand" />
              <span className="text-sm text-text-primary">
                {previewSourceMutation.isPending
                  ? 'Parsing uploaded source file...'
                  : analyzeMutation.isPending
                    ? 'Analyzing imported HTML...'
                    : validateMutation.isPending
                      ? 'Validating chart queries...'
                      : 'Building native dashboard...'}
              </span>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
