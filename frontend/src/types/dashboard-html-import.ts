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
  layout?: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
}

export interface DashboardHtmlImportAnalyzeResponse {
  suggested_dashboard_name: string;
  document_title?: string | null;
  source_profile: DashboardHtmlImportSourceProfile;
  chart_plans: DashboardHtmlImportChartPlan[];
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
}

export interface DashboardHtmlImportAnalyzeInput {
  htmlContent: string;
  htmlSummary: Record<string, any>;
  sourceMode: DashboardHtmlImportSourceMode;
  datasetTableId?: number | null;
  selectedSheetName?: string | null;
  excelFile?: File | null;
}

export interface DashboardHtmlImportBuildInput {
  analysis: DashboardHtmlImportAnalyzeResponse;
  sourceMode: DashboardHtmlImportSourceMode;
  targetMode: DashboardHtmlImportTargetMode;
  dashboardName?: string;
  datasetTableId?: number | null;
  selectedSheetName?: string | null;
  targetDashboardId?: number | null;
  includedBlockIds: string[];
  excelFile?: File | null;
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

export interface DashboardHtmlSummary {
  title: string;
  blocks: DashboardHtmlSummaryBlock[];
}
