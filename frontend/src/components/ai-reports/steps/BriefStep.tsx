// @ts-nocheck
import { Bot, CheckCircle2, Loader2, Sparkles } from 'lucide-react';

export function BriefStep(props: any) {
  const {
    isVietnamese,
    language,
    isPlanningLocked,
    openGuides,
    toggleGuide,
    goal,
    setGoal,
    audience,
    setAudience,
    timeframe,
    setTimeframe,
    comparisonPeriod,
    setComparisonPeriod,
    preferredGranularity,
    setPreferredGranularity,
    notes,
    setNotes,
    selectedTables,
    selectedTableCards,
    readinessCount,
    readinessChecks,
    agentUnderstandingPreview,
    tableDescriptions,
    planMutation,
    planningEvents,
    planningPhaseSummary,
    recentPlanningThoughts,
    formatProcessPhaseLabel,
    getProcessPhaseStatusClass,
    getProcessPhaseStatusLabel,
    getPlanEventBadgeClass,
  } = props;

  const audienceOptions = [
    { value: 'exec', label: 'Exec' },
    { value: 'manager', label: 'Manager' },
    { value: 'analyst', label: 'Analyst' },
  ];

  const comparisonOptions = isVietnamese
    ? [
        { value: 'previous_period', label: 'Kỳ trước' },
        { value: 'same_period', label: 'Cùng kỳ' },
        { value: 'none', label: 'Không' },
      ]
    : [
        { value: 'previous_period', label: 'Previous period' },
        { value: 'same_period', label: 'Same period' },
        { value: 'none', label: 'None' },
      ];

  const detailOptions = isVietnamese
    ? [
        { value: 'overview', label: 'Tổng quan' },
        { value: 'detailed', label: 'Chi tiết' },
      ]
    : [
        { value: 'overview', label: 'Overview' },
        { value: 'detailed', label: 'Detailed' },
      ];

  return (
    <fieldset disabled={isPlanningLocked} className="space-y-0">
      <div className="grid gap-6 xl:grid-cols-[1fr_300px]">
        {/* ── Left: form ── */}
        <div className="space-y-5">
          {/* Goal — full width, prominent */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-900">
              {isVietnamese ? 'Mục tiêu báo cáo' : 'Report goal'} <span className="text-rose-500">*</span>
            </label>
            <textarea
              rows={3}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder={isVietnamese
                ? 'Ví dụ: Phân tích doanh thu Q4 theo vùng miền so với cùng kỳ năm ngoái'
                : 'Example: Analyze Q4 revenue by region compared to the same period last year'}
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 shadow-sm outline-none transition placeholder:text-gray-400 focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
            />
          </div>

          {/* Row: Audience + Timeframe */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-900">
                {isVietnamese ? 'Người đọc' : 'Audience'}
              </label>
              <div className="flex flex-wrap gap-2">
                {audienceOptions.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setAudience(opt.value)}
                    className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
                      audience === opt.value
                        ? 'border-blue-300 bg-blue-50 text-blue-700'
                        : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-900">
                {isVietnamese ? 'Khung thời gian' : 'Timeframe'}
              </label>
              <input
                value={timeframe}
                onChange={(e) => setTimeframe(e.target.value)}
                placeholder={isVietnamese ? 'VD: Tháng 3/2026' : 'e.g. Last 30 days'}
                className="w-full rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-900 shadow-sm outline-none transition placeholder:text-gray-400 focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
              />
            </div>
          </div>

          {/* Row: Comparison + Detail level */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-900">
                {isVietnamese ? 'So sánh với' : 'Compare against'}
              </label>
              <div className="flex flex-wrap gap-2">
                {comparisonOptions.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setComparisonPeriod(opt.value)}
                    className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
                      comparisonPeriod === opt.value
                        ? 'border-blue-300 bg-blue-50 text-blue-700'
                        : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-900">
                {isVietnamese ? 'Mức chi tiết' : 'Detail level'}
              </label>
              <div className="flex flex-wrap gap-2">
                {detailOptions.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setPreferredGranularity(opt.value)}
                    className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
                      preferredGranularity === opt.value
                        ? 'border-blue-300 bg-blue-50 text-blue-700'
                        : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Notes — last field */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-900">
              {isVietnamese ? 'Ghi chú' : 'Notes'}{' '}
              <span className="font-normal text-gray-400">({isVietnamese ? 'tuỳ chọn' : 'optional'})</span>
            </label>
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={isVietnamese
                ? 'VD: Dữ liệu tháng 12 có thể chưa đầy đủ'
                : 'e.g. December data may be incomplete'}
              className="w-full rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-900 shadow-sm outline-none transition placeholder:text-gray-400 focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
            />
          </div>

          {/* Planning progress — shows inline when running */}
          {(planMutation.isPending || planningEvents.length > 0) && (
            <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-5">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold text-blue-900">
                  <Sparkles className="h-4 w-4" />
                  {isVietnamese ? 'AI đang suy luận...' : 'AI is reasoning...'}
                </div>
                {planMutation.isPending && <Loader2 className="h-4 w-4 animate-spin text-blue-600" />}
              </div>
              <div className="space-y-1.5">
                {planningPhaseSummary.map((item) => (
                  <div key={item.phase} className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${getProcessPhaseStatusClass(item.status)}`}>
                    <span className="font-medium">{formatProcessPhaseLabel(item.phase, language)}</span>
                    <span className="text-[11px] font-semibold uppercase tracking-[0.16em]">{getProcessPhaseStatusLabel(item.status, language)}</span>
                  </div>
                ))}
              </div>
              {recentPlanningThoughts.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  {recentPlanningThoughts.slice(0, 3).map((event, index) => (
                    <div key={`${event.phase}-${index}`} className="flex items-start justify-between gap-2 rounded-lg border border-blue-100 bg-white px-3 py-2">
                      <p className="text-xs text-gray-700">{event.message}</p>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${getPlanEventBadgeClass(event)}`}>
                        {event.phase}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Right: merged sidebar ── */}
        <div className="space-y-0">
          <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
            {/* Tables with descriptions */}
            <div className="border-b border-gray-100 px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">
                {isVietnamese ? 'Dữ liệu đã chọn' : 'Selected data'}
              </p>
              <div className="mt-3 space-y-3">
                {selectedTableCards.slice(0, 6).map((item) => {
                  const desc = (tableDescriptions ?? []).find((d) => d.key === item.key);
                  return (
                    <div key={item.key}>
                      <p className="text-sm font-medium text-gray-900">{item.tableName}</p>
                      <p className="text-[11px] text-gray-400">{item.workspaceName}</p>
                      {desc?.autoDescription && (
                        <p className="mt-1 text-xs leading-relaxed text-gray-500">{desc.autoDescription}</p>
                      )}
                      {desc?.commonQuestions && desc.commonQuestions.length > 0 && (
                        <div className="mt-1.5">
                          {desc.commonQuestions.slice(0, 2).map((q, qi) => (
                            <p key={qi} className="text-[11px] text-gray-400">• {q}</p>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Readiness */}
            <div className="border-b border-gray-100 px-4 py-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">
                  {isVietnamese ? 'Sẵn sàng' : 'Readiness'}
                </p>
                <span className="text-xs font-semibold text-gray-600">{readinessCount}/{readinessChecks.length}</span>
              </div>
              <div className="mt-2 space-y-1.5">
                {readinessChecks.map((item) => (
                  <div key={item.label} className="flex items-center justify-between text-xs">
                    <span className={item.done ? 'text-emerald-700' : 'text-gray-400'}>{item.label}</span>
                    {item.done ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                      <span className="h-3.5 w-3.5 rounded-full border border-gray-300" />
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Agent understanding */}
            <div className="px-4 py-4">
              <div className="flex items-center gap-1.5">
                <Bot className="h-3.5 w-3.5 text-blue-600" />
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">
                  {isVietnamese ? 'AI sẽ hiểu' : 'AI reads this as'}
                </p>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-gray-600">{agentUnderstandingPreview}</p>
            </div>
          </div>
        </div>
      </div>
    </fieldset>
  );
}
