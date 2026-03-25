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
import { AgentReportResultSummary, AgentReportRun } from '@/types/agent';

function statusTone(status: string) {
  if (status === 'succeeded' || status === 'ready') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (status === 'failed') return 'bg-rose-50 text-rose-700 border-rose-200';
  return 'bg-blue-50 text-blue-700 border-blue-200';
}

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
      <div className="min-h-screen bg-gray-50">
        <div className="px-8 py-10">
          <div className="flex items-center justify-center rounded-xl border border-gray-200 bg-white px-6 py-16 shadow-sm">
            <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
            <span className="ml-3 text-sm text-gray-600">Loading AI report…</span>
          </div>
        </div>
      </div>
    );
  }

  if (!spec) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="px-8 py-10">
          <div className="rounded-xl border border-gray-200 bg-white px-6 py-12 shadow-sm">
            <p className="text-lg font-semibold text-gray-900">AI report not found</p>
            <p className="mt-2 text-sm text-gray-500">The saved report may have been removed or you may not have access to it.</p>
            <Link href="/ai-reports" className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-blue-600 hover:text-blue-700">
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
    <div className="min-h-screen bg-gray-50">
      <div className="px-8 py-8">
        <div className="mb-6 flex items-center justify-between gap-4">
          <div>
            <Link href="/ai-reports" className="inline-flex items-center gap-2 text-sm font-medium text-blue-600 hover:text-blue-700">
              <ArrowLeft className="h-4 w-4" />
              Back to AI reports
            </Link>
            <div className="mt-4 flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                <Bot className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-2xl font-semibold text-gray-900">{spec.name}</h1>
                <p className="mt-1 text-sm text-gray-500">
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
              className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              <Bot className="h-4 w-4" />
              Edit brief
            </button>
            <button
              type="button"
              onClick={handleDeleteReport}
              disabled={deleteSpecMutation.isPending}
              className="inline-flex items-center gap-2 rounded-md border border-rose-200 bg-white px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Trash2 className="h-4 w-4" />
              Delete report
            </button>
            {dashboardId && dashboard && (
              <button
                type="button"
                onClick={() => router.push(`/dashboards/${dashboardId}`)}
                className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                <LayoutDashboard className="h-4 w-4" />
                Edit in dashboard
              </button>
            )}
          </div>
        </div>

        <div className="mb-6 grid gap-4 lg:grid-cols-5">
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <p className="text-xs uppercase tracking-[0.16em] text-gray-400">Latest run</p>
            <p className="mt-2 text-base font-semibold text-gray-900">
              {latestSuccessfulRun ? `#${latestSuccessfulRun.id}` : 'No run yet'}
            </p>
            {latestSuccessfulRun && (
              <p className="mt-1 text-sm text-gray-500">{new Date(latestSuccessfulRun.created_at).toLocaleString('vi-VN')}</p>
            )}
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <p className="text-xs uppercase tracking-[0.16em] text-gray-400">Charts built</p>
            <p className="mt-2 text-base font-semibold text-gray-900">{result?.created_chart_count ?? 0}</p>
            <p className="mt-1 text-sm text-gray-500">From the latest successful report run</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <p className="text-xs uppercase tracking-[0.16em] text-gray-400">Tables in scope</p>
            <p className="mt-2 text-base font-semibold text-gray-900">{spec.selected_tables_snapshot?.length ?? 0}</p>
            <p className="mt-1 text-sm text-gray-500">The Agent stayed within this selected scope</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <p className="text-xs uppercase tracking-[0.16em] text-gray-400">Build mode</p>
            <p className="mt-2 text-base font-semibold capitalize text-gray-900">{(result?.build_mode ?? latestSuccessfulRun?.build_mode ?? 'n/a').replace(/_/g, ' ')}</p>
            <p className="mt-1 text-sm text-gray-500">Latest output strategy</p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <p className="text-xs uppercase tracking-[0.16em] text-gray-400">LLM runtime</p>
            <p className="mt-2 text-base font-semibold text-gray-900">
              {buildRuntime?.model || planningRuntime?.model || 'Unknown'}
            </p>
            <p className="mt-1 text-sm text-gray-500">
              {(buildRuntime?.provider || planningRuntime?.provider || 'n/a')}
              {typeof (buildRuntime?.timeout_seconds ?? planningRuntime?.timeout_seconds) === 'number'
                ? ` • ${buildRuntime?.timeout_seconds ?? planningRuntime?.timeout_seconds}s timeout`
                : ''}
            </p>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-[0.78fr_1.22fr]">
          <div className="space-y-6 xl:sticky xl:top-6 xl:self-start">
            <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <div className="mb-4 flex items-center gap-2 text-gray-900">
                <Sparkles className="h-5 w-5 text-blue-600" />
                <h2 className="text-lg font-semibold">Executive summary</h2>
              </div>
              <p className="text-sm leading-6 text-gray-700">
                {result?.executive_summary || blueprint?.executive_summary || spec.description || 'The report has been saved, but a narrative summary is not available yet.'}
              </p>
            </div>

            {insight?.top_findings?.length ? (
              <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="mb-4 flex items-center gap-2 text-gray-900">
                  <CheckCircle2 className="h-5 w-5 text-blue-600" />
                  <h2 className="text-lg font-semibold">Top findings</h2>
                </div>
                <ul className="space-y-3 text-sm text-gray-700">
                  {insight.top_findings.map((item) => (
                    <li key={item}>- {item}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {(insight?.headline_risks?.length || insight?.priority_actions?.length) ? (
              <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-1">
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-6">
                  <div className="mb-4 flex items-center gap-2 text-amber-900">
                    <ShieldAlert className="h-5 w-5" />
                    <h2 className="text-lg font-semibold">Headline risks</h2>
                  </div>
                  <ul className="space-y-3 text-sm text-amber-900">
                    {(insight?.headline_risks ?? []).map((item) => (
                      <li key={item}>- {item}</li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-xl border border-blue-200 bg-blue-50 p-6">
                  <div className="mb-4 flex items-center gap-2 text-blue-900">
                    <FileText className="h-5 w-5" />
                    <h2 className="text-lg font-semibold">Priority actions</h2>
                  </div>
                  <ul className="space-y-3 text-sm text-blue-900">
                    {(insight?.priority_actions ?? []).map((item) => (
                      <li key={item}>- {item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}

            {insight?.section_insights?.length ? (
              <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="mb-4 flex items-center gap-2 text-gray-900">
                  <Bot className="h-5 w-5 text-blue-600" />
                  <h2 className="text-lg font-semibold">Section narrative</h2>
                </div>
                <div className="space-y-4">
                  {insight.section_insights.map((section) => (
                    <div key={section.section_title} className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold text-gray-900">{section.section_title}</p>
                          <p className="mt-1 text-xs uppercase tracking-[0.16em] text-gray-500">{section.table_name}</p>
                        </div>
                        <span className="rounded-full bg-white px-3 py-1 text-xs text-gray-600">
                          {Math.round(section.confidence * 100)}% confidence
                        </span>
                      </div>
                      <p className="mt-3 text-sm text-gray-700">{section.summary}</p>
                      {section.key_findings.length > 0 && (
                        <div className="mt-3">
                          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">Findings</p>
                          <ul className="mt-2 space-y-2 text-sm text-gray-700">
                            {section.key_findings.map((item) => (
                              <li key={item}>- {item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {section.caveats.length > 0 && (
                        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
                          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-700">Caveats</p>
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
              <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="mb-4 flex items-center gap-2 text-gray-900">
                  <Clock className="h-5 w-5 text-blue-600" />
                  <h2 className="text-lg font-semibold">Run history</h2>
                </div>
                <div className="space-y-3">
                  {sortedRuns.slice(0, 6).map((run: AgentReportRun) => (
                    <div key={run.id} className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium text-gray-900">Run #{run.id}</p>
                          <p className="mt-1 text-xs text-gray-500">{new Date(run.created_at).toLocaleString('vi-VN')}</p>
                        </div>
                        <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${statusTone(run.status)}`}>
                          {run.status}
                        </span>
                      </div>
                      {run.error && <p className="mt-2 text-xs text-rose-600">{run.error}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="space-y-6">
            <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 text-gray-900">
                    <LayoutDashboard className="h-5 w-5 text-blue-600" />
                    <h2 className="text-lg font-semibold">Dashboard view</h2>
                  </div>
                  <p className="mt-1 text-sm text-gray-500">
                    Read the narrative on the left, then jump into the dashboard editor when you want to fine-tune layout, charts, and filters.
                  </p>
                </div>
                {dashboardId && dashboard && (
                  <button
                    type="button"
                    onClick={() => router.push(`/dashboards/${dashboardId}`)}
                    className="inline-flex items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Edit in dashboard
                  </button>
                )}
              </div>
              {dashboardId && dashboard ? (
                <DashboardGrid dashboardId={dashboardId} dashboardCharts={dashboard.dashboard_charts || []} />
              ) : isLoadingDashboard ? (
                <div className="flex items-center justify-center rounded-lg border border-gray-200 bg-gray-50 px-6 py-16">
                  <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
                  <span className="ml-3 text-sm text-gray-600">Loading dashboard preview…</span>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-6 py-16 text-center">
                  <p className="text-base font-medium text-gray-900">No dashboard output is attached yet</p>
                  <p className="mt-2 text-sm text-gray-500">Run the AI report at least once to generate a dashboard and narrative pair.</p>
                </div>
              )}
            </div>

            {insight?.chart_insights?.length ? (
              <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
                <div className="mb-4 flex items-center gap-2 text-gray-900">
                  <FileText className="h-5 w-5 text-blue-600" />
                  <h2 className="text-lg font-semibold">Chart captions and evidence</h2>
                </div>
                <div className="space-y-4">
                  {insight.chart_insights.map((chart) => (
                    <div key={`${chart.chart_key}-${chart.chart_id ?? 'draft'}`} className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold text-gray-900">{chart.title}</p>
                          <p className="mt-1 text-xs uppercase tracking-[0.16em] text-gray-500">{chart.chart_type}</p>
                        </div>
                        <span className="rounded-full bg-white px-3 py-1 text-xs text-gray-600">
                          {Math.round(chart.confidence * 100)}% confidence
                        </span>
                      </div>
                      <p className="mt-3 text-sm font-medium text-gray-900">{chart.caption}</p>
                      <p className="mt-2 text-sm text-gray-700">{chart.finding}</p>
                      <p className="mt-2 text-xs text-gray-500">Evidence: {chart.evidence_summary}</p>
                      {chart.warning_if_any && (
                        <p className="mt-2 text-xs text-amber-700">Caveat: {chart.warning_if_any}</p>
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
