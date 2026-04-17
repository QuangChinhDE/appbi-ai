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
  value?: number | string;
  benchmarkField?: string;
  color?: string; // Text color
  backgroundColor?: string; // Background color
}

export interface TableHeatmapRule {
  field: string;
  steps?: number;
  minColor?: string;
  maxColor?: string;
}

export type TableColumnAlignment = 'left' | 'center' | 'right';

export type TableSummaryCalculation =
  | 'sum'
  | 'avg'
  | 'count'
  | 'min'
  | 'max'
  | 'count_distinct';

export interface TableSummaryRowConfig {
  label: string;
  calculation: TableSummaryCalculation;
  columns?: string[];
  labelColumn?: string;
}

export type ChartBenchmarkLineStyle = 'solid' | 'dashed';
export type KpiGoalDirection = 'up' | 'down';

// Chart-level sort rule (applied client-side before rendering)
export interface ChartSortRule {
  field: string;
  direction: 'asc' | 'desc';
}

// Time granularity for TIME_SERIES charts
export type TimeGranularity = 'raw' | 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface KpiValueColorRule {
  operator: '>' | '<' | '=' | '>=' | '<=' | '!=';
  value: number;
  color: string;
  label?: string;
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
  HORIZONTAL_BAR = 'HORIZONTAL_BAR',
  LINE = 'LINE',
  PIE = 'PIE',
  TIME_SERIES = 'TIME_SERIES',
  TABLE = 'TABLE',
  AREA = 'AREA',
  STACKED_BAR = 'STACKED_BAR',
  GROUPED_BAR = 'GROUPED_BAR',
  BAR_LINE = 'BAR_LINE',
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

export interface ChartConfig {
  // Legacy field arrays (backward compatibility)
  dimensions?: string[];
  measures?: string[];
  
  // Explore 2.0: Preferred configs with rename/alias support
  dimension_configs?: DimensionConfig[];
  measure_configs?: MeasureConfig[];
  
  filters?: any[];
  baseFilters?: any[];
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
  semanticBinding?: ChartSemanticBinding;
  
  [key: string]: any; // Allow additional fields
}

export interface ChartSemanticBinding {
  status: 'partial' | 'resolved';
  datasetId: number;
  datasetTableId: number;
  modelId?: number | null;
  exploreId?: number | null;
  exploreName?: string | null;
  baseViewId?: number | null;
  baseViewName?: string | null;
  fieldMap?: Record<string, string>;
  dimensionFields?: string[];
  measureFields?: string[];
  calendarFieldMappings?: Array<{
    semanticField: string;
    sourceField: string;
    calendarField: string;
  }>;
}

export interface Chart {
  id: number;
  name: string;
  description?: string;
  dataset_table_id?: number | null;
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
  dataset_table_id?: number | null;
  chart_type: ChartType;
  config: ChartConfig;
}

export interface ChartUpdate {
  name?: string;
  description?: string | null;
  chart_type?: ChartType;
  config?: ChartConfig;
  dataset_table_id?: number | null;
}

export interface DashboardChartLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  custom_title?: string;
  pageId?: string | null;
  styleConfigOverride?: Record<string, any> | null;
}

export interface DashboardPageConfig {
  id: string;
  name: string;
}

export interface DashboardChart {
  id: number;
  chart_id: number;
  layout: DashboardChartLayout;
  chart: Chart;
  parameters?: Record<string, any> | null;
}

export interface DashboardFilterField {
  name: string;
  type: 'text' | 'number' | 'date' | 'dropdown';
  key?: string;
  label?: string;
  datasetId?: number;
  semanticField?: string;
  chartCoverage?: number;
  datasetChartCount?: number;
  sharedAcrossDataset?: boolean;
}

export interface PublicLinkAppearanceConfig {
  preset?: 'briefing' | 'editorial' | 'minimal';
  accent_preset?: 'sky' | 'teal' | 'amber' | 'rose' | 'slate';
  accent_color?: string | null;
  density?: 'comfortable' | 'compact';
  canvas_style?: 'soft' | 'grid' | 'plain';
  embed_header_mode?: 'full' | 'compact' | 'hidden';
  hero_label?: string | null;
  headline?: string | null;
  summary?: string | null;
  footer_note?: string | null;
  show_summary?: boolean;
  show_stats?: boolean;
  show_page_tabs?: boolean;
  allow_viewer_filters?: boolean;
  show_footer?: boolean;
  show_chart_type_label?: boolean;
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
  public_filters_config?: any[];
  pages_config?: DashboardPageConfig[];
  available_filter_fields?: DashboardFilterField[];
  public_link_name?: string | null;
  public_link_appearance?: PublicLinkAppearanceConfig | null;
}

export interface DashboardCreate {
  name: string;
  description?: string;
  pages_config?: DashboardPageConfig[];
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
  public_filters_config?: any[];
  pages_config?: DashboardPageConfig[];
}

export interface QueryExecuteRequest {
  data_source_id: number;
  sql_query: string;
  limit?: number;
  timeout_seconds?: number;
}

export interface QueryExecuteResponse {
  columns: string[];
  data: Record<string, any>[];
  row_count: number;
  execution_time_ms: number;
}

export type ChartDataContext = 'default' | 'dashboard';

export interface ChartDataResponse {
  chart: Chart;
  data: Record<string, any>[];
  pre_aggregated?: boolean;
  meta?: {
    row_count?: number;
    execution_time_ms?: number;
  };
}

export interface ChartPreviewDataRequest {
  dataset_table_id: number;
  chart_type: string;
  config: Record<string, any>;
  context?: ChartDataContext;
  include_source_sample?: boolean;
  source_sample_limit?: number;
}

export interface ChartPreviewDataResponse {
  data: Record<string, any>[];
  pre_aggregated?: boolean;
  execution_time_ms?: number;
  source_columns?: string[];
  source_rows?: Record<string, any>[];
}
