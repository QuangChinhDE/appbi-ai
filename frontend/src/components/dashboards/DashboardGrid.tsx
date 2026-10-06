'use client';

import { measureContentRows, useMeasuredContentRows } from '@/lib/responsive-fit';
import { resolveReportLayout, type DeviceBreakpoint, type GridItem, type PageProfiles, type ResolvedLayout } from '@/lib/responsive-layout/resolve';
import React, { useRef, useState, useEffect } from 'react';
import GridLayout, { Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { ChartTile } from './ChartTile';
import { ChartErrorBoundary } from './ChartErrorBoundary';
import { DashboardWidget } from './DashboardWidget';
import { SectionBands } from './SectionBands';
import { DashboardChart, DashboardPageConfig, DashboardThemeConfig } from '@/types/api';
import { DashboardFilter } from '@/lib/filters';
import type { BaseFilter } from '@/lib/filters';
import { Loader2, LayoutDashboard } from 'lucide-react';
import { getDashboardGridMargin } from './DashboardThemeProvider';
import { DASHBOARD_GRID_COLS, REPORT_STACK_BREAKPOINT, RESPONSIVE_MIN_WIDTH_PX, STACK_MIN_HEIGHT_PX, dashboardRowHeight, reportBreakpointFor, type ResponsiveTileKind } from '@/lib/dashboard-pages';
import { settleStoredLayout } from '@/lib/grid-settle';
import { growInPlace, resolveDrop } from '@/lib/grid-arrange';
import { tileKindOf } from '@/lib/dashboard-presentation/tile-frame';
import { useExportMode } from '@/lib/export-mode';
import { useI18n } from '@/providers/LanguageProvider';
import { ReportEvidenceProvider, citedTilesOf } from '@/lib/report-evidence';
import { isSlicerControl } from '@/lib/slicer-placement';

// Non-responsive grid: ONE layout at the ONE width this component measures
// (gridWidth). Which layout that is — authored desktop, a derived device
// layout or a CUSTOM one — is decided by the responsive resolver, never by the
// grid: no ResponsiveGridLayout, no WidthProvider measuring a second width.

/** Readable floors for a device layout's cells (drag/resize minimums). */
function deviceMinCells(kind: ResponsiveTileKind, bp: DeviceBreakpoint, rowPitch: number): { minW: number; minH: number } {
  const refWidth = bp === 'md' ? 820 : 390;
  const colPx = refWidth / DASHBOARD_GRID_COLS;
  const minW = Math.min(DASHBOARD_GRID_COLS, Math.max(kind === 'widget' ? 2 : 3, Math.ceil((RESPONSIVE_MIN_WIDTH_PX[kind] ?? 0) / colPx)));
  const minH = Math.max(1, Math.ceil((STACK_MIN_HEIGHT_PX[kind] ?? 0) / Math.max(1, rowPitch)));
  return { minW, minH };
}

/** What the grid resolved, for the Builder's device badges and Customize. */
export type ResolvedLayoutSummary = Pick<ResolvedLayout, 'breakpoint' | 'source' | 'stale' | 'orphans' | 'dropped' | 'desktopFingerprint'>;

/** The element that scrolls the builder (the app scrolls inside <main>). */
function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

/**
 * Drag and resize auto-scroll. The grid never scrolled while a tile was
 * dragged, so moving an element across a long report meant dropping it,
 * scrolling and dragging again (the acceptance harness had to enlarge its
 * viewport to move a control from the top to the bottom). Near the top or
 * bottom edge of the scroll container the page now scrolls, faster the closer
 * the pointer; each step re-sends the pointer so the dragged tile follows.
 */
function useEdgeAutoScroll(anchor: React.RefObject<HTMLElement>) {
  const state = React.useRef<{ raf: number | null; x: number; y: number; box: HTMLElement | null; maxTop: number } | null>(null);
  // The pointer is tracked from the document itself while a drag is on: the
  // grid's own drag callback did not report every move (measured: the loop ran
  // but kept the position the drag started at), so it could never reach an edge.
  const onPointer = React.useCallback((e: MouseEvent) => {
    if (state.current && e.isTrusted !== false) { state.current.x = e.clientX; state.current.y = e.clientY; }
  }, []);
  const stop = React.useCallback(() => {
    if (state.current?.raf) cancelAnimationFrame(state.current.raf);
    state.current = null;
    document.removeEventListener('mousemove', onPointer, true);
  }, [onPointer]);
  const tick = React.useCallback(() => {
    const s = state.current;
    if (!s || !s.box) return;
    const isRoot = s.box === document.scrollingElement;
    const rect = isRoot ? { top: 0, bottom: window.innerHeight } : s.box.getBoundingClientRect();
    const EDGE = 80;
    let dy = 0;
    if (s.y < rect.top + EDGE) dy = -Math.ceil((rect.top + EDGE - s.y) / 3);
    else if (s.y > rect.bottom - EDGE) dy = Math.ceil((s.y - (rect.bottom - EDGE)) / 3);
    if (dy) {
      const before = s.box.scrollTop;
      // Down only as far as the report's end plus half a screen: room to drop
      // under the last row, never an endless scroll into empty space (the
      // free-form grid would drop the element thousands of pixels below).
      const next = before + Math.max(-28, Math.min(28, dy));
      s.box.scrollTop = dy > 0 ? Math.min(next, Math.max(before, s.maxTop)) : next;
      if (s.box.scrollTop !== before) {
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: s.x, clientY: s.y, bubbles: true }));
      }
    }
    s.raf = requestAnimationFrame(tick);
  }, []);
  const start = React.useCallback((event?: MouseEvent) => {
    stop();
    const box = scrollParentOf(anchor.current);
    let maxTop = Number.POSITIVE_INFINITY;
    if (box && anchor.current) {
      const isRoot = box === document.scrollingElement;
      const boxTop = isRoot ? 0 : box.getBoundingClientRect().top;
      const viewH = isRoot ? window.innerHeight : box.clientHeight;
      const items = Array.from(anchor.current.querySelectorAll<HTMLElement>('.react-grid-item:not(.react-grid-placeholder)'));
      const contentBottom = items.reduce((mx, el) => Math.max(mx, el.getBoundingClientRect().bottom - boxTop + box.scrollTop), 0);
      maxTop = Math.max(0, contentBottom + viewH / 2 - viewH);
    }
    state.current = { raf: null, x: event?.clientX ?? 0, y: event?.clientY ?? 0, box, maxTop };
    document.addEventListener('mousemove', onPointer, true);
    state.current.raf = requestAnimationFrame(tick);
  }, [anchor, onPointer, stop, tick]);
  const move = React.useCallback((event?: MouseEvent) => {
    if (state.current && event) { state.current.x = event.clientX; state.current.y = event.clientY; }
  }, []);
  React.useEffect(() => stop, [stop]);
  return { start, move, stop };
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
  /** Double-click an element: open it in the Inspector (manual builder). */
  onOpenInspector?: (dashboardChartId: number) => void;
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
  /** What the author can do on an empty page (the builder's guided start). */
  emptyActions?: React.ReactNode;
  /** Studio preview: project tablet widths exactly as the published report does
   *  (the authoring grid keeps the desktop layout at any editable width). */
  publicProjection?: boolean;
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
  /** AI Design selection. When given, it — not the single focus — decides
   *  which tiles show the selection ring. */
  selectedDashboardChartIds?: number[];
  onFocusChart?: (dashboardChartId: number, additive?: boolean) => void;
  /** Lock/unlock a tile through the page's draft buffer. */
  onToggleLock?: (dashboardChartId: number, next: boolean) => void;
  /** Stage a tile-level layout edit (title, appearance, toggles) in the page's
   *  draft buffer. When absent a tile writes its row directly. */
  onPatchLayout?: (dashboardChartId: number, patch: Record<string, any>) => void;
  /** Persisted (server ⊕ saved draft) layout for tile-level live toggles. */
  getPersistedLayout?: (dashboardChartId: number) => Record<string, any> | undefined;
  /** AI Design mode — tiles become click-to-focus targets (no drag handle) so a
   *  click anywhere on a tile scopes an AI restyle to just that visual. */
  aiDesignMode?: boolean;
  /** Phase-B17 — collaborators currently editing each tile (GG-Sheets cursors). */
  presenceByChart?: Record<number, { name: string; color: string }>;
  /** Dashboard-level parameter values (what-if / field parameters). Consumed by
   *  parameter_switcher + text widgets. */
  params?: Record<string, any>;
  onParamChange?: (paramName: string, value: any) => void;
  /** Open the what-if parameter bind modal for a chart tile (editor only). */
  onBindParameter?: (dashboardChartId: number) => void;
  /** Draws a slicer control (widget_type 'slicer') bound to the page's filter
   *  state. The grid only places it; it never sees filter state itself. */
  renderSlicerControl?: (dashboardChart: DashboardChart) => React.ReactNode;
  /** Bumped by the page when it refuses a gesture: the grid then re-reads the
   *  stored layout instead of keeping the tile where it was dropped. */
  layoutRevision?: number;
  /** The Builder's DESKTOP authoring canvas: draws the authored grid at any
   *  width >= the phone breakpoint (viewer surfaces use the width bands). */
  editorDesktop?: boolean;
  /** The page's device layouts (published, with the author's draft over them). */
  deviceProfiles?: PageProfiles | null;
  /** Edit cells of a CUSTOM device layout (Builder device mode only). */
  onDeviceLayoutChange?: (breakpoint: DeviceBreakpoint, cells: GridItem[]) => void;
  /** Receives what the grid resolved (badges: auto/custom, stale, orphans). */
  onResolved?: (summary: ResolvedLayoutSummary) => void;
  /** Holds the full resolution of the last render (Customize freezes it). */
  resolvedRef?: React.MutableRefObject<ResolvedLayout | null>;
  /** Holds a one-shot content measurement (the explicit "Fit heights to content"). */
  measureRef?: React.MutableRefObject<(() => Record<string, number>) | null>;
}


function DashboardGridInner({
  dashboardId,
  dashboardCharts,
  onLayoutChange,
  onRemoveChart,
  onEditWidget,
  onOpenInspector,
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
  emptyActions,
  publicProjection = false,
  canEdit = false,
  allowAppearanceEdit = false,
  themeConfig = null,
  disableLazy = false,
  focusedDashboardChartId = null,
  selectedDashboardChartIds,
  onFocusChart,
  onToggleLock,
  onPatchLayout,
  getPersistedLayout,
  aiDesignMode = false,
  presenceByChart,
  params = {},
  onParamChange,
  onBindParameter,
  renderSlicerControl,
  layoutRevision = 0,
  editorDesktop = false,
  deviceProfiles = null,
  onDeviceLayoutChange,
  onResolved,
  resolvedRef,
  measureRef,
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
  const autoScroll = useEdgeAutoScroll(gridWrapRef as React.RefObject<HTMLElement>);
  const [gridWidth, setGridWidth] = React.useState(0);
  // Bumped when a device drop is refused: the grid re-reads the stored cells.
  const [deviceRevision, setDeviceRevision] = React.useState(0);
  React.useEffect(() => {
    const el = gridWrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      // Whole pixels, only on a real change: a sub-pixel jitter here would
      // re-render the whole grid on every scroll-driven layout pass. This is the
      // ONE width of this report: breakpoint, resolver and grid all read it.
      // A collapsed/hidden canvas reports 0 — that is not a width: keep the
      // last one, or the grid unmounts and every tile loses its lazy-mount
      // state (below-fold tiles fell back to blank placeholders).
      const w = Math.round(entries[0]?.contentRect?.width ?? 0);
      if (w <= 0) return;
      setGridWidth((prev) => (prev === w ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Which layout this canvas draws is the RESOLVER's decision (one rule for the
  // Builder, the Studio preview and every public surface): desktop as authored;
  // below 1024px of report width the tablet, below 640 the phone — AUTO
  // (derived from desktop, content-fitted) or the page's CUSTOM layout. The
  // Builder's desktop authoring canvas keeps the authored grid down to the
  // phone breakpoint (an author edits desktop in a narrow window).
  const forceBreakpoint = editorDesktop && gridWidth >= REPORT_STACK_BREAKPOINT ? 'lg' as const : undefined;
  const expectedBreakpoint = forceBreakpoint ?? reportBreakpointFor(gridWidth);
  const expectedCustom = expectedBreakpoint !== 'lg' && deviceProfiles?.[expectedBreakpoint]?.mode === 'custom';
  // The last press on a drag handle that did not move (see onDragStop: double-click).
  const lastStillPressRef = React.useRef<{ id: string; at: number } | null>(null);

  const storedLayouts = dashboardCharts.map((dc) => {
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
      minW: isWidget ? (isSlicerControl(dc) ? 3 : 2) : 4,
      minH: isWidget ? (isSlicerControl(dc) ? 2 : 1) : 3,
      // Locked tile → react-grid-layout `static`: not draggable, not resizable,
      // and never displaced by a neighbour. Prevents accidental nudges.
      static: Boolean(layout.locked),
      resizeHandles: RESIZE_HANDLES,
      // Not read by the grid: a changed value makes it re-read this layout
      // (react-grid-layout keeps its own copy until the prop differs).
      rev: layoutRevision,
    };
  });
  // Editing lets a dragged tile pass over others (allowOverlap), which also stops
  // the grid settling a stored overlap the way the public report does. Settle it
  // here with the library's own rule, so the author sees what viewers see.
  const authoredLayouts = onLayoutChange && expectedBreakpoint === 'lg' ? settleStoredLayout(storedLayouts, DASHBOARD_GRID_COLS) : storedLayouts;

  // AUTO tablet/phone: headers, text and KPI cards take the height of what they
  // say at this width, exactly as the published report does (lib/responsive-fit).
  // Nothing is measured for desktop or for a CUSTOM device layout.
  const fitGap = getDashboardGridMargin(themeConfig)[1];
  const measuredContentRows = useMeasuredContentRows(
    gridWrapRef,
    { enabled: gridWidth > 0 && expectedBreakpoint !== 'lg' && !expectedCustom, width: gridWidth, rowHeight: dashboardRowHeight(fitGap), gapY: fitGap },
    [dashboardCharts],
  );
  if (measureRef) {
    measureRef.current = () => (gridWrapRef.current ? measureContentRows(gridWrapRef.current, dashboardRowHeight(fitGap), fitGap) : {});
  }
  const resolved = React.useMemo(() => resolveReportLayout({
    tiles: dashboardCharts,
    profiles: deviceProfiles,
    containerWidth: gridWidth,
    gap: fitGap,
    measuredRows: measuredContentRows,
    forceBreakpoint,
  }), [dashboardCharts, deviceProfiles, gridWidth, fitGap, measuredContentRows, forceBreakpoint]);
  if (resolvedRef) resolvedRef.current = resolved;
  const deviceView = resolved.breakpoint !== 'lg';
  const deviceBreakpoint = deviceView ? resolved.breakpoint as DeviceBreakpoint : null;
  // A CUSTOM device layout is edited in the Builder's device mode only (never
  // in a narrow desktop canvas, never in the Studio preview, never AUTO).
  const editableDevice = Boolean(deviceBreakpoint && resolved.source === 'custom' && onDeviceLayoutChange);
  const orphanSet = React.useMemo(() => new Set(resolved.orphans), [resolved.orphans]);
  const summaryKey = `${resolved.breakpoint}|${resolved.source}|${resolved.stale}|${resolved.orphans.join(',')}|${resolved.dropped.join(',')}|${resolved.desktopFingerprint}`;
  React.useEffect(() => {
    onResolved?.({
      breakpoint: resolved.breakpoint, source: resolved.source, stale: resolved.stale,
      orphans: resolved.orphans, dropped: resolved.dropped, desktopFingerprint: resolved.desktopFingerprint,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaryKey]);
  const deviceRowPitch = dashboardRowHeight(fitGap) + fitGap;
  const layouts = deviceBreakpoint
    ? resolved.layout.map((cell) => {
      const dc = dashboardCharts.find((d) => String(d.id) === cell.i);
      const kind = tileKindOf(dc?.chart?.chart_type, dc?.widget_type) as ResponsiveTileKind;
      return {
        ...cell,
        ...(editableDevice ? deviceMinCells(kind, deviceBreakpoint, deviceRowPitch) : {}),
        static: !editableDevice,
        resizeHandles: RESIZE_HANDLES,
        rev: `${layoutRevision}.${deviceRevision}`,
      };
    })
    : authoredLayouts;
  const gridCols = resolved.cols;

  // Persist ONLY the tile the user just finished manipulating. react-grid-layout
  // hands the moved item as the 3rd onDragStop/onResizeStop arg; we forward JUST
  // that item (a single-element array), never the whole layout — so a gesture is a
  // one-chart transaction: sibling coordinates are never re-read or re-written.
  // (Free-form compactType={null}+preventCollision already means siblings didn't
  // move; this guarantees we don't RECORD them either.) Persisting on "stop" — not
  // the mid-drag events — keeps the draft from jumping on reload.
  const persistItem = (item?: Layout) => {
    if (!item) return;
    const prev = layouts.find((l) => l.i === item.i);
    const changed = !prev
      || item.x !== prev.x || item.y !== prev.y || item.w !== prev.w || item.h !== prev.h;
    if (!changed) return;
    // A device gesture edits the device layout — never desktop. A MOVE follows
    // the desktop drop rule (lib/grid-arrange resolveDrop): the tile may be
    // carried over others and the layout opens room where it lands. A RESIZE in
    // place pushes down only what it now covers (growInPlace) — a tile beside it
    // never jumps. Everything that had to move is one change; a gesture that
    // cannot be placed returns the tile.
    if (deviceBreakpoint) {
      if (!editableDevice) return;
      const boxes = layouts.map((l) => ({ id: Number(l.i), x: l.x, y: l.y, w: l.w, h: l.h, locked: Boolean(l.static) }));
      const rect = { x: item.x, y: item.y, w: item.w, h: item.h };
      // A drag never changes a tile's size; a resize always does (from any handle).
      const result = item.w !== prev!.w || item.h !== prev!.h
        ? growInPlace(boxes, Number(item.i), rect)
        : resolveDrop(boxes, Number(item.i), rect);
      if (result.status === 'refused') {
        setDeviceRevision((n) => n + 1);
        return;
      }
      onDeviceLayoutChange!(deviceBreakpoint, result.changed.map((b) => ({ i: String(b.id), x: b.x, y: b.y, w: b.w, h: b.h })));
      return;
    }
    if (onLayoutChange) onLayoutChange([item]);
  };

  // A narrative's evidence mounts with the page (see citedTilesOf). Every hook
  // runs before the empty-page return below: switching to a page with no
  // element rendered fewer hooks and crashed the builder (React #300).
  const citedTileIds = React.useMemo(() => citedTilesOf(dashboardCharts), [dashboardCharts]);

  if (dashboardCharts.length === 0) {
    return (
      <div className={`bi-empty-state bi-fade-in flex flex-col items-center justify-center gap-3 text-center ${emptyActions ? 'min-h-[22rem] py-10' : 'h-72'}`} data-testid="report-empty-state">
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
        {emptyActions}
      </div>
    );
  }

  // Finer grid: 36 cols + a row height coupled to the theme gap so ×3-migrated
  // tiles keep their exact pixel size (see dashboardRowHeight). Margin unchanged.
  const gridMargin = getDashboardGridMargin(themeConfig);
  const gridRowHeight = dashboardRowHeight(gridMargin[1]);
  return (
    <div
      ref={gridWrapRef}
      className="relative"
      // Observability (tests, audits): what this surface drew, from the ONE width —
      // nothing before that width is known (nothing is drawn then either).
      data-report-width={gridWidth}
      data-report-breakpoint={gridWidth > 0 ? resolved.breakpoint : undefined}
      data-report-cols={gridWidth > 0 ? gridCols : undefined}
      data-report-layout-source={gridWidth > 0 ? resolved.source : undefined}
      data-report-layout={gridWidth > 0 ? JSON.stringify(layouts.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))) : undefined}
    >
      <SectionBands
        layouts={layouts}
        dashboardCharts={dashboardCharts}
        cols={gridCols}
        rowH={gridRowHeight}
        margin={gridMargin}
        width={gridWidth}
      />
    {gridWidth > 0 ? (
    <GridLayout
      width={gridWidth}
      // `rgl-no-anim` (edit mode only) kills the library's 200ms position
      // transition on ALL tiles so a settled drag doesn't leave siblings sliding
      // — the builder prioritises pixel accuracy / cursor-fidelity. Public keeps
      // the transition (plain `layout`).
      className={onLayoutChange || editableDevice ? 'layout rgl-no-anim' : 'layout'}
      layout={layouts}
      cols={gridCols}
      rowHeight={gridRowHeight}
      margin={gridMargin}
      onDragStart={(_l, _o, _n, _p, event) => autoScroll.start(event as unknown as MouseEvent)}
      onDrag={(_l, _o, _n, _p, event) => autoScroll.move(event as unknown as MouseEvent)}
      onResizeStart={(_l, _o, _n, _p, event) => autoScroll.start(event as unknown as MouseEvent)}
      onResize={(_l, _o, _n, _p, event) => autoScroll.move(event as unknown as MouseEvent)}
      onDragStop={(_layout, oldItem, newItem, _placeholder, event) => {
        autoScroll.stop();
        persistItem(newItem);
        // A press on a widget's body starts a drag, and the grid's placeholder
        // then covers the widget, so the click never reaches it. A drag that
        // ended where it began IS the click: it selects (Shift/Cmd/Ctrl adds).
        if (onFocusChart && oldItem && newItem && oldItem.x === newItem.x && oldItem.y === newItem.y) {
          const dc = dashboardCharts.find((d) => String(d.id) === newItem.i);
          const target = (event?.target ?? null) as HTMLElement | null;
          if (dc && dc.widget_type && dc.widget_type !== 'chart'
            && !target?.closest?.('button, input, select, textarea, a, [role="menu"], [data-slicer-menu]')) {
            onFocusChart(dc.id, Boolean(event?.shiftKey || event?.metaKey || event?.ctrlKey));
          }
        }
        // The same holds for a double-click on a drag handle (a widget's body, a
        // chart's title row): two presses that did not move, on one tile, close
        // together, are the double-click — it opens the Inspector.
        if (onOpenInspector && oldItem && newItem && oldItem.x === newItem.x && oldItem.y === newItem.y) {
          const now = Date.now();
          const last = lastStillPressRef.current;
          if (last && last.id === newItem.i && now - last.at < 450) {
            lastStillPressRef.current = null;
            onOpenInspector(Number(newItem.i));
          } else {
            lastStillPressRef.current = { id: newItem.i, at: now };
          }
        } else {
          lastStillPressRef.current = null;
        }
      }}
      onResizeStop={(_layout, _oldItem, newItem) => { autoScroll.stop(); persistItem(newItem); }}
      draggableHandle=".drag-handle"
      // Never start a drag from an interactive control or the widget's own
      // edit/delete cluster (whole widget bodies are now drag handles).
      draggableCancel=".no-drag, button, select, input, textarea, a, label"
      isDraggable={deviceView ? editableDevice : !!onLayoutChange}
      isResizable={deviceView ? editableDevice : !!onLayoutChange}
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
      // Editing: a tile may be carried over others and dropped there — the page
      // then opens room where it lands (lib/grid-arrange resolveDrop), so the
      // stored layout never overlaps. Viewing: nothing moves at all.
      // A CUSTOM device layout is edited the same way (persistItem: resolveDrop);
      // AUTO and every read-only view never move.
      allowOverlap={editableDevice || (!!onLayoutChange && !deviceView)}
      preventCollision={!editableDevice && (!onLayoutChange || deviceView)}
    >
      {dashboardCharts.map((dc) => {
        const isWidget = dc.widget_type && dc.widget_type !== 'chart';
        // Visual-only widgets (Shape, Line/Divider) intentionally render
        // as solid blocks without a card frame — wrapping them in
        // `dashboard-tile bi-card-hover` would defeat the purpose
        // (Shape becomes a coloured pill inside a white frame).
        const slicerControl = isSlicerControl(dc);
        const isVisualWidget = isWidget && (
          slicerControl
          || dc.widget_type === 'shape'
          || dc.widget_type === 'section_header'
          || dc.widget_type === 'callout'
          || dc.widget_type === 'hero_strip'
          // It draws its own frame (as on the published report): no second one.
          || dc.widget_type === 'parameter_switcher'
        );
        // Per-widget "transparent background" also drops the card frame so the
        // dashboard bg shows through (text/image/countdown widgets).
        const transparentWidget = isWidget
          && ((dc.widget_config ?? {}) as Record<string, any>).transparentBackground === true;
        const framelessWidget = isVisualWidget || transparentWidget;
        const widgetSelected = isWidget && (selectedDashboardChartIds
          ? selectedDashboardChartIds.includes(dc.id)
          : focusedDashboardChartId === dc.id);
        const tile = isWidget ? (
          // The WHOLE widget body is the drag handle (a widget is a visual
          // add-on you move like a shape, not a chart with a header). The thin
          // 20px top strip was a fiddly target — especially on a slim h=1 tile
          // where it was 25% of the tile. draggableCancel (on the grid) stops a
          // drag from starting on the edit/delete buttons or any form control.
          <div
            data-tile-id={dc.id}
            data-tile-kind="widget"
            data-widget-type={dc.widget_type ?? undefined}
            className={`group relative h-full w-full ${canEdit && !(dc.layout as any)?.locked ? `drag-handle ${slicerControl ? '' : 'cursor-move'}` : ''} ${
              framelessWidget
                ? ''
                : 'dashboard-tile bi-card-hover rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 overflow-hidden'
            } ${widgetSelected ? 'rounded-lg ring-2 ring-brand ring-offset-1 ring-offset-transparent' : ''}`}
            title={canEdit && !slicerControl ? t('dashboards.grid.dragToMove') : undefined}
            // A widget is selected like a chart (Shift/Cmd/Ctrl adds), so the
            // Arrange tools and the keyboard work on it too. A click on one of
            // its own controls is that control's, not a selection.
            // Only a widget that cannot be dragged (locked, or not editable)
            // gets a real click; a draggable one is selected from onDragStop.
            onClick={onFocusChart && !(canEdit && onLayoutChange && !deviceView && !(dc.layout as any)?.locked) ? (event) => {
              if ((event.target as HTMLElement).closest('button, input, select, textarea, a, [role="menu"], [data-slicer-menu]')) return;
              onFocusChart(dc.id, event.shiftKey || event.metaKey || event.ctrlKey);
            } : undefined}
          >
            {slicerControl && renderSlicerControl
              ? renderSlicerControl(dc)
              : <DashboardWidget widget={dc} params={params} onParamChange={onParamChange} editing={canEdit} />}
            {/* A slicer control carries these in its own menu (one place, no
                overlapping buttons); every other widget gets the hover cluster. */}
            {canEdit && !slicerControl && (
              <div className="no-drag absolute right-2 top-2 z-20 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                {onToggleLock && (
                  <button
                    type="button"
                    data-testid="widget-lock-toggle"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => onToggleLock(dc.id, !(dc.layout as any)?.locked)}
                    aria-pressed={Boolean((dc.layout as any)?.locked)}
                    className={`rounded-md border bg-surface-1 p-1.5 shadow-linear-sm transition-colors ${(dc.layout as any)?.locked ? 'border-brand/50 text-brand' : 'border-[rgb(var(--border-strong))] hover:border-brand/40 hover:text-brand'}`}
                    title={(dc.layout as any)?.locked ? t('dashboards.grid.unlock') : t('dashboards.grid.lock')}
                  >
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <rect x="3" y="7" width="10" height="7" rx="1.5" />
                      <path d={(dc.layout as any)?.locked ? 'M5.5 7V5a2.5 2.5 0 015 0v2' : 'M5.5 7V5a2.5 2.5 0 014.9-.7'} strokeLinecap="round" />
                    </svg>
                  </button>
                )}
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
            isFocused={selectedDashboardChartIds ? selectedDashboardChartIds.includes(dc.id) : focusedDashboardChartId === dc.id}
            onFocus={onFocusChart}
            onToggleLock={onToggleLock}
            onPatchLayout={onPatchLayout}
            getPersistedLayout={getPersistedLayout}
            aiDesignMode={aiDesignMode}
            editingBy={presenceByChart?.[dc.id] ?? null}
          />
        );
        return (
          <div
            key={dc.id.toString()}
            data-grid-item-id={dc.id}
            // The PDF arranger finds a chart tile by this, exactly as on the
            // public view — without it the builder's arranged export was blank.
            data-chart-id={(!dc.widget_type || dc.widget_type === 'chart') && dc.chart_id ? dc.chart_id : undefined}
            // Editing: Shift-click adds to the selection; it must not select the
            // text of every tile between the clicks.
            className={onLayoutChange && !deviceView ? 'select-none' : undefined}
            onDoubleClick={onOpenInspector && !deviceView ? (event) => {
              // A double-click inside a control (a slicer, an input, a menu) is that control's.
              if ((event.target as HTMLElement).closest('input, textarea, select, [role="menu"], [data-slicer-menu], [contenteditable="true"]')) return;
              onOpenInspector(dc.id);
            } : undefined}
          >
            <ChartErrorBoundary
              chartId={dc.chart_id}
              dashboardChartId={dc.id}
              onRemove={isWidget ? undefined : onRemoveChart}
              isRemoving={removingChartId === dc.id}
            >
              {disableLazy || isWidget || citedTileIds.has(dc.id) ? tile : <LazyChartSlot>{tile}</LazyChartSlot>}
            </ChartErrorBoundary>
          </div>
        );
      })}
    </GridLayout>
    ) : null}
    </div>
  );
}

/** Every tile and narrative block of one rendered report shares one evidence
 *  store, so a sentence states exactly what its tile is showing. */
export function DashboardGrid(props: React.ComponentProps<typeof DashboardGridInner>) {
  return (
    <ReportEvidenceProvider>
      <DashboardGridInner {...props} />
    </ReportEvidenceProvider>
  );
}
