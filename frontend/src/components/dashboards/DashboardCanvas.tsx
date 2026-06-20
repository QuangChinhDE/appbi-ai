'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChartTile } from './ChartTile';
import { ChartErrorBoundary } from './ChartErrorBoundary';
import { DashboardWidget } from './DashboardWidget';
import type { DashboardChart, DashboardCanvasConfig, DashboardPageConfig } from '@/types/api';
import type { DashboardFilter, BaseFilter } from '@/lib/filters';
import { ensureCanvasCoords } from '@/lib/dashboard-layout-convert';
import { useI18n } from '@/providers/LanguageProvider';

type ResizeDir = 'n' | 'e' | 's' | 'w' | 'nw' | 'ne' | 'sw' | 'se';
type DragMode = { kind: 'move' } | { kind: 'resize'; dir: ResizeDir };

type DragState = {
  id: number;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
  mode: DragMode;
};

const MIN_W = 80;
const MIN_H = 60;

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
  /** Cross-highlight (PBI-parity) — active selection P + its source chart. */
  highlightFilter?: BaseFilter | null;
  highlightSourceChartId?: number | null;
  onChartDataLoaded?: (chartId: number, data: any[], meta: { dimensionFields: string[] }) => void;
  onSelectCrossFilter?: (chartId: number, filter: BaseFilter | null) => void;
  availablePages?: DashboardPageConfig[];
  onMoveChartToPage?: (dashboardChartId: number, pageId: string) => void;
  emptyMessage?: string;
  canEdit?: boolean;
  allowAppearanceEdit?: boolean;
  /** Phase-15.81 v6 — focus prop for Canvas highlight only. The
   *  FilterPane "this visual" scope was removed; focus is now just a
   *  UI signal that survives so the user can see which tile they last
   *  clicked. */
  focusedDashboardChartId?: number | null;
  onFocusChart?: (dashboardChartId: number) => void;
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
  highlightFilter = null,
  highlightSourceChartId = null,
  onChartDataLoaded,
  onSelectCrossFilter,
  availablePages = [],
  onMoveChartToPage,
  emptyMessage,
  canEdit = false,
  allowAppearanceEdit = false,
  focusedDashboardChartId = null,
  onFocusChart,
}: DashboardCanvasProps) {
  const { t } = useI18n();
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
    (e: React.PointerEvent, dc: DashboardChart, mode: DragMode) => {
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

  // rAF-throttle for pointer move. Without this, fast drags fire 100+
  // pointermove events per second, each triggering a setState → React
  // re-render. Coalescing to one update per animation frame (~60fps)
  // makes the drag feel buttery without losing precision — the latest
  // event always wins because we keep the freshest values in pendingRef.
  const pendingRef = useRef<{ xPx: number; yPx: number; wPx: number; hPx: number } | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) return;
      const dx = (e.clientX - drag.startX) / scale;
      const dy = (e.clientY - drag.startY) / scale;
      let next: { xPx: number; yPx: number; wPx: number; hPx: number };
      if (drag.mode.kind === 'move') {
        next = {
          xPx: Math.max(0, snapVal(drag.origX + dx)),
          yPx: Math.max(0, snapVal(drag.origY + dy)),
          wPx: drag.origW,
          hPx: drag.origH,
        };
      } else {
        // Resize: each of 8 directions affects x/y/w/h differently.
        // Anchor the OPPOSITE edge of the dragged handle so the chart
        // stretches naturally toward the cursor — same behaviour as
        // Looker / PowerBI canvas tiles.
        const dir = drag.mode.dir;
        const grow = {
          left:   dir === 'w' || dir === 'nw' || dir === 'sw',
          right:  dir === 'e' || dir === 'ne' || dir === 'se',
          top:    dir === 'n' || dir === 'nw' || dir === 'ne',
          bottom: dir === 's' || dir === 'sw' || dir === 'se',
        };
        let xPx = drag.origX;
        let yPx = drag.origY;
        let wPx = drag.origW;
        let hPx = drag.origH;
        if (grow.right) {
          wPx = Math.max(MIN_W, snapVal(drag.origW + dx));
        } else if (grow.left) {
          const newW = Math.max(MIN_W, snapVal(drag.origW - dx));
          wPx = newW;
          xPx = Math.max(0, drag.origX + drag.origW - newW);
        }
        if (grow.bottom) {
          hPx = Math.max(MIN_H, snapVal(drag.origH + dy));
        } else if (grow.top) {
          const newH = Math.max(MIN_H, snapVal(drag.origH - dy));
          hPx = newH;
          yPx = Math.max(0, drag.origY + drag.origH - newH);
        }
        next = { xPx, yPx, wPx, hPx };
      }
      pendingRef.current = next;
      if (rafIdRef.current == null) {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null;
          const pending = pendingRef.current;
          if (!pending) return;
          setLocalOverrides((m) => ({ ...m, [drag.id]: pending }));
        });
      }
    },
    [drag, snap, scale],
  );

  const onPointerUp = useCallback(() => {
    if (!drag) return;
    // Flush any pending rAF update synchronously so the drop-position
    // reflects the freshest pointer event, not whatever was last
    // committed to React state.
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    const finalPos = pendingRef.current ?? localOverrides[drag.id];
    pendingRef.current = null;
    if (finalPos && onLayoutChange) {
      const maxZ = Math.max(0, ...hydrated.map((dc) => dc.layout.z ?? 0));
      onLayoutChange([{ id: drag.id, ...finalPos, z: maxZ + 1 }]);
    }
    setDrag(null);
  }, [drag, localOverrides, onLayoutChange, hydrated]);

  if (dashboardCharts.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-2">
        <p className="text-caption text-text-tertiary">
          {emptyMessage ?? t('dashboards.canvas.emptyMessage')}
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
          // Tag the tile being dragged so CSS can kill its transitions
          // and make cursor follow 1:1 instead of easing.
          const isDragging = drag?.id === dc.id;
          return (
            <div
              key={dc.id}
              className={`group absolute${isDragging ? ' canvas-tile-dragging' : ''}`}
              style={{ left: x, top: y, width: w, height: h, zIndex: z }}
            >
              {canEdit && (
                <div
                  className="absolute inset-x-0 top-0 z-10 h-6 cursor-move bg-transparent"
                  onPointerDown={(e) => onPointerDown(e, dc, { kind: 'move' })}
                  title={t('dashboards.canvas.dragToMove')}
                />
              )}
              {dc.widget_type && dc.widget_type !== 'chart' ? (
                <div
                  className={`relative h-full w-full group ${
                    dc.widget_type === 'shape'
                      ? ''
                      : 'dashboard-tile bi-card-hover rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 overflow-hidden'
                  }`}
                >
                  <DashboardWidget widget={dc} />
                  {canEdit && (
                    <div className="absolute right-2 top-2 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      {onEditWidget && (
                        <button
                          type="button"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => onEditWidget(dc.id)}
                          className="rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 p-1.5 shadow-linear-sm transition-colors hover:border-brand/40 hover:bg-brand/10 hover:text-brand"
                          title={t('dashboards.canvas.editWidget')}
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
                          title={t('dashboards.canvas.removeWidget')}
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
                  /* Source dims, targets filter, per-chart opt-out — see DashboardGrid. */
                  crossFilters={crossFilterSourceChartId === dc.chart_id || dc.layout?.highlightEnabled === false ? [] : crossFilters}
                  highlightFilter={dc.layout?.highlightEnabled === false || highlightSourceChartId !== dc.chart_id ? null : highlightFilter}
                  isHighlightSource={highlightSourceChartId === dc.chart_id}
                  onDataLoaded={onChartDataLoaded}
                  onSelectCrossFilter={
                    onSelectCrossFilter && dc.layout?.highlightEnabled !== false ? (filter) => onSelectCrossFilter(dc.chart_id, filter) : undefined
                  }
                  isCrossFilterSource={crossFilterSourceChartId === dc.chart_id}
                  instanceParameters={dc.parameters ?? {}}
                  availablePages={availablePages}
                  currentPageId={
                    typeof dc.layout?.pageId === 'string' ? dc.layout.pageId : (availablePages[0]?.id ?? null)
                  }
                  onMoveToPage={onMoveChartToPage ? (pageId) => onMoveChartToPage(dc.id, pageId) : undefined}
                  isFocused={focusedDashboardChartId === dc.id}
                  onFocus={onFocusChart}
                />
              </ChartErrorBoundary>
              )}
              {canEdit && (
                <>
                  {/* 4 corners only. Each stretches both width and height.
                      Edges removed per DA feedback — too noisy and easy to
                      hit edge instead of corner. */}
                  <div
                    className="canvas-resize-handle canvas-resize-nw"
                    onPointerDown={(e) => onPointerDown(e, dc, { kind: 'resize', dir: 'nw' })}
                    title={t('dashboards.canvas.dragToResize')}
                  />
                  <div
                    className="canvas-resize-handle canvas-resize-ne"
                    onPointerDown={(e) => onPointerDown(e, dc, { kind: 'resize', dir: 'ne' })}
                    title={t('dashboards.canvas.dragToResize')}
                  />
                  <div
                    className="canvas-resize-handle canvas-resize-sw"
                    onPointerDown={(e) => onPointerDown(e, dc, { kind: 'resize', dir: 'sw' })}
                    title={t('dashboards.canvas.dragToResize')}
                  />
                  <div
                    className="canvas-resize-handle canvas-resize-se"
                    onPointerDown={(e) => onPointerDown(e, dc, { kind: 'resize', dir: 'se' })}
                    title={t('dashboards.canvas.dragToResize')}
                  />
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
