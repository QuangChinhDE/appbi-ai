/**
 * API functions for dashboards.
 */
import apiClient from '@/lib/api-client';
import {
  Dashboard,
  DashboardCreate,
  DashboardUpdate,
  DashboardChartLayout,
  PublicLinkAppearanceConfig,
} from '@/types/api';
import type {
  DashboardHtmlImportAnalyzeInput,
  DashboardHtmlImportAnalyzeResponse,
  DashboardHtmlImportBatchAnalyzeInput,
  DashboardHtmlImportBatchAnalyzeResponse,
  DashboardHtmlImportBatchBuildInput,
  DashboardHtmlImportBatchBuildResponse,
  DashboardHtmlImportBuildInput,
  DashboardHtmlImportBuildResponse,
  DashboardHtmlImportFixChartInput,
  DashboardHtmlImportFixChartResponse,
  DashboardHtmlImportPrepareDraftInput,
  DashboardHtmlImportPrepareDraftResponse,
  DashboardHtmlImportPreviewCalculatedInput,
  DashboardHtmlImportPreviewCalculatedResponse,
  DashboardHtmlImportSourcePreviewResponse,
  DashboardHtmlImportValidateInput,
  DashboardHtmlImportValidateResponse,
} from '@/types/dashboard-html-import';

/** Per-page co-edit right resolved by the presence service (owner-priority). */
export type DashboardEditLock = {
  page_id: string;
  holder_key: string | null;
  holder_name: string | null;
  held_by_me: boolean;
  owner_present: boolean;
  i_am_owner: boolean;
  i_am_granted: boolean;
  can_edit: boolean;
  pending_requests: Array<{ requester_key: string; name: string | null; email: string | null }>;
};

export const dashboardApi = {
  getAll: async (): Promise<Dashboard[]> => {
    const response = await apiClient.get('/dashboards/');
    return response.data;
  },

  getById: async (id: number): Promise<Dashboard> => {
    const response = await apiClient.get(`/dashboards/${id}`);
    return response.data;
  },

  create: async (data: DashboardCreate): Promise<Dashboard> => {
    const response = await apiClient.post('/dashboards/', data);
    return response.data;
  },

  update: async (id: number, data: DashboardUpdate): Promise<Dashboard> => {
    const response = await apiClient.put(`/dashboards/${id}`, data);
    return response.data;
  },

  delete: async (id: number): Promise<void> => {
    await apiClient.delete(`/dashboards/${id}`);
  },

  // Deep-clone a dashboard into an independent copy (own chart rows).
  duplicate: async (id: number): Promise<Dashboard> => {
    const response = await apiClient.post(`/dashboards/${id}/duplicate`);
    return response.data;
  },

  // Download a re-importable HTML export (embedded verbatim snapshot).
  exportHtml: async (id: number): Promise<Blob> => {
    const response = await apiClient.get(`/dashboards/${id}/export-html`, {
      responseType: 'blob',
    });
    return response.data;
  },

  // One-click import of an AppBI-exported HTML file (verbatim snapshot).
  importSnapshot: async (file: File, dashboardName?: string): Promise<Dashboard> => {
    const formData = new FormData();
    formData.append('file', file);
    if (dashboardName?.trim()) {
      formData.append('dashboard_name', dashboardName.trim());
    }
    const response = await apiClient.post('/dashboards/import-snapshot', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },

  // Dashboard perf #5 — force-rebuild the materialized snapshots for every
  // dataset this dashboard reads. Returns { as_of } for the "Số tính đến" label.
  // Async now: kicks a BACKGROUND rebuild and returns immediately with
  // `building` (whether a rebuild is in flight). Poll getSnapshotInfo until
  // `building` is false. Never blocks on the extract-load.
  refreshSnapshots: async (
    dashboardId: number,
  ): Promise<{ ok: boolean; status?: string; as_of: string | null; building?: boolean; datasets?: any[] }> => {
    const response = await apiClient.post(`/dashboards/${dashboardId}/snapshots/refresh`);
    return response.data;
  },

  // Report-level "data as of" WITHOUT rebuilding, so the freshness label shows
  // on load (not only after a Refresh click). `building` = a rebuild is in flight.
  getSnapshotInfo: async (
    dashboardId: number,
  ): Promise<{ as_of: string | null; mode: string; building?: boolean }> => {
    const response = await apiClient.get(`/dashboards/${dashboardId}/snapshots/info`);
    return response.data;
  },

  addChart: async (
    dashboardId: number,
    chartId: number,
    layout: DashboardChartLayout,
    parameters?: Record<string, any>,
  ): Promise<Dashboard> => {
    const response = await apiClient.post(`/dashboards/${dashboardId}/charts`, {
      chart_id: chartId,
      layout,
      parameters: parameters ?? {},
    });
    return response.data;
  },

  removeChart: async (dashboardId: number, dashboardChartId: number): Promise<Dashboard> => {
    const response = await apiClient.delete(`/dashboards/${dashboardId}/charts/${dashboardChartId}`);
    return response.data;
  },

  addWidget: async (
    dashboardId: number,
    widgetType: string,
    layout: DashboardChartLayout,
    widgetConfig?: Record<string, any>,
  ): Promise<Dashboard> => {
    const response = await apiClient.post(`/dashboards/${dashboardId}/widgets`, {
      widget_type: widgetType,
      layout,
      widget_config: widgetConfig ?? {},
    });
    return response.data;
  },

  updateWidget: async (
    dashboardId: number,
    dashboardChartId: number,
    widgetConfig: Record<string, any>,
  ): Promise<Dashboard> => {
    const response = await apiClient.patch(
      `/dashboards/${dashboardId}/widgets/${dashboardChartId}`,
      { widget_config: widgetConfig },
    );
    return response.data;
  },

  // What-if / field parameter — persist a chart instance's `parameters`
  // (bindings live under `__whatifBindings`) so a switcher can swap the chart's
  // dimension/measure at query time.
  updateChartParameters: async (
    dashboardId: number,
    dashboardChartId: number,
    parameters: Record<string, any>,
  ): Promise<Dashboard> => {
    const response = await apiClient.patch(
      `/dashboards/${dashboardId}/charts/${dashboardChartId}/parameters`,
      { parameters },
    );
    return response.data;
  },

  updateLayout: async (
    dashboardId: number,
    chartLayouts: Array<{ id: number; layout: Record<string, any> }>
  ): Promise<Dashboard> => {
    const response = await apiClient.put(`/dashboards/${dashboardId}/layout`, {
      chart_layouts: chartLayouts,
    });
    return response.data;
  },

  // Phase-15.56 — draft / publish workflow. Layout edits write to
  // draft_snapshot; public viewers stay on the last-published layout
  // until publishDraft() copies the snapshot onto the live rows.
  updateDraftLayout: async (
    dashboardId: number,
    chartLayouts: Array<{ id: number; layout: Record<string, any> }>
  ): Promise<Dashboard> => {
    const response = await apiClient.put(`/dashboards/${dashboardId}/draft-layout`, {
      chart_layouts: chartLayouts,
    });
    return response.data;
  },

  // Phase-15.81 v12 — stage filter slot edits (all-pages + per-page)
  // into draft_snapshot so Publish flushes layout + filter together.
  // Either field may be omitted; pass [] to clear that scope's draft.
  // Phase-C THẬT — slicers_config joins the payload so slicer-block
  // edits share the same draft/publish lifecycle.
  updateDraftFilters: async (
    dashboardId: number,
    body: {
      filters_config?: Array<Record<string, any>>;
      slicers_config?: Array<Record<string, any>>;
      slicer_cluster_layout?: Record<string, any>;
      pages_config?: Array<Record<string, any>>;
    }
  ): Promise<Dashboard> => {
    const response = await apiClient.put(`/dashboards/${dashboardId}/draft-filters`, body);
    return response.data;
  },

  // Phase-B17 — publish accepts an optimistic-concurrency guard. Pass the
  // dashboard.updated_at the editor loaded; the BE 409s if someone else
  // published meanwhile (unless force=true).
  publishDraft: async (
    dashboardId: number,
    opts?: { tileBaseV?: Record<string, number> | null; force?: boolean },
  ): Promise<Dashboard> => {
    const body = opts
      ? { tile_base_v: opts.tileBaseV ?? null, force: !!opts.force }
      : undefined;
    const response = await apiClient.post(`/dashboards/${dashboardId}/publish`, body);
    return response.data;
  },

  discardDraft: async (dashboardId: number): Promise<Dashboard> => {
    const response = await apiClient.post(`/dashboards/${dashboardId}/discard-draft`);
    return response.data;
  },

  // Phase-B17/B19 — editor presence + per-page co-edit rights. Heartbeat reports
  // which tile + page the user is on and returns the OTHER editors active now,
  // the caller's edit-right for their current page (`lock`, owner-priority), and
  // who holds each page.
  editingHeartbeat: async (
    dashboardId: number,
    editingChartId?: number | null,
    editingPageId?: string | null,
  ): Promise<{
    editors: Array<{ user_key: string; name: string; email: string; seconds_ago: number; editing_chart_id: number | null; editing_page_id: string | null; is_owner: boolean }>;
    lock: DashboardEditLock | null;
    page_holders: Record<string, { holder_key: string; holder_name: string | null }>;
    current_updated_at: string | null;
  }> => {
    const response = await apiClient.post(`/dashboards/${dashboardId}/editing/heartbeat`, {
      editing_chart_id: editingChartId ?? null,
      editing_page_id: editingPageId ?? null,
    });
    return response.data;
  },
  editingLeave: async (dashboardId: number): Promise<void> => {
    await apiClient.post(`/dashboards/${dashboardId}/editing/leave`);
  },
  // A non-owner asks the owner for edit rights on a page the owner holds.
  editingRequestEdit: async (
    dashboardId: number,
    pageId: string,
  ): Promise<{ lock: DashboardEditLock | null }> => {
    const response = await apiClient.post(`/dashboards/${dashboardId}/editing/request-edit`, {
      page_id: pageId,
    });
    return response.data;
  },
  // The owner approves/denies a pending edit request on a page.
  editingRespond: async (
    dashboardId: number,
    pageId: string,
    requesterKey: string,
    approve: boolean,
  ): Promise<{ lock: DashboardEditLock | null }> => {
    const response = await apiClient.post(`/dashboards/${dashboardId}/editing/respond`, {
      page_id: pageId,
      requester_key: requesterKey,
      approve,
    });
    return response.data;
  },

  analyzeHtmlImport: async (input: DashboardHtmlImportAnalyzeInput): Promise<DashboardHtmlImportAnalyzeResponse> => {
    const formData = new FormData();
    formData.append('html_content', input.htmlContent);
    formData.append('html_summary_json', JSON.stringify(input.htmlSummary ?? {}));
    formData.append('source_mode', input.sourceMode);
    if (input.datasetId != null) {
      formData.append('dataset_id', String(input.datasetId));
    }
    if (input.datasetTableId != null) {
      formData.append('dataset_table_id', String(input.datasetTableId));
    }
    if (input.selectedSheetName?.trim()) {
      formData.append('selected_sheet_name', input.selectedSheetName.trim());
    }
    if (input.selectedSourceKey?.trim()) {
      formData.append('selected_source_key', input.selectedSourceKey.trim());
    }
    if (input.excelFiles && input.excelFiles.length > 0) {
      for (const file of input.excelFiles) {
        formData.append('excel_files', file);
      }
    } else if (input.excelFile) {
      formData.append('excel_file', input.excelFile);
    }

    const response = await apiClient.post('/dashboards/import-html/analyze', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },

  analyzeHtmlImportBatch: async (input: DashboardHtmlImportBatchAnalyzeInput): Promise<DashboardHtmlImportBatchAnalyzeResponse> => {
    const formData = new FormData();
    formData.append('html_documents_json', JSON.stringify((input.documents ?? []).map((document, index) => ({
      document_id: document.documentId || `document-${index + 1}`,
      filename: document.filename ?? null,
      page_name: document.pageName ?? null,
      html_content: document.htmlContent,
      html_summary: document.htmlSummary ?? {},
    }))));
    formData.append('source_mode', input.sourceMode);
    if (input.datasetId != null) {
      formData.append('dataset_id', String(input.datasetId));
    }
    if (input.datasetTableId != null) {
      formData.append('dataset_table_id', String(input.datasetTableId));
    }
    if (input.selectedSheetName?.trim()) {
      formData.append('selected_sheet_name', input.selectedSheetName.trim());
    }
    if (input.selectedSourceKey?.trim()) {
      formData.append('selected_source_key', input.selectedSourceKey.trim());
    }
    if (input.excelFiles && input.excelFiles.length > 0) {
      for (const file of input.excelFiles) {
        formData.append('excel_files', file);
      }
    } else if (input.excelFile) {
      formData.append('excel_file', input.excelFile);
    }

    const response = await apiClient.post('/dashboards/import-html/analyze-batch', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },

  buildHtmlImport: async (input: DashboardHtmlImportBuildInput): Promise<DashboardHtmlImportBuildResponse> => {
    const formData = new FormData();
    formData.append('analysis_json', JSON.stringify(input.analysis));
    formData.append('source_mode', input.sourceMode);
    formData.append('target_mode', input.targetMode);
    formData.append('included_block_ids_json', JSON.stringify(input.includedBlockIds ?? []));
    if (input.dashboardName?.trim()) {
      formData.append('dashboard_name', input.dashboardName.trim());
    }
    if (input.datasetId != null) {
      formData.append('dataset_id', String(input.datasetId));
    }
    if (input.datasetTableId != null) {
      formData.append('dataset_table_id', String(input.datasetTableId));
    }
    if (input.preparedDatasetId != null) {
      formData.append('prepared_dataset_id', String(input.preparedDatasetId));
    }
    if (input.selectedSheetName?.trim()) {
      formData.append('selected_sheet_name', input.selectedSheetName.trim());
    }
    if (input.targetDashboardId != null) {
      formData.append('target_dashboard_id', String(input.targetDashboardId));
    }
    if (input.excelFiles && input.excelFiles.length > 0) {
      for (const file of input.excelFiles) {
        formData.append('excel_files', file);
      }
    } else if (input.excelFile) {
      formData.append('excel_file', input.excelFile);
    }

    const response = await apiClient.post('/dashboards/import-html/build', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },

  buildHtmlImportBatch: async (input: DashboardHtmlImportBatchBuildInput): Promise<DashboardHtmlImportBatchBuildResponse> => {
    const formData = new FormData();
    formData.append('analyses_json', JSON.stringify((input.documents ?? []).map((document) => ({
      document_id: document.documentId,
      filename: document.filename ?? null,
      page_name: document.pageName ?? null,
      analysis: document.analysis,
      included_block_ids: document.includedBlockIds ?? [],
    }))));
    formData.append('source_mode', input.sourceMode);
    formData.append('target_mode', input.targetMode);
    if (input.dashboardName?.trim()) {
      formData.append('dashboard_name', input.dashboardName.trim());
    }
    if (input.datasetId != null) {
      formData.append('dataset_id', String(input.datasetId));
    }
    if (input.datasetTableId != null) {
      formData.append('dataset_table_id', String(input.datasetTableId));
    }
    if (input.preparedDatasetId != null) {
      formData.append('prepared_dataset_id', String(input.preparedDatasetId));
    }
    if (input.selectedSheetName?.trim()) {
      formData.append('selected_sheet_name', input.selectedSheetName.trim());
    }
    if (input.targetDashboardId != null) {
      formData.append('target_dashboard_id', String(input.targetDashboardId));
    }
    if (input.excelFiles && input.excelFiles.length > 0) {
      for (const file of input.excelFiles) {
        formData.append('excel_files', file);
      }
    } else if (input.excelFile) {
      formData.append('excel_file', input.excelFile);
    }

    const response = await apiClient.post('/dashboards/import-html/build-batch', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },

  previewHtmlImportSource: async (file: File): Promise<DashboardHtmlImportSourcePreviewResponse> => {
    const formData = new FormData();
    formData.append('excel_file', file);
    const response = await apiClient.post('/dashboards/import-html/source-preview', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },

  validateHtmlImportPlans: async (input: DashboardHtmlImportValidateInput): Promise<DashboardHtmlImportValidateResponse> => {
    const formData = new FormData();
    formData.append('analysis_json', JSON.stringify(input.analysis));
    formData.append('dataset_id', String(input.datasetId));
    const response = await apiClient.post('/dashboards/import-html/validate-plans', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },

  fixHtmlImportChartPlan: async (input: DashboardHtmlImportFixChartInput): Promise<DashboardHtmlImportFixChartResponse> => {
    const formData = new FormData();
    formData.append('chart_plan_json', JSON.stringify(input.chartPlan));
    formData.append('error_message', input.errorMessage);
    formData.append('source_profile_json', JSON.stringify(input.sourceProfile));
    if (input.allSourceProfiles) {
      formData.append('all_source_profiles_json', JSON.stringify(input.allSourceProfiles));
    }
    if (input.derivedTables) {
      formData.append('derived_tables_json', JSON.stringify(input.derivedTables));
    }
    if (input.datasetId) {
      formData.append('dataset_id', String(input.datasetId));
    }
    if (input.calculatedFields) {
      formData.append('calculated_fields_json', JSON.stringify(input.calculatedFields));
    }
    const response = await apiClient.post('/dashboards/import-html/fix-chart-plan', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },

  prepareHtmlImportDraft: async (
    input: DashboardHtmlImportPrepareDraftInput,
  ): Promise<DashboardHtmlImportPrepareDraftResponse> => {
    const formData = new FormData();
    formData.append('source_mode', input.sourceMode);
    if (input.dashboardName?.trim()) {
      formData.append('dashboard_name', input.dashboardName.trim());
    }
    if (input.datasetId != null) {
      formData.append('dataset_id', String(input.datasetId));
    }
    if (input.excelFiles && input.excelFiles.length > 0) {
      for (const file of input.excelFiles) {
        formData.append('excel_files', file);
      }
    } else if (input.excelFile) {
      formData.append('excel_file', input.excelFile);
    }
    const response = await apiClient.post(
      '/dashboards/import-html/prepare-draft',
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    );
    return response.data;
  },

  cancelHtmlImportDraft: async (datasetId: number): Promise<void> => {
    await apiClient.delete(`/dashboards/import-html/drafts/${datasetId}`);
  },

  previewHtmlImportCalculatedFields: async (
    input: DashboardHtmlImportPreviewCalculatedInput,
  ): Promise<DashboardHtmlImportPreviewCalculatedResponse> => {
    const formData = new FormData();
    formData.append('sample_rows_json', JSON.stringify(input.sampleRows || []));
    formData.append('columns_json', JSON.stringify(input.columns || []));
    formData.append('calculated_fields_json', JSON.stringify(input.calculatedFields || []));
    if (typeof input.rowLimit === 'number') {
      formData.append('row_limit', String(input.rowLimit));
    }
    const response = await apiClient.post(
      '/dashboards/import-html/preview-calculated',
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    );
    return response.data;
  },

  share: async (
    id: number,
    public_filters_config?: any[],
  ): Promise<{ share_token: string; public_filters_config?: any[] }> => {
    const response = await apiClient.post(`/dashboards/${id}/share`, { public_filters_config });
    return response.data;
  },

  unshare: async (id: number): Promise<void> => {
    await apiClient.delete(`/dashboards/${id}/share`);
  },

  // ── Multi public links ────────────────────────────────────────
  listPublicLinks: async (dashboardId: number): Promise<PublicLink[]> => {
    const response = await apiClient.get(`/dashboards/${dashboardId}/public-links`);
    return response.data;
  },

  // Ask the AI to read the dashboard and draft a report-flow system prompt.
  // `apiKey` is the key the DA is configuring (sent in header, not stored by
  // this call); if blank, the server uses a key already stored on a link.
  suggestAiSystemPrompt: async (
    dashboardId: number,
    opts: { provider?: string; model?: string; apiKey?: string },
  ): Promise<string> => {
    const headers: Record<string, string> = {};
    if (opts.apiKey) headers['X-User-Ai-Key'] = opts.apiKey;
    if (opts.provider) headers['X-User-Ai-Provider'] = opts.provider;
    if (opts.model) headers['X-User-Ai-Model'] = opts.model;
    const response = await apiClient.post(
      `/dashboards/${dashboardId}/ai/suggest-system-prompt`,
      { provider: opts.provider, model: opts.model },
      { headers },
    );
    return response.data?.system_prompt ?? '';
  },

  createPublicLink: async (
    dashboardId: number,
    data: {
      name: string;
      filters_config?: any[];
      appearance_config?: PublicLinkAppearanceConfig;
      password?: string;
    },
  ): Promise<PublicLink> => {
    const response = await apiClient.post(`/dashboards/${dashboardId}/public-links`, data);
    return response.data;
  },

  updatePublicLink: async (
    dashboardId: number,
    linkId: number,
    // password: undefined = no change, '' = clear password, non-empty = set new
    data: {
      name?: string;
      filters_config?: any[];
      appearance_config?: PublicLinkAppearanceConfig;
      is_active?: boolean;
      password?: string;
    },
  ): Promise<PublicLink> => {
    const response = await apiClient.patch(`/dashboards/${dashboardId}/public-links/${linkId}`, data);
    return response.data;
  },

  deletePublicLink: async (dashboardId: number, linkId: number): Promise<void> => {
    await apiClient.delete(`/dashboards/${dashboardId}/public-links/${linkId}`);
  },
};

export interface PublicLink {
  id: number;
  dashboard_id: number;
  name: string;
  token: string;
  filters_config: any[] | null;
  appearance_config: PublicLinkAppearanceConfig | null;
  is_active: boolean;
  has_password: boolean;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
}
