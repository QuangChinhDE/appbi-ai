/**
 * API functions for charts.
 */
import apiClient from '@/lib/api-client';
import {
  Chart,
  ChartCreate,
  ChartUpdate,
  ChartDataResponse,
  ChartMetadata,
  ChartMetadataUpsert,
  ChartParameter,
  ChartParameterCreate,
} from '@/types/api';

export const chartApi = {
  getAll: async (): Promise<Chart[]> => {
    const response = await apiClient.get('/charts/');
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

  update: async (id: number, data: ChartUpdate): Promise<Chart> => {
    const response = await apiClient.put(`/charts/${id}`, data);
    return response.data;
  },

  delete: async (id: number): Promise<void> => {
    await apiClient.delete(`/charts/${id}`);
  },

  getData: async (id: number, filters?: Record<string, unknown>[]): Promise<ChartDataResponse> => {
    const params: Record<string, string> = {};
    if (filters && filters.length > 0) {
      params.filters = JSON.stringify(filters);
    }
    const response = await apiClient.get(`/charts/${id}/data`, { params });
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
