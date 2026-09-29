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
  /** Current width in grid columns (36-col space). A TIE-BREAKER only. */
  w: number;
  /** Current row. Kept for callers; no longer decides a role on its own. */
  y: number;
  gridColumns: number;
  /** The visual is organised over time (date axis / time grain). */
  temporal?: boolean;
  /** Analytical intent from chart metadata (trend, comparison, ranking, …). */
  intent?: string;
}

/**
 * The inference, meaning first.
 *
 * It used to read mostly geometry — "a trend given half the width is the
 * page's argument" — which made every redesign a function of the last one: the
 * chart the author happened to make wide was promoted, got made wider, and was
 * promoted again. Now the order of evidence is: what KIND of mark it is (a
 * number, a table, a composition), then what it SAYS (a series over time is the
 * argument; metadata intent), and only when those are silent, how wide the
 * author made it. Geometry is still a signal — an author who gave a bar chart
 * two thirds of the page meant something — but it is the last one consulted.
 */
export function inferPresentationRole(input: RoleInferenceInput): PresentationRole {
  const { chartType, widgetType, w, gridColumns } = input;
  const type = String(chartType || '').toUpperCase();
  const intent = String(input.intent ?? '').toLowerCase();

  if (!isDataVisual(widgetType)) return 'supporting';
  if (KPI_TYPES.has(type)) return 'kpi';
  if (TABLE_TYPES.has(type)) return 'table';
  if (BREAKDOWN_TYPES.has(type)) return 'breakdown';

  // A series over time carries the page's argument, whatever width it has now.
  if (TREND_TYPES.has(type) || input.temporal || intent === 'trend') return 'primary';

  if (intent === 'distribution' || intent === 'composition') return 'breakdown';
  if (intent === 'comparison' || intent === 'ranking') return 'secondary';

  // Silent on meaning: the author's sizing is the remaining evidence.
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
