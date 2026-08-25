/**
 * Guessing what a visual is FOR.
 *
 * A composition needs to know which tile carries the argument and which one is
 * a footnote, and the dashboard does not record that anywhere — nobody ever
 * typed "this is the headline". So it is inferred, from the chart type, from
 * how big the author already made it, and from where they put it. An author who
 * gave one chart half the page was telling us something.
 *
 * This is a presentation role and it is never written into the chart's own
 * config. Two dashboards can show the same chart with different roles, which is
 * the whole reason it lives here and not there.
 */
import type { PresentationRole } from './types';

/** Chart types whose job is a single number. */
const KPI_TYPES = new Set(['KPI', 'GAUGE', 'CARD', 'BIG_NUMBER', 'PODIUM']);

/** Chart types that show a composition — parts of a whole. */
const BREAKDOWN_TYPES = new Set(['PIE', 'DONUT', 'TREEMAP', 'FUNNEL', 'SANKEY', 'RADAR', 'WATERFALL']);

/** Chart types that carry a trend, which is usually the argument of a page. */
const TREND_TYPES = new Set(['LINE', 'TIME_SERIES', 'AREA', 'BAR_LINE', 'COMBO']);

/** Chart types that are a grid of numbers. */
const TABLE_TYPES = new Set(['TABLE', 'MATRIX', 'PIVOT', 'PIVOT_TABLE']);

/** Widgets that decorate rather than report. */
const DECORATIVE_WIDGETS = new Set(['section_header', 'callout', 'hero_strip', 'text', 'shape', 'image', 'html_fragment']);

export function isDataVisual(widgetType: string | null | undefined): boolean {
  const kind = String(widgetType || 'chart');
  return kind === 'chart';
}

export function isDecorativeWidget(widgetType: string | null | undefined): boolean {
  return DECORATIVE_WIDGETS.has(String(widgetType || ''));
}

export interface RoleInferenceInput {
  chartType: string;
  widgetType: string;
  /** Current width in grid columns (36-col space). */
  w: number;
  /** Current row. Tiles the author put at the top are more likely headline. */
  y: number;
  gridColumns: number;
}

/**
 * The inference. Deliberately conservative — when the signals disagree it
 * returns `supporting` rather than promoting something to `primary`, because a
 * composition that over-promotes ends up with three "main" charts and no
 * hierarchy at all, which is the exact failure the redesign is meant to fix.
 */
export function inferPresentationRole(input: RoleInferenceInput): PresentationRole {
  const { chartType, widgetType, w, y, gridColumns } = input;
  const type = String(chartType || '').toUpperCase();

  if (!isDataVisual(widgetType)) return 'supporting';

  if (KPI_TYPES.has(type)) {
    // A KPI the author left full-width at the very top was doing headline work.
    const isHeadline = y === 0 && w >= gridColumns / 2;
    return isHeadline ? 'headline' : 'kpi';
  }

  if (TABLE_TYPES.has(type)) return 'table';
  if (BREAKDOWN_TYPES.has(type)) return 'breakdown';

  if (TREND_TYPES.has(type)) {
    // A trend given at least half the width is the page's argument.
    return w >= gridColumns / 2 ? 'primary' : 'secondary';
  }

  // BAR and the rest: wide means it was leading, narrow means it was flanking.
  if (w >= gridColumns * 0.6) return 'primary';
  if (w <= gridColumns / 3) return 'breakdown';
  return 'secondary';
}

/** Rank used when a composition has to decide what goes first. Lower is more
 *  prominent. */
export const ROLE_PROMINENCE: Record<PresentationRole, number> = {
  headline: 0,
  kpi: 1,
  primary: 2,
  secondary: 3,
  breakdown: 4,
  table: 5,
  supporting: 6,
};
