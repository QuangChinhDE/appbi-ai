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
import { Loader2, LayoutDashboard } from 'lucide-react';
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
  /** Phase-15.81 v6 — focus state for Grid highlight only. The
   *  "Filters on this visual" scope was removed; Grid still passes
   *  focusedDashboardChartId through so the focused tile renders a
   *  brand-ring while editing, and click toggles focus. */
  focusedDashboardChartId?: number | null;
  onFocusChart?: (dashboardChartId: number) => void;
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
  focusedDashboardChartId = null,
  onFocusChart,
}: DashboardGridProps) {
  // Convert backend layout to react-grid-layout format.
  // resizeHandles: 4 corners only. Edges removed per DA feedback —
  // 8 handles is noisy and users accidentally hit an edge when they
  // wanted a corner. Each corner stretches BOTH width and height,
  // so 4 handles cover every resize direction without confusion.
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
      resizeHandles: ['se', 'sw', 'ne', 'nw'] as Array<'se' | 'sw' | 'ne' | 'nw'>,
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

    // Match by item ID (not array index) so reordered arrays don't produce false-positives.
    const oldById = new Map(layouts.map((l) => [l.i, l]));
    const hasChanged = newLayout.some((item) => {
      const oldItem = oldById.get(item.i);
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
      <div className="bi-empty-state bi-fade-in flex h-72 flex-col items-center justify-center gap-3 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-1 shadow-linear-sm">
          <LayoutDashboard className="h-7 w-7 text-brand/70" strokeWidth={1.5} />
        </div>
        <div>
          <h3 className="text-base font-semibold text-text-primary">
            {emptyMessage ? '' : 'Bắt đầu xây dashboard'}
          </h3>
          <p className="mt-1 max-w-sm text-[13px] text-text-tertiary">
            {emptyMessage ?? 'Chưa có chart nào trên dashboard này. Click "Add Chart" ở thanh trên để chèn KPI, biểu đồ hoặc widget.'}
          </p>
        </div>
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
      compactType={null}
      preventCollision={true}
    >
      {dashboardCharts.map((dc) => {
        const isWidget = dc.widget_type && dc.widget_type !== 'chart';
        // Visual-only widgets (Shape, Line/Divider) intentionally render
        // as solid blocks without a card frame — wrapping them in
        // `dashboard-tile bi-card-hover` would defeat the purpose
        // (Shape becomes a coloured pill inside a white frame).
        const isVisualWidget = isWidget && (
          dc.widget_type === 'shape'
        );
        const tile = isWidget ? (
          <div
            className={`group relative h-full w-full ${
              isVisualWidget
                ? ''
                : 'dashboard-tile bi-card-hover rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 overflow-hidden'
            }`}
          >
            {/* Drag handle for react-grid-layout — required so widgets are draggable */}
            {canEdit && (
              <div
                className="drag-handle bi-drag-grip absolute inset-x-0 top-0 z-10 h-5 bg-transparent"
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
            isFocused={focusedDashboardChartId === dc.id}
            onFocus={onFocusChart}
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
