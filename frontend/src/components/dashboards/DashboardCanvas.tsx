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

type Box = { xPx: number; yPx: number; wPx: number; hPx: number };

const MIN_W = 80;
const MIN_H = 60;
// Smart-guide snap threshold in DESIGN px: when a moving/resizing edge lands
// this close to a sibling edge/centre (or a canvas edge) it snaps flush and a
// guide line is drawn — mirrors PowerBI / Figma alignment guides.
const SNAP_TH = 6;
// Body-drag start threshold in SCREEN px: a press-and-move past this on a tile
// body becomes a move; a plain click below it passes through to the chart
// (cross-filter / menu keep working). This is how "drag the whole tile" stays
// compatible with the chart's own click handlers.
const BODY_DRAG_TH = 4;
// Visible grid dot spacing in DESIGN px (a multiple of the 8px snap so dots
// line up with snap stops). Rendered only while editing.
const GRID_DOT = 16;

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
  /** Forwarded to ChartTile — gate the tile data fetch until the page has
   *  seeded filters/slicers (avoids the unfiltered flash + wasted scan).
   *  See ChartTileProps.filtersReady. */
  filtersReady?: boolean;
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
  /** Dashboard-level parameter values (what-if / field parameters). */
  params?: Record<string, any>;
  onParamChange?: (paramName: string, value: any) => void;
  onBindParameter?: (dashboardChartId: number) => void;
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
  filtersReady = true,
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
  params = {},
  onParamChange,
  onBindParameter,
}: DashboardCanvasProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(canvasConfig?.width ?? 1440);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [localOverrides, setLocalOverrides] = useState<Record<number, Box>>({});
  // Active alignment guide lines (DESIGN px) drawn while dragging/resizing.
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>({ v: [], h: [] });

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
  // Fit-to-width WITHOUT the old CSS `transform: scale()` (which rasterised the
  // whole canvas and blurred every chart + label). Instead we keep coordinates
  // in design space for storage/drag math, and multiply them by `scale` only at
  // render time — so each chart lays out at its true pixel size and stays crisp.
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

  // Current design-space box for a tile (live override wins over saved layout).
  const boxOf = useCallback(
    (dc: DashboardChart): Box => {
      const o = localOverrides[dc.id];
      return {
        xPx: o?.xPx ?? dc.layout.xPx ?? 0,
        yPx: o?.yPx ?? dc.layout.yPx ?? 0,
        wPx: o?.wPx ?? dc.layout.wPx ?? 320,
        hPx: o?.hPx ?? dc.layout.hPx ?? 240,
      };
    },
    [localOverrides],
  );

  // Snap the dragged box to sibling edges/centres + canvas edges, returning the
  // adjusted box and the guide lines to draw. Only the ACTIVE edges snap:
  // all four for a move, the grabbed edge(s) for a resize.
  const snapToSiblings = useCallback(
    (box: Box, mode: DragMode, selfId: number): { box: Box; v: number[]; h: number[] } => {
      const others = hydrated.filter((d) => d.id !== selfId).map(boxOf);
      const vCand = [0, designWidth];
      const hCand = [0];
      for (const o of others) {
        vCand.push(o.xPx, o.xPx + o.wPx / 2, o.xPx + o.wPx);
        hCand.push(o.yPx, o.yPx + o.hPx / 2, o.yPx + o.hPx);
      }
      let { xPx, yPx, wPx, hPx } = box;
      const v: number[] = [];
      const h: number[] = [];
      const nearest = (edge: number, cands: number[]) => {
        let best: { delta: number; line: number } | null = null;
        for (const c of cands) {
          const d = c - edge;
          if (Math.abs(d) <= SNAP_TH && (!best || Math.abs(d) < Math.abs(best.delta))) {
            best = { delta: d, line: c };
          }
        }
        return best;
      };
      if (mode.kind === 'move') {
        const bv =
          nearest(xPx, vCand) ??
          nearest(xPx + wPx / 2, vCand) ??
          nearest(xPx + wPx, vCand);
        if (bv) { xPx += bv.delta; v.push(bv.line); }
        const bh =
          nearest(yPx, hCand) ??
          nearest(yPx + hPx / 2, hCand) ??
          nearest(yPx + hPx, hCand);
        if (bh) { yPx += bh.delta; h.push(bh.line); }
      } else {
        const dir = mode.dir;
        const growLeft = dir === 'w' || dir === 'nw' || dir === 'sw';
        const growRight = dir === 'e' || dir === 'ne' || dir === 'se';
        const growTop = dir === 'n' || dir === 'nw' || dir === 'ne';
        const growBottom = dir === 's' || dir === 'sw' || dir === 'se';
        if (growRight) {
          const b = nearest(xPx + wPx, vCand);
          if (b) { wPx = Math.max(MIN_W, wPx + b.delta); v.push(b.line); }
        } else if (growLeft) {
          const b = nearest(xPx, vCand);
          if (b) { const nl = xPx + b.delta; wPx = Math.max(MIN_W, wPx - (nl - xPx)); xPx = nl; v.push(b.line); }
        }
        if (growBottom) {
          const b = nearest(yPx + hPx, hCand);
          if (b) { hPx = Math.max(MIN_H, hPx + b.delta); h.push(b.line); }
        } else if (growTop) {
          const b = nearest(yPx, hCand);
          if (b) { const nt = yPx + b.delta; hPx = Math.max(MIN_H, hPx - (nt - yPx)); yPx = nt; h.push(b.line); }
        }
      }
      return { box: { xPx, yPx, wPx, hPx }, v, h };
    },
    [hydrated, boxOf, designWidth],
  );

  const beginDrag = useCallback(
    (dc: DashboardChart, mode: DragMode, clientX: number, clientY: number) => {
      const l = dc.layout;
      setDrag({
        id: dc.id,
        startX: clientX,
        startY: clientY,
        origX: l.xPx ?? 0,
        origY: l.yPx ?? 0,
        origW: l.wPx ?? 320,
        origH: l.hPx ?? 240,
        mode,
      });
    },
    [],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent, dc: DashboardChart, mode: DragMode) => {
      if (!canEdit) return;
      e.stopPropagation();
      onFocusChart?.(dc.id);
      const target = e.currentTarget as HTMLElement;
      try { target.setPointerCapture(e.pointerId); } catch { /* pointer already released */ }
      beginDrag(dc, mode, e.clientX, e.clientY);
    },
    [canEdit, onFocusChart, beginDrag],
  );

  // Press-and-move on a tile BODY → move (drag the whole tile). A press that
  // doesn't move past BODY_DRAG_TH passes through as a normal click so the
  // chart's cross-filter / menu still work. Interactive targets (buttons,
  // inputs, links, the resize handles, the explicit move header) are excluded
  // so their own handlers win.
  const pendingBodyRef = useRef<
    { id: number; startX: number; startY: number; origX: number; origY: number; origW: number; origH: number } | null
  >(null);

  const onBodyPointerDown = useCallback(
    (e: React.PointerEvent, dc: DashboardChart) => {
      if (!canEdit || e.button !== 0) return;
      const el = e.target as HTMLElement;
      if (
        el.closest(
          'button, a, input, select, textarea, [role="button"], [data-no-drag], .canvas-resize-handle, .canvas-move-header',
        )
      ) {
        return;
      }
      onFocusChart?.(dc.id);
      const l = dc.layout;
      pendingBodyRef.current = {
        id: dc.id,
        startX: e.clientX,
        startY: e.clientY,
        origX: l.xPx ?? 0,
        origY: l.yPx ?? 0,
        origW: l.wPx ?? 320,
        origH: l.hPx ?? 240,
      };
    },
    [canEdit, onFocusChart],
  );

  // rAF-throttle for pointer move. Without this, fast drags fire 100+
  // pointermove events per second, each triggering a setState → React
  // re-render. Coalescing to one update per animation frame (~60fps)
  // makes the drag feel buttery without losing precision — the latest
  // event always wins because we keep the freshest values in pendingRef.
  const pendingRef = useRef<Box | null>(null);
  const pendingGuidesRef = useRef<{ v: number[]; h: number[] }>({ v: [], h: [] });
  const rafIdRef = useRef<number | null>(null);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) {
        // Not dragging yet — see if a pending body-press has moved far enough
        // to promote into a whole-tile move.
        const p = pendingBodyRef.current;
        if (p) {
          const moved = Math.hypot(e.clientX - p.startX, e.clientY - p.startY);
          if (moved > BODY_DRAG_TH) {
            setDrag({ ...p, mode: { kind: 'move' } });
            try { containerRef.current?.setPointerCapture(e.pointerId); } catch { /* pointer already released */ }
          }
        }
        return;
      }
      const dx = (e.clientX - drag.startX) / scale;
      const dy = (e.clientY - drag.startY) / scale;
      let next: Box;
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
      // Smart alignment: pull the active edges to nearby siblings + record guides.
      const snapped = snapToSiblings(next, drag.mode, drag.id);
      next = snapped.box;
      pendingRef.current = next;
      pendingGuidesRef.current = { v: snapped.v, h: snapped.h };
      if (rafIdRef.current == null) {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null;
          const pending = pendingRef.current;
          if (!pending) return;
          setLocalOverrides((m) => ({ ...m, [drag.id]: pending }));
          setGuides(pendingGuidesRef.current);
        });
      }
    },
    [drag, snap, scale, snapToSiblings],
  );

  const onPointerUp = useCallback(() => {
    pendingBodyRef.current = null;
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
    setGuides({ v: [], h: [] });
  }, [drag, localOverrides, onLayoutChange, hydrated]);

  // z-order controls (only meaningful when tiles overlap).
  const bringToFront = useCallback(
    (dc: DashboardChart) => {
      if (!onLayoutChange) return;
      const maxZ = Math.max(0, ...hydrated.map((d) => d.layout.z ?? 0));
      const b = boxOf(dc);
      onLayoutChange([{ id: dc.id, ...b, z: maxZ + 1 }]);
    },
    [onLayoutChange, hydrated, boxOf],
  );
  const sendToBack = useCallback(
    (dc: DashboardChart) => {
      if (!onLayoutChange) return;
      // Keep z >= 0: a negative z-index would drop the tile BEHIND the canvas
      // background (dot-grid) and make it vanish. z=0 still sits below the
      // default tile z (1) so it lands behind its neighbours.
      const zs = hydrated.map((d) => d.layout.z ?? 1);
      const minZ = zs.length ? Math.min(...zs) : 1;
      const b = boxOf(dc);
      onLayoutChange([{ id: dc.id, ...b, z: Math.max(0, minZ - 1) }]);
    },
    [onLayoutChange, hydrated, boxOf],
  );

  if (dashboardCharts.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-[rgb(var(--border-strong))] bg-surface-2">
        <p className="text-caption text-text-tertiary">
          {emptyMessage ?? t('dashboards.canvas.emptyMessage')}
        </p>
      </div>
    );
  }

  const showGrid = canEdit;

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
        className={showGrid ? 'canvas-dot-grid relative' : 'relative'}
        style={{
          width: designWidth * scale,
          height: requiredHeight * scale,
          ...(showGrid
            ? { backgroundSize: `${GRID_DOT * scale}px ${GRID_DOT * scale}px` }
            : {}),
        }}
      >
        {hydrated.map((dc) => {
          const o = localOverrides[dc.id];
          const x = (o?.xPx ?? dc.layout.xPx ?? 0) * scale;
          const y = (o?.yPx ?? dc.layout.yPx ?? 0) * scale;
          const w = (o?.wPx ?? dc.layout.wPx ?? 320) * scale;
          const h = (o?.hPx ?? dc.layout.hPx ?? 240) * scale;
          const z = dc.layout.z ?? 1;
          // Tag the tile being dragged so CSS can kill its transitions
          // and make cursor follow 1:1 instead of easing.
          const isDragging = drag?.id === dc.id;
          const isSelected = canEdit && focusedDashboardChartId === dc.id;
          return (
            <div
              key={dc.id}
              className={`group absolute${isDragging ? ' canvas-tile-dragging' : ''}${isSelected ? ' canvas-tile-selected' : ''}`}
              style={{ left: x, top: y, width: w, height: h, zIndex: isDragging ? 1000 : z }}
              onPointerDown={canEdit ? (e) => onBodyPointerDown(e, dc) : undefined}
            >
              {canEdit && (
                <div
                  className="canvas-move-header absolute inset-x-0 top-0 z-20 flex h-6 cursor-move items-center justify-center rounded-t-lg bg-[rgb(var(--brand)/0.10)]"
                  onPointerDown={(e) => onPointerDown(e, dc, { kind: 'move' })}
                  title={t('dashboards.canvas.dragToMove')}
                >
                  <span className="canvas-move-grip" aria-hidden />
                </div>
              )}
              {dc.widget_type && dc.widget_type !== 'chart' ? (
                <div
                  className={`relative h-full w-full group ${
                    dc.widget_type === 'shape'
                    || ((dc.widget_config ?? {}) as Record<string, any>).transparentBackground === true
                      ? ''
                      : 'dashboard-tile bi-card-hover rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 overflow-hidden'
                  }`}
                >
                  <DashboardWidget widget={dc} params={params} onParamChange={onParamChange} />
                  {canEdit && (
                    <div className="absolute right-2 top-2 z-30 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      {onEditWidget && (
                        <button
                          type="button"
                          data-no-drag
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
                          data-no-drag
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
                  filtersReady={filtersReady}
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
                  dashboardParams={params}
                  onBindParameter={onBindParameter ? () => onBindParameter(dc.id) : undefined}
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
                  {/* z-order controls — surface on the SELECTED tile so overlapping
                      tiles can be reordered (bottom-left, clear of ChartTile's own
                      top-right menu). */}
                  {isSelected && onLayoutChange && (
                    <div className="absolute bottom-1.5 left-1.5 z-30 flex items-center gap-1">
                      <button
                        type="button"
                        data-no-drag
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => bringToFront(dc)}
                        className="rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 p-1 shadow-linear-sm transition-colors hover:border-brand/40 hover:bg-brand/10 hover:text-brand"
                        title={t('dashboards.canvas.bringToFront')}
                      >
                        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
                          <rect x="5" y="5" width="8" height="8" rx="1" fill="currentColor" opacity="0.9" />
                          <rect x="3" y="3" width="6" height="6" rx="1" fill="none" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        data-no-drag
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => sendToBack(dc)}
                        className="rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 p-1 shadow-linear-sm transition-colors hover:border-brand/40 hover:bg-brand/10 hover:text-brand"
                        title={t('dashboards.canvas.sendToBack')}
                      >
                        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6">
                          <rect x="3" y="3" width="8" height="8" rx="1" fill="currentColor" opacity="0.9" />
                          <rect x="7" y="7" width="6" height="6" rx="1" fill="none" />
                        </svg>
                      </button>
                    </div>
                  )}
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

        {/* Smart alignment guides — thin brand lines while dragging/resizing. */}
        {drag && (guides.v.length > 0 || guides.h.length > 0) && (
          <div className="pointer-events-none absolute inset-0 z-[1001]">
            {guides.v.map((vx, i) => (
              <div
                key={`v-${i}`}
                className="canvas-align-guide"
                style={{ left: vx * scale, top: 0, width: 1, height: requiredHeight * scale }}
              />
            ))}
            {guides.h.map((hy, i) => (
              <div
                key={`h-${i}`}
                className="canvas-align-guide"
                style={{ left: 0, top: hy * scale, width: designWidth * scale, height: 1 }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
