/**
 * TypeScript types matching the backend schemas.
 */

// Explore 2.0: Aggregation functions
export type AggregationFn = 'sum' | 'avg' | 'count' | 'min' | 'max';

// Explore 2.0: Dimension configuration with rename/alias
export interface DimensionConfig {
  field: string; // Technical column name
  label?: string; // Display name (optional)
}

// Explore 2.0: Measure configuration with rename/alias
export interface MeasureConfig {
  field: string; // Technical column name
  agg: AggregationFn;
  label?: string; // Display name (optional)
}

// Explore 2.0: Sort configuration
export interface SortConfig {
  field: string;
  direction: 'asc' | 'desc';
  index: number; // Priority: 0 = highest
}

// Explore 2.0: Conditional formatting rule
export interface ConditionalFormatRule {
  field: string;
  operator: '>' | '<' | '=' | '>=' | '<=' | '!=';
  value: number | string;
  color?: string; // Text color
  backgroundColor?: string; // Background color
}

// Explore 2.0: Grouping configuration
export interface GroupingConfig {
  rowDimensions: string[]; // Dimensions for rows
  columnDimension?: string; // Optional dimension for pivot columns
}

export enum DataSourceType {
  POSTGRESQL = 'postgresql',
  MYSQL = 'mysql',
  BIGQUERY = 'bigquery',
  GOOGLE_SHEETS = 'google_sheets',
  MANUAL = 'manual',
}

export enum ChartType {
  BAR = 'BAR',
  LINE = 'LINE',
  PIE = 'PIE',
  TIME_SERIES = 'TIME_SERIES',
  TABLE = 'TABLE',
  AREA = 'AREA',
  STACKED_BAR = 'STACKED_BAR',
  GROUPED_BAR = 'GROUPED_BAR',
  SCATTER = 'SCATTER',
  KPI = 'KPI',
}

export interface DataSource {
  id: number;
  name: string;
  type: DataSourceType;
  description?: string;
  config: Record<string, any>;
  owner_id?: string;
  owner_email?: string;
  user_permission?: 'none' | 'view' | 'edit' | 'full';
  created_at: string;
  updated_at: string;
}

export interface DataSourceCreate {
  name: string;
  type: DataSourceType;
  description?: string;
  config: Record<string, any>;
}

export interface DataSourceUpdate {
  name?: string;
  description?: string;
  config?: Record<string, any>;
}

// ── Schema Browser ─────────────────────────────────────────────────────────

export interface SchemaTableEntry {
  name: string;
  type: 'table' | 'view' | 'materialized_view' | 'other';
  row_count: number | null;
  size_bytes: number | null;
}

export interface SchemaEntry {
  schema: string;
  tables: SchemaTableEntry[];
}

export interface SchemaResponse {
  schemas: SchemaEntry[];
}

export interface TableColumn {
  name: string;
  type: string;
  nullable: boolean;
  is_primary_key: boolean;
  is_foreign_key: boolean;
  has_index: boolean;
}

export interface TableDetail {
  schema: string;
  name: string;
  type: string;
  row_count: number | null;
  size_bytes: number | null;
  columns: TableColumn[];
  preview: Record<string, any>[];
}

export interface WatermarkColumn {
  name: string;
  type: string;
}

// ── Sync Config ────────────────────────────────────────────────────────────

export type SyncStrategyType = 'full_refresh' | 'incremental' | 'append_only' | 'manual';
export type ScheduleType = 'interval' | 'daily' | 'custom_cron';

export interface SyncScheduleConfig {
  enabled: boolean;
  type: ScheduleType;
  interval_hours?: number;
  interval_seconds?: number;
  time?: string;       // "HH:MM" for daily
  timezone?: string;
  cron?: string;
  cron_expression?: string;
}

export interface SyncTableConfig {
  enabled: boolean;
  strategy: SyncStrategyType;
  watermark_column?: string;
  rows_cached?: number;
}

export interface SyncRetryConfig {
  max_attempts: number;
  backoff_interval: string; // "5m" | "15m" | "30m" | "1h"
}

export interface SyncNotificationConfig {
  email_on_failure: boolean;
  webhook_url?: string;
}

export interface SyncConfig {
  mode?: 'full_refresh' | 'incremental' | 'append_only' | 'manual';
  schedule?: SyncScheduleConfig;
  tables?: Record<string, SyncTableConfig>;   // key = "schema.table"
  retry?: SyncRetryConfig;
  notification?: SyncNotificationConfig;
  watermark_column?: string;
  incremental?: Record<string, any>;
}

// ── Sync Jobs ──────────────────────────────────────────────────────────────

export interface SyncJob {
  id: number;
  status: 'running' | 'success' | 'failed' | 'timeout';
  mode: string;
  started_at: string;
  finished_at: string | null;
  duration_seconds: number | null;
  rows_synced: number | null;
  rows_failed: number | null;
  error_message: string | null;
  triggered_by: string | null;
}

export interface ColumnMetadata {
  name: string;
  type: string;
}

// Dataset Transformations v2 (Power Query-style)
export type TransformationType =
  // Column selection & rename
  | 'select_columns'
  | 'rename_columns'
  | 'remove_columns'
  | 'duplicate_column'
  // Column create & compute
  | 'add_column'
  // Type & value transformations
  | 'cast_column'
  | 'replace_value'
  | 'replace_regex'
  | 'fill_null'
  | 'trim'
  | 'lowercase'
  | 'uppercase'
  // Text split / merge
  | 'split_column'
  | 'merge_columns'
  // Row filtering & sorting
  | 'filter_rows'
  | 'sort'
  | 'limit'
  // Dedup & sampling
  | 'remove_duplicates'
  | 'sample_rows'
  // Aggregation
  | 'group_by'
  // Join
  | 'join_dataset';

export interface TransformationStep {
  id: string;
  type: TransformationType;
  enabled: boolean;
  name?: string; // User-editable label
  params: Record<string, any>;
  meta?: {
    createdAt?: string;
    updatedAt?: string;
  };
}

// Materialization configuration
export interface MaterializationConfig {
  mode: 'none' | 'view' | 'table' | 'parquet';
  name?: string;
  schema?: string;
  refresh?: {
    type: 'manual' | 'schedule';
    cron?: string;
    timezone?: string;
  };
  last_refreshed_at?: string;
  status?: 'idle' | 'running' | 'failed';
  error?: string;
}

export interface SyncJobRun {
  id: number;
  mode: string;
  status: 'running' | 'success' | 'failed';
  rows_pulled?: number;
  duration_seconds?: number;
  error?: string;
  started_at?: string;
  finished_at?: string;
}

export interface ChartConfig {
  // Legacy field arrays (backward compatibility)
  dimensions?: string[];
  measures?: string[];
  
  // Explore 2.0: Preferred configs with rename/alias support
  dimension_configs?: DimensionConfig[];
  measure_configs?: MeasureConfig[];
  
  filters?: any[];
  xField?: string;
  yFields?: string[];
  labelField?: string;
  valueField?: string;
  timeField?: string;
  title?: string;
  
  // Color configuration
  color?: string; // Single color for PIE, KPI
  series_colors?: Record<string, string>; // Per-series colors: { "sales": "#ff0000" }
  colors?: string[]; // Deprecated: legacy color array
  
  // Theme and palette
  palette?: string; // Named palette: 'default' | 'vibrant' | 'classic' | 'monochrome' | 'pastel'
  color_by_dimension?: string; // Dimension name for color mapping
  
  // Explore 2.0: Advanced features
  grouping?: GroupingConfig; // Grouping and pivot configuration
  sorts?: SortConfig[]; // Multi-column sorting
  conditional_formatting?: ConditionalFormatRule[]; // Table cell formatting
  
  [key: string]: any; // Allow additional fields
}

export interface Chart {
  id: number;
  name: string;
  description?: string;
  workspace_table_id?: number | null;
  chart_type: ChartType;
  config: ChartConfig;
  owner_id?: string;
  owner_email?: string;
  user_permission?: 'none' | 'view' | 'edit' | 'full';
  created_at: string;
  updated_at: string;
  metadata?: ChartMetadata | null;
  parameters?: ChartParameter[];
}

export interface ChartCreate {
  name: string;
  description?: string;
  workspace_table_id?: number | null;
  chart_type: ChartType;
  config: ChartConfig;
}

export interface ChartUpdate {
  name?: string;
  description?: string | null;
  chart_type?: ChartType;
  config?: ChartConfig;
  workspace_table_id?: number | null;
}

export interface DashboardChartLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  custom_title?: string;
}

export interface DashboardChart {
  id: number;
  chart_id: number;
  layout: DashboardChartLayout;
  chart: Chart;
  parameters?: Record<string, any> | null;
}

// --- Chart Metadata (semantic/business layer) ---
export interface ChartMetadata {
  id: number;
  chart_id: number;
  domain?: string | null;     // sales / marketing / finance / operations
  intent?: string | null;     // trend / comparison / ranking / summary
  metrics?: string[];         // business metric names (semantic labels)
  dimensions?: string[];      // business dimension names
  tags?: string[];            // free-form tags
  created_at: string;
  updated_at: string;
}

export interface ChartMetadataUpsert {
  domain?: string | null;
  intent?: string | null;
  metrics?: string[];
  dimensions?: string[];
  tags?: string[];
}

// --- Chart Parameters (template capability definitions) ---
export type ChartParameterType = 'time_range' | 'dimension' | 'measure';

export interface ChartParameterColumnMapping {
  column: string;   // actual dataset column name
  type: string;     // 'date' | 'string' | 'number'
}

export interface ChartParameter {
  id: number;
  chart_id: number;
  parameter_name: string;     // e.g. 'date_range', 'region'
  parameter_type: ChartParameterType;
  column_mapping?: ChartParameterColumnMapping | null;
  default_value?: string | null;
  description?: string | null;
  created_at: string;
}

export interface ChartParameterCreate {
  parameter_name: string;
  parameter_type: ChartParameterType;
  column_mapping?: ChartParameterColumnMapping | null;
  default_value?: string | null;
  description?: string | null;
}

export interface Dashboard {
  id: number;
  name: string;
  description?: string;
  owner_id?: string;
  owner_email?: string;
  user_permission?: 'none' | 'view' | 'edit' | 'full';
  share_token?: string | null;
  created_at: string;
  updated_at: string;
  dashboard_charts: DashboardChart[];
  filters_config?: any[]; // Dashboard-level filters (hybrid v1)
}

export interface DashboardCreate {
  name: string;
  description?: string;
  charts?: Array<{
    chart_id: number;
    layout: DashboardChartLayout;
    parameters?: Record<string, any>;
  }>;
}

export interface DashboardUpdate {
  name?: string;
  description?: string;
  filters_config?: any[];
}

export interface QueryExecuteRequest {
  data_source_id: number;
  sql_query: string;
  limit?: number;
}

export interface QueryExecuteResponse {
  columns: string[];
  data: Record<string, any>[];
  row_count: number;
  execution_time_ms: number;
}

export interface ChartDataResponse {
  chart: Chart;
  data: Record<string, any>[];
  pre_aggregated?: boolean;
  meta?: {
    row_count?: number;
    execution_time_ms?: number;
  };
}
