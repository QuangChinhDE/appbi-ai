/**
 * React Query hooks for Dataset Data Model (Semantic Layer) API
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient as api } from '@/lib/api-client';

// ===== Types =====

export interface DimensionDefinition {
  name: string;
  type: 'string' | 'number' | 'date' | 'datetime' | 'yesno';
  sql?: string;
  label?: string;
  description?: string;
  hidden: boolean;
}

export interface MeasureDefinition {
  name: string;
  type: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_distinct' | 'percent_of_total';
  sql?: string;
  label?: string;
  description?: string;
  hidden: boolean;
}

export interface JoinDefinition {
  name: string;
  view: string;
  type: 'left' | 'inner' | 'right' | 'full';
  sql_on: string;
  relationship?: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
  from_view?: string;
  from_column?: string;
  to_column?: string;
}

export interface DatasetModelView {
  id: number;
  name: string;
  dataset_table_id?: number;
  table_display_name?: string;
  sql_table_name?: string;
  dimensions: DimensionDefinition[];
  measures: MeasureDefinition[];
  description?: string;
}

export interface DatasetModelExplore {
  id: number;
  name: string;
  base_view_name: string;
  base_view_id: number;
  joins: JoinDefinition[];
  description?: string;
}

export interface DatasetModelResponse {
  model_id: number | null;
  dataset_id: number;
  dataset_name: string;
  views: DatasetModelView[];
  explores: DatasetModelExplore[];
  generated: boolean;
}

export interface GenerateModelResponse {
  model_id: number;
  dataset_id: number;
  views_created: number;
  views_updated: number;
  explores_created: number;
  generated: boolean;
}

export interface DistinctFieldValuesResponse {
  field: string;
  values: string[];
}

// ===== Query Keys =====

export const modelKeys = {
  all: ['dataset-model'] as const,
  detail: (datasetId: number) => [...modelKeys.all, datasetId] as const,
  distinct: (datasetId: number, field: string) => [...modelKeys.detail(datasetId), 'distinct', field] as const,
};

// ===== Hooks =====

export async function fetchDatasetModel(datasetId: number) {
  const response = await api.get<DatasetModelResponse>(`/datasets/${datasetId}/model`);
  return response.data;
}

export async function fetchDatasetModelDistinctValues(
  datasetId: number,
  field: string,
  limit = 200,
) {
  const response = await api.get<DistinctFieldValuesResponse>(
    `/datasets/${datasetId}/model/distinct-values`,
    {
      params: { field, limit },
    },
  );
  return response.data;
}

/**
 * Get the semantic model for a dataset
 */
export function useDatasetModel(datasetId: number | null) {
  return useQuery({
    queryKey: modelKeys.detail(datasetId!),
    queryFn: () => fetchDatasetModel(datasetId!),
    enabled: datasetId !== null && datasetId > 0,
  });
}

/**
 * Generate (or regenerate) the semantic model for a dataset
 */
export function useGenerateModel() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ datasetId, force = false }: { datasetId: number; force?: boolean }) => {
      const response = await api.post<GenerateModelResponse>(
        `/datasets/${datasetId}/generate-model?force=${force}`
      );
      return response.data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: modelKeys.detail(variables.datasetId) });
    },
  });
}

/**
 * Update a semantic view (dimensions/measures)
 */
export function useUpdateModelView() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      datasetId,
      viewId,
      data,
    }: {
      datasetId: number;
      viewId: number;
      data: Partial<Pick<DatasetModelView, 'dimensions' | 'measures' | 'description' | 'name'>>;
    }) => {
      const response = await api.put(
        `/datasets/${datasetId}/model/views/${viewId}`,
        data
      );
      return response.data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: modelKeys.detail(variables.datasetId) });
    },
  });
}

/**
 * Update a semantic explore (joins)
 */
export function useUpdateModelExplore() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      datasetId,
      exploreId,
      data,
    }: {
      datasetId: number;
      exploreId: number;
      data: Partial<Pick<DatasetModelExplore, 'joins' | 'description' | 'name'>>;
    }) => {
      const response = await api.put(
        `/datasets/${datasetId}/model/explores/${exploreId}`,
        data
      );
      return response.data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: modelKeys.detail(variables.datasetId) });
    },
  });
}

// ===== Join CRUD hooks =====

export interface AddJoinParams {
  datasetId: number;
  fromViewId: number;
  toViewId: number;
  fromColumn: string;
  toColumn: string;
  joinType?: 'left' | 'inner' | 'right' | 'full';
  relationship?: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
}

export function useAddJoin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: AddJoinParams) => {
      const response = await api.post(
        `/datasets/${params.datasetId}/model/joins`,
        {
          from_view_id: params.fromViewId,
          to_view_id: params.toViewId,
          from_column: params.fromColumn,
          to_column: params.toColumn,
          join_type: params.joinType ?? 'left',
          relationship: params.relationship ?? 'many_to_one',
        }
      );
      return response.data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: modelKeys.detail(variables.datasetId) });
    },
  });
}

export interface RemoveJoinParams {
  datasetId: number;
  fromViewId: number;
  toViewName: string;
  fromColumn?: string;
  toColumn?: string;
}

export function useRemoveJoin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: RemoveJoinParams) => {
      const response = await api.delete(
        `/datasets/${params.datasetId}/model/joins`,
        {
          params: {
            from_view_id: params.fromViewId,
            to_view_name: params.toViewName,
            from_column: params.fromColumn,
            to_column: params.toColumn,
          },
        }
      );
      return response.data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: modelKeys.detail(variables.datasetId) });
    },
  });
}
