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
import { DASHBOARD_GRID_COLS, dashboardRowHeight } from '@/lib/dashboard-pages';
import { useExportMode } from '@/lib/export-mode';
import { useI18n } from '@/providers/LanguageProvider';

// Non-responsive grid: a single 12-column layout that simply scales cell
// width with the container. Avoiding ResponsiveGridLayout means opening
// DevTools (or any viewport shrink) won't reflow charts onto a different
// breakpoint and clobber the saved layout.
const FixedGridLayout = WidthProvider(GridLayout);

/** Wrapper that defers rendering children until the element is visible. */
function LazyChartSlot({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  // Phase-B22 — during PDF export, render immediately (don't wait for scroll)
  // so off-screen tiles aren't blank in the capture.
  const exporting = useExportMode();

  useEffect(() => {
    if (exporting) { setVisible(true); return; }
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
  }, [exporting]);

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
  /** Forwarded to ChartTile — gate the tile data fetch until the page has
   *  seeded filters/slicers from the saved config (avoids the unfiltered flash
   *  + wasted warehouse scan). See ChartTileProps.filtersReady. */
  filtersReady?: boolean;
  globalFilters?: BaseFilter[];
  crossFilters?: BaseFilter[];
  crossFilterSourceChartId?: number | null;
  /** Cross-highlight (PBI-parity) — the active selection's P filter and its
   *  source chart. Applies to every tile (source dims locally; targets overlay
   *  a P-filtered query). null when no highlight active / mode off. */
  highlightFilter?: BaseFilter | null;
  highlightSourceChartId?: number | null;
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
  /** Phase-B17 — collaborators currently editing each tile (GG-Sheets cursors). */
  presenceByChart?: Record<number, { name: string; color: string }>;
  /** Dashboard-level parameter values (what-if / field parameters). Consumed by
   *  parameter_switcher + text widgets. */
  params?: Record<string, any>;
  onParamChange?: (paramName: string, value: any) => void;
  /** Open the what-if parameter bind modal for a chart tile (editor only). */
  onBindParameter?: (dashboardChartId: number) => void;
}


/**
 * The surface behind a group of tiles.
 *
 * A report with only ONE surface depth — page under card — reads as a bag of
 * loose tiles however well each tile is styled, and no amount of card polish
 * fixes it, because grouping is a surface, not a border on each member. This
 * draws that missing level: a `section_header` widget opens a band, the band
 * runs until the next header, and every tile in between sits on it.
 *
 * Drawn as a backdrop layer rather than as a real container because
 * react-grid-layout positions children absolutely from the layout array — a
 * wrapper element would have to become a grid item and would then be draggable,
 * resizable and collide with its own contents. The geometry is deterministic,
 * so the band can be computed from the same numbers the library uses:
 *
 *   colWidth = (W - mx*(cols+1)) / cols
 *   x_px     = colWidth*x + (x+1)*mx        w_px = w*colWidth + (w-1)*mx
 *   y_px     = rowH*y     + (y+1)*my        h_px = h*rowH     + (h-1)*my
 *
 * Bands are inert to the pointer so dragging, resizing and tile clicks behave
 * exactly as before.
 */
function SectionBands({
  layouts, dashboardCharts, cols, rowH, margin, width,
}: {
  layouts: Layout[];
  dashboardCharts: any[];
  cols: number;
  rowH: number;
  margin: [number, number];
  width: number;
}) {
  const bands = React.useMemo(() => {
    if (!width) return [];
    const [mx, my] = margin;
    const typeById = new Map<string, string>(
      dashboardCharts.map((dc) => [String(dc.id), String(dc.widget_type ?? 'chart')]),
    );
    const sorted = [...layouts].sort((a, b) => a.y - b.y || a.x - b.x);
    const headers = sorted.filter((l) => typeById.get(l.i) === 'section_header');
    if (!headers.length) return [];

    const colWidth = (width - mx * (cols + 1)) / cols;
    const out: { key: string; left: number; top: number; width: number; height: number }[] = [];

    headers.forEach((header, idx) => {
      const next = headers[idx + 1];
      // Members are the tiles between this header and the next one. The header
      // itself is included so the band starts at its top edge.
      const members = sorted.filter((l) =>
        l.y >= header.y && (next ? l.y < next.y : true));
      if (members.length < 2) return; // a header with nothing under it is not a group

      const minX = Math.min(...members.map((l) => l.x));
      const maxX = Math.max(...members.map((l) => l.x + l.w));
      const minY = Math.min(...members.map((l) => l.y));
      const maxY = Math.max(...members.map((l) => l.y + l.h));

      const left = colWidth * minX + (minX + 1) * mx;
      const right = colWidth * maxX + maxX * mx;
      const top = rowH * minY + (minY + 1) * my;
      const bottom = rowH * maxY + maxY * my;
      out.push({
        key: header.i,
        // Bleed a little past the tiles so the band reads as containing them
        // rather than as a rectangle drawn exactly under them.
        left: left - mx / 2,
        top: top - my / 2,
        width: (right - left) + mx,
        height: (bottom - top) + my,
      });
    });
    return out;
  }, [layouts, dashboardCharts, cols, rowH, margin, width]);

  if (!bands.length) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-0" aria-hidden="true">
      {bands.map((b) => (
        <div
          key={b.key}
          className="dashboard-section-band absolute"
          style={{ left: b.left, top: b.top, width: b.width, height: b.height }}
        />
      ))}
    </div>
  );
}

export function DashboardGrid({
  dashboardId,
  dashboardCharts,
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
  themeConfig = null,
  disableLazy = false,
  focusedDashboardChartId = null,
  onFocusChart,
  presenceByChart,
  params = {},
  onParamChange,
  onBindParameter,
}: DashboardGridProps) {
  const { t } = useI18n();
  // Convert backend layout to react-grid-layout format.
  //
  // Resize is FLEXIBLE for both charts and widgets: 8 handles (every edge AND
  // corner) so you can nudge JUST the width or JUST the height, plus a 1-row
  // floor so a card — a KPI especially — can be made tight instead of being
  // forced to a 2-row block with dead space under the value. (Charts were
  // previously pinned to 4 corners + a 2×2 floor; that made single-axis sizing
  // fiddly and left KPI cards looking empty, so it's lifted.) Charts keep a
  // 2-column minimum so they stay legible; widgets can shrink to a single column.
  const RESIZE_HANDLES: Array<'s' | 'w' | 'e' | 'n' | 'se' | 'sw' | 'ne' | 'nw'> =
    ['s', 'w', 'e', 'n', 'se', 'sw', 'ne', 'nw'];
  // Render tiles at their STORED coordinates — NO liftLayoutToTop. An empty band
  // above the topmost tile is the DA's intentional spacing and must survive render
  // (WYSIWYG with the published report). "Dồn lên trên" is an explicit, on-demand
  // action only — never a render/persist side effect.
  // WidthProvider measures the grid internally and does not expose it, so the
  // section backdrop takes its own measurement of the same box.
  //
  // ABOVE the empty-state early return on purpose: these three hooks used to
  // sit below it, so a dashboard going from zero charts to one changed the
  // hook count between renders and threw React #300, taking the grid with it.
  const gridWrapRef = React.useRef<HTMLDivElement | null>(null);
  const [gridWidth, setGridWidth] = React.useState(0);
  React.useEffect(() => {
    const el = gridWrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width ?? 0;
      // Only react to real changes: a sub-pixel jitter here would re-render the
      // whole grid on every scroll-driven layout pass.
      setGridWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Below this the 12-column arrangement stops being readable rather than
  // merely tight: measured on a 4-KPI console at 390px, each card came out
  // 53px wide and "16.0M" rendered as "1".
  const NARROW_GRID_PX = 700;
  const isNarrow = gridWidth > 0 && gridWidth < NARROW_GRID_PX;

  const authoredLayouts = dashboardCharts.map((dc) => {
    const layout = dc.layout;
    const isWidget = Boolean(dc.widget_type && dc.widget_type !== 'chart');
    return {
      i: dc.id.toString(),
      x: layout.x || 0,
      y: layout.y || 0,
      w: layout.w || 12,
      h: layout.h || 12,
      // Finer-grid minimums (36-col / small-row): smaller than the old 2×1 so a
      // DA can "thu vào bé hơn", while charts keep a legible floor (4 cols ≈ 11%
      // width, 3 rows) and widgets can go tiny.
      minW: isWidget ? 2 : 4,
      minH: isWidget ? 1 : 3,
      // Locked tile → react-grid-layout `static`: not draggable, not resizable,
      // and never displaced by a neighbour. Prevents accidental nudges.
      static: Boolean(layout.locked),
      resizeHandles: RESIZE_HANDLES,
    };
  });

  /**
   * The same tiles, stacked, for a viewport too narrow to hold the grid.
   *
   * This is a PROJECTION, never a save. `ResponsiveGridLayout` was rejected for
   * exactly that reason -- it reflows onto a breakpoint and then reports the
   * reflowed positions through `onLayoutChange`, so opening DevTools once would
   * rewrite a report's desktop layout. Deriving the narrow arrangement here and
   * refusing to persist it keeps the authored geometry the single source of
   * truth: widen the window and the original comes back untouched.
   *
   * Reading order is the authored one -- top to bottom, left to right -- so a
   * KPI strip stays above the charts it introduces.
   */
  const narrowLayouts = React.useMemo(() => {
    if (!isNarrow) return authoredLayouts;
    const byReadingOrder = [...authoredLayouts].sort((a, b) => (a.y - b.y) || (a.x - b.x));
    let cursor = 0;
    return byReadingOrder.map((item) => {
      // Full width, and tall enough that a chart squeezed to one column is
      // still worth looking at.
      const height = Math.max(item.h, item.minH ?? 3);
      const placed = { ...item, x: 0, y: cursor, w: DASHBOARD_GRID_COLS, h: height, static: true };
      cursor += height;
      return placed;
    });
  }, [isNarrow, authoredLayouts]);

  const layouts = isNarrow ? narrowLayouts : authoredLayouts;

  // Persist ONLY the tile the user just finished manipulating. react-grid-layout
  // hands the moved item as the 3rd onDragStop/onResizeStop arg; we forward JUST
  // that item (a single-element array), never the whole layout — so a gesture is a
  // one-chart transaction: sibling coordinates are never re-read or re-written.
  // (Free-form compactType={null}+preventCollision already means siblings didn't
  // move; this guarantees we don't RECORD them either.) Persisting on "stop" — not
  // the mid-drag events — keeps the draft from jumping on reload.
  const persistItem = (item?: Layout) => {
    if (!onLayoutChange || !item) return;
    const prev = layouts.find((l) => l.i === item.i);
    const changed = !prev
      || item.x !== prev.x || item.y !== prev.y || item.w !== prev.w || item.h !== prev.h;
    if (changed) onLayoutChange([item]);
  };


  if (dashboardCharts.length === 0) {
    return (
      <div className="bi-empty-state bi-fade-in flex h-72 flex-col items-center justify-center gap-3 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-1 shadow-linear-sm">
          <LayoutDashboard className="h-7 w-7 text-brand/70" strokeWidth={1.5} />
        </div>
        <div>
          <h3 className="text-base font-semibold text-text-primary">
            {emptyMessage ? '' : t('dashboards.grid.emptyTitle')}
          </h3>
          <p className="mt-1 max-w-sm text-[13px] text-text-tertiary">
            {emptyMessage ?? t('dashboards.grid.emptyMessage')}
          </p>
        </div>
      </div>
    );
  }

  // Finer grid: 36 cols + a row height coupled to the theme gap so ×3-migrated
  // tiles keep their exact pixel size (see dashboardRowHeight). Margin unchanged.
  const gridMargin = getDashboardGridMargin(themeConfig);
  const gridRowHeight = dashboardRowHeight(gridMargin[1]);
  return (
    <div ref={gridWrapRef} className="relative">
      <SectionBands
        layouts={layouts}
        dashboardCharts={dashboardCharts}
        cols={DASHBOARD_GRID_COLS}
        rowH={gridRowHeight}
        margin={gridMargin}
        width={gridWidth}
      />
    <FixedGridLayout
      // `rgl-no-anim` (edit mode only) kills the library's 200ms position
      // transition on ALL tiles so a settled drag doesn't leave siblings sliding
      // — the builder prioritises pixel accuracy / cursor-fidelity. Public keeps
      // the transition (plain `layout`).
      className={onLayoutChange ? 'layout rgl-no-anim' : 'layout'}
      layout={layouts}
      cols={DASHBOARD_GRID_COLS}
      rowHeight={gridRowHeight}
      margin={gridMargin}
      onDragStop={(_layout, _oldItem, newItem) => { if (!isNarrow) persistItem(newItem); }}
      onResizeStop={(_layout, _oldItem, newItem) => { if (!isNarrow) persistItem(newItem); }}
      draggableHandle=".drag-handle"
      // Never start a drag from an interactive control or the widget's own
      // edit/delete cluster (whole widget bodies are now drag handles).
      draggableCancel=".no-drag, button, select, input, textarea, a"
      isDraggable={!!onLayoutChange && !isNarrow}
      isResizable={!!onLayoutChange && !isNarrow}
      // Grid arrange model = FREE-FORM / WYSIWYG (matches the published report,
      // which renders with compactType={null} + preventCollision). A tile stays
      // EXACTLY where the user drops it; dragging one tile never reflows the
      // others (no more "cards suddenly jump down" when a tall tile is moved into
      // their row). Dropping onto an occupied cell returns the dragged tile to
      // its origin instead of cascading its neighbours. This keeps the builder
      // pixel-identical to what viewers see, and keeps existing layouts rendering
      // exactly as stored. Auto-pack (compactType="vertical") was rejected because
      // its live reflow moved tiles the user hadn't touched.
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
          || dc.widget_type === 'section_header'
          || dc.widget_type === 'callout'
          || dc.widget_type === 'hero_strip'
        );
        // Per-widget "transparent background" also drops the card frame so the
        // dashboard bg shows through (text/image/countdown widgets).
        const transparentWidget = isWidget
          && ((dc.widget_config ?? {}) as Record<string, any>).transparentBackground === true;
        const framelessWidget = isVisualWidget || transparentWidget;
        const tile = isWidget ? (
          // The WHOLE widget body is the drag handle (a widget is a visual
          // add-on you move like a shape, not a chart with a header). The thin
          // 20px top strip was a fiddly target — especially on a slim h=1 tile
          // where it was 25% of the tile. draggableCancel (on the grid) stops a
          // drag from starting on the edit/delete buttons or any form control.
          <div
            className={`group relative h-full w-full ${canEdit ? 'drag-handle cursor-move' : ''} ${
              framelessWidget
                ? ''
                : 'dashboard-tile bi-card-hover rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 overflow-hidden'
            }`}
            title={canEdit ? t('dashboards.grid.dragToMove') : undefined}
          >
            <DashboardWidget widget={dc} params={params} onParamChange={onParamChange} />
            {canEdit && (
              <div className="no-drag absolute right-2 top-2 z-20 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                {onEditWidget && (
                  <button
                    type="button"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => onEditWidget(dc.id)}
                    className="rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 p-1.5 shadow-linear-sm transition-colors hover:border-brand/40 hover:bg-brand/10 hover:text-brand"
                    title={t('dashboards.grid.editWidget')}
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
                    title={t('dashboards.grid.removeWidget')}
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
            filtersReady={filtersReady}
            globalFilters={globalFilters}
            /* Click a point → SOURCE chart dims its non-selected marks, every
               OTHER chart FILTERS to the value (PBI parity):
                 • source tile: highlightFilter set (local dim), crossFilters []
                   (not filtered itself).
                 • target tiles: highlightFilter null, crossFilters [P] (filter).
               Per-chart opt-out (layout.highlightEnabled === false): tile neither
               emits clicks, dims, nor gets filtered. */
            crossFilters={crossFilterSourceChartId === dc.chart_id || dc.layout?.highlightEnabled === false ? [] : crossFilters}
            highlightFilter={dc.layout?.highlightEnabled === false || highlightSourceChartId !== dc.chart_id ? null : highlightFilter}
            isHighlightSource={highlightSourceChartId === dc.chart_id}
            onDataLoaded={onChartDataLoaded}
            onSelectCrossFilter={onSelectCrossFilter && dc.layout?.highlightEnabled !== false ? (filter) => onSelectCrossFilter(dc.chart_id, filter) : undefined}
            isCrossFilterSource={crossFilterSourceChartId === dc.chart_id}
            instanceParameters={dc.parameters ?? {}}
            dashboardParams={params}
            onBindParameter={onBindParameter ? () => onBindParameter(dc.id) : undefined}
            availablePages={availablePages}
            currentPageId={typeof dc.layout?.pageId === 'string' ? dc.layout.pageId : (availablePages[0]?.id ?? null)}
            onMoveToPage={onMoveChartToPage ? (pageId) => onMoveChartToPage(dc.id, pageId) : undefined}
            isFocused={focusedDashboardChartId === dc.id}
            onFocus={onFocusChart}
            editingBy={presenceByChart?.[dc.id] ?? null}
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
    </div>
  );
}
