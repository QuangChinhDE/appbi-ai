import {
  AgentBuildEvent as BuildEvent,
  AgentChartPlan,
  AgentPlanEvent,
  AgentPlanResponse,
  AgentSectionPlan,
} from '@/types/agent';
import { EditableAgentChartPlan, EditableAgentPlan } from './wizard-types';

export function splitLines(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizePlan(plan: AgentPlanResponse): EditableAgentPlan {
  return {
    dashboard_title: plan.dashboard_title,
    dashboard_summary: plan.dashboard_summary,
    strategy_summary: plan.strategy_summary,
    planning_mode: plan.planning_mode,
    quality_score: plan.quality_score,
    quality_breakdown: { ...(plan.quality_breakdown ?? {}) },
    parsed_brief: plan.parsed_brief ? JSON.parse(JSON.stringify(plan.parsed_brief)) : undefined,
    dataset_fit_report: plan.dataset_fit_report ? JSON.parse(JSON.stringify(plan.dataset_fit_report)) : undefined,
    profiling_report: plan.profiling_report ? JSON.parse(JSON.stringify(plan.profiling_report)) : undefined,
    quality_gate_report: plan.quality_gate_report ? JSON.parse(JSON.stringify(plan.quality_gate_report)) : undefined,
    analysis_plan: plan.analysis_plan ? JSON.parse(JSON.stringify(plan.analysis_plan)) : undefined,
    runtime: plan.runtime ? JSON.parse(JSON.stringify(plan.runtime)) : undefined,
    sections: plan.sections.map((section) => ({
      ...section,
      chart_keys: [...section.chart_keys],
      questions_covered: [...(section.questions_covered ?? [])],
    })),
    charts: plan.charts.map((chart) => ({
      ...chart,
      enabled: typeof (chart as { enabled?: boolean }).enabled === 'boolean' ? Boolean((chart as { enabled?: boolean }).enabled) : true,
      config: JSON.parse(JSON.stringify(chart.config ?? {})),
    })),
    warnings: [...plan.warnings],
  };
}

export function cloneEditablePlan(plan: EditableAgentPlan): EditableAgentPlan {
  return {
    dashboard_title: plan.dashboard_title,
    dashboard_summary: plan.dashboard_summary,
    strategy_summary: plan.strategy_summary,
    planning_mode: plan.planning_mode,
    quality_score: plan.quality_score,
    quality_breakdown: { ...(plan.quality_breakdown ?? {}) },
    parsed_brief: plan.parsed_brief ? JSON.parse(JSON.stringify(plan.parsed_brief)) : undefined,
    dataset_fit_report: plan.dataset_fit_report ? JSON.parse(JSON.stringify(plan.dataset_fit_report)) : undefined,
    profiling_report: plan.profiling_report ? JSON.parse(JSON.stringify(plan.profiling_report)) : undefined,
    quality_gate_report: plan.quality_gate_report ? JSON.parse(JSON.stringify(plan.quality_gate_report)) : undefined,
    analysis_plan: plan.analysis_plan ? JSON.parse(JSON.stringify(plan.analysis_plan)) : undefined,
    runtime: plan.runtime ? JSON.parse(JSON.stringify(plan.runtime)) : undefined,
    sections: plan.sections.map((section) => ({
      ...section,
      chart_keys: [...section.chart_keys],
      questions_covered: [...(section.questions_covered ?? [])],
    })),
    charts: plan.charts.map((chart) => ({
      ...chart,
      enabled: chart.enabled,
      config: JSON.parse(JSON.stringify(chart.config ?? {})),
    })),
    warnings: [...plan.warnings],
  };
}

export function toBuildPlan(plan: EditableAgentPlan): AgentPlanResponse {
  const activeCharts = plan.charts
    .filter((chart) => chart.enabled)
    .map(({ enabled: _enabled, ...chart }) => chart);
  const allowedKeys = new Set(activeCharts.map((chart) => chart.key));
  const sections = plan.sections
    .map((section) => ({
      ...section,
      chart_keys: section.chart_keys.filter((key) => allowedKeys.has(key)),
    }))
    .filter((section) => section.chart_keys.length > 0);

  return {
    dashboard_title: plan.dashboard_title.trim(),
    dashboard_summary: plan.dashboard_summary.trim(),
    strategy_summary: plan.strategy_summary,
    planning_mode: plan.planning_mode,
    quality_score: plan.quality_score,
    quality_breakdown: { ...(plan.quality_breakdown ?? {}) },
    parsed_brief: plan.parsed_brief ? JSON.parse(JSON.stringify(plan.parsed_brief)) : undefined,
    dataset_fit_report: plan.dataset_fit_report ? JSON.parse(JSON.stringify(plan.dataset_fit_report)) : undefined,
    profiling_report: plan.profiling_report ? JSON.parse(JSON.stringify(plan.profiling_report)) : undefined,
    quality_gate_report: plan.quality_gate_report ? JSON.parse(JSON.stringify(plan.quality_gate_report)) : undefined,
    analysis_plan: plan.analysis_plan ? JSON.parse(JSON.stringify(plan.analysis_plan)) : undefined,
    runtime: plan.runtime ? JSON.parse(JSON.stringify(plan.runtime)) : undefined,
    sections,
    charts: activeCharts,
    warnings: [...plan.warnings],
  };
}

export function describeChartConfig(chart: AgentChartPlan): string[] {
  const roleConfig = (chart.config?.roleConfig ?? {}) as Record<string, any>;
  const notes: string[] = [];

  const metrics = Array.isArray(roleConfig.metrics) ? roleConfig.metrics : [];
  if (metrics.length > 0) {
    const metric = metrics[0];
    if (metric?.field) {
      notes.push(`Metric: ${metric.field}${metric.agg ? ` (${metric.agg})` : ''}`);
    }
  }

  if (typeof roleConfig.dimension === 'string' && roleConfig.dimension) {
    notes.push(`Dimension: ${roleConfig.dimension}`);
  }

  if (typeof roleConfig.timeField === 'string' && roleConfig.timeField) {
    notes.push(`Time: ${roleConfig.timeField}`);
  }

  if (Array.isArray(roleConfig.selectedColumns) && roleConfig.selectedColumns.length > 0) {
    notes.push(`Columns: ${roleConfig.selectedColumns.length}`);
  }

  return notes.slice(0, 3);
}

export function sectionActiveCount(section: AgentSectionPlan, charts: EditableAgentChartPlan[]): number {
  const enabledKeys = new Set(charts.filter((chart) => chart.enabled).map((chart) => chart.key));
  return section.chart_keys.filter((key) => enabledKeys.has(key)).length;
}

export function getBuildEventBadgeClass(event: BuildEvent): string {
  if (event.type === 'error') {
    return 'bg-rose-50 text-rose-700 border border-rose-200';
  }
  if (event.type === 'done') {
    return 'bg-emerald-50 text-emerald-700 border border-emerald-200';
  }
  return 'bg-blue-50 text-blue-700 border border-blue-200';
}

export function getPlanEventBadgeClass(event: AgentPlanEvent): string {
  if (event.type === 'error') {
    return 'bg-rose-50 text-rose-700 border border-rose-200';
  }
  if (event.type === 'done') {
    return 'bg-emerald-50 text-emerald-700 border border-emerald-200';
  }
  return 'bg-blue-50 text-blue-700 border border-blue-200';
}

export function briefToMultiline(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map((item) => String(item).trim()).filter(Boolean).join('\n');
}
