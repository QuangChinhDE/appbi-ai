// @ts-nocheck
import { Bot, CheckCircle2, Loader2, Sparkles } from 'lucide-react';

export function BriefStep(props: any) {
  const {
    isVietnamese,
    language,
    isPlanningLocked,
    domainId,
    setDomainId,
    domains,
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
  const selectedDomain = Array.isArray(domains)
    ? domains.find((item) => item.id === domainId) ?? domains.find((item) => item.id === 'finance')
    : null;

  return (
    <fieldset disabled={isPlanningLocked} className="space-y-0">
      <div className="grid gap-6 xl:grid-cols-[1fr_300px]">
        {/* ── Left: form ── */}
        <div className="space-y-5">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-primary">
              {isVietnamese ? 'Business domain' : 'Business domain'}
            </label>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {(domains ?? []).map((domain) => {
                const isActive = domainId === domain.id;
                return (
                  <button
                    key={domain.id}
                    type="button"
                    onClick={() => domain.enabled && setDomainId(domain.id)}
                    disabled={!domain.enabled}
                    className={`rounded-2xl border p-4 text-left transition ${
                      isActive
                        ? 'border-success/40 bg-success/10 text-success'
                        : domain.enabled
                          ? 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:border-brand/30 hover:bg-brand/15/40'
                          : 'cursor-not-allowed border-dashed border-[rgb(var(--border-line))] bg-surface-2 text-text-quaternary'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold">{domain.label}</p>
                        <p className="mt-1 text-xs leading-relaxed">{domain.description}</p>
                      </div>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
                        domain.enabled ? 'bg-surface-1/90 text-success' : 'bg-surface-1 text-text-tertiary'
                      }`}>
                        {domain.enabled ? 'Live' : 'Coming soon'}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
            {selectedDomain && (
              <div className="mt-3 rounded-xl border border-success/30 bg-success/10/70 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-success">
                  {selectedDomain.helperTitle?.[language] ?? selectedDomain.label}
                </p>
                <p className="mt-1 text-sm leading-6 text-success">
                  {selectedDomain.helperDescription?.[language]}
                </p>
                <p className="mt-2 text-xs leading-5 text-success">
                  <span className="font-semibold">{isVietnamese ? 'Ví dụ goal:' : 'Example goal:'}</span>{' '}
                  {selectedDomain.exampleGoal?.[language]}
                </p>
              </div>
            )}
          </div>
          {/* Goal — full width, prominent */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-primary">
              {isVietnamese ? 'Mục tiêu báo cáo' : 'Report goal'} <span className="text-danger">*</span>
            </label>
            <textarea
              rows={3}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder={isVietnamese
                ? (selectedDomain?.exampleGoal?.vi ?? 'Ví dụ: Phân tích doanh thu Q4 theo vùng miền so với cùng kỳ năm ngoái')
                : (selectedDomain?.exampleGoal?.en ?? 'Example: Analyze Q4 revenue by region compared to the same period last year')}
              className="w-full rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-3 text-sm text-text-primary shadow-linear-sm outline-none transition placeholder:text-text-quaternary focus:border-brand/40 focus:ring-2 focus:ring-brand"
            />
          </div>

          {/* Row: Audience + Timeframe */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-primary">
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
                        ? 'border-brand/40 bg-brand/10 text-brand'
                        : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:bg-surface-2'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-primary">
                {isVietnamese ? 'Khung thời gian' : 'Timeframe'}
              </label>
              <input
                value={timeframe}
                onChange={(e) => setTimeframe(e.target.value)}
                placeholder={isVietnamese ? 'VD: Tháng 3/2026' : 'e.g. Last 30 days'}
                className="w-full rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2.5 text-sm text-text-primary shadow-linear-sm outline-none transition placeholder:text-text-quaternary focus:border-brand/40 focus:ring-2 focus:ring-brand"
              />
            </div>
          </div>

          {/* Row: Comparison + Detail level */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-primary">
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
                        ? 'border-brand/40 bg-brand/10 text-brand'
                        : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:bg-surface-2'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-text-primary">
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
                        ? 'border-brand/40 bg-brand/10 text-brand'
                        : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:bg-surface-2'
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
            <label className="mb-1.5 block text-sm font-medium text-text-primary">
              {isVietnamese ? 'Ghi chú' : 'Notes'}{' '}
              <span className="font-normal text-text-quaternary">({isVietnamese ? 'tuỳ chọn' : 'optional'})</span>
            </label>
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={isVietnamese
                ? 'VD: Dữ liệu tháng 12 có thể chưa đầy đủ'
                : 'e.g. December data may be incomplete'}
              className="w-full rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-3 text-sm text-text-primary shadow-linear-sm outline-none transition placeholder:text-text-quaternary focus:border-brand/40 focus:ring-2 focus:ring-brand"
            />
          </div>

          {/* Planning progress — shows inline when running */}
          {(planMutation.isPending || planningEvents.length > 0) && (
            <div className="rounded-xl border border-brand/30 bg-brand/10/60 p-5">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold text-brand">
                  <Sparkles className="h-4 w-4" />
                  {isVietnamese ? 'AI đang suy luận...' : 'AI is reasoning...'}
                </div>
                {planMutation.isPending && <Loader2 className="h-4 w-4 animate-spin text-brand" />}
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
                    <div key={`${event.phase}-${index}`} className="flex items-start justify-between gap-2 rounded-lg border border-brand/20 bg-surface-1 px-3 py-2">
                      <p className="text-xs text-text-secondary">{event.message}</p>
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
          <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
            {/* Tables with descriptions */}
            <div className="border-b border-[rgb(var(--border-line))] px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-text-quaternary">
                {isVietnamese ? 'Dữ liệu đã chọn' : 'Selected data'}
              </p>
              <div className="mt-3 space-y-3">
                {selectedTableCards.slice(0, 6).map((item) => {
                  const desc = (tableDescriptions ?? []).find((d) => d.key === item.key);
                  return (
                    <div key={item.key}>
                      <p className="text-sm font-medium text-text-primary">{item.tableName}</p>
                      <p className="text-[11px] text-text-quaternary">{item.datasetName}</p>
                      {desc?.autoDescription && (
                        <p className="mt-1 text-xs leading-relaxed text-text-tertiary">{desc.autoDescription}</p>
                      )}
                      {desc?.commonQuestions && desc.commonQuestions.length > 0 && (
                        <div className="mt-1.5">
                          {desc.commonQuestions.slice(0, 2).map((q, qi) => (
                            <p key={qi} className="text-[11px] text-text-quaternary">• {q}</p>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Readiness */}
            <div className="border-b border-[rgb(var(--border-line))] px-4 py-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-text-quaternary">
                  {isVietnamese ? 'Sẵn sàng' : 'Readiness'}
                </p>
                <span className="text-xs font-semibold text-text-secondary">{readinessCount}/{readinessChecks.length}</span>
              </div>
              <div className="mt-2 space-y-1.5">
                {readinessChecks.map((item) => (
                  <div key={item.label} className="flex items-center justify-between text-xs">
                    <span className={item.done ? 'text-success' : 'text-text-quaternary'}>{item.label}</span>
                    {item.done ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                    ) : (
                      <span className="h-3.5 w-3.5 rounded-full border border-[rgb(var(--border-strong))]" />
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Agent understanding */}
            <div className="px-4 py-4">
              <div className="flex items-center gap-1.5">
                <Bot className="h-3.5 w-3.5 text-brand" />
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-text-quaternary">
                  {isVietnamese ? 'AI sẽ hiểu' : 'AI reads this as'}
                </p>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-text-secondary">{agentUnderstandingPreview}</p>
            </div>
          </div>
        </div>
      </div>
    </fieldset>
  );
}
