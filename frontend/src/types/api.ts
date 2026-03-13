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
  mode: 'none' | 'view' | 'table';
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

export interface Dataset {
  id: number;
  name: string;
  description?: string;
  data_source_id: number;
  sql_query: string;
  columns?: ColumnMetadata[];
  transformations?: TransformationStep[];
  transformation_version?: number;
  materialization?: MaterializationConfig;
  created_at: string;
  updated_at: string;
}

export interface DatasetCreate {
  name: string;
  description?: string;
  data_source_id: number;
  sql_query: string;
  transformations?: TransformationStep[];
  transformation_version?: number;
  materialization?: MaterializationConfig;
}

export interface DatasetUpdate {
  name?: string;
  description?: string;
  sql_query?: string;
  transformations?: TransformationStep[];
  transformation_version?: number;
  materialization?: MaterializationConfig;
}

// Preview request/response
export interface DatasetPreviewRequest {
  limit?: number;
  stop_at_step_id?: string;
  apply_transformations?: boolean;
}

export interface DatasetPreviewResponse {
  columns: ColumnMetadata[];
  data: Record<string, any>[];
  row_count: number;
  step_id?: string;
  compiled_sql?: string;
}

// Materialization request/response
export interface DatasetMaterializeRequest {
  mode: 'none' | 'view' | 'table';
  name?: string;
  schema?: string;
}

export interface DatasetMaterializeResponse {
  success: boolean;
  message: string;
  materialization: MaterializationConfig;
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
  dataset_id: number;
  chart_type: ChartType;
  config: ChartConfig;
  created_at: string;
  updated_at: string;
}

export interface ChartCreate {
  name: string;
  description?: string;
  dataset_id: number;
  chart_type: ChartType;
  config: ChartConfig;
}

export interface ChartUpdate {
  name?: string;
  description?: string;
  chart_type?: ChartType;
  config?: ChartConfig;
}

export interface DashboardChartLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardChart {
  id: number;
  chart_id: number;
  layout: Record<string, number>;
  chart: Chart;
}

export interface Dashboard {
  id: number;
  name: string;
  description?: string;
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
  }>;
}

export interface DashboardUpdate {
  name?: string;
  description?: string;
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

export interface DatasetExecuteResponse {
  columns: ColumnMetadata[];
  data: Record<string, any>[];
  row_count: number;
}

export interface ChartDataResponse {
  chart: Chart;
  data: Record<string, any>[];
}
