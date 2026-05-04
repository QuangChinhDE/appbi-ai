/**
 * Grid <-> canvas layout conversion.
 *
 * - Grid layout: react-grid-layout coords (12-col, 80px row).
 * - Canvas layout: absolute pixel coords (xPx, yPx, wPx, hPx) plus z-order.
 *
 * Both bundles are stored side by side on each tile. Converters never erase
 * the *other* mode's coords — toggling back and forth is lossless as long as
 * neither mode has been edited in between.
 */

import type { DashboardChartLayout } from '@/types/api';

export const GRID_COLS = 12;
export const GRID_ROW_HEIGHT = 80;
export const GRID_MARGIN = 16;

/** Convert a grid-mode layout to canvas pixel coords. */
export function gridToCanvas(
  layout: DashboardChartLayout,
  canvasWidth: number,
): DashboardChartLayout {
  const colWidth = (canvasWidth - GRID_MARGIN * (GRID_COLS + 1)) / GRID_COLS;
  const xPx = GRID_MARGIN + (colWidth + GRID_MARGIN) * (layout.x ?? 0);
  const yPx = GRID_MARGIN + (GRID_ROW_HEIGHT + GRID_MARGIN) * (layout.y ?? 0);
  const wPx = (layout.w ?? 4) * colWidth + ((layout.w ?? 4) - 1) * GRID_MARGIN;
  const hPx = (layout.h ?? 4) * GRID_ROW_HEIGHT + ((layout.h ?? 4) - 1) * GRID_MARGIN;
  return { ...layout, xPx, yPx, wPx, hPx };
}

/** Convert a canvas-mode layout back to grid coords (snap + clamp). */
export function canvasToGrid(
  layout: DashboardChartLayout,
  canvasWidth: number,
): DashboardChartLayout {
  const colWidth = (canvasWidth - GRID_MARGIN * (GRID_COLS + 1)) / GRID_COLS;
  const stepX = colWidth + GRID_MARGIN;
  const stepY = GRID_ROW_HEIGHT + GRID_MARGIN;
  const x = Math.max(0, Math.min(GRID_COLS - 1, Math.round(((layout.xPx ?? 0) - GRID_MARGIN) / stepX)));
  const y = Math.max(0, Math.round(((layout.yPx ?? 0) - GRID_MARGIN) / stepY));
  const w = Math.max(1, Math.min(GRID_COLS, Math.round(((layout.wPx ?? colWidth) + GRID_MARGIN) / stepX)));
  const h = Math.max(1, Math.round(((layout.hPx ?? GRID_ROW_HEIGHT) + GRID_MARGIN) / stepY));
  // Clamp x + w within grid
  const clampedX = Math.min(x, GRID_COLS - w);
  return { ...layout, x: clampedX, y, w, h };
}

type Box = { id: number; x: number; y: number; w: number; h: number; z?: number };

/**
 * Resolve overlaps after canvas->grid: vertically push items down so no two
 * tiles share a cell. Mirrors react-grid-layout's "compact: vertical" idea
 * without importing the lib's full collision engine.
 */
export function compactGridLayouts(items: Box[]): Box[] {
  // Stable order: top-to-bottom, then left-to-right, then by z (top z first).
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x || (a.z ?? 0) - (b.z ?? 0));
  const placed: Box[] = [];
  const overlaps = (a: Box, b: Box) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  for (const item of sorted) {
    let candidate = { ...item };
    let pushed = true;
    while (pushed) {
      pushed = false;
      for (const p of placed) {
        if (overlaps(candidate, p)) {
          candidate.y = p.y + p.h;
          pushed = true;
          break;
        }
      }
    }
    placed.push(candidate);
  }
  return placed;
}

/** Apply gridToCanvas to a list while preserving any existing canvas coords. */
export function ensureCanvasCoords<T extends { layout: DashboardChartLayout }>(
  items: T[],
  canvasWidth: number,
): T[] {
  return items.map((it, i) => {
    const l = it.layout;
    if (
      typeof l.xPx === 'number' &&
      typeof l.yPx === 'number' &&
      typeof l.wPx === 'number' &&
      typeof l.hPx === 'number'
    ) {
      return it;
    }
    return { ...it, layout: { ...gridToCanvas(l, canvasWidth), z: l.z ?? i + 1 } };
  });
}
