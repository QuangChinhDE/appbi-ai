// @ts-nocheck
import { Bot, CheckCircle2, Eye, FileText, History, LayoutDashboard, ListChecks, PencilLine, Sparkles, Table2 } from 'lucide-react';
import { CollapsibleGuideCard } from './shared/CollapsibleGuideCard';

export function ReviewPlanStep(props: any) {
  const {
    draftPlan,
    setDraftPlan,
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
    planWorkspaceTabs,
    planWorkspaceTab,
    setPlanWorkspaceTab,
    describeChartConfig,
    sectionActiveCount,
    openGuides,
    toggleGuide,
    updateSection,
    updateChart,
  } = props;

  const warnings = Array.isArray(draftPlan?.warnings) ? draftPlan.warnings : [];
  const qualityBreakdownEntries = Object.entries(draftPlan?.quality_breakdown ?? {});
  const recentRunsSafe = Array.isArray(recentRuns) ? recentRuns : [];
  const datasetFitReport = Array.isArray(draftPlan?.dataset_fit_report) ? draftPlan.dataset_fit_report : [];
  const profilingReport = Array.isArray(draftPlan?.profiling_report) ? draftPlan.profiling_report : [];
  const sections = Array.isArray(draftPlan?.sections) ? draftPlan.sections : [];
  const charts = Array.isArray(draftPlan?.charts) ? draftPlan.charts : [];
  const parsedBriefSuccessCriteria = Array.isArray(draftPlan?.parsed_brief?.success_criteria)
    ? draftPlan.parsed_brief.success_criteria
    : [];
  const parsedBriefAssumptions = Array.isArray(draftPlan?.parsed_brief?.explicit_assumptions)
    ? draftPlan.parsed_brief.explicit_assumptions
    : [];
  const qualityGateBlockers = Array.isArray(draftPlan?.quality_gate_report?.blockers)
    ? draftPlan.quality_gate_report.blockers
    : [];
  const qualityGateWarnings = Array.isArray(draftPlan?.quality_gate_report?.warnings)
    ? draftPlan.quality_gate_report.warnings
    : [];
  const analysisPriorityChecks = Array.isArray(draftPlan?.analysis_plan?.priority_checks)
    ? draftPlan.analysis_plan.priority_checks
    : [];
  const analysisQuestionMap = Array.isArray(draftPlan?.analysis_plan?.question_map)
    ? draftPlan.analysis_plan.question_map
    : [];

  return (
  <div className="space-y-6">
    <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-2 text-gray-900">
          <PencilLine className="h-5 w-5 text-blue-600" />
            <h3 className="text-lg font-semibold">{wizardText.editableDraft}</h3>
        </div>
        <div className="space-y-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700">{wizardText.dashboardTitle}</label>
              <input
                value={draftPlan.dashboard_title}
                onChange={(event) => setDraftPlan((prev) => (prev ? { ...prev, dashboard_title: event.target.value } : prev))}
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700">{wizardText.dashboardSummary}</label>
              <textarea
                value={draftPlan.dashboard_summary}
                onChange={(event) => setDraftPlan((prev) => (prev ? { ...prev, dashboard_summary: event.target.value } : prev))}
                rows={4}
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
          </div>
          {draftPlan.strategy_summary && (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">{wizardText.strategySummary}</p>
              <p className="mt-2">{draftPlan.strategy_summary}</p>
            </div>
          )}
          {warnings.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {warnings.join(' ')}
            </div>
          )}
          {activeSpecId && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">
              {isVietnamese
                ? `Đang chỉnh sửa AI report #${activeSpecId}. Bạn có thể tiếp tục tinh chỉnh draft này và rerun sau.`
                : `Editing saved AI report #${activeSpecId}. You can keep refining this draft and rerun it later.`}
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
          <div className="flex items-center gap-2 text-gray-900">
            <LayoutDashboard className="h-5 w-5 text-blue-600" />
              <span className="text-sm font-semibold">{isVietnamese ? 'Section' : 'Sections'}</span>
          </div>
          <p className="mt-3 text-3xl font-semibold text-gray-900">{enabledSectionCount}</p>
          <p className="mt-1 text-sm text-gray-500">
            {isVietnamese ? 'số section sẽ được build từ draft hiện tại' : 'sections will be built from your current draft'}
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
          <div className="flex items-center gap-2 text-gray-900">
            <ListChecks className="h-5 w-5 text-blue-600" />
              <span className="text-sm font-semibold">{isVietnamese ? 'Chart đang bật' : 'Active charts'}</span>
          </div>
          <p className="mt-3 text-3xl font-semibold text-gray-900">{enabledChartCount}</p>
          <p className="mt-1 text-sm text-gray-500">
            {isVietnamese ? 'số chart đang bật cho build' : 'charts currently enabled for build'}
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-5">
          <div className="flex items-center gap-2 text-gray-900">
            <Sparkles className="h-5 w-5 text-blue-600" />
            <span className="text-sm font-semibold">{isVietnamese ? 'Điểm chất lượng' : 'Quality score'}</span>
          </div>
          <p className="mt-3 text-3xl font-semibold text-gray-900">{Math.round((draftPlan.quality_score ?? 0) * 100)}%</p>
          <div className="mt-3 grid gap-2 text-xs text-gray-500">
            {qualityBreakdownEntries.map(([key, value]) => (
              <div key={key} className="flex items-center justify-between">
                <span className="capitalize">{key.replace(/_/g, ' ')}</span>
                <span>{Math.round((value ?? 0) * 100)}%</span>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <label className="mb-2 block text-sm font-medium text-gray-700">{wizardText.buildMode}</label>
          <select
            value={buildMode}
            onChange={(event) => setBuildMode(event.target.value as AgentBuildMode)}
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          >
            <option value="new_dashboard">{wizardText.createNewDashboard}</option>
            <option value="new_version">{wizardText.createNewVersion}</option>
            <option value="replace_existing" disabled={!activeSpec?.latest_dashboard_id}>{wizardText.replaceLatestDashboard}</option>
          </select>
          <p className="mt-2 text-xs text-gray-500">
            {activeSpec?.latest_dashboard_id
              ? `${wizardText.latestDashboard}: #${activeSpec.latest_dashboard_id}`
              : wizardText.saveAndBuildFirst}
          </p>
        </div>
        {recentRunsSafe.length > 0 && (
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="mb-3 flex items-center gap-2 text-gray-900">
              <History className="h-5 w-5 text-blue-600" />
              <span className="text-sm font-semibold">{wizardText.recentRuns}</span>
            </div>
            <div className="space-y-3">
              {recentRunsSafe.map((run) => (
                <div key={run.id} className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        Run #{run.id} · {run.build_mode.replace(/_/g, ' ')}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        {new Date(run.created_at).toLocaleString('vi-VN')}
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] ${
                        run.status === 'succeeded'
                          ? 'bg-emerald-50 text-emerald-700'
                          : run.status === 'failed'
                            ? 'bg-rose-50 text-rose-700'
                            : 'bg-blue-50 text-blue-700'
                      }`}
                    >
                      {run.status}
                    </span>
                  </div>
                  {run.error && (
                    <p className="mt-2 text-xs text-rose-600">{run.error}</p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => router.push(`/ai-reports/${activeSpecId}`)}
                      className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                    >
                      <FileText className="h-3.5 w-3.5" />
                      {wizardText.readReport}
                    </button>
                    {run.dashboard_id && (
                      <button
                        type="button"
                        onClick={() => router.push(`/dashboards/${run.dashboard_id}`)}
                        className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                      >
                        <Eye className="h-3.5 w-3.5" />
                        {wizardText.editInDashboard}
                      </button>
                    )}
                    {run.result_summary_json?.created_chart_count != null && (
                      <span className="rounded-full bg-white px-2.5 py-1 text-[11px] text-gray-600">
                        {run.result_summary_json.created_chart_count} {wizardText.chartsBuilt}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>

    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h4 className="text-lg font-semibold text-gray-900">{wizardText.reviewWorkspace}</h4>
          <p className="mt-1 text-sm text-gray-500">{wizardText.reviewWorkspaceDesc}</p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {planWorkspaceTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setPlanWorkspaceTab(tab.key)}
              className={`rounded-lg border px-4 py-3 text-left transition ${
                planWorkspaceTab === tab.key
                  ? 'border-blue-300 bg-blue-50 text-blue-700'
                  : 'border-gray-200 bg-white text-gray-600 hover:border-blue-200 hover:bg-blue-50/40'
              }`}
            >
              <p className="text-sm font-semibold">{tab.label}</p>
              <p className={`mt-1 text-xs ${planWorkspaceTab === tab.key ? 'text-blue-600' : 'text-gray-400'}`}>
                {tab.caption}
              </p>
            </button>
          ))}
        </div>
      </div>
    </div>

    {(planWorkspaceTab === 'overview' || planWorkspaceTab === 'reasoning') && (
    <div className="grid gap-6 xl:grid-cols-2">
      {draftPlan.parsed_brief && planWorkspaceTab === 'overview' && (
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center gap-2 text-gray-900">
            <Bot className="h-5 w-5 text-blue-600" />
            <h4 className="text-lg font-semibold">{isVietnamese ? 'Cách Agent hiểu brief của bạn' : 'How the Agent understood your brief'}</h4>
          </div>
          <div className="space-y-4 text-sm text-gray-700">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">{isVietnamese ? 'Mục tiêu nghiệp vụ' : 'Business goal'}</p>
              <p className="mt-2 text-gray-900">{draftPlan.parsed_brief.business_goal}</p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.14em] text-gray-400">{isVietnamese ? 'Đối tượng đọc' : 'Audience'}</p>
                <p className="mt-2 font-medium text-gray-900">{draftPlan.parsed_brief.target_audience || (isVietnamese ? 'Đối tượng kinh doanh chung' : 'General business audience')}</p>
              </div>
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.14em] text-gray-400">{isVietnamese ? 'Phong cách report' : 'Report style'}</p>
                <p className="mt-2 font-medium capitalize text-gray-900">{(draftPlan.parsed_brief.report_style || 'executive').replace(/_/g, ' ')}</p>
              </div>
            </div>
            {parsedBriefSuccessCriteria.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">{isVietnamese ? 'Tiêu chí thành công' : 'Success criteria'}</p>
                <ul className="mt-2 space-y-2 text-gray-700">
                  {parsedBriefSuccessCriteria.map((item) => (
                    <li key={item}>- {item}</li>
                  ))}
                </ul>
              </div>
            )}
            {parsedBriefAssumptions.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-700">{isVietnamese ? 'Giả định' : 'Assumptions'}</p>
                <ul className="mt-2 space-y-2 text-sm">
                  {parsedBriefAssumptions.map((item) => (
                    <li key={item}>- {item}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {draftPlan.quality_gate_report && planWorkspaceTab === 'overview' && (
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center gap-2 text-gray-900">
            <CheckCircle2 className="h-5 w-5 text-blue-600" />
            <h4 className="text-lg font-semibold">{isVietnamese ? 'Cổng kiểm tra chất lượng dữ liệu' : 'Data quality gate'}</h4>
          </div>
          <div className="space-y-4 text-sm text-gray-700">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
                {draftPlan.quality_gate_report.overall_status.replace(/_/g, ' ')}
              </span>
              <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-600">
                {isVietnamese
                  ? `${Object.keys(draftPlan.quality_gate_report.confidence_penalties ?? {}).length} cờ giảm confidence ở cấp bảng`
                  : `${Object.keys(draftPlan.quality_gate_report.confidence_penalties ?? {}).length} table-level penalty flag${Object.keys(draftPlan.quality_gate_report.confidence_penalties ?? {}).length === 1 ? '' : 's'}`}
              </span>
            </div>
            <p className="text-gray-900">{draftPlan.quality_gate_report.quality_summary}</p>
            {qualityGateBlockers.length > 0 && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-rose-800">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-rose-700">{isVietnamese ? 'Điểm chặn' : 'Blockers'}</p>
                <ul className="mt-2 space-y-2 text-sm">
                  {qualityGateBlockers.map((item) => (
                    <li key={item}>- {item}</li>
                  ))}
                </ul>
              </div>
            )}
            {qualityGateWarnings.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">{isVietnamese ? 'Cảnh báo' : 'Warnings'}</p>
                <ul className="mt-2 space-y-2">
                  {qualityGateWarnings.map((item) => (
                    <li key={item}>- {item}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {datasetFitReport.length > 0 && planWorkspaceTab === 'reasoning' && (
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm xl:col-span-2">
          <div className="mb-4 flex items-center gap-2 text-gray-900">
            <Table2 className="h-5 w-5 text-blue-600" />
            <h4 className="text-lg font-semibold">{isVietnamese ? 'Vì sao Agent dùng các bảng này' : 'Why the Agent is using these tables'}</h4>
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            {datasetFitReport.map((item) => (
              <div key={`${item.workspace_id}:${item.table_id}`} className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-gray-400">{item.workspace_name}</p>
                    <p className="mt-1 text-base font-semibold text-gray-900">{item.table_name}</p>
                  </div>
                  <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
                    {Math.round(item.fit_score * 100)}% fit
                  </span>
                </div>
                <p className="mt-3 text-sm text-gray-700">
                  {isVietnamese ? 'Vai trò gợi ý:' : 'Suggested role:'} <span className="font-medium capitalize text-gray-900">{item.suggested_role.replace(/_/g, ' ')}</span>
                </p>
                {item.notes && <p className="mt-2 text-sm text-gray-600">{item.notes}</p>}
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">{isVietnamese ? 'Phù hợp cho' : 'Good for'}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {(Array.isArray(item.good_for) ? item.good_for : []).map((note) => (
                        <span key={note} className="rounded-full bg-white px-3 py-1 text-xs text-gray-700">{note}</span>
                      ))}
                    </div>
                  </div>
                  {item.metadata_risk && item.metadata_risk !== 'low' && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">{isVietnamese ? 'Rủi ro metadata' : 'Metadata risk'}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <span className="rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-800">{item.metadata_risk}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {draftPlan.analysis_plan && planWorkspaceTab === 'reasoning' && (
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center gap-2 text-gray-900">
            <ListChecks className="h-5 w-5 text-blue-600" />
            <h4 className="text-lg font-semibold">{isVietnamese ? 'Logic phân tích' : 'Analysis logic'}</h4>
          </div>
          <div className="space-y-4 text-sm text-gray-700">
            <p className="text-gray-900">{draftPlan.analysis_plan.business_thesis}</p>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">{isVietnamese ? 'Kiểm tra ưu tiên' : 'Priority checks'}</p>
              <ul className="mt-2 space-y-2">
                {analysisPriorityChecks.map((item) => (
                  <li key={item}>- {item}</li>
                ))}
              </ul>
            </div>
            {analysisQuestionMap.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">{isVietnamese ? 'Ánh xạ câu hỏi' : 'Question mapping'}</p>
                <div className="mt-2 space-y-3">
                  {analysisQuestionMap.map((item) => (
                    <div key={item.question} className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                      <p className="font-medium text-gray-900">{item.question}</p>
                      <p className="mt-1 text-xs uppercase tracking-[0.14em] text-gray-500">{item.suggested_method}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {profilingReport.length > 0 && planWorkspaceTab === 'reasoning' && (
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center gap-2 text-gray-900">
            <Sparkles className="h-5 w-5 text-blue-600" />
            <h4 className="text-lg font-semibold">{isVietnamese ? 'Những gì Agent tìm thấy trong dữ liệu' : 'What the Agent found in the data'}</h4>
          </div>
          <div className="space-y-3">
            {profilingReport.map((item) => (
              <div key={`${item.workspace_id}:${item.table_id}`} className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-gray-900">{item.table_name}</p>
                    <p className="mt-1 text-xs uppercase tracking-[0.16em] text-gray-500">{item.workspace_name}</p>
                  </div>
                  <span className="rounded-full bg-white px-3 py-1 text-xs text-gray-600">{item.table_grain}</span>
                </div>
                <p className="mt-2 text-sm text-gray-700">{item.semantic_summary || (isVietnamese ? 'Agent đã rút ra candidate metric, dimension và data shape từ các dòng sample.' : 'The Agent extracted candidate metrics, dimensions, and data shape from the sampled rows.')}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(Array.isArray(item.candidate_metrics) ? item.candidate_metrics : []).slice(0, 3).map((metric) => (
                    <span key={metric} className="rounded-full bg-blue-50 px-3 py-1 text-xs text-blue-700">{metric}</span>
                  ))}
                  {(Array.isArray(item.candidate_dimensions) ? item.candidate_dimensions : []).slice(0, 3).map((dimension) => (
                    <span key={dimension} className="rounded-full bg-white px-3 py-1 text-xs text-gray-700">{dimension}</span>
                  ))}
                  {(Array.isArray(item.null_risk_columns) ? item.null_risk_columns : []).slice(0, 2).map((risk) => (
                    <span key={risk} className="rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-800">{risk}</span>
                  ))}
                  {(Array.isArray(item.risk_flags) ? item.risk_flags : []).slice(0, 2).map((risk) => (
                    <span key={risk} className="rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-800">{risk}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
    )}

    {planWorkspaceTab === 'sections' && (
    <div className="grid gap-6 lg:grid-cols-[0.92fr_1.08fr]">
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h4 className="text-lg font-semibold text-gray-900">{isVietnamese ? 'Section' : 'Sections'}</h4>
              <p className="mt-1 text-sm text-gray-500">{isVietnamese ? 'Tinh chỉnh cấu trúc narrative trước khi build.' : 'Refine the narrative structure before building.'}</p>
            </div>
          </div>
          <div className="space-y-4">
            {sections.map((section, index) => {
              const activeCharts = sectionActiveCount(section, charts);
              return (
                <div key={`${section.workspace_id}:${section.workspace_table_id}`} className="rounded-lg border border-gray-200 p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.16em] text-gray-400">
                        {section.workspace_name} / {section.table_name}
                      </p>
                      <p className="mt-1 text-sm font-medium text-gray-900">{isVietnamese ? `${activeCharts} chart đang bật` : `${activeCharts} active chart${activeCharts !== 1 ? 's' : ''}`}</p>
                    </div>
                    <span className="rounded-full bg-gray-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-600">
                      {isVietnamese ? 'Section' : 'Section'}
                    </span>
                  </div>

                  <div className="space-y-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium uppercase tracking-[0.14em] text-gray-500">{isVietnamese ? 'Tiêu đề' : 'Title'}</label>
                      <input
                        value={section.title}
                        onChange={(event) => updateSection(index, { title: event.target.value })}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium uppercase tracking-[0.14em] text-gray-500">{isVietnamese ? 'Ý định' : 'Intent'}</label>
                      <textarea
                        value={section.intent}
                        onChange={(event) => updateSection(index, { intent: event.target.value })}
                        rows={3}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      />
                    </div>
                    {section.why_this_section && (
                      <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-3 text-sm text-blue-900">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">{isVietnamese ? 'Vì sao chọn section này' : 'Why this section'}</p>
                        <p className="mt-2">{section.why_this_section}</p>
                      </div>
                    )}
                    {section.questions_covered?.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {section.questions_covered.map((question) => (
                          <span key={question} className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">
                            {question}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {(Array.isArray(section.chart_keys) ? section.chart_keys : []).map((chartKey) => {
                        const chart = charts.find((item) => item.key === chartKey);
                        if (!chart) return null;
                        return (
                          <span
                            key={chartKey}
                            className={`rounded-full px-3 py-1 text-xs font-medium ${
                              chart.enabled
                                ? 'bg-blue-50 text-blue-700'
                                : 'bg-gray-100 text-gray-400 line-through'
                            }`}
                          >
                            {chart.title}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

      <CollapsibleGuideCard
        title={isVietnamese ? 'Ghi chú khi duyệt section' : 'Section review notes'}
        description={isVietnamese ? 'Chỉ mở khi bạn muốn nhắc lại cách siết câu chuyện. Nếu không, hãy thu gọn để nhường canvas cho phần sửa section.' : 'Use this only when you want a reminder of how to tighten the story. Otherwise collapse it and keep the canvas for section editing.'}
        icon={<LayoutDashboard className="h-5 w-5" />}
        isOpen={openGuides['sections-guide']}
        onToggle={() => toggleGuide('sections-guide')}
        badge={isVietnamese ? 'Hướng dẫn' : 'Guide'}
      >
        <div className="space-y-3 text-sm text-gray-600">
          <p>{isVietnamese ? '- Giữ tiêu đề section theo hướng outcome, không chỉ theo tên field.' : '- Keep section titles outcome-oriented, not field-oriented.'}</p>
          <p>{isVietnamese ? '- Dùng ô intent để nói rõ mỗi section giúp người đọc quyết định điều gì.' : '- Use the intent box to say what each section should help the reader decide.'}</p>
          <p>{isVietnamese ? '- Để phần chart sang tab riêng để màn này giữ được sự tập trung.' : '- Leave charts for the dedicated charts tab so this screen stays focused.'}</p>
        </div>
      </CollapsibleGuideCard>
    </div>
    )}

    {planWorkspaceTab === 'charts' && (
    <div className="grid gap-6 lg:grid-cols-[0.32fr_0.68fr]">
      <CollapsibleGuideCard
        title={isVietnamese ? 'Ghi chú khi duyệt chart' : 'Chart review notes'}
        description={isVietnamese ? 'Thu gọn phần này khi bạn đã nắm các rule of thumb. Cột chính nên tập trung vào quyết định giữ hay bỏ chart.' : 'Collapse this once you know the rules of thumb. The main column should stay focused on chart decisions.'}
        icon={<ListChecks className="h-5 w-5" />}
        isOpen={openGuides['charts-guide']}
        onToggle={() => toggleGuide('charts-guide')}
        badge={isVietnamese ? 'Hướng dẫn' : 'Guide'}
      >
        <div className="space-y-3 text-sm text-gray-600">
          <p>{isVietnamese ? '- Tắt các chart lặp lại cùng một tín hiệu.' : '- Disable charts that repeat the same signal.'}</p>
          <p>{isVietnamese ? '- Đổi tên chart để người đọc hiểu ngay cả khi chưa mở config.' : '- Rename charts so a reader understands them without opening the config.'}</p>
          <p>{isVietnamese ? '- Dùng confidence và rationale để phát hiện chart yếu trước khi build.' : '- Use confidence and rationale to spot weak charts before you build.'}</p>
        </div>
      </CollapsibleGuideCard>
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h4 className="text-lg font-semibold text-gray-900">{isVietnamese ? 'Các chart Agent sẽ build' : 'Charts the Agent will build'}</h4>
              <p className="mt-1 text-sm text-gray-500">{isVietnamese ? 'Bạn có thể đổi tên, giữ lại hoặc bỏ chart trước khi build.' : 'You can rename, keep, or skip charts before building.'}</p>
            </div>
            <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
              {isVietnamese ? 'Chế độ duyệt' : 'Review mode'}
            </span>
          </div>
          <div className="space-y-4">
            {charts.map((chart) => {
              const configNotes = describeChartConfig(chart);
              return (
              <div
                key={chart.key}
                className={`rounded-lg border p-4 transition ${
                  chart.enabled ? 'border-gray-200 bg-white' : 'border-gray-200 bg-gray-50'
                }`}
              >
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => updateChart(chart.key, { enabled: !chart.enabled })}
                      className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] transition ${
                      chart.enabled
                        ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                          : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                      }`}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {chart.enabled ? (isVietnamese ? 'Sẽ được build' : 'Included in build') : (isVietnamese ? 'Tạm bỏ qua' : 'Skipped for now')}
                    </button>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-gray-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-600">
                        {chart.chart_type}
                      </span>
                      <span className="rounded-full bg-gray-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500">
                        {chart.workspace_name}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium uppercase tracking-[0.14em] text-gray-500">{isVietnamese ? 'Tên chart' : 'Chart title'}</label>
                      <input
                        value={chart.title}
                        onChange={(event) => updateChart(chart.key, { title: event.target.value })}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium uppercase tracking-[0.14em] text-gray-500">{isVietnamese ? 'Lý do chọn' : 'Rationale'}</label>
                      <textarea
                        value={chart.rationale}
                        onChange={(event) => updateChart(chart.key, { rationale: event.target.value })}
                        rows={3}
                        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                      />
                    </div>
                    {chart.why_this_chart && (
                      <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-3 text-sm text-blue-900">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">{isVietnamese ? 'Vì sao chọn chart này' : 'Why this chart'}</p>
                        <p className="mt-2">{chart.why_this_chart}</p>
                      </div>
                    )}
                    <div className="grid gap-3 md:grid-cols-3">
                      <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3">
                        <p className="text-xs uppercase tracking-[0.14em] text-gray-400">{isVietnamese ? 'Độ tin cậy' : 'Confidence'}</p>
                        <p className="mt-2 text-sm font-semibold text-gray-900">{Math.round((chart.confidence ?? 0) * 100)}%</p>
                      </div>
                      <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3">
                        <p className="text-xs uppercase tracking-[0.14em] text-gray-400">{isVietnamese ? 'Tín hiệu kỳ vọng' : 'Expected signal'}</p>
                        <p className="mt-2 text-sm text-gray-700">{chart.expected_signal || (isVietnamese ? 'Tín hiệu hiệu suất tổng quát' : 'General performance signal')}</p>
                      </div>
                      <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3">
                        <p className="text-xs uppercase tracking-[0.14em] text-gray-400">{isVietnamese ? 'Phương án thay thế đã cân nhắc' : 'Alternative considered'}</p>
                        <p className="mt-2 text-sm text-gray-700">{chart.alternative_considered || (isVietnamese ? 'Chưa ghi nhận' : 'None noted')}</p>
                      </div>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.16em] text-gray-400">
                        {chart.workspace_name} / {chart.table_name}
                      </p>
                      {configNotes.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {configNotes.map((note) => (
                            <span key={note} className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-600">
                              {note}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
      </div>
    </div>
    )}
  </div>
  );
}
