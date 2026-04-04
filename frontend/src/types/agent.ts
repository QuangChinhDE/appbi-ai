export type PlanningMode = 'quick' | 'deep';
export type AgentBuildMode = 'new_dashboard' | 'new_version' | 'replace_existing';
export type AgentReportSpecStatus = 'draft' | 'ready' | 'running' | 'failed' | 'archived';
export type AgentWizardStep = 'select' | 'brief' | 'plan' | 'building';
export type AgentAudience = 'exec' | 'manager' | 'analyst';
export type AgentComparisonPeriod = 'previous_period' | 'same_period' | 'none';
export type AgentDetailLevel = 'overview' | 'detailed';
export type AgentDomainId =
  | 'sales'
  | 'marketing'
  | 'finance'
  | 'hr'
  | 'operations'
  | 'customer_service'
  | 'generic';
export type AgentReportRunStatus =
  | 'queued'
  | 'planning'
  | 'parsing_brief'
  | 'selecting_datasets'
  | 'profiling_data'
  | 'quality_gate'
  | 'planning_analysis'
  | 'planning_charts'
  | 'building'
  | 'building_dashboard'
  | 'generating_insights'
  | 'composing_report'
  | 'succeeded'
  | 'failed';

export interface SelectedTableRef {
  dataset_id: number;
  table_id: number;
}

export interface AgentBriefRequest {
  domain_id?: AgentDomainId;
  output_language?: 'auto' | 'vi' | 'en';
  report_name?: string;
  goal: string;
  audience?: AgentAudience;
  timeframe?: string;
  comparison_period?: AgentComparisonPeriod;
  detail_level?: AgentDetailLevel;
  notes?: string;
  planning_mode?: PlanningMode;
  selected_tables: SelectedTableRef[];
}

export interface ParsedBriefArtifact {
  domain_id?: AgentDomainId | null;
  domain_version?: string | null;
  output_language?: string | null;
  business_goal: string;
  decision_context?: string | null;
  target_audience?: string | null;
  report_style?: string | null;
  insight_depth?: string | null;
  recommendation_style?: string | null;
  primary_kpis: string[];
  secondary_kpis: string[];
  must_answer_questions: string[];
  required_sections: string[];
  risk_focus: string[];
  narrative_preferences: Record<string, any>;
  important_dimensions: string[];
  columns_to_avoid: string[];
  glossary_terms: string[];
  known_data_issues: string[];
  table_role_hints: string[];
  success_criteria: string[];
  explicit_assumptions: string[];
  clarification_gaps: string[];
  business_domain?: string | null;
  table_relationships?: string[];
  narrative_arc?: string | null;
}

export interface ThesisArtifact {
  central_thesis: string;
  supporting_arguments: string[];
  narrative_arc: string;
}

export interface DatasetFitArtifactItem {
  dataset_id: number;
  dataset_name: string;
  table_id: number;
  table_name: string;
  fit_score: number;
  suggested_role: string;
  good_for: string[];
  weak_for: string[];
  metadata_risk: string;
  coverage_notes: string[];
  notes: string;
}

export interface ProfilingArtifactItem {
  dataset_id: number;
  dataset_name: string;
  table_id: number;
  table_name: string;
  row_sample_count: number;
  column_count: number;
  table_grain: string;
  candidate_metrics: string[];
  candidate_dimensions: string[];
  candidate_time_fields: string[];
  top_dimensions: Record<string, string[]>;
  null_risk_columns: string[];
  freshness_summary?: string | null;
  semantic_summary?: string | null;
  risk_flags: string[];
}

export interface QualityGateArtifact {
  overall_status: string;
  blockers: string[];
  warnings: string[];
  acceptable_risks: string[];
  confidence_penalties: Record<string, number>;
  recommended_adjustments: string[];
  fields_with_issues: string[];
  quality_summary?: string | null;
}

export interface AnalysisQuestionMap {
  question: string;
  target_table_id?: number | null;
  target_table_name?: string | null;
  suggested_method: string;
  target_metric?: string | null;
  target_dimension?: string | null;
  target_time_field?: string | null;
  expected_signal?: string | null;
}

export interface AnalysisPlanArtifact {
  business_thesis: string;
  analysis_objectives: string[];
  question_map: AnalysisQuestionMap[];
  hypotheses: string[];
  priority_checks: string[];
  fallback_checks: string[];
  section_logic: Record<string, string>;
  narrative_flow: string[];
}

export interface ChartInsightArtifact {
  chart_key: string;
  chart_id?: number | null;
  title: string;
  chart_type: string;
  caption: string;
  finding: string;
  evidence_summary: string;
  confidence: number;
  warning_if_any?: string | null;
}

export interface SectionInsightArtifact {
  section_title: string;
  table_name: string;
  summary: string;
  key_findings: string[];
  caveats: string[];
  recommended_actions: string[];
  confidence: number;
  chart_keys: string[];
  chart_ids: number[];
}

export interface InsightReportArtifact {
  executive_summary: string;
  top_findings: string[];
  headline_risks: string[];
  priority_actions: string[];
  section_insights: SectionInsightArtifact[];
  chart_insights: ChartInsightArtifact[];
}

export interface DashboardBlueprintArtifact {
  dashboard_title: string;
  executive_summary: string;
  reading_order: string[];
  section_intro_text: Record<string, string>;
  chart_caption_map: Record<string, string>;
  narrative_flow: string[];
  layout_strategy: string;
  callout_priority: string[];
}

export interface AgentRuntimeMetadata {
  provider: string;
  model: string;
  fallback_chain: Array<{ provider: string; model: string }>;
  timeout_seconds: number;
}

export interface AgentReportResultSummary {
  created_chart_count?: number;
  preflight_failures?: number;
  build_mode?: AgentBuildMode;
  executive_summary?: string;
  top_findings?: string[];
  headline_risks?: string[];
  priority_actions?: string[];
  insight_report?: InsightReportArtifact | null;
  dashboard_blueprint?: DashboardBlueprintArtifact | null;
  planning_runtime?: AgentRuntimeMetadata | null;
  build_runtime?: AgentRuntimeMetadata | null;
  phase_runtimes?: Record<string, AgentRuntimeMetadata> | null;
  chart_data_summary?: Record<string, any> | null;
}

export interface AgentChartPlan {
  key: string;
  title: string;
  chart_type: string;
  dataset_id: number;
  dataset_table_id: number;
  dataset_name: string;
  table_name: string;
  rationale: string;
  insight_goal?: string | null;
  why_this_chart?: string | null;
  hypothesis?: string | null;
  confidence?: number;
  alternative_considered?: string | null;
  expected_signal?: string | null;
  config: Record<string, any>;
}

export interface AgentSectionPlan {
  title: string;
  dataset_id: number;
  dataset_table_id: number;
  dataset_name: string;
  table_name: string;
  intent: string;
  why_this_section?: string | null;
  questions_covered: string[];
  priority: number;
  chart_keys: string[];
}

export interface AgentPlanResponse {
  domain_id?: AgentDomainId | null;
  domain_version?: string | null;
  dashboard_title: string;
  dashboard_summary: string;
  strategy_summary?: string | null;
  planning_mode: PlanningMode;
  quality_score: number;
  quality_breakdown: Record<string, number>;
  sections: AgentSectionPlan[];
  charts: AgentChartPlan[];
  warnings: string[];
  parsed_brief?: ParsedBriefArtifact | null;
  dataset_fit_report?: DatasetFitArtifactItem[] | null;
  profiling_report?: ProfilingArtifactItem[] | null;
  quality_gate_report?: QualityGateArtifact | null;
  analysis_plan?: AnalysisPlanArtifact | null;
  thesis?: ThesisArtifact | null;
  runtime?: AgentRuntimeMetadata | null;
  phase_runtimes?: Record<string, AgentRuntimeMetadata> | null;
}

export interface AgentPlanEvent {
  type: string;
  phase: string;
  message: string;
  plan?: AgentPlanResponse;
  error?: string;
}

export interface AgentBuildEvent {
  type: string;
  phase: string;
  message: string;
  chart_id?: number;
  dashboard_id?: number;
  dashboard_url?: string;
  report_url?: string;
  error?: string;
}

export interface AgentReportSpec {
  id: number;
  name: string;
  description?: string | null;
  owner_id?: string | null;
  owner_email?: string | null;
  latest_dashboard_id?: number | null;
  domain_id?: AgentDomainId | null;
  domain_version?: string | null;
  status: AgentReportSpecStatus;
  current_step?: AgentWizardStep;
  selected_tables_snapshot: Array<Record<string, any>>;
  brief_json: Record<string, any>;
  approved_plan_json?: Record<string, any> | null;
  last_run_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentReportRun {
  id: number;
  report_spec_id: number;
  triggered_by?: string | null;
  dashboard_id?: number | null;
  target_dashboard_id?: number | null;
  build_mode: AgentBuildMode;
  domain_id?: AgentDomainId | null;
  domain_version?: string | null;
  status: AgentReportRunStatus;
  error?: string | null;
  input_brief_json: Record<string, any>;
  plan_json: Record<string, any>;
  result_summary_json?: AgentReportResultSummary | null;
  created_at: string;
  finished_at?: string | null;
}

export interface AgentReportSpecDetail extends AgentReportSpec {
  runs: AgentReportRun[];
}

export interface AgentReportSpecCreate {
  name: string;
  description?: string;
  selected_tables_snapshot: Array<Record<string, any>>;
  domain_id?: AgentDomainId;
  domain_version?: string;
  brief_json: Record<string, any>;
  approved_plan_json?: Record<string, any> | null;
  latest_dashboard_id?: number | null;
  status?: AgentReportSpecStatus;
  current_step?: AgentWizardStep;
}

export interface AgentReportSpecUpdate {
  name?: string;
  description?: string;
  selected_tables_snapshot?: Array<Record<string, any>>;
  domain_id?: AgentDomainId;
  domain_version?: string;
  brief_json?: Record<string, any>;
  approved_plan_json?: Record<string, any> | null;
  latest_dashboard_id?: number | null;
  status?: AgentReportSpecStatus;
  current_step?: AgentWizardStep;
}

export interface AgentReportRunCreate {
  build_mode: AgentBuildMode;
  domain_id?: AgentDomainId;
  domain_version?: string;
  input_brief_json: Record<string, any>;
  plan_json: Record<string, any>;
  target_dashboard_id?: number | null;
  status?: AgentReportRunStatus;
}
