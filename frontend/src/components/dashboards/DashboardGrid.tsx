'use client';

import React, { useRef, useState, useEffect } from 'react';
import { Responsive, WidthProvider, Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { ChartTile } from './ChartTile';
import { ChartErrorBoundary } from './ChartErrorBoundary';
import { DashboardChart, DashboardPageConfig } from '@/types/api';
import { DashboardFilter } from '@/lib/filters';
import type { BaseFilter } from '@/lib/filters';
import { Loader2 } from 'lucide-react';

const ResponsiveGridLayout = WidthProvider(Responsive);

/** Wrapper that defers rendering children until the element is visible. */
function LazyChartSlot({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' }, // start loading 200px before in view
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (!visible) {
    return (
      <div
        ref={ref}
        className="flex h-full items-center justify-center rounded-xl border border-[rgb(var(--border-line))] bg-surface-1"
      >
        <Loader2 className="h-5 w-5 animate-spin text-text-quaternary" />
      </div>
    );
  }

  return <>{children}</>;
}

interface DashboardGridProps {
  dashboardId: number;
  dashboardCharts: DashboardChart[];
  onLayoutChange?: (layouts: Layout[]) => void;
  onRemoveChart?: (dashboardChartId: number) => void;
  removingChartId?: number;
  dashboardFilters?: DashboardFilter[];
  globalFilters?: BaseFilter[];
  crossFilters?: BaseFilter[];
  crossFilterSourceChartId?: number | null;
  onChartDataLoaded?: (chartId: number, data: any[], meta: { dimensionFields: string[] }) => void;
  onSelectCrossFilter?: (chartId: number, filter: BaseFilter | null) => void;
  availablePages?: DashboardPageConfig[];
  onMoveChartToPage?: (dashboardChartId: number, pageId: string) => void;
  emptyMessage?: string;
  canEdit?: boolean;
  allowAppearanceEdit?: boolean;
}

export function DashboardGrid({
  dashboardId,
  dashboardCharts,
  onLayoutChange,
  onRemoveChart,
  removingChartId,
  dashboardFilters = [],
  globalFilters = [],
  crossFilters = [],
  crossFilterSourceChartId = null,
  onChartDataLoaded,
  onSelectCrossFilter,
  availablePages = [],
  onMoveChartToPage,
  emptyMessage,
  canEdit = false,
  allowAppearanceEdit = false,
}: DashboardGridProps) {
  // Convert backend layout to react-grid-layout format
  const layouts = dashboardCharts.map((dc) => {
    const layout = dc.layout;
    return {
      i: dc.id.toString(),
      x: layout.x || 0,
      y: layout.y || 0,
      w: layout.w || 4,
      h: layout.h || 4,
      minW: 2,
      minH: 2,
    };
  });

  const handleLayoutChange = (newLayout: Layout[]) => {
    // Only trigger if layout actually changed
    const hasChanged = newLayout.some((item, index) => {
      const oldItem = layouts[index];
      return (
        oldItem &&
        (item.x !== oldItem.x ||
          item.y !== oldItem.y ||
          item.w !== oldItem.w ||
          item.h !== oldItem.h)
      );
    });

    if (hasChanged && onLayoutChange) {
      onLayoutChange(newLayout);
    }
  };

  if (dashboardCharts.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-2">
        <p className="text-caption text-text-tertiary">
          {emptyMessage ?? 'No charts in this dashboard. Click "Add Chart" to get started.'}
        </p>
      </div>
    );
  }

  return (
    <ResponsiveGridLayout
      className="layout"
      layouts={{ lg: layouts }}
      breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
      cols={{ lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 }}
      rowHeight={80}
      onLayoutChange={handleLayoutChange}
      draggableHandle=".drag-handle"
      isDraggable={!!onLayoutChange}
      isResizable={!!onLayoutChange}
      compactType="vertical"
      preventCollision={false}
    >
      {dashboardCharts.map((dc) => (
        <div key={dc.id.toString()}>
          <ChartErrorBoundary
            chartId={dc.chart_id}
            dashboardChartId={dc.id}
            onRemove={onRemoveChart}
            isRemoving={removingChartId === dc.id}
          >
            <LazyChartSlot>
              <ChartTile
                chartId={dc.chart_id}
                dashboardChartId={dc.id}
                dashboardId={dashboardId}
                currentLayout={dc.layout as Record<string, any>}
                canEdit={canEdit}
                allowAppearanceEdit={allowAppearanceEdit}
                onRemove={onRemoveChart}
                isRemoving={removingChartId === dc.id}
                dashboardFilters={dashboardFilters}
                globalFilters={globalFilters}
                crossFilters={crossFilterSourceChartId === dc.chart_id ? [] : crossFilters}
                onDataLoaded={onChartDataLoaded}
                onSelectCrossFilter={onSelectCrossFilter ? (filter) => onSelectCrossFilter(dc.chart_id, filter) : undefined}
                isCrossFilterSource={crossFilterSourceChartId === dc.chart_id}
                instanceParameters={dc.parameters ?? {}}
                availablePages={availablePages}
                currentPageId={typeof dc.layout?.pageId === 'string' ? dc.layout.pageId : (availablePages[0]?.id ?? null)}
                onMoveToPage={onMoveChartToPage ? (pageId) => onMoveChartToPage(dc.id, pageId) : undefined}
              />
            </LazyChartSlot>
          </ChartErrorBoundary>
        </div>
      ))}
    </ResponsiveGridLayout>
  );
}
