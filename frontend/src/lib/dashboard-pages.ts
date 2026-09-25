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

/** What a tile is, for responsive sizing rules. */
export type ResponsiveTileKind = 'kpi' | 'chart' | 'table' | 'widget';

/** Narrowest a tile stays readable at, in pixels — the same floors the render
 *  audit enforces, so a derived layout never produces what the gate rejects. */
export const RESPONSIVE_MIN_WIDTH_PX: Record<ResponsiveTileKind, number> = {
  kpi: 150, chart: 260, table: 320, widget: 0,
};
/** Shortest a tile may be in the phone stack (px), so a KPI authored as a slim
 *  strip or a chart authored short still reads when it becomes full-width. */
export const STACK_MIN_HEIGHT_PX: Record<ResponsiveTileKind, number> = {
  kpi: 96, chart: 220, table: 260, widget: 0,
};

/**
 * Derive a 1-column phone stack from a desktop layout: every tile full-width,
 * stacked in the SAME reading order (y, then x). Heights are preserved, raised
 * to a readable floor per kind when `kindOf` is given (a KPI authored 60px tall
 * reads fine in a 4-across strip and cramped as a full-width card). Used as the
 * explicit `xs` layout of the public grid AND as the builder's narrow
 * projection, so the phone view is the same logic in both.
 */
export function deriveStackedLayout<T extends { i?: string; x: number; y: number; w: number; h: number }>(
  layouts: T[],
  opts?: { kindOf?: (item: T) => ResponsiveTileKind; rowPitchPx?: number; cols?: number },
): T[] {
  if (!Array.isArray(layouts) || layouts.length === 0) return layouts;
  const sorted = [...layouts].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const pitch = opts?.rowPitchPx && opts.rowPitchPx > 0 ? opts.rowPitchPx : 0;
  const cols = opts?.cols ?? 1;
  const heightOf = (item: T) => {
    let h = Math.max(1, Math.round(Number(item.h)) || 1);
    // Words re-wrap when a wide block becomes a phone column: a headline
    // authored across the page needs more lines, so it gets proportionally
    // more height instead of scrolling inside its own box.
    if (opts?.kindOf && opts.kindOf(item) === 'widget' && cols < DASHBOARD_GRID_COLS) {
      const widthShare = Math.min(1, Math.max(0, Number(item.w) / DASHBOARD_GRID_COLS));
      h = Math.round(h * Math.min(2.6, Math.max(1, widthShare * 2.6)));
    }
    if (opts?.kindOf && pitch > 0) {
      const minPx = STACK_MIN_HEIGHT_PX[opts.kindOf(item)] ?? 0;
      h = Math.max(h, Math.ceil(minPx / pitch));
    }
    return h;
  };
  // Reading plan, not geometry: headline numbers the author put side by side
  // stay side by side as a 2-up grid (four KPIs are one glance, not four
  // screens of tall cards); everything else is full width in reading order.
  const out: T[] = [];
  let cursorY = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const item = sorted[i];
    const next = sorted[i + 1];
    const pairable = cols >= 2 && opts?.kindOf
      && opts.kindOf(item) === 'kpi' && next && opts.kindOf(next) === 'kpi' && next.y === item.y;
    if (pairable) {
      const half = Math.floor(cols / 2);
      const h = Math.max(heightOf(item), heightOf(next));
      out.push({ ...item, x: 0, y: cursorY, w: half, h });
      out.push({ ...next, x: half, y: cursorY, w: cols - half, h });
      cursorY += h;
      i += 1;
      continue;
    }
    const h = heightOf(item);
    out.push({ ...item, x: 0, y: cursorY, w: cols, h });
    cursorY += h;
  }
  return out;
}

/** Tablet band: between the phone stack and a layout wide enough to show the
 *  authored grid as-is. */
export const REPORT_TABLET_BREAKPOINT = 1024;
const TABLET_SPANS = [9, 12, 18, 24, 36];

/**
 * Derive the tablet layout from the desktop one, deterministically.
 *
 * At tablet width the authored grid mostly still works — a tile at 12 of 36
 * columns is ~280px — so the rule is to change NOTHING unless some tile would
 * render below its readable width (`RESPONSIVE_MIN_WIDTH_PX`). Those tiles are
 * widened to the next standard span, and the page is re-flowed in reading order
 * with each tile keeping its height. A layout that is already fine at tablet
 * width comes back byte-identical, so most dashboards look exactly as authored.
 */
export function deriveTabletLayout<T extends { x: number; y: number; w: number; h: number }>(
  layouts: T[],
  opts: { kindOf: (item: T) => ResponsiveTileKind; referenceWidthPx?: number; cols?: number },
): T[] {
  if (!Array.isArray(layouts) || layouts.length === 0) return layouts;
  const cols = opts.cols ?? DASHBOARD_GRID_COLS;
  const colPx = (opts.referenceWidthPx ?? 820) / cols;
  let widened = false;
  const sized = layouts.map((item) => {
    const minPx = RESPONSIVE_MIN_WIDTH_PX[opts.kindOf(item)] ?? 0;
    const need = Math.ceil(minPx / colPx);
    if (item.w >= need) return { item, w: item.w };
    widened = true;
    const span = TABLET_SPANS.find((s) => s >= need && s <= cols) ?? cols;
    return { item, w: span };
  });
  if (!widened) return layouts;
  const ordered = [...sized].sort((a, b) => (a.item.y - b.item.y) || (a.item.x - b.item.x));
  let x = 0;
  let y = 0;
  let rowH = 0;
  return ordered.map(({ item, w }) => {
    if (x + w > cols && x > 0) { y += rowH; x = 0; rowH = 0; }
    const placed = { ...item, x, y, w };
    x += w;
    rowH = Math.max(rowH, item.h);
    return placed;
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
type GridTile = { id: number; x: number; y: number; w: number; h: number };

function tilesOverlap(a: GridTile, b: GridTile): boolean {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

/** Push each movable tile (in reading order) down just far enough to clear the
 *  fixed tiles and everything already placed. Fixed tiles never move. */
function routeAroundFixed(movable: GridTile[], fixed: GridTile[]): GridTile[] {
  const placed: GridTile[] = [...fixed];
  const out: GridTile[] = [];
  for (const tile of [...movable].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const next = { ...tile };
    for (let guard = 0; guard < 500; guard += 1) {
      const blocker = placed.find((p) => tilesOverlap(next, p));
      if (!blocker) break;
      next.y = blocker.y + blocker.h;
    }
    placed.push(next);
    out.push(next);
  }
  return out;
}

/**
 * "Dồn lên trên" that respects locks: removes the empty band above the page's
 * content by lifting the MOVABLE tiles, never a locked one, and never into a
 * locked one. Returns null when there is nothing to lift.
 */
export function compactPageUp(tiles: GridTile[], lockedIds: ReadonlySet<number> = new Set()): GridTile[] | null {
  const movable = tiles.filter((t) => !lockedIds.has(t.id));
  if (movable.length === 0) return null;
  const minY = Math.min(...tiles.map((t) => t.y));
  if (!Number.isFinite(minY) || minY <= 0) return null;
  const fixed = tiles.filter((t) => lockedIds.has(t.id));
  const routed = routeAroundFixed(movable.map((t) => ({ ...t, y: t.y - minY })), fixed);
  return [...routed, ...fixed];
}

export function tidyPageLayout(
  tiles: GridTile[],
  lockedIds: ReadonlySet<number> = new Set(),
): GridTile[] {
  if (lockedIds.size > 0) {
    // Locked tiles are obstacles: tidy the rest, then route it around them.
    const fixed = tiles.filter((t) => lockedIds.has(t.id));
    const tidied = tidyPageLayout(tiles.filter((t) => !lockedIds.has(t.id)));
    return [...routeAroundFixed(tidied, fixed), ...fixed];
  }
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

/** The public report's breakpoints, in measured GRID px: phone stack below
 *  `md`, the tablet derivation between `md` and `lg`, the authored grid above. */
export const REPORT_RESPONSIVE_BREAKPOINTS = { lg: REPORT_TABLET_BREAKPOINT, md: REPORT_STACK_BREAKPOINT, xs: 0 };
export const REPORT_RESPONSIVE_COLS = { lg: DASHBOARD_GRID_COLS, md: DASHBOARD_GRID_COLS, xs: 2 };

/**
 * Every breakpoint's layout from the ONE authored desktop layout. Desktop is
 * the source; tablet and phone are derived, deterministically, and never saved.
 * The builder's narrow projection calls the same function, so what an author
 * previews by narrowing the window is what a viewer gets on that device.
 */
export function buildResponsiveReportLayouts<T extends { i: string; x: number; y: number; w: number; h: number }>(
  layouts: T[],
  opts: { kindOf: (item: T) => ResponsiveTileKind; gridWidth?: number | null; gridGap?: number },
): { lg: T[]; md: T[]; xs: T[] } {
  const gap = Number(opts.gridGap) || 0;
  const width = Number(opts.gridWidth) || 0;
  const tabletRef = width >= REPORT_STACK_BREAKPOINT && width < REPORT_TABLET_BREAKPOINT ? width : 820;
  const stackPitch = computeReportRowHeight(REPORT_STACK_BREAKPOINT - 1, gap) + gap;
  return {
    lg: layouts,
    md: deriveTabletLayout(layouts, { kindOf: opts.kindOf, referenceWidthPx: tabletRef }),
    xs: deriveStackedLayout(layouts, { kindOf: opts.kindOf, rowPitchPx: stackPitch, cols: REPORT_RESPONSIVE_COLS.xs }),
  };
}

/** Which breakpoint a measured grid width falls in. */
export function reportBreakpointFor(width: number | null | undefined): 'lg' | 'md' | 'xs' {
  const w = Number(width) || 0;
  if (w <= 0 || w >= REPORT_TABLET_BREAKPOINT) return 'lg';
  return w >= REPORT_STACK_BREAKPOINT ? 'md' : 'xs';
}
