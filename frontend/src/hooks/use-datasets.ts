/**
 * React Query hooks for Dataset Datasets API
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Query } from '@tanstack/react-query';
import { apiClient as api } from '@/lib/api-client';

// ===== Types =====

export interface Dataset {
  id: number;
  name: string;
  description?: string;
  owner_id?: string;
  owner_email?: string;
  user_permission?: 'none' | 'view' | 'edit' | 'full';
  created_at: string;
  updated_at: string;
}

export interface Transformation {
  id?: string;
  type: 'select_columns' | 'add_column' | 'rename_columns' | 'js_formula';
  enabled: boolean;
  params: Record<string, any>;
}

export interface DatasetTable {
  id: number;
  dataset_id: number;
  datasource_id: number;
  source_kind: "physical_table" | "sql_query";
  source_table_name?: string;
  source_query?: string;
  display_name: string;
  enabled: boolean;
  transformations?: Transformation[];
  columns_cache?: Record<string, any>;
  sample_cache?: Record<string, any>[];
  type_overrides?: Record<string, string>;
  column_formats?: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface DatasetWithTables extends Dataset {
  tables: DatasetTable[];
}

export interface CreateDatasetInput {
  name: string;
  description?: string;
}

export interface UpdateDatasetInput {
  name?: string;
  description?: string;
}

export interface AddTableInput {
  datasource_id: number;
  source_kind?: "physical_table" | "sql_query";
  source_table_name?: string;
  source_query?: string;
  display_name: string;
  enabled?: boolean;
}

export interface UpdateTableInput {
  display_name?: string;
  source_query?: string;
  enabled?: boolean;
  transformations?: Transformation[];
  type_overrides?: Record<string, string>;
  column_formats?: Record<string, any>;
}

export interface ColumnMetadata {
  name: string;
  type: string;
  nullable?: boolean;
}

export interface TablePreviewRequest {
  limit?: number;
  offset?: number;
  filters?: Record<string, any>;
  sort?: Record<string, string>;
}

export interface TablePreviewResponse {
  columns: ColumnMetadata[];
  rows: Record<string, any>[];
  total: number;
  has_more: boolean;
}

export interface AggregationSpec {
  field: string;
  function: 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct';
}

export interface FilterCondition {
  field: string;
  operator: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'LIKE' | 'IN';
  value: string;
}

export interface ExecuteQueryRequest {
  dimensions?: string[];
  measures?: AggregationSpec[];
  filters?: FilterCondition[];
  limit?: number;
}

export interface ExecuteQueryResponse {
  columns: ColumnMetadata[];
  rows: Record<string, any>[];
}

export interface DatasourceTable {
  name: string;
  schema?: string;
  table_type: string;
}

export interface DatasourceColumn {
  name: string;
  type: string;
}

// ===== Query Keys =====

export const datasetKeys = {
  all: ['datasets'] as const,
  lists: () => [...datasetKeys.all, 'list'] as const,
  list: (filters?: Record<string, any>) => [...datasetKeys.lists(), filters] as const,
  details: () => [...datasetKeys.all, 'detail'] as const,
  detail: (id: number) => [...datasetKeys.details(), id] as const,
  tables: (datasetId: number) => [...datasetKeys.detail(datasetId), 'tables'] as const,
  tablePreview: (datasetId: number, tableId: number) => 
    [...datasetKeys.detail(datasetId), 'table', tableId, 'preview'] as const,
};

export const datasourceTableKeys = {
  all: ['datasource-tables'] as const,
  list: (datasourceId: number, search?: string) => 
    [...datasourceTableKeys.all, datasourceId, search] as const,
};

// ===== Hooks =====

/**
 * Get all dataset datasets
 */
export function useDatasets(skip = 0, limit = 100) {
  return useQuery({
    queryKey: datasetKeys.list({ skip, limit }),
    queryFn: async () => {
      const response = await api.get<Dataset[]>(
        `/datasets/?skip=${skip}&limit=${limit}`
      );
      return response.data;
    },
  });
}

/**
 * Get a single dataset with tables
 */
export function useDataset(datasetId: number | null) {
  return useQuery({
    queryKey: datasetKeys.detail(datasetId!),
    queryFn: async () => {
      const response = await api.get<DatasetWithTables>(
        `/datasets/${datasetId}`
      );
      return response.data;
    },
    enabled: datasetId !== null,
  });
}

/**
 * Get tables in a dataset
 */
export function useDatasetTables(datasetId: number | null) {
  return useQuery({
    queryKey: datasetKeys.tables(datasetId!),
    queryFn: async () => {
      const response = await api.get<DatasetTable[]>(
        `/datasets/${datasetId}/tables`
      );
      return response.data;
    },
    enabled: datasetId !== null,
  });
}

/**
 * Create a new dataset
 */
export function useCreateDataset() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (input: CreateDatasetInput) => {
      const response = await api.post<Dataset>(
        '/datasets/',
        input
      );
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: datasetKeys.lists() });
    },
  });
}

/**
 * Update a dataset
 */
export function useUpdateDataset() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ id, input }: { id: number; input: UpdateDatasetInput }) => {
      const response = await api.put<Dataset>(
        `/datasets/${id}`,
        input
      );
      return response.data;
    },
    onSuccess: (_data: Dataset, variables: { id: number; input: UpdateDatasetInput }) => {
      queryClient.invalidateQueries({ queryKey: datasetKeys.detail(variables.id) });
      queryClient.invalidateQueries({ queryKey: datasetKeys.lists() });
    },
  });
}

/**
 * Delete a dataset
 */
export function useDeleteDataset() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/datasets/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: datasetKeys.lists() });
    },
  });
}

/**
 * Add a table to dataset
 */
export function useAddTableToDataset() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ datasetId, input }: { datasetId: number; input: AddTableInput }) => {
      const response = await api.post<DatasetTable>(
        `/datasets/${datasetId}/tables`,
        input
      );
      return response.data;
    },
    onSuccess: (_data: DatasetTable, variables: { datasetId: number; input: AddTableInput }) => {
      queryClient.invalidateQueries({ queryKey: datasetKeys.detail(variables.datasetId) });
      queryClient.invalidateQueries({ queryKey: datasetKeys.tables(variables.datasetId) });
    },
  });
}

/**
 * Update a table
 */
export function useUpdateTable() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ 
      datasetId, 
      tableId, 
      input 
    }: { 
      datasetId: number; 
      tableId: number; 
      input: UpdateTableInput 
    }) => {
      const response = await api.put<DatasetTable>(
        `/datasets/${datasetId}/tables/${tableId}`,
        input
      );
      return response.data;
    },
    onSuccess: (_data: DatasetTable, variables: { datasetId: number; tableId: number; input: UpdateTableInput }) => {
      queryClient.invalidateQueries({ queryKey: datasetKeys.detail(variables.datasetId) });
      queryClient.invalidateQueries({ queryKey: datasetKeys.tables(variables.datasetId) });
    },
  });
}

/**
 * Remove a table from dataset
 */
export function useRemoveTable() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ datasetId, tableId }: { datasetId: number; tableId: number }) => {
      await api.delete(`/datasets/${datasetId}/tables/${tableId}`);
    },
    onSuccess: (_data: void, variables: { datasetId: number; tableId: number }) => {
      queryClient.invalidateQueries({ queryKey: datasetKeys.detail(variables.datasetId) });
      queryClient.invalidateQueries({ queryKey: datasetKeys.tables(variables.datasetId) });
    },
  });
}

/**
 * Preview table data
 */
export function useTablePreview(
  datasetId: number | null,
  tableId: number | null,
  request: TablePreviewRequest = {}
) {
  return useQuery({
    queryKey: [...datasetKeys.tablePreview(datasetId!, tableId!), request],
    queryFn: async () => {
      const response = await api.post<TablePreviewResponse>(
        `/datasets/${datasetId}/tables/${tableId}/preview`,
        request
      );
      return response.data;
    },
    enabled: datasetId !== null && tableId !== null,
    // Retry every 5s while the table is not yet synced (422) so the UI
    // automatically recovers once the background sync thread finishes.
    refetchInterval: (query: Query<TablePreviewResponse, any, TablePreviewResponse, readonly unknown[]>) => {
      const err = query.state.error as any;
      if (err?.response?.status === 422) return 5000;
      return false;
    },
    retry: (failureCount: number, error: any) => {
      // Keep retrying 422 (not synced) indefinitely; stop on other errors.
      if (error?.response?.status === 422) return true;
      return failureCount < 2;
    },
  });
}

/**
 * List columns for a specific table in a datasource
 */
export function useDatasourceTableColumns(datasourceId: number | null, tableName: string | null) {
  return useQuery({
    queryKey: ['datasource-columns', datasourceId, tableName],
    queryFn: async () => {
      const response = await api.get<{ columns: DatasourceColumn[] }>(
        `/datasets/datasources/${datasourceId}/tables/columns?table=${encodeURIComponent(tableName!)}`
      );
      return response.data.columns;
    },
    enabled: datasourceId !== null && !!tableName,
  });
}

/**
 * List tables from a datasource
 */
export function useDatasourceTables(datasourceId: number | null, search?: string) {
  return useQuery({
    queryKey: datasourceTableKeys.list(datasourceId!, search),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) {
        params.append('search', search);
      }
      
      const response = await api.get<DatasourceTable[]>(
        `/datasets/datasources/${datasourceId}/tables?${params.toString()}`
      );
      return response.data;
    },
    enabled: datasourceId !== null,
  });
}

/**
 * Execute query on dataset table with aggregations
 */
export function useExecuteDatasetTableQuery(
  datasetId: number | null,
  tableId: number | null,
  request: ExecuteQueryRequest
) {
  return useQuery({
    queryKey: [...datasetKeys.tablePreview(datasetId!, tableId!), request],
    queryFn: async () => {
      const response = await api.post<ExecuteQueryResponse>(
        `/datasets/${datasetId}/tables/${tableId}/execute`,
        request
      );
      return response.data;
    },
    enabled: datasetId !== null && tableId !== null,
  });
}
