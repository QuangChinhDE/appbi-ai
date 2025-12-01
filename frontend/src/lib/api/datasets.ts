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

  execute: async (id: number, limit?: number): Promise<DatasetExecuteResponse> => {
    const response = await apiClient.post(`/datasets/${id}/execute`, { limit });
    return response.data;
  },
};
