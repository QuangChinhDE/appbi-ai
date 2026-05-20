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

  publishDraft: async (dashboardId: number): Promise<Dashboard> => {
    const response = await apiClient.post(`/dashboards/${dashboardId}/publish`);
    return response.data;
  },

  discardDraft: async (dashboardId: number): Promise<Dashboard> => {
    const response = await apiClient.post(`/dashboards/${dashboardId}/discard-draft`);
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
