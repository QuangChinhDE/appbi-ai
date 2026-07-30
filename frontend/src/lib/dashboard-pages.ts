import type { DashboardChart, DashboardChartLayout, DashboardPageConfig } from '@/types/api';

export const DEFAULT_DASHBOARD_PAGE_ID = 'page-1';
export const DEFAULT_DASHBOARD_PAGE_NAME = 'Page 1';

export function createDashboardPageId(): string {
  return `page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getDefaultDashboardPage(): DashboardPageConfig {
  return {
    id: DEFAULT_DASHBOARD_PAGE_ID,
    name: DEFAULT_DASHBOARD_PAGE_NAME,
  };
}

export function normalizeDashboardPages(
  pages: DashboardPageConfig[] | null | undefined,
): DashboardPageConfig[] {
  const fallback = getDefaultDashboardPage();
  if (!Array.isArray(pages) || pages.length === 0) {
    return [fallback];
  }

  const normalized: DashboardPageConfig[] = [];
  const seenIds = new Set<string>();
  for (const page of pages) {
    if (!page || typeof page !== 'object') continue;
    const id = String(page.id ?? '').trim();
    const name = String(page.name ?? '').trim();
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    // Preserve every authored field (filters, layout overrides, future
    // additions) — only enforce id + a non-empty name. Stripping unknown
    // fields here was the cause of "Filters on this page" cards
    // disappearing right after save: server refetch returned the
    // filters, normalize() threw them away, derived state lost them.
    normalized.push({
      ...page,
      id,
      name: name || `Page ${normalized.length + 1}`,
    });
  }

  return normalized.length > 0 ? normalized : [fallback];
}

export function getDashboardChartPageId(
  layout: Partial<DashboardChartLayout> | Record<string, any> | null | undefined,
): string {
  const pageId = typeof layout?.pageId === 'string' ? layout.pageId.trim() : '';
  return pageId || DEFAULT_DASHBOARD_PAGE_ID;
}

export function getDashboardChartsForPage(
  charts: DashboardChart[] | null | undefined,
  pageId: string,
): DashboardChart[] {
  return (charts ?? []).filter((chart) => getDashboardChartPageId(chart.layout) === pageId);
}

export function getFirstDashboardPageId(
  pages: DashboardPageConfig[] | null | undefined,
): string {
  return normalizeDashboardPages(pages)[0].id;
}

export function ensureDashboardPageId(
  pages: DashboardPageConfig[] | null | undefined,
  pageId: string | null | undefined,
): string {
  const normalizedPages = normalizeDashboardPages(pages);
  if (pageId && normalizedPages.some((page) => page.id === pageId)) {
    return pageId;
  }
  return normalizedPages[0].id;
}

// Finer grid (2026-07): the builder grid went 12→36 columns and the row unit
// went 80px→(80-2·gap)/3 so a DA gets ~3× more resize/move stops ("thu vào bé
// hơn, giãn nhiều nấc hơn"). Existing (legacy, gv<2) layouts are scaled ×3 LAZILY
// at read time by scaleGridLayoutForRender — there is NO backend migration yet
// (a future Alembic revision will stamp gv=2 on all rows and retire this). They
// render pixel-IDENTICAL because RGL's column width shrinks proportionally with
// `cols` and the ×3 row-height formula below keeps tile heights exact incl. the
// inter-tile margin. `GRID_FINER` = the scale.
export const GRID_FINER = 3;
export const DASHBOARD_GRID_COLS = 12 * GRID_FINER; // 36
/** Logical row pitch of the OLD 80px grid — the reference the finer grid keeps. */
export const DASHBOARD_ROW_BASE = 80;
/**
 * Finer grid row height that keeps a ×3-migrated tile's pixel height EXACT.
 * Derivation: a tile of old height h (px = h·80 + (h-1)·gap) becomes h·3 finer
 * rows; requiring 3h·R + (3h-1)·gap === h·80 + (h-1)·gap for all h gives
 * R = (80 − 2·gap)/3. So it necessarily couples to the theme's grid gap.
 */
export function dashboardRowHeight(gridGap: number): number {
  return Math.max(4, (DASHBOARD_ROW_BASE - 2 * (Number(gridGap) || 0)) / GRID_FINER);
}

// ── Legacy-grid upscale (lazy, no data migration) ───────────────────────────
// Existing dashboards store layouts in the OLD 12-col grid. Rather than bulk-
// rewrite persisted data (which would also touch pending drafts + teammates'
// WIP), each tile self-describes its grid version via `layout.gv`; a tile with
// gv < GRID_VERSION is scaled ×GRID_FINER at READ time so it renders on the
// finer 36-col grid identically to before. Canvas px coords (xPx/yPx/wPx/hPx/z)
// are grid-resolution-independent → never scaled. Idempotent: an already-finer
// tile (gv === GRID_VERSION) is returned untouched. On save the FE writes finer
// coords tagged gv=GRID_VERSION, so a tile upgrades the first time it's edited.
export const GRID_VERSION = 2;
export function scaleGridLayoutForRender<T extends Record<string, any> | null | undefined>(layout: T): T {
  if (!layout || (layout as any).gv >= GRID_VERSION) return layout;
  const s = GRID_FINER;
  const sc = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v * s : v);
  return {
    ...(layout as any),
    x: sc((layout as any).x),
    y: sc((layout as any).y),
    w: sc((layout as any).w),
    h: sc((layout as any).h),
    minW: sc((layout as any).minW),
    maxW: sc((layout as any).maxW),
    minH: sc((layout as any).minH),
    maxH: sc((layout as any).maxH),
    gv: GRID_VERSION,
  } as T;
}

/**
 * Upscale every legacy tile in a dashboard for render (charts + the per-chart BE
 * draft-layout overlay). Pure/idempotent — call it right where the dashboard is
 * consumed so the whole downstream render pipeline sees finer-grid coords.
 */
export function normalizeDashboardGridForRender<
  D extends { dashboard_charts?: any[]; draft_layouts?: Record<string, any> | null },
>(dash: D | null | undefined): D | null | undefined {
  if (!dash) return dash;
  const dashboard_charts = Array.isArray(dash.dashboard_charts)
    ? dash.dashboard_charts.map((dc) =>
        dc && dc.layout ? { ...dc, layout: scaleGridLayoutForRender(dc.layout) } : dc,
      )
    : dash.dashboard_charts;
  let draft_layouts = dash.draft_layouts;
  if (draft_layouts && typeof draft_layouts === 'object') {
    draft_layouts = Object.fromEntries(
      Object.entries(draft_layouts).map(([k, v]) => [k, scaleGridLayoutForRender(v as any)]),
    ) as any;
  }
  return { ...dash, dashboard_charts, draft_layouts };
}

type GridRect = { x: number; y: number; w: number; h: number };

function rectsOverlap(a: GridRect, b: GridRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Find the first free top-left slot for a `w`×`h` tile that doesn't overlap any
 * `occupied` rect, scanning left-to-right then top-to-bottom on a
 * `DASHBOARD_GRID_COLS`-wide grid. Mirrors how a human tiles cards: fill the
 * current row, then wrap to the next. Width is clamped to the grid so an
 * oversized tile still lands at x=0.
 */
export function findNextGridSlot(
  occupied: GridRect[],
  w: number,
  h: number,
): { x: number; y: number } {
  const tileW = Math.max(1, Math.min(w, DASHBOARD_GRID_COLS));
  const tileH = Math.max(1, h);
  // Candidate Y rows: 0 and the bottom edge of every occupied tile, so we never
  // scan more rows than there are distinct shelf heights.
  const candidateYs = Array.from(
    new Set<number>([0, ...occupied.map((r) => r.y + r.h)]),
  ).sort((a, b) => a - b);

  for (const y of candidateYs) {
    for (let x = 0; x + tileW <= DASHBOARD_GRID_COLS; x++) {
      const candidate: GridRect = { x, y, w: tileW, h: tileH };
      if (!occupied.some((r) => rectsOverlap(candidate, r))) {
        return { x, y };
      }
    }
  }
  // Fallback: drop below everything at x=0.
  const maxBottom = occupied.reduce((max, r) => Math.max(max, r.y + r.h), 0);
  return { x: 0, y: maxBottom };
}

/**
 * Assign non-overlapping grid positions to a batch of new tiles, flowing them
 * left-to-right across the row and wrapping down — starting from the cells
 * already occupied on the page. Returns one {x,y} per requested tile, in order.
 * This is what makes "add 4 KPIs" tile into a neat row instead of stacking at
 * {0,0} (the grid uses compactType=null + preventCollision, so it won't
 * auto-arrange a pile of tiles dropped on the same cell).
 */
export function packNewGridTiles(
  existing: Array<Partial<GridRect>>,
  sizes: Array<{ w: number; h: number }>,
): Array<{ x: number; y: number }> {
  const occupied: GridRect[] = existing
    .map((r) => ({
      x: Math.max(0, Math.floor(Number(r.x) || 0)),
      y: Math.max(0, Math.floor(Number(r.y) || 0)),
      w: Math.max(1, Math.floor(Number(r.w) || 1)),
      h: Math.max(1, Math.floor(Number(r.h) || 1)),
    }));
  const placements: Array<{ x: number; y: number }> = [];
  for (const size of sizes) {
    const slot = findNextGridSlot(occupied, size.w, size.h);
    placements.push(slot);
    occupied.push({ x: slot.x, y: slot.y, w: Math.max(1, Math.min(size.w, DASHBOARD_GRID_COLS)), h: Math.max(1, size.h) });
  }
  return placements;
}

/**
 * Remove dead vertical whitespace ABOVE the first row of tiles by shifting
 * every tile up so the topmost one sits at y=0. Operates purely on grid
 * coordinates (column/row units), so the result is identical at any container
 * width — it never causes the resize "jumping" that breakpoint reflow did.
 *
 * Why this and not full vertical compaction: lifting only the leading offset
 * preserves the author's INTENTIONAL spacing between tiles (a deliberate gap
 * between two sections stays), while killing the most common defect — a big
 * empty band at the top of a public/read-only dashboard because the saved
 * layout happened to start at y=3+. Idempotent: re-lifting an already-lifted
 * layout is a no-op, so it's safe to apply on every render (including the
 * editable Build grid, whose onLayoutChange then persists the lifted coords).
 *
 * `T` is preserved so callers keep their react-grid-layout item shape (i,
 * minW, resizeHandles, …) — only `y` changes.
 */
/**
 * Sensible default tile size (in 12-col grid units, rowHeight≈80px) for a
 * chart type — so a freshly added chart lands at a size that FITS its content
 * instead of every chart defaulting to 4×4. This is the "size communicates
 * importance" principle from BI layout research: KPIs are small reference
 * cards, tables are large, spatial charts (maps/sankey) need room. Stops the
 * "KPI floating in a huge empty tile" and "everything is the same square"
 * defects at the source. Type is matched case-insensitively.
 */
export function defaultSizeForChartType(chartType: string | null | undefined): { w: number; h: number } {
  const t = String(chartType || '').toLowerCase();
  // Sizes are authored in the OLD 12-col / 80px-row units (so this table stays
  // readable) and scaled to the finer grid by GRID_FINER at the end — a KPI is
  // still "3 per row", a table still wide+tall, spatial charts still roomy.
  const base = ((): { w: number; h: number } => {
    if (t === 'kpi' || t === 'card') return { w: 4, h: 3 };
    if (t === 'podium') return { w: 6, h: 4 };
    if (t === 'gauge' || t === 'bullet') return { w: 3, h: 4 };
    if (t === 'table' || t === 'matrix') return { w: 6, h: 8 };
    if (t === 'pie' || t === 'donut' || t === 'polar_area' || t === 'funnel' || t === 'word_cloud' || t === 'radar') {
      return { w: 4, h: 5 };
    }
    if (
      t === 'map_point' || t === 'map_region' || t === 'sankey' || t === 'sunburst'
      || t === 'treemap' || t === 'heatmap' || t === 'scatter' || t === 'bubble' || t === 'boxplot'
    ) {
      return { w: 6, h: 6 };
    }
    if (
      t === 'bar' || t === 'horizontal_bar' || t === 'line' || t === 'area' || t === 'time_series'
      || t === 'stacked_bar' || t === 'grouped_bar' || t === 'bar_line' || t === 'waterfall'
      || t === 'ribbon' || t === 'timeline'
    ) {
      return { w: 6, h: 5 };
    }
    return { w: 4, h: 4 };
  })();
  return { w: base.w * GRID_FINER, h: base.h * GRID_FINER };
}

/**
 * Derive a 1-column mobile/tablet stack from a desktop layout: every tile
 * full-width (x=0, w=1 in a 1-col grid), stacked top-to-bottom in the SAME
 * reading order (sorted by y then x), heights preserved. Used as the explicit
 * `xs` layout for the responsive public grid so the small-screen view is a
 * clean vertical stack — WITHOUT touching the desktop `lg` layout (so desktop
 * resize never crosses a breakpoint in normal use → no "jumping").
 */
export function deriveStackedLayout<T extends { x: number; y: number; w: number; h: number }>(layouts: T[]): T[] {
  if (!Array.isArray(layouts) || layouts.length === 0) return layouts;
  const sorted = [...layouts].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  let cursorY = 0;
  return sorted.map((item) => {
    const h = Math.max(1, Math.round(Number(item.h)) || 1);
    const stacked = { ...item, x: 0, y: cursorY, w: 1, h };
    cursorY += h;
    return stacked;
  });
}

// ── Responsive report grid (public / embed) ─────────────────────────────────
// The authored dashboard is a 12-col grid. A PUBLIC report must look
// "chuẩn chỉnh" on every screen (TV / desktop / laptop / tablet / phone). The
// old grid froze the row height at 80px while column width stayed fluid, so a
// tile's aspect ratio drifted with the viewer's width — wide-and-short on a TV,
// tall-and-squished on a small window — and a hard 768px cliff dropped the whole
// tablet band into a 1-column stack of oversized cards.
//
// Fix (revised): the public/embed report must be WYSIWYG with the BUILDER. The
// builder edits at a FIXED 80px row, so the public view uses the SAME fixed 80px
// row on any desktop/tablet width — the author sees exactly what viewers get,
// with no scaled-up "bigger on the public link than in build" surprise. (An
// earlier revision scaled the row height with width to "fill" wide screens; that
// made cards visibly larger than the builder on a wide monitor, which read as too
// big / less tidy — so it's reverted to fixed.) Columns still fill the width via
// react-grid-layout's WidthProvider; only the ROW height is pinned. On a phone
// (< REPORT_STACK_BREAKPOINT) the layout collapses to a 1-col vertical stack at a
// slightly tighter fixed row.
//
// 640 grid px ≈ 710 window px after app-shell chrome, so tablets (portrait 768 /
// landscape 1024) get the multi-column layout; only true phones stack.
export const REPORT_STACK_BREAKPOINT = 640;

/**
 * Row height (px) for the public/embed report grid, given the MEASURED grid
 * container width. FIXED at the builder's row height on desktop/tablet so the
 * published report matches the builder (no scaled-up cards); a slightly tighter
 * fixed row below the stack breakpoint (1-col phone view).
 */
export function computeReportRowHeight(
  containerWidth: number | null | undefined,
  gridGap: number = 16,
): number {
  // Finer-grid row height — MUST match the builder (DashboardGrid rowHeight) so
  // the published report is pixel-identical. Couples to the theme's grid gap
  // (see dashboardRowHeight). A slightly tighter row below the stack breakpoint.
  const base = dashboardRowHeight(gridGap);
  const stackRow = Math.max(4, (72 - 2 * (Number(gridGap) || 0)) / GRID_FINER);
  if (!containerWidth || !Number.isFinite(containerWidth) || containerWidth <= 0) return base;
  return containerWidth < REPORT_STACK_BREAKPOINT ? stackRow : base;
}

export function liftLayoutToTop<T extends { y: number }>(layouts: T[]): T[] {
  if (!Array.isArray(layouts) || layouts.length === 0) return layouts;
  let minY = Infinity;
  for (const item of layouts) {
    const y = Number(item?.y);
    if (Number.isFinite(y) && y < minY) minY = y;
  }
  if (!Number.isFinite(minY) || minY <= 0) return layouts;
  return layouts.map((item) => ({ ...item, y: item.y - minY }));
}

/**
 * "Tidy" a page's tiles into a clean, aligned grid — the one-click rescue for
 * a ragged ("cái thò cái thụt") layout. Re-flows tiles in reading order
 * (top→bottom, left→right) into rows packed to 12 columns, then aligns every
 * tile in a row to the SAME top and the SAME height (= the row's tallest), so
 * row bottoms line up and there are no vertical gaps between rows. This is the
 * equal-height-row grid the BI-layout research calls professional
 * (grid-auto-rows: 1fr / snap-to-grid). Each tile keeps its own WIDTH (the DA's
 * importance signal); only x/y/h are normalized. Returns one record per input
 * tile, keyed by id — apply via the existing layout-save path.
 */
export function tidyPageLayout(
  tiles: Array<{ id: number; x: number; y: number; w: number; h: number }>,
): Array<{ id: number; x: number; y: number; w: number; h: number }> {
  const norm = tiles.map((t) => ({
    id: t.id,
    x: Math.max(0, Math.floor(Number(t.x) || 0)),
    y: Math.max(0, Math.floor(Number(t.y) || 0)),
    w: Math.max(1, Math.min(Math.floor(Number(t.w) || 1), DASHBOARD_GRID_COLS)),
    h: Math.max(1, Math.floor(Number(t.h) || 1)),
  }));
  // Reading order from the current arrangement.
  norm.sort((a, b) => a.y - b.y || a.x - b.x);

  type Placed = { id: number; x: number; w: number; h: number };
  const rows: Array<{ items: Placed[]; maxH: number }> = [];
  let cursorX = 0;
  let row: { items: Placed[]; maxH: number } = { items: [], maxH: 0 };
  // Break a row when it would overflow 12 cols OR the next tile's natural height
  // differs too much from the row's. The height-break is what keeps a short KPI
  // (h≈3) out of a row with a tall table (h≈8): equalizing a mixed row would
  // balloon the KPI back to table height (undoing the size-by-type win). With
  // homogeneous rows, equalizing to the row max is safe and yields the clean
  // "KPI strip on top, chart rows below" structure professional BI uses.
  const HEIGHT_BREAK = 1;
  for (const t of norm) {
    const overflow = cursorX + t.w > DASHBOARD_GRID_COLS && row.items.length > 0;
    const heightMismatch = row.items.length > 0 && Math.abs(t.h - row.maxH) > HEIGHT_BREAK;
    if (overflow || heightMismatch) {
      rows.push(row);
      row = { items: [], maxH: 0 };
      cursorX = 0;
    }
    row.items.push({ id: t.id, x: cursorX, w: t.w, h: t.h });
    cursorX += t.w;
    row.maxH = Math.max(row.maxH, t.h);
  }
  if (row.items.length > 0) rows.push(row);

  const out: Array<{ id: number; x: number; y: number; w: number; h: number }> = [];
  let y = 0;
  for (const r of rows) {
    for (const item of r.items) {
      out.push({ id: item.id, x: item.x, y, w: item.w, h: r.maxH });
    }
    y += r.maxH;
  }
  return out;
}
