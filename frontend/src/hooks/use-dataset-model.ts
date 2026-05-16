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

export type MeasureFilterOperator =
  | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'not_in' | 'between'
  | 'contains' | 'starts_with' | 'ends_with'
  | 'is_null' | 'is_not_null';

export interface MeasureFilter {
  field: string;
  operator: MeasureFilterOperator;
  value?: unknown;
}

export interface MeasureFormat {
  kind: 'number' | 'currency' | 'percent' | 'duration' | 'custom';
  decimals?: number;
  currency?: string;
  prefix?: string;
  suffix?: string;
  pattern?: string;
}

export interface MeasureSourceColumn {
  view: string;
  field: string;
}

export interface MeasureDefinition {
  name: string;
  type: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_distinct' | 'percent_of_total';
  /** Column or simple SQL — the value being aggregated (form mode). */
  sql?: string;
  /** Free SQL expression (advanced). When set, takes precedence over `sql`. */
  expression?: string;
  /** Structured filter list (Looker-style filtered measure). */
  filters?: MeasureFilter[];
  /** Raw WHERE fragment for power users; AND-combined with `filters`. */
  where_sql?: string;
  /** Measures referenced by this formula. Same-view names may be bare; cross-view refs use view.measure. */
  depends_on?: string[];
  /** Display format hint (does not affect SQL). */
  format?: MeasureFormat;
  /** UI grouping label. */
  folder?: string;
  label?: string;
  description?: string;
  hidden: boolean;
  /**
   * Phase-12: 'view' (default) means the measure aggregates columns from
   * its parent SemanticView only. 'dataset' means it pulls columns from
   * other views in the dataset declared via {@link source_columns}; the
   * engine auto-joins those views via the dataset's join graph.
   */
  scope?: 'view' | 'dataset';
  /**
   * Phase-12: required when scope='dataset'. Each entry names a view + field
   * the measure expression references (e.g. ${deals.amount}). Save-time
   * validator checks the view/field exist in the dataset model.
   */
  source_columns?: MeasureSourceColumn[];
}

export interface JoinDefinition {
  name: string;
  view: string;
  alias?: string;
  type: 'left' | 'inner' | 'right' | 'full';
  sql_on: string;
  relationship?: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
  from_view?: string;
  from_column?: string;
  to_column?: string;
  from_columns?: string[];
  to_columns?: string[];
  origin?: 'auto_fk' | 'auto_calendar' | 'manual';
  managed?: boolean;
  presentation_view?: string;
  calendar_source_field?: string;
  /** Phase-3b: inactive joins are stored but ignored by the engine. */
  is_active?: boolean;
  /** Phase-3b: 'both' adds a reverse edge in the resolver. */
  cross_filter?: 'single' | 'both';
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

function normalizeJoinColumnList(values?: string[] | null, fallback?: string | null): string[] {
  const source = values?.length ? values : (fallback ? [fallback] : []);
  return source
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function buildJoinColumnPayload(params: {
  fromColumn?: string | null;
  toColumn?: string | null;
  fromColumns?: string[] | null;
  toColumns?: string[] | null;
}) {
  const fromColumns = normalizeJoinColumnList(params.fromColumns, params.fromColumn);
  const toColumns = normalizeJoinColumnList(params.toColumns, params.toColumn);
  return {
    fromColumns,
    toColumns,
    payload: {
      from_column: fromColumns[0],
      to_column: toColumns[0],
      from_columns: fromColumns,
      to_columns: toColumns,
    },
  };
}

// ===== Query Keys =====

export const modelKeys = {
  all: ['dataset-model'] as const,
  detail: (datasetId: number) => [...modelKeys.all, datasetId] as const,
  distinct: (datasetId: number, field: string) => [...modelKeys.detail(datasetId), 'distinct', field] as const,
  layout: (datasetId: number) => [...modelKeys.detail(datasetId), 'layout'] as const,
  joinSuggestion: (
    datasetId: number,
    fromViewId: number,
    toViewId: number,
    fromColumnsKey: string,
    toColumnsKey: string,
  ) => [...modelKeys.detail(datasetId), 'join-suggestion', fromViewId, toViewId, fromColumnsKey, toColumnsKey] as const,
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
  params: Pick<AddJoinParams, 'fromViewId' | 'toViewId' | 'fromColumn' | 'toColumn' | 'fromColumns' | 'toColumns'>,
) {
  const { payload } = buildJoinColumnPayload(params);
  const response = await api.post<JoinSuggestionResponse>(
    `/datasets/${datasetId}/model/joins/suggestion`,
    {
      from_view_id: params.fromViewId,
      to_view_id: params.toViewId,
      ...payload,
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
      force,
    }: {
      datasetId: number;
      viewId: number;
      data: Partial<Pick<DatasetModelView, 'dimensions' | 'measures' | 'description'>> & {
        /** Phase-6: BE auto-rewrites every Chart.config and depends_on
         *  reference that targets an old measure name in this map. */
        rename_map?: Record<string, string>;
      };
      /** Phase-3: when true, bypass cascade guards (e.g. measure used by chart). */
      force?: boolean;
    }) => {
      const response = await api.put(
        `/datasets/${datasetId}/model/views/${viewId}${force ? '?force=true' : ''}`,
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
  params: Pick<AddJoinParams, 'fromViewId' | 'toViewId' | 'fromColumn' | 'toColumn' | 'fromColumns' | 'toColumns'> | null,
) {
  const normalizedFromColumns = normalizeJoinColumnList(params?.fromColumns, params?.fromColumn);
  const normalizedToColumns = normalizeJoinColumnList(params?.toColumns, params?.toColumn);
  return useQuery({
    queryKey: params
      ? modelKeys.joinSuggestion(
          datasetId!,
          params.fromViewId,
          params.toViewId,
          normalizedFromColumns.join('|'),
          normalizedToColumns.join('|'),
        )
      : [...modelKeys.all, 'join-suggestion', 'idle'],
    queryFn: () => fetchDatasetModelJoinSuggestion(datasetId!, params!),
    enabled: datasetId !== null
      && datasetId > 0
      && params !== null
      && params.fromViewId > 0
      && params.toViewId > 0
      && normalizedFromColumns.length > 0
      && normalizedToColumns.length > 0
      && normalizedFromColumns.length === normalizedToColumns.length,
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
  fromColumns?: string[];
  toColumns?: string[];
  joinType?: 'left' | 'inner' | 'right' | 'full';
  relationship?: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
  /** Optional alias for role-playing joins (e.g. "creator", "updater" → users) */
  alias?: string | null;
  /** Phase-3b: inactive joins are stored but ignored by the engine. */
  isActive?: boolean;
  /** Phase-3b: bidirectional filter propagation when set to 'both'. */
  crossFilter?: 'single' | 'both';
}

export function useAddJoin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: AddJoinParams) => {
      const { payload } = buildJoinColumnPayload(params);
      const response = await api.post(
        `/datasets/${params.datasetId}/model/joins`,
        {
          from_view_id: params.fromViewId,
          to_view_id: params.toViewId,
          ...payload,
          join_type: params.joinType ?? 'left',
          relationship: params.relationship ?? 'many_to_one',
          ...(params.alias ? { alias: params.alias } : {}),
          // Phase-3b extras — server defaults preserve old behaviour if omitted.
          ...(params.isActive !== undefined ? { is_active: params.isActive } : {}),
          ...(params.crossFilter ? { cross_filter: params.crossFilter } : {}),
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
  fromColumns?: string[];
  toColumns?: string[];
}

export function useRemoveJoin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: RemoveJoinParams) => {
      const { payload, fromColumns, toColumns } = buildJoinColumnPayload(params);
      const response = await api.delete(
        `/datasets/${params.datasetId}/model/joins`,
        {
          params: {
            from_view_id: params.fromViewId,
            to_view_name: params.toViewName,
            from_column: payload.from_column,
            to_column: payload.to_column,
            from_columns: fromColumns.length ? fromColumns.join(',') : undefined,
            to_columns: toColumns.length ? toColumns.join(',') : undefined,
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

// ===== Phase-4: Canvas layout (server-side persistence) =====

export type ModelLayoutPositions = Record<string, { x: number; y: number }>;

/**
 * Fetch the saved canvas card positions for the data-model view. Positions
 * follow the dataset (not the browser) so multiple users see the same
 * layout. Returns an empty object when nothing has been saved — the canvas
 * falls back to its topology-aware auto layout.
 */
export function useModelLayout(datasetId: number | null) {
  return useQuery({
    queryKey: datasetId == null ? ['dataset-model', 'layout', 'null'] : modelKeys.layout(datasetId),
    queryFn: async () => {
      if (datasetId == null) return {} as ModelLayoutPositions;
      const res = await api.get<ModelLayoutPositions>(`/datasets/${datasetId}/model/layout`);
      return res.data || {};
    },
    enabled: datasetId != null,
    staleTime: 60_000,
  });
}

export function useSaveModelLayout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: { datasetId: number; positions: ModelLayoutPositions }) => {
      const res = await api.put<ModelLayoutPositions>(
        `/datasets/${args.datasetId}/model/layout`,
        args.positions,
      );
      return res.data || {};
    },
    onSuccess: (data, variables) => {
      queryClient.setQueryData(modelKeys.layout(variables.datasetId), data);
    },
  });
}

// ===== Phase-5: Column lineage probe (proactive cascade warning) =====

export interface ColumnLineageResponse {
  column: string;
  table_id: number;
  dataset_id: number;
  semantic_refs: string[];
  chart_count_on_table: number;
}

/**
 * Ask the BE which dimensions/measures still reference a given column.
 * Use this BEFORE opening a destructive flow (delete column, rename) so
 * the UI can warn the user about the blast radius up front instead of
 * surfacing the cascade only when the save fails.
 */
export async function fetchColumnLineage(
  datasetId: number,
  tableId: number,
  columnName: string,
): Promise<ColumnLineageResponse> {
  const res = await api.get<ColumnLineageResponse>(
    `/datasets/${datasetId}/lineage/column/${tableId}/${encodeURIComponent(columnName)}`,
  );
  return res.data;
}
