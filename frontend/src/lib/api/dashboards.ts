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
  DashboardHtmlImportBuildInput,
  DashboardHtmlImportBuildResponse,
  DashboardHtmlImportSourcePreviewResponse,
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

  updateLayout: async (
    dashboardId: number,
    chartLayouts: Array<{ id: number; layout: Record<string, any> }>
  ): Promise<Dashboard> => {
    const response = await apiClient.put(`/dashboards/${dashboardId}/layout`, {
      chart_layouts: chartLayouts,
    });
    return response.data;
  },

  analyzeHtmlImport: async (input: DashboardHtmlImportAnalyzeInput): Promise<DashboardHtmlImportAnalyzeResponse> => {
    const formData = new FormData();
    formData.append('html_content', input.htmlContent);
    formData.append('html_summary_json', JSON.stringify(input.htmlSummary ?? {}));
    formData.append('source_mode', input.sourceMode);
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

  buildHtmlImport: async (input: DashboardHtmlImportBuildInput): Promise<DashboardHtmlImportBuildResponse> => {
    const formData = new FormData();
    formData.append('analysis_json', JSON.stringify(input.analysis));
    formData.append('source_mode', input.sourceMode);
    formData.append('target_mode', input.targetMode);
    formData.append('included_block_ids_json', JSON.stringify(input.includedBlockIds ?? []));
    if (input.dashboardName?.trim()) {
      formData.append('dashboard_name', input.dashboardName.trim());
    }
    if (input.datasetTableId != null) {
      formData.append('dataset_table_id', String(input.datasetTableId));
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
