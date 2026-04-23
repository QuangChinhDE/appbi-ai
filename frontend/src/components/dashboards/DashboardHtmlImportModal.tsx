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
  Pencil,
  RefreshCw,
  Sparkles,
  Upload,
  Wand2,
  Wrench,
  X,
} from 'lucide-react';

import { Modal } from '@/components/common/Modal';
import {
  HtmlImportChartEditor,
  type HtmlImportChartEditResult,
} from '@/components/dashboards/HtmlImportChartEditor';
import { HtmlImportUploadChartEditor } from '@/components/dashboards/HtmlImportUploadChartEditor';
import { CalculatedFieldsPanel } from '@/components/dashboards/CalculatedFieldsPanel';
import { Button } from '@/components/ui/Button';
import { FieldGroup, Input, Select, Textarea } from '@/components/ui/Input';
import {
  useAnalyzeDashboardHtmlImport,
  useAnalyzeDashboardHtmlImportBatch,
  useBuildDashboardHtmlImport,
  useBuildDashboardHtmlImportBatch,
  useCancelDashboardHtmlImportDraft,
  useFixDashboardHtmlImportChartPlan,
  usePrepareDashboardHtmlImportDraft,
  usePreviewDashboardHtmlImportSource,
  useValidateDashboardHtmlImportPlans,
} from '@/hooks/use-dashboards';
import { useDatasets, useDatasetTables, useTablePreview } from '@/hooks/use-datasets';
import { detectEmbeddedMultiPageImportHtml, summarizeImportedDashboardHtml } from '@/lib/dashboard-html-import';
import { toast } from '@/lib/toast';
import type {
  DashboardHtmlImportAnalyzeResponse,
  DashboardHtmlImportBatchAnalyzeResponse,
  DashboardHtmlImportBatchBuildResponse,
  DashboardHtmlImportBuildResponse,
  DashboardHtmlImportCalculatedField,
  DashboardHtmlImportChartPlan,
  DashboardHtmlImportSourcePreviewResponse,
  DashboardHtmlImportTargetMode,
  DashboardHtmlImportSourceMode,
  DashboardHtmlImportValidationResult,
} from '@/types/dashboard-html-import';

type DashboardHtmlImportBuiltResult = DashboardHtmlImportBuildResponse | DashboardHtmlImportBatchBuildResponse;

type HtmlImportBatchDocumentInput = {
  documentId: string;
  filename: string;
  pageName: string;
  htmlContent: string;
};

interface DashboardHtmlImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  targetMode: DashboardHtmlImportTargetMode;
  targetDashboardId?: number;
  targetDashboardName?: string;
  onBuilt?: (result: DashboardHtmlImportBuiltResult) => void;
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

function stripHtmlExtension(filename: string): string {
  return filename.replace(/\.(html?|xhtml)$/i, '').trim();
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
  const pendingFocusRevalidationRef = useRef(false);

  const [step, setStep] = useState<'configure' | 'preview'>('configure');
  const [htmlInput, setHtmlInput] = useState('');
  const [htmlFilename, setHtmlFilename] = useState('');
  const [htmlDocuments, setHtmlDocuments] = useState<HtmlImportBatchDocumentInput[]>([]);
  const [sourceMode, setSourceMode] = useState<DashboardHtmlImportSourceMode>('existing_dataset');
  const [selectedDatasetId, setSelectedDatasetId] = useState<number | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null);
  const [sourceFiles, setSourceFiles] = useState<File[]>([]);
  const [sourcePreviews, setSourcePreviews] = useState<Record<string, DashboardHtmlImportSourcePreviewResponse>>({});
  const [activePreviewFilename, setActivePreviewFilename] = useState('');
  const [activeUploadSheetName, setActiveUploadSheetName] = useState('');
  const [buildName, setBuildName] = useState('');
  const [analysis, setAnalysis] = useState<DashboardHtmlImportAnalyzeResponse | null>(null);
  const [batchAnalysis, setBatchAnalysis] = useState<DashboardHtmlImportBatchAnalyzeResponse | null>(null);
  const [activeBatchDocumentId, setActiveBatchDocumentId] = useState('');
  const [includedBlockIds, setIncludedBlockIds] = useState<string[]>([]);
  const [validationResults, setValidationResults] = useState<Record<string, DashboardHtmlImportValidationResult>>({});
  const [validationRan, setValidationRan] = useState(false);
  const [fixingBlockIds, setFixingBlockIds] = useState<Set<string>>(new Set());
  const [selectedFixBlockIds, setSelectedFixBlockIds] = useState<Set<string>>(new Set());
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [calculatedFieldsErrors, setCalculatedFieldsErrors] = useState<Record<string, string>>({});

  /** Draft state: once the user clicks "Transform table", we materialize the
   * wizard source into a real Dataset (for upload_excel) or resolve the
   * selected dataset (existing_dataset). The user then edits transformations
   * on a real dataset page and returns. If they cancel the wizard, we delete
   * the draft so it never pollutes their dataset list. */
  const [draftDatasetId, setDraftDatasetId] = useState<number | null>(null);
  const [draftIsOwned, setDraftIsOwned] = useState(false);
  const [draftTableIdMap, setDraftTableIdMap] = useState<Record<string, number>>({});
  const [preparingDraft, setPreparingDraft] = useState(false);
  /** Surfaces dataset-level failures (draft prepare crash, whole-batch
   * validation failure) so the Build button can block with a clear reason —
   * not just per-chart query errors. */
  const [datasetPrepError, setDatasetPrepError] = useState<string | null>(null);
  const [validationFailed, setValidationFailed] = useState(false);

  const effectiveDatasetId = draftDatasetId ?? selectedDatasetId;

  const { data: datasets = [] } = useDatasets(0, 200);
  const { data: tables = [] } = useDatasetTables(effectiveDatasetId);
  const tablePreviewQuery = useTablePreview(
    effectiveDatasetId,
    selectedTableId,
    { limit: 5 },
    { enabled: isOpen && effectiveDatasetId !== null && selectedTableId !== null },
  );
  const analyzeMutation = useAnalyzeDashboardHtmlImport();
  const analyzeBatchMutation = useAnalyzeDashboardHtmlImportBatch();
  const buildMutation = useBuildDashboardHtmlImport();
  const buildBatchMutation = useBuildDashboardHtmlImportBatch();
  const previewSourceMutation = usePreviewDashboardHtmlImportSource();
  const validateMutation = useValidateDashboardHtmlImportPlans();
  const fixChartMutation = useFixDashboardHtmlImportChartPlan();
  const prepareDraftMutation = usePrepareDashboardHtmlImportDraft();
  const cancelDraftMutation = useCancelDashboardHtmlImportDraft();

  useEffect(() => {
    if (!isOpen) {
      setStep('configure');
      setHtmlInput('');
      setHtmlFilename('');
      setHtmlDocuments([]);
      setSourceMode('existing_dataset');
      setSelectedDatasetId(null);
      setSelectedTableId(null);
      setSourceFiles([]);
      setSourcePreviews({});
      setActivePreviewFilename('');
      setActiveUploadSheetName('');
      setBuildName('');
      setAnalysis(null);
      setBatchAnalysis(null);
      setActiveBatchDocumentId('');
      setIncludedBlockIds([]);
      setValidationResults({});
      setValidationRan(false);
      setFixingBlockIds(new Set());
      setSelectedFixBlockIds(new Set());
      setEditingBlockId(null);
      setCalculatedFieldsErrors({});
      setDraftDatasetId(null);
      setDraftIsOwned(false);
      setDraftTableIdMap({});
      setPreparingDraft(false);
      setDatasetPrepError(null);
      setValidationFailed(false);
      pendingFocusRevalidationRef.current = false;
      analyzeMutation.reset();
      analyzeBatchMutation.reset();
      buildMutation.reset();
      buildBatchMutation.reset();
      previewSourceMutation.reset();
      validateMutation.reset();
      fixChartMutation.reset();
    }
  }, [analyzeBatchMutation, analyzeMutation, buildBatchMutation, buildMutation, isOpen, previewSourceMutation, validateMutation, fixChartMutation]);

  useEffect(() => {
    if (!effectiveDatasetId) {
      setSelectedTableId(null);
    }
  }, [effectiveDatasetId]);

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
  const isBatchInputMode = htmlDocuments.length > 1;
  const activeBatchDocument = useMemo(
    () => batchAnalysis?.documents.find((document) => document.document_id === activeBatchDocumentId)
      ?? batchAnalysis?.documents[0]
      ?? null,
    [activeBatchDocumentId, batchAnalysis],
  );
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

  const handleHtmlFilesChange = async (files: File[]) => {
    if (files.length === 0) return;
    try {
      if (files.length === 1) {
        const [file] = files;
        const text = await file.text();
        setHtmlInput(text);
        setHtmlFilename(file.name);
        setHtmlDocuments([]);
        setBatchAnalysis(null);
        setActiveBatchDocumentId('');
        toast.success(`Loaded HTML from ${file.name}`);
        return;
      }

      const loadedDocuments = await Promise.all(files.map(async (file, index) => ({
        documentId: `html-${Date.now()}-${index + 1}`,
        filename: file.name,
        pageName: stripHtmlExtension(file.name) || `Imported Page ${index + 1}`,
        htmlContent: await file.text(),
      })));
      setHtmlDocuments(loadedDocuments);
      setHtmlInput('');
      setHtmlFilename(`${loadedDocuments.length} HTML files`);
      setBatchAnalysis(null);
      setActiveBatchDocumentId('');
      toast.success(`Loaded ${loadedDocuments.length} HTML files for batch import.`);
    } catch {
      toast.error('Could not read one or more HTML files.');
    }
  };

  const handleRemoveHtmlDocument = (documentId: string) => {
    setHtmlDocuments((current) => {
      const next = current.filter((document) => document.documentId !== documentId);
      if (next.length === 1) {
        setHtmlInput(next[0].htmlContent);
        setHtmlFilename(next[0].filename);
        setBatchAnalysis(null);
        setActiveBatchDocumentId('');
        return [];
      }
      if (next.length === 0) {
        setHtmlInput('');
        setHtmlFilename('');
        setBatchAnalysis(null);
        setActiveBatchDocumentId('');
      }
      return next;
    });
  };

  const handleUpdateBatchPageName = (documentId: string, pageName: string) => {
    setBatchAnalysis((current) => {
      if (!current) return current;
      return {
        ...current,
        documents: current.documents.map((document) => (
          document.document_id === documentId
            ? { ...document, page_name: pageName }
            : document
        )),
      };
    });
  };

  /** If we already prepared a draft for the previous source-file set, drop it
   * now — the new file list can no longer map to the draft's tables. The
   * user will re-Analyze, which re-runs ensureDraft() with the new files. */
  const invalidateDraftIfOwned = async () => {
    if (draftDatasetId != null && draftIsOwned) {
      try {
        await cancelDraftMutation.mutateAsync(draftDatasetId);
      } catch {
        // Non-blocking.
      }
    }
    setDraftDatasetId(null);
    setDraftIsOwned(false);
    setDraftTableIdMap({});
  };

  const handleSourceFileChange = async (file: File | null) => {
    if (!file) return;
    if (sourceFiles.some((f) => f.name === file.name && f.size === file.size)) {
      toast.error(`File "${file.name}" is already added.`);
      return;
    }

    try {
      const preview = await previewSourceMutation.mutateAsync(file);
      await invalidateDraftIfOwned();
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
    // Removing a file changes the draft's table layout, so invalidate.
    void invalidateDraftIfOwned();
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
    if (sourceMode === 'existing_dataset' && !selectedDatasetId) {
      toast.error('Select a dataset to map the HTML into native charts.');
      return;
    }
    if (sourceMode === 'upload_excel' && sourceFiles.length === 0) {
      toast.error('Upload at least one Excel or CSV source file for this import.');
      return;
    }

    const trimmedHtml = htmlInput.trim();
    const embeddedMultiPage = !isBatchInputMode && trimmedHtml
      ? detectEmbeddedMultiPageImportHtml(trimmedHtml)
      : { isMultiPage: false, pageCount: 0, pageNames: [] };
    const shouldUseBatchAnalyze = isBatchInputMode || embeddedMultiPage.isMultiPage;

    if (shouldUseBatchAnalyze) {
      if (!isBatchInputMode && !trimmedHtml) {
        toast.error('HTML import content is required.');
        return;
      }

      const batchDocuments = isBatchInputMode
        ? htmlDocuments.map((document) => ({
          documentId: document.documentId,
          filename: document.filename,
          pageName: document.pageName,
          htmlContent: document.htmlContent,
          htmlSummary: summarizeImportedDashboardHtml(document.htmlContent),
        }))
        : [{
          documentId: 'html-1',
          filename: htmlFilename || null,
          pageName: embeddedMultiPage.pageNames[0] || stripHtmlExtension(htmlFilename) || 'Imported Page 1',
          htmlContent: trimmedHtml,
          htmlSummary: summarizeImportedDashboardHtml(trimmedHtml),
        }];

      try {
        const result = await analyzeBatchMutation.mutateAsync({
          documents: batchDocuments,
          sourceMode,
          datasetId: sourceMode === 'existing_dataset' ? selectedDatasetId : null,
          selectedSheetName: sourceMode === 'upload_excel' && sourceFiles.length === 1 ? activeUploadSheetName : null,
          selectedSourceKey: sourceMode === 'upload_excel' && sourceFiles.length > 1 ? activeSourceKey : null,
          excelFile: sourceMode === 'upload_excel' && sourceFiles.length === 1 ? sourceFiles[0] : null,
          excelFiles: sourceMode === 'upload_excel' && sourceFiles.length > 1 ? sourceFiles : undefined,
        });
        const resolvedBuildName = buildName.trim() || result.suggested_dashboard_name;
        setBatchAnalysis(result);
        setActiveBatchDocumentId(result.documents[0]?.document_id ?? '');
        setBuildName(resolvedBuildName);
        setAnalysis(null);
        setValidationResults({});
        setValidationRan(false);
        setSelectedFixBlockIds(new Set());
        setStep('preview');
      } catch (error) {
        toast.error(getApiErrorMessage(error, 'Could not analyze imported HTML files.'));
      }
      return;
    }

    if (!trimmedHtml) {
      toast.error('HTML import content is required.');
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
      const resolvedBuildName = buildName.trim() || result.suggested_dashboard_name;
      setAnalysis(result);
      setIncludedBlockIds(result.chart_plans.map((plan) => plan.block_id));
      setBuildName(resolvedBuildName);
      setValidationResults({});
      setValidationRan(false);
      setSelectedFixBlockIds(new Set());
      setStep('preview');

      let validationDatasetId: number | null = sourceMode === 'existing_dataset' ? selectedDatasetId : null;
      if (sourceMode === 'upload_excel') {
        const draft = await ensureDraft({
          dashboardName: resolvedBuildName,
          silent: true,
        });
        if (draft) validationDatasetId = draft.datasetId;
      }

      // Auto-validate when a dataset context is available.
      if (validationDatasetId) {
        try {
          const valResp = await validateMutation.mutateAsync({
            analysis: result,
            datasetId: validationDatasetId,
          });
          const map: Record<string, DashboardHtmlImportValidationResult> = {};
          for (const r of valResp.results) map[r.block_id] = r;
          setValidationResults(map);
          setValidationRan(true);
          setValidationFailed(false);
          const errorCount = valResp.results.filter((r) => r.status === 'error').length;
          if (errorCount > 0) {
            toast.warning(`${errorCount} chart(s) have query issues. You can use AI to fix them.`);
            // Auto-select error charts for easy batch fix
            const errorBlockIds = valResp.results.filter((r) => r.status === 'error').map((r) => r.block_id);
            setSelectedFixBlockIds(new Set(errorBlockIds));
          }
        } catch {
          // Batch validation itself failed (dataset unreachable, 500, …).
          // Flag it so the Build button blocks with a dataset-level reason.
          setValidationFailed(true);
        }
      }
    } catch (error) {
      toast.error(getApiErrorMessage(error, 'Could not analyze imported HTML.'));
    }
  };

  const handleValidate = async () => {
    if (!analysis || !effectiveDatasetId) return;
    try {
      const valResp = await validateMutation.mutateAsync({
        analysis,
        datasetId: effectiveDatasetId,
      });
      const map: Record<string, DashboardHtmlImportValidationResult> = {};
      for (const r of valResp.results) map[r.block_id] = r;
      setValidationResults(map);
      setValidationRan(true);
      setValidationFailed(false);
      const errorCount = valResp.results.filter((r) => r.status === 'error').length;
      if (errorCount === 0) {
        toast.success('All chart queries validated successfully.');
      } else {
        toast.warning(`${errorCount} chart(s) have query issues.`);
      }
    } catch (error) {
      setValidationFailed(true);
      toast.error(getApiErrorMessage(error, 'Validation failed.'));
    }
  };

  const handleFixChart = async (plan: DashboardHtmlImportChartPlan) => {
    if (!analysis) return;
    const validation = validationResults[plan.block_id];
    if (!validation || validation.status !== 'error') return;
    await handleBatchFix(new Set([plan.block_id]));
  };

  /**
   * Merge a manual chart edit back into the analysis, mark the plan as edited,
   * and kick off a silent re-validation so the user can continue straight to
   * build if the edited query is now sound.
   */
  const handleApplyManualEdit = async (edit: HtmlImportChartEditResult) => {
    if (!analysis) return;
    const mergedPlan = (current: DashboardHtmlImportChartPlan): DashboardHtmlImportChartPlan => ({
      ...current,
      final_chart_type: edit.final_chart_type,
      role_config: edit.role_config,
      custom_role_config: edit.custom_role_config,
      query_mode: edit.query_mode,
      custom_sql: edit.custom_sql,
      base_filters: edit.base_filters,
      style_config: edit.style_config,
      chart_name: edit.chart_name,
      chart_description: edit.chart_description,
      source_key: edit.source_key ?? current.source_key,
      dataset_table_id_override: edit.dataset_table_id_override,
      manually_edited: true,
      // Clear any stale AI-fix note now that the user hand-edited the plan
      fix_note: null,
      fix_validated: false,
    } as DashboardHtmlImportChartPlan);

    const nextAnalysis: DashboardHtmlImportAnalyzeResponse = {
      ...analysis,
      chart_plans: analysis.chart_plans.map((p) => (p.block_id === edit.block_id ? mergedPlan(p) : p)),
    };
    setAnalysis(nextAnalysis);
    // Drop any previous validation verdict for this plan so the UI no longer
    // shows the old error before the re-validation round-trips.
    setValidationResults((prev) => {
      const next = { ...prev };
      delete next[edit.block_id];
      return next;
    });
    setEditingBlockId(null);
    toast.success('Chart updated');

    // Re-validate if we have a real dataset context (selected or prepared draft).
    if (effectiveDatasetId) {
      try {
        const valResp = await validateMutation.mutateAsync({
          analysis: nextAnalysis,
          datasetId: effectiveDatasetId,
        });
        const map: Record<string, DashboardHtmlImportValidationResult> = {};
        for (const r of valResp.results) map[r.block_id] = r;
        setValidationResults(map);
        setValidationRan(true);
        setValidationFailed(false);
      } catch (error) {
        setValidationFailed(true);
        toast.error(getApiErrorMessage(error, 'Could not re-validate after manual edit.'));
      }
    }
  };

  const tableIdByDisplayName = useMemo<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const t of tables) map[t.display_name] = t.id;
    return map;
  }, [tables]);

  const tableIdBySourceKey = useMemo<Record<string, number>>(() => ({
    ...draftTableIdMap,
  }), [draftTableIdMap]);

  const sourceKeyByTableId = useMemo<Record<number, string>>(() => {
    const map: Record<number, string> = {};
    for (const [sourceKey, tableId] of Object.entries(draftTableIdMap)) {
      if (typeof tableId === 'number' && tableId > 0) {
        map[tableId] = sourceKey;
      }
    }
    for (const table of tables) {
      if (!map[table.id]) {
        map[table.id] = table.display_name;
      }
    }
    return map;
  }, [draftTableIdMap, tables]);

  const editingPlan = useMemo<DashboardHtmlImportChartPlan | null>(() => {
    if (!editingBlockId || !analysis) return null;
    return analysis.chart_plans.find((p) => p.block_id === editingBlockId) ?? null;
  }, [editingBlockId, analysis]);

  /** Columns that calc-field editors can insert as tokens. Prefers the live
   * draft/selected dataset schema when available (authoritative), falling
   * back to the analyze-time source profile for pre-draft upload mode. */
  const calculatedFieldsAvailableColumns = useMemo<Array<{ name: string; type?: string }>>(() => {
    if (!analysis) return [];
    // When we have a real dataset context (selected or prepared draft), read
    // columns from dataset tables — this reflects any transforms the user
    // applied in the dataset editor.
    if (effectiveDatasetId && tables.length > 0) {
      const seen = new Set<string>();
      const out: Array<{ name: string; type?: string }> = [];
      for (const table of tables) {
        const raw = (table as any)?.columns_cache;
        const cols: any[] = Array.isArray(raw)
          ? raw
          : (Array.isArray(raw?.columns) ? raw.columns : []);
        for (const col of cols) {
          const name = typeof col === 'string' ? col : col?.name;
          const type = typeof col === 'string' ? undefined : (col?.type as string | undefined);
          if (!name || seen.has(name)) continue;
          seen.add(name);
          out.push({ name, type });
        }
      }
      if (out.length > 0) return out;
    }
    if (sourceMode === 'upload_excel') {
      const profiles = analysis.all_source_profiles ?? null;
      const active = analysis.source_profile;
      const seen = new Set<string>();
      const out: Array<{ name: string; type?: string }> = [];
      const push = (name: string, type?: string) => {
        if (!name || seen.has(name)) return;
        seen.add(name);
        out.push({ name, type });
      };
      (active?.columns || []).forEach((c) => push(c.name, c.type));
      if (profiles) {
        for (const profile of Object.values(profiles)) {
          (profile?.columns || []).forEach((c) => push(c.name, c.type));
        }
      }
      return out;
    }
    const seen = new Set<string>();
    const out: Array<{ name: string; type?: string }> = [];
    for (const table of tables) {
      const raw = (table as any)?.columns_cache;
      const cols: any[] = Array.isArray(raw)
        ? raw
        : (Array.isArray(raw?.columns) ? raw.columns : []);
      for (const col of cols) {
        const name = typeof col === 'string' ? col : col?.name;
        const type = typeof col === 'string' ? undefined : (col?.type as string | undefined);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        out.push({ name, type });
      }
    }
    return out;
  }, [analysis, sourceMode, tables]);

  const calculatedFieldsSourceKeys = useMemo<string[]>(() => {
    if (!analysis) return [];
    if (sourceMode === 'upload_excel' && analysis.all_source_profiles) {
      return Object.keys(analysis.all_source_profiles);
    }
    if (sourceMode === 'existing_dataset') {
      return tables.map((t) => t.display_name).filter(Boolean);
    }
    return [];
  }, [analysis, sourceMode, tables]);

  /** Sample rows fed to AddColumnModal's live-preview pane. */
  const calculatedFieldsPreviewRows = useMemo<Array<Record<string, any>>>(() => {
    if (sourceMode === 'upload_excel') {
      return (analysis?.source_profile?.sample_rows ?? []) as Array<Record<string, any>>;
    }
    return (tablePreviewQuery.data?.rows ?? []) as Array<Record<string, any>>;
  }, [sourceMode, analysis, tablePreviewQuery.data]);

  /** Replace calculated_fields in the analysis and re-validate once a dataset
   * context is available. Validation tells us immediately whether a new or
   * edited expression survives DuckDB. */
  const handleCalculatedFieldsChange = async (
    nextFields: DashboardHtmlImportCalculatedField[],
  ) => {
    if (!analysis) return;
    const nextAnalysis: DashboardHtmlImportAnalyzeResponse = {
      ...analysis,
      calculated_fields: nextFields,
    };
    setAnalysis(nextAnalysis);
    // Drop the cached validation so any chart that references a calc field
    // is re-checked before the user builds.
    setValidationResults({});
    if (effectiveDatasetId) {
      try {
        const valResp = await validateMutation.mutateAsync({
          analysis: nextAnalysis,
          datasetId: effectiveDatasetId,
        });
        const map: Record<string, DashboardHtmlImportValidationResult> = {};
        const nextFieldErrors: Record<string, string> = {};
        for (const r of valResp.results) map[r.block_id] = r;
        // Heuristic: pick up calc-field complaints from validation errors and
        // surface them next to the offending field.
        for (const r of valResp.results) {
          if (r.status !== 'error' || !r.error) continue;
          for (const field of nextFields) {
            if (r.error.includes(field.name) && !nextFieldErrors[field.name]) {
              nextFieldErrors[field.name] = r.error;
            }
          }
        }
        setValidationResults(map);
        setValidationRan(true);
        setValidationFailed(false);
        setCalculatedFieldsErrors(nextFieldErrors);
      } catch (error) {
        setValidationFailed(true);
        toast.error(getApiErrorMessage(error, 'Could not re-validate calculated fields.'));
      }
    } else {
      // No live dataset — clear any stale error flags. Upload preview runs
      // inside the editor itself via the preview-calculated endpoint.
      setCalculatedFieldsErrors({});
    }
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
          derivedTables: currentAnalysis.derived_tables,
          datasetId: effectiveDatasetId,
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
    if (effectiveDatasetId) {
      try {
        const valResp = await validateMutation.mutateAsync({
          analysis: currentAnalysis,
          datasetId: effectiveDatasetId,
        });
        const map: Record<string, DashboardHtmlImportValidationResult> = {};
        for (const r of valResp.results) map[r.block_id] = r;
        setValidationResults(map);
        setValidationRan(true);
        setValidationFailed(false);
        const errorCount = valResp.results.filter((r) => r.status === 'error').length;
        if (errorCount === 0) {
          toast.success('All chart queries validated successfully after fix.');
        } else {
          toast.warning(`${errorCount} chart(s) still have query issues.`);
        }
      } catch (error) {
        setValidationFailed(true);
        toast.error(getApiErrorMessage(error, 'Re-validation failed.'));
      }
    }
  };

  /** Ensure a dataset exists that the user can open for transformations.
   *
   * - existing_dataset: returns the selected dataset_id directly (no writes).
   * - upload_excel: lazily creates a draft Dataset on the first Transform-table
   *   click. Subsequent clicks reuse the same draft.
   */
  const ensureDraft = async (options?: {
    dashboardName?: string;
    silent?: boolean;
  }): Promise<{
    datasetId: number;
    tableIdMap: Record<string, number>;
  } | null> => {
    if (draftDatasetId != null) {
      return { datasetId: draftDatasetId, tableIdMap: draftTableIdMap };
    }
    if (sourceMode === 'existing_dataset') {
      if (selectedDatasetId == null) {
        toast.error('Select a dataset before transforming tables.');
        return null;
      }
      try {
        setPreparingDraft(true);
        const resp = await prepareDraftMutation.mutateAsync({
          sourceMode: 'existing_dataset',
          datasetId: selectedDatasetId,
          dashboardName: options?.dashboardName || buildName || analysis?.suggested_dashboard_name || batchAnalysis?.suggested_dashboard_name || null,
        });
        setDraftDatasetId(resp.dataset_id);
        setDraftTableIdMap(resp.table_id_map || {});
        setDraftIsOwned(resp.is_draft);
        setDatasetPrepError(null);
        return { datasetId: resp.dataset_id, tableIdMap: resp.table_id_map || {} };
      } catch (error) {
        const msg = getApiErrorMessage(error, 'Could not resolve the selected dataset.');
        toast.error(msg);
        setDatasetPrepError(msg);
        return null;
      } finally {
        setPreparingDraft(false);
      }
    }
    // upload_excel
    if (sourceFiles.length === 0) {
      toast.error('Upload at least one source file first.');
      return null;
    }
    try {
      setPreparingDraft(true);
      const resp = await prepareDraftMutation.mutateAsync({
        sourceMode: 'upload_excel',
        dashboardName: options?.dashboardName || buildName || analysis?.suggested_dashboard_name || batchAnalysis?.suggested_dashboard_name || null,
        excelFile: sourceFiles.length === 1 ? sourceFiles[0] : null,
        excelFiles: sourceFiles.length > 1 ? sourceFiles : undefined,
      });
      setDraftDatasetId(resp.dataset_id);
      setDraftTableIdMap(resp.table_id_map || {});
      setDraftIsOwned(resp.is_draft);
      setDatasetPrepError(null);
      if (!options?.silent) {
        toast.success('Draft dataset prepared. Opening the dataset editor…');
      }
      return { datasetId: resp.dataset_id, tableIdMap: resp.table_id_map || {} };
    } catch (error) {
      const msg = getApiErrorMessage(error, 'Could not prepare a draft dataset.');
      toast.error(msg);
      setDatasetPrepError(msg);
      return null;
    } finally {
      setPreparingDraft(false);
    }
  };

  /** Open the dataset editor in a new tab so the user can apply the full
   * transformation pipeline (Add Column, Filter, Rename, Cast, …) and return
   * to the wizard. When they come back (window focus), we re-run validation
   * because column names / calculated fields may have changed. */
  const handleTransformTable = async () => {
    const draft = await ensureDraft();
    if (!draft) return;
    if (typeof window !== 'undefined') {
      pendingFocusRevalidationRef.current = true;
      window.open(`/datasets/${draft.datasetId}`, '_blank', 'noopener,noreferrer');
    }
  };

  /** Re-validate chart plans once the user returns from the dataset editor. */
  useEffect(() => {
    if (!isOpen) return;
    if (draftDatasetId == null) return;
    if (!analysis) return;
    const onFocus = () => {
      if (!pendingFocusRevalidationRef.current) return;
      pendingFocusRevalidationRef.current = false;
      validateMutation
        .mutateAsync({ analysis, datasetId: draftDatasetId })
        .then((resp) => {
          const map: Record<string, DashboardHtmlImportValidationResult> = {};
          for (const r of resp.results) map[r.block_id] = r;
          setValidationResults(map);
          setValidationRan(true);
        })
        .catch(() => undefined);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, draftDatasetId, analysis]);

  /** Best-effort cleanup when the browser tab is closed with an open draft. */
  useEffect(() => {
    if (!isOpen) return;
    if (draftDatasetId == null || !draftIsOwned) return;
    const onBeforeUnload = () => {
      try {
        const base = process.env.NEXT_PUBLIC_API_URL || '/api/v1';
        void fetch(`${base}/dashboards/import-html/drafts/${draftDatasetId}`, {
          method: 'DELETE',
          credentials: 'include',
          keepalive: true,
        });
      } catch {
        /* swallow */
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isOpen, draftDatasetId, draftIsOwned]);

  /** Wrapper around the parent-provided onClose that removes any draft the
   * user created in this session so cancelled imports never leave orphans. */
  const handleClose = async () => {
    if (draftDatasetId != null && draftIsOwned) {
      try {
        await cancelDraftMutation.mutateAsync(draftDatasetId);
      } catch {
        // Swallow — backend will also expire via is_draft cleanup; do not
        // block the user from closing the modal.
      }
    }
    onClose();
  };

  // Block IDs that are both selected for build AND currently failing validation.
  // Users must either fix these or uncheck them before building.
  const selectedInvalidBlockIds = includedBlockIds.filter(
    (id) => validationResults[id]?.status === 'error',
  );

  /** Single source of truth for "why Build is disabled". Covers both
   * per-chart errors AND dataset-level problems (draft prep crash, whole
   * validation batch failed, validation never ran with a dataset context). */
  const buildBlockReason: string | null = (() => {
    if (batchAnalysis) {
      return null;
    }
    if (datasetPrepError) {
      return `Dataset preparation failed: ${datasetPrepError}. Fix the source or pick a different dataset before building.`;
    }
    if (validationFailed) {
      return 'Validation could not complete — the dataset may be unreachable or invalid. Resolve the dataset issue and re-validate before building.';
    }
    if (validationRan && selectedInvalidBlockIds.length > 0) {
      return `${selectedInvalidBlockIds.length} selected chart(s) still have errors. Fix them or uncheck to continue.`;
    }
    if (analysis && effectiveDatasetId && !validationRan) {
      return 'Run validation before building so dataset issues can be caught.';
    }
    return null;
  })();
  const hasBlockingErrors = buildBlockReason !== null;

  const handleBuild = async () => {
    if (batchAnalysis) {
      const buildDocuments = batchAnalysis.documents
        .filter((document) => document.analysis.chart_plans.length > 0)
        .map((document) => ({
          documentId: document.document_id,
          filename: document.filename ?? null,
          pageName: document.page_name,
          analysis: document.analysis,
          includedBlockIds: document.analysis.chart_plans.map((plan) => plan.block_id),
        }));

      if (buildDocuments.length === 0) {
        toast.error('No chart blocks were detected across the selected HTML files.');
        return;
      }

      try {
        const result = await buildBatchMutation.mutateAsync({
          documents: buildDocuments,
          sourceMode,
          targetMode,
          targetDashboardId,
          dashboardName: buildName.trim() || batchAnalysis.suggested_dashboard_name,
          datasetId: sourceMode === 'existing_dataset' ? selectedDatasetId : null,
          preparedDatasetId: draftDatasetId ?? null,
          selectedSheetName: sourceMode === 'upload_excel' && sourceFiles.length === 1 ? activeUploadSheetName : null,
          excelFile:
            draftDatasetId == null && sourceMode === 'upload_excel' && sourceFiles.length === 1
              ? sourceFiles[0]
              : null,
          excelFiles:
            draftDatasetId == null && sourceMode === 'upload_excel' && sourceFiles.length > 1
              ? sourceFiles
              : undefined,
        });

        toast.success(`Imported ${result.pages.length} page(s) and ${result.created_chart_count} chart(s) successfully.`);
        onBuilt?.(result);
        setDraftIsOwned(false);
        setDraftDatasetId(null);
        onClose();

        if (targetMode === 'new_dashboard') {
          router.push(`/dashboards/${result.dashboard_id}`);
        }
      } catch (error) {
        toast.error(getApiErrorMessage(error, 'Could not build dashboard from the imported HTML files.'));
      }
      return;
    }

    if (!analysis) return;
    if (includedBlockIds.length === 0) {
      toast.error('Select at least one mapped chart block to build.');
      return;
    }
    if (hasBlockingErrors) {
      toast.error(buildBlockReason || 'Resolve the errors above before building.');
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
        // When the user transformed a draft dataset in the dataset editor we
        // point build at that prepared dataset rather than re-creating one.
        preparedDatasetId: draftDatasetId ?? null,
        selectedSheetName: sourceMode === 'upload_excel' && sourceFiles.length === 1 ? activeUploadSheetName : null,
        includedBlockIds,
        excelFile:
          draftDatasetId == null && sourceMode === 'upload_excel' && sourceFiles.length === 1
            ? sourceFiles[0]
            : null,
        excelFiles:
          draftDatasetId == null && sourceMode === 'upload_excel' && sourceFiles.length > 1
            ? sourceFiles
            : undefined,
      });

      const typeChangeCount = result.type_changes.length;
      if (typeChangeCount > 0) {
        toast.success(`Imported ${result.created_chart_count} chart(s). ${typeChangeCount} chart(s) were adapted to supported native types.`);
      } else {
        toast.success(`Imported ${result.created_chart_count} chart(s) successfully.`);
      }

      onBuilt?.(result);
      // Build succeeded → the draft (if any) has been promoted to a real
      // dataset server-side. Clear the owned-flag so handleClose does not
      // try to DELETE it on subsequent close.
      setDraftIsOwned(false);
      setDraftDatasetId(null);
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
    <>
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={targetMode === 'append_to_dashboard' ? 'Import HTML Into This Dashboard' : 'Import HTML Dashboard'}
      size="full"
      bodyClassName="overflow-hidden p-0"
      contentClassName="max-w-[92rem]"
      footer={
        <>
          {step === 'preview' && (
            <Button variant="ghost" size="sm" onClick={() => { setStep('configure'); setAnalysis(null); setBatchAnalysis(null); setValidationResults({}); setValidationRan(false); setSelectedFixBlockIds(new Set()); }} disabled={buildMutation.isPending || buildBatchMutation.isPending}>
              Back
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={handleClose} disabled={analyzeMutation.isPending || analyzeBatchMutation.isPending || buildMutation.isPending || buildBatchMutation.isPending}>
            Cancel
          </Button>
          {step === 'configure' ? (
            <Button
              variant="primary"
              size="sm"
              onClick={handleAnalyze}
              loading={analyzeMutation.isPending || analyzeBatchMutation.isPending}
            >
              Analyze Import
            </Button>
          ) : (
            <>
              {hasBlockingErrors && (
                <span className="text-xs text-red-600 dark:text-red-400 mr-2 self-center max-w-md">
                  {buildBlockReason}
                </span>
              )}
              <Button
                variant="primary"
                size="sm"
                onClick={handleBuild}
                loading={buildMutation.isPending || buildBatchMutation.isPending}
                disabled={!batchAnalysis && hasBlockingErrors}
                title={!batchAnalysis && hasBlockingErrors ? buildBlockReason || undefined : undefined}
              >
                Build Dashboard
              </Button>
            </>
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
            description={isBatchInputMode
              ? 'Batch mode imports multiple pages into one dashboard. You can load 2+ single-page HTML files, or switch back to one file for detailed chart editing.'
              : 'Paste Claude HTML here, or load a .html file. Single-page v1 stays in detailed editor mode; embedded v2 pages[] will automatically switch to multi-page import.'}
          >
            {isBatchInputMode ? (
              <div className="space-y-3 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3">
                {htmlDocuments.map((document) => (
                  <div key={document.documentId} className="flex items-center gap-2 rounded-lg border border-brand/20 bg-brand/10 px-3 py-2 text-caption text-text-primary">
                    <FileCode2 className="h-3.5 w-3.5 flex-shrink-0 text-brand" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{document.filename}</p>
                      <p className="truncate text-text-tertiary">Default page name: {document.pageName}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveHtmlDocument(document.documentId)}
                      className="rounded p-0.5 text-text-tertiary hover:bg-brand/10 hover:text-brand"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                <p className="text-caption text-text-tertiary">
                  Multi-page import is streamlined: page-level import only. Use single-file mode when you need chart-by-chart validation and manual edits before build.
                </p>
              </div>
            ) : (
              <Textarea
                value={htmlInput}
                onChange={(event) => setHtmlInput(event.target.value)}
                rows={12}
                placeholder="<html>...</html>"
              />
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<FileCode2 className="h-3.5 w-3.5" />}
                onClick={() => htmlFileInputRef.current?.click()}
              >
                Load HTML File(s)
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
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? []);
                  void handleHtmlFilesChange(files);
                  event.currentTarget.value = '';
                }}
              />
              {isBatchInputMode && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setHtmlDocuments([]);
                    setHtmlFilename('');
                    setBatchAnalysis(null);
                    setActiveBatchDocumentId('');
                  }}
                >
                  Clear HTML Batch
                </Button>
              )}
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
                    onChange={() => {
                      if (sourceMode !== 'existing_dataset') void invalidateDraftIfOwned();
                      setSourceMode('existing_dataset');
                    }}
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
                    onChange={() => {
                      if (sourceMode !== 'upload_excel') void invalidateDraftIfOwned();
                      setSourceMode('upload_excel');
                    }}
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
                      onChange={(event) => {
                        const nextId = event.target.value ? Number(event.target.value) : null;
                        if (nextId !== selectedDatasetId) void invalidateDraftIfOwned();
                        setSelectedDatasetId(nextId);
                      }}
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
          {batchAnalysis ? (
            <>
              <div className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
                <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
                  <p className="text-sm font-semibold text-text-primary">
                    {buildName.trim() || batchAnalysis.suggested_dashboard_name}
                  </p>
                  <p className="mt-1 text-caption text-text-tertiary">
                    {batchAnalysis.document_count} page import unit(s) analyzed. This can come from multiple HTML files or one embedded v2 HTML with pages[].
                  </p>
                  <div className="mt-4 rounded-lg border border-brand/20 bg-brand/10 px-3 py-2 text-caption text-brand">
                    Batch mode is additive only: the single-file editor, validation, and AI fix flow remain unchanged for the legacy path.
                  </div>
                </div>

                <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
                  {targetMode === 'new_dashboard' ? (
                    <FieldGroup
                      label="Dashboard Name"
                      description="All imported pages will be created inside this new dashboard."
                    >
                      <Input
                        value={buildName}
                        onChange={(event) => setBuildName(event.target.value)}
                        placeholder="Imported dashboard name"
                      />
                    </FieldGroup>
                  ) : (
                    <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3 text-caption text-text-tertiary">
                      The import will append {batchAnalysis.document_count} page(s) into {targetDashboardName ?? 'the current dashboard'}.
                    </div>
                  )}
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="xs"
                      leadingIcon={<Wand2 className="h-3 w-3" />}
                      loading={preparingDraft}
                      onClick={handleTransformTable}
                    >
                      {sourceMode === 'existing_dataset'
                        ? 'Open Dataset Editor'
                        : (draftDatasetId != null ? 'Open Draft Dataset' : 'Prepare Draft Dataset')}
                    </Button>
                  </div>
                  {draftDatasetId != null && (
                    <p className="mt-2 text-caption text-text-tertiary">
                      {draftIsOwned
                        ? `Draft dataset #${draftDatasetId} ready. Cancel will discard it; Build will promote it to a real dataset.`
                        : `Editing dataset #${draftDatasetId}. Changes persist across the wizard.`}
                    </p>
                  )}
                </div>
              </div>

              <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
                <div className="space-y-3">
                  {batchAnalysis.documents.map((document) => {
                    const chartCount = document.analysis.chart_plans.length;
                    const warningCount = document.analysis.warnings.length;
                    const ignoredCount = document.analysis.ignored_blocks.length;
                    const isActive = activeBatchDocument?.document_id === document.document_id;
                    return (
                      <div
                        key={document.document_id}
                        className={`rounded-xl border p-4 ${isActive ? 'border-brand/40 bg-brand/10' : 'border-[rgb(var(--border-line))] bg-surface-1'}`}
                      >
                        <div className="flex items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-text-primary">
                              {document.filename || document.analysis.document_title || document.page_name}
                            </p>
                            <p className="mt-1 text-caption text-text-tertiary">
                              {chartCount} chart block(s)
                              {warningCount > 0 ? ` • ${warningCount} warning(s)` : ''}
                              {ignoredCount > 0 ? ` • ${ignoredCount} ignored block(s)` : ''}
                              {chartCount === 0 ? ' • will be skipped' : ''}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => setActiveBatchDocumentId(document.document_id)}
                          >
                            Inspect
                          </Button>
                        </div>
                        <div className="mt-3">
                          <FieldGroup label="Page Name">
                            <Input
                              value={document.page_name}
                              onChange={(event) => handleUpdateBatchPageName(document.document_id, event.target.value)}
                              placeholder="Imported page name"
                            />
                          </FieldGroup>
                        </div>
                        {warningCount > 0 && (
                          <div className="mt-3 space-y-2">
                            {document.analysis.warnings.slice(0, 2).map((warning) => (
                              <div key={warning} className="rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-caption text-warning">
                                {warning}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4">
                  {activeBatchDocument ? (
                    <>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-text-primary">{activeBatchDocument.page_name}</p>
                          <p className="mt-1 text-caption text-text-tertiary">
                            {activeBatchDocument.analysis.document_title || activeBatchDocument.filename || 'Imported HTML document'}
                          </p>
                        </div>
                        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-text-tertiary">
                          {activeBatchDocument.analysis.chart_plans.length} chart(s)
                        </span>
                      </div>

                      {!!activeBatchDocument.analysis.warnings.length && (
                        <div className="mt-4 space-y-2">
                          {activeBatchDocument.analysis.warnings.map((warning) => (
                            <div key={warning} className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-caption text-warning">
                              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                              <span>{warning}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="mt-4 space-y-3">
                        {activeBatchDocument.analysis.chart_plans.length > 0 ? (
                          activeBatchDocument.analysis.chart_plans.map((plan) => (
                            <div key={plan.block_id} className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-3">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="text-caption font-semibold text-text-primary">{plan.title}</p>
                                <ChartTypeBadge value={plan.final_chart_type} />
                                {plan.source_key && (sourceFiles.length > 1 || sourceMode === 'existing_dataset') && (
                                  <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand">
                                    {plan.source_key}
                                  </span>
                                )}
                              </div>
                              {!!plan.source_fields_used.length && (
                                <p className="mt-2 text-caption text-text-tertiary">
                                  Fields: {plan.source_fields_used.join(', ')}
                                </p>
                              )}
                            </div>
                          ))
                        ) : (
                          <div className="rounded-lg border border-dashed border-[rgb(var(--border-strong))] bg-surface-2 px-4 py-6 text-center text-caption text-text-tertiary">
                            No chart blocks were detected for this HTML file. This page will be skipped during build.
                          </div>
                        )}
                      </div>

                      {!!activeBatchDocument.analysis.ignored_blocks.length && (
                        <div className="mt-4 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
                          <p className="text-caption font-semibold text-text-primary">Ignored blocks</p>
                          <div className="mt-2 space-y-2">
                            {activeBatchDocument.analysis.ignored_blocks.slice(0, 6).map((block, index) => (
                              <div key={`${block.block_id ?? index}-${index}`} className="text-caption text-text-tertiary">
                                <span className="font-semibold text-text-secondary">{block.block_id ?? `block-${index + 1}`}</span>
                                {' '}
                                {block.reason ?? 'Skipped during chart-first import'}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="rounded-lg border border-dashed border-[rgb(var(--border-strong))] bg-surface-2 px-4 py-8 text-center text-caption text-text-tertiary">
                      Select an HTML document to inspect its mapped page.
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : analysis && (
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
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="xs"
                      leadingIcon={<Wand2 className="h-3 w-3" />}
                      loading={preparingDraft}
                      onClick={handleTransformTable}
                    >
                      {sourceMode === 'existing_dataset'
                        ? 'Open Dataset Editor'
                        : (draftDatasetId != null ? 'Open Draft Dataset' : 'Prepare Draft Dataset')}
                    </Button>
                  </div>
                  {draftDatasetId != null && (
                    <p className="mt-2 text-caption text-text-tertiary">
                      {draftIsOwned
                        ? `Draft dataset #${draftDatasetId} ready. Cancel will discard it; Build will promote it to a real dataset.`
                        : `Editing dataset #${draftDatasetId}. Changes persist across the wizard.`}
                    </p>
                  )}
                </div>
              </div>

              {(
                <CalculatedFieldsPanel
                  fields={analysis.calculated_fields ?? []}
                  onChange={handleCalculatedFieldsChange}
                  availableColumns={calculatedFieldsAvailableColumns}
                  previewRows={calculatedFieldsPreviewRows}
                  sourceKeys={calculatedFieldsSourceKeys}
                  fieldErrors={calculatedFieldsErrors}
                  title="Derived columns (build-time)"
                  subtitle={sourceMode === 'upload_excel'
                    ? 'Formula-based columns injected during validation and build. For SQL-derived tables, use Edit chart -> Calculated table or open the draft dataset.'
                    : 'Formula-based columns injected during validation and build. For SQL-derived tables, use Edit chart -> Calculated table or open the dataset editor.'}
                />
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
                          <AlertTriangle className="h-4 w-4 text-danger" />
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
                {!validationRan && effectiveDatasetId && (
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
                                  <AlertTriangle className="h-3 w-3" /> Error
                                </span>
                              )
                            )}
                            {validateMutation.isPending && !validation && (
                              <Loader2 className="h-3 w-3 animate-spin text-text-tertiary" />
                            )}
                            {plan.manually_edited && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand">
                                <Pencil className="h-3 w-3" /> Edited
                              </span>
                            )}
                            <span className="ml-auto" />
                            <Button
                              variant="ghost"
                              size="xs"
                              leadingIcon={<Pencil className="h-3 w-3" />}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setEditingBlockId(plan.block_id);
                              }}
                            >
                              Edit
                            </Button>
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

      {(previewSourceMutation.isPending || analyzeMutation.isPending || analyzeBatchMutation.isPending || buildMutation.isPending || buildBatchMutation.isPending || validateMutation.isPending) && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-overlay/45 backdrop-blur-[1px]">
          <div className="rounded-xl border border-[rgb(var(--border-strong))] bg-surface-1 px-5 py-4 shadow-linear-lg">
            <div className="flex items-center gap-3">
              <Loader2 className="h-4 w-4 animate-spin text-brand" />
              <span className="text-sm text-text-primary">
                {previewSourceMutation.isPending
                  ? 'Parsing uploaded source file...'
                  : (analyzeMutation.isPending || analyzeBatchMutation.isPending)
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
    {effectiveDatasetId != null && analysis != null ? (
      <HtmlImportChartEditor
        isOpen={editingBlockId != null && !!editingPlan}
        plan={editingPlan}
        datasetId={effectiveDatasetId}
        tableIdByDisplayName={tableIdByDisplayName}
        tableIdBySourceKey={tableIdBySourceKey}
        sourceKeyByTableId={sourceKeyByTableId}
        calculatedFields={analysis?.calculated_fields ?? []}
        onCalculatedFieldsChange={handleCalculatedFieldsChange}
        onClose={() => setEditingBlockId(null)}
        onSave={handleApplyManualEdit}
      />
    ) : (
      <HtmlImportUploadChartEditor
        isOpen={editingBlockId != null && !!editingPlan}
        plan={editingPlan}
        sourceProfile={analysis?.source_profile ?? null}
        allSourceProfiles={analysis?.all_source_profiles ?? null}
        calculatedFields={analysis?.calculated_fields ?? []}
        onCalculatedFieldsChange={handleCalculatedFieldsChange}
        onClose={() => setEditingBlockId(null)}
        onSave={handleApplyManualEdit}
      />
    )}
    </>
  );
}
