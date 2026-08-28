/**
 * The single registry of what a generated presentation is allowed to touch.
 *
 * Every allow-list in this file is a CLOSED set. Anything absent is denied, so
 * a capability that does not exist yet cannot be reached by inventing a key
 * name — which is the failure mode that matters, because a model asked for
 * something unsupported will happily make up a plausible-looking field.
 *
 * The hard-won part is `AI_ALLOWED_CHART_STYLE_KEYS`. `ChartStyleConfig` reads
 * like a styling bag, and it is not: sitting among the radii and legend
 * positions are `dataLimit` (Top-N — changes which rows exist), `chartSortRules`
 * (changes which rows are first, and therefore which survive a limit),
 * `calculatedFields` (a measure expression), `timeGranularity` (the date
 * hierarchy), `seriesRenderAs` (turns a bar series into a line — a chart-type
 * change through the back door) and the benchmark fields (a target the reader
 * judges the number against). Handing the whole interface to a planner and
 * validating afterwards would mean auditing that list again every time someone
 * adds a field. Listing the safe keys instead means a new field is denied by
 * default and someone has to think before it is allowed.
 */
import { TEMPLATE_KEYS, COLORWAY_KEYS, TEMPLATES, COLORWAYS } from '@/lib/dashboard-theme-catalog';
import {
  DECORATIVE_WIDGET_TYPES,
  LAYOUT_PRIMITIVES,
  PRESENTATION_ROLES,
  PRESENTATION_SPANS,
  PRESENTATION_EMPHASES,
  PRESENTATION_DENSITIES,
  COMPOSITION_STYLES,
} from './types';

export type AiPresentationCapabilities = {
  grid: true;
  theme: true;
  tileStyle: true;
  slicerPresentation: true;
  decorativeWidgets: true;
};

export const AI_PRESENTATION_CAPABILITIES: AiPresentationCapabilities = {
  grid: true,
  theme: true,
  tileStyle: true,
  slicerPresentation: true,
  decorativeWidgets: true,
};

// ── Per-tile chart style ────────────────────────────────────────────────────

/**
 * `ChartStyleConfig` keys a presentation plan may set through
 * `layout.styleConfigOverride`. Purely visual: none of them changes which rows
 * are fetched, which rows are shown, what is aggregated, or what a number is
 * compared against.
 */
export const AI_ALLOWED_CHART_STYLE_KEYS = [
  // Framing
  'transparentBackground',
  // Legend & grid
  'legendPosition',
  'showGrid',
  // Data labels — visibility and placement only, never the template text
  'showDataLabels',
  'dataLabelPosition',
  // Type
  'fontSize',
  'chartTitleFontSize',
  // Marks
  'barRadius',
  'barSize',
  'showDots',
  'lineStyle',
  'lineWidth',
  'areaOpacity',
  'pieInnerRadius',
  // Palette — a named palette from the system, not free colours
  'palette',
  // Value formatting (display only; the underlying value is unchanged)
  'numberFormat',
  'decimalPlaces',
  'axisDisplayUnits',
  // Surface — a chart's own card background as a named mode (not a free colour),
  // so "make this chart dark" works for ANY chart type. The tile flips its text,
  // axis and grid colours to stay readable; the data is untouched.
  'chartSurface',
  // KPI presentation (applies to KPI tiles only; inert on a chart)
  'kpiBackgroundMode',
  'kpiAccentColor',
  'kpiAccentBorder',
  'kpiGradientBg',
  'kpiValueFontSize',
  'kpiIconName',
  'kpiIconColor',
] as const;

/** Style keys that only mean anything on a KPI card. Applied to a chart they are
 *  inert, so a focused restyle drops them rather than reporting a change that
 *  never renders. `chartSurface` is the cross-type way to reskin a chart. */
export const KPI_ONLY_STYLE_KEYS: ReadonlySet<string> = new Set([
  'kpiBackgroundMode', 'kpiAccentColor', 'kpiAccentBorder', 'kpiGradientBg',
  'kpiValueFontSize', 'kpiIconName', 'kpiIconColor',
]);

export type AiAllowedChartStyleKey = (typeof AI_ALLOWED_CHART_STYLE_KEYS)[number];

const ALLOWED_STYLE_KEY_SET: ReadonlySet<string> = new Set(AI_ALLOWED_CHART_STYLE_KEYS);

export function isAllowedChartStyleKey(key: string): key is AiAllowedChartStyleKey {
  return ALLOWED_STYLE_KEY_SET.has(key);
}

/**
 * The keys that look like style and are not. Kept as an explicit list rather
 * than "everything not in the allow-list" so the reason each one is excluded
 * survives in the code, and so a test can assert none of them ever drifts into
 * the allow-list.
 */
export const SEMANTIC_CHART_STYLE_KEYS = [
  'dataLimit',              // Top-N: changes which rows exist
  'dataLimitDirection',
  'chartSortRules',         // changes which rows a limit keeps
  'timeGranularity',        // the date hierarchy
  'dateDrillLevel',
  'calculatedFields',       // a measure expression
  'seriesRenderAs',         // bar→line per series: a chart-type change
  'stackMode',              // absolute vs share-of: the number means something else
  'dualYAxis',              // two scales invite a comparison the data may not support
  'yAxisRightSeriesKey',
  'yAxisMin', 'yAxisMax',   // a truncated axis misstates magnitude
  'yAxisRightMin', 'yAxisRightMax',
  'showBenchmarkLine', 'benchmarkLines', 'benchmarkValue', 'benchmarkLabel',
  'kpiBenchmarkValue', 'kpiBenchmarkMultiplier', 'kpiBenchmarkOffset',
  'kpiBenchmarkLabel', 'kpiShowBenchmarkValue', 'kpiGoalDirection',
  'podiumNameField', 'podiumValueField', 'scatterLabelField',
  'tooltipExtraFields',
  'tableSummaryRows', 'tableShowSummaryRow',   // adds an aggregation
  'tableConditionalFormatting', 'tableHeatmapRules', 'seriesConditionalRules',
  'annotations',
  'currencySymbol',         // relabelling the unit misstates the value
  // Display text: renaming a series or a title changes what a reader thinks
  // the number IS, which is meaning, not presentation.
  'chartTitle', 'kpiLabel', 'kpiContextTemplate', 'dataLabelTemplate',
  'seriesLabels', 'tableColumnLabels', 'xAxisLabel', 'yAxisLabel',
  'yAxisRightLabel',
] as const;

// ── Theme ───────────────────────────────────────────────────────────────────

/** Theme keys reachable from a plan. Reuses the catalog's own definition of
 *  what a template and a colorway own, so the AI can never set a token the
 *  one-click template picker could not. */
/** Report fonts the renderer actually ships (DashboardThemeProvider FONT_PRESETS).
 *  A curated list, not free text — an unknown face would fall back and silently
 *  do nothing. */
export const AI_ALLOWED_FONTS = [
  'inter', 'roboto', 'dm-sans', 'jakarta', 'grotesk', 'serif', 'mono',
] as const;
export type AiAllowedFont = (typeof AI_ALLOWED_FONTS)[number];
const ALLOWED_FONT_SET: ReadonlySet<string> = new Set(AI_ALLOWED_FONTS);
export function isAllowedFont(value: string): boolean {
  return ALLOWED_FONT_SET.has(value.toLowerCase());
}

export const AI_ALLOWED_THEME_KEYS: readonly string[] = [
  ...TEMPLATE_KEYS,
  ...COLORWAY_KEYS,
  // A report font family — carried on theme_config, applied by the provider,
  // but not owned by a template or colorway, so it is listed on its own.
  'fontFamily',
];

const ALLOWED_THEME_KEY_SET: ReadonlySet<string> = new Set(AI_ALLOWED_THEME_KEYS);

export function isAllowedThemeKey(key: string): boolean {
  return ALLOWED_THEME_KEY_SET.has(key);
}

export function templateIds(): string[] {
  return TEMPLATES.map((t) => t.id);
}

export function colorwayIds(): string[] {
  return COLORWAYS.map((c) => c.id);
}

/**
 * Each colorway's mood, derived from the catalog rather than restated.
 *
 * The bare id list tells a planner that `graphite` exists; it does not tell it
 * that graphite is the dark, violet one. Asked for "a dark modern SaaS report
 * with a violet accent" the model then either guesses or picks a light palette,
 * and the redesign that comes back is not dark at all. Handing it the mode and
 * the accent colour of every option lets it choose on purpose — the accent is
 * the catalog's own value, so this can never drift from what actually renders.
 */
export function colorwayGuide(): Array<{ id: string; mode: string; accent: string }> {
  return COLORWAYS.map((c) => ({
    id: c.id,
    mode: String(c.value.mode ?? (c.dark ? 'dark' : 'light')),
    accent: String(c.value.accent ?? ''),
  }));
}

/** Each template's mood, so the planner can match a requested feel to a
 *  composition instead of a name it has to already know. `skin` is what makes a
 *  report read as "modern" (soft cards, sunken sections) versus "classic". */
export function templateGuide(): Array<{ id: string; skin: string }> {
  return TEMPLATES.map((t) => ({ id: t.id, skin: String(t.value.skin ?? 'classic') }));
}

// ── Slicer ──────────────────────────────────────────────────────────────────

export const AI_ALLOWED_SLICER_DOCKS = ['top', 'bottom', 'left', 'right', 'drawer'] as const;
export const AI_ALLOWED_SLICER_VARIANTS = ['auto', 'segmented', 'dropdown', 'compact'] as const;
export const AI_ALLOWED_SLICER_STYLES = ['card', 'pill', 'compact', 'glass', 'minimal'] as const;

/** Slicer fields a plan must never reach. Listed so the validator can assert
 *  the compiled patch touches none of them, even though the plan shape has no
 *  way to express them. Belt and braces: the slicer patch merges into a shared
 *  object, and a merge is exactly where an extra key would slip through. */
export const SLICER_SEMANTIC_KEYS = [
  'field', 'fieldKey', 'datasetId', 'operator', 'value', 'values',
  'scope', 'pageScope', 'locked', 'hidden', 'linkedField', 'type',
] as const;

// ── Grid ────────────────────────────────────────────────────────────────────

/** Column spans the compiler will emit. Constraining to a small set keeps
 *  compositions from breaking at the responsive breakpoints (§27). */
export const AI_ALLOWED_SPANS = [9, 12, 18, 24, 27, 36] as const;

export const MIN_TILE_W = 6;
export const MIN_TILE_H = 2;
export const MAX_TILE_H = 24;

// ── The schema handed to the planner ────────────────────────────────────────

/** The capability document sent with every prompt. This is the ONLY vocabulary
 *  a plan may draw on; the validator rejects anything outside it. */
export function buildCapabilitySchema() {
  return {
    capabilities: AI_PRESENTATION_CAPABILITIES,
    grid: { columns: 36, allowedSpans: [...AI_ALLOWED_SPANS] },
    composition: {
      primitives: [...LAYOUT_PRIMITIVES],
      styles: [...COMPOSITION_STYLES],
      densities: [...PRESENTATION_DENSITIES],
    },
    visual: {
      roles: [...PRESENTATION_ROLES],
      spans: [...PRESENTATION_SPANS],
      emphasis: [...PRESENTATION_EMPHASES],
    },
    theme: {
      templates: templateIds(),
      colorways: colorwayIds(),
      modes: ['light', 'dark'],
      cardTreatments: ['clean', 'soft', 'tinted', 'elevated', 'glass', 'outline', 'frameless'],
      // The mood behind each id, so "dark, violet, modern" can be chosen rather
      // than guessed. Match a requested colour to a colorway's `accent`, a
      // dark/night request to one whose `mode` is dark, and a "modern" request
      // to a template whose `skin` is modern.
      colorwayGuide: colorwayGuide(),
      templateGuide: templateGuide(),
    },
    slicer: {
      docks: [...AI_ALLOWED_SLICER_DOCKS],
      variants: [...AI_ALLOWED_SLICER_VARIANTS],
      styles: [...AI_ALLOWED_SLICER_STYLES],
    },
    tileStyle: { allowedKeys: [...AI_ALLOWED_CHART_STYLE_KEYS] },
    decorative: { widgetTypes: [...DECORATIVE_WIDGET_TYPES] },
  };
}
