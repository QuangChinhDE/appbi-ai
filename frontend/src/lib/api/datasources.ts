/**
 * API functions for data sources.
 */
import apiClient from '@/lib/api-client';
import {
  DataSource,
  DataSourceCreate,
  DataSourceTestResult,
  DataSourceUpdate,
  QueryExecuteRequest,
  QueryExecuteResponse,
  SchemaResponse,
  TableDetail,
  WatermarkColumn,
} from '@/types/api';

/** Manual (CSV/XLSX) upload — POST /datasources/manual/parse-file. Rows are
 *  never returned in full; the source config references the staged asset. */
export type ManualColumn = { name: string; type: string };
export type ManualSheetUpload = {
  asset_id: string;
  columns: ManualColumn[];
  row_count: number;
  preview_rows: Record<string, unknown>[];
  preview_truncated: boolean;
};
export type ManualParseFileResponse = {
  filename: string;
  sheets: Record<string, ManualSheetUpload>;
  limits: { max_bytes: number; max_rows: number; max_columns: number; preview_rows: number };
};
/** What a manual source stores in `config.sheets[name]`. */
export type ManualSheetRef = { asset_id: string; columns?: ManualColumn[]; row_count?: number };
/** Upload error body: `detail: {code, message}`. */
export type ManualUploadErrorDetail = { code: string; message: string };

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

  // Retest a SAVED source: type, destination and secret come only from the
  // persisted row (object edit required).
  test: async (id: number): Promise<DataSourceTestResult> => {
    const response = await apiClient.post(`/datasources/${id}/test`);
    return response.data;
  },

  // Test an unsaved config (create/edit form). A blank secret reuses the stored
  // one only when data_source_id is given AND nothing about the destination changed.
  testDraft: async (
    type: string,
    config: Record<string, any>,
    data_source_id?: number,
  ): Promise<DataSourceTestResult> => {
    const response = await apiClient.post('/datasources/test-draft', { type, config, data_source_id });
    return response.data;
  },

  executeQuery: async (request: QueryExecuteRequest): Promise<QueryExecuteResponse> => {
    const response = await apiClient.post('/datasources/query', request);
    return response.data;
  },

  validateSql: async (request: { data_source_id: number; sql_query: string }): Promise<{ valid: boolean; error: string | null; dialect: string | null }> => {
    const response = await apiClient.post('/datasources/validate-sql', request);
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

};
