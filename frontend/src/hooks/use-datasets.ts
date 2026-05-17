/**
 * React Query hooks for Dataset Datasets API
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient as api } from '@/lib/api-client';
import { sortByUpdatedAtDesc } from '@/lib/sort';

// ===== Types =====

export interface Dataset {
  id: number;
  name: string;
  description?: string;
  settings?: DatasetSettings;
  dictionary?: DatasetDictionary | null;
  dictionary_updated_at?: string | null;
  owner_id?: string;
  owner_email?: string;
  user_permission?: 'none' | 'view' | 'edit' | 'full';
  datasource_ids?: number[];
  created_at: string;
  updated_at: string;
}

export interface CalendarDimensionSettings {
  enabled: boolean;
  start_date: string;
  end_date: string;
  timezone: string;
  week_start_day: 'monday' | 'sunday';
  fiscal_year_start_month: number;
  auto_join_temporal_columns: boolean;
  excluded_auto_joins: Array<{
    view_name: string;
    column_name: string;
  }>;
}

export interface DatasetSettings {
  calendar_dimension: CalendarDimensionSettings;
}

export type DatasetDictionaryQualitySeverity = 'info' | 'warning' | 'error';
export type DatasetDictionaryQualityFormatHint =
  | 'email'
  | 'phone'
  | 'url'
  | 'date'
  | 'datetime'
  | 'currency'
  | 'percent'
  | 'custom';

export interface DatasetDictionaryColumnQuality {
  required?: boolean;
  unique?: boolean;
  accepted_values: string[];
  min_value?: string | number;
  max_value?: string | number;
  pattern?: string;
  format_hint?: DatasetDictionaryQualityFormatHint;
  null_threshold_percent?: number;
  distinct_threshold?: number;
  severity?: DatasetDictionaryQualitySeverity;
  notes?: string;
}

export interface DatasetDictionaryColumnNote {
  column_name: string;
  description?: string;
  business_name?: string;
  examples: string[];
  quality?: DatasetDictionaryColumnQuality;
}

export interface DatasetDictionaryTableNote {
  table_id: number;
  business_role?: string;
  grain?: string;
  join_hint?: string;
  owner_note?: string;
  freshness_expectation?: string;
  row_count_expectation?: string;
  important_columns: string[];
  column_notes: DatasetDictionaryColumnNote[];
}

export interface DatasetDictionary {
  overview?: string;
  business_purpose?: string;
  usage_guidelines?: string;
  ai_context?: string;
  default_filters: string[];
  warnings: string[];
  table_notes: DatasetDictionaryTableNote[];
}

export interface DatasetDictionaryStats {
  warnings: number;
  default_filters: number;
  table_notes: number;
  covered_tables: number;
  total_tables: number;
}

export interface DatasetDictionaryResponse {
  dictionary: DatasetDictionary;
  dictionary_updated_at?: string | null;
  stats: DatasetDictionaryStats;
  compiled_context: string;
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
  datasource_id?: number | null;
  source_kind: "physical_table" | "sql_query" | "derived_table" | "generated_calendar";
  source_table_name?: string;
  source_query?: string;
  display_name: string;
  enabled: boolean;
  transformations?: Transformation[];
  columns_cache?: Record<string, any>;
  sample_cache?: Record<string, any>[];
  type_overrides?: Record<string, any>;
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
  settings?: DatasetSettings;
}

export interface UpdateDatasetInput {
  name?: string;
  description?: string;
  settings?: DatasetSettings;
}

export interface AddTableInput {
  datasource_id?: number | null;
  source_kind?: "physical_table" | "sql_query" | "derived_table";
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
  type_overrides?: Record<string, any>;
  column_formats?: Record<string, any>;
}

export interface ColumnMetadata {
  name: string;
  type: string;
  nullable?: boolean;
  /** Optional human-readable display label sourced from the dataset model
   *  (semantic dimension/measure label or column dictionary). When absent,
   *  UIs should fall back to `name`. */
  label?: string;
  /** Optional UI-only field classification for Explore pickers. */
  fieldKind?: 'source' | 'calculated' | 'dimension' | 'measure' | 'date';
  /** Optional UI-only source classification for Explore pickers. */
  sourceKind?: 'source' | 'calculated' | 'semantic' | 'custom';
  /** Canonical semantic view name when the field is qualified. */
  viewName?: string;
  /** Human-readable semantic view / table label for display. */
  viewLabel?: string;
  /** Dataset table id/label for raw preview columns. */
  tableId?: number;
  tableLabel?: string;
}

export interface TablePreviewRequest {
  limit?: number;
  offset?: number;
  filters?: Record<string, any>;
  sort?: Record<string, string>;
}

export interface TablePreviewOptions {
  enabled?: boolean;
}

export interface DatasetTableSourceStatusOptions {
  enabled?: boolean;
}

export interface TablePreviewResponse {
  columns: ColumnMetadata[];
  rows: Record<string, any>[];
  total: number;
  has_more: boolean;
}

export type DatasetTableSourceStatusState = 'ok' | 'missing' | 'error' | 'unknown';

export interface DatasetTableSourceStatus {
  table_id: number;
  table_name?: string | null;
  source_kind?: string | null;
  source_table_name?: string | null;
  datasource_id?: number | null;
  status: DatasetTableSourceStatusState;
  code?: string | null;
  message?: string | null;
  source_object?: 'sheet' | 'table' | string | null;
  verified?: boolean | null;
  raw_error?: string | null;
}

export interface DatasetTableSourceStatusResponse {
  tables: DatasetTableSourceStatus[];
  checked_at?: string;
}

export interface AggregationSpec {
  field: string;
  /**
   * 'auto' is sent when the metric references a semantic measure whose
   * aggregation is part of the measure definition (e.g. count_distinct,
   * percent_of_total, formula). The backend resolves 'auto' against the
   * measure's stored type at query time.
   */
  function: 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct' | 'auto';
}

export interface FilterCondition {
  field: string;
  operator:
    | '=' | '!=' | '>' | '<' | '>=' | '<=' | 'LIKE' | 'IN'
    | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
    | 'contains' | 'not_contains' | 'starts_with'
    | 'between' | 'not_in' | 'is_null' | 'is_not_null';
  value?: any;
}

export interface OrderBySpec {
  field: string;
  direction: 'ASC' | 'DESC';
}

export interface ExecuteQueryRequest {
  dimensions?: string[];
  measures?: AggregationSpec[];
  filters?: FilterCondition[];
  order_by?: OrderBySpec[];
  limit?: number;
  /**
   * Phase-13.4: time-bucket dimensions on the BE. Keyed by dimension
   * field; value is the grain. BE engine emits dialect-correct
   * date_trunc (Phase-5 multi-dialect support). Omitting / empty =
   * group by the raw column value.
   */
  time_grains?: Record<string, 'day' | 'week' | 'month' | 'quarter' | 'year'>;
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

// ===== Quality Types =====

export type QualityDimension =
  | 'completeness'
  | 'validity'
  | 'uniqueness'
  | 'consistency'
  | 'timeliness'
  | 'accuracy';

export type QualitySeverity = 'info' | 'warning' | 'error';

export type QualityFormat = 'email' | 'url' | 'date' | 'datetime' | 'phone';

export interface QualityRuleConfig {
  threshold?: number;
  values?: string[];
  pattern?: string;
  flags?: string;
  min?: string | number;
  max?: string | number;
  format?: QualityFormat;
  columns?: string[];
  expression?: string;
  secondary_table_id?: number;
  join_condition?: string;
  column?: string;
  max_days?: number;
  min_z?: number;
  max_z?: number;
  sql?: string;
  [key: string]: unknown;
}

export interface QualityRule {
  id: number;
  dataset_id: number;
  table_id: number;
  column_name?: string | null;
  dimension: QualityDimension;
  rule_type: string;
  name: string;
  config?: QualityRuleConfig | null;
  severity: QualitySeverity;
  enabled: boolean;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface QualityRuleCreate {
  table_id: number;
  column_name?: string | null;
  dimension: QualityDimension;
  rule_type: string;
  name: string;
  config?: QualityRuleConfig;
  severity?: QualitySeverity;
  enabled?: boolean;
}

export interface QualityRuleUpdate {
  column_name?: string | null;
  dimension?: QualityDimension;
  rule_type?: string;
  name?: string;
  config?: QualityRuleConfig;
  severity?: QualitySeverity;
  enabled?: boolean;
}

export interface QualityRuleResult {
  passed: boolean;
  rows_checked?: number | null;
  rows_failed?: number | null;
  detail?: string | null;
  sql?: string | null;
  preview_sql?: string | null;
  preview_note?: string | null;
  preview_columns?: string[] | null;
  preview_rows?: Array<Record<string, unknown>> | null;
  log?: string[] | null;
  elapsed_ms?: number | null;
  skipped?: boolean;
  error?: boolean;
}

export interface QualityRun {
  id: number;
  dataset_id: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  score?: number | null;
  results?: Record<string, QualityRuleResult> | null;
  trigger_source?: 'manual' | 'schedule' | null;
  schedule_id?: number | null;
  progress_done?: number | null;
  progress_total?: number | null;
  error_message?: string | null;
  triggered_by_id?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at?: string | null;
}

export interface QualityRunTriggerResponse {
  run_id: number;
  status: string;
}

export interface QualityDimensionSummary {
  dimension: QualityDimension;
  total: number;
  enabled: number;
  passed?: number | null;
  failed?: number | null;
}

export interface QualitySummary {
  total_rules: number;
  enabled_rules: number;
  covered_tables: number;
  covered_columns: number;
  last_run?: QualityRun | null;
  score?: number | null;
  dimension_breakdown: QualityDimensionSummary[];
}

// ===== Quality Schedule / Automation =====

export type QualityScheduleType = 'manual' | 'schedule';

export interface QualitySchedule {
  id?: number | null;
  dataset_id: number;
  enabled: boolean;
  type: QualityScheduleType;
  cron?: string | null;
  timezone: string;
  recipient_email?: string | null;
  cc_emails: string[];
  notify_on_success: boolean;
  notify_on_failure: boolean;
  last_run_at?: string | null;
  last_run_status?: string | null;
  last_error?: string | null;
  next_run_at?: string | null;
  created_by_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface QualityScheduleUpsert {
  enabled: boolean;
  type: QualityScheduleType;
  cron?: string | null;
  timezone: string;
  recipient_email?: string | null;
  cc_emails: string[];
  notify_on_success: boolean;
  notify_on_failure: boolean;
}

// ===== Query Keys =====

export const datasetKeys = {
  all: ['datasets'] as const,
  lists: () => [...datasetKeys.all, 'list'] as const,
  list: (filters?: Record<string, any>) => [...datasetKeys.lists(), filters] as const,
  details: () => [...datasetKeys.all, 'detail'] as const,
  detail: (id: number) => [...datasetKeys.details(), id] as const,
  tables: (datasetId: number) => [...datasetKeys.detail(datasetId), 'tables'] as const,
  tableSourceStatus: (datasetId: number) =>
    [...datasetKeys.detail(datasetId), 'tables', 'source-status'] as const,
  dictionary: (datasetId: number) => [...datasetKeys.detail(datasetId), 'dictionary'] as const,
  tablePreview: (datasetId: number, tableId: number) =>
    [...datasetKeys.detail(datasetId), 'table', tableId, 'preview'] as const,
  qualityRules: (datasetId: number) => [...datasetKeys.detail(datasetId), 'quality', 'rules'] as const,
  qualityRulesTable: (datasetId: number, tableId: number) =>
    [...datasetKeys.detail(datasetId), 'quality', 'rules', tableId] as const,
  qualitySummary: (datasetId: number) => [...datasetKeys.detail(datasetId), 'quality', 'summary'] as const,
  qualityRuns: (datasetId: number) => [...datasetKeys.detail(datasetId), 'quality', 'runs'] as const,
  qualityRun: (datasetId: number, runId: number) =>
    [...datasetKeys.detail(datasetId), 'quality', 'runs', runId] as const,
  qualitySchedule: (datasetId: number) =>
    [...datasetKeys.detail(datasetId), 'quality', 'schedule'] as const,
};

export const datasourceTableKeys = {
  all: ['datasource-tables'] as const,
  list: (datasourceId: number, search?: string) => 
    [...datasourceTableKeys.all, datasourceId, search] as const,
};

function decodeContentDispositionFilename(header?: string | null): string | null {
  if (!header) return null;

  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }

  const asciiMatch = header.match(/filename="?([^";]+)"?/i);
  return asciiMatch?.[1] ?? null;
}

export interface DatasetTableExcelDownload {
  blob: Blob;
  filename: string;
  truncated: boolean;
  rowsWritten: number | null;
}

export async function downloadDatasetTableExcel(
  datasetId: number,
  tableId: number,
  options?: { maxRows?: number }
): Promise<DatasetTableExcelDownload> {
  const response = await api.get<Blob>(
    `/datasets/${datasetId}/tables/${tableId}/export/excel`,
    {
      responseType: 'blob',
      params: options?.maxRows ? { max_rows: options.maxRows } : undefined,
    }
  );

  const filename =
    decodeContentDispositionFilename(response.headers['content-disposition'])
    ?? `dataset-${datasetId}-table-${tableId}.xlsx`;
  const rowsHeader = response.headers['x-appbi-export-rows'];
  const rowsWritten = rowsHeader ? Number(rowsHeader) : null;

  return {
    blob: response.data,
    filename,
    truncated: response.headers['x-appbi-export-truncated'] === 'true',
    rowsWritten: Number.isFinite(rowsWritten) ? rowsWritten : null,
  };
}

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
    select: (datasets) => sortByUpdatedAtDesc(datasets),
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
 * Check whether dataset tables still exist in their connected live datasource.
 */
export function useDatasetTableSourceStatus(
  datasetId: number | null,
  options: DatasetTableSourceStatusOptions = {}
) {
  return useQuery({
    queryKey: datasetKeys.tableSourceStatus(datasetId!),
    queryFn: async () => {
      const response = await api.get<DatasetTableSourceStatusResponse>(
        `/datasets/${datasetId}/tables/source-status`
      );
      return response.data;
    },
    enabled: datasetId !== null && (options.enabled ?? true),
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

export function useDatasetDictionary(datasetId: number | null) {
  return useQuery({
    queryKey: datasetKeys.dictionary(datasetId!),
    queryFn: async () => {
      const response = await api.get<DatasetDictionaryResponse>(
        `/datasets/${datasetId}/dictionary`
      );
      return response.data;
    },
    enabled: datasetId !== null,
    staleTime: 5_000,
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
      queryClient.invalidateQueries({ queryKey: datasetKeys.tableSourceStatus(variables.datasetId) });
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
    onMutate: async (variables: { datasetId: number; tableId: number; input: UpdateTableInput }) => {
      await queryClient.cancelQueries({ queryKey: datasetKeys.detail(variables.datasetId) });
      await queryClient.cancelQueries({ queryKey: datasetKeys.tables(variables.datasetId) });

      const previousDetail = queryClient.getQueryData<DatasetWithTables>(
        datasetKeys.detail(variables.datasetId)
      );
      const previousTables = queryClient.getQueryData<DatasetTable[]>(
        datasetKeys.tables(variables.datasetId)
      );

      const patchTable = (table: DatasetTable): DatasetTable =>
        table.id === variables.tableId
          ? {
              ...table,
              ...variables.input,
              updated_at: new Date().toISOString(),
            }
          : table;

      queryClient.setQueryData<DatasetWithTables>(
        datasetKeys.detail(variables.datasetId),
        (current) => current ? { ...current, tables: current.tables.map(patchTable) } : current,
      );

      queryClient.setQueryData<DatasetTable[]>(
        datasetKeys.tables(variables.datasetId),
        (current) => current ? current.map(patchTable) : current,
      );

      return { previousDetail, previousTables };
    },
    onError: (_error, variables, context) => {
      if (context?.previousDetail) {
        queryClient.setQueryData(datasetKeys.detail(variables.datasetId), context.previousDetail);
      }
      if (context?.previousTables) {
        queryClient.setQueryData(datasetKeys.tables(variables.datasetId), context.previousTables);
      }
    },
    onSuccess: (data: DatasetTable, variables: { datasetId: number; tableId: number; input: UpdateTableInput }) => {
      queryClient.setQueryData<DatasetWithTables>(
        datasetKeys.detail(variables.datasetId),
        (current) => current ? {
          ...current,
          tables: current.tables.map((table) => table.id === variables.tableId ? data : table),
        } : current,
      );
      queryClient.setQueryData<DatasetTable[]>(
        datasetKeys.tables(variables.datasetId),
        (current) => current ? current.map((table) => table.id === variables.tableId ? data : table) : current,
      );
      queryClient.invalidateQueries({ queryKey: datasetKeys.tablePreview(variables.datasetId, variables.tableId) });
      queryClient.invalidateQueries({ queryKey: datasetKeys.tableSourceStatus(variables.datasetId) });
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
      queryClient.invalidateQueries({ queryKey: datasetKeys.tableSourceStatus(variables.datasetId) });
    },
  });
}

/**
 * Preview table data
 */
export function useTablePreview(
  datasetId: number | null,
  tableId: number | null,
  request: TablePreviewRequest = {},
  options: TablePreviewOptions = {}
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
    enabled: datasetId !== null && tableId !== null && (options.enabled ?? true),
    retry: (failureCount: number, error: any) => {
      return failureCount < 2;
    },
  });
}

export function useUpdateDatasetDictionary(datasetId: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: DatasetDictionary) => {
      const response = await api.put<DatasetDictionaryResponse>(
        `/datasets/${datasetId}/dictionary`,
        input
      );
      return response.data;
    },
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: datasetKeys.dictionary(datasetId) });

      const previousDictionary = queryClient.getQueryData<DatasetDictionaryResponse>(
        datasetKeys.dictionary(datasetId)
      );

      queryClient.setQueryData<DatasetDictionaryResponse>(
        datasetKeys.dictionary(datasetId),
        (current) => ({
          dictionary: input,
          dictionary_updated_at: current?.dictionary_updated_at ?? new Date().toISOString(),
          stats: current?.stats ?? {
            warnings: input.warnings?.length ?? 0,
            default_filters: input.default_filters?.length ?? 0,
            table_notes: input.table_notes?.length ?? 0,
            covered_tables: input.table_notes?.length ?? 0,
            total_tables: current?.stats?.total_tables ?? 0,
          },
          compiled_context: current?.compiled_context ?? '',
        })
      );

      return { previousDictionary };
    },
    onError: (_error, _input, context) => {
      if (context?.previousDictionary) {
        queryClient.setQueryData(datasetKeys.dictionary(datasetId), context.previousDictionary);
      }
    },
    onSuccess: (data) => {
      queryClient.setQueryData(datasetKeys.dictionary(datasetId), data);
      queryClient.invalidateQueries({ queryKey: datasetKeys.detail(datasetId) });
      queryClient.invalidateQueries({ queryKey: datasetKeys.lists() });
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

export function useExecuteDatasetTableQueryMutation() {
  return useMutation({
    mutationFn: async ({
      datasetId,
      tableId,
      request,
    }: {
      datasetId: number;
      tableId: number;
      request: ExecuteQueryRequest;
    }) => {
      const response = await api.post<ExecuteQueryResponse>(
        `/datasets/${datasetId}/tables/${tableId}/execute`,
        request
      );
      return response.data;
    },
  });
}

// ===== Quality Hooks =====

export function useQualitySummary(datasetId: number | null) {
  return useQuery({
    queryKey: datasetKeys.qualitySummary(datasetId!),
    queryFn: async () => {
      const res = await api.get<QualitySummary>(`/datasets/${datasetId}/quality/summary`);
      return res.data;
    },
    enabled: datasetId !== null,
    staleTime: 10_000,
  });
}

export function useQualityRules(datasetId: number | null, tableId?: number) {
  return useQuery({
    queryKey: tableId
      ? datasetKeys.qualityRulesTable(datasetId!, tableId)
      : datasetKeys.qualityRules(datasetId!),
    queryFn: async () => {
      const params = tableId ? `?table_id=${tableId}` : '';
      const res = await api.get<QualityRule[]>(
        `/datasets/${datasetId}/quality/rules${params}`
      );
      return res.data;
    },
    enabled: datasetId !== null,
  });
}

export function useCreateQualityRule(datasetId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: QualityRuleCreate) => {
      const res = await api.post<QualityRule>(
        `/datasets/${datasetId}/quality/rules`,
        body
      );
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: datasetKeys.qualityRules(datasetId) });
      queryClient.invalidateQueries({ queryKey: datasetKeys.qualitySummary(datasetId) });
    },
  });
}

export function useBulkCreateQualityRules(datasetId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (rules: QualityRuleCreate[]) => {
      const res = await api.post<QualityRule[]>(
        `/datasets/${datasetId}/quality/rules/bulk`,
        { rules }
      );
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: datasetKeys.qualityRules(datasetId) });
      queryClient.invalidateQueries({ queryKey: datasetKeys.qualitySummary(datasetId) });
    },
  });
}

export function useUpdateQualityRule(datasetId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ ruleId, body }: { ruleId: number; body: QualityRuleUpdate }) => {
      const res = await api.put<QualityRule>(
        `/datasets/${datasetId}/quality/rules/${ruleId}`,
        body
      );
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: datasetKeys.qualityRules(datasetId) });
      queryClient.invalidateQueries({ queryKey: datasetKeys.qualitySummary(datasetId) });
    },
  });
}

export function useDeleteQualityRule(datasetId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (ruleId: number) => {
      await api.delete(`/datasets/${datasetId}/quality/rules/${ruleId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: datasetKeys.qualityRules(datasetId) });
      queryClient.invalidateQueries({ queryKey: datasetKeys.qualitySummary(datasetId) });
    },
  });
}

export function useDuplicateQualityRule(datasetId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ ruleId, targetTableId, nameSuffix }: {
      ruleId: number;
      targetTableId?: number;
      nameSuffix?: string;
    }) => {
      const res = await api.post<QualityRule>(
        `/datasets/${datasetId}/quality/rules/${ruleId}/duplicate`,
        { target_table_id: targetTableId ?? null, name_suffix: nameSuffix ?? ' (copy)' }
      );
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: datasetKeys.qualityRules(datasetId) });
      queryClient.invalidateQueries({ queryKey: datasetKeys.qualitySummary(datasetId) });
    },
  });
}

export function useTriggerQualityRun(datasetId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await api.post<QualityRunTriggerResponse>(
        `/datasets/${datasetId}/quality/runs`
      );
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: datasetKeys.qualityRuns(datasetId) });
      queryClient.invalidateQueries({ queryKey: datasetKeys.qualitySummary(datasetId) });
    },
  });
}

export function useQualityRuns(datasetId: number | null) {
  return useQuery({
    queryKey: datasetKeys.qualityRuns(datasetId!),
    queryFn: async () => {
      const res = await api.get<QualityRun[]>(`/datasets/${datasetId}/quality/runs?limit=20`);
      return res.data;
    },
    enabled: datasetId !== null,
  });
}

export function useQualityRunPoll(
  datasetId: number | null,
  runId: number | null,
  enabled = false,
) {
  return useQuery({
    queryKey: datasetKeys.qualityRun(datasetId!, runId!),
    queryFn: async () => {
      const res = await api.get<QualityRun>(
        `/datasets/${datasetId}/quality/runs/${runId}`
      );
      return res.data;
    },
    enabled: enabled && datasetId !== null && runId !== null,
    // Chỉ poll khi đang queued/running, tự dừng khi completed/failed
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 2000;
      if (data.status === 'queued' || data.status === 'running') return 2000;
      return false; // dừng poll ngay khi có kết quả
    },
    // Không dùng staleTime mặc định — luôn fetch fresh khi enabled
    staleTime: 0,
    // Không retry khi poll bị lỗi tạm thời
    retry: false,
  });
}

// ===== Quality Schedule Hooks =====

export function useQualitySchedule(datasetId: number | null) {
  return useQuery({
    queryKey: datasetKeys.qualitySchedule(datasetId!),
    queryFn: async () => {
      const res = await api.get<QualitySchedule>(
        `/datasets/${datasetId}/quality/schedule`
      );
      return res.data;
    },
    enabled: datasetId !== null,
    staleTime: 30_000,
  });
}

export function useUpsertQualitySchedule(datasetId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: QualityScheduleUpsert) => {
      const res = await api.put<QualitySchedule>(
        `/datasets/${datasetId}/quality/schedule`,
        body
      );
      return res.data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(datasetKeys.qualitySchedule(datasetId), data);
      queryClient.invalidateQueries({ queryKey: datasetKeys.qualitySchedule(datasetId) });
    },
  });
}

// ===== AI Quality Rule Suggestion =====

export interface QualityAISuggestRequest {
  description: string;
  table_name: string;
  columns: { name: string; type: string }[];
}

export interface QualityAISuggestResponse {
  rule_type: string;
  dimension: string;
  column_name?: string | null;
  config?: QualityRuleConfig | null;
  severity: string;
  name: string;
  explanation: string;
}

export function useAISuggestQualityRule(datasetId: number) {
  return useMutation({
    mutationFn: async (body: QualityAISuggestRequest) => {
      const res = await api.post<QualityAISuggestResponse>(
        `/datasets/${datasetId}/quality/ai-suggest`,
        body,
      );
      return res.data;
    },
  });
}
