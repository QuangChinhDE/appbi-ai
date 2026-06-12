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

export const DASHBOARD_GRID_COLS = 12;

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
