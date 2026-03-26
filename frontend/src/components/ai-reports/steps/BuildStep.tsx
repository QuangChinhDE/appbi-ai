// @ts-nocheck
﻿import { Bot, Loader2 } from 'lucide-react';

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
  } = props;

  return (
    <div className="grid gap-6 lg:grid-cols-[0.85fr_1.15fr]">
      <div className="space-y-4">
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-6">
          <div className="mb-3 flex items-center gap-2 text-blue-900">
            <Bot className="h-5 w-5" />
            <h3 className="text-lg font-semibold">{wizardText.buildAgentRun}</h3>
          </div>
          <p className="text-sm text-blue-900/80">
            {isVietnamese
              ? 'Agent đang tạo chart, kiểm tra dữ liệu của chart và lắp dashboard từ draft đã duyệt.'
              : 'The Agent is creating charts, checking their data, and assembling the dashboard from your approved draft.'}
          </p>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-blue-200 bg-white p-4">
              <p className="text-xs uppercase tracking-[0.16em] text-gray-400">{isVietnamese ? 'Chart đang bật' : 'Active charts'}</p>
              <p className="mt-2 text-2xl font-semibold text-gray-900">{enabledChartCount}</p>
            </div>
            <div className="rounded-lg border border-blue-200 bg-white p-4">
              <p className="text-xs uppercase tracking-[0.16em] text-gray-400">{isVietnamese ? 'Section' : 'Sections'}</p>
              <p className="mt-2 text-2xl font-semibold text-gray-900">{enabledSectionCount}</p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h4 className="text-lg font-semibold text-gray-900">{wizardText.buildNowTitle}</h4>
              <p className="mt-1 text-sm text-gray-500">
                {isVietnamese
                  ? 'Mục này giúp quá trình dễ đọc hơn thay vì chỉ hiện spinner trống.'
                  : 'This keeps the process readable instead of looking like a blank spinner.'}
              </p>
            </div>
            {isBuildRunning && <Loader2 className="h-5 w-5 animate-spin text-blue-500" />}
          </div>

          <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">{wizardText.currentThought}</p>
            <p className="mt-2 text-sm text-blue-900">
              {latestBuildThought?.message || (isVietnamese
                ? 'Đang chờ Agent bắt đầu build từ draft đã duyệt.'
                : 'Waiting for the Agent to start building from the approved draft.')}
            </p>
          </div>

          <div className="mt-4 grid gap-2">
            {buildPhaseSummaryItems.map((item: any) => (
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
        </div>

        {recentBuildThoughts.length > 0 && (
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <div className="mb-3 flex items-center gap-2 text-gray-900">
              <Bot className="h-5 w-5 text-blue-600" />
              <h4 className="text-lg font-semibold">{wizardText.recentThoughtTrail}</h4>
            </div>
            <div className="space-y-3">
              {recentBuildThoughts.map((event: any, index: number) => (
                <div key={`${event.phase}-${index}`} className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-medium text-gray-900">{event.message}</p>
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${getBuildEventBadgeClass(event)}`}>
                      {event.phase}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {!isBuildRunning && agentError && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
            <p className="font-semibold">
              {isVietnamese
                ? 'Bạn có thể quay lại, điều chỉnh draft và thử lại.'
                : 'You can go back, adjust the draft, and try again.'}
            </p>
            <p className="mt-2 text-amber-800">
              {isVietnamese
                ? 'Plan hiện tại vẫn có thể chỉnh sửa, vì vậy bạn có thể tắt chart yếu, đổi tên, hoặc tạo lại draft mới từ brief.'
                : 'The current plan stays editable, so you can disable weak charts, update titles, or regenerate a fresh draft from the brief.'}
            </p>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h4 className="text-lg font-semibold text-gray-900">{wizardText.progressStream}</h4>
            <p className="mt-1 text-sm text-gray-500">
              {isVietnamese
                ? 'Mỗi event được đẩy trực tiếp từ standalone AI Agent service.'
                : 'Each event comes directly from the standalone AI Agent service.'}
            </p>
          </div>
          {isBuildRunning && <Loader2 className="h-5 w-5 animate-spin text-blue-500" />}
        </div>

        <div className="space-y-3">
          {events.length === 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-3 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
              {wizardText.waitingFirstBuildEvent}
            </div>
          )}

          {events.map((event: any, index: number) => (
            <div key={`${event.type}-${index}`} className="rounded-lg border border-gray-200 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-gray-900">{event.message}</p>
                  {event.error && <p className="mt-2 text-sm text-rose-600">{event.error}</p>}
                </div>
                <span className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${getBuildEventBadgeClass(event)}`}>
                  {event.phase}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
