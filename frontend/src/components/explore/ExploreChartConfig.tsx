'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AreaChart,
  BarChart2,
  BarChart3,
  BarChart4,
  BarChartHorizontal,
  Box,
  Boxes,
  Check,
  ChevronDown,
  CircleDot,
  Cloud,
  Donut,
  Flame,
  Gauge,
  GitBranch,
  LayoutGrid,
  LineChart,
  Map as MapIcon,
  MapPin,
  Network,
  PieChart,
  Radar,
  Ribbon,
  Rows3,
  ScatterChart,
  Search,
  Table,
  Table2,
  Timer,
  TrendingUp,
  Trophy,
  Workflow,
  X,
  Info,
} from 'lucide-react';
import { CHART_PALETTES, type ChartPaletteName } from '@/lib/chartColors';
import { DATE_FORMAT_OPTIONS, type DateFormatKind } from '@/lib/exploreAggregations';
import { useI18n } from '@/providers/LanguageProvider';
import type {
  ChartBenchmarkLineStyle,
  BenchmarkLineDef,
  BenchmarkAggregate,
  ChartSortRule,
  ConditionalFormatRule,
  KpiGoalDirection,
  KpiValueColorRule,
  TableColumnAlignment,
  TableHeatmapRule,
  TableHyperlinkRule,
  TableSummaryCalculation,
  TableSummaryRowConfig,
  TimeGranularity,
} from '@/types/api';

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Types ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
export type { ChartSortRule, TimeGranularity } from '@/types/api';

export type ExploreChartType =
  | 'TABLE' | 'BAR' | 'HORIZONTAL_BAR' | 'GROUPED_BAR' | 'STACKED_BAR'
  | 'LINE' | 'AREA' | 'TIME_SERIES' | 'BAR_LINE'
  | 'PIE' | 'DONUT' | 'RADAR' | 'POLAR_AREA'
  | 'SCATTER' | 'BUBBLE' | 'HEATMAP' | 'TREEMAP' | 'FUNNEL' | 'GAUGE'
  | 'WATERFALL' | 'MATRIX' | 'MAP_POINT' | 'MAP_REGION' | 'BOXPLOT'
  | 'BULLET' | 'SANKEY' | 'SUNBURST' | 'RIBBON' | 'TIMELINE' | 'WORD_CLOUD'
  | 'KPI' | 'PODIUM' | 'NINE_BOX';

export type AggFn = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct' | 'auto';
export type TableLayoutMode = 'standard' | 'pivot';

export type NumberFormat = 'auto' | 'number' | 'compact' | 'percent' | 'currency';
/**
 * A per-column table cell format is EITHER a number format OR a date format
 * (see DateFormatKind). The two value-spaces are disjoint, so a single string
 * field carries both; the renderer branches on `isDateFormatKind`.
 */
export type TableCellFormat = NumberFormat | DateFormatKind;
export type { DateFormatKind };
/** Power-BI-style value-axis "Display units". */
export type AxisDisplayUnits = 'auto' | 'none' | 'thousands' | 'millions' | 'billions';
export type LegendPosition = 'top' | 'bottom' | 'left' | 'right' | 'none';
export const TABLE_PIVOT_COLUMN_LIMIT = 50;

/**
 * Phase-15.82 — manual chart annotation. Rendered as a Recharts
 * `<ReferenceLine>` on the indicated axis. `axis` defaults to `y`.
 * `value` is plotted against that axis (numeric for y, raw row value
 * for x). `color` defaults to a warm hue; `label` is optional.
 */
export interface ChartAnnotation {
  id: string;
  label?: string;
  value: number | string;
  axis?: 'x' | 'y';
  color?: string;
  lineStyle?: 'solid' | 'dashed';
}

/**
 * Phase-15.82 — inline calculated field. Pure FE — evaluated after the
 * BE returns aggregated rows. Supported `expression` grammar:
 *
 *   - References to other metric keys via `${metricKey}` interpolation
 *     (matches `agg__field` form, e.g. `${sum__revenue}`)
 *   - Plain math operators `+ - * /` and parentheses
 *   - Numeric literals (e.g. `100`, `0.5`)
 *
 * Example: `${sum__revenue} / ${sum__units}` produces a per-unit price.
 * Evaluator uses Function constructor in a sandboxed scope (no globals);
 * malformed expressions render as `NaN` and surface in the UI editor.
 */
export interface CalculatedFieldDef {
  id: string;
  label: string;
  expression: string;
  format?: NumberFormat;
}

/**
 * Phase-15.84 — granular data-label customisation (PowerBI-style).
 *
 * Was: a single global `showDataLabels` boolean + a `dataLabelPosition`
 * field that was declared but never read by the renderer.
 *
 * Now: a structured DataLabelConfig where:
 *   - `enabled` is the global on/off (defaults to false).
 *   - `position` controls placement; supported values match Recharts'
 *     `LabelList.position` for the chart family in question.
 *   - `rotation` rotates the text (-90 / 0 / 90). 90° helps fit numbers
 *     on narrow stacked-bar segments.
 *   - `fontSize`, `fontColor`, `background` style the chip.
 *   - `autoHideOverlap` is a best-effort runtime hide for colliding
 *     labels (we drop later ones whose centroid is closer than a
 *     threshold to a previously-placed one).
 *   - `overrides[seriesKey]` lets DA tweak just one series, falling
 *     back to the chart-level config for unset keys.
 *
 * Backward-compat: when `dataLabelConfig` is absent we fall back to the
 * legacy `showDataLabels` + `dataLabelPosition` so charts saved before
 * Phase-15.84 keep rendering exactly the same.
 */
export type DataLabelPosition =
  | 'top' | 'bottom' | 'left' | 'right'
  | 'inside' | 'insideTop' | 'insideBottom' | 'insideStart' | 'insideEnd'
  | 'center' | 'outside';

export type DataLabelRotation = -90 | 0 | 90;

export interface DataLabelStyle {
  position?: DataLabelPosition;
  rotation?: DataLabelRotation;
  fontSize?: number;
  fontColor?: string;
  background?: boolean;
  backgroundColor?: string;
  /** Per-series number-format override; falls back to seriesFormats / global */
  format?: NumberFormat;
}

export interface DataLabelConfig extends DataLabelStyle {
  /** Master switch. Equivalent to legacy `showDataLabels`. */
  enabled?: boolean;
  /** When true, drop labels whose bounding box overlaps an earlier label. */
  autoHideOverlap?: boolean;
  /** Per-series overrides keyed by metricKey / breakdown value. */
  overrides?: Record<string, DataLabelStyle>;
  /**
   * Phase-15.90 — STACKED_BAR has two visually-distinct label kinds
   * that need DIFFERENT colour/background defaults:
   *
   *   - Segment labels sit INSIDE a coloured bar segment. They need
   *     high-contrast text (usually white) and rarely a background.
   *   - Total labels sit ABOVE the stack on the chart background. They
   *     need a dark text colour (usually black / text-secondary) and
   *     can use a translucent background for readability.
   *
   * `segmentStyle` and `totalStyle` are STACKED_BAR-only overrides. When
   * absent, the renderer falls back to chart-level `DataLabelConfig`
   * fields plus its own sensible defaults (white for segment text,
   * text-secondary for total text). Tweaking these does NOT mutate
   * `overrides[seriesKey]` — those remain per-series overrides for
   * individual segments only.
   */
  segmentStyle?: DataLabelStyle;
  totalStyle?: DataLabelStyle;
}

export interface MetricConfig {
  field: string;
  agg: AggFn;
  outputField?: string;
  /**
   * Phase-13: implicit measure flag. True when this metric was auto-created
   * by the FE because the user dragged a raw numeric column directly into
   * the metric slot WITHOUT pre-defining a semantic measure. Pure FE state
   * (BE doesn't read it) — used to show a "promote to measure" prompt and
   * to skip the qualified-upgrade pass for raw columns.
   *
   * Does NOT change any SQL — BE compiles `agg(field)` the same way for
   * implicit and explicit measures. Implicit just means "we made this up
   * for you; consider saving it to your model".
   */
  _implicit?: boolean;
  /**
   * Quick-calc: render this metric as a cumulative RUNNING TOTAL (Power BI
   * "Running total" / YTD when the axis is a date). Pure intent flag — the
   * actual window function is derived in `normalizeRoleConfig` from the
   * chart's ordering dimension (so it tracks the current axis) into
   * `roleConfig.windowFunctions`, which the BE renders as
   * `SUM(<measure>) OVER (ORDER BY <dim> ROWS UNBOUNDED PRECEDING)`. Only
   * meaningful for additive (sum) metrics on an ordered axis.
   */
  runningTotal?: boolean;
}

export interface ChartStyleConfig {
  // Data labels
  /** @deprecated Phase-15.84 — kept for backward compat with charts saved
   *  before DataLabelConfig existed. New code should read
   *  `dataLabelConfig.enabled` instead. */
  showDataLabels?: boolean;
  /** @deprecated Phase-15.84 — superseded by `dataLabelConfig.position`. */
  dataLabelPosition?: 'top' | 'center' | 'inside' | 'outside';
  /** Phase-15.84 — granular data-label settings. See DataLabelConfig. */
  dataLabelConfig?: DataLabelConfig;
  /**
   * Phase-15.89 — STACKED_BAR has TWO independent label concepts:
   *
   *   - 'segment': value text inside each segment of the stack (one
   *     per series per row). Use this when DA wants to read "Region A
   *     = 12, Region B = 5" at a glance.
   *   - 'total':   value text above the top of the stack showing the
   *     SUM of segments. Use this when only the column total matters.
   *   - 'both':    render both (segment values inside + total above).
   *
   * Defaults to 'total' for backward compat (legacy STACKED rendered
   * only the top-of-stack total). Percent mode is unaffected — it
   * always renders per-segment % inside each segment.
   */
  stackedBarLabelMode?: 'segment' | 'total' | 'both';
  // Number formatting
  numberFormat?: NumberFormat;
  currencySymbol?: string;
  decimalPlaces?: number;
  // Axis
  xAxisLabel?: string;
  yAxisLabel?: string;
  yAxisMin?: number | '';
  yAxisMax?: number | '';
  /**
   * Power-BI "Display units" for the value axis tick labels. Controls how
   * large numbers are abbreviated on the AXIS only (data labels / tooltips
   * keep their own numberFormat). 'auto' (default) picks K/M/B per value;
   * 'none' shows the full number; 'thousands'/'millions'/'billions' force a
   * fixed unit.
   */
  axisDisplayUnits?: AxisDisplayUnits;
  // Legend
  legendPosition?: LegendPosition;
  // Grid
  showGrid?: boolean;
  // Palette
  palette?: ChartPaletteName;
  // Per-series color overrides (priority: seriesColors[key] > palette[i]).
  // Key matches the series key shown in the legend (metric key or breakdown value).
  seriesColors?: Record<string, string>;
  // Display-only legend/series aliases. Keys stay identical to seriesColors keys.
  seriesLabels?: Record<string, string>;
  // Font
  fontSize?: number;
  chartTitleFontSize?: number;
  // Bar
  barRadius?: number;
  // Line
  showDots?: boolean;
  lineStyle?: 'solid' | 'dashed';
  // Benchmark line. showBenchmarkLine is the master enable. `benchmarkLines` is
  // the multi-line model (fixed or dynamic-aggregate); the legacy single scalars
  // below are kept for back-compat and folded into a one-element list on load.
  showBenchmarkLine?: boolean;
  benchmarkLines?: BenchmarkLineDef[];
  benchmarkValue?: number | '';
  benchmarkLabel?: string;
  benchmarkColor?: string;
  benchmarkLineStyle?: ChartBenchmarkLineStyle;
  // KPI card
  kpiLabel?: string;
  kpiContextTemplate?: string;
  kpiBenchmarkValue?: number | '';
  // Calculation on the benchmark (dynamic "Target" metric OR the manual value):
  // final = base × multiplier + offset. Lets "[Goal] × 1.1" (110% of goal)
  // without hand-editing the number when the goal changes.
  kpiBenchmarkMultiplier?: number | '';
  kpiBenchmarkOffset?: number | '';
  kpiBenchmarkLabel?: string;
  kpiShowBenchmarkValue?: boolean;
  kpiShowDelta?: boolean;
  kpiGoalDirection?: KpiGoalDirection;
  kpiAccentColor?: string;
  kpiEnableColorRules?: boolean;
  kpiColorRules?: KpiValueColorRule[];
  // KPI icon (lucide-react icon name) + accent border + gradient bg
  kpiIconName?: string;
  kpiIconColor?: string;
  kpiAccentBorder?: boolean;
  kpiGradientBg?: boolean;
  kpiValueFontSize?: number;
  // PODIUM: top-N visualization with medal styling
  podiumTop?: number;        // default 3, max 5
  podiumNameField?: string;  // dimension column for the rank name
  podiumValueField?: string; // measure column for the rank value
  podiumGoldColor?: string;
  podiumSilverColor?: string;
  podiumBronzeColor?: string;
  // Table
  tableEnableConditionalFormatting?: boolean;
  tableEnableHeatmap?: boolean;
  tableConditionalFormatting?: ConditionalFormatRule[];
  tableHeatmapRules?: TableHeatmapRule[];
  tableShowSummaryRow?: boolean;
  tableSummaryLabel?: string;
  tableSummaryLabelColumn?: string;
  tableSummaryRows?: TableSummaryRowConfig[];
  tableColumnWidths?: Record<string, number>;
  tableColumnAlignments?: Record<string, TableColumnAlignment>;
  /** Phase-16.x — per-column number format chosen in the Table chart config
   *  (Explore), keyed by column ref. Overrides the measure's declared format
   *  and the table-wide Number Format for that column only. Empty/absent =
   *  inherit (measure format → table-wide format). Lets DA format a % or money
   *  column at chart-build time without editing the dataset measure. */
  tableColumnFormats?: Record<string, TableCellFormat>;
  // Display-only table header aliases. Raw column keys/data rows are unchanged.
  tableColumnLabels?: Record<string, string>;
  tableHyperlinkRules?: TableHyperlinkRule[];
  // Chart title (shown above the chart)
  chartTitle?: string;
  // PIE: donut inner radius (0 = full pie, >0 = donut, percentage of outer radius 0-80)
  pieInnerRadius?: number;
  // STACKED_BAR: 100% stacked mode
  stackMode?: 'normal' | 'percent';
  // TIME_SERIES: time bucketing granularity
  timeGranularity?: TimeGranularity;
  // Data: multi-column sort rules applied client-side before rendering
  chartSortRules?: ChartSortRule[];
  // Data: limit displayed rows (top N or bottom N)
  dataLimit?: number | '';
  dataLimitDirection?: 'top' | 'bottom';
  // Phase-15.83 — `showAllPoints` retired. The FE no longer truncates;
  // every row from the BE renders. Kept here (deprecated) so older saved
  // charts that already wrote the field don't crash on read — Pydantic
  // is passthrough JSON, so the field stays in DB but is ignored.
  /** @deprecated Phase-15.83 — ignored. */
  showAllPoints?: boolean;
  // Phase-15.82 — per-series formatting & free-form custom tooltip.
  // `seriesFormats[key]` overrides global numberFormat for that series.
  seriesFormats?: Record<string, NumberFormat>;
  // `seriesDecimalPlaces[key]` per-series decimals override.
  seriesDecimalPlaces?: Record<string, number>;
  // Custom tooltip: list of fields to surface (in addition to default
  // series values). Each entry is a raw row key from the result set.
  tooltipExtraFields?: string[];
  // Phase-15.82 — data label template, e.g. "{label}: {value} ({percent}%)".
  // Supported tokens: {value}, {label}, {dimension}, {series}, {percent}.
  dataLabelTemplate?: string;
  // Phase-15.82 — date hierarchy drill state. When non-null, overrides
  // `timeGranularity` for the current render. Cleared on chart-type or
  // dimension change.
  dateDrillLevel?: TimeGranularity;
  // Phase-15.82 — conditional color rules for bar/line series. Same shape
  // as table ConditionalFormatRule but applied to series cells.
  seriesConditionalRules?: ConditionalFormatRule[];
  // Phase-15.82 — manual annotations rendered as ReferenceLines/Areas on
  // cartesian charts. Each entry is a label + value + axis target.
  annotations?: ChartAnnotation[];
  // Phase-15.82 — free-form mixed series. When non-empty, BAR_LINE-like
  // mix is replaced by an explicit `(metricKey, renderAs)` mapping.
  seriesRenderAs?: Record<string, 'bar' | 'line' | 'area'>;
  // Phase-15.82 — inline calculated fields (DAX-lite). Each evaluates
  // against aggregated row to produce a derived numeric series.
  calculatedFields?: CalculatedFieldDef[];
  // BAR_LINE: show a second Y axis on the right for the line metric
  dualYAxis?: boolean;
  yAxisRightLabel?: string;
  // AREA: fill opacity (0–1)
  areaOpacity?: number;
  // LINE/AREA/TIME_SERIES: stroke width in px
  lineWidth?: number;
  // BAR types: fixed bar width in px (undefined = auto)
  barSize?: number | '';
  // SCATTER: dimension field used as point labels
  scatterLabelField?: string;
}

export const DEFAULT_STYLE_CONFIG: ChartStyleConfig = {
  showDataLabels: false,
  dataLabelPosition: 'top',
  numberFormat: 'compact',
  currencySymbol: '$',
  decimalPlaces: 1,
  xAxisLabel: '',
  yAxisLabel: '',
  yAxisMin: '',
  yAxisMax: '',
  axisDisplayUnits: 'auto',
  legendPosition: 'bottom',
  showGrid: true,
  palette: 'default',
  fontSize: 12,
  chartTitleFontSize: undefined,
  barRadius: 4,
  // Markers default to Auto (undefined): the renderer shows dots on sparse
  // series and hides them on dense ones (Power BI parity). 'Always'/'Never'
  // are explicit overrides set via the Markers select. A forced `true` here
  // used to clutter 100+-point lines with dots by default.
  showDots: undefined,
  lineStyle: 'solid',
  showBenchmarkLine: false,
  benchmarkValue: '',
  benchmarkLabel: 'Benchmark',
  benchmarkColor: '#dc2626',
  benchmarkLineStyle: 'dashed',
  kpiLabel: '',
  kpiContextTemplate: '',
  kpiBenchmarkValue: '',
  kpiBenchmarkLabel: 'Target',
  kpiShowBenchmarkValue: true,
  kpiShowDelta: true,
  kpiGoalDirection: 'up',
  kpiAccentColor: '#2563eb',
  kpiEnableColorRules: false,
  kpiColorRules: [],
  kpiValueFontSize: undefined,
  tableEnableConditionalFormatting: false,
  tableEnableHeatmap: false,
  tableShowSummaryRow: false,
  tableSummaryLabel: 'Total',
  tableColumnWidths: undefined,
  tableColumnAlignments: undefined,
  tableHyperlinkRules: undefined,
  // New features
  chartTitle: '',
  pieInnerRadius: 0,
  stackMode: 'normal',
  timeGranularity: 'raw',
  chartSortRules: [],
  dataLimit: '',
  dataLimitDirection: 'top',
  dualYAxis: false,
  yAxisRightLabel: '',
  areaOpacity: 0.6,
  lineWidth: 2,
  barSize: '',
  scatterLabelField: '',
};

function normalizePixelSize(value: unknown, fallback?: number, min = 8, max = 72): number | undefined {
  if (value === '' || value === null || value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

function normalizeLabelOverrideMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, label]) => [key.trim(), typeof label === 'string' ? label.trim() : ''] as const)
    .filter(([key, label]) => key.length > 0 && label.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function normalizeChartStyleConfig(
  styleConfig: ChartStyleConfig | null | undefined,
  legacyConditionalFormatting?: ConditionalFormatRule[] | null,
): ChartStyleConfig {
  const rawStyleConfig = styleConfig ?? {};
  const normalized: ChartStyleConfig = {
    ...DEFAULT_STYLE_CONFIG,
    ...rawStyleConfig,
  };

  if (
    (!normalized.tableConditionalFormatting || normalized.tableConditionalFormatting.length === 0) &&
    legacyConditionalFormatting &&
    legacyConditionalFormatting.length > 0
  ) {
    normalized.tableConditionalFormatting = legacyConditionalFormatting;
  }

  if (
    (!normalized.tableSummaryRows || normalized.tableSummaryRows.length === 0) &&
    normalized.tableShowSummaryRow
  ) {
    normalized.tableSummaryRows = [{
      label: normalized.tableSummaryLabel || 'Total',
      calculation: 'sum',
      labelColumn: normalized.tableSummaryLabelColumn,
    }];
  }

  if (normalized.tableSummaryRows?.length) {
    normalized.tableSummaryRows = normalized.tableSummaryRows.map((row) => ({
      label: row.label?.trim() || 'Total',
      calculation: row.calculation ?? 'sum',
      columns: row.columns?.filter(Boolean),
      labelColumn: row.labelColumn?.trim() || undefined,
    }));
  }

  if (normalized.tableColumnWidths) {
    const validWidths = Object.entries(normalized.tableColumnWidths)
      .filter(([columnName, width]) => columnName.trim() && Number.isFinite(Number(width)) && Number(width) > 0)
      .map(([columnName, width]) => [columnName, Math.round(Number(width))] as const);
    normalized.tableColumnWidths = validWidths.length > 0 ? Object.fromEntries(validWidths) : undefined;
  }

  if (normalized.tableColumnAlignments) {
    const validAlignments = Object.entries(normalized.tableColumnAlignments)
      .filter((entry): entry is [string, TableColumnAlignment] => (
        entry[0].trim().length > 0
        && ['left', 'center', 'right'].includes(String(entry[1]))
      ));
    normalized.tableColumnAlignments = validAlignments.length > 0 ? Object.fromEntries(validAlignments) : undefined;
  }

  normalized.seriesLabels = normalizeLabelOverrideMap(normalized.seriesLabels);
  normalized.tableColumnLabels = normalizeLabelOverrideMap(normalized.tableColumnLabels);

  if (Array.isArray(normalized.tableHyperlinkRules)) {
    const validRules = normalized.tableHyperlinkRules
      .map((rule) => ({
        ...rule,
        id: rule.id?.trim() || undefined,
        targetColumn: rule.targetColumn?.trim() || '',
        urlColumn: rule.urlColumn?.trim() || undefined,
        // BUG-006 — keep the URL template (column-only rules leave it undefined).
        urlTemplate: typeof rule.urlTemplate === 'string' ? rule.urlTemplate : undefined,
        openInNewTab: rule.openInNewTab !== false,
      }))
      .filter((rule) => rule.targetColumn && (rule.urlColumn || typeof rule.urlTemplate === 'string'));
    normalized.tableHyperlinkRules = validRules.length > 0 ? validRules : undefined;
  } else {
    normalized.tableHyperlinkRules = undefined;
  }

  if (!Object.prototype.hasOwnProperty.call(rawStyleConfig, 'tableEnableConditionalFormatting')) {
    normalized.tableEnableConditionalFormatting = Boolean(normalized.tableConditionalFormatting?.length);
  }

  if (!Object.prototype.hasOwnProperty.call(rawStyleConfig, 'tableEnableHeatmap')) {
    normalized.tableEnableHeatmap = Boolean(normalized.tableHeatmapRules?.length);
  }

  if (!Object.prototype.hasOwnProperty.call(rawStyleConfig, 'tableShowSummaryRow')) {
    normalized.tableShowSummaryRow = Boolean(normalized.tableSummaryRows?.length);
  }

  if (!Object.prototype.hasOwnProperty.call(rawStyleConfig, 'showBenchmarkLine')) {
    normalized.showBenchmarkLine = rawStyleConfig?.benchmarkValue !== undefined && rawStyleConfig?.benchmarkValue !== '';
  }
  // Fold the legacy single benchmark scalars into the multi-line array so the
  // editor shows the existing line. Only when no array is already present.
  if ((!Array.isArray(normalized.benchmarkLines) || normalized.benchmarkLines.length === 0)
      && normalized.benchmarkValue !== undefined && normalized.benchmarkValue !== '') {
    normalized.benchmarkLines = [{
      source: 'value',
      value: normalized.benchmarkValue,
      label: normalized.benchmarkLabel,
      color: normalized.benchmarkColor,
      lineStyle: normalized.benchmarkLineStyle,
    }];
  }
  if (!Array.isArray(normalized.benchmarkLines)) normalized.benchmarkLines = [];

  normalized.fontSize = normalizePixelSize(normalized.fontSize, DEFAULT_STYLE_CONFIG.fontSize, 8, 48);
  normalized.chartTitleFontSize = normalizePixelSize(normalized.chartTitleFontSize, undefined, 10, 48);
  normalized.kpiValueFontSize = normalizePixelSize(normalized.kpiValueFontSize, undefined, 16, 80);

  if (normalized.kpiColorRules?.length) {
    normalized.kpiColorRules = normalized.kpiColorRules.map((rule) => ({
      operator: rule.operator ?? '>=',
      value: Number.isFinite(Number(rule.value)) ? Number(rule.value) : 0,
      color: normalizeColorInput(rule.color || '#16a34a', '#16a34a'),
      label: rule.label?.trim() || undefined,
      // Preserve dynamic-threshold fields (source/multiplier/offset).
      source: rule.source === 'benchmark' ? 'benchmark' : 'value',
      ...(typeof rule.multiplier === 'number' ? { multiplier: rule.multiplier } : {}),
      ...(typeof rule.offset === 'number' ? { offset: rule.offset } : {}),
    }));
  }

  if (!Object.prototype.hasOwnProperty.call(rawStyleConfig, 'kpiEnableColorRules')) {
    normalized.kpiEnableColorRules = Boolean(normalized.kpiColorRules?.length);
  }

  return normalized;
}

/**
 * Window-function definition forwarded to the BE semantic engine (it renders
 * `SUM(<base_measure>) OVER (ORDER BY <order_by> ...)`). Derived from metrics
 * flagged `runningTotal` in `normalizeRoleConfig` — not edited directly.
 */
export interface WindowFunctionDef {
  name: string;          // output column name
  base_measure: string;  // measure/column ref to accumulate
  order_by: string[];    // ordering dimension ref(s)
  type: 'running_sum' | 'running_avg' | 'rank' | 'dense_rank' | 'row_number';
}

export interface ChartRoleConfig {
  dimension?: string;
  metrics: MetricConfig[];
  /** Derived (not hand-edited): running-total / window outputs for the BE. */
  windowFunctions?: WindowFunctionDef[];
  /** Legacy breakdown dimension for stacked/pivoted charts. */
  breakdown?: string;
  /** Additive BAR_LINE contract: one aggregated metric rendered as a line. */
  lineMetric?: MetricConfig;
  /** Optional KPI benchmark metric used for dynamic context/delta calculations. */
  benchmarkMetric?: MetricConfig;
  timeField?: string;
  scatterX?: string;
  scatterY?: string;
  /** BUBBLE only: how the X / Y axes aggregate per Label (PowerBI "Details").
   *  Default SUM. Ignored for SCATTER / MAP_POINT (which plot raw points). */
  scatterXAgg?: AggFn;
  scatterYAgg?: AggFn;
  /** For TABLE type: standard flat table or dynamic pivot table */
  tableMode?: TableLayoutMode;
  /** For TABLE pivot mode: the row grouping dimension */
  tableRowDimension?: string;
  /** For TABLE pivot mode: the dimension turned into dynamic headers */
  tableColumnDimension?: string;
  /** For TABLE pivot mode: the aggregated measure inside pivot cells */
  tablePivotMetric?: MetricConfig;
  /** For TABLE type: which columns to show. undefined = show all */
  selectedColumns?: string[];
  /**
   * Phase-13.4: bucket time dimensions on the BE via date_trunc. Keyed by
   * the dimension field name (qualified `view.field` or bare). Value is
   * the grain — engine emits dialect-correct SQL (Phase-5 multi-dialect).
   * Empty / missing key = no bucketing (raw timestamps).
   */
  timeGrains?: Record<string, TimeGrain>;
}

export type TimeGrain = 'day' | 'week' | 'month' | 'quarter' | 'year';

export const TIME_GRAIN_OPTIONS: { value: TimeGrain; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'Year' },
];

export const EMPTY_ROLE_CONFIG: ChartRoleConfig = { metrics: [] };

const TABLE_LIKE_TYPES = new Set<string>(['TABLE', 'MATRIX']);
const SCATTER_LIKE_TYPES = new Set<string>(['SCATTER', 'BUBBLE', 'MAP_POINT', 'NINE_BOX']);
const NO_DIMENSION_METRIC_TYPES = new Set<string>(['KPI', 'GAUGE', 'BULLET']);
const PIE_LIKE_TYPES = new Set<string>(['PIE', 'DONUT', 'POLAR_AREA']);
const BREAKDOWN_CHART_TYPES = new Set<string>([
  'GROUPED_BAR',
  'STACKED_BAR',
  'HEATMAP',
  'SANKEY',
  'SUNBURST',
  'RIBBON',
]);
const BREAKDOWN_SUPPORTED_CHART_TYPES = new Set<string>([
  ...BREAKDOWN_CHART_TYPES,
  'LINE',
  'AREA',
  'TIME_SERIES',
  // MAP_POINT uses a breakdown to draw a per-region DONUT marker (category
  // segments) on the basemap; without this the breakdown is stripped on
  // normalize and the map falls back to plain points.
  'MAP_POINT',
]);
const RAW_DISTRIBUTION_TYPES = new Set<string>(['BOXPLOT']);

/**
 * Phase-15.78 — when DA changes chart type in Explore, transfer the
 * old role config into the new chart's shape so the canvas doesn't
 * render blank just because the role field names differ.
 *
 * Concretely:
 *   BAR (dimension + metrics)         → SCATTER (scatterX + scatterY)
 *     scatterX gets the first metric field, scatterY the second, falling
 *     back to dimension when only one metric exists. DA's intent
 *     ("plot these two numeric fields") is preserved.
 *
 *   LINE (dimension + metrics)        → TIME_SERIES (timeField + metrics)
 *     dimension carries over to timeField; metrics stay.
 *
 *   PIE (dimension + 1 metric)        → KPI (metrics, no dimension)
 *     drop dimension, keep first metric.
 *
 *   SCATTER (scatterX/scatterY)       → BAR (dimension + metrics)
 *     scatterX becomes the dimension, scatterY becomes the first metric.
 *
 *   BAR (metrics)                     → BAR_LINE (metrics + lineMetric)
 *     if there are ≥2 metrics, second one becomes lineMetric.
 *
 *   TABLE/MATRIX transitions          → handled by createDefaultTableRoleConfig
 *     in ExploreEditor.handleChartTypeChange — this helper deliberately
 *     skips those (they have their own field shape).
 *
 * Anything we can't infer just falls through unchanged. Combined with
 * normalizeRoleConfig (which prunes fields that don't belong to the new
 * type), the result is a config that's at least *render-attemptable*.
 * If the new chart still lacks required fields, the existing
 * getChartRoleConfigValidationMessage banner explains what's missing.
 */
const TIME_SERIES_LIKE_TYPES = new Set<string>(['TIME_SERIES', 'RIBBON']);

export function migrateRoleConfig(
  fromType: string,
  toType: string,
  config: ChartRoleConfig | null | undefined,
): ChartRoleConfig {
  if (fromType === toType || !config) {
    return config ?? EMPTY_ROLE_CONFIG;
  }

  const next: ChartRoleConfig = { ...config, metrics: [...(config.metrics ?? [])] };

  const toScatter = SCATTER_LIKE_TYPES.has(toType);
  const fromScatter = SCATTER_LIKE_TYPES.has(fromType);
  const toTime = TIME_SERIES_LIKE_TYPES.has(toType);
  const fromTime = TIME_SERIES_LIKE_TYPES.has(fromType);

  // SCATTER family: needs scatterX + scatterY. Map from metrics/dimension.
  if (toScatter && !fromScatter) {
    if (!next.scatterX) {
      next.scatterX = next.metrics[0]?.field ?? next.dimension;
    }
    if (!next.scatterY) {
      // Prefer a second metric for Y; fall back to first metric if only one.
      next.scatterY = next.metrics[1]?.field ?? next.metrics[0]?.field;
    }
  }

  // SCATTER → categorical: rehydrate dimension + metrics from x/y.
  if (fromScatter && !toScatter) {
    if (!next.dimension && next.scatterX) {
      next.dimension = next.scatterX;
    }
    if (next.metrics.length === 0 && next.scatterY) {
      // 'auto' (not 'sum'): scatterY may reference a declared measure whose
      // aggregation is part of its definition (percent_of_total / count_distinct
      // / …). Hardcoding 'sum' would override the declared type before the BE
      // sees it. 'auto' defers to the measure's stored type and still SUMs a
      // raw numeric column. Mirrors the BE normalize_metric_config(default='auto').
      next.metrics = [{ field: next.scatterY, agg: 'auto' }];
    }
  }

  // TIME_SERIES family: needs timeField; pull from dimension if not set.
  if (toTime && !fromTime && !next.timeField && next.dimension) {
    next.timeField = next.dimension;
  }

  // Coming OUT of TIME_SERIES into a plain categorical: dimension is the
  // user-facing X. Surface timeField so the BAR/LINE doesn't render blank.
  if (fromTime && !toTime && !next.dimension && next.timeField) {
    next.dimension = next.timeField;
  }

  // BAR_LINE needs metrics[] for bars AND a lineMetric for the line series.
  // If switching INTO BAR_LINE with multiple metrics, donate the last one
  // to lineMetric so the chart isn't just a bar chart in disguise.
  if (toType === 'BAR_LINE' && !next.lineMetric && next.metrics.length >= 2) {
    next.lineMetric = next.metrics[next.metrics.length - 1];
    next.metrics = next.metrics.slice(0, -1);
  }

  // Leaving BAR_LINE: fold lineMetric back into metrics so we don't lose the
  // user's field choice — normalizeRoleConfig will trim if the new type only
  // supports one metric.
  if (fromType === 'BAR_LINE' && toType !== 'BAR_LINE' && next.lineMetric) {
    next.metrics = [...next.metrics, next.lineMetric];
    next.lineMetric = undefined;
  }

  // Coming INTO PIE/DONUT/etc. or KPI/GAUGE/BULLET: normalizeRoleConfig
  // already trims to one metric and (for KPI/GAUGE/BULLET) the dimension
  // is irrelevant. Don't undo that here.

  return next;
}

/**
 * Optional registry mapping qualified field refs (`view.field`) or bare field
 * names to the human-friendly label declared on the semantic measure /
 * dimension. Callers that know the semantic model build this map once and
 * pass it into {@link metricLabel}.
 */
export type SemanticLabelMap = Map<string, string> | Record<string, string>;

function lookupSemanticLabel(field: string, map?: SemanticLabelMap): string | undefined {
  if (!map) return undefined;
  // Narrow once into a callable getter so TS doesn't choke on the union.
  const isMap = map instanceof globalThis.Map;
  const get = isMap
    ? (k: string): string | undefined => (map as Map<string, string>).get(k)
    : (k: string): string | undefined => (map as Record<string, string>)[k];
  // Try qualified ref first, then bare field, then last-segment of qualified.
  const direct = get(field);
  if (direct) return direct;
  if (field.includes('.')) {
    const last = field.split('.').slice(-1)[0];
    const byLast = get(last);
    if (byLast) return byLast;
  }
  return undefined;
}

/** Display label, e.g. "SUM of revenue".
 *
 * Two special cases:
 *
 * 1. ``agg === 'auto'``: the metric is referencing a measure whose
 *    aggregation is part of the measure definition. We must not prepend
 *    "AUTO of " — that reads like a bug. We fall back to the semantic label
 *    (if a ``labelMap`` is provided) or to the bare field segment.
 *
 * 2. Otherwise we strip the ``view.`` qualifier so the label is short.
 *
 * Pass ``labelMap`` to render user-friendly Vietnamese / business labels
 * stored on measures (e.g. ``"Unique users"`` instead of
 * ``"task_user_distinct"``).
 */
export function metricLabel(m: MetricConfig, labelMap?: SemanticLabelMap): string {
  const fieldDisplay = m.field.includes('.') ? m.field.split('.').slice(-1)[0] : m.field;
  const semanticLabel = lookupSemanticLabel(m.field, labelMap);
  if (m.agg === 'auto') return semanticLabel || fieldDisplay;
  const aggName = m.agg === 'count_distinct' ? 'COUNT DISTINCT' : m.agg.toUpperCase();
  return `${aggName} of ${semanticLabel || fieldDisplay}`;
}

/** Friendly display label for a plain (dimension) field key.
 * Prefers the semantic label map; otherwise humanises the bare last segment
 * (e.g. "dataset_table_225.region_name" → "Region Name"). Used to default
 * axis titles so a chart names its grouping dimension (BI-standard) instead
 * of leaving axes unlabelled. */
export function fieldLabel(field: string | null | undefined, labelMap?: SemanticLabelMap): string | undefined {
  const raw = String(field ?? '').trim();
  if (!raw) return undefined;
  const semantic = lookupSemanticLabel(raw, labelMap);
  if (semantic) return semantic;
  const bare = raw.includes('.') ? raw.split('.').slice(-1)[0] : raw;
  // humanise snake/camel → Title Case words
  return bare
    .replace(/[_\-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** recharts dataKey for a MetricConfig */
export function metricKey(m: MetricConfig): string {
  return `${m.agg}__${m.field}`;
}

export function normalizeMetricConfig(metric: MetricConfig | string | null | undefined): MetricConfig | null {
  // Default agg is 'auto', NOT 'sum': a metric that references a declared
  // semantic measure carries its aggregation in the measure definition
  // (percent_of_total / count_distinct / window / …). Defaulting a missing /
  // string-form agg to 'sum' would silently override that declared type (the
  // "metric identity loss" — a % measure rendered as raw SUM). 'auto' tells the
  // BE to use the stored measure type, and a raw numeric column still SUMs.
  // Mirrors backend chart_contracts.normalize_metric_config(default_agg="auto").
  if (!metric) return null;
  if (typeof metric === 'string') {
    const field = metric.trim();
    return field ? { field, agg: 'auto' } : null;
  }

  const field = metric.field?.trim();
  if (!field) return null;
  return {
    field,
    agg: metric.agg ?? 'auto',
    outputField: metric.outputField?.trim() || undefined,
    ...(metric.runningTotal ? { runningTotal: true } : {}),
  };
}

export function normalizeRoleConfig(chartType: string, roleConfig: ChartRoleConfig | null | undefined): ChartRoleConfig {
  let normalizedMetrics = (roleConfig?.metrics ?? [])
    .map(metric => normalizeMetricConfig(metric as MetricConfig | string))
    .filter((metric): metric is MetricConfig => metric !== null);

  // Per-chart contract — prune incompatible state when chartType switches.
  // BAR / HORIZONTAL_BAR: many measures, no breakdown.
  // GROUPED_BAR / STACKED_BAR: single measure + breakdown.
  // BAR_LINE: bar metrics + explicit lineMetric, no breakdown.
  let breakdown = roleConfig?.breakdown;
  if (!BREAKDOWN_SUPPORTED_CHART_TYPES.has(chartType) || chartType === 'BAR_LINE') {
    breakdown = undefined;
  }
  if (
    (
      chartType === 'GROUPED_BAR' ||
      chartType === 'STACKED_BAR' ||
      PIE_LIKE_TYPES.has(chartType) ||
      BREAKDOWN_CHART_TYPES.has(chartType) ||
      ['FUNNEL', 'TREEMAP', 'WATERFALL', 'MAP_REGION', 'WORD_CLOUD', 'BOXPLOT'].includes(chartType)
    ) &&
    normalizedMetrics.length > 1
  ) {
    normalizedMetrics = [normalizedMetrics[0]];
  }

  // Explicit only — no implicit breakdown→lineMetric fallback.
  const lineMetric = chartType === 'BAR_LINE'
    ? normalizeMetricConfig(roleConfig?.lineMetric)
    : null;

  const benchmarkMetric = normalizeMetricConfig(roleConfig?.benchmarkMetric);
  const tablePivotMetric = normalizeMetricConfig(roleConfig?.tablePivotMetric);
  const tableMode: TableLayoutMode = TABLE_LIKE_TYPES.has(chartType) && roleConfig?.tableMode === 'pivot'
    ? 'pivot'
    : 'standard';

  // Phase-15.24: collapse `selectedColumns: []` (empty array) to undefined
  // so downstream consumers (chart adapter, TableVisualization) reliably
  // hit the "show every column" fallback. The Visible Columns toggle
  // (ExploreChartConfig:2694) writes `[]` for "deselect all" which used
  // to leak through `??` chains as a literal empty list and render a
  // zero-column TABLE — DA's intent was "use defaults" anyway.
  const rawSelectedColumns = roleConfig?.selectedColumns;
  const selectedColumns = Array.isArray(rawSelectedColumns) && rawSelectedColumns.length === 0
    ? undefined
    : rawSelectedColumns;

  // Derive window functions from metrics flagged `runningTotal`. We compute
  // it here (rather than storing a fixed window) so order_by always tracks
  // the CURRENT ordering dimension — changing the axis updates the cumulative
  // without the DA re-toggling. Needs an ordered axis (dimension / timeField /
  // pivot row) and is only meaningful for additive metrics, so we gate on
  // sum-like aggregations.
  const orderRef = roleConfig?.dimension || roleConfig?.timeField || roleConfig?.tableRowDimension;
  const windowFunctions: WindowFunctionDef[] = orderRef
    ? normalizedMetrics
        .filter(m => m.runningTotal && (m.agg === 'sum' || m.agg === 'auto'))
        .map(m => ({
          name: `${metricKey(m)}__rt`,
          base_measure: m.field,
          order_by: [orderRef],
          type: 'running_sum' as const,
        }))
    : [];

  return {
    ...(roleConfig ?? EMPTY_ROLE_CONFIG),
    selectedColumns,
    metrics: normalizedMetrics,
    breakdown,
    tableMode,
    ...(benchmarkMetric ? { benchmarkMetric } : {}),
    ...(tablePivotMetric ? { tablePivotMetric } : {}),
    ...(lineMetric ? { lineMetric } : {}),
    windowFunctions: windowFunctions.length ? windowFunctions : undefined,
  };
}

const BREAKDOWN_MULTI_METRIC_UNSUPPORTED_TYPES = new Set<ExploreChartType>([
  'LINE',
  'AREA',
  'TIME_SERIES',
]);

const SINGLE_METRIC_TYPES = new Set<ExploreChartType>([
  'GROUPED_BAR',
  'STACKED_BAR',
  'PIE',
  'DONUT',
  'POLAR_AREA',
  'FUNNEL',
  'TREEMAP',
  'WATERFALL',
  'MAP_REGION',
  'BOXPLOT',
  'HEATMAP',
  'SANKEY',
  'SUNBURST',
  'RIBBON',
  'TIMELINE',
  'WORD_CLOUD',
  'KPI',
  'GAUGE',
  'BULLET',
  'PODIUM',
]);

const BREAKDOWN_REQUIRED_TYPES = new Set<ExploreChartType>([
  'GROUPED_BAR',
  'STACKED_BAR',
  'HEATMAP',
  'SANKEY',
  'SUNBURST',
  'RIBBON',
]);

export function getChartRoleConfigValidationMessage(
  chartType: string,
  roleConfig: ChartRoleConfig | null | undefined,
): string | null {
  const normalized = normalizeRoleConfig(chartType, roleConfig);
  const typedChart = chartType as ExploreChartType;

  if (SINGLE_METRIC_TYPES.has(typedChart) && normalized.metrics.length > 1) {
    return 'This chart type supports only one value column. Remove extra metrics to continue.';
  }

  if (BREAKDOWN_REQUIRED_TYPES.has(typedChart) && !normalized.breakdown) {
    return 'This chart type requires a Breakdown field.';
  }

  if (
    BREAKDOWN_MULTI_METRIC_UNSUPPORTED_TYPES.has(typedChart)
    && normalized.breakdown
    && normalized.metrics.length > 1
  ) {
    return 'This chart cannot combine multiple value columns with Breakdown. Keep one metric or clear Breakdown.';
  }

  return null;
}

export function getChartRoleConfigRequirementMessage(
  chartType: string,
  roleConfig: ChartRoleConfig | null | undefined,
): string | null {
  const validationMessage = getChartRoleConfigValidationMessage(chartType, roleConfig);
  if (validationMessage) {
    return validationMessage;
  }

  const normalized = normalizeRoleConfig(chartType, roleConfig);

  if (TABLE_LIKE_TYPES.has(chartType)) {
    if (normalized.tableMode !== 'pivot') {
      return null;
    }
    if (!normalized.tableRowDimension) {
      return 'Choose a row dimension for the pivot table.';
    }
    if (!normalized.tableColumnDimension) {
      return 'Choose a column dimension for the pivot table.';
    }
    if (!normalized.tablePivotMetric) {
      return 'Choose a value measure for the pivot table.';
    }
    return null;
  }

  if (SCATTER_LIKE_TYPES.has(chartType)) {
    if (!normalized.scatterX) {
      return 'Choose an X axis column for this chart.';
    }
    if (!normalized.scatterY) {
      return 'Choose a Y axis column for this chart.';
    }
    if (chartType === 'BUBBLE' && normalized.metrics.length === 0) {
      return 'Choose a size value column for the bubble chart.';
    }
    return null;
  }

  if (NO_DIMENSION_METRIC_TYPES.has(chartType)) {
    return normalized.metrics.length > 0
      ? null
      : 'Choose a value column for this chart.';
  }

  if (chartType === 'PODIUM') {
    if (!normalized.dimension) {
      return 'Choose a rank name column for the podium chart.';
    }
    if (normalized.metrics.length === 0) {
      return 'Choose a rank value column for the podium chart.';
    }
    return null;
  }

  if (PIE_LIKE_TYPES.has(chartType)) {
    if (!normalized.dimension) {
      return 'Choose a legend column for this chart.';
    }
    if (normalized.metrics.length === 0) {
      return 'Choose a value column for this chart.';
    }
    return null;
  }

  if (RAW_DISTRIBUTION_TYPES.has(chartType)) {
    if (!normalized.dimension) {
      return 'Choose a category column for this chart.';
    }
    if (normalized.metrics.length === 0) {
      return 'Choose a numeric value column for this chart.';
    }
    return null;
  }

  if (chartType === 'STACKED_BAR') {
    if (!normalized.dimension) {
      return 'Choose an X axis column for the stacked bar chart.';
    }
    if (normalized.metrics.length === 0) {
      return 'Choose a value column for the stacked bar chart.';
    }
    if (!normalized.breakdown) {
      return 'Choose a Stack by column for the stacked bar chart.';
    }
    return null;
  }

  if (chartType === 'BAR_LINE') {
    if (!normalized.dimension) {
      return 'Choose an X axis column for the bar + line chart.';
    }
    if (normalized.metrics.length === 0) {
      return 'Choose at least one bar value column for the bar + line chart.';
    }
    if (!normalized.lineMetric) {
      return 'Choose a line value column for the bar + line chart.';
    }
    return null;
  }

  if (chartType === 'TIME_SERIES' || chartType === 'TIMELINE') {
    if (!normalized.timeField && !normalized.dimension) {
      return 'Choose a time field for this chart.';
    }
    if (chartType === 'TIME_SERIES' && normalized.metrics.length === 0) {
      return 'Choose at least one value column for the time series chart.';
    }
    return null;
  }

  if (!normalized.dimension) {
    return chartType === 'HORIZONTAL_BAR'
      ? 'Choose a Y axis column for this chart.'
      : 'Choose an X axis column for this chart.';
  }

  if (normalized.metrics.length === 0) {
    return 'Choose at least one value column for this chart.';
  }

  return null;
}

export function getRoleConfigDimensionFields(chartType: string, roleConfig: ChartRoleConfig | null | undefined): string[] {
  const normalized = normalizeRoleConfig(chartType, roleConfig);
  const fields = [normalized.dimension, normalized.timeField];
  if (TABLE_LIKE_TYPES.has(chartType) && normalized.tableMode === 'pivot') {
    fields.push(normalized.tableRowDimension, normalized.tableColumnDimension);
  }
  if (SCATTER_LIKE_TYPES.has(chartType)) {
    fields.push(normalized.scatterX, normalized.scatterY);
  }
  if (chartType !== 'BAR_LINE' && normalized.breakdown) {
    fields.push(normalized.breakdown);
  }
  return fields.filter((field): field is string => Boolean(field));
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Chart type list ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
type ChartTypeGroupKey = 'essentials' | 'comparison' | 'trend' | 'composition' | 'relationship' | 'geo';

type ChartTypeMeta = {
  value: ExploreChartType;
  label: string;
  group: ChartTypeGroupKey;
  icon: React.ComponentType<{ className?: string }>;
};

type ChartTypeGroupMeta = {
  key: ChartTypeGroupKey;
  label: string;
  hint: string;
};

const DEFAULT_CHART_TYPE_GROUP: ChartTypeGroupMeta = {
  key: 'essentials',
  label: 'Essentials',
  hint: 'Tables, cards, and goal visuals',
};

const CHART_TYPE_GROUPS: ChartTypeGroupMeta[] = [
  DEFAULT_CHART_TYPE_GROUP,
  { key: 'comparison', label: 'Comparison', hint: 'Compare categories and rankings' },
  { key: 'trend', label: 'Trend', hint: 'Follow change over time or order' },
  { key: 'composition', label: 'Composition', hint: 'Show part-to-whole structure' },
  { key: 'relationship', label: 'Relationship', hint: 'Reveal correlation, flow, and distribution' },
  { key: 'geo', label: 'Geo', hint: 'Map-based location visuals' },
];

const DEFAULT_CHART_TYPE_META: ChartTypeMeta = {
  value: 'TABLE',
  label: 'Table',
  group: 'essentials',
  icon: Table,
};

const CHART_TYPE_GRID: ChartTypeMeta[] = [
  DEFAULT_CHART_TYPE_META,
  { value: 'MATRIX',         label: 'Matrix',         group: 'essentials', icon: Table2 },
  { value: 'KPI',            label: 'KPI',            group: 'essentials', icon: Activity },
  { value: 'GAUGE',          label: 'Gauge',          group: 'essentials', icon: Gauge },
  { value: 'BULLET',         label: 'Bullet',         group: 'essentials', icon: Rows3 },
  { value: 'PODIUM',         label: 'Podium',         group: 'essentials', icon: Trophy },
  { value: 'BAR',            label: 'Bar',            group: 'comparison', icon: BarChart3 },
  { value: 'HORIZONTAL_BAR', label: 'Horizontal Bar', group: 'comparison', icon: BarChartHorizontal },
  { value: 'GROUPED_BAR',    label: 'Grouped Bar',    group: 'comparison', icon: BarChart2 },
  { value: 'STACKED_BAR',    label: 'Stacked Bar',    group: 'comparison', icon: BarChart4 },
  { value: 'BAR_LINE',       label: 'Bar + Line',     group: 'comparison', icon: Workflow },
  { value: 'WATERFALL',      label: 'Waterfall',      group: 'comparison', icon: Flame },
  { value: 'LINE',           label: 'Line',           group: 'trend', icon: LineChart },
  { value: 'AREA',           label: 'Area',           group: 'trend', icon: AreaChart },
  { value: 'TIME_SERIES',    label: 'Time Series',    group: 'trend', icon: TrendingUp },
  { value: 'RIBBON',         label: 'Ribbon',         group: 'trend', icon: Ribbon },
  { value: 'TIMELINE',       label: 'Timeline',       group: 'trend', icon: Timer },
  { value: 'PIE',            label: 'Pie',            group: 'composition', icon: PieChart },
  { value: 'DONUT',          label: 'Donut',          group: 'composition', icon: Donut },
  { value: 'POLAR_AREA',     label: 'Polar Area',     group: 'composition', icon: Radar },
  { value: 'TREEMAP',        label: 'Treemap',        group: 'composition', icon: Boxes },
  { value: 'FUNNEL',         label: 'Funnel',         group: 'composition', icon: GitBranch },
  { value: 'WORD_CLOUD',     label: 'Word Cloud',     group: 'composition', icon: Cloud },
  { value: 'SCATTER',        label: 'Scatter',        group: 'relationship', icon: ScatterChart },
  { value: 'BUBBLE',         label: 'Bubble',         group: 'relationship', icon: CircleDot },
  { value: 'NINE_BOX',       label: '9-Box Grid',     group: 'relationship', icon: LayoutGrid },
  { value: 'HEATMAP',        label: 'Heatmap',        group: 'relationship', icon: Table2 },
  { value: 'BOXPLOT',        label: 'Boxplot',        group: 'relationship', icon: Box },
  { value: 'RADAR',          label: 'Radar',          group: 'relationship', icon: Radar },
  { value: 'SANKEY',         label: 'Sankey',         group: 'relationship', icon: Network },
  { value: 'SUNBURST',       label: 'Sunburst',       group: 'relationship', icon: PieChart },
  { value: 'MAP_POINT',      label: 'Point Map',      group: 'geo', icon: MapPin },
  { value: 'MAP_REGION',     label: 'Region Map',     group: 'geo', icon: MapIcon },
];

const AGG_OPTIONS: { value: AggFn; label: string }[] = [
  { value: 'auto',           label: 'AS-IS' },
  { value: 'sum',            label: 'SUM' },
  { value: 'avg',            label: 'AVG' },
  { value: 'count',          label: 'COUNT' },
  { value: 'min',            label: 'MIN' },
  { value: 'max',            label: 'MAX' },
  { value: 'count_distinct', label: 'COUNT DISTINCT' },
];

const KPI_TEMPLATE_TOKENS = [
  '{value}',
  '{benchmark}',
  '{delta}',
  '{deltaPercent}',
  '{benchmarkLabel}',
  '{label}',
  '{rows}',
  '{rawValue}',
] as const;

const TABLE_SUMMARY_CALCULATION_OPTIONS: { value: TableSummaryCalculation; label: string }[] = [
  { value: 'sum', label: 'SUM' },
  { value: 'avg', label: 'AVG' },
  { value: 'count', label: 'COUNT' },
  { value: 'min', label: 'MIN' },
  { value: 'max', label: 'MAX' },
  { value: 'count_distinct', label: 'COUNT DISTINCT' },
];

const CONDITIONAL_OPERATOR_OPTIONS: Array<{ value: ConditionalFormatRule['operator']; label: string }> = [
  { value: '>', label: '>' },
  { value: '>=', label: '>=' },
  { value: '<', label: '<' },
  { value: '<=', label: '<=' },
  { value: '=', label: '=' },
  { value: '!=', label: '!=' },
];

const TABLE_HEATMAP_STEP_OPTIONS = [3, 4, 5, 6, 7];
const TABLE_COLUMN_ALIGNMENT_OPTIONS: Array<{ value: TableColumnAlignment; label: string }> = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
];
const COLOR_PRESET_SWATCHES = [
  '#eff6ff', '#dbeafe', '#bfdbfe', '#60a5fa', '#1d4ed8', '#172554',
  '#ecfeff', '#a7f3d0', '#34d399', '#15803d', '#14532d', '#064e3b',
  '#fef3c7', '#f59e0b', '#f97316', '#ea580c', '#ef4444', '#7f1d1d',
  '#fce7f3', '#ec4899', '#111827', '#475569', '#94a3b8', '#ffffff',
];

const KPI_GOAL_DIRECTION_OPTIONS: Array<{ value: KpiGoalDirection; label: string }> = [
  { value: 'up', label: 'Higher is better' },
  { value: 'down', label: 'Lower is better' },
];

type TableBenchmarkMode = 'value' | 'field' | 'percentile' | 'percentage';

function getTableBenchmarkMode(rule: ConditionalFormatRule): TableBenchmarkMode {
  if (rule.benchmarkType) return rule.benchmarkType;
  return rule.benchmarkField ? 'field' : 'value';
}

// Feature #4 — how a matched rule is presented.
const CF_MODE_OPTIONS: Array<{ value: NonNullable<ConditionalFormatRule['mode']>; label: string }> = [
  { value: 'color', label: 'Màu nền / chữ' },
  { value: 'dataBar', label: 'Thanh dữ liệu (Data bar)' },
  { value: 'icon', label: 'Biểu tượng (Icon)' },
];
// Feature #5 — benchmark type. Percentile/percentage are computed over the column.
const CF_BENCHMARK_OPTIONS: Array<{ value: TableBenchmarkMode; label: string }> = [
  { value: 'value', label: 'Giá trị cố định' },
  { value: 'field', label: 'Cột khác' },
  { value: 'percentile', label: 'Phân vị (Percentile)' },
  { value: 'percentage', label: '% của giá trị lớn nhất' },
];
const CF_ICON_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'up', label: '↑  Tăng' },
  { value: 'down', label: '↓  Giảm' },
  { value: 'flat', label: '—  Ổn định' },
  { value: 'check', label: '✓  Đạt' },
  { value: 'cross', label: '✕  Không đạt' },
  { value: 'warning', label: '⚠  Cảnh báo' },
  { value: 'flag', label: '⚑  Cờ' },
  { value: 'star', label: '★  Sao' },
  { value: 'dot', label: '●  Chấm' },
];

function createDefaultTableRule(displayedColumns: Col[], availableColumns: Col[]): ConditionalFormatRule {
  const numericDisplayed = displayedColumns.find(isNumeric);
  const numericFallback = availableColumns.find(isNumeric);
  const displayField = numericDisplayed?.name
    ?? displayedColumns[0]?.name
    ?? numericFallback?.name
    ?? availableColumns[0]?.name
    ?? '';
  return {
    field: displayField,
    operator: '>=',
    value: '',
    color: '#1f2937',
    backgroundColor: '#dbeafe',
    mode: 'color',
    benchmarkType: 'value',
  };
}

function createDefaultTableHeatmapRule(displayedColumns: Col[], availableColumns: Col[]): TableHeatmapRule {
  const numericDisplayed = displayedColumns.find(isNumeric);
  const numericFallback = availableColumns.find(isNumeric);
  return {
    field: numericDisplayed?.name ?? numericFallback?.name ?? availableColumns[0]?.name ?? '',
    steps: 5,
    minColor: '#eff6ff',
    maxColor: '#1d4ed8',
  };
}

function getDefaultSummaryLabelColumnName(displayedColumns: Col[], availableColumns: Col[]): string | undefined {
  return displayedColumns.find((column) => !isNumeric(column))?.name
    ?? availableColumns.find((column) => !isNumeric(column))?.name
    ?? displayedColumns[0]?.name
    ?? availableColumns[0]?.name;
}

function createDefaultTableSummaryRow(
  displayedColumns: Col[],
  availableColumns: Col[],
  label = 'Total',
): TableSummaryRowConfig {
  return {
    label,
    calculation: 'sum',
    labelColumn: getDefaultSummaryLabelColumnName(displayedColumns, availableColumns),
  };
}

function createTableHyperlinkRuleId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createDefaultTableHyperlinkRule(displayedColumns: Col[], availableColumns: Col[]): TableHyperlinkRule {
  const targetColumn = displayedColumns[0]?.name ?? availableColumns[0]?.name ?? '';
  const urlCandidate = availableColumns.find((column) => {
    const name = column.name.toLowerCase();
    return name.includes('url') || name.includes('link') || name.includes('href');
  });
  const urlColumn = urlCandidate?.name
    ?? availableColumns.find((column) => column.name !== targetColumn)?.name
    ?? targetColumn;

  return {
    id: createTableHyperlinkRuleId(),
    targetColumn,
    urlColumn,
    openInNewTab: true,
  };
}

function createDefaultKpiColorRule(index = 0): KpiValueColorRule {
  const presets = [
    { value: 0, color: '#16a34a', label: 'Positive' },
    { value: 0, color: '#dc2626', label: 'Negative' },
  ];
  const preset = presets[index] ?? presets[0];
  return {
    operator: index === 1 ? '<' : '>=',
    value: preset.value,
    color: preset.color,
    label: preset.label,
  };
}

function pruneTableColumnWidths(widths: Record<string, number>): Record<string, number> | undefined {
  const validWidths = Object.entries(widths)
    .filter(([, width]) => Number.isFinite(width) && width > 0)
    .map(([columnName, width]) => [columnName, Math.round(width)] as const);
  return validWidths.length > 0 ? Object.fromEntries(validWidths) : undefined;
}

function pruneTableColumnAlignments(
  alignments: Record<string, TableColumnAlignment>,
): Record<string, TableColumnAlignment> | undefined {
  const validAlignments = Object.entries(alignments)
    .filter((entry): entry is [string, TableColumnAlignment] => (
      entry[0].trim().length > 0
      && ['left', 'center', 'right'].includes(entry[1])
    ));
  return validAlignments.length > 0 ? Object.fromEntries(validAlignments) : undefined;
}

function pruneTableHyperlinkRules(rules: TableHyperlinkRule[]): TableHyperlinkRule[] | undefined {
  const validRules = rules
    .map((rule) => ({
      id: rule.id?.trim() || createTableHyperlinkRuleId(),
      targetColumn: rule.targetColumn?.trim() || '',
      urlColumn: rule.urlColumn?.trim() || undefined,
      // BUG-006 — preserve the URL template here too; this runs on EVERY edit
      // (setTableHyperlinkRules), so dropping it would stop a template rule
      // from ever persisting. Keeping the field (even empty) holds the rule in
      // "template mode" so it doesn't vanish while the DA is still typing.
      urlTemplate: typeof rule.urlTemplate === 'string' ? rule.urlTemplate : undefined,
      openInNewTab: rule.openInNewTab !== false,
    }))
    .filter((rule) => rule.targetColumn && (rule.urlColumn || typeof rule.urlTemplate === 'string'));
  return validRules.length > 0 ? validRules : undefined;
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Column helpers ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
type Col = {
  name: string;
  type: string;
  label?: string;
  fieldKind?: 'source' | 'calculated' | 'dimension' | 'measure' | 'date';
  sourceKind?: 'source' | 'calculated' | 'semantic' | 'custom';
  viewName?: string;
  viewLabel?: string;
  tableId?: number;
  tableLabel?: string;
};

function fieldBareName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : name;
}

function humanizeIdentifier(value: string): string {
  const text = value.replace(/[_-]+/g, ' ').trim();
  if (!text) return value;
  return text
    .split(/\s+/)
    .map((token) => {
      if (/^[A-Z0-9]{2,}$/.test(token)) return token;
      if (/^id$/i.test(token)) return 'ID';
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join(' ');
}

/** Display text for a Col option in pickers. Falls back to the raw name. */
function colLabel(c: Col): string {
  return (c.label && c.label.trim()) ? c.label : fieldBareName(c.name);
}

function fieldViewName(name: string): string | null {
  if (!name.includes('.')) return null;
  return name.split('.', 1)[0] || null;
}

function fieldSourceLabel(c: Col): string {
  const explicit = c.viewLabel || c.tableLabel;
  if (explicit?.trim()) return explicit.trim();
  const view = c.viewName || fieldViewName(c.name);
  if (view && !/^dataset_table_\d+$/i.test(view)) return humanizeIdentifier(view);
  if (c.sourceKind === 'custom') return 'SQL output';
  if (c.sourceKind === 'semantic') return 'Semantic model';
  return 'Current table';
}

function fieldTypeLabel(c: Col): string {
  const type = (c.type || 'field').trim();
  return type ? type.toUpperCase() : 'FIELD';
}

function fieldDisplayMeta(c: Col): { label: string; view: string | null; typeLabel: string } {
  return {
    label: colLabel(c),
    view: fieldViewName(c.name),
    typeLabel: fieldTypeLabel(c),
  };
}

function fieldSecondaryText(c: Col): string {
  const meta = fieldDisplayMeta(c);
  return `${meta.typeLabel} - ${fieldSourceLabel(c)}`;
}

function isDateType(c: Col): boolean {
  return ['date', 'datetime', 'timestamp', 'timestamptz', 'datetimetz', 'time'].includes(
    (c.type ?? '').toLowerCase(),
  );
}

function isNumeric(c: Col): boolean {
  return ['number', 'integer', 'float', 'double', 'decimal', 'bigint'].includes(
    (c.type ?? '').toLowerCase()
  );
}

function isTimelike(c: Col): boolean {
  const n = c.name.toLowerCase();
  return (
    ['date', 'datetime', 'timestamp', 'time'].includes((c.type ?? '').toLowerCase()) ||
    /(date|time|_at|created|updated|day|month|year|start|end|deadline)/.test(n)
  );
}

function isSourceField(c: Col): boolean {
  return c.sourceKind === 'source' || (!c.sourceKind && !c.fieldKind);
}

function isCalculatedField(c: Col): boolean {
  return c.sourceKind === 'calculated' || c.fieldKind === 'calculated';
}

function isMeasureField(c: Col): boolean {
  return c.fieldKind === 'measure';
}

function isDimensionField(c: Col): boolean {
  return c.fieldKind === 'dimension' || (!isMeasureField(c) && !isNumeric(c) && !isTimelike(c));
}

function fieldBadges(c: Col): Array<{ label: string; className: string }> {
  const badges: Array<{ label: string; className: string }> = [];
  if (isCalculatedField(c)) {
    badges.push({ label: 'Calculated', className: 'bg-brand/10 text-brand' });
  } else if (isSourceField(c)) {
    badges.push({ label: 'Source', className: 'bg-surface-2 text-text-tertiary' });
  }

  if (isMeasureField(c)) {
    badges.push({ label: 'Measure', className: 'bg-warning/10 text-warning' });
  } else if (c.fieldKind === 'date' || isTimelike(c)) {
    badges.push({ label: 'Date', className: 'bg-info/10 text-info' });
  } else if (isDimensionField(c)) {
    badges.push({ label: 'Dim', className: 'bg-success/10 text-success' });
  }

  if (badges.length === 0) {
    badges.push({ label: fieldTypeLabel(c), className: 'bg-surface-2 text-text-quaternary' });
  }
  return badges;
}

function isIdentifierLikeOption(c: Col): boolean {
  const bare = fieldBareName(c.name).toLowerCase();
  return (
    bare === 'id' ||
    bare === 'hid' ||
    bare === 'uuid' ||
    bare === 'guid' ||
    bare === 'token' ||
    bare === 'key' ||
    bare.endsWith('_id') ||
    /(^|_)(uuid|guid|token|hash|key)$/.test(bare)
  );
}

function preferredFieldRank(c: Col): number {
  if (isIdentifierLikeOption(c)) return 90;
  const bare = fieldBareName(c.name).toLowerCase();
  if (['name', 'display_name', 'title', 'type', 'status', 'category', 'email', 'owner', 'stage'].includes(bare)) return 0;
  if (isTimelike(c)) return 5;
  if (isNumeric(c)) return 10;
  return 20;
}

function compareFieldOptions(a: Col, b: Col): number {
  const rank = preferredFieldRank(a) - preferredFieldRank(b);
  if (rank !== 0) return rank;
  return colLabel(a).localeCompare(colLabel(b), undefined, { sensitivity: 'base' });
}

function normalizeColorInput(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    const chars = trimmed.slice(1).split('');
    return `#${chars.map((char) => `${char}${char}`).join('')}`.toLowerCase();
  }
  return fallback.toLowerCase();
}

function HelpTooltip({ text }: { text: string }) {
  return (
    <span className="group/help relative inline-flex items-center">
      <Info className="h-3.5 w-3.5 text-text-quaternary transition-colors group-hover/help:text-brand" />
      <span className="pointer-events-none absolute right-0 top-full z-20 mt-2 hidden w-56 rounded-md bg-surface-inverse px-2.5 py-2 text-[11px] font-normal normal-case tracking-normal text-white shadow-lg group-hover/help:block">
        {text}
      </span>
    </span>
  );
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Disclosure (collapsible section) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
/**
 * Phase-15.82 — Series colors editor extracted so it can keep its own
 * "show more / collapse" local state (the previous IIFE attempted to
 * stash it on styleConfig, which would have persisted UI state into the
 * saved chart — wrong layer).
 *
 * Also adds:
 *   - Defensive dedupe on key. The PIE adapter dedupes upstream, but
 *     defensive filtering protects against future callers passing raw
 *     pie slices (PowerBI / Superset both dedupe at this layer too).
 *   - Heads-up banner when every legend label looks like a raw ISO
 *     timestamp — strong signal DA mapped a datetime column to the
 *     legend dimension by mistake (the bug in the screenshot).
 *   - 12-row visible cap with "Show N more…" so a 50-slice pie doesn't
 *     produce a 50-row scrolling color editor.
 */
function SeriesColorsEditor({
  availableSeriesKeys,
  palette,
  seriesColors,
  onChange,
}: {
  availableSeriesKeys: { key: string; label: string }[];
  palette: string;
  seriesColors?: Record<string, string>;
  onChange: (next: Record<string, string> | undefined) => void;
}) {
  const VISIBLE_CAP = 12;
  const [expanded, setExpanded] = useState(false);

  // Dedupe by key so duplicate slice names from a fan-out join don't
  // render as separate rows with different colours.
  const uniqueSeries = useMemo(() => {
    const seen = new Set<string>();
    return availableSeriesKeys.filter(({ key }) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [availableSeriesKeys]);

  // ISO timestamps like "2025-08-01T00:00:00" or "2025-08-01 12:34" —
  // common when DA picks a datetime column for the PIE legend.
  const looksLikeRawTime = useMemo(() => {
    const isoTimestampRegex = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
    return uniqueSeries.length > 0 && uniqueSeries.every(({ label }) => isoTimestampRegex.test(label));
  }, [uniqueSeries]);

  const visible = expanded ? uniqueSeries : uniqueSeries.slice(0, VISIBLE_CAP);
  const hiddenCount = uniqueSeries.length - visible.length;
  const paletteColors = useMemo(
    () => CHART_PALETTES.find((p) => p.name === palette)?.colors ?? [],
    [palette],
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs font-semibold text-text-secondary">
          Series colors
          <span className="ml-1 text-[10px] font-normal text-text-quaternary">
            ({uniqueSeries.length})
          </span>
        </label>
      </div>
      {looksLikeRawTime && (
        <div className="mb-1.5 px-2 py-1 text-[10px] bg-warning/10 border border-warning/30 rounded text-warning">
          Series labels look like raw timestamps. Pick a categorical column for the legend, or set a time granularity in the Style tab.
        </div>
      )}
      <div className="space-y-1.5">
        {visible.map(({ key, label }, i) => {
          const current = seriesColors?.[key] ?? '';
          const fallback = paletteColors[i] || '#888';
          return (
            <div key={key} className="flex items-center gap-2">
              <span className="flex-1 truncate text-xs text-text-secondary" title={label}>
                {label}
              </span>
              <input
                type="color"
                value={current || fallback}
                onChange={(e) => onChange({ ...(seriesColors ?? {}), [key]: e.target.value })}
                className="h-7 w-10 cursor-pointer rounded border border-[rgb(var(--border-line))]"
              />
              {current && (
                <button
                  type="button"
                  onClick={() => {
                    const next = { ...(seriesColors ?? {}) };
                    delete next[key];
                    onChange(Object.keys(next).length === 0 ? undefined : next);
                  }}
                  className="text-xs text-text-tertiary hover:text-text-primary"
                  title="Reset to palette"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1.5 w-full px-2 py-1 text-[11px] border border-dashed border-[rgb(var(--border-line))] rounded text-text-secondary hover:bg-surface-2"
        >
          Show {hiddenCount} more…
        </button>
      )}
      {expanded && uniqueSeries.length > VISIBLE_CAP && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-1.5 w-full px-2 py-1 text-[11px] text-text-quaternary hover:text-text-tertiary"
        >
          Collapse
        </button>
      )}
    </div>
  );
}

/**
 * Display-only legend label editor. Raw series keys remain unchanged.
 */
function SeriesLabelsEditor({
  availableSeriesKeys,
  seriesLabels,
  onChange,
}: {
  availableSeriesKeys: { key: string; label: string }[];
  seriesLabels?: Record<string, string>;
  onChange: (next: Record<string, string> | undefined) => void;
}) {
  const VISIBLE_CAP = 12;
  const [expanded, setExpanded] = useState(false);

  const uniqueSeries = useMemo(() => {
    const seen = new Set<string>();
    return availableSeriesKeys.filter(({ key }) => {
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [availableSeriesKeys]);

  const visible = expanded ? uniqueSeries : uniqueSeries.slice(0, VISIBLE_CAP);
  const hiddenCount = uniqueSeries.length - visible.length;

  const setLabel = (key: string, value: string) => {
    const next = { ...(seriesLabels ?? {}) };
    const trimmed = value.trim();
    if (trimmed) next[key] = trimmed;
    else delete next[key];
    onChange(Object.keys(next).length > 0 ? next : undefined);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs font-semibold text-text-secondary">
          Legend labels
          <span className="ml-1 text-[10px] font-normal text-text-quaternary">
            ({uniqueSeries.length})
          </span>
        </label>
      </div>
      <div className="space-y-1.5">
        {visible.map(({ key, label }) => {
          const current = seriesLabels?.[key] ?? '';
          return (
            <div key={`series-label-${key}`} className="grid grid-cols-[minmax(0,1fr)_minmax(120px,1fr)_24px] items-center gap-2">
              <span className="min-w-0 truncate text-xs text-text-secondary" title={label}>
                {label}
              </span>
              <input
                type="text"
                value={current}
                onChange={(event) => setLabel(key, event.target.value)}
                placeholder={label}
                className="min-w-0 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs"
              />
              <button
                type="button"
                onClick={() => setLabel(key, '')}
                disabled={!current}
                className="h-7 w-6 rounded-md border border-[rgb(var(--border-line))] text-text-tertiary hover:border-[rgb(var(--border-strong))] hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
                title="Reset legend label"
              >
                <X className="mx-auto h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1.5 w-full rounded border border-dashed border-[rgb(var(--border-line))] px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-2"
        >
          Show {hiddenCount} more...
        </button>
      )}
      {expanded && uniqueSeries.length > VISIBLE_CAP && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-1.5 w-full px-2 py-1 text-[11px] text-text-quaternary hover:text-text-tertiary"
        >
          Collapse
        </button>
      )}
    </div>
  );
}

// Data-label editor: writes top-level DataLabelConfig or per-series overrides.
type ApplyTarget = '__all__' | string;
function DataLabelsEditor({
  styleConfig,
  availableSeriesKeys,
  updStyle,
  applicableForChart,
  chartType,
}: {
  styleConfig: ChartStyleConfig;
  availableSeriesKeys: { key: string; label: string }[];
  updStyle: (patch: Partial<ChartStyleConfig>) => void;
  applicableForChart: boolean;
  /** Phase-15.89 — needed so STACKED_BAR can surface its own
   *  segment-vs-total label mode toggle. */
  chartType?: string;
}) {
  const [target, setTarget] = useState<ApplyTarget>('__all__');
  const dlc: DataLabelConfig = styleConfig.dataLabelConfig ?? {};
  const enabled = dlc.enabled ?? styleConfig.showDataLabels ?? false;

  // Resolve effective DataLabelStyle for the currently-edited target,
  // walking override → chart-level → defaults. The editor writes back
  // ONLY the diff against chart-level so per-series rows stay sparse.
  const isAll = target === '__all__';
  const currentStyle: DataLabelStyle = isAll
    ? {
        position: dlc.position ?? 'top',
        rotation: dlc.rotation ?? 0,
        fontSize: dlc.fontSize,
        fontColor: dlc.fontColor,
        background: dlc.background,
        backgroundColor: dlc.backgroundColor,
        format: dlc.format,
      }
    : (dlc.overrides?.[target] ?? {});

  const patchConfig = (next: DataLabelConfig) => {
    // Keep legacy showDataLabels in sync so older code paths see the
    // master switch.
    updStyle({
      dataLabelConfig: next,
      showDataLabels: next.enabled ?? styleConfig.showDataLabels,
    });
  };
  const patchTarget = (patch: DataLabelStyle) => {
    if (isAll) {
      patchConfig({ ...dlc, ...patch });
      return;
    }
    const overrides = { ...(dlc.overrides ?? {}) };
    const merged: DataLabelStyle = { ...(overrides[target] ?? {}), ...patch };
    // Drop keys whose value matches the chart-level config — keeps the
    // override sparse so "reset" is the natural state.
    const cleaned: DataLabelStyle = {};
    (Object.keys(merged) as (keyof DataLabelStyle)[]).forEach((k) => {
      const v = merged[k];
      if (v !== undefined && v !== null && v !== '') cleaned[k] = v as never;
    });
    if (Object.keys(cleaned).length === 0) {
      delete overrides[target];
    } else {
      overrides[target] = cleaned;
    }
    patchConfig({ ...dlc, overrides: Object.keys(overrides).length === 0 ? undefined : overrides });
  };
  const resetTarget = () => {
    if (isAll) {
      patchConfig({ enabled: dlc.enabled });
    } else {
      const overrides = { ...(dlc.overrides ?? {}) };
      delete overrides[target];
      patchConfig({ ...dlc, overrides: Object.keys(overrides).length === 0 ? undefined : overrides });
    }
  };

  if (!applicableForChart) {
    return null;
  }

  return (
    <div className="space-y-3">
      <Toggle
        label="Enabled"
        checked={enabled}
        onChange={(v) => patchConfig({ ...dlc, enabled: v })}
      />
      {!enabled && (
        <p className="text-[10px] text-text-quaternary">
          Turn on to show numeric labels on each data point. Customise per series below once enabled.
        </p>
      )}
      {enabled && (
        <>
          {/* (i) Apply to */}
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">
              Apply settings to
            </label>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value as ApplyTarget)}
              className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1"
            >
              <option value="__all__">All series</option>
              {availableSeriesKeys.map(({ key, label }) => {
                const hasOverride = Boolean(dlc.overrides?.[key]);
                return (
                  <option key={key} value={key}>
                    {label}{hasOverride ? ' · customised' : ''}
                  </option>
                );
              })}
            </select>
            {!isAll && (
              <button
                type="button"
                onClick={resetTarget}
                className="mt-1 text-[10px] text-text-tertiary hover:text-text-primary underline-offset-2 hover:underline"
              >
                Reset to chart defaults
              </button>
            )}
          </div>

          {/* Phase-15.89 — STACKED_BAR-specific control. Lets DA pick
              between "show one number per segment", "one total above the
              stack", or both. The rest of the editor (position, font,
              colour) applies to whichever labels actually render. */}
          {chartType === 'STACKED_BAR' && (
            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1 block">
                Stack label mode
              </label>
              <div className="flex flex-wrap gap-1">
                {([
                  { value: 'segment', label: 'Per segment', desc: 'Show value inside each segment' },
                  { value: 'total', label: 'Stack total', desc: 'Show sum above the top of the stack' },
                  { value: 'both', label: 'Both', desc: 'Show segment values AND stack total' },
                ] as const).map((opt) => {
                  const active = (styleConfig.stackedBarLabelMode ?? 'both') === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => updStyle({ stackedBarLabelMode: opt.value })}
                      title={opt.desc}
                      className={`px-1.5 py-1 text-[11px] rounded border ${
                        active
                          ? 'bg-brand text-white border-brand'
                          : 'bg-surface-1 border-[rgb(var(--border-line))] hover:bg-surface-2'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-[10px] text-text-quaternary">
                Percent stacks (100%) always show segment values regardless of this setting.
              </p>
            </div>
          )}

          {/* (ii) Position + rotation + auto-hide */}
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">
              Position
            </label>
            <div className="flex flex-wrap gap-1">
              {(['top', 'bottom', 'inside', 'center', 'outside'] as DataLabelPosition[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => patchTarget({ position: p })}
                  className={`px-1.5 py-1 text-[11px] rounded border ${
                    (currentStyle.position ?? (isAll ? 'top' : undefined)) === p
                      ? 'bg-brand text-white border-brand'
                      : 'bg-surface-1 border-[rgb(var(--border-line))] hover:bg-surface-2'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
            <label className="text-xs font-semibold text-text-secondary mt-2 mb-1 block">
              Rotation
            </label>
            <div className="flex gap-1">
              {([0, -90, 90] as DataLabelRotation[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => patchTarget({ rotation: r })}
                  className={`px-2 py-1 text-[11px] rounded border ${
                    (currentStyle.rotation ?? 0) === r
                      ? 'bg-brand text-white border-brand'
                      : 'bg-surface-1 border-[rgb(var(--border-line))] hover:bg-surface-2'
                  }`}
                >
                  {r === 0 ? 'Horizontal' : r === 90 ? 'Vertical ↑' : 'Vertical ↓'}
                </button>
              ))}
            </div>
            {isAll && (
              <div className="mt-2">
                <Toggle
                  label="Auto-hide overlapping labels"
                  checked={dlc.autoHideOverlap ?? true}
                  onChange={(v) => patchConfig({ ...dlc, autoHideOverlap: v })}
                />
                <p className="text-[10px] text-text-quaternary mt-1">
                  Drops labels whose bounding box intersects an earlier one in the same chart frame.
                </p>
              </div>
            )}
          </div>

          {/* (iii) Font + color + background */}
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">
              Font & background
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={8}
                max={32}
                placeholder="size"
                value={currentStyle.fontSize ?? ''}
                onChange={(e) => patchTarget({ fontSize: e.target.value === '' ? undefined : Number(e.target.value) })}
                className="w-16 px-1.5 py-1 text-[11px] border border-[rgb(var(--border-line))] rounded bg-surface-1"
              />
              <input
                type="color"
                value={currentStyle.fontColor ?? '#1a1a1a'}
                onChange={(e) => patchTarget({ fontColor: e.target.value })}
                className="h-7 w-10 cursor-pointer rounded border border-[rgb(var(--border-line))]"
                title="Text color"
              />
              <span className="text-[11px] text-text-tertiary flex-1">Text</span>
            </div>
            <div className="flex items-center gap-2 mt-1.5">
              <input
                type="checkbox"
                checked={currentStyle.background ?? false}
                onChange={(e) => patchTarget({ background: e.target.checked })}
                className="h-3.5 w-3.5"
              />
              <input
                type="color"
                value={currentStyle.backgroundColor ?? '#ffffff'}
                onChange={(e) => patchTarget({ backgroundColor: e.target.value, background: true })}
                className="h-7 w-10 cursor-pointer rounded border border-[rgb(var(--border-line))]"
                title="Background color"
              />
              <span className="text-[11px] text-text-tertiary flex-1">Background chip</span>
            </div>
            <p className="text-[10px] text-text-quaternary mt-1">
              Background helps readability on dark themes / cluttered charts.
            </p>
          </div>

          {/* (iv) Value format — Phase-15.91. Surfaces DataLabelStyle.format
              that was already declared in the type and read by the renderer
              (resolveDataLabelStyle line ~446) but never had a UI control.
              Per PBI: Data labels panel owns its OWN display-units pick,
              independent of the chart's global Number Format. Falls back
              to chart-level numberFormat / per-series seriesFormats when
              left at "(inherit)". */}
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">
              Value format
            </label>
            <select
              value={currentStyle.format ?? ''}
              onChange={(e) => patchTarget({ format: e.target.value === '' ? undefined : (e.target.value as NumberFormat) })}
              className="w-full px-2 py-1 text-[11px] border border-[rgb(var(--border-line))] rounded bg-surface-1"
            >
              <option value="">(inherit chart Number Format)</option>
              <option value="auto">Auto (raw)</option>
              <option value="compact">Compact (1.2K, 3.4M)</option>
              <option value="number">Full Number (1,234)</option>
              <option value="percent">Percent (%)</option>
              <option value="currency">Currency ($)</option>
            </select>
            <p className="text-[10px] text-text-quaternary mt-1">
              Overrides display units for the data label only. Tooltip / axis stay on the chart-level Number Format.
            </p>
          </div>

          {/* (v) Template — Phase-15.91. Moved here from a separate
              Disclosure so all data-label controls live in ONE panel
              (PowerBI parity). Template is a CHART-WIDE setting — only
              editable when "Apply settings to" is "All series". */}
          {isAll && (
            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1 block">
                Template
              </label>
              <input
                type="text"
                value={styleConfig.dataLabelTemplate ?? ''}
                placeholder="{label}: {value}"
                onChange={(e) => updStyle({ dataLabelTemplate: e.target.value || undefined })}
                className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1 font-mono"
              />
              <p className="text-[10px] text-text-quaternary mt-1">
                Tokens: {'{value}'} {'{label}'} {'{series}'} {'{dimension}'} {'{percent}'}. Blank uses the chart's default label.
              </p>
            </div>
          )}

          {/* Phase-15.90 — STACKED_BAR-only: tách Segment vs Total color.
              Reason: segment labels sit ON a coloured bar (need contrast,
              usually white); total labels sit ON the chart background
              (need a dark colour). One shared `fontColor` couldn't serve
              both — picking black made segments invisible on dark bars
              while picking white made the total invisible on the chart
              bg. Two independent setting groups solve it. */}
          {chartType === 'STACKED_BAR' && isAll && (() => {
            const mode = styleConfig.stackedBarLabelMode ?? 'both';
            const showSeg = mode === 'segment' || mode === 'both';
            const showTot = mode === 'total' || mode === 'both';
            const seg = dlc.segmentStyle ?? {};
            const tot = dlc.totalStyle ?? {};
            const patchSegment = (patch: DataLabelStyle) => {
              const next = { ...seg, ...patch };
              // Drop keys that match the chart-level defaults so the
              // override stays sparse and "reset" is the natural state.
              const cleaned: DataLabelStyle = {};
              (Object.keys(next) as (keyof DataLabelStyle)[]).forEach((k) => {
                const v = next[k];
                if (v !== undefined && v !== null && v !== '') cleaned[k] = v as never;
              });
              patchConfig({
                ...dlc,
                segmentStyle: Object.keys(cleaned).length === 0 ? undefined : cleaned,
              });
            };
            const patchTotal = (patch: DataLabelStyle) => {
              const next = { ...tot, ...patch };
              const cleaned: DataLabelStyle = {};
              (Object.keys(next) as (keyof DataLabelStyle)[]).forEach((k) => {
                const v = next[k];
                if (v !== undefined && v !== null && v !== '') cleaned[k] = v as never;
              });
              patchConfig({
                ...dlc,
                totalStyle: Object.keys(cleaned).length === 0 ? undefined : cleaned,
              });
            };
            return (
              <div className="mt-3 pt-2 border-t border-[rgb(var(--border-line))]">
                <label className="text-xs font-semibold text-text-secondary mb-1.5 block">
                  Stacked Bar — separate colors
                </label>
                <p className="text-[10px] text-text-quaternary mb-2">
                  Segment labels (inside bars) and Stack total labels (above bars)
                  each get their own colour. Leave blank to inherit the Font &amp;
                  background above.
                </p>
                {showSeg && (
                  <div className="rounded border border-[rgb(var(--border-line))] p-2 mb-1.5">
                    <div className="text-[11px] font-semibold text-text-secondary mb-1.5">
                      Segment label (inside coloured bar)
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={seg.fontColor ?? '#ffffff'}
                        onChange={(e) => patchSegment({ fontColor: e.target.value })}
                        className="h-7 w-10 cursor-pointer rounded border border-[rgb(var(--border-line))]"
                        title="Segment text color"
                      />
                      <span className="text-[11px] text-text-tertiary flex-1">Text</span>
                      <button
                        type="button"
                        onClick={() => patchSegment({ fontColor: undefined })}
                        className="text-[10px] text-text-quaternary hover:text-text-tertiary underline-offset-2 hover:underline"
                        title="Reset to chart-level Font & background"
                      >
                        reset
                      </button>
                    </div>
                    <div className="flex items-center gap-2 mt-1.5">
                      <input
                        type="checkbox"
                        checked={seg.background ?? false}
                        onChange={(e) => patchSegment({ background: e.target.checked })}
                        className="h-3.5 w-3.5"
                      />
                      <input
                        type="color"
                        value={seg.backgroundColor ?? '#000000'}
                        onChange={(e) => patchSegment({ backgroundColor: e.target.value, background: true })}
                        className="h-7 w-10 cursor-pointer rounded border border-[rgb(var(--border-line))]"
                        title="Segment background color"
                      />
                      <span className="text-[11px] text-text-tertiary flex-1">Background chip</span>
                    </div>
                  </div>
                )}
                {showTot && (
                  <div className="rounded border border-[rgb(var(--border-line))] p-2">
                    <div className="text-[11px] font-semibold text-text-secondary mb-1.5">
                      Stack total label (above bar)
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={tot.fontColor ?? '#1a1a1a'}
                        onChange={(e) => patchTotal({ fontColor: e.target.value })}
                        className="h-7 w-10 cursor-pointer rounded border border-[rgb(var(--border-line))]"
                        title="Total text color"
                      />
                      <span className="text-[11px] text-text-tertiary flex-1">Text</span>
                      <button
                        type="button"
                        onClick={() => patchTotal({ fontColor: undefined })}
                        className="text-[10px] text-text-quaternary hover:text-text-tertiary underline-offset-2 hover:underline"
                        title="Reset to chart-level Font & background"
                      >
                        reset
                      </button>
                    </div>
                    <div className="flex items-center gap-2 mt-1.5">
                      <input
                        type="checkbox"
                        checked={tot.background ?? false}
                        onChange={(e) => patchTotal({ background: e.target.checked })}
                        className="h-3.5 w-3.5"
                      />
                      <input
                        type="color"
                        value={tot.backgroundColor ?? '#ffffff'}
                        onChange={(e) => patchTotal({ backgroundColor: e.target.value, background: true })}
                        className="h-7 w-10 cursor-pointer rounded border border-[rgb(var(--border-line))]"
                        title="Total background color"
                      />
                      <span className="text-[11px] text-text-tertiary flex-1">Background chip</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}

function Disclosure({ title, hint, defaultOpen = false, children, forceOpen, hidden }: {
  title: string; hint?: string; defaultOpen?: boolean; children: React.ReactNode;
  /** Phase-15.92 — when set, parent (eg. search filter) overrides local open state. */
  forceOpen?: boolean;
  /** Phase-15.92 — hide entirely when filtered out by search. */
  hidden?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (hidden) return null;
  const isOpen = forceOpen ?? open;
  return (
    <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2/70 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="group flex w-full items-center justify-between py-1"
      >
        <span className="flex items-center gap-1.5 text-xs font-semibold text-text-tertiary uppercase tracking-wide">
          <span>{title}</span>
          {hint && <HelpTooltip text={hint} />}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 text-text-quaternary transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && <div className="mt-3 space-y-3 border-t border-[rgb(var(--border-line))] pt-3">{children}</div>}
    </div>
  );
}

/**
 * Phase-15.92 — FormatGroup: PowerBI-style group header that wraps a set
 * of related Disclosures (sections). Each group shows:
 *
 *   - A coloured dot indicator (⚫ active / ⚪ default) telling DA at a
 *     glance whether anything in this group has been customised.
 *   - A collapse caret so DA can fold whole groups.
 *
 * Search integration: when `matchesSearch=false`, the group hides
 * entirely. When `matchesSearch=true` AND `searchActive=true`, the
 * group force-opens so matched sections inside are visible without an
 * extra click.
 */
function FormatGroup({
  title,
  hasCustomization,
  defaultOpen = true,
  matchesSearch = true,
  searchActive = false,
  children,
}: {
  title: string;
  /** Show brand dot when any setting in this group differs from defaults. */
  hasCustomization: boolean;
  defaultOpen?: boolean;
  /** False = hide group entirely (filtered out by search). */
  matchesSearch?: boolean;
  /** Indicates the user has typed in the search box — force-open matching groups. */
  searchActive?: boolean;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(defaultOpen);
  if (!matchesSearch) return null;
  const isOpen = searchActive ? true : open;
  // Style parity with Disclosure (line ~2050) — same border, surface,
  // radius, typography. Difference: FormatGroup uses text-text-secondary
  // (vs text-tertiary) because it's a level above Disclosure in the
  // hierarchy, plus a brand dot to signal customisation at-a-glance.
  return (
    <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2/70 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={searchActive}
        className="group flex w-full items-center justify-between py-1 disabled:cursor-default"
      >
        <span className="flex items-center gap-2 text-xs font-semibold text-text-secondary uppercase tracking-wide">
          <span
            className={`h-1.5 w-1.5 rounded-full transition-colors ${
              hasCustomization ? 'bg-brand' : 'bg-text-quaternary/40'
            }`}
            title={hasCustomization ? t('explore.config.hasCustomSettings') : t('explore.config.defaultSettings')}
          />
          <span>{title}</span>
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-text-quaternary transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>
      {isOpen && (
        <div className="mt-3 space-y-3 border-t border-[rgb(var(--border-line))] pt-3">
          {children}
        </div>
      )}
    </div>
  );
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Toggle switch ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
function Toggle({ label, checked, onChange, description }: { label: string; checked: boolean; onChange: (v: boolean) => void; description?: string }) {
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 transition-colors ${
        checked ? 'border-brand/30 bg-brand/10/80' : 'border-[rgb(var(--border-line))] bg-surface-1'
      }`}
    >
      <div className="min-w-0">
        <div className={`text-xs font-semibold ${checked ? 'text-brand' : 'text-text-secondary'}`}>{label}</div>
        {description ? (
          <div className="text-[11px] leading-4 text-text-quaternary">{description}</div>
        ) : (
          <div className={`text-[11px] ${checked ? 'text-brand' : 'text-text-quaternary'}`}>
            {checked ? 'Enabled' : 'Disabled'}
          </div>
        )}
      </div>
      <button
        type="button"
        aria-pressed={checked}
        aria-label={`${checked ? 'Disable' : 'Enable'} ${label}`}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-10 rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-brand ${
          checked ? 'border-brand bg-brand' : 'border-[rgb(var(--border-strong))] bg-surface-3'
        }`}
      >
        <span
          className={`absolute top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        >
          {checked && <Check className="h-2.5 w-2.5 text-brand" />}
        </span>
      </button>
    </div>
  );
}

function SectionPanel({
  step,
  title,
  description,
  children,
}: {
  step: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
      <div className="border-b border-[rgb(var(--border-line))] px-4 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">{step}</p>
        <div className="mt-1 flex items-center gap-1">
          <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
          {description && <HelpTooltip text={description} />}
        </div>
      </div>
      <div className="space-y-3 px-4 py-4">
        {children}
      </div>
    </section>
  );
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ SelectSlot ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
/**
 * Phase-15.10/15.11: shared chart-config context for every FieldPicker
 * rendered inside the same ExploreChartConfig tree.
 *
 * - `baseViewName` lets pickers tag cross-table fields with a JOIN cue.
 * - `joinKeyRefs` lets pickers hide PK/FK columns by default (they exist
 *   for relationship wiring, not for charting). A "Show JOIN keys" toggle
 *   in each picker opens the escape hatch when power users need them.
 *
 * Held in context (vs. prop-drilling) because there are ~50 picker call
 * sites and threading two more props through every SelectSlot/MetricSlot
 * would be pure line-noise.
 */
const FieldPickerContext = createContext<{
  baseViewName: string | null;
  joinKeyRefs: Set<string>;
}>({ baseViewName: null, joinKeyRefs: new Set() });

/**
 * Phase-15.11 — FieldPicker rewrite.
 *
 * Old design used 10 quick-filter chips (Suggested / Same view / Source /
 * Calculated / Measures / Dimensions / Numeric / Dates / IDs / All). DA
 * feedback: too many overlapping classifications and the "Source" chip
 * collided with the top-bar "Source" selector concept. With Phase 15.10
 * dropping the base-table picker, the natural grouping is now BY TABLE
 * (semantic view) — same shape as PowerBI / Looker Fields panes.
 *
 * Behaviour:
 *   - Search bar at top stays
 *   - "Show JOIN keys" toggle at top-right exposes PK/FK columns that are
 *     normally hidden (they're for relationship wiring, not charting)
 *   - Body is grouped by view, with a sticky header per group showing
 *     "View name · (count)" and a collapse caret
 *   - Each group sorted: dimensions first, measures last, alphabetical
 *     within each
 *   - Base view (from context) renders first; remaining views alphabetical
 *   - When user has a query, every matching group auto-expands so search
 *     surfaces hits without manual unfolding
 */

/** Human-readable field ref for tooltips: "<table display name>.<column>" —
 * never the raw "dataset_table_401.activity_group" key the user didn't choose. */
function humanFieldRef(c: Col): string {
  const view = c.viewName || fieldViewName(c.name) || '';
  const label = (c.viewLabel || c.tableLabel || '').trim()
    || (view && !/^dataset_table_\d+$/i.test(view) ? humanizeIdentifier(view) : view);
  const bare = c.name.includes('.') ? c.name.split('.').slice(1).join('.') : c.name;
  return label ? `${label}.${bare}` : c.name;
}

function FieldPicker({
  value = '',
  options,
  placeholder,
  emptyLabel = 'No matching fields',
  disabled,
  invalid,
  onSelect,
  onClear,
}: {
  value?: string;
  options: Col[];
  placeholder: string;
  emptyLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  onSelect: (v: string) => void;
  onClear?: () => void;
}) {
  const { baseViewName, joinKeyRefs } = useContext(FieldPickerContext);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showKeys, setShowKeys] = useState(false);
  const [collapsedViews, setCollapsedViews] = useState<Set<string>>(() => new Set());
  const containerRef = useRef<HTMLDivElement | null>(null);
  const selected = value ? options.find((option) => option.name === value) : undefined;
  const selectedMeta = selected ? fieldDisplayMeta(selected) : null;
  const q = query.trim().toLowerCase();

  // Determine which options carry a JOIN-key signal. We hide them by
  // default — DA never wants `customer_id` on the chart axis. Power users
  // can flip "Show JOIN keys" to see them.
  const isJoinKey = useCallback((option: Col): boolean => {
    if (!joinKeyRefs || joinKeyRefs.size === 0) return false;
    if (joinKeyRefs.has(option.name)) return true;
    // Also tolerate bare names from raw preview columns: if the option has
    // a viewName (or qualified prefix), check `view.bare`.
    const v = option.viewName || fieldViewName(option.name);
    if (v) {
      const bare = option.name.includes('.') ? option.name.split('.').slice(1).join('.') : option.name;
      if (joinKeyRefs.has(`${v}.${bare}`)) return true;
    }
    return false;
  }, [joinKeyRefs]);

  // Group options by their owning view. Calculated / SQL-output / raw
  // columns without a resolvable view fall into a synthetic "Other"
  // bucket so they remain pickable. Hidden join-key columns are filtered
  // upstream of the grouping unless `showKeys` is on.
  const groups = useMemo(() => {
    const buckets = new Map<string, { viewName: string; viewLabel: string; options: Col[] }>();
    for (const option of options) {
      if (!showKeys && isJoinKey(option)) continue;
      const viewName = option.viewName || fieldViewName(option.name) || '__other__';
      const viewLabel = (() => {
        if (viewName === '__other__') {
          if (option.sourceKind === 'custom' || option.viewLabel === 'SQL output') return 'SQL output';
          if (option.sourceKind === 'calculated') return 'Calculated';
          return 'Other';
        }
        const explicit = option.viewLabel || option.tableLabel;
        if (explicit?.trim()) return explicit.trim();
        if (!/^dataset_table_\d+$/i.test(viewName)) return humanizeIdentifier(viewName);
        return viewName;
      })();
      let bucket = buckets.get(viewName);
      if (!bucket) {
        bucket = { viewName, viewLabel, options: [] };
        buckets.set(viewName, bucket);
      }
      bucket.options.push(option);
    }
    // Sort within each bucket: dimensions/non-measure first, measures last,
    // alphabetical by label inside each segment.
    for (const bucket of buckets.values()) {
      bucket.options.sort((a, b) => {
        const aMeas = isMeasureField(a) ? 1 : 0;
        const bMeas = isMeasureField(b) ? 1 : 0;
        if (aMeas !== bMeas) return aMeas - bMeas;
        return colLabel(a).localeCompare(colLabel(b));
      });
    }
    // Order groups: base view first, then alphabetical by label.
    const out = Array.from(buckets.values());
    out.sort((a, b) => {
      const aBase = baseViewName && a.viewName === baseViewName ? 0 : 1;
      const bBase = baseViewName && b.viewName === baseViewName ? 0 : 1;
      if (aBase !== bBase) return aBase - bBase;
      return a.viewLabel.localeCompare(b.viewLabel);
    });
    return out;
  }, [options, baseViewName, showKeys, isJoinKey]);

  // Apply the search query AFTER grouping so each group keeps its identity
  // (count, header) even when filtered. Empty groups drop out.
  const filteredGroups = useMemo(() => {
    if (!q) return groups;
    const out: typeof groups = [];
    for (const group of groups) {
      const matches = group.options.filter((option) => {
        const meta = fieldDisplayMeta(option);
        const badges = fieldBadges(option).map((b) => b.label).join(' ');
        return `${meta.label} ${option.name} ${option.type} ${meta.view ?? ''} ${fieldSourceLabel(option)} ${badges}`.toLowerCase().includes(q);
      });
      if (matches.length > 0) {
        out.push({ ...group, options: matches });
      }
    }
    return out;
  }, [groups, q]);

  const totalCount = filteredGroups.reduce((sum, g) => sum + g.options.length, 0);

  // Auto-expand all groups while a query is active so search hits are
  // visible without manual unfolding. Manual collapse state only applies
  // when no query.
  const isCollapsed = (viewName: string) => !q && collapsedViews.has(viewName);
  const toggleGroup = (viewName: string) => {
    setCollapsedViews((prev) => {
      const next = new Set(prev);
      if (next.has(viewName)) next.delete(viewName);
      else next.add(viewName);
      return next;
    });
  };

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setOpen((current) => !current);
          setQuery('');
        }}
        className={`flex min-h-[2.35rem] w-full items-center justify-between gap-2 rounded-md border bg-surface-1 px-2.5 py-1.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          invalid
            ? 'border-danger/40 bg-danger/10 text-danger'
            : open
              ? 'border-brand/50 ring-1 ring-brand/30'
              : 'border-[rgb(var(--border-strong))] hover:bg-surface-2'
        }`}
        title={selected ? humanFieldRef(selected) : undefined}
      >
        <span className="min-w-0 flex-1">
          <span className={`block truncate font-medium ${selected ? 'text-text-secondary' : 'text-text-quaternary'}`}>
            {selectedMeta?.label ?? placeholder}
          </span>
          {selected && (
            <span className="mt-0.5 block truncate text-[10px] text-text-quaternary">
              {fieldSecondaryText(selected)}
            </span>
          )}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-text-quaternary transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-lg">
          <div className="border-b border-[rgb(var(--border-line))] p-2">
            <div className="flex items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search fields..."
                className="min-w-0 flex-1 bg-transparent text-xs text-text-secondary outline-none placeholder:text-text-quaternary"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="rounded p-0.5 text-text-quaternary hover:bg-surface-3 hover:text-text-secondary"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <div className="mt-2 flex items-center justify-between text-[10px] text-text-quaternary">
              <span className="font-semibold uppercase tracking-wide">
                {q ? `${totalCount} match${totalCount === 1 ? '' : 'es'}` : `${filteredGroups.length} table${filteredGroups.length === 1 ? '' : 's'} · ${totalCount} field${totalCount === 1 ? '' : 's'}`}
              </span>
              {joinKeyRefs && joinKeyRefs.size > 0 && (
                <label
                  className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-surface-2"
                  title="JOIN-key columns (PK/FK) are hidden by default — they exist for relationship wiring, not for charting."
                >
                  <input
                    type="checkbox"
                    checked={showKeys}
                    onChange={(e) => setShowKeys(e.target.checked)}
                    className="h-3 w-3 accent-brand"
                  />
                  Show JOIN keys
                </label>
              )}
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto py-1">
            {onClear && value && (
              <button
                type="button"
                onClick={() => {
                  onClear();
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs text-text-tertiary hover:bg-surface-2 hover:text-text-secondary"
              >
                <span>Clear selection</span>
              </button>
            )}
            {filteredGroups.length === 0 ? (
              <div className="px-3 py-5 text-center text-xs italic text-text-quaternary">
                {emptyLabel}
              </div>
            ) : (
              filteredGroups.map((group) => {
                const collapsed = isCollapsed(group.viewName);
                return (
                  <div key={group.viewName} className="border-b border-[rgb(var(--border-line))] last:border-b-0">
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.viewName)}
                      className="sticky top-0 z-10 flex w-full items-center justify-between gap-2 bg-surface-2 px-3 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-text-tertiary hover:bg-surface-3"
                    >
                      <span className="inline-flex items-center gap-1.5 truncate">
                        <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
                        <span className="truncate normal-case tracking-normal">{group.viewLabel}</span>
                        {baseViewName && group.viewName === baseViewName && (
                          <span className="rounded-full bg-brand/10 px-1.5 py-0.5 text-[9px] font-medium text-brand">base</span>
                        )}
                      </span>
                      <span className="text-text-quaternary">{group.options.length}</span>
                    </button>
                    {!collapsed && group.options.map((option) => {
                      const meta = fieldDisplayMeta(option);
                      const active = option.name === value;
                      const badges = fieldBadges(option);
                      const optionViewName = option.viewName || fieldViewName(option.name);
                      const isCrossTable = Boolean(
                        baseViewName
                        && optionViewName
                        && optionViewName !== baseViewName
                      );
                      return (
                        <button
                          key={option.name}
                          type="button"
                          onClick={() => {
                            onSelect(option.name);
                            setOpen(false);
                          }}
                          className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                            active ? 'bg-brand/10' : 'hover:bg-surface-2'
                          }`}
                          title={`${group.viewLabel}.${option.name.includes('.') ? option.name.split('.').slice(1).join('.') : option.name}`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className={`block truncate text-xs font-medium ${active ? 'text-brand' : 'text-text-secondary'}`}>
                              {meta.label}
                            </span>
                            <span className="mt-0.5 block truncate text-[10px] text-text-quaternary">
                              {fieldTypeLabel(option)}
                            </span>
                          </span>
                          <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                            {isCrossTable && (
                              <span
                                className="inline-flex items-center gap-0.5 rounded-full bg-info/10 px-1.5 py-0.5 text-[10px] font-medium text-info"
                                title={`Cross-table: pick to join ${optionViewName} to base ${baseViewName} through a relationship.`}
                              >
                                JOIN
                              </span>
                            )}
                            {badges.map((badge) => (
                              <span
                                key={badge.label}
                                className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}
                              >
                                {badge.label}
                              </span>
                            ))}
                          </span>
                          {active && <Check className="h-3.5 w-3.5 shrink-0 text-brand" />}
                        </button>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SelectSlot({
  label, required, hint, value, options, placeholder = 'none', onChange,
}: {
  label: string; required?: boolean; hint?: string; value: string;
  options: Col[]; placeholder?: string; onChange: (v: string) => void;
}) {
  const missing = required && !value;
  return (
    <div>
      <label className="flex items-center gap-1 text-xs font-semibold text-text-secondary mb-1">
        {label}
        {required && <span className="text-danger">*</span>}
        {hint && <HelpTooltip text={hint} />}
      </label>
      <FieldPicker
        value={value}
        options={options}
        placeholder={placeholder}
        invalid={missing}
        onSelect={onChange}
        onClear={() => onChange('')}
      />
    </div>
  );
}

/**
 * BUBBLE axis aggregation. The scatter X / Y axes are stored as plain field
 * refs (`scatterX` / `scatterY`); for BUBBLE the BE aggregates them per the
 * Label dimension (one bubble per label). This compact select lets DA pick
 * SUM / AVG / … for that aggregation — mirrors the Size metric's agg dropdown.
 * 'auto' (AS-IS) is omitted: it only makes sense for a declared measure, and
 * a raw numeric axis has nothing to "use as-is".
 */
function ScatterAxisAgg({
  axis, value, onChange,
}: {
  axis: 'X' | 'Y'; value: AggFn; onChange: (v: AggFn) => void;
}) {
  return (
    <div className="-mt-1.5 flex items-center gap-2 pl-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
        {axis} aggregation
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as AggFn)}
        className="rounded border border-[rgb(var(--border-strong))] bg-surface-1 px-1.5 py-0.5 text-[11px] font-bold text-brand outline-none cursor-pointer"
        title={`How the ${axis} axis aggregates within each Label (bubble).`}
      >
        {AGG_OPTIONS.filter((a) => a.value !== 'auto').map((a) => (
          <option key={a.value} value={a.value}>{a.label}</option>
        ))}
      </select>
    </div>
  );
}

/**
 * Shown in place of {@link ScatterAxisAgg} when the bound axis is a declared
 * MEASURE. Power BI / Looker / Tableau never let you re-aggregate a measure
 * inline — it carries the aggregation defined in the model. We surface a Σ
 * marker + read-only note so DA coming from Power BI sees the same contract
 * (instead of a SUM/AVG dropdown that the BE would silently ignore — BUG-016).
 */
function AxisMeasureAggHint({ axis }: { axis: 'X' | 'Y' }) {
  return (
    <div
      className="-mt-1.5 flex items-center gap-1.5 pl-0.5"
      title="Trục này là Measure — gộp theo aggregation đã định nghĩa trong Data Model, không re-aggregate tại đây (giống Power BI / Looker)."
    >
      <span className="text-[11px] font-bold text-warning leading-none">Σ</span>
      <span className="text-[10px] text-text-tertiary">{axis}: aggregation theo Data Model (measure)</span>
    </div>
  );
}

/**
 * Phase-15.1: drill-down action. When the chart's current dimension has
 * children declared via DimensionDefinition.parent (Phase-13.1 hierarchy
 * metadata), render compact buttons "↓ <child label>". Click swaps the
 * chart's dimension to the child. Multiple children = multiple buttons.
 *
 * Pure FE: BE doesn't know about drill — it just runs the new query with
 * the swapped dim. Preserves Phase-1 "2 cơ chế" — no new calculation,
 * just navigation.
 */
function DrillDownButtons({
  currentDim,
  childrenMap,
  onDrill,
}: {
  currentDim: string | undefined;
  childrenMap: Map<string, string[]> | undefined;
  onDrill: (childField: string) => void;
}) {
  if (!currentDim || !childrenMap) return null;
  const children = childrenMap.get(currentDim);
  if (!children || children.length === 0) return null;
  return (
    <div className="-mt-1 flex flex-wrap items-center gap-1">
      <span className="text-[10px] text-text-quaternary">Drill into:</span>
      {children.map((child) => {
        // Display the child's bare segment (after the last dot) for compactness.
        const bare = child.split('.').slice(-1)[0] ?? child;
        return (
          <button
            key={child}
            onClick={() => onDrill(child)}
            className="rounded-md border border-brand/30 bg-brand/10 px-1.5 py-0.5 text-[10px] font-emphasis text-brand hover:bg-brand/20"
            title={`Switch the chart dimension to "${child}" and rerun the query.`}
          >
            ↓ {bare}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Phase-13.4: time grain picker shown next to a time-field SelectSlot.
 * Lets the user request server-side bucketing (date_trunc per dialect)
 * so chart points group by day/week/month/quarter/year instead of by
 * raw timestamp. Renders nothing when no time field is picked yet —
 * the grain only makes sense once we know which field to bucket.
 *
 * State lives in ChartRoleConfig.timeGrains[fieldName]. `none` removes
 * the entry so legacy charts that never used grains stay byte-identical.
 */
function TimeGrainSlot({
  fieldName,
  value,
  onChange,
}: {
  fieldName: string | undefined;
  value: TimeGrain | undefined;
  onChange: (next: TimeGrain | undefined) => void;
}) {
  if (!fieldName) return null;
  // Phase-15.20: shrink the config slot to a single Date-hierarchy toggle
  // (PowerBI-style). Picking the actual drill level (Year / Quarter /
  // Month / Week / Day) moved to the chart preview header where DA can
  // ↑↓ between levels at view time — that's where the action belongs in
  // a BI tool. Config just says "is the hierarchy enabled on this chart
  // or not?". Default level on enable = 'month'.
  const enabled = value !== undefined;
  return (
    <div className="flex items-center justify-between rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2">
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="truncate text-xs font-semibold text-text-secondary">
          Date hierarchy
        </span>
        <HelpTooltip text="Enable date hierarchy to bucket this chart by Year, Quarter, Month, Week, or Day. Drill controls appear in the chart preview header. Disable it to keep raw timestamps. New date hierarchies default to Month, similar to Power BI auto-bucketing when a date field is added." />
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => onChange(enabled ? undefined : 'month')}
        className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors ${
          enabled
            ? 'border-brand bg-brand/80'
            : 'border-[rgb(var(--border-line))] bg-surface-2'
        }`}
        title={enabled ? 'Date hierarchy on: the chart is bucketed by the level selected in the preview header.' : 'Date hierarchy off: render raw timestamps.'}
      >
        <span
          className={`inline-block h-3 w-3 rounded-full bg-surface-1 shadow-linear-sm transition-transform ${
            enabled ? 'translate-x-3.5' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ MetricSlot ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â PowerBI-style pill with per-field aggregation ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
/**
 * Phase-15.16: validity matrix per aggregation × column-type.
 *
 *   SUM / AVG          → numeric only
 *   MIN / MAX          → any orderable type (numeric, date, string)
 *   COUNT              → any column (it counts non-null rows of that column)
 *   COUNT_DISTINCT     → any column
 *
 * The previous MetricSlot enforced this by SPLITTING the picker into two —
 * one numeric-only "+ add value..." (defaulting to SUM) and a second
 * "+ count any field..." (defaulting to COUNT). DA feedback: only the
 * first picker was discoverable; the second got missed, and text columns
 * could not be added to chart Values at all. The fix is a single unified
 * picker that lets DA pick ANY column and picks a smart default agg —
 * incompatible (column × agg) combinations stay reachable but light up
 * the pill with a warning + tooltip explaining which aggs do work.
 */
function isMetricAggValidForCol(agg: AggFn, col: Col | undefined): boolean {
  if (!col) return true; // unknown col — don't block; engine will surface real error
  const numeric = isNumeric(col);
  switch (agg) {
    case 'sum':
    case 'avg':
      return numeric;
    case 'min':
    case 'max':
      // Numeric, date, and string are all orderable — MIN/MAX of a string
      // returns the alphabetically first/last value, which is useful for
      // "first opened ticket subject", etc.
      return true;
    case 'count':
    case 'count_distinct':
      return true;
    case 'auto':
      // AS-IS only makes sense for a declared semantic measure (it already
      // has its own stored aggregation). For a bare column, there's nothing
      // to "use as-is" — the engine would silently fall back to SUM.
      return isMeasureField(col);
    default:
      return true;
  }
}

function defaultMetricAggForCol(col: Col | undefined): AggFn {
  if (!col) return 'sum';
  if (isMeasureField(col)) {
    // Declared semantic measure — pass 'auto' so BE uses the measure's
    // stored aggregation. Phase-15.7 hardened the engine to honour this.
    return 'auto';
  }
  if (isNumeric(col)) return 'sum';
  // Text / date / yesno → count_distinct is almost always what DA wants
  // (count of unique users / orders / regions). Plain COUNT degenerates
  // to row count once a dimension is present.
  return 'count_distinct';
}

function describeValidAggs(col: Col | undefined): string {
  if (!col) return '';
  const labels = AGG_OPTIONS
    .filter((opt) => isMetricAggValidForCol(opt.value, col))
    .map((opt) => opt.label);
  return labels.join(' / ');
}

function MetricSlot({
  label, required, hint, single, value, options, allOptions, declaredMeasureRefs, allowRunningTotal, onChange,
}: {
  label: string; required?: boolean; hint?: string;
  single?: boolean;
  value: MetricConfig[];
  /** Numeric columns (legacy — kept for the SUM-default ranking inside
   *  the picker only). The picker itself draws from `allOptions`. */
  options: Col[];
  /** All columns including non-numeric. Defaults to options for back-compat. */
  allOptions?: Col[];
  /** Phase-15.7: qualified refs that ARE declared semantic measures. Used
   *  to distinguish "user picked a declared measure" (no badge) from
   *  "user picked a raw numeric dim that BE will auto-promote to SUM/...".
   *  Undefined → fall back to bare-vs-qualified heuristic. */
  declaredMeasureRefs?: Set<string>;
  /** Show the "Running total" (cumulative/YTD) per-metric toggle. Only for
   *  cartesian charts with an ordered axis (BAR/LINE/AREA/TIME_SERIES). */
  allowRunningTotal?: boolean;
  onChange: (v: MetricConfig[]) => void;
}) {
  const missing = required && value.length === 0;
  const fullOptions = allOptions ?? options;
  const fullOptionsByName = useMemo(() => {
    const map = new Map<string, Col>();
    for (const c of fullOptions) map.set(c.name, c);
    return map;
  }, [fullOptions]);

  const addField = (fieldName: string) => {
    if (!fieldName) return;
    if (value.find(m => m.field === fieldName)) return;
    const col = fullOptionsByName.get(fieldName);
    const agg = defaultMetricAggForCol(col);
    // Phase-15.7: implicit detect tightened. A metric is implicit when it
    // points to ANYTHING that isn't a declared semantic measure — that
    // covers (a) bare names (no qualifier) AND (b) qualified names whose
    // target view doesn't have a measure of that name (i.e. the BE will
    // synthesise SUM/AVG/... at query time via the implicit-fallback in
    // semantic_query_engine._render_measure).
    const isQualified = fieldName.includes('.');
    const isExplicit = isQualified && (declaredMeasureRefs?.has(fieldName) ?? false);
    const next: MetricConfig = isExplicit
      ? { field: fieldName, agg }
      : { field: fieldName, agg, _implicit: true };
    onChange(single ? [next] : [...value, next]);
  };

  const removeField = (fieldName: string) => onChange(value.filter(m => m.field !== fieldName));

  // Phase-15.16: KEEP the metric on agg change even when the new agg is
  // not compatible with the column type. The previous behaviour was to
  // silently drop the row, leaving DA wondering why the chart suddenly
  // emptied out. Now the pill stays, gets a warning style, and tooltips
  // explain which aggs are valid for the column.
  const changeAgg = (fieldName: string, agg: AggFn) =>
    onChange(value.map((m) => (m.field === fieldName ? { ...m, agg } : m)));

  const toggleRunningTotal = (fieldName: string) =>
    onChange(value.map((m) => (m.field === fieldName ? { ...m, runningTotal: !m.runningTotal } : m)));

  const available = fullOptions.filter(o => !value.find(m => m.field === o.name));

  return (
    <div>
      <label className="flex items-center gap-1 text-xs font-semibold text-text-secondary mb-1.5">
        {label}
        {required && <span className="text-danger">*</span>}
        {hint && <HelpTooltip text={hint} />}
      </label>

      {/* Metric pills */}
      {value.length > 0 && (
        <div className="space-y-1.5 mb-2">
          {value.map(m => {
            const col = fullOptionsByName.get(m.field);
            const aggValid = isMetricAggValidForCol(m.agg, col);
            const validList = describeValidAggs(col);
            const pillClass = aggValid
              ? 'border-brand/30 bg-brand/10'
              : 'border-warning/50 bg-warning/10';
            const aggClass = aggValid ? 'text-brand' : 'text-warning';
            const labelClass = aggValid ? 'text-brand' : 'text-warning';
            const removeClass = aggValid
              ? 'hover:bg-brand-hover text-brand'
              : 'hover:bg-warning/20 text-warning';
            return (
              <div
                key={m.field}
                className={`flex items-center gap-1 pl-2 pr-1 py-1 rounded-md border ${pillClass}`}
              >
                <select
                  value={m.agg}
                  onChange={e => changeAgg(m.field, e.target.value as AggFn)}
                  className={`text-xs font-bold bg-transparent border-none outline-none cursor-pointer ${aggClass}`}
                  title={
                    aggValid
                      ? undefined
                      : `${m.agg.toUpperCase()} is not available for type=${col?.type || 'unknown'} columns. Valid aggregations: ${validList || 'none'}.`
                  }
                >
                  {AGG_OPTIONS.map(a => {
                    const compatible = isMetricAggValidForCol(a.value, col);
                    return (
                      <option key={a.value} value={a.value}>
                        {compatible ? a.label : `${a.label} ✕`}
                      </option>
                    );
                  })}
                </select>
                <span className={`flex-1 text-xs truncate ${labelClass}`} title={(() => { const _c = fullOptionsByName.get(m.field); return _c ? humanFieldRef(_c) : m.field; })()}>
                  {col ? colLabel(col) : m.field}
                </span>
                {!aggValid && (
                  <span
                    className="rounded bg-warning/20 px-1 text-[10px] font-emphasis uppercase tracking-wide text-warning"
                    title={`Warning: ${m.agg.toUpperCase()} is incompatible with type=${col?.type || 'unknown'}. Switch to ${validList} to clear this warning.`}
                  >
                    ⚠ Incompatible
                  </span>
                )}
                {m._implicit && aggValid && (
                  <span
                    className="rounded bg-warning/10 px-1 text-[10px] font-emphasis uppercase tracking-wide text-warning"
                    title={
                      "Temporary measure: created from a raw column in this chart. To reuse it in other charts, " +
                      "add a measure in Data Model with the same column and aggregation."
                    }
                  >
                    auto
                  </span>
                )}
                {allowRunningTotal && (m.agg === 'sum' || m.agg === 'auto') && (
                  <button
                    onClick={() => toggleRunningTotal(m.field)}
                    title={m.runningTotal
                      ? 'Running total ON — cumulative (YTD) over the axis. Click to turn off.'
                      : 'Show as running total (cumulative / YTD over the axis)'}
                    className={`px-1 py-0.5 rounded text-[10px] font-bold flex-shrink-0 ${
                      m.runningTotal
                        ? 'bg-primary/15 text-primary'
                        : 'text-text-tertiary hover:text-text-secondary hover:bg-surface-hover'
                    }`}
                  >
                    Σ↑
                  </button>
                )}
                <button
                  onClick={() => removeField(m.field)}
                  className={`p-0.5 rounded flex-shrink-0 ${removeClass}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Phase-15.16: single unified picker. All column types are pickable;
          a smart default agg is chosen (numeric → SUM, declared measure →
          auto, anything else → COUNT_DISTINCT). User can switch agg via
          the dropdown afterwards; incompatible combos show a warning
          instead of being silently dropped. */}
      {(!single || value.length === 0) && (
        <FieldPicker
          options={available}
          placeholder={available.length === 0 ? 'all fields added' : '+ add value (any column)...'}
          emptyLabel="No fields available"
          disabled={available.length === 0}
          invalid={missing}
          onSelect={addField}
        />
      )}
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const normalizedValue = normalizeColorInput(value, '#dbeafe');
  const [draft, setDraft] = useState(normalizedValue);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setDraft(normalizedValue);
  }, [normalizedValue]);

  useEffect(() => {
    if (!open) return;

    const handleMouseDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const commitDraft = () => {
    const next = normalizeColorInput(draft, normalizedValue);
    setDraft(next);
    onChange(next);
  };

  const applyColor = (nextValue: string) => {
    const next = normalizeColorInput(nextValue, normalizedValue);
    setDraft(next);
    onChange(next);
  };

  return (
    <div ref={containerRef} className="relative">
      <label className="mb-1 block text-xs font-semibold text-text-secondary">{label}</label>

      <div
        className={`flex items-center gap-2 rounded-md border bg-surface-1 px-2 py-1.5 transition-colors ${
          open ? 'border-brand/40 ring-1 ring-brand' : 'border-[rgb(var(--border-strong))]'
        }`}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-label={`Open color picker for ${label}`}
          onClick={() => setOpen((current) => !current)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-[rgb(var(--border-line))] bg-surface-1 hover:border-[rgb(var(--border-strong))]"
        >
          <span
            className="h-4 w-4 rounded-sm border border-white/70 shadow-inner"
            style={{ backgroundColor: normalizedValue }}
          />
        </button>

        <input
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitDraft();
            }
          }}
          placeholder="#1d4ed8"
          className="min-w-0 flex-1 bg-transparent px-0 text-[11px] font-mono uppercase tracking-wide text-text-secondary focus:outline-none"
        />

        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="rounded p-1 text-text-quaternary hover:bg-surface-2 hover:text-text-secondary"
        >
          <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-52 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-2 shadow-linear-lg">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={normalizedValue}
              onChange={e => applyColor(e.target.value)}
              className="h-8 w-9 cursor-pointer rounded border border-[rgb(var(--border-line))] bg-surface-1 p-0.5"
            />

            <input
              type="text"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={commitDraft}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitDraft();
                }
              }}
              className="min-w-0 flex-1 rounded border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-1.5 text-[11px] font-mono uppercase text-text-secondary focus:outline-none focus:ring-1 focus:ring-brand"
            />

            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-1 text-text-quaternary hover:bg-surface-2 hover:text-text-secondary"
              title="Close color picker"
            >
              <X className="h-3 w-3" />
            </button>
          </div>

          <div className="mt-2 grid grid-cols-6 gap-1.5">
            {COLOR_PRESET_SWATCHES.map((preset) => {
              const active = normalizedValue === preset;
              return (
                <button
                  key={`${label}-${preset}`}
                  type="button"
                  onClick={() => applyColor(preset)}
                  className={`h-6 rounded-md border transition-transform hover:scale-105 ${
                    active ? 'border-[rgb(var(--border-strong))] ring-1 ring-[rgb(var(--border-strong))]/20' : 'border-[rgb(var(--border-line))]'
                  }`}
                  style={{ backgroundColor: preset }}
                  title={preset}
                  aria-label={`Select color ${preset}`}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Main ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
interface ExploreChartConfigProps {
  chartType: ExploreChartType;
  roleConfig: ChartRoleConfig;
  styleConfig: ChartStyleConfig;
  availableColumns: Col[];
  sortLimitColumns?: Col[];
  tableDisplayColumns?: Col[];
  queryMode?: 'generated' | 'custom';
  validationMessage?: string | null;
  readOnly?: boolean;
  mode?: 'full' | 'styleOnly';
  /** Series keys (metric keys or breakdown values) available for per-series color override. */
  availableSeriesKeys?: { key: string; label: string }[];
  /**
   * Phase-15.88 — columns the BE actually returns in chart rows after the
   * query runs. Distinct from `availableColumns` (the full dataset
   * column catalogue). Tooltip extra fields MUST be picked from this
   * set, otherwise CustomTooltip lookups return undefined and the
   * feature silently no-ops — DA's "I tick the chip and nothing shows
   * up" report.
   */
  chartResultColumns?: string[];
  /**
   * Phase-15.1: drill-down hierarchy map. Keyed by qualified parent field
   * name; value is the list of qualified child field names declared via
   * DimensionDefinition.parent. When the chart's dimension has children
   * in this map, we render a "↓ Drill into <child>" button next to it.
   * Empty / undefined = no hierarchy info; drill button hidden.
   */
  dimChildrenMap?: Map<string, string[]>;
  /**
   * Phase-15.7: set of qualified field refs that ARE declared as semantic
   * measures on reachable views. MetricSlot uses this to decide whether
   * a newly-added qualified ref should carry the `_implicit` flag —
   * qualified-AND-declared = explicit, anything else (bare OR qualified
   * pointing at a numeric dim) = implicit (BE auto-promotes via SUM).
   * Hiding the badge for declared measures keeps the UI honest.
   */
  declaredMeasureRefs?: Set<string>;
  /**
   * Phase-15.10: name of the chart's base semantic view. Forwarded into
   * FieldPickerContext so cross-table options get a "JOIN" cue.
   */
  baseViewName?: string | null;
  /**
   * Phase-15.11: qualified refs (`view.bare_column`) of every column that
   * participates in an active JoinDefinition on either side. FieldPickers
   * hide these from the dropdown by default — DA never charts by raw FK
   * IDs — and expose a "Show JOIN keys" toggle for the rare override.
   */
  joinKeyRefs?: Set<string>;
  onChartTypeChange: (t: ExploreChartType) => void;
  onRoleConfigChange: (c: ChartRoleConfig) => void;
  onStyleConfigChange: (c: ChartStyleConfig) => void;
}

export function ExploreChartConfig({
  chartType,
  roleConfig,
  styleConfig,
  availableColumns,
  sortLimitColumns = [],
  tableDisplayColumns = [],
  queryMode = 'generated',
  validationMessage = null,
  readOnly,
  mode = 'full',
  availableSeriesKeys = [],
  chartResultColumns = [],
  dimChildrenMap,
  declaredMeasureRefs,
  baseViewName,
  joinKeyRefs,
  onChartTypeChange,
  onRoleConfigChange,
  onStyleConfigChange,
}: ExploreChartConfigProps) {
  const { t } = useI18n();
  const isStyleOnly = mode === 'styleOnly';
  const upd = useCallback(
    (patch: Partial<ChartRoleConfig>) => onRoleConfigChange({ ...roleConfig, ...patch }),
    [roleConfig, onRoleConfigChange]
  );
  const updStyle = useCallback(
    (patch: Partial<ChartStyleConfig>) => onStyleConfigChange({ ...styleConfig, ...patch }),
    [styleConfig, onStyleConfigChange]
  );
  // Phase-13.4: set / clear a per-field time grain. Keep timeGrains
  // undefined when empty so legacy chart configs that never used
  // grains stay byte-identical (no spurious diff on save).
  const setGrain = useCallback(
    (fieldName: string | undefined, grain: TimeGrain | undefined) => {
      if (!fieldName) return;
      const current = roleConfig.timeGrains ?? {};
      const nextGrains: Record<string, TimeGrain> = { ...current };
      if (grain) {
        nextGrains[fieldName] = grain;
      } else {
        delete nextGrains[fieldName];
      }
      const cleaned = Object.keys(nextGrains).length > 0 ? nextGrains : undefined;
      onRoleConfigChange({ ...roleConfig, timeGrains: cleaned });
    },
    [roleConfig, onRoleConfigChange],
  );

  const allCols  = availableColumns;
  const numCols  = allCols.filter(isNumeric);
  const dimCols  = allCols.filter(c => !isNumeric(c));
  const timeCols = allCols.filter(isTimelike);
  const normalizedRoleConfig = normalizeRoleConfig(chartType, roleConfig);
  const normalizedStyleConfig = normalizeChartStyleConfig(styleConfig);

  const dimOrAll  = dimCols.length  > 0 ? dimCols  : allCols;
  const numOrAll  = numCols.length  > 0 ? numCols  : allCols;
  const timeOrAll = timeCols.length > 0 ? timeCols : allCols;

  const dim = normalizedRoleConfig.dimension || '';
  const brk = normalizedRoleConfig.breakdown || '';
  const tf  = normalizedRoleConfig.timeField || '';
  // Phase-15.3: auto-detect when the chart's X-axis dimension is a
  // date/datetime column — let the TimeGrainSlot appear so DA can bucket
  // without switching to TIME_SERIES chart type. LINE / AREA / BAR are
  // the common cases where users plot a date on X without thinking of it
  // as "time series" semantically.
  const dimIsTime = Boolean(
    dim && allCols.find((c) => c.name === dim && isTimelike(c)),
  );
  const sx  = normalizedRoleConfig.scatterX  || '';
  const sy  = normalizedRoleConfig.scatterY  || '';
  // PBI/Tableau parity: a declared MEASURE carries its own aggregation (defined
  // in the Data Model) and is never re-aggregated inline. So for a measure axis
  // we HIDE the X/Y aggregation dropdown (it would be silently ignored by the
  // BE — the BUG-016 sibling) and surface a read-only "Σ Measure" hint instead.
  // Only a raw numeric column gets the SUM/AVG picker.
  const sxIsMeasure = !!sx && allCols.some(c => c.name === sx && isMeasureField(c));
  const syIsMeasure = !!sy && allCols.some(c => c.name === sy && isMeasureField(c));
  const lineMetric = normalizedRoleConfig.lineMetric ? [normalizedRoleConfig.lineMetric] : [];
  const benchmarkMetric = normalizedRoleConfig.benchmarkMetric ? [normalizedRoleConfig.benchmarkMetric] : [];
  const tableMode = normalizedRoleConfig.tableMode ?? 'standard';
  const tableRowDimension = normalizedRoleConfig.tableRowDimension || '';
  const tableColumnDimension = normalizedRoleConfig.tableColumnDimension || '';
  const tablePivotMetric = normalizedRoleConfig.tablePivotMetric ? [normalizedRoleConfig.tablePivotMetric] : [];
  const standardDisplayedTableColumns = (normalizedRoleConfig.selectedColumns?.length
    ? normalizedRoleConfig.selectedColumns
        .map((columnName) => availableColumns.find((column) => column.name === columnName))
        .filter((column): column is Col => Boolean(column))
    : availableColumns);
  const fallbackPivotDisplayColumns = [
    availableColumns.find((column) => column.name === tableRowDimension),
  ].filter((column): column is Col => Boolean(column));
  const displayedTableColumns = tableMode === 'pivot'
    ? (tableDisplayColumns.length > 0 ? tableDisplayColumns : fallbackPivotDisplayColumns)
    : standardDisplayedTableColumns;
  const tableFormattingColumns = displayedTableColumns.length > 0
    ? displayedTableColumns
    : (tableMode === 'pivot' ? fallbackPivotDisplayColumns : availableColumns);
  const tableNumericColumns = tableFormattingColumns.filter(isNumeric);
  const tableConditionalFormatting = normalizedStyleConfig.tableConditionalFormatting ?? [];
  const tableHeatmapRules = normalizedStyleConfig.tableHeatmapRules ?? [];
  const tableSummaryRows = normalizedStyleConfig.tableSummaryRows ?? [];
  const tableColumnWidths = normalizedStyleConfig.tableColumnWidths ?? {};
  const tableColumnAlignments = normalizedStyleConfig.tableColumnAlignments ?? {};
  const tableColumnLabels = normalizedStyleConfig.tableColumnLabels ?? {};
  const tableHyperlinkRules = normalizedStyleConfig.tableHyperlinkRules ?? [];
  const isPivotEnabled = tableMode === 'pivot';
  const isSummaryRowEnabled = normalizedStyleConfig.tableShowSummaryRow ?? false;
  const isHeatmapEnabled = normalizedStyleConfig.tableEnableHeatmap ?? false;
  const isConditionalFormattingEnabled = normalizedStyleConfig.tableEnableConditionalFormatting ?? false;
  const tableBenchmarkColumns = tableMode === 'pivot'
    ? tableFormattingColumns
    : availableColumns;
  const tableSummaryLabelColumns = tableFormattingColumns.length > 0
    ? tableFormattingColumns
    : availableColumns;

  const isTableLike = ['TABLE', 'MATRIX'].includes(chartType);
  const isNoDimensionMetric = ['KPI', 'GAUGE', 'BULLET'].includes(chartType);
  const isPieLike = ['PIE', 'DONUT', 'POLAR_AREA'].includes(chartType);
  const isScatterLike = ['SCATTER', 'BUBBLE', 'MAP_POINT', 'NINE_BOX'].includes(chartType);
  const isBarType = ['BAR', 'HORIZONTAL_BAR', 'GROUPED_BAR', 'STACKED_BAR', 'BAR_LINE', 'WATERFALL'].includes(chartType);
  // Bars rendered via real Recharts <Bar> (honour barRadius/barSize). WATERFALL
  // is a hand-rolled SVG that ignores those props → exclude it so the Bar Shape
  // controls aren't shown-but-dead.
  const isRechartsBarShape = isBarType && chartType !== 'WATERFALL';
  const isLineType = ['LINE', 'TIME_SERIES', 'AREA', 'BAR_LINE', 'RIBBON'].includes(chartType);
  // hasAxis = chart is rendered with REAL Recharts cartesian axes (so the
  // "Axes & Scale" controls — gridlines, X/Y axis label, Y min/max, axis font —
  // actually take effect). ALLOWLIST, not a blocklist: the previous blocklist
  // leaked these controls onto SVG-rendered advanced charts (WATERFALL, RADAR,
  // BUBBLE, HEATMAP, MAP_POINT, BOXPLOT, RIBBON, TIMELINE) whose renderers
  // ignore every axis field → "DA toggles it, nothing happens". Only the
  // Recharts cartesian family qualifies. (RIBBON/TIMELINE are SVG → excluded.)
  const hasAxis = [
    'BAR', 'HORIZONTAL_BAR', 'GROUPED_BAR', 'STACKED_BAR', 'BAR_LINE',
    'LINE', 'TIME_SERIES', 'AREA', 'SCATTER',
  ].includes(chartType);
  const supportsBenchmarkLine = ['BAR', 'HORIZONTAL_BAR', 'GROUPED_BAR', 'STACKED_BAR', 'LINE', 'AREA', 'TIME_SERIES', 'BAR_LINE'].includes(chartType);
  // Metric keys the chart plots — a dynamic-aggregate benchmark reads one of
  // these off the data rows (metricKey = `${agg}__${field}`, present per bucket).
  const benchmarkFieldOptions = [
    ...(normalizedRoleConfig.metrics || []),
    ...(normalizedRoleConfig.lineMetric ? [normalizedRoleConfig.lineMetric] : []),
  ].map((m) => ({ value: metricKey(m), label: `${m.agg}(${m.field})` }));
  const benchmarkLines = normalizedStyleConfig.benchmarkLines ?? [];
  const setBenchmarkLines = (next: BenchmarkLineDef[]) => updStyle({ benchmarkLines: next });
  const addBenchmarkLine = () => setBenchmarkLines([
    ...benchmarkLines,
    { source: 'value', value: '', label: `Mục tiêu ${benchmarkLines.length + 1}`, color: '#dc2626', lineStyle: 'dashed' },
  ]);
  const updateBenchmarkLine = (i: number, patch: Partial<BenchmarkLineDef>) =>
    setBenchmarkLines(benchmarkLines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const removeBenchmarkLine = (i: number) =>
    setBenchmarkLines(benchmarkLines.filter((_, idx) => idx !== i));
  const supportsDataSection = !isTableLike && !isNoDimensionMetric;
  const chartBindingTitle = queryMode === 'custom' ? t('explore.config.sqlColumnRoles') : t('explore.config.fieldRoles');
  const tableBindingTitle = isPivotEnabled ? t('explore.config.pivotLayout') : t('explore.config.visibleColumns');
  const tableRoleSectionHint = queryMode === 'custom'
    ? t('explore.config.tableRoleHintCustom')
    : t('explore.config.tableRoleHintGenerated');
  const chartRoleSectionHint = queryMode === 'custom'
    ? t('explore.config.chartRoleHintCustom')
    : undefined;
  const showQuickView = !isTableLike && chartType !== 'KPI';
  const hasAdvancedControls = showQuickView && (hasAxis || supportsBenchmarkLine || isBarType || isLineType || isPieLike || isScatterLike || chartType === 'TIME_SERIES' || supportsDataSection);
  const chartSortRules = normalizedStyleConfig.chartSortRules ?? [];
  const sortLimitCols = sortLimitColumns;
  const quickViewStep = isStyleOnly ? 'Step 1' : 'Step 3';
  const tableSectionStep = isStyleOnly ? 'Step 1' : 'Step 2';
  // Phase-15.92 — Format-pane search. Lets DA jump directly to a group
  // by keyword (eg. "axis", "label", "color"). Match is case-insensitive,
  // checked against a fixed bag of keywords per FormatGroup below. Empty
  // query = all groups visible.
  const [formatSearch, setFormatSearch] = useState('');
  const formatSearchActive = formatSearch.trim().length > 0;
  const formatSearchLower = formatSearch.trim().toLowerCase();
  const matchesFormatSearch = useCallback((keywords: string[]) => {
    if (!formatSearchActive) return true;
    return keywords.some((k) => k.toLowerCase().includes(formatSearchLower));
  }, [formatSearchActive, formatSearchLower]);
  const kpiSetupStep = isStyleOnly ? 'Step 1' : 'Step 3';
  const currentChartTypeMeta = useMemo(
    () => CHART_TYPE_GRID.find((item) => item.value === chartType) ?? DEFAULT_CHART_TYPE_META,
    [chartType]
  );
  const currentChartTypeGroup = useMemo(
    () => CHART_TYPE_GROUPS.find((group) => group.key === currentChartTypeMeta.group) ?? DEFAULT_CHART_TYPE_GROUP,
    [currentChartTypeMeta.group]
  );
  const [isChartTypePickerOpen, setIsChartTypePickerOpen] = useState(false);
  const [activeChartTypeGroup, setActiveChartTypeGroup] = useState<ChartTypeGroupKey>(currentChartTypeMeta.group);
  const visibleChartTypes = useMemo(
    () => CHART_TYPE_GRID.filter((item) => item.group === activeChartTypeGroup),
    [activeChartTypeGroup]
  );

  useEffect(() => {
    setActiveChartTypeGroup(currentChartTypeMeta.group);
  }, [currentChartTypeMeta.group]);

  // NINE_BOX parity with BUBBLE: a NUMERIC axis must aggregate per Label, so we
  // persist scatter*Agg='sum' by default. This is the signal the BE reads to
  // SUM/AVG the axis and GROUP BY the Label (else each raw value becomes its own
  // dot — the BUG-016 defect). An effect is required because auto-bound fields
  // (set when the user picks the chart type) never pass through the axis
  // onChange that would otherwise seed the agg. A CATEGORICAL axis clears the
  // agg so the BE keeps it as a 3-level GROUP BY dimension (no SUM-of-string).
  useEffect(() => {
    if (chartType !== 'NINE_BOX') return;
    // Decide per axis whether it should carry a numeric aggregation.
    //   • declared MEASURE  → no scatter*Agg (uses its Data-Model aggregation)
    //   • CONFIRMED categorical (present in the column list AND non-numeric)
    //                        → no scatter*Agg (stays a 3-level GROUP BY band)
    //   • everything else (a local numeric column, OR an axis we cannot see in
    //     the local column list — typically a CROSS-FACT / joined column that
    //     `configColumns` doesn't include) → wants SUM.
    // CRITICAL: "absent from numCols" must NOT be read as "categorical". A
    // cross-fact numeric axis (e.g. a joined fact's `performance_point`) is
    // absent from the base view's `configColumns`, so the old
    // `!numCols.has(sx)` test wrongly stripped its saved scatterXAgg on load —
    // the BE then regrouped it as a dimension and a multi-fact chart failed
    // loudly with "không thể tính measure từ nhiều bảng fact" (report-demo
    // NINE_BOX bug: saved config had scatterXAgg=sum, editor preview dropped
    // it → 400). Only a CONFIRMED categorical/measure clears the agg now.
    const sxCol = sx ? allCols.find((c) => c.name === sx) : undefined;
    const syCol = sy ? allCols.find((c) => c.name === sy) : undefined;
    const xCatConfirmed = !!sxCol && !isNumeric(sxCol) && !isMeasureField(sxCol);
    const yCatConfirmed = !!syCol && !isNumeric(syCol) && !isMeasureField(syCol);
    const xWantsAgg = !!sx && !sxIsMeasure && !xCatConfirmed;
    const yWantsAgg = !!sy && !syIsMeasure && !yCatConfirmed;
    const patch: Partial<ChartRoleConfig> = {};
    if (xWantsAgg && !roleConfig.scatterXAgg) patch.scatterXAgg = 'sum';
    if (!xWantsAgg && roleConfig.scatterXAgg) patch.scatterXAgg = undefined;
    if (yWantsAgg && !roleConfig.scatterYAgg) patch.scatterYAgg = 'sum';
    if (!yWantsAgg && roleConfig.scatterYAgg) patch.scatterYAgg = undefined;
    if (Object.keys(patch).length > 0) upd(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartType, sx, sy, roleConfig.scatterXAgg, roleConfig.scatterYAgg]);

  useEffect(() => {
    if (chartSortRules.length === 0 || sortLimitCols.length === 0) {
      return;
    }

    const validColumnNames = new Set(sortLimitCols.map((column) => column.name));
    const nextRules = chartSortRules.filter((rule) => validColumnNames.has(rule.field));

    if (nextRules.length !== chartSortRules.length) {
      updStyle({ chartSortRules: nextRules });
    }
  }, [chartSortRules, sortLimitCols, updStyle]);

  const setTableConditionalFormatting = (rules: ConditionalFormatRule[]) => {
    updStyle({ tableConditionalFormatting: rules.length > 0 ? rules : undefined });
  };

  const setTableHeatmapRules = (rules: TableHeatmapRule[]) => {
    updStyle({ tableHeatmapRules: rules.length > 0 ? rules : undefined });
  };

  const setTableSummaryRows = (rows: TableSummaryRowConfig[]) => {
    updStyle({ tableSummaryRows: rows.length > 0 ? rows : undefined });
  };

  const setTableColumnWidths = (widths: Record<string, number>) => {
    updStyle({ tableColumnWidths: pruneTableColumnWidths(widths) });
  };

  const setTableColumnAlignments = (alignments: Record<string, TableColumnAlignment>) => {
    updStyle({ tableColumnAlignments: pruneTableColumnAlignments(alignments) });
  };

  const setTableHyperlinkRules = (rules: TableHyperlinkRule[]) => {
    updStyle({ tableHyperlinkRules: pruneTableHyperlinkRules(rules) });
  };

  const toggleTablePivot = (enabled: boolean) => {
    upd({ tableMode: enabled ? 'pivot' : 'standard' });
  };

  const toggleTableSummaryRow = (enabled: boolean) => {
    if (enabled) {
      onStyleConfigChange({
        ...styleConfig,
        tableShowSummaryRow: true,
        tableSummaryRows: tableSummaryRows.length > 0
          ? tableSummaryRows
          : [createDefaultTableSummaryRow(tableFormattingColumns, availableColumns)],
      });
      return;
    }

    updStyle({ tableShowSummaryRow: false });
  };

  const toggleTableHeatmap = (enabled: boolean) => {
    if (enabled) {
      onStyleConfigChange({
        ...styleConfig,
        tableEnableHeatmap: true,
        tableHeatmapRules: tableHeatmapRules.length > 0
          ? tableHeatmapRules
          : [createDefaultTableHeatmapRule(tableNumericColumns, availableColumns)],
      });
      return;
    }

    updStyle({ tableEnableHeatmap: false });
  };

  const toggleTableConditionalFormatting = (enabled: boolean) => {
    if (enabled) {
      onStyleConfigChange({
        ...styleConfig,
        tableEnableConditionalFormatting: true,
        tableConditionalFormatting: tableConditionalFormatting.length > 0
          ? tableConditionalFormatting
          : [createDefaultTableRule(tableFormattingColumns, availableColumns)],
      });
      return;
    }

    updStyle({ tableEnableConditionalFormatting: false });
  };

  const updateTableRule = (index: number, patch: Partial<ConditionalFormatRule>) => {
    setTableConditionalFormatting(
      tableConditionalFormatting.map((rule, ruleIndex) => (
        ruleIndex === index ? { ...rule, ...patch } : rule
      )),
    );
  };

  const addTableRule = () => {
    setTableConditionalFormatting([
      ...tableConditionalFormatting,
      createDefaultTableRule(tableFormattingColumns, availableColumns),
    ]);
  };

  const removeTableRule = (index: number) => {
    setTableConditionalFormatting(
      tableConditionalFormatting.filter((_, ruleIndex) => ruleIndex !== index),
    );
  };

  const updateTableHeatmapRule = (index: number, patch: Partial<TableHeatmapRule>) => {
    setTableHeatmapRules(
      tableHeatmapRules.map((rule, ruleIndex) => (
        ruleIndex === index ? { ...rule, ...patch } : rule
      )),
    );
  };

  const addTableHeatmapRule = () => {
    setTableHeatmapRules([
      ...tableHeatmapRules,
      createDefaultTableHeatmapRule(tableNumericColumns, availableColumns),
    ]);
  };

  const removeTableHeatmapRule = (index: number) => {
    setTableHeatmapRules(
      tableHeatmapRules.filter((_, ruleIndex) => ruleIndex !== index),
    );
  };

  const updateTableSummaryRow = (index: number, patch: Partial<TableSummaryRowConfig>) => {
    setTableSummaryRows(
      tableSummaryRows.map((row, rowIndex) => (
        rowIndex === index ? { ...row, ...patch } : row
      )),
    );
  };

  const addTableSummaryRow = () => {
    setTableSummaryRows([
      ...tableSummaryRows,
      createDefaultTableSummaryRow(
        tableFormattingColumns,
        availableColumns,
        tableSummaryRows.length === 0 ? 'Total' : `Summary ${tableSummaryRows.length + 1}`,
      ),
    ]);
  };

  const removeTableSummaryRow = (index: number) => {
    setTableSummaryRows(
      tableSummaryRows.filter((_, rowIndex) => rowIndex !== index),
    );
  };

  const toggleTableSummaryRowColumnMode = (index: number, useAllColumns: boolean) => {
    updateTableSummaryRow(index, {
      columns: useAllColumns ? undefined : tableNumericColumns.map((column) => column.name),
    });
  };

  const toggleTableSummaryColumnSelection = (index: number, columnName: string) => {
    const currentRow = tableSummaryRows[index];
    const currentColumns = currentRow?.columns ?? [];
    const nextColumns = currentColumns.includes(columnName)
      ? currentColumns.filter((name) => name !== columnName)
      : [...currentColumns, columnName];
    updateTableSummaryRow(index, { columns: nextColumns });
  };

  const updateTableColumnAlignment = (columnName: string, alignment: TableColumnAlignment) => {
    setTableColumnAlignments({
      ...tableColumnAlignments,
      [columnName]: alignment,
    });
  };

  const tableColumnFormats = normalizedStyleConfig.tableColumnFormats ?? {};
  const updateTableColumnFormat = (columnName: string, format: TableCellFormat | '') => {
    const next = { ...tableColumnFormats };
    if (!format) delete next[columnName];
    else next[columnName] = format;
    updStyle({ tableColumnFormats: Object.keys(next).length > 0 ? next : undefined });
  };

  const updateTableColumnLabel = (columnName: string, label: string) => {
    const next = { ...tableColumnLabels };
    const trimmed = label.trim();
    if (trimmed) next[columnName] = trimmed;
    else delete next[columnName];
    updStyle({ tableColumnLabels: Object.keys(next).length > 0 ? next : undefined });
  };

  const updateTableHyperlinkRule = (index: number, patch: Partial<TableHyperlinkRule>) => {
    setTableHyperlinkRules(
      tableHyperlinkRules.map((rule, ruleIndex) => (
        ruleIndex === index ? { ...rule, ...patch } : rule
      )),
    );
  };

  const addTableHyperlinkRule = () => {
    setTableHyperlinkRules([
      ...tableHyperlinkRules,
      createDefaultTableHyperlinkRule(tableFormattingColumns, availableColumns),
    ]);
  };

  const removeTableHyperlinkRule = (index: number) => {
    setTableHyperlinkRules(
      tableHyperlinkRules.filter((_, ruleIndex) => ruleIndex !== index),
    );
  };

  const resetTableColumnWidth = (columnName: string) => {
    const nextWidths = { ...tableColumnWidths };
    delete nextWidths[columnName];
    setTableColumnWidths(nextWidths);
  };

  const resetAllTableColumnWidths = () => {
    updStyle({ tableColumnWidths: undefined });
  };

  const CurrentChartIcon = currentChartTypeMeta.icon;

  // Phase-15.11: stable context value so child FieldPickers do not
  // re-render on every parent render. The `joinKeyRefs` fallback to an
  // empty Set keeps the type tight even when the prop is undefined.
  const fieldPickerCtx = useMemo(
    () => ({
      baseViewName: baseViewName ?? null,
      joinKeyRefs: joinKeyRefs ?? new Set<string>(),
    }),
    [baseViewName, joinKeyRefs],
  );

  return (
    <FieldPickerContext.Provider value={fieldPickerCtx}>
    <div className={`space-y-4 p-4${readOnly ? ' pointer-events-none opacity-60' : ''}`}>
      {validationMessage && (
        <div className="rounded-2xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          {validationMessage}
        </div>
      )}

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Chart Type ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ visual grid ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      {!isStyleOnly && (
        <SectionPanel
          step="Step 1"
          title="Chart Type"
          description="Start with the visual form. The required field roles below will adapt to the chart you choose."
        >
          <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2/70 p-2">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-1"
              onClick={() => setIsChartTypePickerOpen((open) => !open)}
              aria-expanded={isChartTypePickerOpen}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-brand/30 bg-brand/10 text-brand">
                <CurrentChartIcon className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-text-primary">{currentChartTypeMeta.label}</span>
                <span className="block truncate text-[11px] text-text-tertiary">{currentChartTypeGroup.label}</span>
              </span>
              <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-0.5 text-[11px] font-medium text-text-secondary">
                {isChartTypePickerOpen ? 'Close' : 'Change'}
              </span>
              <ChevronDown className={`h-4 w-4 text-text-tertiary transition-transform ${isChartTypePickerOpen ? 'rotate-180' : ''}`} />
            </button>

            {isChartTypePickerOpen && (
              <div className="mt-3 space-y-3 border-t border-[rgb(var(--border-line))] pt-3">
                <div className="flex gap-1 overflow-x-auto pb-1">
                  {CHART_TYPE_GROUPS.map((group) => {
                    const isActive = activeChartTypeGroup === group.key;
                    const count = CHART_TYPE_GRID.filter((item) => item.group === group.key).length;

                    return (
                      <button
                        key={group.key}
                        type="button"
                        className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                          isActive
                            ? 'border-brand/40 bg-brand/10 text-brand'
                            : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-tertiary hover:border-[rgb(var(--border-strong))] hover:text-text-secondary'
                        }`}
                        title={group.hint}
                        onClick={() => setActiveChartTypeGroup(group.key)}
                      >
                        {group.label} ({count})
                      </button>
                    );
                  })}
                </div>

                <div className="grid grid-cols-2 gap-1.5">
                  {visibleChartTypes.map(({ value, label, icon: Icon }) => {
                    const isSelected = chartType === value;

                    return (
                      <button
                        key={value}
                        type="button"
                        className={`flex min-w-0 items-center gap-2 rounded-lg border px-2 py-2 text-left text-[11px] font-medium transition-colors ${
                          isSelected
                            ? 'border-brand/50 bg-brand/10 text-brand'
                            : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary hover:border-[rgb(var(--border-strong))] hover:bg-surface-2'
                        }`}
                        title={label}
                        onClick={() => {
                          onChartTypeChange(value);
                          setIsChartTypePickerOpen(false);
                        }}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                        {isSelected && <Check className="h-3.5 w-3.5 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </SectionPanel>
      )}

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ TABLE: column picker ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      {isTableLike && (
        <SectionPanel
          step={tableSectionStep}
          title={isStyleOnly ? 'Table Appearance' : 'Table Structure'}
          description={isStyleOnly
            ? 'Adjust formatting and display behaviors for this table without changing its source fields.'
            : 'Choose the visible columns first, then enable only the table behaviors you actually need.'}
        >
      {!isStyleOnly && availableColumns.length > 0 && (
        <>
        <Disclosure
          title={tableBindingTitle}
          hint={tableRoleSectionHint}
          defaultOpen
        >
          <Toggle
            label="Enable dynamic pivot layout"
            checked={isPivotEnabled}
            onChange={toggleTablePivot}
          />

          {isPivotEnabled ? (
            <>
              <SelectSlot
                label="Row Dimension"
                required
                value={tableRowDimension}
                options={dimOrAll}
                placeholder="select row dimension"
                onChange={value => upd({ tableRowDimension: value || undefined })}
              />

              <SelectSlot
                label="Column Dimension"
                required
                value={tableColumnDimension}
                options={dimOrAll.filter((column) => column.name !== tableRowDimension)}
                placeholder="select column dimension"
                onChange={value => upd({ tableColumnDimension: value || undefined })}
              />

              <MetricSlot
                label="Value Measure"
                required
                single
                value={tablePivotMetric}
                options={numOrAll}
                allOptions={allCols}
                declaredMeasureRefs={declaredMeasureRefs}
                onChange={value => upd({ tablePivotMetric: value[0] })}
              />

            </>
          ) : (
            <>
              {/* BUG-005 — the Select/Deselect-all button and the checkboxes
                  read the RAW roleConfig.selectedColumns, NOT normalizedRoleConfig
                  (which collapses [] → undefined for the render pipeline). That
                  collapse made "Deselect all" write [], get re-read as undefined,
                  and snap every box back to checked. Reading the raw value lets an
                  explicit empty selection ([]) show as "none ticked"; `undefined`
                  (never chosen) still means "use defaults = all columns". */}
              <div className="flex items-center justify-between mb-1">
                <button
                  onClick={() => {
                    const sel = roleConfig?.selectedColumns;
                    const allSelected = !sel || sel.length === availableColumns.length;
                    upd({ selectedColumns: allSelected ? [] : availableColumns.map(c => c.name) });
                  }}
                  className="text-xs text-brand hover:text-brand"
                >
                  {(!roleConfig?.selectedColumns || roleConfig.selectedColumns.length === availableColumns.length) ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
                {availableColumns.map(col => {
                  const checked = !roleConfig?.selectedColumns || roleConfig.selectedColumns.includes(col.name);
                  // Phase-15.13: show the friendly column label; expose the
                  // raw qualified key via `title` so engineering debug still
                  // has the SQL identifier on hover.
                  const display = colLabel(col);
                  const viewLabel = fieldSourceLabel(col);
                  const isMeasure = isMeasureField(col);
                  return (
                    <label
                      key={col.name}
                      className="flex items-center gap-2 py-1 px-2 rounded hover:bg-surface-2 cursor-pointer group"
                      title={col.name}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const current = roleConfig?.selectedColumns ?? availableColumns.map(c => c.name);
                          const next = checked ? current.filter(n => n !== col.name) : [...current, col.name];
                          upd({ selectedColumns: next });
                        }}
                        className="w-3.5 h-3.5 rounded border-[rgb(var(--border-strong))] text-brand focus:ring-brand"
                      />
                      <span className="text-xs text-text-secondary truncate flex-1">
                        {display}
                        {viewLabel && viewLabel !== display && (
                          <span className="ml-1.5 text-[10px] text-text-quaternary">· {viewLabel}</span>
                        )}
                      </span>
                      {/* Persistent pill so DA can tell aggregated rows from
                          raw ones at a glance. Without it, ticking a measure
                          silently changes query semantics from "list rows"
                          to "GROUP BY non-measures + auto-agg measures". */}
                      {isMeasure && (
                        <span
                          className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-warning/10 text-warning"
                          title="This is a semantic measure — selecting it makes the table aggregate by the non-measure columns."
                        >
                          Measure
                        </span>
                      )}
                      <span className="text-xs text-text-quaternary opacity-0 group-hover:opacity-100">{col.type}</span>
                    </label>
                  );
                })}
              </div>
              {/* BUG-005 — coherence note: when nothing is ticked ([]), the
                  render pipeline still shows ALL columns (its long-standing
                  "[] = no selection = show all" contract, guarded in
                  chartDataAdapter + explore-query). Surface that so an empty
                  tick list doesn't read as a second bug. */}
              {Array.isArray(roleConfig?.selectedColumns) && roleConfig.selectedColumns.length === 0 && (
                <p className="mt-1 text-[10px] text-text-quaternary italic">
                  Chưa tích cột nào — bảng đang hiển thị tất cả cột mặc định. Tích các cột để chỉ hiển thị những cột đó.
                </p>
              )}
            </>
          )}
        </Disclosure>

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Field Mapping ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        </>
      )}
      {isTableLike && (
        <Disclosure
          title="Optional Enhancements"
          hint="Each option is opt-in. The base table remains unchanged until you enable one of these behaviors."
          defaultOpen
        >
          {tableNumericColumns.length > 0 && (
            <Toggle
              label="Summary rows"
              checked={isSummaryRowEnabled}
              onChange={toggleTableSummaryRow}
            />
          )}

          {tableNumericColumns.length > 0 && (
            <Toggle
              label="Thang màu / Gradient (Color scale)"
              description="Tô nền chuyển sắc theo độ lớn — nhìn nhanh giá trị cao/thấp mà không cần đặt ngưỡng."
              checked={isHeatmapEnabled}
              onChange={toggleTableHeatmap}
            />
          )}

          {tableFormattingColumns.length > 0 && (
            <Toggle
              label="Định dạng theo điều kiện (Conditional formatting)"
              description="Nhiều quy tắc: đổi màu / thanh dữ liệu / icon theo ngưỡng, phân vị, %, hoặc giá trị cột khác."
              checked={isConditionalFormattingEnabled}
              onChange={toggleTableConditionalFormatting}
            />
          )}

        </Disclosure>
      )}

      {isTableLike && !isPivotEnabled && tableFormattingColumns.length > 0 && availableColumns.length > 0 && (
        <Disclosure
          title="Cell Links"
          hint="Map a displayed text column to a URL column. The URL column can stay hidden from the visible table columns."
          defaultOpen={tableHyperlinkRules.length > 0}
        >
          {tableHyperlinkRules.length > 0 && (
            <div className="space-y-3">
              {tableHyperlinkRules.map((rule, index) => (
                <div
                  key={rule.id || `${rule.targetColumn}-${rule.urlColumn}-${index}`}
                  className="space-y-2.5 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
                      Link {index + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeTableHyperlinkRule(index)}
                      className="rounded p-1 text-text-quaternary hover:bg-surface-1 hover:text-danger"
                      title="Remove link"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <SelectSlot
                    label="Text Column"
                    required
                    value={rule.targetColumn}
                    options={tableFormattingColumns}
                    placeholder="select text column"
                    onChange={(value) => updateTableHyperlinkRule(index, { targetColumn: value })}
                  />

                  {/* BUG-006 — link source: an existing URL column, OR a {token}
                      template that builds the URL from row values (e.g. a CRM
                      deep link from an id column). Template mode is detected by
                      the presence of the urlTemplate string. */}
                  {(() => {
                    const useTemplate = typeof rule.urlTemplate === 'string';
                    const template = rule.urlTemplate ?? '';
                    const hasToken = /\{[^}]+\}/.test(template);
                    const schemeOk = /^(https?:\/\/|mailto:|tel:|\/)/i.test(template.trim());
                    return (
                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] font-medium text-text-tertiary">Link from</span>
                          <div className="flex overflow-hidden rounded-md border border-[rgb(var(--border-line))]">
                            <button
                              type="button"
                              onClick={() => updateTableHyperlinkRule(index, { urlTemplate: undefined })}
                              className={`px-2 py-0.5 text-[11px] ${!useTemplate ? 'bg-brand text-white' : 'bg-surface-1 text-text-secondary hover:bg-surface-2'}`}
                            >
                              URL column
                            </button>
                            <button
                              type="button"
                              onClick={() => updateTableHyperlinkRule(index, { urlTemplate: rule.urlTemplate ?? '' })}
                              className={`px-2 py-0.5 text-[11px] ${useTemplate ? 'bg-brand text-white' : 'bg-surface-1 text-text-secondary hover:bg-surface-2'}`}
                            >
                              URL template
                            </button>
                          </div>
                        </div>

                        {!useTemplate ? (
                          <SelectSlot
                            label="URL Column"
                            required
                            value={rule.urlColumn ?? ''}
                            options={availableColumns}
                            placeholder="select URL column"
                            onChange={(value) => updateTableHyperlinkRule(index, { urlColumn: value })}
                          />
                        ) : (
                          <div className="space-y-1">
                            <label className="block text-[11px] font-medium text-text-secondary">URL Template</label>
                            <input
                              type="text"
                              value={template}
                              onChange={(event) => updateTableHyperlinkRule(index, { urlTemplate: event.target.value })}
                              placeholder="https://crm.example.com/deal/{deal_id}"
                              className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 font-mono text-xs"
                            />
                            <p className="text-[10px] text-text-quaternary">
                              {`Use {column} tokens, e.g. {${rule.targetColumn || 'deal_id'}}. Values are URL-encoded.`}
                            </p>
                            {template.trim() !== '' && !schemeOk && (
                              <p className="text-[10px] text-danger">Must start with http(s)://, mailto:, tel: or / — otherwise the link is dropped.</p>
                            )}
                            {template.trim() !== '' && schemeOk && !hasToken && (
                              <p className="text-[10px] text-warning">No {`{column}`} token — every row links to the same URL.</p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  <label className="flex items-center gap-2 text-xs font-medium text-text-secondary">
                    <input
                      type="checkbox"
                      checked={rule.openInNewTab !== false}
                      onChange={(event) => updateTableHyperlinkRule(index, { openInNewTab: event.target.checked })}
                      className="h-3.5 w-3.5 rounded border-[rgb(var(--border-strong))] text-brand focus:ring-brand"
                    />
                    Open in new tab
                  </label>
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={addTableHyperlinkRule}
            className="w-full rounded-md border border-dashed border-[rgb(var(--border-strong))] bg-surface-2 px-3 py-2 text-xs font-medium text-text-secondary hover:bg-surface-2"
          >
            + Add link rule
          </button>
        </Disclosure>
      )}

      {isTableLike && tableFormattingColumns.length > 0 && (
        <Disclosure
          title={t('explore.config.columnLayout')}
          hint={t('explore.config.columnLayoutHint')}
          defaultOpen
        >
          <div className="flex items-center justify-between rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2">
            <div className="flex items-center gap-1">
              <div className="text-xs font-semibold text-text-secondary">{t('explore.config.resizableColumns')}</div>
              <HelpTooltip text={t('explore.config.resizableColumnsHelp')} />
            </div>
            <button
              type="button"
              onClick={resetAllTableColumnWidths}
              disabled={Object.keys(tableColumnWidths).length === 0}
              className="rounded-md border border-[rgb(var(--border-line))] px-2.5 py-1.5 text-[11px] font-medium text-text-secondary hover:border-[rgb(var(--border-strong))] hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('explore.config.resetAllWidths')}
            </button>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_84px_112px_24px] items-center gap-3 px-0.5 pb-1 text-[10px] font-medium uppercase tracking-wide text-text-quaternary">
            <span className="min-w-0 flex-1">{t('explore.config.column')}</span>
            <span className="w-[84px] text-center">{t('explore.config.align')}</span>
            <span className="w-[112px]">{t('explore.config.formatColumn')}</span>
            <span className="w-6" />
          </div>
          <div className="space-y-1">
            {tableFormattingColumns.map((column) => {
              const currentWidth = tableColumnWidths[column.name];
              const currentAlignment = tableColumnAlignments[column.name] ?? 'left';

              return (
                // Phase-16.x — compact single-row layout (was a 3-tier card per
                // column, which made a many-column table's config scroll forever).
                <div
                  key={`table-column-layout-${column.name}`}
                  className="grid grid-cols-[minmax(0,1fr)_84px_112px_24px] items-center gap-3 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2.5 py-1.5"
                >
                  <div
                    className="min-w-0 space-y-1"
                    title={`${column.name} · ${column.type || 'column'}${currentWidth ? ` · ${Math.round(currentWidth)}px` : ' · auto width'}`}
                  >
                    <span className="block truncate text-xs font-medium text-text-secondary">
                      {colLabel(column)}
                    </span>
                    <input
                      type="text"
                      value={tableColumnLabels[column.name] ?? ''}
                      onChange={(event) => updateTableColumnLabel(column.name, event.target.value)}
                      placeholder={colLabel(column)}
                      className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1 text-[11px]"
                      title={t('explore.config.customHeaderTitle')}
                    />
                  </div>
                  <div className="inline-flex w-[84px] shrink-0 overflow-hidden rounded-md border border-[rgb(var(--border-line))] bg-surface-1">
                    {TABLE_COLUMN_ALIGNMENT_OPTIONS.map((option) => {
                      const active = currentAlignment === option.value;
                      return (
                        <button
                          key={`${column.name}-${option.value}`}
                          type="button"
                          title={t('explore.config.alignOption', { option: option.label })}
                          onClick={() => updateTableColumnAlignment(column.name, option.value)}
                          className={`flex-1 py-1 text-[11px] font-semibold transition-colors ${
                            active ? 'bg-brand/10 text-brand' : 'text-text-tertiary hover:bg-surface-2'
                          }`}
                        >
                          {option.label.charAt(0)}
                        </button>
                      );
                    })}
                  </div>
                  <select
                    value={tableColumnFormats[column.name] ?? ''}
                    onChange={(e) => updateTableColumnFormat(column.name, e.target.value as TableCellFormat | '')}
                    title={t('explore.config.columnNumberFormatTitle')}
                    className="w-[112px] shrink-0 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-1.5 py-1 text-[11px]"
                  >
                    <option value="">{t('explore.config.default')}</option>
                    {isDateType(column) ? (
                      // Date columns get DATE display formats (not number formats,
                      // which no-op on an ISO string) — fixes "can't format a date
                      // column".
                      DATE_FORMAT_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))
                    ) : (
                      <>
                        <option value="auto">{t('explore.config.number')}</option>
                        <option value="compact">{t('explore.config.compact')}</option>
                        <option value="number">1,234</option>
                        <option value="percent">{t('explore.config.percent')}</option>
                        <option value="currency">{t('explore.config.currency')} {normalizedStyleConfig.currencySymbol || '$'}</option>
                      </>
                    )}
                  </select>
                  <button
                    type="button"
                    onClick={() => resetTableColumnWidth(column.name)}
                    disabled={!currentWidth}
                    title="Reset column width"
                    className="w-6 shrink-0 rounded-md border border-[rgb(var(--border-line))] py-1 text-[11px] text-text-tertiary hover:border-[rgb(var(--border-strong))] hover:bg-surface-1 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    ↺
                  </button>
                </div>
              );
            })}
          </div>
        </Disclosure>
      )}

      {isTableLike && isSummaryRowEnabled && tableNumericColumns.length > 0 && (
        <Disclosure
          title="Summary Rows"
          hint="Keep one or more calculation rows pinned to the bottom of the table. Each row can target different numeric columns and use a different aggregation."
          defaultOpen
        >
          {tableSummaryRows.length > 0 && (
            <div className="space-y-3">
              {tableSummaryRows.map((summaryRow, index) => {
                const usesAllColumns = !summaryRow.columns || summaryRow.columns.length === 0;
                return (
                  <div
                    key={`table-summary-row-${index}`}
                    className="space-y-2.5 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
                        Summary Row {index + 1}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeTableSummaryRow(index)}
                        className="rounded p-1 text-text-quaternary hover:bg-surface-1 hover:text-danger"
                        title="Remove summary row"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="mb-1 block text-xs font-semibold text-text-secondary">Label</label>
                        <input
                          type="text"
                          value={summaryRow.label || ''}
                          onChange={e => updateTableSummaryRow(index, { label: e.target.value || `Summary ${index + 1}` })}
                          className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs"
                          placeholder="Total"
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-xs font-semibold text-text-secondary">Formula</label>
                        <select
                          value={summaryRow.calculation}
                          onChange={e => updateTableSummaryRow(index, {
                            calculation: e.target.value as TableSummaryCalculation,
                          })}
                          className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs"
                        >
                          {TABLE_SUMMARY_CALCULATION_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <SelectSlot
                      label="Label Column"
                      value={summaryRow.labelColumn || ''}
                      options={tableSummaryLabelColumns}
                      placeholder="auto"
                      onChange={(value) => updateTableSummaryRow(index, { labelColumn: value || undefined })}
                    />

                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-text-secondary">Columns</span>
                        <div className="inline-flex rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-1">
                          <button
                            type="button"
                            onClick={() => toggleTableSummaryRowColumnMode(index, true)}
                            className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                              usesAllColumns ? 'bg-brand/10 text-brand' : 'text-text-tertiary hover:bg-surface-2'
                            }`}
                          >
                            All numeric
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleTableSummaryRowColumnMode(index, false)}
                            className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                              !usesAllColumns ? 'bg-brand/10 text-brand' : 'text-text-tertiary hover:bg-surface-2'
                            }`}
                          >
                            Pick columns
                          </button>
                        </div>
                      </div>

                      {!usesAllColumns && (
                        <div className="flex flex-wrap gap-1">
                          {tableNumericColumns.map((column) => {
                            const selected = summaryRow.columns?.includes(column.name);
                            return (
                              <button
                                key={`${summaryRow.label}-${column.name}`}
                                type="button"
                                onClick={() => toggleTableSummaryColumnSelection(index, column.name)}
                                title={column.name}
                                className={`rounded-full border px-2 py-1 text-[11px] font-medium transition-colors ${
                                  selected
                                    ? 'border-brand/30 bg-brand/10 text-brand'
                                    : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-tertiary hover:border-[rgb(var(--border-strong))]'
                                }`}
                              >
                                {colLabel(column)}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <button
            type="button"
            onClick={addTableSummaryRow}
            className="w-full rounded-md border border-dashed border-[rgb(var(--border-strong))] bg-surface-2 px-3 py-2 text-xs font-medium text-text-secondary hover:bg-surface-2"
          >
            + Add summary row
          </button>
        </Disclosure>
      )}

      {isTableLike && isHeatmapEnabled && tableNumericColumns.length > 0 && (
        <Disclosure
          title="Thang màu / Gradient (Color scale)"
          hint="Tô nền mỗi cột số chuyển sắc theo khoảng min–max của chính cột đó (đậm = cao, nhạt = thấp)."
          defaultOpen
        >
          {tableHeatmapRules.length > 0 && (
            <div className="space-y-3">
              {tableHeatmapRules.map((rule, index) => (
                <div
                  key={`table-heatmap-${index}`}
                  className="space-y-2.5 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
                      Heatmap {index + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeTableHeatmapRule(index)}
                      className="rounded p-1 text-text-quaternary hover:bg-surface-1 hover:text-danger"
                      title="Remove heatmap"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <SelectSlot
                    label="Column"
                    required
                    value={rule.field}
                    options={tableNumericColumns}
                    placeholder="select numeric column"
                    onChange={(value) => updateTableHeatmapRule(index, { field: value })}
                  />

                  <div>
                    <label className="mb-1 block text-xs font-semibold text-text-secondary">Bands</label>
                    <select
                      value={String(rule.steps ?? 5)}
                      onChange={e => updateTableHeatmapRule(index, { steps: Number(e.target.value) })}
                      className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs"
                    >
                      {TABLE_HEATMAP_STEP_OPTIONS.map((step) => (
                        <option key={step} value={step}>
                          {step} bands
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <ColorField
                      label="Low"
                      value={rule.minColor || '#eff6ff'}
                      onChange={(value) => updateTableHeatmapRule(index, { minColor: value })}
                    />
                    <ColorField
                      label="High"
                      value={rule.maxColor || '#1d4ed8'}
                      onChange={(value) => updateTableHeatmapRule(index, { maxColor: value })}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={addTableHeatmapRule}
            className="w-full rounded-md border border-dashed border-sky-300 bg-sky-50 px-3 py-2 text-xs font-medium text-sky-700 hover:bg-sky-100"
          >
            + Add heatmap column
          </button>
        </Disclosure>
      )}

      {isTableLike && isConditionalFormattingEnabled && tableFormattingColumns.length > 0 && (
        <Disclosure
          title="Định dạng theo điều kiện (Conditional formatting)"
          hint="Nhiều quy tắc chạy từ trên xuống, quy tắc khớp đầu tiên thắng. Mỗi quy tắc chọn kiểu (màu / thanh dữ liệu / icon), ngưỡng (giá trị / phân vị / % / cột khác), và có thể tô cột này dựa trên giá trị cột khác."
          defaultOpen
        >
          {tableConditionalFormatting.length > 0 && (
            <div className="space-y-3">
              {tableConditionalFormatting.map((rule, index) => {
                const benchmarkMode = getTableBenchmarkMode(rule);
                const ruleMode = rule.mode || 'color';
                return (
                  <div
                    key={`table-rule-${index}`}
                    className="space-y-2.5 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
                        Rule {index + 1}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeTableRule(index)}
                        className="rounded p-1 text-text-quaternary hover:bg-surface-1 hover:text-danger"
                        title="Remove rule"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {/* Feature #4 — presentation style */}
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-text-secondary">Kiểu định dạng</label>
                      <select
                        value={ruleMode}
                        onChange={e => updateTableRule(index, { mode: e.target.value as ConditionalFormatRule['mode'] })}
                        className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs"
                      >
                        {CF_MODE_OPTIONS.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </div>

                    <SelectSlot
                      label="Tô định dạng cho cột"
                      required
                      value={rule.field}
                      options={tableFormattingColumns}
                      placeholder="select column"
                      onChange={value => updateTableRule(index, { field: value })}
                    />

                    {/* Feature #3 — cross-column: condition can read another column */}
                    <div>
                      <label className="mb-1 block text-xs font-semibold text-text-secondary">
                        Dựa trên giá trị cột
                      </label>
                      <select
                        value={rule.sourceColumn ?? ''}
                        onChange={e => updateTableRule(index, { sourceColumn: e.target.value || undefined })}
                        className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs"
                      >
                        <option value="">(chính cột này)</option>
                        {tableFormattingColumns.map(c => (
                          <option key={c.name} value={c.name}>{c.label ?? c.name}</option>
                        ))}
                      </select>
                    </div>

                    {ruleMode === 'dataBar' ? (
                      // Data bars are column-wide (no condition): just a bar color.
                      <ColorField
                        label="Màu thanh"
                        value={rule.barColor || '#3b82f6'}
                        onChange={value => updateTableRule(index, { barColor: value })}
                      />
                    ) : (
                      <>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="mb-1 block text-xs font-semibold text-text-secondary">Toán tử</label>
                            <select
                              value={rule.operator}
                              onChange={e => updateTableRule(index, {
                                operator: e.target.value as ConditionalFormatRule['operator'],
                              })}
                              className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs"
                            >
                              {CONDITIONAL_OPERATOR_OPTIONS.map(option => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                              ))}
                            </select>
                          </div>

                          <div>
                            <label className="mb-1 block text-xs font-semibold text-text-secondary">Loại ngưỡng</label>
                            <select
                              value={benchmarkMode}
                              onChange={e => {
                                const nextMode = e.target.value as TableBenchmarkMode;
                                updateTableRule(index, nextMode === 'field'
                                  ? { benchmarkType: 'field', benchmarkField: rule.benchmarkField ?? tableBenchmarkColumns[0]?.name }
                                  : { benchmarkType: nextMode, benchmarkField: undefined });
                              }}
                              className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs"
                            >
                              {CF_BENCHMARK_OPTIONS.map(o => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                              ))}
                            </select>
                          </div>
                        </div>

                        {benchmarkMode === 'field' ? (
                          <SelectSlot
                            label="Cột so sánh"
                            required
                            value={rule.benchmarkField || ''}
                            options={tableBenchmarkColumns}
                            placeholder="select column"
                            onChange={value => updateTableRule(index, { benchmarkField: value || undefined })}
                          />
                        ) : (
                          <div>
                            <label className="mb-1 block text-xs font-semibold text-text-secondary">
                              {benchmarkMode === 'percentile' ? 'Phân vị (0–100)'
                                : benchmarkMode === 'percentage' ? '% của Max (0–100)'
                                : 'Ngưỡng'}
                            </label>
                            <input
                              type="text"
                              value={String(rule.value ?? '')}
                              onChange={e => updateTableRule(index, { value: e.target.value })}
                              placeholder={benchmarkMode === 'percentile' ? 'vd 90 = top 10%'
                                : benchmarkMode === 'percentage' ? 'vd 80 = ≥80% của Max'
                                : 'vd 1000'}
                              className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs"
                            />
                          </div>
                        )}

                        {ruleMode === 'icon' ? (
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="mb-1 block text-xs font-semibold text-text-secondary">Biểu tượng</label>
                              <select
                                value={rule.icon || 'flag'}
                                onChange={e => updateTableRule(index, { icon: e.target.value })}
                                className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs"
                              >
                                {CF_ICON_OPTIONS.map(o => (
                                  <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                              </select>
                            </div>
                            <ColorField
                              label="Màu icon"
                              value={rule.color || '#1f2937'}
                              onChange={value => updateTableRule(index, { color: value })}
                            />
                          </div>
                        ) : (
                          <div className="grid grid-cols-2 gap-2">
                            <ColorField
                              label="Màu nền"
                              value={rule.backgroundColor || '#dbeafe'}
                              onChange={value => updateTableRule(index, { backgroundColor: value })}
                            />
                            <ColorField
                              label="Màu chữ"
                              value={rule.color || '#1f2937'}
                              onChange={value => updateTableRule(index, { color: value })}
                            />
                          </div>
                        )}

                        {benchmarkMode !== 'field' && String(rule.value ?? '').trim() === '' && (
                          <p className="text-[11px] text-warning">
                            Nhập ngưỡng để kích hoạt quy tắc này.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <button
            type="button"
            onClick={addTableRule}
            className="w-full rounded-md border border-dashed border-brand/40 bg-brand/10 px-3 py-2 text-xs font-medium text-brand hover:bg-brand/15"
          >
            + Add rule
          </button>

        </Disclosure>
      )}

        </SectionPanel>
      )}

      {!isStyleOnly && chartType === 'KPI' && (
        <SectionPanel
          step="Step 2"
          title="Data Binding"
          description="Pick the KPI value first, then add an optional benchmark metric if the card should compare against live data."
        >
          <Disclosure title={chartBindingTitle} hint={chartRoleSectionHint} defaultOpen>
            <MetricSlot label="Value" required single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols} declaredMeasureRefs={declaredMeasureRefs}
              onChange={v => upd({ metrics: v })} />
            <MetricSlot label="Benchmark Metric" hint="In Custom SQL mode, choose a second numeric SQL output column. Use {benchmark}, {delta}, or {deltaPercent} in the Context Template." single value={benchmarkMetric} options={numOrAll} allOptions={allCols} declaredMeasureRefs={declaredMeasureRefs}
              onChange={v => upd({ benchmarkMetric: v[0] || undefined })} />
          </Disclosure>
        </SectionPanel>
      )}

      {chartType === 'KPI' && (
        <SectionPanel
          step={kpiSetupStep}
          title="Card Setup"
          description="Shape the KPI card after choosing its value and optional benchmark metric."
        >
        <Disclosure title="Card Details" hint="Make the KPI card smarter with labels, context, benchmark, and value rules." defaultOpen>
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">Card Label</label>
            <input
              type="text"
              value={normalizedStyleConfig.kpiLabel || ''}
              placeholder="Use metric label"
              onChange={e => updStyle({ kpiLabel: e.target.value })}
              className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md"
            />
          </div>

          <div>
            <label className="flex items-center gap-1 text-xs font-semibold text-text-secondary mb-1">
              Context Template
              <HelpTooltip text="Use tokens like {value}, {benchmark}, {delta}, {deltaPercent}, {benchmarkLabel}, {label}, {rows}, {rawValue}. If Benchmark Metric is set, the card uses that dynamic value before the manual benchmark value." />
            </label>
            <textarea
              value={normalizedStyleConfig.kpiContextTemplate || ''}
              placeholder="Example: {delta} above {benchmarkLabel} {benchmark}"
              onChange={e => updStyle({ kpiContextTemplate: e.target.value })}
              rows={3}
              className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md resize-none"
            />
            <div className="mt-2 flex flex-wrap gap-1">
              {KPI_TEMPLATE_TOKENS.map((token) => (
                <button
                  key={token}
                  type="button"
                  onClick={() => updStyle({
                    kpiContextTemplate: `${normalizedStyleConfig.kpiContextTemplate || ''}${token}`,
                  })}
                  className="rounded-full border border-brand/30 bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand hover:bg-brand/15"
                >
                  {token}
                </button>
              ))}
            </div>
          </div>

          <p className="text-[11px] leading-4 text-text-tertiary">
            Benchmark ĐỘNG: đặt <span className="font-semibold">Target</span> ở phần Field Roles (một chỉ số) —
            benchmark tự tính theo dữ liệu &amp; bộ lọc. Nếu không có Target thì dùng giá trị thủ công dưới đây.
            Công thức bên dưới áp cho CẢ hai: <span className="font-mono">benchmark × hệ số + cộng thêm</span> (vd × 1.1 = vượt mục tiêu 10%).
          </p>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1 block">Benchmark thủ công (giá trị)</label>
              <input
                type="number"
                value={normalizedStyleConfig.kpiBenchmarkValue ?? ''}
                placeholder="Tùy chọn (nếu không đặt Target)"
                onChange={e => updStyle({
                  kpiBenchmarkValue: e.target.value === '' ? '' : Number(e.target.value),
                })}
                className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1 block">Nhãn benchmark</label>
              <input
                type="text"
                value={normalizedStyleConfig.kpiBenchmarkLabel || ''}
                placeholder="Target"
                onChange={e => updStyle({ kpiBenchmarkLabel: e.target.value })}
                className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1 block">Hệ số nhân (×)</label>
              <input
                type="number"
                step="0.01"
                value={normalizedStyleConfig.kpiBenchmarkMultiplier ?? ''}
                placeholder="1 (vd 1.1 = +10%)"
                onChange={e => updStyle({ kpiBenchmarkMultiplier: e.target.value === '' ? '' : Number(e.target.value) })}
                className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1 block">Cộng thêm (+)</label>
              <input
                type="number"
                value={normalizedStyleConfig.kpiBenchmarkOffset ?? ''}
                placeholder="0"
                onChange={e => updStyle({ kpiBenchmarkOffset: e.target.value === '' ? '' : Number(e.target.value) })}
                className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md"
              />
            </div>
          </div>


          <Toggle
            label="Show benchmark value block"
            checked={normalizedStyleConfig.kpiShowBenchmarkValue ?? true}
            onChange={v => updStyle({ kpiShowBenchmarkValue: v })}
          />

          <Toggle
            label="Show delta vs benchmark"
            checked={normalizedStyleConfig.kpiShowDelta ?? true}
            onChange={v => updStyle({ kpiShowDelta: v })}
          />

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1 block">Goal Direction</label>
              <select
                value={normalizedStyleConfig.kpiGoalDirection || 'up'}
                onChange={e => updStyle({ kpiGoalDirection: e.target.value as KpiGoalDirection })}
                className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1"
              >
                {KPI_GOAL_DIRECTION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>

            <ColorField
              label="Accent Color"
              value={normalizedStyleConfig.kpiAccentColor || '#2563eb'}
              onChange={value => updStyle({ kpiAccentColor: value })}
            />
          </div>

          <Toggle
            label="Value color rules"
            checked={normalizedStyleConfig.kpiEnableColorRules ?? false}
            onChange={(enabled) => updStyle({
              kpiEnableColorRules: enabled,
              kpiColorRules: enabled
                ? (normalizedStyleConfig.kpiColorRules?.length
                    ? normalizedStyleConfig.kpiColorRules
                    : [createDefaultKpiColorRule()])
                : (normalizedStyleConfig.kpiColorRules ?? []),
            })}
          />

          {normalizedStyleConfig.kpiEnableColorRules && (
            <div className="space-y-2">
              {(normalizedStyleConfig.kpiColorRules ?? []).map((rule, index) => (
                <div key={`kpi-rule-${index}`} className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2/80 p-2 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
                      Rule {index + 1}
                    </div>
                    <button
                      type="button"
                      onClick={() => updStyle({
                        kpiColorRules: (normalizedStyleConfig.kpiColorRules ?? []).filter((_, ruleIndex) => ruleIndex !== index),
                      })}
                      className="rounded p-1 text-text-quaternary hover:bg-surface-1 hover:text-danger"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>

                  <div className="grid grid-cols-[96px_1fr] gap-2">
                    <div>
                      <label className="text-[11px] font-semibold text-text-tertiary mb-1 block">Toán tử</label>
                      <select
                        value={rule.operator}
                        onChange={e => updStyle({
                          kpiColorRules: (normalizedStyleConfig.kpiColorRules ?? []).map((currentRule, ruleIndex) => (
                            ruleIndex === index
                              ? { ...currentRule, operator: e.target.value as KpiValueColorRule['operator'] }
                              : currentRule
                          )),
                        })}
                        className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1"
                      >
                        {CONDITIONAL_OPERATOR_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-[11px] font-semibold text-text-tertiary mb-1 block">Nguồn ngưỡng</label>
                      <select
                        value={rule.source === 'benchmark' ? 'benchmark' : 'value'}
                        onChange={e => updStyle({
                          kpiColorRules: (normalizedStyleConfig.kpiColorRules ?? []).map((currentRule, ruleIndex) => (
                            ruleIndex === index
                              ? { ...currentRule, source: e.target.value === 'benchmark' ? 'benchmark' : 'value' }
                              : currentRule
                          )),
                        })}
                        className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1"
                      >
                        <option value="value">Giá trị cố định</option>
                        <option value="benchmark">So với Target / Benchmark</option>
                      </select>
                    </div>
                  </div>

                  {rule.source === 'benchmark' ? (
                    <div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[11px] font-semibold text-text-tertiary mb-1 block">× Hệ số</label>
                          <input
                            type="number"
                            step="any"
                            value={rule.multiplier ?? 1}
                            placeholder="1"
                            onChange={e => updStyle({
                              kpiColorRules: (normalizedStyleConfig.kpiColorRules ?? []).map((currentRule, ruleIndex) => (
                                ruleIndex === index
                                  ? { ...currentRule, multiplier: e.target.value === '' ? undefined : Number(e.target.value) }
                                  : currentRule
                              )),
                            })}
                            className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] font-semibold text-text-tertiary mb-1 block">+ Cộng thêm</label>
                          <input
                            type="number"
                            step="any"
                            value={rule.offset ?? 0}
                            placeholder="0"
                            onChange={e => updStyle({
                              kpiColorRules: (normalizedStyleConfig.kpiColorRules ?? []).map((currentRule, ruleIndex) => (
                                ruleIndex === index
                                  ? { ...currentRule, offset: e.target.value === '' ? undefined : Number(e.target.value) }
                                  : currentRule
                              )),
                            })}
                            className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1"
                          />
                        </div>
                      </div>
                      <p className="mt-1 text-[10px] leading-tight text-text-quaternary">
                        Ngưỡng = Target/Benchmark × Hệ số + Cộng thêm. Ví dụ × 0.9 = 90% mục tiêu.
                      </p>
                    </div>
                  ) : (
                    <div>
                      <label className="text-[11px] font-semibold text-text-tertiary mb-1 block">Giá trị</label>
                      <input
                        type="number"
                        value={rule.value}
                        onChange={e => updStyle({
                          kpiColorRules: (normalizedStyleConfig.kpiColorRules ?? []).map((currentRule, ruleIndex) => (
                            ruleIndex === index
                              ? { ...currentRule, value: Number(e.target.value || 0) }
                              : currentRule
                          )),
                        })}
                        className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1"
                      />
                    </div>
                  )}

                  <div>
                    <label className="text-[11px] font-semibold text-text-tertiary mb-1 block">Status Label</label>
                    <input
                      type="text"
                      value={rule.label || ''}
                      placeholder="Optional badge text"
                      onChange={e => updStyle({
                        kpiColorRules: (normalizedStyleConfig.kpiColorRules ?? []).map((currentRule, ruleIndex) => (
                          ruleIndex === index
                            ? { ...currentRule, label: e.target.value }
                            : currentRule
                        )),
                      })}
                      className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1"
                    />
                  </div>

                  <ColorField
                    label="Value Color"
                    value={rule.color}
                    onChange={value => updStyle({
                      kpiColorRules: (normalizedStyleConfig.kpiColorRules ?? []).map((currentRule, ruleIndex) => (
                        ruleIndex === index
                          ? { ...currentRule, color: value }
                          : currentRule
                      )),
                    })}
                  />
                </div>
              ))}

              <button
                type="button"
                onClick={() => updStyle({
                  kpiColorRules: [
                    ...(normalizedStyleConfig.kpiColorRules ?? []),
                    createDefaultKpiColorRule((normalizedStyleConfig.kpiColorRules ?? []).length),
                  ],
                })}
                className="w-full rounded-md border border-dashed border-[rgb(var(--border-strong))] px-3 py-2 text-xs font-medium text-text-tertiary hover:border-[rgb(var(--border-strong))] hover:text-text-secondary"
              >
                + Add Color Rule
              </button>
            </div>
          )}
        </Disclosure>
        </SectionPanel>
      )}

      {!isStyleOnly && !isTableLike && chartType !== 'KPI' && (
        <SectionPanel
          step="Step 2"
          title="Data Binding"
          description="Map the minimum fields first so the chart becomes valid, then add optional roles like breakdown."
        >
        <Disclosure title={chartBindingTitle} hint={chartRoleSectionHint} defaultOpen>

          {(chartType === 'BAR' || chartType === 'HORIZONTAL_BAR') && <>
            <SelectSlot label={chartType === 'HORIZONTAL_BAR' ? 'Y Axis' : 'X Axis'} hint="group by" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <DrillDownButtons
              currentDim={dim || undefined}
              childrenMap={dimChildrenMap}
              onDrill={(child) => upd({ dimension: child })} />
            {dimIsTime && (
              <TimeGrainSlot
                fieldName={dim || undefined}
                value={dim ? normalizedRoleConfig.timeGrains?.[dim] : undefined}
                onChange={(g) => setGrain(dim || undefined, g)} />
            )}
            <MetricSlot label={chartType === 'HORIZONTAL_BAR' ? 'Values (X)' : 'Values (Y)'} required value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols} declaredMeasureRefs={declaredMeasureRefs} allowRunningTotal={!!dim}
              onChange={v => upd({ metrics: v })} />
          </>}

          {chartType === 'GROUPED_BAR' && <>
            <SelectSlot label="X Axis" hint="group by" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Value (Y)" required single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols} declaredMeasureRefs={declaredMeasureRefs}
              onChange={v => upd({ metrics: v })} />
            <SelectSlot label="Breakdown" hint="grouped by" required value={brk} options={dimOrAll}
              placeholder="select field"
              onChange={v => upd({ breakdown: v || undefined })} />
          </>}

          {chartType === 'STACKED_BAR' && <>
            <SelectSlot label="X Axis" hint="group by" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Value (Y)" required single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols} declaredMeasureRefs={declaredMeasureRefs}
              onChange={v => upd({ metrics: v })} />
            <SelectSlot label="Breakdown" hint="stack by" required value={brk} options={dimOrAll}
              placeholder="select field"
              onChange={v => upd({ breakdown: v || undefined })} />
          </>}

          {chartType === 'BAR_LINE' && <>
            <SelectSlot label="X Axis" hint="group by" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Bar Values" hint="shown as bars" required value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols} declaredMeasureRefs={declaredMeasureRefs} allowRunningTotal={!!dim}
              onChange={v => upd({ metrics: v })} />
            <MetricSlot label="Line Value" hint="shown as line" required single value={lineMetric} options={numOrAll} allOptions={allCols} declaredMeasureRefs={declaredMeasureRefs}
              onChange={v => upd({ lineMetric: v[0], breakdown: undefined })} />
          </>}


          {chartType === 'LINE' && <>
            <SelectSlot label="X Axis" required value={dim} options={allCols}
              onChange={v => upd({ dimension: v || undefined })} />
            <DrillDownButtons
              currentDim={dim || undefined}
              childrenMap={dimChildrenMap}
              onDrill={(child) => upd({ dimension: child })} />
            {dimIsTime && (
              <TimeGrainSlot
                fieldName={dim || undefined}
                value={dim ? normalizedRoleConfig.timeGrains?.[dim] : undefined}
                onChange={(g) => setGrain(dim || undefined, g)} />
            )}
            <MetricSlot label="Values (Y)" required value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols} declaredMeasureRefs={declaredMeasureRefs} allowRunningTotal={!!dim}
              onChange={v => upd({ metrics: v })} />
            <SelectSlot label="Breakdown" hint="optional" value={brk} options={dimOrAll}
              placeholder="none"
              onChange={v => upd({ breakdown: v || undefined })} />
          </>}

          {chartType === 'AREA' && <>
            <SelectSlot label="X Axis" required value={dim} options={allCols}
              onChange={v => upd({ dimension: v || undefined })} />
            <DrillDownButtons
              currentDim={dim || undefined}
              childrenMap={dimChildrenMap}
              onDrill={(child) => upd({ dimension: child })} />
            {dimIsTime && (
              <TimeGrainSlot
                fieldName={dim || undefined}
                value={dim ? normalizedRoleConfig.timeGrains?.[dim] : undefined}
                onChange={(g) => setGrain(dim || undefined, g)} />
            )}
            <MetricSlot label="Values (Y)" required value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols} declaredMeasureRefs={declaredMeasureRefs} allowRunningTotal={!!dim}
              onChange={v => upd({ metrics: v })} />
            <SelectSlot label="Breakdown" hint="optional" value={brk} options={dimOrAll}
              placeholder="none"
              onChange={v => upd({ breakdown: v || undefined })} />
          </>}

          {chartType === 'TIME_SERIES' && <>
            <SelectSlot label="Time Field (X)" required value={tf} options={timeOrAll}
              placeholder="select time field"
              onChange={v => upd({ timeField: v || undefined })} />
            <TimeGrainSlot
              fieldName={tf || undefined}
              value={tf ? normalizedRoleConfig.timeGrains?.[tf] : undefined}
              onChange={(g) => setGrain(tf || undefined, g)} />
            <MetricSlot label="Values (Y)" required value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols} declaredMeasureRefs={declaredMeasureRefs} allowRunningTotal={!!tf}
              onChange={v => upd({ metrics: v })} />
            <SelectSlot label="Breakdown" hint="optional" value={brk} options={dimOrAll}
              placeholder="none"
              onChange={v => upd({ breakdown: v || undefined })} />
          </>}

          {isPieLike && <>
            <SelectSlot label="Legend" hint="slice label" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Value" hint="slice size" required single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols} declaredMeasureRefs={declaredMeasureRefs}
              onChange={v => upd({ metrics: v })} />
          </>}

          {chartType === 'RADAR' && <>
            <SelectSlot label="Axis" hint="category" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Values" required value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols} declaredMeasureRefs={declaredMeasureRefs}
              onChange={v => upd({ metrics: v })} />
          </>}

          {isScatterLike && <>
            {/* NINE_BOX accepts numeric (→ tertile) OR categorical (→ 3-level)
                axes. When the picked axis is NUMERIC it should aggregate per
                Label exactly like BUBBLE, so we expose the X/Y AGGREGATION
                dropdown and auto-set scatter*Agg='sum' (the BE reads that as the
                "numeric axis → aggregate" signal). A categorical pick clears the
                agg so the BE keeps it as a GROUP BY dimension. */}
            <SelectSlot label="X Axis" hint={chartType === 'BUBBLE' ? 'numeric — aggregated per Label' : chartType === 'NINE_BOX' ? 'numeric → tertile, or 3-level category' : 'numeric'} required value={sx} options={chartType === 'NINE_BOX' ? allCols : numOrAll}
              placeholder="select X"
              onChange={v => upd(
                chartType === 'NINE_BOX'
                  ? { scatterX: v || undefined, scatterXAgg: (v && numCols.some(c => c.name === v)) ? (normalizedRoleConfig.scatterXAgg || 'sum') : undefined }
                  : { scatterX: v || undefined }
              )} />
            {sx && sxIsMeasure ? (
              <AxisMeasureAggHint axis="X" />
            ) : (chartType === 'BUBBLE' || (chartType === 'NINE_BOX' && !!sx && numCols.some(c => c.name === sx))) && sx ? (
              <ScatterAxisAgg axis="X" value={(normalizedRoleConfig.scatterXAgg as AggFn) || 'sum'}
                onChange={v => upd({ scatterXAgg: v })} />
            ) : null}
            <SelectSlot label="Y Axis" hint={chartType === 'BUBBLE' ? 'numeric — aggregated per Label' : chartType === 'NINE_BOX' ? 'numeric → tertile, or 3-level category' : 'numeric'} required value={sy} options={chartType === 'NINE_BOX' ? allCols : numOrAll}
              placeholder="select Y"
              onChange={v => upd(
                chartType === 'NINE_BOX'
                  ? { scatterY: v || undefined, scatterYAgg: (v && numCols.some(c => c.name === v)) ? (normalizedRoleConfig.scatterYAgg || 'sum') : undefined }
                  : { scatterY: v || undefined }
              )} />
            {sy && syIsMeasure ? (
              <AxisMeasureAggHint axis="Y" />
            ) : (chartType === 'BUBBLE' || (chartType === 'NINE_BOX' && !!sy && numCols.some(c => c.name === sy))) && sy ? (
              <ScatterAxisAgg axis="Y" value={(normalizedRoleConfig.scatterYAgg as AggFn) || 'sum'}
                onChange={v => upd({ scatterYAgg: v })} />
            ) : null}
            <SelectSlot label="Label" hint={chartType === 'BUBBLE' ? 'group into one bubble per value' : chartType === 'NINE_BOX' ? 'item plotted in each cell' : 'optional'} value={dim} options={dimOrAll}
              placeholder="none"
              onChange={v => upd({ dimension: v || undefined })} />
            {chartType === 'BUBBLE' && (
              <MetricSlot label="Size" hint="bubble radius" required single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols} declaredMeasureRefs={declaredMeasureRefs}
                onChange={v => upd({ metrics: v })} />
            )}
            {(chartType === 'MAP_POINT' || chartType === 'NINE_BOX') && (
              <MetricSlot label="Size" hint="optional" single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols} declaredMeasureRefs={declaredMeasureRefs}
                onChange={v => upd({ metrics: v })} />
            )}
          </>}

          {['FUNNEL', 'TREEMAP', 'WATERFALL', 'MAP_REGION', 'WORD_CLOUD', 'BOXPLOT'].includes(chartType) && <>
            <SelectSlot label="Category" hint="group by" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Value" required single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols} declaredMeasureRefs={declaredMeasureRefs}
              onChange={v => upd({ metrics: v })} />
          </>}

          {['HEATMAP', 'SANKEY', 'SUNBURST'].includes(chartType) && <>
            <SelectSlot label="Source" hint="first dimension" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <SelectSlot label="Target" hint="second dimension" required value={brk} options={dimOrAll}
              onChange={v => upd({ breakdown: v || undefined })} />
            <MetricSlot label="Value" required single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols} declaredMeasureRefs={declaredMeasureRefs}
              onChange={v => upd({ metrics: v })} />
          </>}

          {chartType === 'RIBBON' && <>
            <SelectSlot label="Time Field" required value={tf} options={timeOrAll}
              placeholder="select time field"
              onChange={v => upd({ timeField: v || undefined, dimension: v || undefined })} />
            <TimeGrainSlot
              fieldName={tf || undefined}
              value={tf ? normalizedRoleConfig.timeGrains?.[tf] : undefined}
              onChange={(g) => setGrain(tf || undefined, g)} />
            <SelectSlot label="Ribbon" hint="ranked series" required value={brk} options={dimOrAll}
              onChange={v => upd({ breakdown: v || undefined })} />
            <MetricSlot label="Value" required single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols} declaredMeasureRefs={declaredMeasureRefs}
              onChange={v => upd({ metrics: v })} />
          </>}

          {chartType === 'TIMELINE' && <>
            <SelectSlot label="Time Field" required value={tf} options={timeOrAll}
              placeholder="select time field"
              onChange={v => upd({ timeField: v || undefined })} />
            <TimeGrainSlot
              fieldName={tf || undefined}
              value={tf ? normalizedRoleConfig.timeGrains?.[tf] : undefined}
              onChange={(g) => setGrain(tf || undefined, g)} />
            <SelectSlot label="Label" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Value" hint="optional duration or size" single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols} declaredMeasureRefs={declaredMeasureRefs}
              onChange={v => upd({ metrics: v })} />
          </>}

          {['GAUGE', 'BULLET'].includes(chartType) && <>
            <MetricSlot label="Value" required single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols} declaredMeasureRefs={declaredMeasureRefs}
              onChange={v => upd({ metrics: v })} />
            <MetricSlot label="Target — Benchmark động (chỉ số)" hint="Chọn 1 chỉ số làm benchmark động (tự tính theo dữ liệu + bộ lọc). Áp công thức ×/+ ở phần KPI để đặt vd Goal × 1.1." single value={benchmarkMetric} options={numOrAll} allOptions={allCols} declaredMeasureRefs={declaredMeasureRefs}
              onChange={v => upd({ benchmarkMetric: v[0] })} />
          </>}

          {chartType === 'PODIUM' && <>
            <SelectSlot label="Rank Name" hint="category" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Rank Value" required single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols} declaredMeasureRefs={declaredMeasureRefs}
              onChange={v => upd({ metrics: v })} />
          </>}

        </Disclosure>
        </SectionPanel>
      )}

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Appearance: General ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      {/* Phase-15.92 — Format pane (PowerBI-style). Merges what used to be
          two SectionPanels ("Quick View" + "Advanced") into a single
          "Format" panel with 3 collapsible FormatGroups: Visual / Axes &
          Scale / Advanced. The "Most-used Settings" inner Disclosure was
          removed — its content lives directly under the Visual group. */}
      {showQuickView && (
        <SectionPanel
          step={quickViewStep}
          title={t('explore.config.format')}
          description={t('explore.config.formatDescription')}
        >
        {/* Phase-15.92 v2 — search box. Style aligned with the surface-1
            inputs used throughout the panel (border-strong + bg-surface-1
            + same py / text size as other text inputs). */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-quaternary pointer-events-none" />
          <input
            type="text"
            value={formatSearch}
            onChange={e => setFormatSearch(e.target.value)}
            placeholder={t('explore.config.searchSettingsPlaceholder')}
            className="w-full pl-8 pr-8 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1 placeholder:text-text-quaternary focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand/40 transition-colors"
          />
          {formatSearch && (
            <button
              type="button"
              onClick={() => setFormatSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-text-quaternary hover:text-text-secondary rounded"
              title={t('explore.config.clearSearch')}
              aria-label={t('explore.config.clearSearch')}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        <FormatGroup
          title={t('explore.config.visual')}
          defaultOpen
          matchesSearch={matchesFormatSearch(['visual', 'chart title', 'color palette', 'series colors', 'legend labels', 'rename', 'label', 'number format', 'legend', 'data labels', 'font', 'font size', 'donut', 'stack mode'])}
          searchActive={formatSearchActive}
          hasCustomization={Boolean(
            styleConfig.chartTitle || styleConfig.palette || styleConfig.seriesColors || styleConfig.seriesLabels ||
            styleConfig.numberFormat || styleConfig.legendPosition ||
            styleConfig.dataLabelConfig?.enabled || styleConfig.dataLabelConfig?.format || styleConfig.showDataLabels ||
            styleConfig.pieInnerRadius || styleConfig.stackMode === 'percent' ||
            (chartType === 'HEATMAP' && (styleConfig.fontSize ?? DEFAULT_STYLE_CONFIG.fontSize) !== DEFAULT_STYLE_CONFIG.fontSize)
          )}
        >
          {/* Color palette ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â compact horizontal row */}
          {/* Chart Title */}
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">{t('explore.config.chartTitle')}</label>
            <input type="text" value={styleConfig.chartTitle || ''} placeholder={t('explore.config.optionalTitle')}
              onChange={e => updStyle({ chartTitle: e.target.value })}
              className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md" />
          </div>

          {/* PIE: donut hole slider */}
          {isPieLike && (
            <div>
              {/* DONUT defaults to a real hole (55%) even when unset, mirroring
                  the renderer — otherwise the slider reads "0% (Pie)" while the
                  chart shows a donut. */}
              <label className="text-xs font-semibold text-text-secondary mb-1 block">
                {t('explore.config.donutHole', { value: styleConfig.pieInnerRadius ?? (chartType === 'DONUT' ? 55 : 0) })}
                <span className="ml-1 font-normal text-text-quaternary">({(styleConfig.pieInnerRadius ?? (chartType === 'DONUT' ? 55 : 0)) === 0 ? t('explore.config.pie') : t('explore.config.donut')})</span>
              </label>
              <input type="range" min={0} max={80} step={5} value={styleConfig.pieInnerRadius ?? (chartType === 'DONUT' ? 55 : 0)}
                onChange={e => updStyle({ pieInnerRadius: Number(e.target.value) })}
                className="w-full h-1.5 bg-surface-3 rounded-lg accent-blue-500 cursor-pointer" />
            </div>
          )}

          {/* STACKED_BAR: 100% stack mode */}
          {chartType === 'STACKED_BAR' && (
            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1 block">{t('explore.config.stackMode')}</label>
              <select value={styleConfig.stackMode || 'normal'}
                onChange={e => updStyle({ stackMode: e.target.value as 'normal' | 'percent' })}
                className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1">
                <option value="normal">{t('explore.config.stackNormal')}</option>
                <option value="percent">{t('explore.config.stackPercent')}</option>
              </select>
            </div>
          )}

          {/* Phase-15.92 — compact Color Palette: dropdown + inline
              swatch preview of the currently-selected palette. The old
              5-card layout took ~30% of the panel's height for a one-off
              pick; dropdown collapses it to one row while still showing
              the colours. Style matches the other selects in the panel
              (border-strong + bg-surface-1 + same px-2 py-1.5 text-xs). */}
          {(() => {
            const activePaletteName = styleConfig.palette || 'default';
            const activePalette = CHART_PALETTES.find(p => p.name === activePaletteName) ?? CHART_PALETTES[0];
            return (
              <div>
                <label className="text-xs font-semibold text-text-secondary mb-1 block">{t('explore.config.colorPalette')}</label>
                <div className="flex items-center gap-2">
                  <select
                    value={activePaletteName}
                    onChange={e => updStyle({ palette: e.target.value as ChartPaletteName })}
                    className="flex-1 px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1"
                  >
                    {CHART_PALETTES.map(p => (
                      <option key={p.name} value={p.name}>{p.label}</option>
                    ))}
                  </select>
                  <div
                    className="flex shrink-0 items-center gap-0.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-1 px-1.5 py-1"
                    title={t('explore.config.palettePreview', { name: activePalette.label })}
                  >
                    {activePalette.colors.slice(0, 5).map((c, i) => (
                      <div
                        key={i}
                        className="h-3.5 w-3.5 rounded-sm"
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Per-series color overrides (visible when chart has identifiable series).
              Phase-15.82 bugfix — DA reported the list rendering raw timestamps
              (`2025-08-01T00:00:00`) and the same label thrice ("Sales hunt × 3")
              when picking the wrong PIE dimension. Mitigations:
                1. Defensive dedupe in case upstream forgot.
                2. Cap visible rows so a high-cardinality dimension doesn't
                   produce a 100-line scrollable list (with an "Show more"
                   affordance).
                3. Heads-up hint when a row label looks like a raw timestamp
                   (DA picked a datetime column as the legend dimension by
                   accident). */}
          {chartType === 'GAUGE' && (
            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1 block">{t('explore.config.dataLabelFormat')}</label>
              <select
                value={styleConfig.dataLabelConfig?.format ?? ''}
                onChange={(e) => {
                  const next = e.target.value;
                  const dlc = styleConfig.dataLabelConfig ?? {};
                  updStyle({
                    dataLabelConfig: {
                      ...dlc,
                      format: next === '' ? undefined : (next as NumberFormat),
                    },
                  });
                }}
                className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1"
              >
                <option value="">{t('explore.config.inheritNumberFormat')}</option>
                <option value="auto">{t('explore.config.formatAuto')}</option>
                <option value="compact">{t('explore.config.formatCompact')}</option>
                <option value="number">{t('explore.config.formatNumber')}</option>
                <option value="percent">{t('explore.config.formatPercent')}</option>
                <option value="currency">{t('explore.config.formatCurrency')}</option>
              </select>
            </div>
          )}

          {!isTableLike && availableSeriesKeys.length > 0 && (
            <SeriesColorsEditor
              availableSeriesKeys={availableSeriesKeys}
              palette={styleConfig.palette || 'default'}
              seriesColors={styleConfig.seriesColors}
              onChange={(next) => updStyle({ seriesColors: next })}
            />
          )}

          {!isTableLike && availableSeriesKeys.length > 0 && (
            <SeriesLabelsEditor
              availableSeriesKeys={availableSeriesKeys}
              seriesLabels={styleConfig.seriesLabels}
              onChange={(next) => updStyle({ seriesLabels: next })}
            />
          )}

          {/* Phase-15.92 — Number Format moved up from end of panel so
              the basic display unit setting sits next to other common
              controls instead of below the Advanced cluster. */}
          {chartType === 'HEATMAP' && (
            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1 block">{t('explore.config.fontSize', { value: styleConfig.fontSize || 12 })}</label>
              <input
                type="range"
                min={8}
                max={22}
                step={1}
                value={styleConfig.fontSize || 12}
                onChange={e => updStyle({ fontSize: Number(e.target.value) })}
                className="w-full h-1.5 bg-surface-3 rounded-lg accent-blue-500 cursor-pointer"
              />
            </div>
          )}

          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">{t('explore.config.numberFormat')}</label>
            <select value={styleConfig.numberFormat || 'compact'}
              onChange={e => updStyle({ numberFormat: e.target.value as NumberFormat })}
              className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1">
              <option value="auto">{t('explore.config.formatAuto')}</option>
              <option value="compact">{t('explore.config.formatCompact')}</option>
              <option value="number">{t('explore.config.formatNumber')}</option>
              <option value="percent">{t('explore.config.formatPercent')}</option>
              <option value="currency">{t('explore.config.formatCurrency')}</option>
            </select>
          </div>

          {/* Phase-15.92 — Legend moved up alongside Number Format. */}
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">{t('explore.config.legend')}</label>
            <select value={styleConfig.legendPosition || 'bottom'}
              onChange={e => updStyle({ legendPosition: e.target.value as LegendPosition })}
              className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1">
              <option value="top">{t('explore.config.legendTop')}</option>
              <option value="bottom">{t('explore.config.legendBottom')}</option>
              <option value="left">{t('explore.config.legendLeft')}</option>
              <option value="right">{t('explore.config.legendRight')}</option>
              <option value="none">{t('explore.config.legendHidden')}</option>
            </select>
          </div>
        </FormatGroup>

        {/* Phase-15.92 — Advanced group. Replaces the old "Show advanced
            tools" button. Default collapsed so first-time DA sees a clean
            panel; power users expand once and the FormatGroup state
            persists for the editor session. Contains the power-user
            disclosures: Series mix, Per-series fmt, Tooltip extras,
            Annotations, Conditional colors, Calc fields, Data Labels. */}
        <FormatGroup
          title={t('explore.config.advanced')}
          defaultOpen={false}
          matchesSearch={matchesFormatSearch(['advanced', 'series mix', 'per-series', 'tooltip', 'annotation', 'conditional', 'calculated', 'data label', 'template', 'value format', 'format', 'currency', 'percent', 'decimal'])}
          searchActive={formatSearchActive}
          hasCustomization={Boolean(
            (styleConfig.seriesRenderAs && Object.keys(styleConfig.seriesRenderAs).length > 0) ||
            (styleConfig.seriesFormats && Object.keys(styleConfig.seriesFormats).length > 0) ||
            (styleConfig.tooltipExtraFields && styleConfig.tooltipExtraFields.length > 0) ||
            styleConfig.dataLabelTemplate ||
            (styleConfig.annotations && styleConfig.annotations.length > 0) ||
            (styleConfig.seriesConditionalRules && styleConfig.seriesConditionalRules.length > 0) ||
            (styleConfig.calculatedFields && styleConfig.calculatedFields.length > 0)
          )}
        >
          <>
            {/* Phase-15.92 — Data Labels moved here (was after the Advanced
                button). Keeping it in Advanced means default Visual stays
                minimal; DA who wants labels opens Advanced once. */}
          {/* Phase-15.82 — free-form series mix (BAR_LINE only) */}
          {chartType === 'BAR_LINE' && availableSeriesKeys.length > 0 && (
            <Disclosure
              title="Series mix (free-form)"
              hint="Render each BAR_LINE series as a bar / line / area independently. Leave on (default) to keep the legacy bars + line layout."
            >
            <div>
              <div className="space-y-1.5">
                {availableSeriesKeys.map(({ key, label }) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="flex-1 truncate text-xs text-text-secondary" title={label}>
                      {label}
                    </span>
                    <select
                      value={styleConfig.seriesRenderAs?.[key] ?? ''}
                      onChange={(e) => {
                        const next = { ...(styleConfig.seriesRenderAs ?? {}) };
                        if (e.target.value === '') {
                          delete next[key];
                        } else {
                          next[key] = e.target.value as 'bar' | 'line' | 'area';
                        }
                        updStyle({ seriesRenderAs: Object.keys(next).length === 0 ? undefined : next });
                      }}
                      className="px-1.5 py-1 text-[11px] border border-[rgb(var(--border-line))] rounded bg-surface-1"
                    >
                      <option value="">(default)</option>
                      <option value="bar">Bar</option>
                      <option value="line">Line</option>
                      <option value="area">Area</option>
                    </select>
                  </div>
                ))}
              </div>
              <p className="mt-1 text-[10px] text-text-quaternary">
                Override per-series render type. Leaving all on (default) keeps the legacy bars + line metric layout.
              </p>
            </div>
            </Disclosure>
          )}

          {/* Phase-15.82 — per-series number format. Lets DA mix % and currency
              series in one chart. Empty = inherit global numberFormat. */}
          {!isTableLike && availableSeriesKeys.length > 0 && (
            <Disclosure
              title="Per-series number format"
              hint="Override the chart's global Number Format on a per-series basis. Example: bar series in VND, line series in %. Falls back to the chart's global format when blank."
            >
            <div>
              <div className="space-y-1.5">
                {availableSeriesKeys.map(({ key, label }) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="flex-1 truncate text-xs text-text-secondary" title={label}>
                      {label}
                    </span>
                    <select
                      value={styleConfig.seriesFormats?.[key] ?? ''}
                      onChange={(e) => {
                        const next = { ...(styleConfig.seriesFormats ?? {}) };
                        if (e.target.value === '') {
                          delete next[key];
                        } else {
                          next[key] = e.target.value as NumberFormat;
                        }
                        updStyle({ seriesFormats: next });
                      }}
                      className="px-1.5 py-1 text-[11px] border border-[rgb(var(--border-line))] rounded bg-surface-1"
                    >
                      <option value="">(inherit)</option>
                      <option value="auto">Auto</option>
                      <option value="compact">Compact</option>
                      <option value="number">Number</option>
                      <option value="percent">Percent</option>
                      <option value="currency">Currency</option>
                    </select>
                    <input
                      type="number"
                      min={0}
                      max={6}
                      placeholder="dp"
                      value={styleConfig.seriesDecimalPlaces?.[key] ?? ''}
                      onChange={(e) => {
                        const next = { ...(styleConfig.seriesDecimalPlaces ?? {}) };
                        if (e.target.value === '') {
                          delete next[key];
                        } else {
                          next[key] = Number(e.target.value);
                        }
                        updStyle({ seriesDecimalPlaces: next });
                      }}
                      className="w-12 px-1.5 py-1 text-[11px] border border-[rgb(var(--border-line))] rounded bg-surface-1"
                    />
                  </div>
                ))}
              </div>
              <p className="mt-1 text-[10px] text-text-quaternary">Overrides global Number Format below.</p>
            </div>
            </Disclosure>
          )}

          {/* Phase-15.82 — tooltip extra fields. Chip-style toggle list so
              DA doesn't have to discover Ctrl/Cmd-click on a native
              multi-select (the previous draft used <select multiple>, which
              tested poorly with non-power users). Phase-15.87: own
              Disclosure because the chip list can run to 80+ entries
              and the old shared panel made everything below unreachable. */}
          {/* Phase-15.88 CRITICAL FIX — chip list now sourced from
              `chartResultColumns` (BE actually returned this column),
              NOT `availableColumns` (full dataset catalogue). DA-reported
              bug: user ticked a chip, hovered the chart, tooltip showed
              NOTHING extra. Root cause: chip was for a dataset column
              the chart's GROUP BY never selected, so CustomTooltip
              lookup `row[field]` returned undefined and silently skipped.
              When chartResultColumns is empty (query not run yet) we
              fall back to availableColumns with a clear hint. */}
          {!isTableLike && (
            <Disclosure
              title="Tooltip extra fields"
              hint="Pick row columns to surface in the hover tooltip. Only columns that the chart's query actually returns will display."
            >
            <div>
              {chartResultColumns.length === 0 ? (
                <p className="text-[11px] text-text-tertiary italic">
                  Run the query first — the chip list shows only columns the chart's GROUP BY selects.
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-1">
                    {chartResultColumns.map((colName) => {
                      const selected = (styleConfig.tooltipExtraFields ?? []).includes(colName);
                      // Lookup display label from full availableColumns if it
                      // happens to be in the dataset catalogue; else show raw.
                      const meta = availableColumns.find((c: any) => c.name === colName);
                      const label = meta?.label || colName;
                      return (
                        <button
                          key={colName}
                          type="button"
                          onClick={() => {
                            const current = styleConfig.tooltipExtraFields ?? [];
                            const next = selected
                              ? current.filter((f) => f !== colName)
                              : [...current, colName];
                            updStyle({ tooltipExtraFields: next.length === 0 ? undefined : next });
                          }}
                          className={`px-1.5 py-0.5 text-[11px] rounded border transition-colors ${
                            selected
                              ? 'bg-brand text-white border-brand'
                              : 'bg-surface-1 text-text-secondary border-[rgb(var(--border-line))] hover:bg-surface-2'
                          }`}
                          title={colName}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1 text-[10px] text-text-quaternary">
                    Click a column to toggle it into the chart tooltip.
                  </p>
                </>
              )}
            </div>
            </Disclosure>
          )}

          {/* Phase-15.91 — "Data label template" Disclosure removed. The
              template input now lives INSIDE the Data Labels Disclosure
              below, alongside Value format / Position / Font, matching
              PowerBI's single-panel layout. See DataLabelsEditor. */}

          {/* Phase-15.82 — chart annotations (manual reference lines).
              Phase-15.88 — restrict to cartesian charts. Renderer only
              emits <ReferenceLine> in BAR/LINE/AREA/COMBO/SCATTER paths;
              showing the editor on PIE/DONUT/FUNNEL/RADAR/MATRIX was
              the classic "code mà chạy không được" case — user adds
              annotation, runs query, nothing shows. */}
          {(['LINE', 'AREA', 'TIME_SERIES', 'BAR', 'HORIZONTAL_BAR', 'STACKED_BAR', 'GROUPED_BAR', 'BAR_LINE', 'SCATTER'] as string[]).includes(chartType) && (
            <Disclosure
              title="Annotations"
              hint="Draw manual reference lines on the chart (eg. quota = 5M, launch date). Each annotation pins to either the X or Y axis. Cartesian charts only."
            >
            <div>
              <div className="space-y-1.5">
                {(styleConfig.annotations ?? []).map((annotation, idx) => (
                  <div key={annotation.id} className="rounded border border-[rgb(var(--border-line))] p-2 space-y-1">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={annotation.label ?? ''}
                        placeholder="Label"
                        onChange={(e) => {
                          const next = [...(styleConfig.annotations ?? [])];
                          next[idx] = { ...annotation, label: e.target.value };
                          updStyle({ annotations: next });
                        }}
                        className="flex-1 px-1.5 py-1 text-[11px] border border-[rgb(var(--border-line))] rounded bg-surface-1"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const next = [...(styleConfig.annotations ?? [])];
                          next.splice(idx, 1);
                          updStyle({ annotations: next.length === 0 ? undefined : next });
                        }}
                        className="text-text-tertiary hover:text-text-primary"
                        title="Remove annotation"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <select
                        value={annotation.axis ?? 'y'}
                        onChange={(e) => {
                          const next = [...(styleConfig.annotations ?? [])];
                          next[idx] = { ...annotation, axis: e.target.value as 'x' | 'y' };
                          updStyle({ annotations: next });
                        }}
                        className="px-1.5 py-1 text-[11px] border border-[rgb(var(--border-line))] rounded bg-surface-1"
                      >
                        <option value="y">Y axis</option>
                        <option value="x">X axis</option>
                      </select>
                      <input
                        type="text"
                        value={String(annotation.value ?? '')}
                        placeholder="Value"
                        onChange={(e) => {
                          const next = [...(styleConfig.annotations ?? [])];
                          const raw = e.target.value;
                          next[idx] = { ...annotation, value: Number(raw) || raw };
                          updStyle({ annotations: next });
                        }}
                        className="flex-1 px-1.5 py-1 text-[11px] border border-[rgb(var(--border-line))] rounded bg-surface-1"
                      />
                      <input
                        type="color"
                        value={annotation.color || '#7c3aed'}
                        onChange={(e) => {
                          const next = [...(styleConfig.annotations ?? [])];
                          next[idx] = { ...annotation, color: e.target.value };
                          updStyle({ annotations: next });
                        }}
                        className="h-6 w-8 cursor-pointer rounded border border-[rgb(var(--border-line))]"
                      />
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    const next = [...(styleConfig.annotations ?? [])];
                    next.push({
                      id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                      label: '',
                      value: 0,
                      axis: 'y',
                      color: '#7c3aed',
                      lineStyle: 'dashed',
                    });
                    updStyle({ annotations: next });
                  }}
                  className="w-full px-2 py-1 text-[11px] border border-dashed border-[rgb(var(--border-line))] rounded text-text-secondary hover:bg-surface-2"
                >
                  + Add annotation
                </button>
              </div>
            </div>
            </Disclosure>
          )}

          {/* Phase-15.82 — conditional color rules for bar/line series.
              Phase-15.88 — restrict to BAR + HORIZONTAL_BAR. STACKED_BAR /
              GROUPED_BAR / BAR_LINE renderers don't emit <Cell> children,
              so the rule was silently dropped. LINE/AREA have a single
              stroke and can't paint per-point conditionally without a
              different render path. Hide the editor for incompatible
              chart types instead of accepting input that does nothing. */}
          {(['BAR', 'HORIZONTAL_BAR'] as string[]).includes(chartType) && (
            <Disclosure
              title="Conditional series colors"
              hint="Repaint individual bar cells when their value matches a rule (eg. red if revenue < 0). Applies to BAR and HORIZONTAL_BAR."
            >
            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1 block">
                Conditional series colors
              </label>
              <div className="space-y-1.5">
                {(styleConfig.seriesConditionalRules ?? []).map((rule, idx) => (
                  <div key={idx} className="flex items-center gap-1.5">
                    <select
                      value={rule.operator}
                      onChange={(e) => {
                        const next = [...(styleConfig.seriesConditionalRules ?? [])];
                        next[idx] = { ...rule, operator: e.target.value as ConditionalFormatRule['operator'] };
                        updStyle({ seriesConditionalRules: next });
                      }}
                      className="px-1 py-1 text-[11px] border border-[rgb(var(--border-line))] rounded bg-surface-1"
                    >
                      <option value=">">&gt;</option>
                      <option value=">=">&ge;</option>
                      <option value="<">&lt;</option>
                      <option value="<=">&le;</option>
                      <option value="=">=</option>
                      <option value="!=">≠</option>
                    </select>
                    <input
                      type="number"
                      value={rule.value ?? ''}
                      placeholder="value"
                      onChange={(e) => {
                        const next = [...(styleConfig.seriesConditionalRules ?? [])];
                        next[idx] = { ...rule, value: e.target.value === '' ? '' : Number(e.target.value) };
                        updStyle({ seriesConditionalRules: next });
                      }}
                      className="flex-1 px-1.5 py-1 text-[11px] border border-[rgb(var(--border-line))] rounded bg-surface-1"
                    />
                    <input
                      type="color"
                      value={rule.color || '#dc2626'}
                      onChange={(e) => {
                        const next = [...(styleConfig.seriesConditionalRules ?? [])];
                        next[idx] = { ...rule, color: e.target.value };
                        updStyle({ seriesConditionalRules: next });
                      }}
                      className="h-6 w-8 cursor-pointer rounded border border-[rgb(var(--border-line))]"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const next = [...(styleConfig.seriesConditionalRules ?? [])];
                        next.splice(idx, 1);
                        updStyle({ seriesConditionalRules: next.length === 0 ? undefined : next });
                      }}
                      className="text-text-tertiary hover:text-text-primary"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    const next = [...(styleConfig.seriesConditionalRules ?? [])];
                    next.push({ field: '', operator: '>', value: 0, color: '#dc2626' });
                    updStyle({ seriesConditionalRules: next });
                  }}
                  className="w-full px-2 py-1 text-[11px] border border-dashed border-[rgb(var(--border-line))] rounded text-text-secondary hover:bg-surface-2"
                >
                  + Add color rule
                </button>
              </div>
              <p className="mt-1 text-[10px] text-text-quaternary">Applied to BAR and HORIZONTAL_BAR charts.</p>
            </div>
            </Disclosure>
          )}

          {/* Phase-15.82 — inline calculated fields (DAX-lite).
              UX: surface the available metric keys as click-to-insert chips
              so DA doesn't have to memorise the `agg__field` convention.

              Phase-15.88 — restrict to Recharts cartesian chart types.
              AdvancedExploreCharts.tsx (FUNNEL/TREEMAP/RADAR/MAP/BOXPLOT/
              WATERFALL/SUNBURST) never invokes `applyCalculatedFields`,
              so the previous "show on every non-table non-scatter chart"
              guard silently accepted user input then dropped it on render.
              DA-reported "code mà chạy không được". */}
          {(['LINE', 'AREA', 'TIME_SERIES', 'BAR', 'HORIZONTAL_BAR', 'STACKED_BAR', 'GROUPED_BAR', 'BAR_LINE'] as string[]).includes(chartType) && (
            <Disclosure
              title="Calculated fields"
              hint="Add derived series using a tiny formula language. Click a series chip to insert a reference, then combine with + - * / and parentheses. Only renders on LINE / AREA / BAR family charts."
            >
            <div>
              <div className="space-y-1.5">
                {(styleConfig.calculatedFields ?? []).map((field, idx) => {
                  const expressionId = `calc-expr-${field.id}`;
                  const insertToken = (token: string) => {
                    const input = document.getElementById(expressionId) as HTMLInputElement | null;
                    const before = field.expression ?? '';
                    let nextExpr = before + token;
                    if (input) {
                      const start = input.selectionStart ?? before.length;
                      const end = input.selectionEnd ?? before.length;
                      nextExpr = before.slice(0, start) + token + before.slice(end);
                    }
                    const next = [...(styleConfig.calculatedFields ?? [])];
                    next[idx] = { ...field, expression: nextExpr };
                    updStyle({ calculatedFields: next });
                  };
                  return (
                    <div key={field.id} className="rounded border border-[rgb(var(--border-line))] p-2 space-y-1">
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={field.label ?? ''}
                          placeholder="Label (e.g. Margin %)"
                          onChange={(e) => {
                            const next = [...(styleConfig.calculatedFields ?? [])];
                            next[idx] = { ...field, label: e.target.value };
                            updStyle({ calculatedFields: next });
                          }}
                          className="flex-1 px-1.5 py-1 text-[11px] border border-[rgb(var(--border-line))] rounded bg-surface-1"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const next = [...(styleConfig.calculatedFields ?? [])];
                            next.splice(idx, 1);
                            updStyle({ calculatedFields: next.length === 0 ? undefined : next });
                          }}
                          className="text-text-tertiary hover:text-text-primary"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                      <input
                        id={expressionId}
                        type="text"
                        value={field.expression ?? ''}
                        placeholder="Type, or click a chip below to insert"
                        onChange={(e) => {
                          const next = [...(styleConfig.calculatedFields ?? [])];
                          next[idx] = { ...field, expression: e.target.value };
                          updStyle({ calculatedFields: next });
                        }}
                        className="w-full px-1.5 py-1 text-[11px] font-mono border border-[rgb(var(--border-line))] rounded bg-surface-1"
                      />
                      {availableSeriesKeys.length > 0 ? (
                        <>
                          <div className="flex flex-wrap gap-1 pt-1">
                            {availableSeriesKeys.map(({ key, label }) => (
                              <button
                                key={key}
                                type="button"
                                onClick={() => insertToken('${' + key + '}')}
                                className="px-1.5 py-0.5 text-[10px] rounded bg-brand/10 hover:bg-brand/20 text-brand border border-brand/30"
                                title={`Insert reference to ${label}`}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                          {/* Phase-15.91 — clickable operator chips so DA doesn't have to type. */}
                          <div className="flex flex-wrap gap-1 pt-1">
                            {[' + ', ' - ', ' * ', ' / ', '(', ')'].map((op) => (
                              <button
                                key={op}
                                type="button"
                                onClick={() => insertToken(op)}
                                className="px-1.5 py-0.5 text-[10px] rounded bg-surface-2 hover:bg-surface-3 text-text-secondary border border-[rgb(var(--border-line))] font-mono"
                                title={`Insert ${op.trim()}`}
                              >
                                {op.trim()}
                              </button>
                            ))}
                          </div>
                        </>
                      ) : (
                        // Phase-15.88 — DA-reported: empty chip strip with
                        // "Type, or click a chip below to insert" placeholder
                        // confused users into thinking the feature was broken.
                        // Make the prerequisite explicit.
                        <p className="text-[10px] text-warning pt-1">
                          Run the query first to see series chips. Or type a reference manually like {'${sum__revenue}'}.
                        </p>
                      )}
                    </div>
                  );
                })}
                <button
                  type="button"
                  onClick={() => {
                    const next = [...(styleConfig.calculatedFields ?? [])];
                    next.push({
                      id: `calc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                      label: '',
                      expression: '',
                    });
                    updStyle({ calculatedFields: next });
                  }}
                  className="w-full px-2 py-1 text-[11px] border border-dashed border-[rgb(var(--border-line))] rounded text-text-secondary hover:bg-surface-2"
                >
                  + Add calculated field
                </button>
              </div>
              <p className="mt-1 text-[10px] text-text-quaternary">
                Click a series chip to insert it as a reference. Renders as an additional line on LINE/AREA charts.
              </p>
            </div>
            </Disclosure>
          )}

          {/* Data Labels — moved into Advanced group (Phase-15.92). */}
          {(() => {
            const noLabelTypes = new Set(['PODIUM', 'KPI', 'GAUGE', 'BULLET']);
            // BUBBLE/MAP_POINT renderers DO draw per-point labels (the Label
            // value next to each bubble via dataLabelConfig.enabled), so they
            // get the full editor. Only plain SCATTER (no Label role, raw
            // points) stays excluded. DA report: "Bubble không hiển thị Data
            // Label" — the control was hidden because BUBBLE was lumped with
            // SCATTER under isScatterLike.
            const noLabelScatter = chartType === 'SCATTER';
            const hideFullEditor = noLabelScatter || isTableLike || noLabelTypes.has(chartType);
            // No-dimension metric / podium / scatter still display a single
            // formatted value; they just don't have per-point series labels.
            // Surface JUST the Value format select so DA can pick %/currency/compact
            // for the displayed number without enabling the full per-series editor.
            const showCompactFormat = noLabelTypes.has(chartType) && chartType !== 'GAUGE';
            if (showCompactFormat) {
              const dlc = styleConfig.dataLabelConfig ?? {};
              const currentFormat = dlc.format ?? '';
              return (
                <Disclosure
                  title="Value format"
                  hint="Pick how the displayed number is rendered. Falls back to the chart-level Number Format when left at (inherit)."
                >
                  <div>
                    <label className="text-xs font-semibold text-text-secondary mb-1 block">
                      Display units
                    </label>
                    <select
                      value={currentFormat}
                      onChange={(e) => {
                        const next = e.target.value;
                        updStyle({
                          dataLabelConfig: {
                            ...dlc,
                            format: next === '' ? undefined : (next as NumberFormat),
                          },
                        });
                      }}
                      className="w-full px-2 py-1 text-[11px] border border-[rgb(var(--border-line))] rounded bg-surface-1"
                    >
                      <option value="">(inherit chart Number Format)</option>
                      <option value="auto">Auto (raw)</option>
                      <option value="compact">Compact (1.2K, 3.4M)</option>
                      <option value="number">Full Number (1,234)</option>
                      <option value="percent">Percent (%)</option>
                      <option value="currency">Currency ($)</option>
                    </select>
                    <p className="text-[10px] text-text-quaternary mt-1">
                      Overrides the chart-level Number Format for the displayed value only.
                    </p>
                  </div>
                </Disclosure>
              );
            }
            if (hideFullEditor) return null;
            return (
              <Disclosure
                title="Data Labels"
                hint="Show numeric labels on data points. Customise per series — position, rotation, font, background, and auto-hide overlapping labels."
              >
                <DataLabelsEditor
                  styleConfig={styleConfig}
                  availableSeriesKeys={availableSeriesKeys}
                  updStyle={updStyle}
                  applicableForChart
                  chartType={chartType}
                />
              </Disclosure>
            );
          })()}
          </>
        </FormatGroup>

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Appearance: Axis ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        {/* Phase-15.92 — Axes & Scale group (was a separate "Advanced"
            SectionPanel as Step 4). Merged into the Format pane so DA
            only sees ONE step for styling, matching PBI's single
            "Format" pane. Contains all the scale / axis / shape /
            reference-line / sort controls. */}
        {hasAdvancedControls && (
          <FormatGroup
            title={t('explore.config.axesScale')}
            defaultOpen={false}
            matchesSearch={matchesFormatSearch(['axis', 'axes', 'scale', 'grid', 'benchmark', 'bar', 'line', 'dual', 'time', 'granularity', 'point', 'sort', 'limit'])}
            searchActive={formatSearchActive}
            hasCustomization={Boolean(
              styleConfig.xAxisLabel || styleConfig.yAxisLabel ||
              (styleConfig.yAxisMin !== undefined && styleConfig.yAxisMin !== '') ||
              (styleConfig.yAxisMax !== undefined && styleConfig.yAxisMax !== '') ||
              styleConfig.showGrid === false ||
              styleConfig.showBenchmarkLine ||
              styleConfig.barRadius !== undefined ||
              styleConfig.barSize !== undefined ||
              styleConfig.lineStyle === 'dashed' ||
              styleConfig.lineWidth !== undefined ||
              styleConfig.dualYAxis ||
              styleConfig.timeGranularity ||
              styleConfig.scatterLabelField ||
              (chartSortRules && chartSortRules.length > 0)
            )}
          >
        {hasAxis && (
        <Disclosure title="Range & Gridlines">
          <Toggle label="Grid Lines" checked={styleConfig.showGrid ?? true}
            onChange={v => updStyle({ showGrid: v })} />
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">{t('explore.config.xAxisLabel')}</label>
            <input type="text" value={styleConfig.xAxisLabel || ''} placeholder="auto"
              onChange={e => updStyle({ xAxisLabel: e.target.value })}
              className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md" />
          </div>
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">{t('explore.config.yAxisLabel')}</label>
            <input type="text" value={styleConfig.yAxisLabel || ''} placeholder="auto"
              onChange={e => updStyle({ yAxisLabel: e.target.value })}
              className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1 block">Y Min</label>
              <input type="number" value={styleConfig.yAxisMin ?? ''} placeholder="auto"
                onChange={e => updStyle({ yAxisMin: e.target.value === '' ? '' : Number(e.target.value) })}
                className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md" />
            </div>
            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1 block">Y Max</label>
              <input type="number" value={styleConfig.yAxisMax ?? ''} placeholder="auto"
                onChange={e => updStyle({ yAxisMax: e.target.value === '' ? '' : Number(e.target.value) })}
                className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md" />
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">Display units (axis)</label>
            <select
              value={styleConfig.axisDisplayUnits || 'auto'}
              onChange={e => updStyle({ axisDisplayUnits: e.target.value as AxisDisplayUnits })}
              className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1"
            >
              <option value="auto">Auto (1.2K / 3.4M)</option>
              <option value="none">None (full number)</option>
              <option value="thousands">Thousands (K)</option>
              <option value="millions">Millions (M)</option>
              <option value="billions">Billions (B)</option>
            </select>
            <p className="mt-1 text-[10px] text-text-tertiary">Abbreviates the value-axis ticks only; data labels keep their own format.</p>
          </div>
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">Font Size: {styleConfig.fontSize || 12}px</label>
            <input type="range" min={9} max={18} step={1} value={styleConfig.fontSize || 12}
              onChange={e => updStyle({ fontSize: Number(e.target.value) })}
              className="w-full h-1.5 bg-surface-3 rounded-lg accent-blue-500 cursor-pointer" />
          </div>
        </Disclosure>
      )}

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Appearance: Bar options ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      {supportsBenchmarkLine && (
        <Disclosure
          title="Đường benchmark (Benchmark lines)"
          hint="Nhiều đường mục tiêu cùng lúc (vd Tối thiểu / Kỳ vọng / Xuất sắc). Mỗi đường là giá trị cố định HOẶC động (trung bình/trung vị/max/min/phân vị của một chỉ số — tự đổi theo bộ lọc)."
        >
          <Toggle
            label="Bật đường benchmark"
            checked={normalizedStyleConfig.showBenchmarkLine ?? false}
            onChange={v => updStyle({ showBenchmarkLine: v })}
          />

          {normalizedStyleConfig.showBenchmarkLine && (
            <div className="mt-2 space-y-3">
              {benchmarkLines.map((line, index) => {
                const src = line.source ?? 'value';
                return (
                  <div key={`bench-${index}`} className="space-y-2.5 rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Đường {index + 1}</span>
                      <button type="button" onClick={() => removeBenchmarkLine(index)}
                        className="rounded p-1 text-text-quaternary hover:bg-surface-1 hover:text-danger" title="Xoá đường">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="mb-1 block text-xs font-semibold text-text-secondary">Nguồn giá trị</label>
                        <select
                          value={src}
                          onChange={e => updateBenchmarkLine(index, { source: e.target.value as BenchmarkLineDef['source'] })}
                          className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs"
                        >
                          <option value="value">Giá trị cố định</option>
                          <option value="aggregate">Động (theo chỉ số)</option>
                        </select>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-semibold text-text-secondary">Nhãn</label>
                        <input type="text" value={line.label ?? ''} placeholder="vd Mục tiêu"
                          onChange={e => updateBenchmarkLine(index, { label: e.target.value })}
                          className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs" />
                      </div>
                    </div>

                    {src === 'aggregate' ? (
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="mb-1 block text-xs font-semibold text-text-secondary">Chỉ số</label>
                          <select
                            value={line.field ?? ''}
                            onChange={e => updateBenchmarkLine(index, { field: e.target.value || undefined })}
                            className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs"
                          >
                            <option value="">— chọn chỉ số —</option>
                            {benchmarkFieldOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="mb-1 block text-xs font-semibold text-text-secondary">Phép tính</label>
                          <select
                            value={line.aggregate ?? 'avg'}
                            onChange={e => updateBenchmarkLine(index, { aggregate: e.target.value as BenchmarkAggregate })}
                            className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs"
                          >
                            <option value="avg">Trung bình</option>
                            <option value="median">Trung vị</option>
                            <option value="min">Nhỏ nhất</option>
                            <option value="max">Lớn nhất</option>
                            <option value="sum">Tổng</option>
                            <option value="percentile">Phân vị</option>
                          </select>
                        </div>
                        {line.aggregate === 'percentile' && (
                          <div>
                            <label className="mb-1 block text-xs font-semibold text-text-secondary">Phân vị (0–100)</label>
                            <input type="number" value={line.percentile ?? 90} placeholder="90"
                              onChange={e => updateBenchmarkLine(index, { percentile: e.target.value === '' ? undefined : Number(e.target.value) })}
                              className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs" />
                          </div>
                        )}
                      </div>
                    ) : (
                      <div>
                        <label className="mb-1 block text-xs font-semibold text-text-secondary">Giá trị</label>
                        <input type="number" value={line.value ?? ''} placeholder="vd 1000"
                          onChange={e => updateBenchmarkLine(index, { value: e.target.value === '' ? '' : Number(e.target.value) })}
                          className={`w-full rounded-md border px-2 py-1.5 text-xs ${line.value === '' || line.value == null ? 'border-warning/40 bg-warning/10' : 'border-[rgb(var(--border-strong))] bg-surface-1'}`} />
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-2">
                      <ColorField label="Màu đường" value={line.color || '#dc2626'}
                        onChange={value => updateBenchmarkLine(index, { color: value })} />
                      <div>
                        <label className="mb-1 block text-xs font-semibold text-text-secondary">Kiểu nét</label>
                        <select
                          value={line.lineStyle ?? 'dashed'}
                          onChange={e => updateBenchmarkLine(index, { lineStyle: e.target.value as ChartBenchmarkLineStyle })}
                          className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs"
                        >
                          <option value="solid">Liền</option>
                          <option value="dashed">Đứt</option>
                        </select>
                      </div>
                    </div>

                    {src === 'aggregate' && !line.field && (
                      <p className="text-[11px] text-warning">Chọn chỉ số để kích hoạt đường động này.</p>
                    )}
                  </div>
                );
              })}

              <button type="button" onClick={addBenchmarkLine}
                className="w-full rounded-md border border-dashed border-brand/40 bg-brand/10 px-3 py-2 text-xs font-medium text-brand hover:bg-brand/15">
                + Thêm đường benchmark
              </button>
            </div>
          )}
        </Disclosure>
      )}

      {isRechartsBarShape && (
        <Disclosure title="Bar Shape">
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">Bar Radius: {styleConfig.barRadius ?? 4}px</label>
            <input type="range" min={0} max={12} step={1} value={styleConfig.barRadius ?? 4}
              onChange={e => updStyle({ barRadius: Number(e.target.value) })}
              className="w-full h-1.5 bg-surface-3 rounded-lg accent-blue-500 cursor-pointer" />
          </div>
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">Bar Width (px)</label>
            <input type="number" min={4} max={200} value={styleConfig.barSize ?? ''} placeholder="auto"
              onChange={e => updStyle({ barSize: e.target.value === '' ? '' : Number(e.target.value) })}
              className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md" />
          </div>
        </Disclosure>
      )}

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Appearance: Line options ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      {isLineType && (
        <Disclosure title="Line Style">
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">Markers</label>
            <select
              value={styleConfig.showDots === true ? 'always' : styleConfig.showDots === false ? 'never' : 'auto'}
              onChange={e => {
                const v = e.target.value;
                updStyle({ showDots: v === 'always' ? true : v === 'never' ? false : undefined });
              }}
              className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1">
              <option value="auto">Auto (hide on dense lines)</option>
              <option value="always">Always show</option>
              <option value="never">Never</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">Line Style</label>
            <select value={styleConfig.lineStyle || 'solid'}
              onChange={e => updStyle({ lineStyle: e.target.value as 'solid' | 'dashed' })}
              className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1">
              <option value="solid">Solid</option>
              <option value="dashed">Dashed</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">Line Width: {styleConfig.lineWidth ?? 2}px</label>
            <input type="range" min={1} max={6} step={1} value={styleConfig.lineWidth ?? 2}
              onChange={e => updStyle({ lineWidth: Number(e.target.value) })}
              className="w-full h-1.5 bg-surface-3 rounded-lg accent-blue-500 cursor-pointer" />
          </div>
          {(chartType === 'AREA') && (
            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1 block">Fill Opacity: {Math.round((styleConfig.areaOpacity ?? 0.6) * 100)}%</label>
              <input type="range" min={0} max={100} step={5} value={Math.round((styleConfig.areaOpacity ?? 0.6) * 100)}
                onChange={e => updStyle({ areaOpacity: Number(e.target.value) / 100 })}
                className="w-full h-1.5 bg-surface-3 rounded-lg accent-blue-500 cursor-pointer" />
            </div>
          )}
        </Disclosure>
      )}

      {/* BAR_LINE: dual Y-axis */}
      {chartType === 'BAR_LINE' && (
        <Disclosure title="Dual Y-Axis" hint="Show a second Y axis on the right side for the line metric — useful when bar and line values have very different scales.">
          <Toggle label="Enable right Y axis" checked={styleConfig.dualYAxis ?? false}
            onChange={v => updStyle({ dualYAxis: v })} />
          {styleConfig.dualYAxis && (
            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1 block">Right Axis Label</label>
              <input type="text" value={styleConfig.yAxisRightLabel || ''} placeholder="auto"
                onChange={e => updStyle({ yAxisRightLabel: e.target.value })}
                className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md" />
            </div>
          )}
        </Disclosure>
      )}

      {/* TIME_SERIES: time granularity */}
      {chartType === 'TIME_SERIES' && (
        <Disclosure title="Time Granularity" hint="Bucket timestamps into time periods before aggregating. Useful for compressing high-frequency data.">
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">Group by</label>
            <select value={styleConfig.timeGranularity || 'raw'}
              onChange={e => updStyle({ timeGranularity: e.target.value as TimeGranularity })}
              className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1">
              <option value="raw">Raw (no bucketing)</option>
              <option value="day">Day</option>
              <option value="week">Week</option>
              <option value="month">Month</option>
              <option value="quarter">Quarter</option>
              <option value="year">Year</option>
            </select>
          </div>
        </Disclosure>
      )}

      {/* SCATTER: point labels */}
      {isScatterLike && (
        <Disclosure title="Point Labels" hint="Show a label on each scatter point from a dimension column.">
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">Label Field</label>
            <select value={styleConfig.scatterLabelField || ''}
              onChange={e => updStyle({ scatterLabelField: e.target.value })}
              className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1">
              <option value="">None</option>
              {allCols.map(c => <option key={c.name} value={c.name} title={c.name}>{colLabel(c)}</option>)}
            </select>
          </div>
        </Disclosure>
      )}

      {/* Sort & Limit */}
      {supportsDataSection && (
        <Disclosure title={t('explore.config.sortLimit')} hint={t('explore.config.sortLimitHint')}>
          {/* Sort rules */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-text-secondary">{t('explore.config.sortRules')}</span>
              <button type="button"
                onClick={() => {
                  if (sortLimitCols.length === 0) return;
                  updStyle({ chartSortRules: [...chartSortRules, { field: sortLimitCols[0].name, direction: 'asc' }] });
                }}
                disabled={sortLimitCols.length === 0}
                className="text-xs text-brand hover:text-brand disabled:cursor-not-allowed disabled:text-text-quaternary">{t('explore.config.addRule')}</button>
            </div>
            {chartSortRules.length === 0 && sortLimitCols.length === 0 && (
              <p className="text-[11px] text-text-quaternary italic">{t('explore.config.runQueryEnableSorting')}</p>
            )}
            {chartSortRules.map((rule, i) => (
              <div key={i} className="flex items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 p-2">
                <span className="text-[11px] text-text-quaternary w-4 text-center">{i + 1}</span>
                <select value={rule.field}
                  onChange={e => updStyle({ chartSortRules: chartSortRules.map((r, ri) => ri === i ? { ...r, field: e.target.value } : r) })}
                  className="flex-1 px-1.5 py-1 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1 min-w-0">
                  {sortLimitCols.map(c => <option key={c.name} value={c.name} title={c.name}>{colLabel(c)}</option>)}
                </select>
                <select value={rule.direction}
                  onChange={e => updStyle({ chartSortRules: chartSortRules.map((r, ri) => ri === i ? { ...r, direction: e.target.value as 'asc' | 'desc' } : r) })}
                  className="w-20 px-1.5 py-1 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1">
                  <option value="asc">ASC</option>
                  <option value="desc">DESC</option>
                </select>
                <button type="button"
                  onClick={() => updStyle({ chartSortRules: chartSortRules.filter((_, ri) => ri !== i) })}
                  className="p-0.5 text-text-quaternary hover:text-danger flex-shrink-0">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          {/* BUG-012 — Limit (Top/Bottom N). Caps how many rows the chart
              renders AFTER the sort rules above are applied. Blank = no cap
              (every row renders). The render path reads styleConfig.dataLimit
              / dataLimitDirection via applyDataLimit in ExploreChart and
              ChartPreview. */}
          <div className="mt-3 space-y-1.5 border-t border-[rgb(var(--border-line))] pt-3">
            <span className="text-xs font-semibold text-text-secondary">{t('explore.config.limit')}</span>
            <div className="flex items-center gap-1.5">
              <select
                value={styleConfig.dataLimitDirection ?? 'top'}
                onChange={e => updStyle({ dataLimitDirection: e.target.value as 'top' | 'bottom' })}
                className="w-24 px-1.5 py-1 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1">
                <option value="top">{t('explore.config.top')}</option>
                <option value="bottom">{t('explore.config.bottom')}</option>
              </select>
              <input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                placeholder={t('explore.config.allRows')}
                value={styleConfig.dataLimit === undefined || styleConfig.dataLimit === '' ? '' : styleConfig.dataLimit}
                onChange={e => {
                  const raw = e.target.value;
                  if (raw === '') { updStyle({ dataLimit: undefined }); return; }
                  const n = Math.max(1, Math.floor(Number(raw)));
                  updStyle({ dataLimit: Number.isFinite(n) ? n : undefined });
                }}
                className="flex-1 min-w-0 px-2 py-1 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1"
              />
              <span className="text-[11px] text-text-quaternary">{t('explore.config.rows')}</span>
            </div>
            <p className="text-[10px] text-text-quaternary">{t('explore.config.limitHelp')}</p>
          </div>
        </Disclosure>
      )}
          </FormatGroup>
        )}
        </SectionPanel>
      )}
    </div>
    </FieldPickerContext.Provider>
  );
}
