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
        <div className="rounded-xl border border-brand/30 bg-brand/10/60 p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-brand">
              <Bot className="h-4 w-4" />
              {isBuildRunning
                ? (isVietnamese ? 'Agent đang build...' : 'Agent is building...')
                : (isVietnamese ? 'Sẵn sàng build' : 'Ready to build')}
            </div>
            {isBuildRunning && <Loader2 className="h-4 w-4 animate-spin text-brand" />}
          </div>

          {isBuildRunning && (
            <div>
              <div className="mb-2 flex items-center justify-between text-xs text-brand">
                <span>{createdChartCount}/{enabledChartCount} charts</span>
                <span>{progressPercent}%</span>
              </div>
              <div className="h-2 rounded-full bg-brand/15">
                <div className="h-2 rounded-full bg-brand transition-all" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          )}

          {!isBuildRunning && (
            <p className="text-sm text-brand">
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
              <div key={`${event.type}-${index}`} className="flex items-start justify-between gap-3 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm text-text-primary">{event.message}</p>
                  {event.error && <p className="mt-1 text-xs text-danger">{event.error}</p>}
                </div>
                {event.chart_id && (
                  <span className="shrink-0 rounded bg-success/15 px-2 py-0.5 text-[10px] font-bold text-success">
                    #{event.chart_id}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Error */}
        {!isBuildRunning && agentError && (
          <div className="rounded-xl border border-danger/30 bg-danger/10 p-5 text-sm text-danger">
            <p className="font-semibold">{isVietnamese ? 'Build thất bại' : 'Build failed'}</p>
            <p className="mt-1">{agentError}</p>
            <p className="mt-2 text-danger">
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
      <div className="rounded-xl border border-success/30 bg-success/10 p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-success/15 p-2">
              <CheckCircle2 className="h-5 w-5 text-success" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-success">
                {isVietnamese ? 'Dashboard đã sẵn sàng!' : 'Dashboard is ready!'}
              </h3>
              <p className="text-sm text-success">
                {buildResult?.created_chart_count ?? createdChartCount} {isVietnamese ? 'chart đã tạo' : 'charts created'}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {buildDashboardUrl && (
              <a
                href={buildDashboardUrl}
                className="inline-flex items-center gap-2 rounded-lg bg-success px-4 py-2 text-sm font-medium text-white hover:bg-success/90 transition"
              >
                <ExternalLink className="h-4 w-4" />
                {isVietnamese ? 'Mở Dashboard' : 'Open Dashboard'}
              </a>
            )}
            {buildReportUrl && (
              <a
                href={buildReportUrl}
                className="inline-flex items-center gap-2 rounded-lg border border-success/40 bg-surface-1 px-4 py-2 text-sm font-medium text-success transition hover:bg-success/10"
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
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
          <div className="mb-3 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-brand" />
            <h3 className="text-sm font-semibold text-text-primary">{isVietnamese ? 'Tóm tắt điều hành' : 'Executive summary'}</h3>
          </div>
          <p className="text-sm leading-relaxed text-text-secondary">
            {buildResult?.executive_summary || blueprint?.executive_summary}
          </p>
        </div>
      )}

      {/* Top findings + Risks + Actions in grid */}
      {(insight?.top_findings?.length > 0 || insight?.headline_risks?.length > 0 || insight?.priority_actions?.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-3">
          {/* Findings */}
          {insight?.top_findings?.length > 0 && (
            <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
              <div className="mb-3 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-brand" />
                <h3 className="text-sm font-semibold text-text-primary">{isVietnamese ? 'Phát hiện chính' : 'Top findings'}</h3>
              </div>
              <ul className="space-y-2">
                {insight.top_findings.map((item: string, i: number) => (
                  <li key={i} className="text-sm text-text-secondary">• {item}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Risks */}
          {insight?.headline_risks?.length > 0 && (
            <div className="rounded-xl border border-warning/30 bg-warning/10 p-5">
              <div className="mb-3 flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-warning" />
                <h3 className="text-sm font-semibold text-warning">{isVietnamese ? 'Rủi ro' : 'Risks'}</h3>
              </div>
              <ul className="space-y-2">
                {insight.headline_risks.map((item: string, i: number) => (
                  <li key={i} className="text-sm text-warning">• {item}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Actions */}
          {insight?.priority_actions?.length > 0 && (
            <div className="rounded-xl border border-brand/30 bg-brand/10 p-5">
              <div className="mb-3 flex items-center gap-2">
                <FileText className="h-4 w-4 text-brand" />
                <h3 className="text-sm font-semibold text-brand">{isVietnamese ? 'Hành động' : 'Actions'}</h3>
              </div>
              <ul className="space-y-2">
                {insight.priority_actions.map((item: string, i: number) => (
                  <li key={i} className="text-sm text-brand">• {item}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Section narratives (collapsible) */}
      {insight?.section_insights?.length > 0 && (
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
          <div className="border-b border-[rgb(var(--border-line))] px-5 py-4">
            <h3 className="text-sm font-semibold text-text-primary">
              {isVietnamese ? 'Phân tích theo section' : 'Section analysis'}
            </h3>
          </div>
          <div className="divide-y divide-[rgb(var(--border-line))]">
            {insight.section_insights.map((section: any) => {
              const isOpen = expandedSections[section.section_title] ?? false;
              return (
                <div key={section.section_title}>
                  <button
                    type="button"
                    onClick={() => toggleSection(section.section_title)}
                    className="flex w-full items-center justify-between px-5 py-3.5 text-left hover:bg-surface-2"
                  >
                    <div className="flex items-center gap-3">
                      {isOpen ? <ChevronDown className="h-4 w-4 text-text-quaternary" /> : <ChevronRight className="h-4 w-4 text-text-quaternary" />}
                      <div>
                        <p className="text-sm font-medium text-text-primary">{section.section_title}</p>
                        <p className="text-xs text-text-tertiary">{section.table_name}</p>
                      </div>
                    </div>
                    <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-text-secondary">
                      {Math.round(section.confidence * 100)}%
                    </span>
                  </button>
                  {isOpen && (
                    <div className="px-5 pb-4 pl-12">
                      <p className="text-sm leading-relaxed text-text-secondary">{section.summary}</p>
                      {section.key_findings?.length > 0 && (
                        <div className="mt-3">
                          <p className="mb-1 text-xs font-semibold text-text-tertiary">{isVietnamese ? 'Phát hiện' : 'Findings'}</p>
                          <ul className="space-y-1">
                            {section.key_findings.map((f: string, i: number) => (
                              <li key={i} className="text-sm text-text-secondary">• {f}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {section.caveats?.length > 0 && (
                        <div className="mt-3 rounded-lg border border-warning/20 bg-warning/10 px-3 py-2">
                          <p className="mb-1 text-xs font-semibold text-warning">Caveats</p>
                          <ul className="space-y-1">
                            {section.caveats.map((c: string, i: number) => (
                              <li key={i} className="text-xs text-warning">• {c}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {section.recommended_actions?.length > 0 && (
                        <div className="mt-3">
                          <p className="mb-1 text-xs font-semibold text-text-tertiary">{isVietnamese ? 'Khuyến nghị' : 'Recommendations'}</p>
                          <ul className="space-y-1">
                            {section.recommended_actions.map((a: string, i: number) => (
                              <li key={i} className="text-sm text-text-secondary">• {a}</li>
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
        <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
          <div className="border-b border-[rgb(var(--border-line))] px-5 py-4">
            <h3 className="text-sm font-semibold text-text-primary">
              {isVietnamese ? 'Chi tiết từng biểu đồ' : 'Chart details'}
            </h3>
          </div>
          <div className="grid gap-3 p-4 sm:grid-cols-2">
            {insight.chart_insights.map((chart: any) => (
              <div key={`${chart.chart_key}-${chart.chart_id ?? 'x'}`} className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-4">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-text-primary">{chart.title}</p>
                    <span className="text-[11px] uppercase text-text-quaternary">{chart.chart_type}</span>
                  </div>
                  <span className="shrink-0 rounded-full bg-surface-1 px-2 py-0.5 text-[11px] text-text-tertiary">
                    {Math.round(chart.confidence * 100)}%
                  </span>
                </div>
                {chart.caption && (
                  <p className="text-sm font-medium text-text-primary">{chart.caption}</p>
                )}
                {chart.finding && (
                  <p className="mt-1 text-sm text-text-secondary">{chart.finding}</p>
                )}
                {chart.evidence_summary && (
                  <p className="mt-1 text-xs text-text-quaternary">{chart.evidence_summary}</p>
                )}
                {chart.warning_if_any && (
                  <p className="mt-2 text-xs text-warning">⚠ {chart.warning_if_any}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
