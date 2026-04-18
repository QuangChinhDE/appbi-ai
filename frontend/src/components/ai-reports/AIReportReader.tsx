'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  LayoutDashboard,
  Loader2,
  ShieldAlert,
  Sparkles,
  Trash2,
} from 'lucide-react';

import { DashboardGrid } from '@/components/dashboards/DashboardGrid';
import { useDashboard } from '@/hooks/use-dashboards';
import { useAgentReportSpec, useDeleteAgentReportSpec } from '@/hooks/use-agent-report-specs';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { AgentReportResultSummary, AgentReportRun } from '@/types/agent';

function statusTone(status: string) {
  if (status === 'succeeded' || status === 'ready') return 'bg-success/10 text-success border-success/30';
  if (status === 'failed') return 'bg-danger/10 text-danger border-danger/30';
  return 'bg-brand/10 text-brand border-brand/30';
}

const panelClassName = 'rounded-xl border border-[rgb(var(--border-strong))] bg-surface-1 shadow-linear-sm';
const metricCardClassName = `${panelClassName} p-5`;
const sectionCardClassName = `${panelClassName} p-6`;
const comparisonCardClassName = 'rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-4';
const metaPillClassName = 'rounded-full border border-[rgb(var(--border-line))] bg-surface-0 px-3 py-1 text-xs text-text-secondary';

export default function AIReportReaderPage() {
  const params = useParams();
  const router = useRouter();
  const specId = Number(params.id);
  const { data: spec, isLoading } = useAgentReportSpec(Number.isFinite(specId) ? specId : null);
  const deleteSpecMutation = useDeleteAgentReportSpec();

  const sortedRuns = useMemo(
    () =>
      [...(spec?.runs ?? [])].sort(
        (left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime(),
      ),
    [spec?.runs],
  );

  const latestSuccessfulRun = useMemo(
    () => sortedRuns.find((run) => run.status === 'succeeded') ?? sortedRuns[0],
    [sortedRuns],
  );
  const result = (latestSuccessfulRun?.result_summary_json ?? null) as AgentReportResultSummary | null;
  const dashboardId = spec?.latest_dashboard_id ?? null;
  const { data: dashboard, isLoading: isLoadingDashboard } = useDashboard(dashboardId ?? 0);
  const canEditDashboardAppearance = getResourcePermissions(dashboard?.user_permission).canEdit;

  async function handleDeleteReport() {
    if (!spec) return;
    const confirmed = window.confirm(
      spec.latest_dashboard_id
        ? `Delete AI report "${spec.name}"?\n\nThis removes the brief and run history, but keeps the linked dashboard in Dashboards.`
        : `Delete AI report "${spec.name}"?\n\nThis removes the saved brief and run history.`,
    );
    if (!confirmed) return;

    try {
      await deleteSpecMutation.mutateAsync(spec.id);
      router.push('/ai-reports');
      router.refresh();
    } catch (error) {
      console.error('Failed to delete AI report', error);
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-surface-0">
        <div className="px-8 py-10">
          <div className={`${panelClassName} flex items-center justify-center px-6 py-16`}>
            <Loader2 className="h-6 w-6 animate-spin text-brand" />
            <span className="ml-3 text-sm text-text-secondary">Loading AI report…</span>
          </div>
        </div>
      </div>
    );
  }

  if (!spec) {
    return (
      <div className="min-h-screen bg-surface-0">
        <div className="px-8 py-10">
          <div className={`${panelClassName} px-6 py-12`}>
            <p className="text-lg font-semibold text-text-primary">AI report not found</p>
            <p className="mt-2 text-sm text-text-tertiary">The saved report may have been removed or you may not have access to it.</p>
            <Link href="/ai-reports" className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-brand hover:text-brand">
              <ArrowLeft className="h-4 w-4" />
              Back to AI reports
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const insight = result?.insight_report;
  const blueprint = result?.dashboard_blueprint;
  const planningRuntime = result?.planning_runtime ?? null;
  const buildRuntime = result?.build_runtime ?? null;

  return (
    <div className="min-h-screen bg-surface-0">
      <div className="px-8 py-8">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div>
            <Link href="/ai-reports" className="inline-flex items-center gap-2 text-sm font-medium text-brand hover:text-brand">
              <ArrowLeft className="h-4 w-4" />
              Back to AI reports
            </Link>
            <div className="mt-4 flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand/10 text-brand">
                <Bot className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-2xl font-semibold text-text-primary">{spec.name}</h1>
                <p className="mt-1 text-sm text-text-tertiary">
                  Read the narrative insight flow here, then continue manual dashboard refinement in Dashboards.
                </p>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] ${statusTone(spec.status)}`}>
              {spec.status}
            </span>
            <button
              type="button"
              onClick={() => router.push(`/ai-reports/${spec.id}/edit`)}
              className="inline-flex items-center gap-2 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-2 text-sm font-medium text-text-secondary hover:bg-surface-2"
            >
              <Bot className="h-4 w-4" />
              Edit brief
            </button>
            <button
              type="button"
              onClick={handleDeleteReport}
              disabled={deleteSpecMutation.isPending}
              className="inline-flex items-center gap-2 rounded-md border border-danger/30 bg-surface-1 px-4 py-2 text-sm font-medium text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Trash2 className="h-4 w-4" />
              Delete report
            </button>
            {dashboardId && dashboard && (
              <button
                type="button"
                onClick={() => router.push(`/dashboards/${dashboardId}`)}
                className="inline-flex items-center gap-2 rounded-md bg-brand px-4 py-2 text-sm font-medium text-text-inverse shadow-linear-sm hover:bg-brand-hover"
              >
                <LayoutDashboard className="h-4 w-4" />
                Edit in dashboard
              </button>
            )}
          </div>
        </div>

        <div className="mb-6 grid gap-4 lg:grid-cols-5">
          <div className={metricCardClassName}>
            <p className="text-xs uppercase tracking-[0.16em] text-text-quaternary">Latest run</p>
            <p className="mt-2 text-base font-semibold text-text-primary">
              {latestSuccessfulRun ? `#${latestSuccessfulRun.id}` : 'No run yet'}
            </p>
            {latestSuccessfulRun && (
              <p className="mt-1 text-sm text-text-tertiary">{new Date(latestSuccessfulRun.created_at).toLocaleString('vi-VN')}</p>
            )}
          </div>
          <div className={metricCardClassName}>
            <p className="text-xs uppercase tracking-[0.16em] text-text-quaternary">Charts built</p>
            <p className="mt-2 text-base font-semibold text-text-primary">{result?.created_chart_count ?? 0}</p>
            <p className="mt-1 text-sm text-text-tertiary">From the latest successful report run</p>
          </div>
          <div className={metricCardClassName}>
            <p className="text-xs uppercase tracking-[0.16em] text-text-quaternary">Tables in scope</p>
            <p className="mt-2 text-base font-semibold text-text-primary">{spec.selected_tables_snapshot?.length ?? 0}</p>
            <p className="mt-1 text-sm text-text-tertiary">The Agent stayed within this selected scope</p>
          </div>
          <div className={metricCardClassName}>
            <p className="text-xs uppercase tracking-[0.16em] text-text-quaternary">Build mode</p>
            <p className="mt-2 text-base font-semibold capitalize text-text-primary">{(result?.build_mode ?? latestSuccessfulRun?.build_mode ?? 'n/a').replace(/_/g, ' ')}</p>
            <p className="mt-1 text-sm text-text-tertiary">Latest output strategy</p>
          </div>
          <div className={metricCardClassName}>
            <p className="text-xs uppercase tracking-[0.16em] text-text-quaternary">LLM runtime</p>
            <p className="mt-2 text-base font-semibold text-text-primary">
              {buildRuntime?.model || planningRuntime?.model || 'Unknown'}
            </p>
            <p className="mt-1 text-sm text-text-tertiary">
              {(buildRuntime?.provider || planningRuntime?.provider || 'n/a')}
              {typeof (buildRuntime?.timeout_seconds ?? planningRuntime?.timeout_seconds) === 'number'
                ? ` • ${buildRuntime?.timeout_seconds ?? planningRuntime?.timeout_seconds}s timeout`
                : ''}
            </p>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-[0.78fr_1.22fr]">
          <div className="space-y-6 xl:sticky xl:top-6 xl:self-start">
            <div className={sectionCardClassName}>
              <div className="mb-4 flex items-center gap-2 text-text-primary">
                <Sparkles className="h-5 w-5 text-brand" />
                <h2 className="text-lg font-semibold">Executive summary</h2>
              </div>
              <p className="text-sm leading-6 text-text-secondary">
                {result?.executive_summary || blueprint?.executive_summary || spec.description || 'The report has been saved, but a narrative summary is not available yet.'}
              </p>
            </div>

            {insight?.top_findings?.length ? (
              <div className={sectionCardClassName}>
                <div className="mb-4 flex items-center gap-2 text-text-primary">
                  <CheckCircle2 className="h-5 w-5 text-brand" />
                  <h2 className="text-lg font-semibold">Top findings</h2>
                </div>
                <ul className="space-y-3 text-sm text-text-secondary">
                  {insight.top_findings.map((item) => (
                    <li key={item}>- {item}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {(insight?.headline_risks?.length || insight?.priority_actions?.length) ? (
              <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-1">
                <div className="rounded-xl border border-warning/30 bg-warning/10 p-6">
                  <div className="mb-4 flex items-center gap-2 text-warning">
                    <ShieldAlert className="h-5 w-5" />
                    <h2 className="text-lg font-semibold">Headline risks</h2>
                  </div>
                  <ul className="space-y-3 text-sm text-warning">
                    {(insight?.headline_risks ?? []).map((item) => (
                      <li key={item}>- {item}</li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-xl border border-brand/30 bg-brand/10 p-6">
                  <div className="mb-4 flex items-center gap-2 text-brand">
                    <FileText className="h-5 w-5" />
                    <h2 className="text-lg font-semibold">Priority actions</h2>
                  </div>
                  <ul className="space-y-3 text-sm text-brand">
                    {(insight?.priority_actions ?? []).map((item) => (
                      <li key={item}>- {item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}

            {insight?.section_insights?.length ? (
              <div className={sectionCardClassName}>
                <div className="mb-4 flex items-center gap-2 text-text-primary">
                  <Bot className="h-5 w-5 text-brand" />
                  <h2 className="text-lg font-semibold">Section narrative</h2>
                </div>
                <div className="space-y-4">
                  {insight.section_insights.map((section) => (
                    <div key={section.section_title} className={comparisonCardClassName}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold text-text-primary">{section.section_title}</p>
                          <p className="mt-1 text-xs uppercase tracking-[0.16em] text-text-tertiary">{section.table_name}</p>
                        </div>
                        <span className={metaPillClassName}>
                          {Math.round(section.confidence * 100)}% confidence
                        </span>
                      </div>
                      <p className="mt-3 text-sm text-text-secondary">{section.summary}</p>
                      {section.key_findings.length > 0 && (
                        <div className="mt-3">
                          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-text-quaternary">Findings</p>
                          <ul className="mt-2 space-y-2 text-sm text-text-secondary">
                            {section.key_findings.map((item) => (
                              <li key={item}>- {item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {section.caveats.length > 0 && (
                        <div className="mt-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-3 text-sm text-warning">
                          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-warning">Caveats</p>
                          <ul className="mt-2 space-y-2">
                            {section.caveats.map((item) => (
                              <li key={item}>- {item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {sortedRuns.length > 0 && (
              <div className={sectionCardClassName}>
                <div className="mb-4 flex items-center gap-2 text-text-primary">
                  <Clock className="h-5 w-5 text-brand" />
                  <h2 className="text-lg font-semibold">Run history</h2>
                </div>
                <div className="space-y-3">
                  {sortedRuns.slice(0, 6).map((run: AgentReportRun) => (
                    <div key={run.id} className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-text-primary">Run #{run.id}</p>
                          <p className="mt-1 text-xs text-text-tertiary">{new Date(run.created_at).toLocaleString('vi-VN')}</p>
                        </div>
                        <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${statusTone(run.status)}`}>
                          {run.status}
                        </span>
                      </div>
                      {run.error && <p className="mt-2 text-xs text-danger">{run.error}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="space-y-6">
            <div className={sectionCardClassName}>
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-text-primary">
                    <LayoutDashboard className="h-5 w-5 text-brand" />
                    <h2 className="text-lg font-semibold">Dashboard view</h2>
                  </div>
                  <p className="mt-1 text-sm text-text-tertiary">
                    Read the narrative on the left, then jump into the dashboard editor when you want to fine-tune layout, charts, and filters.
                  </p>
                </div>
                {dashboardId && dashboard && (
                  <button
                    type="button"
                    onClick={() => router.push(`/dashboards/${dashboardId}`)}
                    className="inline-flex items-center gap-2 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-3 py-2 text-sm font-medium text-text-secondary hover:bg-surface-2"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Edit in dashboard
                  </button>
                )}
              </div>
              {dashboardId && dashboard ? (
                <DashboardGrid
                  dashboardId={dashboardId}
                  dashboardCharts={dashboard.dashboard_charts || []}
                  allowAppearanceEdit={canEditDashboardAppearance}
                />
              ) : isLoadingDashboard ? (
                <div className="flex items-center justify-center rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-6 py-16">
                  <Loader2 className="h-5 w-5 animate-spin text-brand" />
                  <span className="ml-3 text-sm text-text-secondary">Loading dashboard preview…</span>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-[rgb(var(--border-strong))] bg-surface-2 px-6 py-16 text-center">
                  <p className="text-base font-medium text-text-primary">No dashboard output is attached yet</p>
                  <p className="mt-2 text-sm text-text-tertiary">Run the AI report at least once to generate a dashboard and narrative pair.</p>
                </div>
              )}
            </div>

            {insight?.chart_insights?.length ? (
              <div className={sectionCardClassName}>
                <div className="mb-4 flex items-center gap-2 text-text-primary">
                  <FileText className="h-5 w-5 text-brand" />
                  <h2 className="text-lg font-semibold">Chart captions and evidence</h2>
                </div>
                <div className="space-y-4">
                  {insight.chart_insights.map((chart) => (
                    <div key={`${chart.chart_key}-${chart.chart_id ?? 'draft'}`} className={comparisonCardClassName}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold text-text-primary">{chart.title}</p>
                          <p className="mt-1 text-xs uppercase tracking-[0.16em] text-text-tertiary">{chart.chart_type}</p>
                        </div>
                        <span className={metaPillClassName}>
                          {Math.round(chart.confidence * 100)}% confidence
                        </span>
                      </div>
                      <p className="mt-3 text-sm font-medium text-text-primary">{chart.caption}</p>
                      <p className="mt-2 text-sm text-text-secondary">{chart.finding}</p>
                      <p className="mt-2 text-xs text-text-tertiary">Evidence: {chart.evidence_summary}</p>
                      {chart.warning_if_any && (
                        <p className="mt-2 text-xs text-warning">Caveat: {chart.warning_if_any}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
