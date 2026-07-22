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
  /**
   * Phase-13: optional drill-down parent. Names another dim on the same
   * view (e.g. day.parent = "month", month.parent = "quarter"). Pure
   * metadata for FE drill-down UX — engine doesn't consume it. BE
   * validator at save time rejects self-reference and cycles.
   */
  parent?: string;
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

/**
 * Phase-14: one filter-context modifier on a Measure.
 * - `all`: ignore the chart's filter context for this measure (grand total).
 * - `all_except`: only the listed `keep_fields` partition the window;
 *   everything else from the chart's slicers is blanked.
 * - `use_relationship`: route via a named JoinDefinition.alias instead of
 *   the default join path. Schema only in Phase-14 — engine wiring lands
 *   in a follow-up phase.
 */
export type ContextModifierType = 'all' | 'all_except' | 'use_relationship';

export interface ContextModifier {
  type: ContextModifierType;
  /** For 'all_except': dim names (bare or qualified) to KEEP in the partition. */
  keep_fields?: string[];
  /** For 'use_relationship': JoinDefinition.alias on the explore. */
  join_alias?: string;
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
  /**
   * Phase-14: filter-context modifiers — when set, the BE engine emits the
   * measure as a SQL window aggregate (`agg(...) OVER (...)`). Used for
   * "% of total" / "% of region" / "use inactive relationship" patterns.
   * Empty / undefined = legacy plain aggregate. See ContextModifier for
   * supported types.
   */
  context_modifiers?: ContextModifier[];
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

export interface DroppedFilterInfo {
  field: string;
  semantic_field?: string | null;
  operator?: string | null;
  reason: 'no_field' | 'no_join_path' | 'view_not_found' | 'field_not_on_view' | string;
  detail?: string;
}

export interface DistinctFieldValuesResponse {
  field: string;
  values: string[];
  /** Total distinct values matching the (searched) set — for pagination. */
  total?: number;
  /** True when more values exist beyond the returned page. */
  has_more?: boolean;
  dropped_filters?: DroppedFilterInfo[];
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
  // Semantic-audit 2026-07 (DA feedback, F4) — the backend now also suggests the
  // JOIN TYPE and the CANONICAL (auto-oriented to the many/fact side) shape, so
  // the dialog can pre-fill the correct fact-anchored relationship. Optional so
  // an older backend response still type-checks.
  suggested_join_type?: 'left' | 'inner' | 'right' | 'full';
  suggested_cardinality?: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
  canonical_from_view?: string;
  canonical_to_view?: string;
  canonical_from_columns?: string[];
  canonical_to_columns?: string[];
  will_auto_orient?: boolean;
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
  search?: string,
  offset?: number,
) {
  const response = await api.get<DistinctFieldValuesResponse>(
    `/datasets/${datasetId}/model/distinct-values`,
    {
      params: {
        field,
        limit,
        ...(offset ? { offset } : {}),
        ...(search && search.trim() ? { search: search.trim() } : {}),
        ...(filters?.length ? { filters: JSON.stringify(filters) } : {}),
      },
    },
  );
  return response.data;
}

async function fetchDatasetModelJoinSuggestion(
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
 * Phase-15.64 — Delete a single measure via the surgical DELETE endpoint
 * that bypasses batch validation. Use this from the measure-row delete
 * button instead of building a PUT with the bad measure omitted — the
 * PUT path re-validates every measure in the batch and would reject the
 * save if any other measure has legacy invalid shape.
 */
export function useDeleteModelMeasure() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      datasetId,
      viewId,
      measureName,
      force = false,
    }: {
      datasetId: number;
      viewId: number;
      measureName: string;
      force?: boolean;
    }) => {
      const response = await api.delete(
        `/datasets/${datasetId}/model/views/${viewId}/measures/${encodeURIComponent(measureName)}${force ? '?force=true' : ''}`,
      );
      return response.data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: modelKeys.detail(variables.datasetId) });
    },
  });
}

/** Response of the measure dry-run compile-check endpoint. */
export interface MeasureDryRunResult {
  ok: boolean;
  error: string | null;
  compiled_sql: string | null;
}

/**
 * Compile-check a single measure WITHOUT saving it.
 *
 * Plain async helper (not a React-Query hook) because the save handler calls
 * it imperatively, once per candidate measure, before committing the PUT. The
 * BE runs the measure through the REAL semantic engine (same path Explore
 * uses) and returns `{ok, error}` — so the FE catches broken SQL syntax /
 * bad references BEFORE the save, instead of the measure saving fine and
 * crashing later at Explore "Run". This is the single gatekeeper: we never
 * re-implement SQL parsing on the FE.
 *
 * A 4xx (access / not-found / system-managed table) throws — callers should
 * let that surface as a normal save error. A 200 with `ok=false` is the
 * expected "invalid syntax" outcome and is returned, not thrown.
 */
export async function dryRunMeasure(args: {
  datasetId: number;
  viewId: number;
  measure: MeasureDefinition;
}): Promise<MeasureDryRunResult> {
  const { datasetId, viewId, measure } = args;
  const response = await api.post<MeasureDryRunResult>(
    `/datasets/${datasetId}/model/views/${viewId}/measures/dry-run`,
    measure,
  );
  return response.data;
}

/** Result of the measure preview ("Chạy thử") — actual computed rows. */
export interface MeasurePreviewResult {
  ok: boolean;
  error: string | null;
  rows: Record<string, unknown>[];
  measure_key?: string | null;
  group_key?: string | null;
}

/**
 * Run a candidate measure WITHOUT saving and return its real value(s) — for
 * the "Chạy thử" button (D3). Grand-total when `groupBy` omitted; one row per
 * group value when a dimension is passed. Same single-gatekeeper path as the
 * dry-run (real engine + datasource, always rolled back). Never re-implements
 * aggregation on the FE.
 */
export async function previewMeasure(args: {
  datasetId: number;
  viewId: number;
  measure: MeasureDefinition;
  groupBy?: string;
}): Promise<MeasurePreviewResult> {
  const { datasetId, viewId, measure, groupBy } = args;
  const response = await api.post<MeasurePreviewResult>(
    `/datasets/${datasetId}/model/views/${viewId}/measures/preview`,
    { measure, group_by: groupBy || undefined },
  );
  return response.data;
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
  /**
   * Phase-1 PBI parity — declared primary key column(s) on the
   * relationship's "to" view ("one" side for many_to_one cardinality).
   * Composite PK = list of columns. Engine uses this for symmetric
   * aggregate (Phase 4) and distinct-count correctness. Null = leave
   * the view's PK declaration unchanged.
   */
  primaryKeyOnToView?: string[] | null;
  /**
   * Confirm-and-override the cascade guard. When the edit would deactivate a
   * relationship that charts still reference, the BE returns 409
   * JOIN_INACTIVE_CASCADE; the dialog asks the user to confirm and re-submits
   * with force=true to proceed (charts then need re-binding).
   */
  force?: boolean;
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
          // Phase-1 PBI parity — declare PK on the "to" view; BE applies it
          // to the SemanticView.primary_key column. Only sent when provided.
          ...(params.primaryKeyOnToView && params.primaryKeyOnToView.length > 0
            ? { primary_key_on_to_view: params.primaryKeyOnToView }
            : {}),
          // Cascade override: re-submit with force after the user confirms the
          // JOIN_INACTIVE_CASCADE warning (charts referencing the disabled join).
          ...(params.force ? { force: true } : {}),
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

// ===== Phase-16: Relationship review (non-destructive Gen-model) =====

export interface RelationshipSuggestion {
  from_view: string;
  to_view: string;
  from_columns: string[];
  to_columns: string[];
  relationship: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
  origin: 'auto_db_constraint' | 'auto_fk' | 'auto_same_name' | 'auto_type_distinct' | 'manual';
  confidence?: number;
  reasons?: string[];
  status: 'kept' | 'new';
}

export interface RelationshipObsolete extends RelationshipSuggestion {
  reason: string;
}

export interface RelationshipWarning {
  kind: 'ambiguous_relationship' | 'deep_scan_capped' | 'datasource_quota_exceeded';
  from_view?: string;
  to_view?: string;
  candidates?: Array<{
    from_column: string;
    to_column: string;
    overlap_ratio: number;
    from_distinct: number;
    to_distinct: number;
  }>;
  reason: string;
}

export interface RelationshipSuggestionsResponse {
  model_id: number;
  dataset_id: number;
  existing: RelationshipSuggestion[];
  recommended: RelationshipSuggestion[];
  obsolete: RelationshipObsolete[];
  warnings: RelationshipWarning[];
  rejected_count: number;
  deep_scan: boolean;
  view_labels?: Record<string, string>;
  stats?: {
    tables_scanned: number;
    fk_constraints_found: number;
    name_matches_found: number;
    same_name_pairs_probed: number;
    same_name_hits: number;
    overlap_probes_run: number;
    overlap_probes_hit: number;
    overlap_probes_failed: number;
    overlap_probes_below_threshold: number;
    rejected_skipped: number;
    already_existing_skipped: number;
    key_like_columns_total: number;
    tables_with_db_pk: number;
    tables_with_raw_types: number;
    datasource_reads: number;
    quota_warnings: number;
  };
}

export function useGenerateJoinSuggestions() {
  return useMutation({
    mutationFn: async ({
      datasetId,
      deepScan = false,
    }: {
      datasetId: number;
      deepScan?: boolean;
    }) => {
      const response = await api.post<RelationshipSuggestionsResponse>(
        `/datasets/${datasetId}/model/generate-suggestions`,
        { deep_scan: deepScan },
      );
      return response.data;
    },
  });
}

export function useApplyJoinSuggestions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      datasetId,
      selections,
    }: {
      datasetId: number;
      selections: RelationshipSuggestion[];
    }) => {
      const response = await api.post<{
        added: number;
        skipped: number;
        errors: Array<{ item: unknown; reason: string }>;
      }>(`/datasets/${datasetId}/model/joins/batch`, { selections });
      return response.data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: modelKeys.detail(variables.datasetId) });
    },
  });
}

export function useRejectJoinSuggestions() {
  return useMutation({
    mutationFn: async ({
      datasetId,
      rejections,
    }: {
      datasetId: number;
      rejections: RelationshipSuggestion[];
    }) => {
      const response = await api.post<{ rejected_count: number; added: number }>(
        `/datasets/${datasetId}/model/joins/reject`,
        { rejections },
      );
      return response.data;
    },
  });
}

export function useClearJoinRejections() {
  return useMutation({
    mutationFn: async ({ datasetId }: { datasetId: number }) => {
      const response = await api.delete<{ cleared: number }>(
        `/datasets/${datasetId}/model/joins/reject`,
      );
      return response.data;
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
