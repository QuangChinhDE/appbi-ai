// @ts-nocheck
import { CheckCircle2, ChevronDown, ChevronRight, Eye, EyeOff, PencilLine, ShieldAlert, Sparkles } from 'lucide-react';
import { useState } from 'react';

export function ReviewPlanStep(props: any) {
  const {
    draftPlan,
    setDraftPlan,
    selectedDomain,
    activeSpecId,
    activeSpec,
    recentRuns,
    router,
    isVietnamese,
    wizardText,
    enabledSectionCount,
    enabledChartCount,
    buildMode,
    setBuildMode,
    planDatasetTabs,
    planDatasetTab,
    setPlanDatasetTab,
    describeChartConfig,
    sectionActiveCount,
    openGuides,
    toggleGuide,
    updateSection,
    updateChart,
  } = props;

  const [techOpen, setTechOpen] = useState(false);

  const warnings = Array.isArray(draftPlan?.warnings) ? draftPlan.warnings : [];
  const sections = Array.isArray(draftPlan?.sections) ? draftPlan.sections : [];
  const charts = Array.isArray(draftPlan?.charts) ? draftPlan.charts : [];
  const datasetFitReport = Array.isArray(draftPlan?.dataset_fit_report) ? draftPlan.dataset_fit_report : [];
  const profilingReport = Array.isArray(draftPlan?.profiling_report) ? draftPlan.profiling_report : [];
  const qualityGateBlockers = Array.isArray(draftPlan?.quality_gate_report?.blockers) ? draftPlan.quality_gate_report.blockers : [];
  const qualityGateWarnings = Array.isArray(draftPlan?.quality_gate_report?.warnings) ? draftPlan.quality_gate_report.warnings : [];
  const analysisQuestionMap = Array.isArray(draftPlan?.analysis_plan?.question_map) ? draftPlan.analysis_plan.question_map : [];
  const thesis = draftPlan?.thesis;
  const thesisArguments = Array.isArray(draftPlan?.thesis?.supporting_arguments) ? draftPlan.thesis.supporting_arguments : [];
  const narrativeFlow = Array.isArray(draftPlan?.analysis_plan?.narrative_flow) ? draftPlan.analysis_plan.narrative_flow : [];
  const qualityBreakdownEntries = Object.entries(draftPlan?.quality_breakdown ?? {});
  const parsedBriefSuccessCriteria = Array.isArray(draftPlan?.parsed_brief?.success_criteria) ? draftPlan.parsed_brief.success_criteria : [];
  const parsedBriefAssumptions = Array.isArray(draftPlan?.parsed_brief?.explicit_assumptions) ? draftPlan.parsed_brief.explicit_assumptions : [];
  const recentRunsSafe = Array.isArray(recentRuns) ? recentRuns : [];
  const domainLabel = selectedDomain?.label ?? draftPlan?.domain_id ?? activeSpec?.domain_id ?? 'Finance';
  const domainVersion = draftPlan?.domain_version ?? draftPlan?.parsed_brief?.domain_version ?? activeSpec?.domain_version ?? selectedDomain?.version;
  const domainLens = selectedDomain?.reviewLens?.[isVietnamese ? 'vi' : 'en'];

  const CHART_TYPE_COLORS = {
    KPI: 'bg-brand/10 text-brand border-brand/30',
    BAR: 'bg-brand/10 text-brand border-brand/30',
    LINE: 'bg-cyan-50 text-cyan-700 border-cyan-200',
    TIME_SERIES: 'bg-cyan-50 text-cyan-700 border-cyan-200',
    AREA: 'bg-teal-50 text-teal-700 border-teal-200',
    PIE: 'bg-warning/10 text-warning border-warning/30',
    TABLE: 'bg-surface-2 text-text-secondary border-[rgb(var(--border-line))]',
    GROUPED_BAR: 'bg-brand/10 text-brand border-brand/30',
    STACKED_BAR: 'bg-brand/10 text-brand border-brand/30',
  };

  return (
    <div className="space-y-6">
      {/* ── Header: title + summary + stats ── */}
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-5 shadow-linear-sm">
        <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-success/30 bg-success/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-success">
                {domainLabel}
              </span>
              {domainVersion && (
                <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 py-1 text-[11px] font-medium text-text-tertiary">
                  v{domainVersion}
                </span>
              )}
              {domainLens && (
                <span className="text-xs text-text-tertiary">{domainLens}</span>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.16em] text-text-quaternary">
                {isVietnamese ? 'Tiêu đề dashboard' : 'Dashboard title'}
              </label>
              <input
                value={draftPlan.dashboard_title}
                onChange={(e) => setDraftPlan((prev) => (prev ? { ...prev, dashboard_title: e.target.value } : prev))}
                className="w-full rounded-lg border border-[rgb(var(--border-line))] px-3 py-2 text-base font-semibold text-text-primary outline-none transition focus:border-brand/40 focus:ring-2 focus:ring-brand"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.16em] text-text-quaternary">
                {isVietnamese ? 'Tóm tắt' : 'Summary'}
              </label>
              <textarea
                rows={2}
                value={draftPlan.dashboard_summary}
                onChange={(e) => setDraftPlan((prev) => (prev ? { ...prev, dashboard_summary: e.target.value } : prev))}
                className="w-full rounded-lg border border-[rgb(var(--border-line))] px-3 py-2 text-sm text-text-secondary outline-none transition focus:border-brand/40 focus:ring-2 focus:ring-brand"
              />
            </div>
          </div>

          {/* Stats + build mode */}
          <div className="flex flex-wrap items-start gap-3 lg:flex-col lg:items-end">
            <div className="flex items-center gap-4">
              <div className="text-center">
                <p className="text-2xl font-bold text-text-primary">{enabledSectionCount}</p>
                <p className="text-[11px] text-text-quaternary">{isVietnamese ? 'section' : 'sections'}</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-text-primary">{enabledChartCount}</p>
                <p className="text-[11px] text-text-quaternary">{isVietnamese ? 'chart' : 'charts'}</p>
              </div>
              {typeof draftPlan.quality_score === 'number' && (
                <div className="text-center">
                  <p className="text-2xl font-bold text-success">{Math.round(draftPlan.quality_score * 100)}%</p>
                  <p className="text-[11px] text-text-quaternary">{isVietnamese ? 'chất lượng' : 'quality'}</p>
                </div>
              )}
            </div>
            <select
              value={buildMode}
              onChange={(e) => setBuildMode(e.target.value)}
              className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 text-xs font-medium text-text-secondary outline-none focus:border-brand/40"
            >
              <option value="new_dashboard">{isVietnamese ? 'Tạo dashboard mới' : 'New dashboard'}</option>
              <option value="new_version">{isVietnamese ? 'Tạo version mới' : 'New version'}</option>
              <option value="replace_existing">{isVietnamese ? 'Thay thế dashboard' : 'Replace existing'}</option>
            </select>
          </div>
        </div>
      </div>

      {(thesis?.central_thesis || draftPlan?.analysis_plan?.business_thesis) && (
        <div className="rounded-xl border border-brand/30 bg-brand/10/60 p-5 shadow-linear-sm">
          <div className="flex items-start gap-3">
            <div className="rounded-lg bg-surface-1 p-2 text-brand shadow-linear-sm">
              <Sparkles className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand">
                {isVietnamese ? 'Luan diem trung tam' : 'Central thesis'}
              </p>
              <p className="mt-2 text-sm font-medium leading-6 text-text-primary">
                {thesis?.central_thesis || draftPlan?.analysis_plan?.business_thesis}
              </p>
              {(thesis?.narrative_arc || narrativeFlow[0]) && (
                <p className="mt-3 text-sm leading-6 text-text-secondary">
                  <span className="font-semibold text-text-primary">Narrative arc:</span>{' '}
                  {thesis?.narrative_arc || narrativeFlow[0]}
                </p>
              )}
              {thesisArguments.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {thesisArguments.map((item, index) => (
                    <span
                      key={`${item}-${index}`}
                      className="rounded-full border border-brand/30 bg-surface-1 px-3 py-1 text-[11px] font-medium text-brand"
                    >
                      {item}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Sections with inline chart cards ── */}
      {sections.map((section, sIndex) => {
        const sectionCharts = charts.filter((c) => section.chart_keys?.includes(c.key));
        const activeCount = sectionCharts.filter((c) => c.enabled !== false).length;

        return (
          <div key={section.title + sIndex} className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
            {/* Section header */}
            <div className="border-b border-[rgb(var(--border-line))] px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-text-primary">{section.title}</h3>
                  {section.intent && (
                    <p className="mt-1 text-sm text-text-tertiary">{section.intent}</p>
                  )}
                  {section.why_this_section && (
                    <p className="mt-1 text-xs text-text-quaternary">{section.why_this_section}</p>
                  )}
                </div>
                <span className="shrink-0 rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-medium text-text-secondary">
                  {activeCount}/{sectionCharts.length} {isVietnamese ? 'chart' : 'charts'}
                </span>
              </div>
              {section.questions_covered?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {section.questions_covered.map((q, qi) => (
                    <span key={qi} className="rounded-full border border-brand/20 bg-brand/10 px-2.5 py-0.5 text-[11px] text-brand">
                      {q}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Chart cards — horizontal flow */}
            <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
              {sectionCharts.map((chart) => {
                const isEnabled = chart.enabled !== false;
                const colorClass = CHART_TYPE_COLORS[chart.chart_type] || CHART_TYPE_COLORS.TABLE;
                const configLines = describeChartConfig(chart);

                return (
                  <div
                    key={chart.key}
                    className={`rounded-lg border p-3.5 transition ${
                      isEnabled ? 'border-[rgb(var(--border-line))] bg-surface-1' : 'border-dashed border-[rgb(var(--border-line))] bg-surface-2 opacity-60'
                    }`}
                  >
                    {/* Chart type badge + toggle */}
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className={`rounded-md border px-2 py-0.5 text-[11px] font-bold uppercase ${colorClass}`}>
                        {chart.chart_type}
                      </span>
                      <button
                        type="button"
                        onClick={() => updateChart(chart.key, { enabled: !isEnabled })}
                        className={`rounded-md p-1 transition ${
                          isEnabled
                            ? 'text-success hover:bg-success/10'
                            : 'text-text-quaternary hover:bg-surface-2'
                        }`}
                        title={isEnabled
                          ? (isVietnamese ? 'Bỏ chart này' : 'Disable chart')
                          : (isVietnamese ? 'Bật lại chart' : 'Enable chart')}
                      >
                        {isEnabled ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                      </button>
                    </div>

                    {/* Title (editable) */}
                    <input
                      value={chart.title}
                      onChange={(e) => updateChart(chart.key, { title: e.target.value })}
                      className="mb-1.5 w-full bg-transparent text-sm font-medium text-text-primary outline-none focus:underline"
                    />

                    {/* Config summary */}
                    {configLines.length > 0 && (
                      <div className="space-y-0.5">
                        {configLines.map((line, li) => (
                          <p key={li} className="text-[11px] text-text-tertiary">{line}</p>
                        ))}
                      </div>
                    )}

                    {/* Hypothesis */}
                    {chart.hypothesis && (
                      <p className="mt-2 text-[11px] italic text-text-quaternary">{chart.hypothesis}</p>
                    )}

                    {/* Confidence */}
                    {typeof chart.confidence === 'number' && (
                      <div className="mt-2 flex items-center gap-1.5">
                        <div className="h-1 flex-1 rounded-full bg-surface-2">
                          <div
                            className="h-1 rounded-full bg-success/60"
                            style={{ width: `${Math.round(chart.confidence * 100)}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-text-quaternary">{Math.round(chart.confidence * 100)}%</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* ── Warnings ── */}
      {(warnings.length > 0 || qualityGateBlockers.length > 0) && (
        <div className="rounded-xl border border-warning/30 bg-warning/10 p-5">
          <div className="mb-3 flex items-center gap-2 text-warning">
            <ShieldAlert className="h-5 w-5" />
            <h3 className="text-sm font-semibold">{isVietnamese ? 'Lưu ý từ AI' : 'AI warnings'}</h3>
          </div>
          <ul className="space-y-1.5 text-sm text-warning">
            {qualityGateBlockers.map((item, i) => (
              <li key={`b-${i}`} className="flex items-start gap-2">
                <span className="mt-0.5 shrink-0 rounded bg-danger/15 px-1.5 py-0.5 text-[10px] font-bold text-danger">BLOCKER</span>
                <span>{item}</span>
              </li>
            ))}
            {warnings.map((item, i) => (
              <li key={`w-${i}`}>• {item}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Collapsible technical details ── */}
      <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
        <button
          type="button"
          onClick={() => setTechOpen(!techOpen)}
          className="flex w-full items-center justify-between px-5 py-4 text-left"
        >
          <span className="text-sm font-medium text-text-secondary">
            {isVietnamese ? 'Chi tiết kỹ thuật' : 'Technical details'}
          </span>
          {techOpen ? <ChevronDown className="h-4 w-4 text-text-quaternary" /> : <ChevronRight className="h-4 w-4 text-text-quaternary" />}
        </button>

        {techOpen && (
          <div className="space-y-4 border-t border-[rgb(var(--border-line))] px-5 py-4">
            {/* Quality breakdown */}
            {qualityBreakdownEntries.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-text-quaternary">
                  {isVietnamese ? 'Phân tích chất lượng' : 'Quality breakdown'}
                </p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {qualityBreakdownEntries.map(([key, value]) => (
                    <div key={key} className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
                      <p className="text-[11px] text-text-tertiary">{key.replace(/_/g, ' ')}</p>
                      <p className="text-sm font-semibold text-text-primary">{Math.round(Number(value) * 100)}%</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Dataset fit */}
            {datasetFitReport.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-text-quaternary">
                  {isVietnamese ? 'Độ phù hợp của bảng' : 'Dataset fit'}
                </p>
                <div className="space-y-2">
                  {datasetFitReport.map((item) => (
                    <div key={item.table_id} className="flex items-center justify-between rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
                      <div>
                        <p className="text-sm font-medium text-text-primary">{item.table_name}</p>
                        <p className="text-[11px] text-text-tertiary">{item.suggested_role?.replace(/_/g, ' ')}</p>
                      </div>
                      <span className="rounded-full bg-surface-1 px-2.5 py-0.5 text-xs font-semibold text-text-secondary">
                        {Math.round(item.fit_score * 100)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Analysis question map */}
            {analysisQuestionMap.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-text-quaternary">
                  {isVietnamese ? 'Ánh xạ câu hỏi' : 'Question mapping'}
                </p>
                <div className="space-y-2">
                  {analysisQuestionMap.map((item, i) => (
                    <div key={i} className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
                      <p className="text-sm text-text-primary">{item.question}</p>
                      <p className="mt-1 text-[11px] text-text-tertiary">
                        {item.target_table_name} — {item.suggested_method}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Profiling */}
            {profilingReport.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-text-quaternary">
                  {isVietnamese ? 'Profile dữ liệu' : 'Data profiling'}
                </p>
                <div className="space-y-2">
                  {profilingReport.map((item) => (
                    <div key={item.table_id} className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2">
                      <p className="text-sm font-medium text-text-primary">{item.table_name}</p>
                      <p className="mt-1 text-[11px] text-text-tertiary">
                        {item.column_count} {isVietnamese ? 'cột' : 'columns'} · {item.row_sample_count} {isVietnamese ? 'dòng mẫu' : 'sample rows'} · {item.table_grain}
                      </p>
                      {item.candidate_metrics?.length > 0 && (
                        <p className="mt-1 text-[11px] text-text-quaternary">
                          Metrics: {item.candidate_metrics.slice(0, 4).join(', ')}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
