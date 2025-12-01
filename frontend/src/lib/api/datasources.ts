/**
 * API functions for data sources.
 */
import apiClient from '@/lib/api-client';
import {
  DataSource,
  DataSourceCreate,
  DataSourceUpdate,
  QueryExecuteRequest,
  QueryExecuteResponse,
} from '@/types/api';

export const dataSourceApi = {
  getAll: async (): Promise<DataSource[]> => {
    const response = await apiClient.get('/datasources/');
    return response.data;
  },

  getById: async (id: number): Promise<DataSource> => {
    const response = await apiClient.get(`/datasources/${id}`);
    return response.data;
  },

  create: async (data: DataSourceCreate): Promise<DataSource> => {
    const response = await apiClient.post('/datasources/', data);
    return response.data;
  },

  update: async (id: number, data: DataSourceUpdate): Promise<DataSource> => {
    const response = await apiClient.put(`/datasources/${id}`, data);
    return response.data;
  },

  delete: async (id: number): Promise<void> => {
    await apiClient.delete(`/datasources/${id}`);
  },

  test: async (type: string, config: Record<string, any>): Promise<{ success: boolean; message: string }> => {
    const response = await apiClient.post('/datasources/test', { type, config });
    return response.data;
  },

  executeQuery: async (request: QueryExecuteRequest): Promise<QueryExecuteResponse> => {
    const response = await apiClient.post('/datasources/query', request);
    return response.data;
  },
};
