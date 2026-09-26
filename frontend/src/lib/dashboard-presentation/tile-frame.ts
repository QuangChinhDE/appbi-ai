/**
 * How much container a tile wears — one definition for every renderer.
 *
 * The builder tile (`ChartTile`) and the viewer tile (`ReadonlyChartTile`,
 * behind /d and /embed) used to each carry their own copy of the frame logic:
 * the surface palettes, the "transparent" branch, the border/background/glass
 * rules, the title typography. They drifted — the builder title was 14px
 * semibold primary, the published one 13px medium secondary — which is exactly
 * the "looks right in the builder, different when shared" class of bug. Both
 * now resolve the frame here and render the result, so a presentation decision
 * is made once.
 *
 * The vocabulary (`tileFrame`) is what lets a report stop being a wall of
 * identical cards:
 *   card   — the contained tile: border, surface, theme shadow/glass.
 *   subtle — a quiet tinted panel: no border, no shadow; groups by tone.
 *   flush  — no container at all: sits on the canvas or a section band; the
 *            header and the mark remain. The honest "frameless".
 * `transparentBackground: true` (the older per-tile switch) reads as `flush`.
 */
import type { CSSProperties } from 'react';

export type TileFrame = 'card' | 'subtle' | 'flush';
export type TileSurface = 'dark' | 'light' | undefined;

const SURFACE_VARS: Record<'dark' | 'light', CSSProperties> = {
  dark: {
    background: '#0f172a',
    ['--surface-1' as any]: '15 23 42',
    ['--surface-2' as any]: '30 41 59',
    ['--text-primary' as any]: '226 232 240',
    ['--text-secondary' as any]: '203 213 225',
    ['--text-tertiary' as any]: '148 163 184',
    ['--border-line' as any]: '51 65 85',
    color: 'rgb(226 232 240)',
  },
  light: {
    background: '#ffffff',
    ['--surface-1' as any]: '255 255 255',
    ['--surface-2' as any]: '243 244 245',
    ['--text-primary' as any]: '8 9 10',
    ['--text-secondary' as any]: '60 65 73',
    ['--text-tertiary' as any]: '120 126 134',
    ['--border-line' as any]: '230 230 230',
    color: 'rgb(8 9 10)',
  },
};

export function resolveTileFrame(style: Record<string, any> | null | undefined): TileFrame {
  const declared = style?.tileFrame;
  if (declared === 'card' || declared === 'subtle' || declared === 'flush') return declared;
  return style?.transparentBackground === true ? 'flush' : 'card';
}

export function resolveTileSurface(style: Record<string, any> | null | undefined): TileSurface {
  const surface = style?.chartSurface;
  return surface === 'dark' || surface === 'light' ? surface : undefined;
}

export interface TileFrameInput {
  style: Record<string, any> | null | undefined;
  /** Theme glass (`cardBg` / `cardBackdrop`) from the dashboard chart theme. */
  theme?: { cardBg?: string; cardBackdrop?: string };
  /** A state ring owns the border colour (focus, cross-filter source…). */
  ringActive?: boolean;
}

export interface ResolvedTileFrame {
  frame: TileFrame;
  surface: TileSurface;
  /** Classes both renderers put on the tile root (besides their own state rings). */
  className: string;
  style: CSSProperties;
  /** Attributes both renderers put on the tile root: the CSS in globals keys on
   *  them, and the render audit reads them. */
  dataAttributes: Record<string, string>;
}

/** The tile's frame, surface and title typography, resolved once. */
export function resolveTileFrameStyle(input: TileFrameInput): ResolvedTileFrame {
  const frame = resolveTileFrame(input.style);
  const surface = resolveTileSurface(input.style);
  const classes = ['dashboard-tile', 'relative', 'rounded-lg'];
  classes.push(frame === 'flush' ? 'p-1' : 'p-3');
  if (surface === 'dark') classes.push('chart-surface-dark');
  if (surface === 'light') classes.push('chart-surface-light');
  if (frame === 'card') classes.push('border', 'bg-surface-1');

  const style: CSSProperties = { borderRadius: 'var(--dashboard-card-radius, 0.5rem)' };
  if (frame === 'flush') {
    Object.assign(style, { borderWidth: 0, background: 'transparent', boxShadow: 'none' });
  } else if (frame === 'subtle') {
    Object.assign(style, {
      borderWidth: 0,
      background: 'color-mix(in srgb, rgb(var(--surface-2)) 70%, transparent)',
      boxShadow: 'none',
    });
  } else {
    style.borderWidth = 'var(--dashboard-card-border-width, 1px)';
    if (!input.ringActive) style.borderColor = 'var(--dashboard-card-border-color, rgb(var(--border-line)))';
    if (input.theme?.cardBg) {
      Object.assign(style, {
        background: input.theme.cardBg,
        backdropFilter: input.theme.cardBackdrop,
        WebkitBackdropFilter: input.theme.cardBackdrop,
        boxShadow: '0 10px 30px -14px rgba(2, 6, 23, 0.45)',
      });
    }
  }
  // A named surface paints the tile and flips its text/axis tokens so the chart
  // stays readable — on a flush tile too, where it paints just the tokens.
  if (surface) {
    const vars = { ...SURFACE_VARS[surface] };
    if (frame === 'flush') delete (vars as any).background;
    Object.assign(style, vars);
  }
  return {
    frame,
    surface,
    className: classes.join(' '),
    style,
    dataAttributes: { 'data-tile-frame': frame, ...(surface ? { 'data-tile-surface': surface } : {}) },
  };
}

/** Title typography — identical in the builder and the published report. */
export const TILE_TITLE_CLASS = 'dashboard-tile-title min-w-0 flex-1 truncate text-[13px] font-semibold text-text-primary';
/** A KPI's header label: quieter than a chart title, same in both renderers. */
// A KPI label wraps to two lines rather than truncating: on a 2-up phone row
// the header shares ~150px with its actions, and "R…" is not a label.
export const TILE_KPI_LABEL_CLASS = 'dashboard-kpi-label min-w-0 flex-1 line-clamp-2 break-words text-[13px] leading-snug font-medium text-text-secondary';

export function tileKindOf(chartType: string | null | undefined, widgetType?: string | null): 'kpi' | 'table' | 'chart' | 'widget' {
  if (widgetType && widgetType !== 'chart') return 'widget';
  const type = String(chartType ?? '').toUpperCase();
  if (type === 'KPI' || type === 'CARD' || type === 'BIG_NUMBER') return 'kpi';
  if (type === 'TABLE' || type === 'MATRIX' || type === 'PIVOT' || type === 'PIVOT_TABLE') return 'table';
  return 'chart';
}
