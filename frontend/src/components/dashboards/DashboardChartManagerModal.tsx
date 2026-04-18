'use client';

import React, { useMemo } from 'react';
import { LayoutGrid, Loader2, Trash2 } from 'lucide-react';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
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
        <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3 text-caption text-text-secondary">
          Remove broken tiles here without relying on the chart tile itself to render successfully.
        </div>

        {chartItems.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-2 px-4 py-8 text-center text-caption text-text-tertiary">
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
                  className="flex flex-col gap-3 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-4 py-4 transition-shadow hover:shadow-linear sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-caption font-strong text-text-primary">
                      <LayoutGrid className="h-4 w-4 text-text-quaternary" />
                      <span className="truncate">{chartName}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Badge variant="neutral" size="xs">
                        Dashboard tile #{dashboardChart.id}
                      </Badge>
                      <Badge variant="brand" size="xs">
                        Page: {pageName}
                      </Badge>
                      <Badge variant="neutral" size="xs">
                        Chart #{dashboardChart.chart_id}
                      </Badge>
                      {chartType && (
                        <Badge variant="neutral" size="xs" className="uppercase">
                          {chartType}
                        </Badge>
                      )}
                    </div>
                  </div>

                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => onRemoveChart(dashboardChart.id)}
                    disabled={isRemoving}
                    leadingIcon={
                      isRemoving
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Trash2 className="h-3.5 w-3.5" />
                    }
                    className="border-danger/30 text-danger hover:bg-danger/10"
                  >
                    Remove from dashboard
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
