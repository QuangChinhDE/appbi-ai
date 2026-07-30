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
import { liftLayoutToTop } from '@/lib/dashboard-pages';
import { useExportMode } from '@/lib/export-mode';
import { useI18n } from '@/providers/LanguageProvider';

// Non-responsive grid: a single 12-column layout that simply scales cell
// width with the container. Avoiding ResponsiveGridLayout means opening
// DevTools (or any viewport shrink) won't reflow charts onto a different
// breakpoint and clobber the saved layout.
const FixedGridLayout = WidthProvider(GridLayout);

// ── Smart-insert collision resolver ─────────────────────────────────────────
// react-grid-layout can't do "auto-spread on insert" while preserving an
// intentional empty gap (compactType='vertical' reflows but forbids gaps;
// compactType=null either scatters on push or blocks). So the grid runs
// allowOverlap (tiles may overlap DURING a drag — others stay put, no mid-drag
// scatter) and we resolve on drag/resize STOP with this pure function:
//
//   • the moved/resized tile is FIXED where the user dropped it (priority);
//   • every OTHER tile keeps its exact position UNLESS it overlaps a
//     higher-priority (already-settled) tile, in which case it is pushed
//     straight DOWN by the minimum needed to clear;
//   • tiles are settled top→bottom so a push cascades onto the next tile — a
//     clean, BOUNDED "make room" — while any tile off the collision path keeps
//     its spot, so a gap the DA left on purpose survives.
//
// Result: dropping a chart between two others spreads only what's necessary
// (auto-insert) AND gaps are preserved — without the runaway scatter of raw
// compactType=null + preventCollision=false. Pure + testable; the settled layout
// is saved through the normal onLayoutChange → save-on-stop path (save flow
// untouched).
type Rect = { x: number; y: number; w: number; h: number };
function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
export function resolveSmartInsert(
  prev: Layout[],
  movedId: string,
  movedRect: Rect,
): Layout[] {
  const movedSrc = prev.find((l) => l.i === movedId);
  if (!movedSrc) return prev;
  const moved: Layout = { ...movedSrc, ...movedRect };
  const others = prev
    .filter((l) => l.i !== movedId)
    .map((l) => ({ ...l }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: Layout[] = [moved];
  for (const t of others) {
    let guard = 0;
    // Push t straight down until it clears every already-settled tile. Bounded:
    // each step lands it just below a blocker and there are finitely many tiles.
    while (guard++ < 500) {
      const hit = placed.find((p) => rectsOverlap(t, p));
      if (!hit) break;
      t.y = hit.y + hit.h;
    }
    placed.push(t);
  }
  return placed;
}

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
  const layouts = liftLayoutToTop(
    dashboardCharts.map((dc) => {
      const layout = dc.layout;
      const isWidget = Boolean(dc.widget_type && dc.widget_type !== 'chart');
      return {
        i: dc.id.toString(),
        x: layout.x || 0,
        y: layout.y || 0,
        w: layout.w || 4,
        h: layout.h || 4,
        minW: isWidget ? 1 : 2,
        minH: 1,
        resizeHandles: RESIZE_HANDLES,
      };
    }),
  );

  // Persist ONLY when the user FINISHES a drag/resize, via onDragStop /
  // onResizeStop — RGL hands us the moved/resized item at its dropped position.
  // We run smart-insert (resolveSmartInsert) to spread only the tiles that must
  // move (auto-insert) while keeping gaps, then save the settled result. Saving
  // on "stop" (not mid-drag onLayoutChange) is what keeps the draft from
  // "jumping" on reload. Mount never fires a stop event, so the as-saved layout
  // is shown but not re-persisted (public stays as-saved).
  const persistSmartLayout = (moved: Layout | undefined) => {
    if (!onLayoutChange || !moved) return;
    const resolved = resolveSmartInsert(layouts, moved.i, {
      x: moved.x,
      y: moved.y,
      w: moved.w,
      h: moved.h,
    });
    const oldById = new Map(layouts.map((l) => [l.i, l]));
    const hasChanged = resolved.some((item) => {
      const o = oldById.get(item.i);
      return o && (item.x !== o.x || item.y !== o.y || item.w !== o.w || item.h !== o.h);
    });
    if (hasChanged) onLayoutChange(resolved);
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

  return (
    <FixedGridLayout
      className="layout"
      layout={layouts}
      cols={12}
      rowHeight={80}
      margin={getDashboardGridMargin(themeConfig)}
      onDragStop={(_l, _oldItem, newItem) => persistSmartLayout(newItem)}
      onResizeStop={(_l, _oldItem, newItem) => persistSmartLayout(newItem)}
      draggableHandle=".drag-handle"
      // Never start a drag from an interactive control or the widget's own
      // edit/delete cluster (whole widget bodies are now drag handles).
      draggableCancel=".no-drag, button, select, input, textarea, a"
      isDraggable={!!onLayoutChange}
      isResizable={!!onLayoutChange}
      // SMART-INSERT (see resolveSmartInsert above). compactType=null keeps the
      // grid free-form so an intentional empty gap is preserved and the builder
      // stays WYSIWYG with the public view. allowOverlap lets a tile float over
      // others DURING the drag (others don't scatter mid-drag); on drag/resize
      // STOP we resolve — the dropped tile pushes only the tiles it lands on
      // straight down (auto-insert) and everything else keeps its place. This is
      // the "gaps AND auto-spread, no scatter" behaviour raw RGL can't give
      // (compactType=null+preventCollision=false scatters; ="vertical" forbids
      // gaps). "Tidy layout" still packs the grid on demand.
      compactType={null}
      allowOverlap={true}
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
  );
}
