/**
 * React Query hooks for Dataset Workspaces API
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient as api } from '@/lib/api-client';

// ===== Types =====

export interface DatasetWorkspace {
  id: number;
  name: string;
  description?: string;
  owner_id?: string;
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

export interface WorkspaceTable {
  id: number;
  workspace_id: number;
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

export interface WorkspaceWithTables extends DatasetWorkspace {
  tables: WorkspaceTable[];
}

export interface CreateWorkspaceInput {
  name: string;
  description?: string;
}

export interface UpdateWorkspaceInput {
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

export const workspaceKeys = {
  all: ['dataset-workspaces'] as const,
  lists: () => [...workspaceKeys.all, 'list'] as const,
  list: (filters?: Record<string, any>) => [...workspaceKeys.lists(), filters] as const,
  details: () => [...workspaceKeys.all, 'detail'] as const,
  detail: (id: number) => [...workspaceKeys.details(), id] as const,
  tables: (workspaceId: number) => [...workspaceKeys.detail(workspaceId), 'tables'] as const,
  tablePreview: (workspaceId: number, tableId: number) => 
    [...workspaceKeys.detail(workspaceId), 'table', tableId, 'preview'] as const,
};

export const datasourceTableKeys = {
  all: ['datasource-tables'] as const,
  list: (datasourceId: number, search?: string) => 
    [...datasourceTableKeys.all, datasourceId, search] as const,
};

// ===== Hooks =====

/**
 * Get all dataset workspaces
 */
export function useWorkspaces(skip = 0, limit = 100) {
  return useQuery({
    queryKey: workspaceKeys.list({ skip, limit }),
    queryFn: async () => {
      const response = await api.get<DatasetWorkspace[]>(
        `/dataset-workspaces/?skip=${skip}&limit=${limit}`
      );
      return response.data;
    },
  });
}

/**
 * Get a single workspace with tables
 */
export function useWorkspace(workspaceId: number | null) {
  return useQuery({
    queryKey: workspaceKeys.detail(workspaceId!),
    queryFn: async () => {
      const response = await api.get<WorkspaceWithTables>(
        `/dataset-workspaces/${workspaceId}`
      );
      return response.data;
    },
    enabled: workspaceId !== null,
  });
}

/**
 * Get tables in a workspace
 */
export function useWorkspaceTables(workspaceId: number | null) {
  return useQuery({
    queryKey: workspaceKeys.tables(workspaceId!),
    queryFn: async () => {
      const response = await api.get<WorkspaceTable[]>(
        `/dataset-workspaces/${workspaceId}/tables`
      );
      return response.data;
    },
    enabled: workspaceId !== null,
  });
}

/**
 * Create a new workspace
 */
export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (input: CreateWorkspaceInput) => {
      const response = await api.post<DatasetWorkspace>(
        '/dataset-workspaces/',
        input
      );
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.lists() });
    },
  });
}

/**
 * Update a workspace
 */
export function useUpdateWorkspace() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ id, input }: { id: number; input: UpdateWorkspaceInput }) => {
      const response = await api.put<DatasetWorkspace>(
        `/dataset-workspaces/${id}`,
        input
      );
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.detail(variables.id) });
      queryClient.invalidateQueries({ queryKey: workspaceKeys.lists() });
    },
  });
}

/**
 * Delete a workspace
 */
export function useDeleteWorkspace() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/dataset-workspaces/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.lists() });
    },
  });
}

/**
 * Add a table to workspace
 */
export function useAddTableToWorkspace() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ workspaceId, input }: { workspaceId: number; input: AddTableInput }) => {
      const response = await api.post<WorkspaceTable>(
        `/dataset-workspaces/${workspaceId}/tables`,
        input
      );
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.detail(variables.workspaceId) });
      queryClient.invalidateQueries({ queryKey: workspaceKeys.tables(variables.workspaceId) });
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
      workspaceId, 
      tableId, 
      input 
    }: { 
      workspaceId: number; 
      tableId: number; 
      input: UpdateTableInput 
    }) => {
      const response = await api.put<WorkspaceTable>(
        `/dataset-workspaces/${workspaceId}/tables/${tableId}`,
        input
      );
      return response.data;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.detail(variables.workspaceId) });
      queryClient.invalidateQueries({ queryKey: workspaceKeys.tables(variables.workspaceId) });
    },
  });
}

/**
 * Remove a table from workspace
 */
export function useRemoveTable() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: async ({ workspaceId, tableId }: { workspaceId: number; tableId: number }) => {
      await api.delete(`/dataset-workspaces/${workspaceId}/tables/${tableId}`);
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: workspaceKeys.detail(variables.workspaceId) });
      queryClient.invalidateQueries({ queryKey: workspaceKeys.tables(variables.workspaceId) });
    },
  });
}

/**
 * Preview table data
 */
export function useTablePreview(
  workspaceId: number | null,
  tableId: number | null,
  request: TablePreviewRequest = {}
) {
  return useQuery({
    queryKey: [...workspaceKeys.tablePreview(workspaceId!, tableId!), request],
    queryFn: async () => {
      const response = await api.post<TablePreviewResponse>(
        `/dataset-workspaces/${workspaceId}/tables/${tableId}/preview`,
        request
      );
      return response.data;
    },
    enabled: workspaceId !== null && tableId !== null,
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
        `/dataset-workspaces/datasources/${datasourceId}/tables/columns?table=${encodeURIComponent(tableName!)}`
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
        `/dataset-workspaces/datasources/${datasourceId}/tables?${params.toString()}`
      );
      return response.data;
    },
    enabled: datasourceId !== null,
  });
}

/**
 * Execute query on workspace table with aggregations
 */
export function useExecuteWorkspaceTableQuery(
  workspaceId: number | null,
  tableId: number | null,
  request: ExecuteQueryRequest
) {
  return useQuery({
    queryKey: [...workspaceKeys.tablePreview(workspaceId!, tableId!), request],
    queryFn: async () => {
      const response = await api.post<ExecuteQueryResponse>(
        `/dataset-workspaces/${workspaceId}/tables/${tableId}/execute`,
        request
      );
      return response.data;
    },
    enabled: workspaceId !== null && tableId !== null,
  });
}
