// @ts-nocheck
import { ArrowLeft, Bot, ChevronDown, ChevronRight, ChevronUp, Eye, Info, ListChecks, Sparkles } from 'lucide-react';
import { CollapsibleGuideCard } from './shared/CollapsibleGuideCard';

export function BriefStep(props: any) {
  const {
    isVietnamese,
    language,
    wizardText,
    isPlanningLocked,
    briefPresets,
    applyBriefPreset,
    briefSectionMeta,
    visibleBriefSections,
    activeBriefSection,
    setActiveBriefSection,
    briefSectionProgress,
    activeBriefSectionMeta,
    activeBriefFocus,
    activeBriefProgress,
    activeBriefSectionIndex,
    collapseOptionalBriefSections,
    openAllBriefSections,
    briefDockTabs,
    briefDockTab,
    setBriefDockTab,
    agentUnderstandingPreview,
    selectedTables,
    selectedTableCards,
    briefKpis,
    briefQuestions,
    readinessCount,
    readinessChecks,
    openGuides,
    toggleGuide,
    planMutation,
    planningEvents,
    planningPhaseSummary,
    latestPlanningThought,
    recentPlanningThoughts,
    formatProcessPhaseLabel,
    getProcessPhaseStatusClass,
    getProcessPhaseStatusLabel,
    getPlanEventBadgeClass,
    reportName,
    setReportName,
    reportType,
    setReportType,
    goal,
    setGoal,
    audience,
    setAudience,
    timeframe,
    setTimeframe,
    whyNow,
    setWhyNow,
    businessBackground,
    setBusinessBackground,
    kpisText,
    setKpisText,
    questionsText,
    setQuestionsText,
    comparisonPeriod,
    setComparisonPeriod,
    refreshFrequency,
    setRefreshFrequency,
    mustIncludeSectionsText,
    setMustIncludeSectionsText,
    alertFocusText,
    setAlertFocusText,
    preferredGranularity,
    setPreferredGranularity,
    decisionContext,
    setDecisionContext,
    reportStyle,
    setReportStyle,
    insightDepth,
    setInsightDepth,
    recommendationStyle,
    setRecommendationStyle,
    confidencePreference,
    setConfidencePreference,
    preferredDashboardStructure,
    setPreferredDashboardStructure,
    includeTextNarrative,
    setIncludeTextNarrative,
    includeActionItems,
    setIncludeActionItems,
    includeDataQualityNotes,
    setIncludeDataQualityNotes,
    tableRolesHintText,
    setTableRolesHintText,
    businessGlossaryText,
    setBusinessGlossaryText,
    knownDataIssuesText,
    setKnownDataIssuesText,
    importantDimensionsText,
    setImportantDimensionsText,
    columnsToAvoidText,
    setColumnsToAvoidText,
    notes,
    setNotes,
    planningMode,
    setPlanningMode,
  } = props;

  return (
  <fieldset disabled={isPlanningLocked} className={isPlanningLocked ? 'pointer-events-none' : ''}>
  <div className="space-y-6">
    <div className="overflow-hidden rounded-[28px] border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 bg-gradient-to-r from-blue-50 via-white to-emerald-50 px-6 py-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-white/90 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
              <Sparkles className="h-3.5 w-3.5" />
              {wizardText.briefGuideTitle}
            </div>
            <div>
              <h3 className="text-xl font-semibold text-gray-900">
                {isVietnamese ? 'Brief cho AI theo từng vùng trọng tâm' : 'Brief the Agent across focused areas'}
              </h3>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-gray-600">
                {isVietnamese
                  ? 'Giữ mọi thứ gọn ở một workspace: chọn vùng đang focus, điền phần cần thiết, rồi xem ngay AI đang hiểu brief theo hướng nào.'
                  : 'Keep everything inside one workspace: focus on a single area, fill only what matters, and watch how the Agent interprets the brief in real time.'}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="rounded-2xl border border-blue-200 bg-white px-4 py-3 shadow-sm">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-blue-500">{isVietnamese ? 'Độ sẵn sàng' : 'Readiness'}</p>
              <div className="mt-2 flex items-end gap-2">
                <span className="text-2xl font-semibold text-gray-900">
                  {Math.round((readinessCount / Math.max(readinessChecks.length, 1)) * 100)}%
                </span>
                <span className="pb-1 text-xs font-medium text-gray-500">
                  {readinessCount}/{readinessChecks.length} {wizardText.ready.toLowerCase()}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => toggleGuide('brief-guide')}
              className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
            >
              <Info className="h-4 w-4 text-blue-600" />
              {openGuides['brief-guide'] ? (isVietnamese ? 'Ẩn mẹo nhanh' : 'Hide quick tips') : (isVietnamese ? 'Xem mẹo nhanh' : 'Show quick tips')}
            </button>
            <button
              type="button"
              onClick={openAllBriefSections}
              className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
            >
              <ListChecks className="h-4 w-4 text-blue-600" />
              {wizardText.expandAll}
            </button>
            <button
              type="button"
              onClick={collapseOptionalBriefSections}
              className="inline-flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-700 transition hover:bg-blue-100"
            >
              <ChevronUp className="h-4 w-4" />
              {isVietnamese ? 'Chỉ giữ phần cốt lõi' : 'Essentials only'}
            </button>
          </div>
        </div>
        {openGuides['brief-guide'] && (
          <div className="mt-4 grid gap-3 rounded-2xl border border-blue-100 bg-white/90 p-4 md:grid-cols-3">
            <div className="rounded-2xl border border-blue-100 bg-blue-50/70 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">{wizardText.requiredFirst}</p>
              <p className="mt-2 text-sm leading-6 text-blue-900/85">
                {isVietnamese
                  ? 'Đi từ Essentials sang Intent trước. Chỉ hai phần đó là đã đủ để ra một draft tốt đầu tiên.'
                  : 'Start with Essentials and Intent. Those two areas are already enough for a strong first draft.'}
              </p>
            </div>
            <div className="rounded-2xl border border-blue-100 bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">{wizardText.optionalLater}</p>
              <p className="mt-2 text-sm leading-6 text-gray-600">
                {isVietnamese
                  ? 'Dataset, Narrative và Advanced chỉ nên bổ sung khi bạn muốn AI bớt đoán mò hoặc viết sâu hơn.'
                  : 'Dataset, Narrative, and Advanced are best used when you want the Agent to guess less or write more deeply.'}
              </p>
            </div>
            <div className="rounded-2xl border border-blue-100 bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-500">{wizardText.previewUnderstanding}</p>
              <p className="mt-2 text-sm leading-6 text-gray-600">
                {isVietnamese
                  ? 'Dock bên phải sẽ cho bạn xem phạm vi dữ liệu và cách AI đang đọc brief ngay trong lúc điền.'
                  : 'The right dock shows the current scope and how the Agent is reading the brief while you type.'}
              </p>
            </div>
          </div>
        )}
      </div>
      <div className="border-b border-gray-100 px-6 py-4">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">{wizardText.presetsTitle}</p>
        <p className="mt-1 text-sm text-gray-600">{wizardText.presetsDesc}</p>
        <div className="mt-4 flex gap-3 overflow-x-auto pb-1">
          {briefPresets.map((preset) => (
            <button
              key={preset.key}
              type="button"
              onClick={() => applyBriefPreset(preset.key)}
              className="min-w-[230px] shrink-0 rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-left transition hover:border-blue-300 hover:bg-blue-50/60"
            >
              <p className="font-semibold text-gray-900">{preset.title}</p>
              <p className="mt-1 text-sm leading-5 text-gray-600">{preset.summary}</p>
            </button>
          ))}
        </div>
      </div>
    </div>

      <div className="grid gap-6 bg-gray-50 px-6 py-6 xl:grid-cols-[minmax(0,1fr)] 2xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid gap-5 xl:grid-cols-[220px_minmax(0,1fr)]">
          <div className="space-y-4 xl:sticky xl:top-6 xl:self-start">
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="mb-4 flex items-center gap-2 text-gray-900">
              <ListChecks className="h-5 w-5 text-blue-600" />
              <h3 className="text-base font-semibold">{wizardText.briefMap}</h3>
            </div>
            <div className="space-y-2">
              {visibleBriefSections.map((section) => {
                const active = activeBriefSectionMeta?.key === section.key;
                const progress = briefSectionProgress[section.key];
                return (
                  <button
                    key={section.key}
                    type="button"
                    onClick={() => setActiveBriefSection(section.key)}
                    className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                      active
                        ? 'border-blue-300 bg-blue-50 shadow-sm'
                        : 'border-gray-200 bg-white hover:border-blue-200 hover:bg-blue-50/40'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <span className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                        active ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
                      }`}>
                        {visibleBriefSections.findIndex((item) => item.key === section.key) + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <p className="font-semibold text-gray-900">{section.title}</p>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] ${
                            section.optional ? 'bg-gray-100 text-gray-500' : 'bg-blue-100 text-blue-700'
                          }`}>
                            {section.optional ? wizardText.optional : wizardText.core}
                          </span>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-gray-500">{section.description}</p>
                        <div className="mt-3 flex items-center justify-between gap-3">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                            <div
                              className={`h-full rounded-full ${progress.ready ? 'bg-emerald-500' : 'bg-blue-500'}`}
                              style={{ width: `${Math.max((progress.filled / Math.max(progress.total, 1)) * 100, progress.filled > 0 ? 18 : 0)}%` }}
                            />
                          </div>
                          <span className={`text-[11px] font-semibold uppercase tracking-[0.16em] ${progress.ready ? 'text-emerald-600' : 'text-gray-400'}`}>
                            {progress.ready ? wizardText.ready : wizardText.inProgress}
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="space-y-5">
      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${
                activeBriefSectionMeta.optional ? 'bg-gray-100 text-gray-600' : 'bg-blue-100 text-blue-700'
              }`}>
                {activeBriefSectionMeta.optional ? wizardText.optional : wizardText.core}
              </span>
              <span className="rounded-full bg-gray-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-gray-500">
                {isVietnamese ? 'Phần đang focus' : 'Current focus'}
              </span>
            </div>
            <div>
              <h3 className="text-xl font-semibold text-gray-900">{activeBriefSectionMeta.title}</h3>
              <p className="mt-1 text-sm leading-6 text-gray-600">{activeBriefSectionMeta.description}</p>
            </div>
          </div>
          <div className="rounded-2xl border border-blue-100 bg-blue-50/70 px-4 py-3 text-right">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-blue-600">{isVietnamese ? 'Tín hiệu đã điền' : 'Signals captured'}</p>
            <div className="mt-2 flex items-end justify-end gap-2">
              <span className="text-2xl font-semibold text-gray-900">{activeBriefProgress.filled}</span>
              <span className="pb-1 text-sm text-gray-500">/ {activeBriefProgress.total}</span>
            </div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">{wizardText.whyThisMatters}</p>
            <p className="mt-2 text-sm leading-6 text-gray-700">{activeBriefSectionMeta.helper}</p>
          </div>
          <button
            type="button"
            onClick={() => toggleGuide('brief-focus')}
            className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
          >
            {openGuides['brief-focus'] ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            {openGuides['brief-focus']
              ? (isVietnamese ? 'Thu gọn gợi ý' : 'Hide helper notes')
              : (isVietnamese ? 'Xem gợi ý theo vùng' : 'Show area helper')}
          </button>
        </div>
        {openGuides['brief-focus'] && (
          <div className="mt-4 grid gap-3 rounded-2xl border border-gray-100 bg-gray-50 p-4 md:grid-cols-2">
            {activeBriefFocus.bullets.map((item) => (
              <div key={item} className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm leading-6 text-gray-700">
                {item}
              </div>
            ))}
          </div>
        )}
      </div>

      {activeBriefSectionMeta.key === 'essentials' && (
        <>
      <div className="grid gap-4 md:grid-cols-[1.2fr_0.8fr]">
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Tên report' : 'Report name'}</label>
          <input
            value={reportName}
            onChange={(event) => setReportName(event.target.value)}
            placeholder={isVietnamese ? 'Theo dõi KPI điều hành' : 'Executive KPI watch'}
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">{isVietnamese ? 'Checklist cho draft đầu tiên' : 'Good first draft checklist'}</p>
          <div className="mt-3 space-y-2 text-sm text-gray-600">
            <p>{isVietnamese ? '- Goal: người đọc cần quyết định điều gì.' : '- Goal: what the reader should decide.'}</p>
            <p>{isVietnamese ? '- Audience: report này đang nói với ai.' : '- Audience: who this report is speaking to.'}</p>
            <p>{isVietnamese ? '- KPI + question: dashboard bắt buộc phải giải thích điều gì.' : '- KPI + question: what the dashboard must explain.'}</p>
          </div>
        </div>
      </div>
      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Mục tiêu nghiệp vụ' : 'Business goal'}</label>
        <textarea
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          rows={4}
          className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
        />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Đối tượng đọc' : 'Audience'}</label>
          <input
            value={audience}
            onChange={(event) => setAudience(event.target.value)}
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Khung thời gian' : 'Timeframe'}</label>
          <input
            value={timeframe}
            onChange={(event) => setTimeframe(event.target.value)}
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Vì sao cần lúc này' : 'Why now'}</label>
          <textarea
            value={whyNow}
            onChange={(event) => setWhyNow(event.target.value)}
            rows={3}
            placeholder={isVietnamese ? 'Vì sao report này quan trọng ở thời điểm hiện tại' : 'Why this report matters right now'}
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Bối cảnh nghiệp vụ' : 'Business background'}</label>
          <textarea
            value={businessBackground}
            onChange={(event) => setBusinessBackground(event.target.value)}
            rows={3}
            placeholder={isVietnamese ? 'Bối cảnh domain, initiative hiện tại hoặc nền vận hành liên quan' : 'Short domain context, current initiative, or operational backdrop'}
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">KPIs</label>
          <textarea
            value={kpisText}
            onChange={(event) => setKpisText(event.target.value)}
            rows={4}
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Câu hỏi dashboard phải trả lời' : 'Questions the dashboard must answer'}</label>
          <textarea
            value={questionsText}
            onChange={(event) => setQuestionsText(event.target.value)}
            rows={4}
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>
      </div>
        </>
      )}
      {activeBriefSectionMeta.key === 'intent' && (
        <>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Kỳ so sánh' : 'Comparison period'}</label>
          <input
            value={comparisonPeriod}
            onChange={(event) => setComparisonPeriod(event.target.value)}
            placeholder={isVietnamese ? 'Kỳ trước / YoY / WoW' : 'Previous period / YoY / WoW'}
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Tần suất làm mới' : 'Refresh frequency'}</label>
          <input
            value={refreshFrequency}
            onChange={(event) => setRefreshFrequency(event.target.value)}
            placeholder={isVietnamese ? 'Hàng ngày / Hàng tuần / Hàng tháng' : 'Daily / Weekly / Monthly'}
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Phong cách report' : 'Report style'}</label>
          <select
            value={reportStyle}
            onChange={(event) => setReportStyle(event.target.value)}
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          >
            <option value="executive">{isVietnamese ? 'Điều hành' : 'Executive'}</option>
            <option value="operational">{isVietnamese ? 'Vận hành' : 'Operational'}</option>
            <option value="investigative">{isVietnamese ? 'Điều tra' : 'Investigative'}</option>
              <option value="monitoring">{isVietnamese ? 'Theo dõi' : 'Monitoring'}</option>
          </select>
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Chế độ planning' : 'Planning mode'}</label>
          <select
            value={planningMode}
            onChange={(event) => setPlanningMode(event.target.value as 'quick' | 'deep')}
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          >
            <option value="deep">{isVietnamese ? 'Draft sâu' : 'Deep draft'}</option>
            <option value="quick">{isVietnamese ? 'Draft nhanh' : 'Quick draft'}</option>
          </select>
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Granularity ưu tiên' : 'Preferred granularity'}</label>
          <input
            value={preferredGranularity}
            onChange={(event) => setPreferredGranularity(event.target.value)}
            placeholder={isVietnamese ? 'ngày / tuần / tháng' : 'day / week / month'}
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Loại report' : 'Report type'}</label>
          <input
            value={reportType}
            onChange={(event) => setReportType(event.target.value)}
            placeholder="executive_tracking / anomaly_watch"
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Section bắt buộc' : 'Must-have sections'}</label>
          <textarea
            value={mustIncludeSectionsText}
            onChange={(event) => setMustIncludeSectionsText(event.target.value)}
            rows={3}
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <div>
          <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Trọng tâm cảnh báo' : 'Alert focus'}</label>
          <textarea
            value={alertFocusText}
            onChange={(event) => setAlertFocusText(event.target.value)}
            rows={3}
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
        </div>
      </div>
      <div>
        <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Bối cảnh quyết định' : 'Decision context'}</label>
        <textarea
          value={decisionContext}
          onChange={(event) => setDecisionContext(event.target.value)}
          rows={3}
          className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
        />
      </div>
        </>
      )}
      {activeBriefSectionMeta.key === 'dataset' && (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Gợi ý vai trò của bảng' : 'Table role hints'}</label>
              <textarea
                value={tableRolesHintText}
                onChange={(event) => setTableRolesHintText(event.target.value)}
                rows={3}
                placeholder={isVietnamese ? 'Ví dụ: Data Lake - Segment = tồn kho hoạt động' : 'Example: Data Lake - Segment = activity inventory'}
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Từ điển nghiệp vụ' : 'Business glossary'}</label>
              <textarea
                value={businessGlossaryText}
                onChange={(event) => setBusinessGlossaryText(event.target.value)}
                rows={3}
                placeholder={isVietnamese ? 'Định nghĩa KPI, thuật ngữ nghiệp vụ hoặc viết tắt nội bộ' : 'Define KPI names, business terms, or internal abbreviations'}
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Vấn đề dữ liệu đã biết' : 'Known data issues'}</label>
              <textarea
                value={knownDataIssuesText}
                onChange={(event) => setKnownDataIssuesText(event.target.value)}
                rows={3}
                placeholder={isVietnamese ? 'Thiếu owner, timestamp cũ, dòng trùng lặp...' : 'Missing owners, stale timestamps, duplicated rows...'}
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Dimension quan trọng' : 'Important dimensions'}</label>
              <textarea
                value={importantDimensionsText}
                onChange={(event) => setImportantDimensionsText(event.target.value)}
                rows={3}
                placeholder={isVietnamese ? 'Region, phòng ban, trạng thái...' : 'Region, department, status...'}
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Cột nên tránh dùng' : 'Columns to avoid'}</label>
              <textarea
                value={columnsToAvoidText}
                onChange={(event) => setColumnsToAvoidText(event.target.value)}
                rows={3}
                placeholder={isVietnamese ? 'Các field độ tin cậy thấp hoặc không nên dẫn dắt report' : 'Low-trust fields or columns that should not drive the report'}
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
            </div>
          </div>
        </>
      )}
      {activeBriefSectionMeta.key === 'narrative' && (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Độ sâu insight' : 'Insight depth'}</label>
              <select
                value={insightDepth}
                onChange={(event) => setInsightDepth(event.target.value)}
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              >
                <option value="concise">{isVietnamese ? 'Ngắn gọn' : 'Concise'}</option>
                <option value="balanced">{isVietnamese ? 'Cân bằng' : 'Balanced'}</option>
                <option value="deep">{isVietnamese ? 'Chuyên sâu' : 'Deep'}</option>
              </select>
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Khuyến nghị' : 'Recommendations'}</label>
              <select
                value={recommendationStyle}
                onChange={(event) => setRecommendationStyle(event.target.value)}
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              >
                <option value="none">{isVietnamese ? 'Không có' : 'None'}</option>
                <option value="suggested_actions">{isVietnamese ? 'Hành động gợi ý' : 'Suggested actions'}</option>
                <option value="priority_actions">{isVietnamese ? 'Hành động ưu tiên' : 'Priority actions'}</option>
              </select>
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Chế độ confidence' : 'Confidence mode'}</label>
              <select
                value={confidencePreference}
                onChange={(event) => setConfidencePreference(event.target.value)}
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              >
                <option value="high_confidence_only">{isVietnamese ? 'Chỉ kết luận confidence cao' : 'High confidence only'}</option>
                <option value="include_tentative_with_caveats">{isVietnamese ? 'Cho phép insight tentative kèm caveat' : 'Include tentative insights with caveats'}</option>
              </select>
            </div>
          </div>
          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-gray-900">{isVietnamese ? 'Tùy chọn đầu ra narrative' : 'Narrative output preferences'}</h4>
            <p className="mt-1 text-xs text-gray-500">{isVietnamese ? 'Cho Agent biết lượng phân tích bằng văn bản nên đi kèm dashboard đến mức nào.' : 'Tell the Agent how much text analysis should ship with the dashboard.'}</p>
          </div>
          <select
            value={preferredDashboardStructure}
            onChange={(event) => setPreferredDashboardStructure(event.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          >
            <option value="summary_first">{isVietnamese ? 'Summary trước' : 'Summary first'}</option>
            <option value="section_by_issue">{isVietnamese ? 'Nhóm theo vấn đề' : 'Section by issue'}</option>
            <option value="section_by_team">{isVietnamese ? 'Nhóm theo đội' : 'Section by team'}</option>
          </select>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="flex items-start gap-3 rounded-lg border border-gray-200 bg-white px-3 py-3 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={includeTextNarrative}
              onChange={(event) => setIncludeTextNarrative(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span>
              <span className="block font-medium text-gray-900">{isVietnamese ? 'Thêm narrative text' : 'Include narrative text'}</span>
              {isVietnamese ? 'Executive summary và phần viết cho từng section đi kèm với chart.' : 'Executive summary and section write-up alongside the charts.'}
            </span>
          </label>
          <label className="flex items-start gap-3 rounded-lg border border-gray-200 bg-white px-3 py-3 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={includeActionItems}
              onChange={(event) => setIncludeActionItems(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span>
              <span className="block font-medium text-gray-900">{isVietnamese ? 'Thêm action items' : 'Include action items'}</span>
              {isVietnamese ? 'Yêu cầu Agent gợi ý hành động tiếp theo ở những nơi evidence đủ mạnh.' : 'Ask the Agent to suggest next actions where evidence supports them.'}
            </span>
          </label>
          <label className="flex items-start gap-3 rounded-lg border border-gray-200 bg-white px-3 py-3 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={includeDataQualityNotes}
              onChange={(event) => setIncludeDataQualityNotes(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span>
              <span className="block font-medium text-gray-900">{isVietnamese ? 'Thêm ghi chú chất lượng' : 'Include quality notes'}</span>
              {isVietnamese ? 'Giữ caveat hiển thị khi chất lượng dữ liệu làm giảm confidence.' : 'Keep caveats visible when data quality weakens confidence.'}
            </span>
          </label>
        </div>
          </div>
        </>
      )}
      {activeBriefSectionMeta.key === 'advanced' && (
        <>
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700">{isVietnamese ? 'Ghi chú bổ sung' : 'Additional notes'}</label>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              rows={3}
              className="w-full rounded-lg border border-gray-300 px-4 py-3 text-sm text-gray-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            />
          </div>
        </>
      )}
      <div className="flex flex-col gap-3 border-t border-gray-100 pt-5 sm:flex-row sm:items-center sm:justify-between">
        <button
          type="button"
          disabled={activeBriefSectionIndex <= 0}
          onClick={() => {
            const previous = visibleBriefSections[activeBriefSectionIndex - 1];
            if (previous) setActiveBriefSection(previous.key);
          }}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ArrowLeft className="h-4 w-4" />
          {isVietnamese ? 'Quay lại vùng trước' : 'Previous area'}
        </button>
        <button
          type="button"
          disabled={activeBriefSectionIndex >= visibleBriefSections.length - 1}
          onClick={() => {
            const next = visibleBriefSections[activeBriefSectionIndex + 1];
            if (next) setActiveBriefSection(next.key);
          }}
          className="inline-flex items-center justify-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isVietnamese ? 'Sang vùng tiếp theo' : 'Next area'}
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
      </div>

    <div className="space-y-5 2xl:sticky 2xl:top-6 2xl:self-start">
      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2 text-gray-900">
          <Eye className="h-5 w-5 text-blue-600" />
          <h3 className="text-base font-semibold">{wizardText.liveBriefSummary}</h3>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2 rounded-2xl bg-gray-50 p-1">
          {briefDockTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setBriefDockTab(tab.key)}
              className={`rounded-xl px-3 py-2 text-left transition ${
                briefDockTab === tab.key ? 'bg-white text-blue-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              <span className="block text-sm font-semibold">{tab.label}</span>
              <span className="mt-0.5 block text-[11px] leading-4">{tab.caption}</span>
            </button>
          ))}
        </div>

        {briefDockTab === 'summary' && (
          <div className="mt-4 space-y-4">
            <div className="rounded-2xl border border-blue-100 bg-blue-50/70 p-4">
              <p className="text-sm leading-6 text-blue-900/90">{agentUnderstandingPreview}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">{reportStyle || 'executive'}</span>
              {briefKpis.slice(0, 2).map((item) => (
                <span key={item} className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700">
                  {item}
                </span>
              ))}
            </div>
            <div className="space-y-2">
              {readinessChecks.map((item) => (
                <div key={item.label} className="flex items-center justify-between rounded-xl border border-gray-200 px-4 py-3">
                  <span className="text-sm text-gray-700">{item.label}</span>
                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${
                    item.done ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {item.done ? wizardText.ready : (isVietnamese ? 'Thiếu' : 'Missing')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {briefDockTab === 'scope' && (
          <div className="mt-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-1">
              <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                <p className="text-xs uppercase tracking-[0.16em] text-gray-400">{wizardText.selectedTables}</p>
                <p className="mt-2 text-2xl font-semibold text-gray-900">{selectedTables.length}</p>
              </div>
              <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
                <p className="text-xs uppercase tracking-[0.16em] text-gray-400">{wizardText.questionsSupplied}</p>
                <p className="mt-2 text-2xl font-semibold text-gray-900">{briefQuestions.length}</p>
              </div>
            </div>
            <div className="space-y-3">
              {selectedTableCards.map((item) => (
                <div key={item.key} className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
                  <p className="font-medium text-gray-900">{item.tableName}</p>
                  <p className="mt-1 text-xs uppercase tracking-[0.16em] text-gray-500">{item.workspaceName}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {briefDockTab === 'agent' && (
          <div className="mt-4 space-y-4">
            <div className="rounded-2xl border border-amber-100 bg-amber-50/70 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-700">
                {isVietnamese ? 'AI đang đọc brief như sau' : 'How the Agent is reading the brief'}
              </p>
              <p className="mt-2 text-sm leading-6 text-amber-950/80">{agentUnderstandingPreview}</p>
            </div>
            <div className="space-y-2">
              {activeBriefFocus.bullets.map((item) => (
                <div key={item} className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm leading-6 text-gray-700">
                  {item}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {(planMutation.isPending || planningEvents.length > 0) && (
        <CollapsibleGuideCard
          title={wizardText.planningProgress}
          description={isVietnamese
            ? 'Luồng suy luận gần nhất luôn nằm gọn ở đây để bạn có thể theo dõi mà không làm chật phần nhập liệu.'
            : 'The latest reasoning stream lives here so you can keep watching it without crowding the input canvas.'}
          icon={<Bot className="h-5 w-5" />}
          isOpen={openGuides['brief-progress']}
          onToggle={() => toggleGuide('brief-progress')}
          badge={planMutation.isPending ? wizardText.live : wizardText.recent}
        >
          <div className="space-y-3">
            <div className="grid gap-2">
              {planningPhaseSummary.slice(0, 5).map((item) => (
                <div
                  key={item.phase}
                  className={`flex items-center justify-between rounded-lg border px-4 py-3 text-sm ${getProcessPhaseStatusClass(item.status)}`}
                >
                  <span className="font-medium capitalize">{formatProcessPhaseLabel(item.phase, language)}</span>
                  <span className="text-xs font-semibold uppercase tracking-[0.16em]">
                    {getProcessPhaseStatusLabel(item.status, language)}
                  </span>
                </div>
              ))}
            </div>
            <div className="space-y-2">
              {recentPlanningThoughts.map((event, index) => (
                <div key={`${event.phase}-${index}`} className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-medium text-gray-900">{event.message}</p>
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${getPlanEventBadgeClass(event)}`}>
                      {event.phase}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </CollapsibleGuideCard>
      )}
    </div>
  </div>
  </div>
  </fieldset>
  );
}
