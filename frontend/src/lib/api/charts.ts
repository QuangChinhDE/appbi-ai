/**
 * API functions for charts.
 */
import apiClient from '@/lib/api-client';
import {
  Chart,
  ChartCreate,
  ChartDryRunCreateRequest,
  ChartDryRunCreateResponse,
  ChartUpdate,
  ChartDataContext,
  ChartDataResponse,
  ChartListParams,
  ChartPreviewDataRequest,
  ChartPreviewDataResponse,
  ChartMetadata,
  ChartMetadataUpsert,
  ChartParameter,
  ChartParameterCreate,
} from '@/types/api';

export const chartApi = {
  getAll: async (params?: ChartListParams): Promise<Chart[]> => {
    const response = await apiClient.get('/charts/', { params });
    return response.data;
  },

  getById: async (id: number): Promise<Chart> => {
    const response = await apiClient.get(`/charts/${id}`);
    return response.data;
  },

  create: async (data: ChartCreate): Promise<Chart> => {
    const response = await apiClient.post('/charts/', data);
    return response.data;
  },

  dryRunCreate: async (data: ChartDryRunCreateRequest): Promise<ChartDryRunCreateResponse> => {
    const response = await apiClient.post('/charts/dry-run-create', data);
    return response.data;
  },

  update: async (id: number, data: ChartUpdate): Promise<Chart> => {
    const response = await apiClient.put(`/charts/${id}`, data);
    return response.data;
  },

  delete: async (id: number): Promise<void> => {
    await apiClient.delete(`/charts/${id}`);
  },

  getData: async (
    id: number,
    filters?: Record<string, unknown>[],
    context: ChartDataContext = 'default',
    granularity?: string,
    roleOverrides?: Record<string, string> | null,
  ): Promise<ChartDataResponse> => {
    const params: Record<string, string> = {};
    if (filters && filters.length > 0) {
      params.filters = JSON.stringify(filters);
    }
    if (context !== 'default') {
      params.context = context;
    }
    // #2 — viewer date-hierarchy: re-bucket the time axis at a grain the
    // end-user picked in the Dashboard viewer (BE re-queries at this grain).
    if (granularity) {
      params.granularity = granularity;
    }
    // What-if / field parameter — swap the chart's active dimension/measure at
    // query time from a dashboard parameter_switcher selection.
    if (roleOverrides && Object.keys(roleOverrides).length > 0) {
      params.overrides = JSON.stringify(roleOverrides);
    }
    const response = await apiClient.get(`/charts/${id}/data`, { params });
    return response.data;
  },

  previewData: async (payload: ChartPreviewDataRequest): Promise<ChartPreviewDataResponse> => {
    const response = await apiClient.post('/charts/preview-data', payload);
    return response.data;
  },

  // --- Metadata ---
  upsertMetadata: async (id: number, data: ChartMetadataUpsert): Promise<ChartMetadata> => {
    const response = await apiClient.put(`/charts/${id}/metadata`, data);
    return response.data;
  },

  deleteMetadata: async (id: number): Promise<void> => {
    await apiClient.delete(`/charts/${id}/metadata`);
  },

  // --- Parameters ---
  replaceParameters: async (id: number, params: ChartParameterCreate[]): Promise<ChartParameter[]> => {
    const response = await apiClient.put(`/charts/${id}/parameters`, params);
    return response.data;
  },

  addParameter: async (id: number, param: ChartParameterCreate): Promise<ChartParameter> => {
    const response = await apiClient.post(`/charts/${id}/parameters`, param);
    return response.data;
  },

  deleteParameter: async (id: number, paramId: number): Promise<void> => {
    await apiClient.delete(`/charts/${id}/parameters/${paramId}`);
  },
};
