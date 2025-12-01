/**
 * API functions for charts.
 */
import apiClient from '@/lib/api-client';
import {
  Chart,
  ChartCreate,
  ChartUpdate,
  ChartDataResponse,
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

  getData: async (id: number): Promise<ChartDataResponse> => {
    const response = await apiClient.get(`/charts/${id}/data`);
    return response.data;
  },
};
