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

const GRID_COLS = 12;
const GRID_ROW_HEIGHT = 80;
const GRID_MARGIN = 16;

export type CanvasLayoutPatch = {
  xPx: number;
  yPx: number;
  wPx: number;
  hPx: number;
  z?: number;
};

/** Convert a grid-mode layout to canvas pixel coords. */
function gridToCanvas(
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

export function hasCanvasCoords(layout: Partial<DashboardChartLayout> | null | undefined): boolean {
  return (
    typeof layout?.xPx === 'number'
    && typeof layout?.yPx === 'number'
    && typeof layout?.wPx === 'number'
    && typeof layout?.hPx === 'number'
  );
}

export function ensureCanvasLayout(
  layout: DashboardChartLayout,
  canvasWidth: number,
  fallbackZ = 1,
): DashboardChartLayout {
  if (hasCanvasCoords(layout)) {
    return { ...layout, z: layout.z ?? fallbackZ };
  }
  return { ...gridToCanvas(layout, canvasWidth), z: layout.z ?? fallbackZ };
}

export function mergeGridLayout(
  base: DashboardChartLayout,
  patch: { x: number; y: number; w: number; h: number },
): DashboardChartLayout {
  return {
    ...base,
    x: patch.x,
    y: patch.y,
    w: patch.w,
    h: patch.h,
  };
}

export function mergeCanvasLayout(
  base: DashboardChartLayout,
  patch: CanvasLayoutPatch,
): DashboardChartLayout {
  return {
    ...base,
    xPx: patch.xPx,
    yPx: patch.yPx,
    wPx: patch.wPx,
    hPx: patch.hPx,
    ...(patch.z !== undefined ? { z: patch.z } : {}),
  };
}

/** Apply gridToCanvas to a list while preserving any existing canvas coords. */
export function ensureCanvasCoords<T extends { layout: DashboardChartLayout }>(
  items: T[],
  canvasWidth: number,
): T[] {
  return items.map((it, i) => {
    if (hasCanvasCoords(it.layout)) {
      if (it.layout.z !== undefined) return it;
      return { ...it, layout: { ...it.layout, z: i + 1 } };
    }
    return { ...it, layout: ensureCanvasLayout(it.layout, canvasWidth, i + 1) };
  });
}
