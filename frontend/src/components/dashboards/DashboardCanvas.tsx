'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChartTile } from './ChartTile';
import { ChartErrorBoundary } from './ChartErrorBoundary';
import { DashboardWidget } from './DashboardWidget';
import type { DashboardChart, DashboardCanvasConfig, DashboardPageConfig } from '@/types/api';
import type { DashboardFilter, BaseFilter } from '@/lib/filters';
import { ensureCanvasCoords } from '@/lib/dashboard-layout-convert';

type DragState = {
  id: number;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
  mode: 'move' | 'resize';
};

interface DashboardCanvasProps {
  dashboardId: number;
  dashboardCharts: DashboardChart[];
  canvasConfig?: DashboardCanvasConfig | null;
  onLayoutChange?: (
    updates: Array<{ id: number; xPx: number; yPx: number; wPx: number; hPx: number; z: number }>,
  ) => void;
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
}

export function DashboardCanvas({
  dashboardId,
  dashboardCharts,
  canvasConfig,
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
}: DashboardCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(canvasConfig?.width ?? 1440);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [localOverrides, setLocalOverrides] = useState<Record<number, { xPx: number; yPx: number; wPx: number; hPx: number }>>({});

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const designWidth = canvasConfig?.width ?? Math.max(containerWidth || 0, 1440);
  const scale = containerWidth > 0 && designWidth > containerWidth ? containerWidth / designWidth : 1;

  const hydrated = useMemo(
    () => ensureCanvasCoords(dashboardCharts, designWidth),
    [dashboardCharts, designWidth],
  );

  const snap = canvasConfig?.snap ?? 8;
  const snapVal = (v: number) => Math.round(v / snap) * snap;
  const canvasHeight = canvasConfig?.height ?? 900;

  // Expand canvas height to fit all placed items so nothing gets clipped.
  const requiredHeight = useMemo(() => {
    if (!hydrated.length) return canvasHeight;
    const maxBottom = Math.max(
      canvasHeight,
      ...hydrated.map((dc) => (dc.layout.yPx ?? 0) + (dc.layout.hPx ?? 240)),
    );
    return maxBottom + 32; // 32px bottom padding
  }, [hydrated, canvasHeight]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent, dc: DashboardChart, mode: 'move' | 'resize') => {
      if (!canEdit) return;
      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);
      const l = dc.layout;
      setDrag({
        id: dc.id,
        startX: e.clientX,
        startY: e.clientY,
        origX: l.xPx ?? 0,
        origY: l.yPx ?? 0,
        origW: l.wPx ?? 320,
        origH: l.hPx ?? 240,
        mode,
      });
    },
    [canEdit],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) return;
      const dx = (e.clientX - drag.startX) / scale;
      const dy = (e.clientY - drag.startY) / scale;
      if (drag.mode === 'move') {
        const xPx = Math.max(0, snapVal(drag.origX + dx));
        const yPx = Math.max(0, snapVal(drag.origY + dy));
        setLocalOverrides((m) => ({
          ...m,
          [drag.id]: { xPx, yPx, wPx: drag.origW, hPx: drag.origH },
        }));
      } else {
        const wPx = Math.max(80, snapVal(drag.origW + dx));
        const hPx = Math.max(60, snapVal(drag.origH + dy));
        setLocalOverrides((m) => ({
          ...m,
          [drag.id]: { xPx: drag.origX, yPx: drag.origY, wPx, hPx },
        }));
      }
    },
    [drag, snap, scale],
  );

  const onPointerUp = useCallback(() => {
    if (!drag) return;
    const o = localOverrides[drag.id];
    if (o && onLayoutChange) {
      const maxZ = Math.max(0, ...hydrated.map((dc) => dc.layout.z ?? 0));
      onLayoutChange([{ id: drag.id, ...o, z: maxZ + 1 }]);
    }
    setDrag(null);
  }, [drag, localOverrides, onLayoutChange, hydrated]);

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
    <div
      ref={containerRef}
      className="relative w-full overflow-x-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-2"
      style={{
        minHeight: requiredHeight * scale,
        background: canvasConfig?.background,
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className="relative"
        style={{
          width: designWidth,
          height: requiredHeight,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
      >
        {hydrated.map((dc) => {
          const o = localOverrides[dc.id];
          const x = o?.xPx ?? dc.layout.xPx ?? 0;
          const y = o?.yPx ?? dc.layout.yPx ?? 0;
          const w = o?.wPx ?? dc.layout.wPx ?? 320;
          const h = o?.hPx ?? dc.layout.hPx ?? 240;
          const z = dc.layout.z ?? 1;
          return (
            <div
              key={dc.id}
              className="absolute"
              style={{ left: x, top: y, width: w, height: h, zIndex: z }}
            >
              {canEdit && (
                <div
                  className="absolute inset-x-0 top-0 z-10 h-6 cursor-move bg-transparent"
                  onPointerDown={(e) => onPointerDown(e, dc, 'move')}
                  title="Drag to move"
                />
              )}
              {dc.widget_type && dc.widget_type !== 'chart' ? (
                <div className="relative h-full w-full group">
                  <DashboardWidget widget={dc} />
                  {canEdit && (
                    <div className="absolute right-2 top-2 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      {onEditWidget && (
                        <button
                          type="button"
                          onPointerDown={(e) => e.stopPropagation()}
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
                          onPointerDown={(e) => e.stopPropagation()}
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
              <ChartErrorBoundary
                chartId={dc.chart_id}
                dashboardChartId={dc.id}
                onRemove={onRemoveChart}
                isRemoving={removingChartId === dc.id}
              >
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
                  onSelectCrossFilter={
                    onSelectCrossFilter ? (filter) => onSelectCrossFilter(dc.chart_id, filter) : undefined
                  }
                  isCrossFilterSource={crossFilterSourceChartId === dc.chart_id}
                  instanceParameters={dc.parameters ?? {}}
                  availablePages={availablePages}
                  currentPageId={
                    typeof dc.layout?.pageId === 'string' ? dc.layout.pageId : (availablePages[0]?.id ?? null)
                  }
                  onMoveToPage={onMoveChartToPage ? (pageId) => onMoveChartToPage(dc.id, pageId) : undefined}
                />
              </ChartErrorBoundary>
              )}
              {canEdit && (
                <div
                  className="absolute -bottom-1 -right-1 z-10 h-4 w-4 cursor-se-resize rounded-sm border border-[rgb(var(--border-strong))] bg-surface-1"
                  onPointerDown={(e) => onPointerDown(e, dc, 'resize')}
                  title="Drag to resize"
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
