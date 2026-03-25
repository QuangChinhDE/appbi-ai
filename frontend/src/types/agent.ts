export type PlanningMode = 'quick' | 'deep';
export type AgentBuildMode = 'new_dashboard' | 'new_version' | 'replace_existing';
export type AgentReportSpecStatus = 'draft' | 'ready' | 'running' | 'failed' | 'archived';
export type AgentReportRunStatus = 'queued' | 'planning' | 'building' | 'succeeded' | 'failed';

export interface SelectedTableRef {
  workspace_id: number;
  table_id: number;
}

export interface AgentBriefRequest {
  report_name?: string;
  report_type?: string;
  goal: string;
  audience?: string;
  timeframe?: string;
  kpis: string[];
  questions: string[];
  comparison_period?: string;
  refresh_frequency?: string;
  must_include_sections: string[];
  alert_focus: string[];
  preferred_granularity?: string;
  decision_context?: string;
  notes?: string;
  planning_mode: PlanningMode;
  selected_tables: SelectedTableRef[];
}

export interface AgentChartPlan {
  key: string;
  title: string;
  chart_type: string;
  workspace_id: number;
  workspace_table_id: number;
  workspace_name: string;
  table_name: string;
  rationale: string;
  insight_goal?: string | null;
  why_this_chart?: string | null;
  confidence?: number;
  alternative_considered?: string | null;
  expected_signal?: string | null;
  config: Record<string, any>;
}

export interface AgentSectionPlan {
  title: string;
  workspace_id: number;
  workspace_table_id: number;
  workspace_name: string;
  table_name: string;
  intent: string;
  why_this_section?: string | null;
  questions_covered: string[];
  priority: number;
  chart_keys: string[];
}

export interface AgentPlanResponse {
  dashboard_title: string;
  dashboard_summary: string;
  strategy_summary?: string | null;
  planning_mode: PlanningMode;
  quality_score: number;
  quality_breakdown: Record<string, number>;
  sections: AgentSectionPlan[];
  charts: AgentChartPlan[];
  warnings: string[];
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
  error?: string;
}

export interface AgentReportSpec {
  id: number;
  name: string;
  description?: string | null;
  owner_id?: string | null;
  latest_dashboard_id?: number | null;
  status: AgentReportSpecStatus;
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
  status: AgentReportRunStatus;
  error?: string | null;
  input_brief_json: Record<string, any>;
  plan_json: Record<string, any>;
  result_summary_json?: Record<string, any> | null;
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
  brief_json: Record<string, any>;
  approved_plan_json?: Record<string, any> | null;
  latest_dashboard_id?: number | null;
  status?: AgentReportSpecStatus;
}

export interface AgentReportSpecUpdate {
  name?: string;
  description?: string;
  selected_tables_snapshot?: Array<Record<string, any>>;
  brief_json?: Record<string, any>;
  approved_plan_json?: Record<string, any> | null;
  latest_dashboard_id?: number | null;
  status?: AgentReportSpecStatus;
}

export interface AgentReportRunCreate {
  build_mode: AgentBuildMode;
  input_brief_json: Record<string, any>;
  plan_json: Record<string, any>;
  target_dashboard_id?: number | null;
  status?: AgentReportRunStatus;
}
