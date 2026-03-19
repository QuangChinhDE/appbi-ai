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
  SchemaResponse,
  TableDetail,
  WatermarkColumn,
  SyncConfig,
  SyncJob,
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

  // ── Schema Browser ──────────────────────────────────────────────────────

  getSchema: async (id: number): Promise<SchemaResponse> => {
    const response = await apiClient.get(`/datasources/${id}/schema`);
    return response.data;
  },

  getTableDetail: async (
    id: number,
    schemaName: string,
    tableName: string,
    previewRows = 5,
  ): Promise<TableDetail> => {
    const response = await apiClient.get(
      `/datasources/${id}/tables/${schemaName}/${tableName}`,
      { params: { preview_rows: previewRows } },
    );
    return response.data;
  },

  getWatermarkCandidates: async (
    id: number,
    schemaName: string,
    tableName: string,
  ): Promise<{ columns: WatermarkColumn[] }> => {
    const response = await apiClient.get(
      `/datasources/${id}/tables/${schemaName}/${tableName}/watermarks`,
    );
    return response.data;
  },

  // ── Sync Config ─────────────────────────────────────────────────────────

  getSyncConfig: async (id: number): Promise<{ sync_config: SyncConfig }> => {
    const response = await apiClient.get(`/datasources/${id}/sync-config`);
    return response.data;
  },

  saveSyncConfig: async (id: number, config: SyncConfig): Promise<{ sync_config: SyncConfig }> => {
    const response = await apiClient.put(`/datasources/${id}/sync-config`, {
      sync_config: config,
    });
    return response.data;
  },

  // ── Sync Jobs ────────────────────────────────────────────────────────────

  getSyncJobs: async (id: number, limit = 10): Promise<{ jobs: SyncJob[] }> => {
    const response = await apiClient.get(`/datasources/${id}/sync-jobs`, {
      params: { limit },
    });
    return response.data;
  },

  triggerSync: async (id: number): Promise<{ job_id: number; status: string; message: string }> => {
    const response = await apiClient.post(`/datasources/${id}/sync`);
    return response.data;
  },
};
