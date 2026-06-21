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

export interface TableHyperlinkRule {
  id?: string;
  targetColumn: string;
  /** Column whose value already holds a ready-made URL. Provide this OR urlTemplate. */
  urlColumn?: string;
  /**
   * BUG-006 — URL template with {column} tokens, e.g.
   * "https://crm.example.com/deals/{deal_id}". Token values are read from the
   * row and URL-encoded. Lets a column (e.g. deal_id) link out even when the
   * dataset has no column already containing a full URL. Takes precedence over
   * urlColumn when set to a non-empty string.
   */
  urlTemplate?: string;
  openInNewTab?: boolean;
}

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
  DONUT = 'DONUT',
  RADAR = 'RADAR',
  POLAR_AREA = 'POLAR_AREA',
  TIME_SERIES = 'TIME_SERIES',
  TABLE = 'TABLE',
  MATRIX = 'MATRIX',
  AREA = 'AREA',
  STACKED_BAR = 'STACKED_BAR',
  GROUPED_BAR = 'GROUPED_BAR',
  BAR_LINE = 'BAR_LINE',
  SCATTER = 'SCATTER',
  BUBBLE = 'BUBBLE',
  HEATMAP = 'HEATMAP',
  TREEMAP = 'TREEMAP',
  FUNNEL = 'FUNNEL',
  GAUGE = 'GAUGE',
  WATERFALL = 'WATERFALL',
  MAP_POINT = 'MAP_POINT',
  MAP_REGION = 'MAP_REGION',
  BOXPLOT = 'BOXPLOT',
  BULLET = 'BULLET',
  SANKEY = 'SANKEY',
  SUNBURST = 'SUNBURST',
  RIBBON = 'RIBBON',
  TIMELINE = 'TIMELINE',
  WORD_CLOUD = 'WORD_CLOUD',
  KPI = 'KPI',
  PODIUM = 'PODIUM',
}

export type DashboardLayoutMode = 'grid' | 'canvas';

export type DashboardWidgetType =
  | 'chart'
  | 'text'
  | 'countdown'
  | 'image'
  | 'shape'
  | 'parameter_switcher';

export interface DashboardThemeConfig {
  mode?: 'light' | 'dark';
  accent?: string;
  font?: string;
  fontFamily?: string;
  cardStyle?: 'soft' | 'sharp' | 'flat' | 'elevated';
  background?: string;
  backgroundColor?: string;
  density?: 'compact' | 'normal' | 'comfortable' | 'spacious';
  cardRadius?: number | string;
  radius?: number | string;
  /** Phase-B14 — card border thickness (px) + color for dashboard tiles. */
  cardBorderWidth?: number | string;
  cardBorderColor?: string;
  cardShadow?: string | boolean;
  /** Phase-B15 — PBI-style personalization.
   *  Colors */
  dataColors?: string[];          // series/data palette for all charts
  goodColor?: string;             // status: positive
  neutralColor?: string;          // status: neutral
  badColor?: string;              // status: negative
  /** Text */
  titleFontSize?: number | string;   // chart/tile title
  titleColor?: string;
  labelFontSize?: number | string;   // axis/data labels
  kpiFontSize?: number | string;     // KPI value
  /** Structural (charts) */
  gridlineColor?: string;
  axisLabelColor?: string;
  /** Phase-B16 — report background image (data-URL) + readability controls.
   *  Charts render ON TOP of the image. */
  backgroundImage?: string;       // data:image/...;base64,... (downscaled)
  backgroundSize?: string;        // default 'cover'
  backgroundPosition?: string;    // default 'center'
  bgOverlay?: number;             // 0..1 scrim over the image for legibility
  glassCards?: boolean;           // translucent tiles so the image shows through
  /** Phase-B16 — id of the applied built-in preset (for highlighting). */
  presetId?: string;
  hoverAnimation?: 'none' | 'lift' | 'scale' | 'glow' | string;
  hoverEffect?: string;
  [k: string]: any;
}

export interface DashboardCanvasConfig {
  width?: number;
  height?: number;
  snap?: number;
  background?: string;
  [k: string]: any;
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
  /** Optional human-readable display label sourced from the dataset model
   *  (semantic dimension/measure label or column dictionary). When absent,
   *  UIs should fall back to `name`. */
  label?: string;
  fieldKind?: 'source' | 'calculated' | 'dimension' | 'measure' | 'date';
  sourceKind?: 'source' | 'calculated' | 'semantic' | 'custom';
  viewName?: string;
  viewLabel?: string;
  tableId?: number;
  tableLabel?: string;
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
  reachableViews?: string[];
  reachableDimensionFields?: string[];
  reachableMeasureFields?: string[];
  reachableFields?: string[];
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
  dataset_id?: number | null;
  dataset_name?: string | null;
  dataset_table_name?: string | null;
  datasource_id?: number | null;
  chart_type: ChartType;
  config: ChartConfig;
  owner_id?: string;
  owner_email?: string;
  user_permission?: 'none' | 'view' | 'edit' | 'full';
  is_owned_by_current_user?: boolean;
  is_shared?: boolean;
  created_at: string;
  updated_at: string;
  metadata?: ChartMetadata | null;
  parameters?: ChartParameter[];
}

export type ChartListScope = 'all' | 'mine' | 'shared';
export type ChartListSort =
  | 'updated_desc'
  | 'created_desc'
  | 'name_asc'
  | 'name_desc'
  | 'relevance';

export interface ChartListParams {
  skip?: number;
  limit?: number;
  q?: string;
  chart_type?: ChartType | string;
  scope?: ChartListScope;
  sort?: ChartListSort;
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

export interface ChartConfigChange {
  path: string;
  before: any;
  after: any;
  reason: string;
}

export interface ChartDryRunCreateRequest {
  name: string;
  chart_type: ChartType | string;
  dataset_table_id: number;
  config: ChartConfig | Record<string, any>;
  description?: string | null;
}

export interface ChartDryRunCreateResponse {
  ok: boolean;
  normalized_config: ChartConfig | Record<string, any>;
  changes?: ChartConfigChange[];
  validation_errors?: string[];
  semantic_warnings?: string[];
  runtime_errors?: string[];
  runtime_root_cause?: string | null;
  runtime_preview_sample?: Record<string, any>[] | null;
  fe_unrecognised_keys?: string[];
}

export interface DashboardChartLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  custom_title?: string;
  pageId?: string | null;
  styleConfigOverride?: Record<string, any> | null;
  /** Phase-15.81 — PowerBI-style "Filters on this visual" scope. Stored on
   *  the tile's layout JSON so other dashboards using the same chart keep
   *  their own per-visual filter (mirrors the styleConfigOverride pattern).
   *  Sent into chart-data API as extra_filters at runtime. */
  tileFilters?: any[];
  /** Per-chart cross-highlight opt-out (default ON / undefined = on). When
   *  false, the tile neither emits click-highlights nor reacts as a target.
   *  Toggled from the tile's ⋯ menu. */
  highlightEnabled?: boolean;
  // Canvas-mode geometry (px). Stored alongside grid coords so toggling modes
  // never loses cell positions.
  xPx?: number;
  yPx?: number;
  wPx?: number;
  hPx?: number;
  z?: number;
}

export interface DashboardPageConfig {
  id: string;
  name: string;
  /** Phase-15.81 — PowerBI-style "Filters on this page" scope. Filters
   *  applied to every chart on this page. Stored as legacy BaseFilter[]
   *  to match the chart-data API contract. BE passes through (pages_config
   *  is arbitrary JSON), no schema change needed server-side. */
  filters?: any[];
}

// NOTE: chart_id is typed as `number` for backward-compat with the ~25 call
// sites that assume a chart row. The backend allows null for non-chart
// widgets (added in commit 1); when widget code lands, narrow via
// `widget_type !== 'chart'` and treat chart_id as optional in those branches.
// See NOTES_DASHBOARD_UPGRADE.md.
export interface DashboardChart {
  id: number;
  chart_id: number;
  layout: DashboardChartLayout;
  chart: Chart;
  parameters?: Record<string, any> | null;
  widget_type?: DashboardWidgetType;
  widget_config?: Record<string, any> | null;
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
  /** Custom report logo shown in the public/embed header instead of the
   *  auto-generated brand mark. A URL or a data: URI (uploaded image). */
  logo_url?: string | null;
  summary?: string | null;
  footer_note?: string | null;
  show_summary?: boolean;
  show_stats?: boolean;
  show_page_tabs?: boolean;
  allow_viewer_filters?: boolean;
  show_footer?: boolean;
  show_chart_type_label?: boolean;
  ai_bot_enabled?: boolean;
  /** Admin-configured AI provider for this link (e.g. "openai", "anthropic", "gemini"). */
  ai_bot_provider?: string;
  /** Admin-configured model id (e.g. "gpt-4o", "claude-sonnet-4-6"). */
  ai_bot_model?: string;
  /** Max spend per normal question on this public link. */
  ai_bot_normal_cost_cap_usd?: number | null;
  /** Max spend per thinking/deep-analysis question on this public link. */
  ai_bot_thinking_cost_cap_usd?: number | null;
  /**
   * Short internal note injected into the AI prompt so the bot keeps the
   * right lens for this report. This is admin-authored configuration.
   */
  ai_bot_report_context_note?: string | null;
  /**
   * Admin-configured API key. Written via the authenticated admin API.
   * The public API NEVER returns this field — it strips it and sets
   * `ai_bot_key_configured: true` instead.
   */
  ai_bot_key?: string;
  /**
   * Read-only, public-safe flag. True when the admin has pre-configured an
   * API key for this link so public viewers don't need to enter one.
   */
  ai_bot_key_configured?: boolean;
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
  last_published_at?: string | null;  // Phase-B17 optimistic-concurrency version
  dashboard_charts: DashboardChart[];
  filters_config?: any[]; // Dashboard-level filters (hybrid v1)
  /** Phase-15.81 — public viewer's top-bar slicer set. BE serves
   *  dashboard.filters_config (all-pages set from editor FilterPane)
   *  through this field on the /public/dashboards/{token} response.
   *  Viewers see + edit values; per-link hidden filters live in
   *  public_link_hidden_filters instead. */
  public_filters_config?: any[];
  /** Phase-15.81 — hidden constraints baked into THIS public link.
   *  Set in the Public Links modal per-link. Viewer never sees these;
   *  FE merges them silently into every chart-data request alongside
   *  top-bar filters. */
  public_link_hidden_filters?: any[];
  pages_config?: DashboardPageConfig[];
  available_filter_fields?: DashboardFilterField[];
  public_link_name?: string | null;
  public_link_appearance?: PublicLinkAppearanceConfig | null;
  layout_mode?: DashboardLayoutMode;
  theme_config?: DashboardThemeConfig | null;
  canvas_config?: DashboardCanvasConfig | null;
  // Phase-15.56 — draft layout overlay. When `has_draft` is true, the
  // editor renders `draft_layouts[dashboard_chart_id]` instead of the
  // live `layout` on each DashboardChart. Public viewers never see
  // these fields — public endpoint strips them.
  draft_layouts?: Record<number, Record<string, any>> | null;
  has_draft?: boolean;
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
  layout_mode?: DashboardLayoutMode;
  theme_config?: DashboardThemeConfig | null;
  canvas_config?: DashboardCanvasConfig | null;
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

/** Phase-15.78 — one entry per runtime filter the BE dropped before SQL. */
export interface DroppedFilterInfo {
  field?: string | null;
  semantic_field?: string | null;
  operator?: string | null;
  /** machine-readable: 'dataset_mismatch' | 'binding_unsupported'
   *  | 'unreachable_view' | 'unknown_operator' | 'empty_value' | 'no_field' */
  reason: string;
  detail?: string | null;
}

/** Phase-15.9 — debug payload surfaced in the Explore "Query" tab. */
export interface ChartDebugInfo {
  sql_emitted?: string | null;
  dialect?: string | null;
  routing?: string | null;
  execution_time_ms?: number | null;
  row_count?: number | null;
  warnings?: string[];
  /** Phase-15.78 — filters the BE dropped (e.g. field not in this chart's binding). */
  dropped_filters?: DroppedFilterInfo[];
}

export interface ChartDataResponse {
  chart: Chart;
  data: Record<string, any>[];
  pre_aggregated?: boolean;
  /** Phase-3b: ambiguous-path / N:N warnings surfaced from the semantic engine. */
  warnings?: string[];
  /** Phase-15.9: debug payload, omitted on cache hits / older clients. */
  debug?: ChartDebugInfo;
  meta?: {
    row_count?: number;
    execution_time_ms?: number;
  };
}

export interface ChartPreviewDataRequest {
  dataset_table_id: number;
  chart_type: string;
  config: Record<string, any>;
  filters?: Record<string, unknown>[];
  context?: ChartDataContext;
  include_source_sample?: boolean;
  source_sample_limit?: number;
}

export interface ChartPreviewDataResponse {
  data: Record<string, any>[];
  pre_aggregated?: boolean;
  execution_time_ms?: number;
  /** Phase-3b: warnings from the semantic engine (also returned by preview). */
  warnings?: string[];
  /** Same BE-side runtime metadata shape as saved chart data. */
  debug?: ChartDebugInfo;
  source_columns?: string[];
  source_rows?: Record<string, any>[];
}
