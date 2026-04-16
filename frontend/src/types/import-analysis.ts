/**
 * Types for the Smart Import from Excel feature.
 */

export interface AnalysisHeaderLine {
  text: string;
  right_text?: string;
  align: 'left' | 'center' | 'right';
  bold: boolean;
  font_size: 'sm' | 'base' | 'lg' | 'xl';
}

export interface AnalysisTitleStyle {
  align?: 'left' | 'center' | 'right';
  bold?: boolean;
  font_size?: 'sm' | 'base' | 'lg' | 'xl';
}

export type AnalysisFooterLine = string | AnalysisHeaderLine;

export interface AnalysisColumnGroup {
  label: string;
  start_col_idx: number;
  span: number;
}

export interface AnalysisColumn {
  label: string;
  key: string;
  inferred_type: 'text' | 'integer' | 'decimal' | 'percentage' | 'date';
  width_px: number;
  align: 'left' | 'center' | 'right';
  format: 'integer' | 'decimal' | 'percentage' | 'text';
  suffix?: string;
  bold: boolean;
  highlight_negative: boolean;
  source_col_idx: number;
}

export interface AnalysisTableSchema {
  name: string;
  display_name: string;
  type: 'string' | 'number' | 'date';
}

export interface AnalysisTheme {
  header_bg: string;
  header_text: string;
  group_bg?: string;
  group_text?: string;
  subtotal_bg?: string;
  subtotal_text?: string;
  accent_color?: string;
}

export interface AnalysisAiAssist {
  requested: boolean;
  applied: boolean;
  status: 'not_requested' | 'applied' | 'unavailable' | 'unsupported' | 'failed';
  provider?: string;
  model?: string;
  message?: string;
}

export interface AnalysisResponse {
  file_token: string;
  header_lines: AnalysisHeaderLine[];
  report_title: string;
  report_title_style?: AnalysisTitleStyle;
  report_meta?: string;
  column_groups: AnalysisColumnGroup[];
  columns: AnalysisColumn[];
  group_by_column?: string;
  show_subtotals: boolean;
  footer_lines: AnalysisFooterLine[];
  signature_count: number;
  signature_labels: string[];
  theme: AnalysisTheme;
  recommended_table_schema: AnalysisTableSchema[];
  data_preview: Record<string, any>[];
  total_data_rows: number;
  confidence: number;
  sheet_names: string[];
  analyzed_sheet: string;
  ai_assist?: AnalysisAiAssist;
}

export interface ImportConfirmPayload {
  file_token: string;
  template_name?: string;
  page_size: string;
  orientation: string;
  include_data: boolean;
  analyzed_sheet: string;
  report_title: string;
  report_title_style?: AnalysisTitleStyle;
  report_meta?: string;
  header_lines: AnalysisHeaderLine[];
  columns: AnalysisColumn[];
  column_groups: AnalysisColumnGroup[];
  group_by_column?: string;
  show_subtotals: boolean;
  footer_lines: AnalysisFooterLine[];
  signature_count: number;
  signature_labels: string[];
  theme: AnalysisTheme;
  recommended_table_schema: AnalysisTableSchema[];
}

export interface ImportConfirmResponse {
  template_id: number;
  dataset_id?: number;
  datasource_id?: number;
}
