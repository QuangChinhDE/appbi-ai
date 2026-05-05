/**
 * React Query hooks for Dataset Data Model (Semantic Layer) API
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient as api } from '@/lib/api-client';
import type { BaseFilter } from '@/lib/filters';

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
  origin?: 'auto_fk' | 'auto_calendar' | 'manual';
  managed?: boolean;
  presentation_view?: string;
  calendar_source_field?: string;
}

export interface DatasetModelView {
  id: number;
  name: string;
  dataset_table_id?: number;
  table_display_name?: string;
  sql_table_name?: string;
  view_role?: 'table' | 'calendar_dimension' | 'calendar_role';
  system_managed?: boolean;
  hidden_in_canvas?: boolean;
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

export interface JoinSuggestionResponse {
  relationship: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
  from_unique: boolean | null;
  to_unique: boolean | null;
  from_non_null_rows: number;
  to_non_null_rows: number;
  from_distinct_count: number;
  to_distinct_count: number;
  inference_mode: 'profiled' | 'heuristic';
  can_create: boolean;
  blocking_code: 'cycle_detected' | 'many_to_many' | null;
  message: string | null;
}

// ===== Query Keys =====

export const modelKeys = {
  all: ['dataset-model'] as const,
  detail: (datasetId: number) => [...modelKeys.all, datasetId] as const,
  distinct: (datasetId: number, field: string) => [...modelKeys.detail(datasetId), 'distinct', field] as const,
  joinSuggestion: (
    datasetId: number,
    fromViewId: number,
    toViewId: number,
    fromColumn: string,
    toColumn: string,
  ) => [...modelKeys.detail(datasetId), 'join-suggestion', fromViewId, toViewId, fromColumn, toColumn] as const,
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
  filters?: BaseFilter[],
) {
  const response = await api.get<DistinctFieldValuesResponse>(
    `/datasets/${datasetId}/model/distinct-values`,
    {
      params: {
        field,
        limit,
        ...(filters?.length ? { filters: JSON.stringify(filters) } : {}),
      },
    },
  );
  return response.data;
}

export async function fetchDatasetModelJoinSuggestion(
  datasetId: number,
  params: Pick<AddJoinParams, 'fromViewId' | 'toViewId' | 'fromColumn' | 'toColumn'>,
) {
  const response = await api.post<JoinSuggestionResponse>(
    `/datasets/${datasetId}/model/joins/suggestion`,
    {
      from_view_id: params.fromViewId,
      to_view_id: params.toViewId,
      from_column: params.fromColumn,
      to_column: params.toColumn,
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
 * Update a model table's fields
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
      data: Partial<Pick<DatasetModelView, 'dimensions' | 'measures' | 'description'>>;
    }) => {
      const response = await api.put(
        `/datasets/${datasetId}/model/views/${viewId}`,
        data
      );
      return response.data;
    },
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: modelKeys.detail(variables.datasetId) });

      const previousModel = queryClient.getQueryData<DatasetModelResponse>(
        modelKeys.detail(variables.datasetId)
      );

      queryClient.setQueryData<DatasetModelResponse>(
        modelKeys.detail(variables.datasetId),
        (current) => {
          if (!current) return current;
          return {
            ...current,
            views: current.views.map((view) =>
              view.id === variables.viewId
                ? {
                    ...view,
                    ...variables.data,
                    dimensions: variables.data.dimensions ?? view.dimensions,
                    measures: variables.data.measures ?? view.measures,
                    description: variables.data.description ?? view.description,
                  }
                : view
            ),
          };
        }
      );

      return { previousModel };
    },
    onError: (_error, variables, context) => {
      if (context?.previousModel) {
        queryClient.setQueryData(modelKeys.detail(variables.datasetId), context.previousModel);
      }
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: modelKeys.detail(variables.datasetId) });
    },
  });
}

/**
 * Update model relationships
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
      data: Partial<Pick<DatasetModelExplore, 'joins' | 'description'>>;
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

export function useDatasetModelJoinSuggestion(
  datasetId: number | null,
  params: Pick<AddJoinParams, 'fromViewId' | 'toViewId' | 'fromColumn' | 'toColumn'> | null,
) {
  return useQuery({
    queryKey: params
      ? modelKeys.joinSuggestion(
          datasetId!,
          params.fromViewId,
          params.toViewId,
          params.fromColumn,
          params.toColumn,
        )
      : [...modelKeys.all, 'join-suggestion', 'idle'],
    queryFn: () => fetchDatasetModelJoinSuggestion(datasetId!, params!),
    enabled: datasetId !== null
      && datasetId > 0
      && params !== null
      && params.fromViewId > 0
      && params.toViewId > 0
      && Boolean(params.fromColumn)
      && Boolean(params.toColumn),
    staleTime: 30_000,
    retry: false,
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
  /** Optional alias for role-playing joins (e.g. "creator", "updater" → users) */
  alias?: string | null;
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
          ...(params.alias ? { alias: params.alias } : {}),
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
