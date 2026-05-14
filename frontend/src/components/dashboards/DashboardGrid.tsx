'use client';

import React, { useRef, useState, useEffect } from 'react';
import GridLayout, { WidthProvider, Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { ChartTile } from './ChartTile';
import { ChartErrorBoundary } from './ChartErrorBoundary';
import { DashboardWidget } from './DashboardWidget';
import { DashboardChart, DashboardPageConfig, DashboardThemeConfig } from '@/types/api';
import { DashboardFilter } from '@/lib/filters';
import type { BaseFilter } from '@/lib/filters';
import { Loader2 } from 'lucide-react';
import { getDashboardGridMargin } from './DashboardThemeProvider';

// Non-responsive grid: a single 12-column layout that simply scales cell
// width with the container. Avoiding ResponsiveGridLayout means opening
// DevTools (or any viewport shrink) won't reflow charts onto a different
// breakpoint and clobber the saved layout.
const FixedGridLayout = WidthProvider(GridLayout);

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
  onEditWidget?: (dashboardChartId: number) => void;
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
  themeConfig?: DashboardThemeConfig | null;
  /** When true, skip IntersectionObserver lazy loading — render all charts immediately. */
  disableLazy?: boolean;
}

export function DashboardGrid({
  dashboardId,
  dashboardCharts,
  onLayoutChange,
  onRemoveChart,
  onEditWidget,
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
  themeConfig = null,
  disableLazy = false,
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

  // Only persist layout when the user actually finishes dragging or resizing.
  // react-grid-layout fires `onLayoutChange` for every internal recompute
  // (initial mount, container resize while DevTools opens, compaction…) —
  // forwarding those would clobber the saved layout with whatever it was
  // momentarily reflowed to.
  const isUserGestureRef = useRef(false);

  const handleLayoutChange = (newLayout: Layout[]) => {
    if (!isUserGestureRef.current) return;
    isUserGestureRef.current = false;

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

  const markUserGesture = () => {
    isUserGestureRef.current = true;
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
    <FixedGridLayout
      className="layout"
      layout={layouts}
      cols={12}
      rowHeight={80}
      margin={getDashboardGridMargin(themeConfig)}
      onLayoutChange={handleLayoutChange}
      onDragStart={markUserGesture}
      onResizeStart={markUserGesture}
      draggableHandle=".drag-handle"
      isDraggable={!!onLayoutChange}
      isResizable={!!onLayoutChange}
      compactType="vertical"
      preventCollision={false}
    >
      {dashboardCharts.map((dc) => {
        const isWidget = dc.widget_type && dc.widget_type !== 'chart';
        const tile = isWidget ? (
          <div className="group relative h-full w-full">
            {/* Drag handle for react-grid-layout — required so widgets are draggable */}
            {canEdit && (
              <div
                className="drag-handle absolute inset-x-0 top-0 z-10 h-5 cursor-move bg-transparent"
                title="Drag to move"
              />
            )}
            <DashboardWidget widget={dc} />
            {canEdit && (
              <div className="absolute right-2 top-2 z-20 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                {onEditWidget && (
                  <button
                    type="button"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => onEditWidget(dc.id)}
                    className="rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 p-1.5 shadow-linear-sm transition-colors hover:border-brand/40 hover:bg-brand/10 hover:text-brand"
                    title="Edit widget"
                  >
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11.5 2.5l2 2L5 13l-3 1 1-3 8.5-8.5z" strokeLinejoin="round" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
                {onRemoveChart && (
                  <button
                    type="button"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => onRemoveChart(dc.id)}
                    disabled={removingChartId === dc.id}
                    className="rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 p-1.5 shadow-linear-sm transition-colors hover:border-danger/40 hover:bg-danger/10 disabled:opacity-50"
                    title="Remove widget"
                  >
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-danger" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
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
        );
        return (
          <div key={dc.id.toString()}>
            <ChartErrorBoundary
              chartId={dc.chart_id}
              dashboardChartId={dc.id}
              onRemove={isWidget ? undefined : onRemoveChart}
              isRemoving={removingChartId === dc.id}
            >
              {disableLazy || isWidget ? tile : <LazyChartSlot>{tile}</LazyChartSlot>}
            </ChartErrorBoundary>
          </div>
        );
      })}
    </FixedGridLayout>
  );
}
