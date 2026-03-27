// @ts-nocheck
import { Bot, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, FileText, Loader2, ShieldAlert, Sparkles } from 'lucide-react';
import { useState } from 'react';

export function BuildStep(props: any) {
  const {
    wizardText,
    isVietnamese,
    enabledChartCount,
    enabledSectionCount,
    latestBuildThought,
    buildPhaseSummaryItems,
    getProcessPhaseStatusClass,
    formatProcessPhaseLabel,
    language,
    getProcessPhaseStatusLabel,
    recentBuildThoughts,
    getBuildEventBadgeClass,
    events,
    agentError,
    isBuildRunning,
    hasBuiltOutput,
    // New props for inline report
    buildResult,
    buildDashboardUrl,
    buildReportUrl,
  } = props;

  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});

  const insight = buildResult?.insight_report;
  const blueprint = buildResult?.dashboard_blueprint;

  // Extract chart creation events for the checklist
  const chartEvents = events.filter((e: any) => e.type === 'chart_created' || e.phase === 'building_charts');
  const createdChartCount = events.filter((e: any) => e.chart_id).length;
  const isDone = events.some((e: any) => e.type === 'done');
  const progressPercent = enabledChartCount > 0 ? Math.min(Math.round((createdChartCount / enabledChartCount) * 100), 100) : 0;

  function toggleSection(key: string) {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  // ─── State A: Build in progress ───
  if (isBuildRunning || (!isDone && !hasBuiltOutput && events.length === 0 && !buildResult)) {
    return (
      <div className="mx-auto max-w-2xl space-y-5">
        {/* Progress bar */}
        <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-blue-900">
              <Bot className="h-4 w-4" />
              {isBuildRunning
                ? (isVietnamese ? 'Agent đang build...' : 'Agent is building...')
                : (isVietnamese ? 'Sẵn sàng build' : 'Ready to build')}
            </div>
            {isBuildRunning && <Loader2 className="h-4 w-4 animate-spin text-blue-600" />}
          </div>

          {isBuildRunning && (
            <div>
              <div className="mb-2 flex items-center justify-between text-xs text-blue-700">
                <span>{createdChartCount}/{enabledChartCount} charts</span>
                <span>{progressPercent}%</span>
              </div>
              <div className="h-2 rounded-full bg-blue-100">
                <div className="h-2 rounded-full bg-blue-500 transition-all" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          )}

          {!isBuildRunning && (
            <p className="text-sm text-blue-800">
              {isVietnamese
                ? 'Bấm "Build Dashboard" ở thanh dưới để bắt đầu tạo dashboard từ plan đã duyệt.'
                : 'Click "Build Dashboard" in the footer to start creating the dashboard from the approved plan.'}
            </p>
          )}
        </div>

        {/* Phase checklist */}
        {buildPhaseSummaryItems.length > 0 && (
          <div className="space-y-1.5">
            {buildPhaseSummaryItems.map((item: any) => (
              <div
                key={item.phase}
                className={`flex items-center justify-between rounded-lg border px-4 py-2.5 text-sm ${getProcessPhaseStatusClass(item.status)}`}
              >
                <span className="font-medium">{formatProcessPhaseLabel(item.phase, language)}</span>
                <span className="text-[11px] font-semibold uppercase tracking-[0.16em]">
                  {getProcessPhaseStatusLabel(item.status, language)}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Event stream */}
        {events.length > 0 && (
          <div className="space-y-1.5">
            {events.map((event: any, index: number) => (
              <div key={`${event.type}-${index}`} className="flex items-start justify-between gap-3 rounded-lg border border-gray-100 bg-gray-50 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm text-gray-800">{event.message}</p>
                  {event.error && <p className="mt-1 text-xs text-rose-600">{event.error}</p>}
                </div>
                {event.chart_id && (
                  <span className="shrink-0 rounded bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                    #{event.chart_id}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Error */}
        {!isBuildRunning && agentError && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-900">
            <p className="font-semibold">{isVietnamese ? 'Build thất bại' : 'Build failed'}</p>
            <p className="mt-1">{agentError}</p>
            <p className="mt-2 text-rose-700">
              {isVietnamese
                ? 'Quay lại step trước để điều chỉnh plan rồi thử lại.'
                : 'Go back to adjust the plan and try again.'}
            </p>
          </div>
        )}
      </div>
    );
  }

  // ─── State B: Build complete → inline report ───
  return (
    <div className="space-y-6">
      {/* Success banner + CTA */}
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-emerald-100 p-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-emerald-900">
                {isVietnamese ? 'Dashboard đã sẵn sàng!' : 'Dashboard is ready!'}
              </h3>
              <p className="text-sm text-emerald-700">
                {buildResult?.created_chart_count ?? createdChartCount} {isVietnamese ? 'chart đã tạo' : 'charts created'}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {buildDashboardUrl && (
              <a
                href={buildDashboardUrl}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 transition"
              >
                <ExternalLink className="h-4 w-4" />
                {isVietnamese ? 'Mở Dashboard' : 'Open Dashboard'}
              </a>
            )}
            {buildReportUrl && (
              <a
                href={buildReportUrl}
                className="inline-flex items-center gap-2 rounded-lg border border-emerald-300 bg-white px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 transition"
              >
                <FileText className="h-4 w-4" />
                {isVietnamese ? 'Xem báo cáo đầy đủ' : 'Full report page'}
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Executive summary */}
      {(buildResult?.executive_summary || blueprint?.executive_summary) && (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-3 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-blue-600" />
            <h3 className="text-sm font-semibold text-gray-900">{isVietnamese ? 'Tóm tắt điều hành' : 'Executive summary'}</h3>
          </div>
          <p className="text-sm leading-relaxed text-gray-700">
            {buildResult?.executive_summary || blueprint?.executive_summary}
          </p>
        </div>
      )}

      {/* Top findings + Risks + Actions in grid */}
      {(insight?.top_findings?.length > 0 || insight?.headline_risks?.length > 0 || insight?.priority_actions?.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-3">
          {/* Findings */}
          {insight?.top_findings?.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="mb-3 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-blue-600" />
                <h3 className="text-sm font-semibold text-gray-900">{isVietnamese ? 'Phát hiện chính' : 'Top findings'}</h3>
              </div>
              <ul className="space-y-2">
                {insight.top_findings.map((item: string, i: number) => (
                  <li key={i} className="text-sm text-gray-700">• {item}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Risks */}
          {insight?.headline_risks?.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
              <div className="mb-3 flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-amber-700" />
                <h3 className="text-sm font-semibold text-amber-900">{isVietnamese ? 'Rủi ro' : 'Risks'}</h3>
              </div>
              <ul className="space-y-2">
                {insight.headline_risks.map((item: string, i: number) => (
                  <li key={i} className="text-sm text-amber-900">• {item}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Actions */}
          {insight?.priority_actions?.length > 0 && (
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-5">
              <div className="mb-3 flex items-center gap-2">
                <FileText className="h-4 w-4 text-blue-700" />
                <h3 className="text-sm font-semibold text-blue-900">{isVietnamese ? 'Hành động' : 'Actions'}</h3>
              </div>
              <ul className="space-y-2">
                {insight.priority_actions.map((item: string, i: number) => (
                  <li key={i} className="text-sm text-blue-900">• {item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Section narratives (collapsible) */}
      {insight?.section_insights?.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-5 py-4">
            <h3 className="text-sm font-semibold text-gray-900">
              {isVietnamese ? 'Phân tích theo section' : 'Section analysis'}
            </h3>
          </div>
          <div className="divide-y divide-gray-100">
            {insight.section_insights.map((section: any) => {
              const isOpen = expandedSections[section.section_title] ?? false;
              return (
                <div key={section.section_title}>
                  <button
                    type="button"
                    onClick={() => toggleSection(section.section_title)}
                    className="flex w-full items-center justify-between px-5 py-3.5 text-left hover:bg-gray-50"
                  >
                    <div className="flex items-center gap-3">
                      {isOpen ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
                      <div>
                        <p className="text-sm font-medium text-gray-900">{section.section_title}</p>
                        <p className="text-xs text-gray-500">{section.table_name}</p>
                      </div>
                    </div>
                    <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-600">
                      {Math.round(section.confidence * 100)}%
                    </span>
                  </button>
                  {isOpen && (
                    <div className="px-5 pb-4 pl-12">
                      <p className="text-sm leading-relaxed text-gray-700">{section.summary}</p>
                      {section.key_findings?.length > 0 && (
                        <div className="mt-3">
                          <p className="mb-1 text-xs font-semibold text-gray-500">{isVietnamese ? 'Phát hiện' : 'Findings'}</p>
                          <ul className="space-y-1">
                            {section.key_findings.map((f: string, i: number) => (
                              <li key={i} className="text-sm text-gray-600">• {f}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {section.caveats?.length > 0 && (
                        <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2">
                          <p className="mb-1 text-xs font-semibold text-amber-700">Caveats</p>
                          <ul className="space-y-1">
                            {section.caveats.map((c: string, i: number) => (
                              <li key={i} className="text-xs text-amber-800">• {c}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {section.recommended_actions?.length > 0 && (
                        <div className="mt-3">
                          <p className="mb-1 text-xs font-semibold text-gray-500">{isVietnamese ? 'Khuyến nghị' : 'Recommendations'}</p>
                          <ul className="space-y-1">
                            {section.recommended_actions.map((a: string, i: number) => (
                              <li key={i} className="text-sm text-gray-600">• {a}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Chart insights */}
      {insight?.chart_insights?.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-5 py-4">
            <h3 className="text-sm font-semibold text-gray-900">
              {isVietnamese ? 'Chi tiết từng biểu đồ' : 'Chart details'}
            </h3>
          </div>
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            {insight.chart_insights.map((chart: any) => (
              <div key={`${chart.chart_key}-${chart.chart_id ?? 'x'}`} className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{chart.title}</p>
                    <span className="text-[11px] uppercase text-gray-400">{chart.chart_type}</span>
                  </div>
                  <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[11px] text-gray-500">
                    {Math.round(chart.confidence * 100)}%
                  </span>
                </div>
                {chart.caption && (
                  <p className="text-sm font-medium text-gray-800">{chart.caption}</p>
                )}
                {chart.finding && (
                  <p className="mt-1 text-sm text-gray-600">{chart.finding}</p>
                )}
                {chart.evidence_summary && (
                  <p className="mt-1 text-xs text-gray-400">{chart.evidence_summary}</p>
                )}
                {chart.warning_if_any && (
                  <p className="mt-2 text-xs text-amber-700">⚠ {chart.warning_if_any}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
