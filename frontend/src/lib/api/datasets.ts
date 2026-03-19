/**
 * API functions for datasets.
 */
import apiClient from '@/lib/api-client';
import {
  Dataset,
  DatasetCreate,
  DatasetUpdate,
  DatasetExecuteResponse,
} from '@/types/api';

export const datasetApi = {
  getAll: async (): Promise<Dataset[]> => {
    const response = await apiClient.get('/datasets/');
    return response.data;
  },

  getById: async (id: number): Promise<Dataset> => {
    const response = await apiClient.get(`/datasets/${id}`);
    return response.data;
  },

  create: async (data: DatasetCreate): Promise<Dataset> => {
    const response = await apiClient.post('/datasets/', data);
    return response.data;
  },

  update: async (id: number, data: DatasetUpdate): Promise<Dataset> => {
    const response = await apiClient.put(`/datasets/${id}`, data);
    return response.data;
  },

  delete: async (id: number): Promise<void> => {
    await apiClient.delete(`/datasets/${id}`);
  },

  execute: async (
    id: number, 
    limit?: number,
    apply_transformations: boolean = true
  ): Promise<DatasetExecuteResponse> => {
    const response = await apiClient.post(`/datasets/${id}/execute`, { 
      limit,
      apply_transformations
    });
    return response.data;
  },

  // ── Sync endpoints ────────────────────────────────────────────────────

  triggerSync: async (id: number, mode?: string) => {
    const params = mode ? `?mode=${mode}` : '';
    const response = await apiClient.post(`/datasets/${id}/sync/trigger${params}`);
    return response.data;
  },

  getSyncStatus: async (id: number) => {
    const response = await apiClient.get(`/datasets/${id}/sync/status`);
    return response.data;
  },

  getSyncHistory: async (id: number, skip = 0, limit = 20) => {
    const response = await apiClient.get(`/datasets/${id}/sync/history`, {
      params: { skip, limit },
    });
    return response.data;
  },

  updateSyncConfig: async (id: number, config: Record<string, unknown>) => {
    const response = await apiClient.put(`/datasets/${id}/sync-config`, config);
    return response.data;
  },
};
