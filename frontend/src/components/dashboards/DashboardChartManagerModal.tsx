'use client';

import React, { useMemo } from 'react';
import { LayoutGrid, Loader2, Trash2 } from 'lucide-react';
import { Modal } from '@/components/common/Modal';
import { getDashboardChartPageId } from '@/lib/dashboard-pages';
import type { DashboardChart, DashboardPageConfig } from '@/types/api';

interface DashboardChartManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  dashboardCharts: DashboardChart[];
  pages: DashboardPageConfig[];
  currentPageId?: string | null;
  removingChartId?: number;
  onRemoveChart: (dashboardChartId: number) => void;
}

export function DashboardChartManagerModal({
  isOpen,
  onClose,
  dashboardCharts,
  pages,
  currentPageId = null,
  removingChartId,
  onRemoveChart,
}: DashboardChartManagerModalProps) {
  const pageNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const page of pages) {
      map.set(page.id, page.name);
    }
    return map;
  }, [pages]);

  const chartItems = useMemo(() => {
    return [...dashboardCharts].sort((left, right) => {
      const leftPageId = getDashboardChartPageId(left.layout);
      const rightPageId = getDashboardChartPageId(right.layout);
      const leftCurrent = leftPageId === currentPageId ? 0 : 1;
      const rightCurrent = rightPageId === currentPageId ? 0 : 1;
      if (leftCurrent !== rightCurrent) return leftCurrent - rightCurrent;

      const leftPageName = pageNameById.get(leftPageId) ?? leftPageId;
      const rightPageName = pageNameById.get(rightPageId) ?? rightPageId;
      const pageCompare = leftPageName.localeCompare(rightPageName);
      if (pageCompare !== 0) return pageCompare;

      const leftName = String(left.chart?.name ?? `Chart #${left.chart_id}`);
      const rightName = String(right.chart?.name ?? `Chart #${right.chart_id}`);
      return leftName.localeCompare(rightName);
    });
  }, [currentPageId, dashboardCharts, pageNameById]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Manage Dashboard Charts"
      size="lg"
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600">
          Remove broken tiles here without relying on the chart tile itself to render successfully.
        </div>

        {chartItems.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-center text-sm text-gray-500">
            This dashboard does not contain any charts.
          </div>
        ) : (
          <div className="space-y-3">
            {chartItems.map((dashboardChart) => {
              const pageId = getDashboardChartPageId(dashboardChart.layout);
              const pageName = pageNameById.get(pageId) ?? pageId;
              const chartName = String(dashboardChart.chart?.name ?? `Chart #${dashboardChart.chart_id}`);
              const chartType = String(dashboardChart.chart?.chart_type ?? '').trim();
              const isRemoving = removingChartId === dashboardChart.id;

              return (
                <div
                  key={dashboardChart.id}
                  className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white px-4 py-4 shadow-sm sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                      <LayoutGrid className="h-4 w-4 text-gray-400" />
                      <span className="truncate">{chartName}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                      <span className="rounded-full bg-gray-100 px-2 py-1 font-medium text-gray-600">
                        Dashboard tile #{dashboardChart.id}
                      </span>
                      <span className="rounded-full bg-blue-50 px-2 py-1 font-medium text-blue-700">
                        Page: {pageName}
                      </span>
                      <span className="rounded-full bg-gray-100 px-2 py-1 font-medium text-gray-600">
                        Chart #{dashboardChart.chart_id}
                      </span>
                      {chartType && (
                        <span className="rounded-full bg-gray-100 px-2 py-1 font-medium uppercase tracking-wide text-gray-600">
                          {chartType}
                        </span>
                      )}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => onRemoveChart(dashboardChart.id)}
                    disabled={isRemoving}
                    className="inline-flex items-center justify-center rounded-md border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isRemoving ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="mr-2 h-4 w-4" />
                    )}
                    Remove from dashboard
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}