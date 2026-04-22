import type { Dashboard } from '@/types/api';

export type DashboardHtmlImportSourceMode = 'existing_dataset' | 'upload_excel';
export type DashboardHtmlImportTargetMode = 'new_dashboard' | 'append_to_dashboard';

export interface DashboardHtmlImportSourceColumn {
  name: string;
  type: string;
  tokens?: string[];
}

export interface DashboardHtmlImportSourceProfile {
  source_mode: DashboardHtmlImportSourceMode;
  dataset_id?: number | null;
  dataset_name?: string | null;
  dataset_table_id?: number | null;
  dataset_table_name?: string | null;
  uploaded_filename?: string | null;
  available_sheets?: string[];
  selected_sheet_name?: string | null;
  row_count?: number | null;
  columns: DashboardHtmlImportSourceColumn[];
  numeric_columns: string[];
  date_columns: string[];
  dimension_columns: string[];
  sample_rows: Array<Record<string, any>>;
}

export interface DashboardHtmlImportSheetData {
  columns: Array<{ name: string; type: string }>;
  rows: Array<Record<string, any>>;
}

export interface DashboardHtmlImportSourcePreviewResponse {
  filename?: string | null;
  default_sheet_name: string;
  sheets: Record<string, DashboardHtmlImportSheetData>;
}

export interface DashboardHtmlImportAiMeta {
  requested?: boolean;
  applied?: boolean;
  status?: string;
  provider?: string | null;
  model?: string | null;
  message?: string | null;
}

export interface DashboardHtmlImportChartPlan {
  block_id: string;
  order: number;
  title: string;
  block_role?: string | null;
  source_excerpt?: string | null;
  original_chart_type?: string | null;
  requested_chart_type?: string | null;
  final_chart_type: string;
  changed_chart_type: boolean;
  conversion_note?: string | null;
  rationale?: string | null;
  confidence: number;
  size_hint: string;
  source_fields_used: string[];
  warnings: string[];
  role_config: Record<string, any>;
  style_config?: Record<string, any>;
  source_key?: string | null;
  layout?: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  // ── Manual-edit extensions (written by HtmlImportChartEditor) ────────────
  // These propagate to _build_chart_config and validate_chart_plans.
  query_mode?: 'generated' | 'custom' | null;
  custom_sql?: string | null;
  custom_role_config?: Record<string, any> | null;
  base_filters?: Array<Record<string, any>> | null;
  chart_name?: string | null;
  chart_description?: string | null;
  // Absolute dataset_table_id override when user switched tables inside
  // the editor (only valid inside the active dataset).
  dataset_table_id_override?: number | null;
  // UI hint — set when user has manually edited this plan so we can show a badge.
  manually_edited?: boolean;
}

export interface DashboardHtmlImportCalculatedField {
  name: string;
  expression: string;
  label?: string | null;
  source_key?: string | null;
}

export interface DashboardHtmlImportAnalyzeResponse {
  suggested_dashboard_name: string;
  document_title?: string | null;
  source_profile: DashboardHtmlImportSourceProfile;
  all_source_profiles?: Record<string, DashboardHtmlImportSourceProfile> | null;
  derived_tables?: Array<Record<string, any>> | null;
  chart_plans: DashboardHtmlImportChartPlan[];
  calculated_fields?: DashboardHtmlImportCalculatedField[];
  ignored_blocks: Array<Record<string, any>>;
  warnings: string[];
  ai_meta: DashboardHtmlImportAiMeta;
}

export interface DashboardHtmlImportTypeChange {
  block_id?: string | null;
  title?: string | null;
  from?: string | null;
  to?: string | null;
  note?: string | null;
}

export interface DashboardHtmlImportBuildResponse {
  dashboard: Dashboard;
  dashboard_id: number;
  created_chart_count: number;
  type_changes: DashboardHtmlImportTypeChange[];
  page_id: string;
  page_name: string;
  dataset_id?: number | null;
  dataset_table_id?: number | null;
  dataset_table_ids?: Record<string, number> | null;
}

export interface DashboardHtmlImportAnalyzeInput {
  htmlContent: string;
  htmlSummary: Record<string, any>;
  sourceMode: DashboardHtmlImportSourceMode;
  datasetId?: number | null;
  datasetTableId?: number | null;
  selectedSheetName?: string | null;
  selectedSourceKey?: string | null;
  excelFile?: File | null;
  excelFiles?: File[];
}

export interface DashboardHtmlImportBuildInput {
  analysis: DashboardHtmlImportAnalyzeResponse;
  sourceMode: DashboardHtmlImportSourceMode;
  targetMode: DashboardHtmlImportTargetMode;
  dashboardName?: string;
  datasetId?: number | null;
  datasetTableId?: number | null;
  preparedDatasetId?: number | null;
  selectedSheetName?: string | null;
  targetDashboardId?: number | null;
  includedBlockIds: string[];
  excelFile?: File | null;
  excelFiles?: File[];
}

export interface DashboardHtmlImportPrepareDraftInput {
  sourceMode: DashboardHtmlImportSourceMode;
  dashboardName?: string | null;
  datasetId?: number | null;
  excelFile?: File | null;
  excelFiles?: File[];
}

export interface DashboardHtmlImportPrepareDraftResponse {
  dataset_id: number;
  is_draft: boolean;
  table_id_map: Record<string, number>;
}

export interface DashboardHtmlSummaryBlock {
  id: string;
  order: number;
  tag: string;
  role?: string;
  heading?: string;
  text?: string;
  classes?: string[];
  id_attr?: string;
  style?: string;
  table?: {
    headers: string[];
    rows: string[][];
  } | null;
}

// ── Validation & AI fix ──────────────────────────────────────────────────────

export interface DashboardHtmlImportValidationResult {
  block_id: string;
  status: 'ok' | 'error';
  error: string | null;
}

export interface DashboardHtmlImportValidateResponse {
  results: DashboardHtmlImportValidationResult[];
}

export interface DashboardHtmlImportValidateInput {
  analysis: DashboardHtmlImportAnalyzeResponse;
  datasetId: number;
}

export interface DashboardHtmlImportFixChartInput {
  chartPlan: DashboardHtmlImportChartPlan;
  errorMessage: string;
  sourceProfile: DashboardHtmlImportSourceProfile;
  allSourceProfiles?: Record<string, DashboardHtmlImportSourceProfile> | null;
  derivedTables?: Array<Record<string, any>> | null;
  datasetId?: number | null;
  calculatedFields?: DashboardHtmlImportCalculatedField[] | null;
}

export interface DashboardHtmlImportFixChartsInput {
  chartPlans: DashboardHtmlImportChartPlan[];
  validationResults: Record<string, DashboardHtmlImportValidationResult>;
  sourceProfile: DashboardHtmlImportSourceProfile;
  allSourceProfiles?: Record<string, DashboardHtmlImportSourceProfile> | null;
}

export interface DashboardHtmlImportFixChartResponse {
  fixed_plan: DashboardHtmlImportChartPlan & { fix_note?: string };
}

export interface DashboardHtmlImportCalculatedFieldError {
  name: string;
  error: string;
}

export interface DashboardHtmlImportPreviewCalculatedInput {
  sampleRows: Array<Record<string, unknown>>;
  columns: Array<{ name: string; type: string }>;
  calculatedFields: DashboardHtmlImportCalculatedField[];
  rowLimit?: number;
}

export interface DashboardHtmlImportPreviewCalculatedResponse {
  columns: Array<{ name: string; type: string }>;
  rows: Array<Record<string, unknown>>;
  errors: DashboardHtmlImportCalculatedFieldError[];
}

export interface DashboardHtmlSummary {
  title: string;
  blocks: DashboardHtmlSummaryBlock[];
}
