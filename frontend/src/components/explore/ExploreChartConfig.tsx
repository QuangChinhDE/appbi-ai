'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  LineChart,
  Map,
  MapPin,
  Network,
  PieChart,
  Radar,
  Ribbon,
  Rows3,
  ScatterChart,
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
import type {
  ChartBenchmarkLineStyle,
  ChartSortRule,
  ConditionalFormatRule,
  KpiGoalDirection,
  KpiValueColorRule,
  TableColumnAlignment,
  TableHeatmapRule,
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
  | 'KPI' | 'PODIUM';

export type AggFn = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct';
export type TableLayoutMode = 'standard' | 'pivot';

export type NumberFormat = 'auto' | 'number' | 'compact' | 'percent' | 'currency';
export type LegendPosition = 'top' | 'bottom' | 'left' | 'right' | 'none';
export const TABLE_PIVOT_COLUMN_LIMIT = 50;

export interface MetricConfig {
  field: string;
  agg: AggFn;
  outputField?: string;
}

export interface ChartStyleConfig {
  // Data labels
  showDataLabels?: boolean;
  dataLabelPosition?: 'top' | 'center' | 'inside' | 'outside';
  // Number formatting
  numberFormat?: NumberFormat;
  currencySymbol?: string;
  decimalPlaces?: number;
  // Axis
  xAxisLabel?: string;
  yAxisLabel?: string;
  yAxisMin?: number | '';
  yAxisMax?: number | '';
  // Legend
  legendPosition?: LegendPosition;
  // Grid
  showGrid?: boolean;
  // Palette
  palette?: ChartPaletteName;
  // Per-series color overrides (priority: seriesColors[key] > palette[i]).
  // Key matches the series key shown in the legend (metric key or breakdown value).
  seriesColors?: Record<string, string>;
  // Font
  fontSize?: number;
  // Bar
  barRadius?: number;
  // Line
  showDots?: boolean;
  lineStyle?: 'solid' | 'dashed';
  // Benchmark line
  showBenchmarkLine?: boolean;
  benchmarkValue?: number | '';
  benchmarkLabel?: string;
  benchmarkColor?: string;
  benchmarkLineStyle?: ChartBenchmarkLineStyle;
  // KPI card
  kpiLabel?: string;
  kpiContextTemplate?: string;
  kpiBenchmarkValue?: number | '';
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
  legendPosition: 'bottom',
  showGrid: true,
  palette: 'default',
  fontSize: 12,
  barRadius: 4,
  showDots: true,
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
  tableEnableConditionalFormatting: false,
  tableEnableHeatmap: false,
  tableShowSummaryRow: false,
  tableSummaryLabel: 'Total',
  tableColumnWidths: undefined,
  tableColumnAlignments: undefined,
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

  if (normalized.kpiColorRules?.length) {
    normalized.kpiColorRules = normalized.kpiColorRules.map((rule) => ({
      operator: rule.operator ?? '>=',
      value: Number.isFinite(Number(rule.value)) ? Number(rule.value) : 0,
      color: normalizeColorInput(rule.color || '#16a34a', '#16a34a'),
      label: rule.label?.trim() || undefined,
    }));
  }

  if (!Object.prototype.hasOwnProperty.call(rawStyleConfig, 'kpiEnableColorRules')) {
    normalized.kpiEnableColorRules = Boolean(normalized.kpiColorRules?.length);
  }

  return normalized;
}

export interface ChartRoleConfig {
  dimension?: string;
  metrics: MetricConfig[];
  /** Legacy breakdown dimension for stacked/pivoted charts. */
  breakdown?: string;
  /** Additive BAR_LINE contract: one aggregated metric rendered as a line. */
  lineMetric?: MetricConfig;
  /** Optional KPI benchmark metric used for dynamic context/delta calculations. */
  benchmarkMetric?: MetricConfig;
  timeField?: string;
  scatterX?: string;
  scatterY?: string;
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
}

export const EMPTY_ROLE_CONFIG: ChartRoleConfig = { metrics: [] };

const TABLE_LIKE_TYPES = new Set<string>(['TABLE', 'MATRIX']);
const SCATTER_LIKE_TYPES = new Set<string>(['SCATTER', 'BUBBLE', 'MAP_POINT']);
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
]);
const RAW_DISTRIBUTION_TYPES = new Set<string>(['BOXPLOT']);

/** Display label e.g. "SUM of revenue" */
export function metricLabel(m: MetricConfig): string {
  const aggName = m.agg === 'count_distinct' ? 'COUNT DISTINCT' : m.agg.toUpperCase();
  return `${aggName} of ${m.field}`;
}

/** recharts dataKey for a MetricConfig */
export function metricKey(m: MetricConfig): string {
  return `${m.agg}__${m.field}`;
}

export function normalizeMetricConfig(metric: MetricConfig | string | null | undefined): MetricConfig | null {
  if (!metric) return null;
  if (typeof metric === 'string') {
    const field = metric.trim();
    return field ? { field, agg: 'sum' } : null;
  }

  const field = metric.field?.trim();
  if (!field) return null;
  return {
    field,
    agg: metric.agg ?? 'sum',
    outputField: metric.outputField?.trim() || undefined,
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

  return {
    ...(roleConfig ?? EMPTY_ROLE_CONFIG),
    metrics: normalizedMetrics,
    breakdown,
    tableMode,
    ...(benchmarkMetric ? { benchmarkMetric } : {}),
    ...(tablePivotMetric ? { tablePivotMetric } : {}),
    ...(lineMetric ? { lineMetric } : {}),
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
  { value: 'HEATMAP',        label: 'Heatmap',        group: 'relationship', icon: Table2 },
  { value: 'BOXPLOT',        label: 'Boxplot',        group: 'relationship', icon: Box },
  { value: 'RADAR',          label: 'Radar',          group: 'relationship', icon: Radar },
  { value: 'SANKEY',         label: 'Sankey',         group: 'relationship', icon: Network },
  { value: 'SUNBURST',       label: 'Sunburst',       group: 'relationship', icon: PieChart },
  { value: 'MAP_POINT',      label: 'Point Map',      group: 'geo', icon: MapPin },
  { value: 'MAP_REGION',     label: 'Region Map',     group: 'geo', icon: Map },
];

const AGG_OPTIONS: { value: AggFn; label: string }[] = [
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

type TableBenchmarkMode = 'value' | 'field';

function getTableBenchmarkMode(rule: ConditionalFormatRule): TableBenchmarkMode {
  return rule.benchmarkField ? 'field' : 'value';
}

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

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Column helpers ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
type Col = { name: string; type: string };

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
function Disclosure({ title, hint, defaultOpen = false, children }: {
  title: string; hint?: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
        <ChevronDown className={`w-3.5 h-3.5 text-text-quaternary transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="mt-3 space-y-3 border-t border-[rgb(var(--border-line))] pt-3">{children}</div>}
    </div>
  );
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Toggle switch ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 transition-colors ${
        checked ? 'border-brand/30 bg-brand/10/80' : 'border-[rgb(var(--border-line))] bg-surface-1'
      }`}
    >
      <div className="min-w-0">
        <div className={`text-xs font-semibold ${checked ? 'text-brand' : 'text-text-secondary'}`}>{label}</div>
        <div className={`text-[11px] ${checked ? 'text-brand' : 'text-text-quaternary'}`}>
          {checked ? 'Enabled' : 'Disabled'}
        </div>
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
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`w-full px-2 py-1.5 text-xs border rounded-md bg-surface-1 focus:outline-none focus:ring-1 focus:ring-brand ${
          missing ? 'border-danger/40 bg-danger/10' : 'border-[rgb(var(--border-strong))]'
        }`}
      >
        <option value="">{placeholder}</option>
        {options.map(o => <option key={o.name} value={o.name}>{o.name}</option>)}
      </select>
    </div>
  );
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ MetricSlot ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â PowerBI-style pill with per-field aggregation ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
function MetricSlot({
  label, required, hint, single, value, options, allOptions, onChange,
}: {
  label: string; required?: boolean; hint?: string;
  single?: boolean;
  value: MetricConfig[];
  /** Numeric columns (allowed for SUM/AVG/MIN/MAX). */
  options: Col[];
  /** All columns including non-numeric (allowed for COUNT/COUNT_DISTINCT). Defaults to options. */
  allOptions?: Col[];
  onChange: (v: MetricConfig[]) => void;
}) {
  const missing = required && value.length === 0;
  const numericNames = useMemo(() => new Set(options.map((o) => o.name)), [options]);
  const fullOptions = allOptions ?? options;

  const addField = (fieldName: string, agg: AggFn = 'sum') => {
    if (!fieldName) return;
    if (value.find(m => m.field === fieldName)) return;
    const next: MetricConfig = { field: fieldName, agg };
    onChange(single ? [next] : [...value, next]);
  };

  const removeField = (fieldName: string) => onChange(value.filter(m => m.field !== fieldName));

  // Changing agg may invalidate field type: SUM/AVG/MIN/MAX require numeric.
  // If incompatible after switch, drop the metric silently rather than leaving
  // a broken row that produces garbage SQL.
  const changeAgg = (fieldName: string, agg: AggFn) =>
    onChange(value.flatMap((m) => {
      if (m.field !== fieldName) return [m];
      const numericRequired = agg === 'sum' || agg === 'avg' || agg === 'min' || agg === 'max';
      if (numericRequired && !numericNames.has(m.field)) {
        return [];
      }
      return [{ ...m, agg }];
    }));

  const available = options.filter(o => !value.find(m => m.field === o.name));
  const availableForCount = fullOptions.filter(o => !value.find(m => m.field === o.name));

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
          {value.map(m => (
            <div key={m.field}
              className="flex items-center gap-1 pl-2 pr-1 py-1 rounded-md border border-brand/30 bg-brand/10"
            >
              <select
                value={m.agg}
                onChange={e => changeAgg(m.field, e.target.value as AggFn)}
                className="text-xs font-bold text-brand bg-transparent border-none outline-none cursor-pointer"
              >
                {AGG_OPTIONS.map(a => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
              <span className="flex-1 text-xs text-brand truncate" title={m.field}>{m.field}</span>
              <button onClick={() => removeField(m.field)}
                className="p-0.5 rounded hover:bg-brand-hover text-brand flex-shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add field — SUM/AVG/etc. on numeric columns. */}
      {(!single || value.length === 0) && (
        <select
          value=""
          onChange={e => addField(e.target.value, 'sum')}
          disabled={available.length === 0}
          className={`w-full px-2 py-1.5 text-xs border rounded-md bg-surface-1 focus:outline-none focus:ring-1 focus:ring-brand disabled:cursor-not-allowed disabled:opacity-60 ${
            missing ? 'border-danger/40 bg-danger/10 text-danger' : 'border-dashed border-[rgb(var(--border-strong))] text-text-quaternary'
          }`}
        >
          <option value="">{available.length === 0 ? 'all numeric fields added' : '+ add value...'}</option>
          {available.map(o => <option key={o.name} value={o.name}>{o.name}</option>)}
        </select>
      )}

      {/* Add count — COUNT/COUNT_DISTINCT works on any column type. */}
      {(!single || value.length === 0) && allOptions && (
        <select
          value=""
          onChange={e => addField(e.target.value, 'count')}
          disabled={availableForCount.length === 0}
          className="mt-1 w-full px-2 py-1.5 text-xs border border-dashed border-[rgb(var(--border-strong))] rounded-md bg-surface-1 text-text-quaternary focus:outline-none focus:ring-1 focus:ring-brand disabled:cursor-not-allowed disabled:opacity-60"
        >
          <option value="">{availableForCount.length === 0 ? 'all fields added' : '+ count any field...'}</option>
          {availableForCount.map(o => <option key={o.name} value={o.name}>{o.name}</option>)}
        </select>
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
  onChartTypeChange,
  onRoleConfigChange,
  onStyleConfigChange,
}: ExploreChartConfigProps) {
  const isStyleOnly = mode === 'styleOnly';
  const upd = useCallback(
    (patch: Partial<ChartRoleConfig>) => onRoleConfigChange({ ...roleConfig, ...patch }),
    [roleConfig, onRoleConfigChange]
  );
  const updStyle = useCallback(
    (patch: Partial<ChartStyleConfig>) => onStyleConfigChange({ ...styleConfig, ...patch }),
    [styleConfig, onStyleConfigChange]
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
  const sx  = normalizedRoleConfig.scatterX  || '';
  const sy  = normalizedRoleConfig.scatterY  || '';
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
  const isScatterLike = ['SCATTER', 'BUBBLE', 'MAP_POINT'].includes(chartType);
  const isBarType = ['BAR', 'HORIZONTAL_BAR', 'GROUPED_BAR', 'STACKED_BAR', 'BAR_LINE', 'WATERFALL'].includes(chartType);
  const isLineType = ['LINE', 'TIME_SERIES', 'AREA', 'BAR_LINE', 'RIBBON'].includes(chartType);
  const hasAxis = ![
    'PIE', 'DONUT', 'POLAR_AREA', 'KPI', 'GAUGE', 'BULLET', 'TABLE', 'MATRIX',
    'TREEMAP', 'FUNNEL', 'SANKEY', 'SUNBURST', 'WORD_CLOUD', 'MAP_REGION',
  ].includes(chartType);
  const supportsBenchmarkLine = ['BAR', 'HORIZONTAL_BAR', 'GROUPED_BAR', 'STACKED_BAR', 'LINE', 'AREA', 'TIME_SERIES', 'BAR_LINE'].includes(chartType);
  const supportsDataSection = !isTableLike && !isNoDimensionMetric;
  const chartBindingTitle = queryMode === 'custom' ? 'SQL Column Roles' : 'Field Roles';
  const tableBindingTitle = isPivotEnabled ? 'Pivot Layout' : 'Visible Columns';
  const tableRoleSectionHint = queryMode === 'custom'
    ? 'Choose directly from the columns returned by your SQL. Nothing is inferred back into Config Builder fields.'
    : 'Standard table stays as-is. Enable pivot only when you want dynamic cross-tab headers driven by distinct column values.';
  const chartRoleSectionHint = queryMode === 'custom'
    ? 'Choose which SQL output columns drive this chart. These selections work directly on your SQL output.'
    : undefined;
  const showQuickView = !isTableLike && chartType !== 'KPI';
  const hasAdvancedControls = showQuickView && (hasAxis || supportsBenchmarkLine || isBarType || isLineType || isPieLike || isScatterLike || chartType === 'TIME_SERIES' || supportsDataSection);
  const chartSortRules = normalizedStyleConfig.chartSortRules ?? [];
  const sortLimitCols = sortLimitColumns;
  const quickViewStep = isStyleOnly ? 'Step 1' : 'Step 3';
  const advancedStep = isStyleOnly ? 'Step 2' : 'Step 4';
  const tableSectionStep = isStyleOnly ? 'Step 1' : 'Step 2';
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

  const resetTableColumnWidth = (columnName: string) => {
    const nextWidths = { ...tableColumnWidths };
    delete nextWidths[columnName];
    setTableColumnWidths(nextWidths);
  };

  const resetAllTableColumnWidths = () => {
    updStyle({ tableColumnWidths: undefined });
  };

  const CurrentChartIcon = currentChartTypeMeta.icon;

  return (
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
                onChange={value => upd({ tablePivotMetric: value[0] })}
              />

            </>
          ) : (
            <>
              <div className="flex items-center justify-between mb-1">
                <button
                  onClick={() => {
                    const allSelected = !normalizedRoleConfig.selectedColumns || normalizedRoleConfig.selectedColumns.length === availableColumns.length;
                    upd({ selectedColumns: allSelected ? [] : availableColumns.map(c => c.name) });
                  }}
                  className="text-xs text-brand hover:text-brand"
                >
                  {!normalizedRoleConfig.selectedColumns || normalizedRoleConfig.selectedColumns.length === availableColumns.length ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
                {availableColumns.map(col => {
                  const checked = !normalizedRoleConfig.selectedColumns || normalizedRoleConfig.selectedColumns.includes(col.name);
                  return (
                    <label key={col.name} className="flex items-center gap-2 py-1 px-2 rounded hover:bg-surface-2 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const current = normalizedRoleConfig.selectedColumns ?? availableColumns.map(c => c.name);
                          const next = checked ? current.filter(n => n !== col.name) : [...current, col.name];
                          upd({ selectedColumns: next });
                        }}
                        className="w-3.5 h-3.5 rounded border-[rgb(var(--border-strong))] text-brand focus:ring-brand"
                      />
                      <span className="text-xs text-text-secondary truncate flex-1">{col.name}</span>
                      <span className="text-xs text-text-quaternary opacity-0 group-hover:opacity-100">{col.type}</span>
                    </label>
                  );
                })}
              </div>
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
              label="Heatmap"
              checked={isHeatmapEnabled}
              onChange={toggleTableHeatmap}
            />
          )}

          {tableFormattingColumns.length > 0 && (
            <Toggle
              label="Conditional formatting"
              checked={isConditionalFormattingEnabled}
              onChange={toggleTableConditionalFormatting}
            />
          )}

        </Disclosure>
      )}

      {isTableLike && tableFormattingColumns.length > 0 && (
        <Disclosure
          title="Column Layout"
          hint="Resize columns directly from the table preview by dragging the header edge. Use these controls to set value alignment and clear saved widths."
          defaultOpen
        >
          <div className="flex items-center justify-between rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2">
            <div className="flex items-center gap-1">
              <div className="text-xs font-semibold text-text-secondary">Resizable columns</div>
              <HelpTooltip text="Drag the divider on a column header in the preview to widen or shrink that column." />
            </div>
            <button
              type="button"
              onClick={resetAllTableColumnWidths}
              disabled={Object.keys(tableColumnWidths).length === 0}
              className="rounded-md border border-[rgb(var(--border-line))] px-2.5 py-1.5 text-[11px] font-medium text-text-secondary hover:border-[rgb(var(--border-strong))] hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Reset all widths
            </button>
          </div>

          <div className="space-y-2">
            {tableFormattingColumns.map((column) => {
              const currentWidth = tableColumnWidths[column.name];
              const currentAlignment = tableColumnAlignments[column.name] ?? 'left';

              return (
                <div
                  key={`table-column-layout-${column.name}`}
                  className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold text-text-secondary">{column.name}</div>
                      <div className="mt-1 text-[11px] text-text-quaternary">
                        {column.type || 'column'}
                        {currentWidth ? ` | ${Math.round(currentWidth)}px` : ' | auto width'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => resetTableColumnWidth(column.name)}
                      disabled={!currentWidth}
                      className="rounded-md border border-[rgb(var(--border-line))] px-2 py-1 text-[11px] font-medium text-text-tertiary hover:border-[rgb(var(--border-strong))] hover:bg-surface-1 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Reset width
                    </button>
                  </div>

                  <div className="mt-3">
                    <label className="mb-1.5 block text-xs font-semibold text-text-secondary">Value alignment</label>
                    <div className="inline-flex rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-1">
                      {TABLE_COLUMN_ALIGNMENT_OPTIONS.map((option) => {
                        const active = currentAlignment === option.value;
                        return (
                          <button
                            key={`${column.name}-${option.value}`}
                            type="button"
                            onClick={() => updateTableColumnAlignment(column.name, option.value)}
                            className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                              active
                                ? 'bg-brand/10 text-brand'
                                : 'text-text-tertiary hover:bg-surface-2'
                            }`}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
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
                                className={`rounded-full border px-2 py-1 text-[11px] font-medium transition-colors ${
                                  selected
                                    ? 'border-brand/30 bg-brand/10 text-brand'
                                    : 'border-[rgb(var(--border-line))] bg-surface-1 text-text-tertiary hover:border-[rgb(var(--border-strong))]'
                                }`}
                              >
                                {column.name}
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
          title="Heatmap"
          hint="Split each numeric column into color bands based on that column's own value range."
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
          title="Conditional Formatting"
          hint="Rules run from top to bottom. The first match wins, and conditional formatting overrides heatmap colors on the same cell."
          defaultOpen
        >
          {tableConditionalFormatting.length > 0 && (
            <div className="space-y-3">
              {tableConditionalFormatting.map((rule, index) => {
                const benchmarkMode = getTableBenchmarkMode(rule);
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

                    <SelectSlot
                      label="Highlight Column"
                      required
                      value={rule.field}
                      options={tableFormattingColumns}
                      placeholder="select column"
                      onChange={value => updateTableRule(index, { field: value })}
                    />

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="mb-1 block text-xs font-semibold text-text-secondary">Operator</label>
                        <select
                          value={rule.operator}
                          onChange={e => updateTableRule(index, {
                            operator: e.target.value as ConditionalFormatRule['operator'],
                          })}
                          className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs"
                        >
                          {CONDITIONAL_OPERATOR_OPTIONS.map(option => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="mb-1 block text-xs font-semibold text-text-secondary">Benchmark Type</label>
                        <select
                          value={benchmarkMode}
                          onChange={e => {
                            const nextMode = e.target.value as TableBenchmarkMode;
                            updateTableRule(index, nextMode === 'field'
                              ? { benchmarkField: rule.benchmarkField ?? tableBenchmarkColumns[0]?.name }
                              : { benchmarkField: undefined });
                          }}
                          className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs"
                        >
                          <option value="value">Fixed value</option>
                          <option value="field">Another column</option>
                        </select>
                      </div>
                    </div>

                    {benchmarkMode === 'field' ? (
                      <SelectSlot
                        label="Benchmark Column"
                        required
                        value={rule.benchmarkField || ''}
                        options={tableBenchmarkColumns}
                        placeholder="select column"
                        onChange={value => updateTableRule(index, { benchmarkField: value || undefined })}
                      />
                    ) : (
                      <div>
                        <label className="mb-1 block text-xs font-semibold text-text-secondary">Benchmark</label>
                        <input
                          type="text"
                          value={String(rule.value ?? '')}
                          onChange={e => updateTableRule(index, { value: e.target.value })}
                          placeholder="e.g. 1000"
                          className="w-full rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1.5 text-xs"
                        />
                      </div>
                    )}

                    <div className="grid grid-cols-2 gap-2">
                      <ColorField
                        label="Background"
                        value={rule.backgroundColor || '#dbeafe'}
                        onChange={value => updateTableRule(index, { backgroundColor: value })}
                      />
                      <ColorField
                        label="Text"
                        value={rule.color || '#1f2937'}
                        onChange={value => updateTableRule(index, { color: value })}
                      />
                    </div>

                    {benchmarkMode === 'value' && String(rule.value ?? '').trim() === '' && (
                      <p className="text-[11px] text-warning">
                        Enter a benchmark value to activate this rule on the table.
                      </p>
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
            <MetricSlot label="Value" required single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols}
              onChange={v => upd({ metrics: v })} />
            <MetricSlot label="Benchmark Metric" hint="In Custom SQL mode, choose a second numeric SQL output column. Use {benchmark}, {delta}, or {deltaPercent} in the Context Template." single value={benchmarkMetric} options={numOrAll} allOptions={allCols}
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

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1 block">Manual Benchmark</label>
              <input
                type="number"
                value={normalizedStyleConfig.kpiBenchmarkValue ?? ''}
                placeholder="Optional"
                onChange={e => updStyle({
                  kpiBenchmarkValue: e.target.value === '' ? '' : Number(e.target.value),
                })}
                className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1 block">Benchmark Label</label>
              <input
                type="text"
                value={normalizedStyleConfig.kpiBenchmarkLabel || ''}
                placeholder="Target"
                onChange={e => updStyle({ kpiBenchmarkLabel: e.target.value })}
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
                      <label className="text-[11px] font-semibold text-text-tertiary mb-1 block">Operator</label>
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
                      <label className="text-[11px] font-semibold text-text-tertiary mb-1 block">Value</label>
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
                  </div>

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
            <MetricSlot label={chartType === 'HORIZONTAL_BAR' ? 'Values (X)' : 'Values (Y)'} required value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols}
              onChange={v => upd({ metrics: v })} />
          </>}

          {chartType === 'GROUPED_BAR' && <>
            <SelectSlot label="X Axis" hint="group by" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Value (Y)" required single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols}
              onChange={v => upd({ metrics: v })} />
            <SelectSlot label="Breakdown" hint="grouped by" required value={brk} options={dimOrAll}
              placeholder="select field"
              onChange={v => upd({ breakdown: v || undefined })} />
          </>}

          {chartType === 'STACKED_BAR' && <>
            <SelectSlot label="X Axis" hint="group by" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Value (Y)" required single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols}
              onChange={v => upd({ metrics: v })} />
            <SelectSlot label="Breakdown" hint="stack by" required value={brk} options={dimOrAll}
              placeholder="select field"
              onChange={v => upd({ breakdown: v || undefined })} />
          </>}

          {chartType === 'BAR_LINE' && <>
            <SelectSlot label="X Axis" hint="group by" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Bar Values" hint="shown as bars" required value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols}
              onChange={v => upd({ metrics: v })} />
            <MetricSlot label="Line Value" hint="shown as line" required single value={lineMetric} options={numOrAll} allOptions={allCols}
              onChange={v => upd({ lineMetric: v[0], breakdown: undefined })} />
          </>}


          {chartType === 'LINE' && <>
            <SelectSlot label="X Axis" required value={dim} options={allCols}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Values (Y)" required value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols}
              onChange={v => upd({ metrics: v })} />
            <SelectSlot label="Breakdown" hint="optional" value={brk} options={dimOrAll}
              placeholder="none"
              onChange={v => upd({ breakdown: v || undefined })} />
          </>}

          {chartType === 'AREA' && <>
            <SelectSlot label="X Axis" required value={dim} options={allCols}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Values (Y)" required value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols}
              onChange={v => upd({ metrics: v })} />
            <SelectSlot label="Breakdown" hint="optional" value={brk} options={dimOrAll}
              placeholder="none"
              onChange={v => upd({ breakdown: v || undefined })} />
          </>}

          {chartType === 'TIME_SERIES' && <>
            <SelectSlot label="Time Field (X)" required value={tf} options={timeOrAll}
              placeholder="select time field"
              onChange={v => upd({ timeField: v || undefined })} />
            <MetricSlot label="Values (Y)" required value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols}
              onChange={v => upd({ metrics: v })} />
            <SelectSlot label="Breakdown" hint="optional" value={brk} options={dimOrAll}
              placeholder="none"
              onChange={v => upd({ breakdown: v || undefined })} />
          </>}

          {isPieLike && <>
            <SelectSlot label="Legend" hint="slice label" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Value" hint="slice size" required single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols}
              onChange={v => upd({ metrics: v })} />
          </>}

          {chartType === 'RADAR' && <>
            <SelectSlot label="Axis" hint="category" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Values" required value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols}
              onChange={v => upd({ metrics: v })} />
          </>}

          {isScatterLike && <>
            <SelectSlot label="X Axis" hint="numeric" required value={sx} options={numOrAll}
              placeholder="select X"
              onChange={v => upd({ scatterX: v || undefined })} />
            <SelectSlot label="Y Axis" hint="numeric" required value={sy} options={numOrAll}
              placeholder="select Y"
              onChange={v => upd({ scatterY: v || undefined })} />
            <SelectSlot label="Label" hint="optional" value={dim} options={dimOrAll}
              placeholder="none"
              onChange={v => upd({ dimension: v || undefined })} />
            {chartType === 'BUBBLE' && (
              <MetricSlot label="Size" hint="bubble radius" required single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols}
                onChange={v => upd({ metrics: v })} />
            )}
            {chartType === 'MAP_POINT' && (
              <MetricSlot label="Size" hint="optional" single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols}
                onChange={v => upd({ metrics: v })} />
            )}
          </>}

          {['FUNNEL', 'TREEMAP', 'WATERFALL', 'MAP_REGION', 'WORD_CLOUD', 'BOXPLOT'].includes(chartType) && <>
            <SelectSlot label="Category" hint="group by" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Value" required single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols}
              onChange={v => upd({ metrics: v })} />
          </>}

          {['HEATMAP', 'SANKEY', 'SUNBURST'].includes(chartType) && <>
            <SelectSlot label="Source" hint="first dimension" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <SelectSlot label="Target" hint="second dimension" required value={brk} options={dimOrAll}
              onChange={v => upd({ breakdown: v || undefined })} />
            <MetricSlot label="Value" required single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols}
              onChange={v => upd({ metrics: v })} />
          </>}

          {chartType === 'RIBBON' && <>
            <SelectSlot label="Time Field" required value={tf} options={timeOrAll}
              placeholder="select time field"
              onChange={v => upd({ timeField: v || undefined, dimension: v || undefined })} />
            <SelectSlot label="Ribbon" hint="ranked series" required value={brk} options={dimOrAll}
              onChange={v => upd({ breakdown: v || undefined })} />
            <MetricSlot label="Value" required single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols}
              onChange={v => upd({ metrics: v })} />
          </>}

          {chartType === 'TIMELINE' && <>
            <SelectSlot label="Time Field" required value={tf} options={timeOrAll}
              placeholder="select time field"
              onChange={v => upd({ timeField: v || undefined })} />
            <SelectSlot label="Label" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Value" hint="optional duration or size" single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols}
              onChange={v => upd({ metrics: v })} />
          </>}

          {['GAUGE', 'BULLET'].includes(chartType) && <>
            <MetricSlot label="Value" required single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols}
              onChange={v => upd({ metrics: v })} />
            <MetricSlot label="Target" hint="optional" single value={benchmarkMetric} options={numOrAll} allOptions={allCols}
              onChange={v => upd({ benchmarkMetric: v[0] })} />
          </>}

          {chartType === 'PODIUM' && <>
            <SelectSlot label="Rank Name" hint="category" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Rank Value" required single value={normalizedRoleConfig.metrics} options={numOrAll} allOptions={allCols}
              onChange={v => upd({ metrics: v })} />
          </>}

        </Disclosure>
        </SectionPanel>
      )}

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Appearance: General ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      {showQuickView && (
        <SectionPanel
          step={quickViewStep}
          title="Quick View"
          description="Keep the most-used presentation controls together, then open Advanced only if the preview still needs extra tuning."
        >
        <Disclosure title="Most-used Settings" defaultOpen>
          {/* Color palette ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â compact horizontal row */}
          {/* Chart Title */}
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">Chart Title</label>
            <input type="text" value={styleConfig.chartTitle || ''} placeholder="Optional title"
              onChange={e => updStyle({ chartTitle: e.target.value })}
              className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md" />
          </div>

          {/* PIE: donut hole slider */}
          {isPieLike && (
            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1 block">
                Donut Hole: {styleConfig.pieInnerRadius ?? 0}%
                <span className="ml-1 font-normal text-text-quaternary">({(styleConfig.pieInnerRadius ?? 0) === 0 ? 'Pie' : 'Donut'})</span>
              </label>
              <input type="range" min={0} max={80} step={5} value={styleConfig.pieInnerRadius ?? 0}
                onChange={e => updStyle({ pieInnerRadius: Number(e.target.value) })}
                className="w-full h-1.5 bg-surface-3 rounded-lg accent-blue-500 cursor-pointer" />
            </div>
          )}

          {/* STACKED_BAR: 100% stack mode */}
          {chartType === 'STACKED_BAR' && (
            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1 block">Stack Mode</label>
              <select value={styleConfig.stackMode || 'normal'}
                onChange={e => updStyle({ stackMode: e.target.value as 'normal' | 'percent' })}
                className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1">
                <option value="normal">Normal (absolute values)</option>
                <option value="percent">100% Stacked (percentage)</option>
              </select>
            </div>
          )}

          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1.5 block">Color Palette</label>
            <div className="space-y-1.5">
              {CHART_PALETTES.map(p => (
                <button
                  key={p.name}
                  type="button"
                  onClick={() => updStyle({ palette: p.name })}
                  className={`w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${
                    (styleConfig.palette || 'default') === p.name
                      ? 'border-brand/40 bg-brand/10'
                      : 'border-[rgb(var(--border-line))] bg-surface-1 hover:border-[rgb(var(--border-strong))] hover:bg-surface-2'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className={`text-xs font-medium ${
                      (styleConfig.palette || 'default') === p.name ? 'text-brand' : 'text-text-secondary'
                    }`}>
                      {p.label}
                    </span>
                    {(styleConfig.palette || 'default') === p.name && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-brand" />
                    )}
                  </div>

                  <div className="mt-2 flex items-center gap-1">
                    {p.colors.slice(0, 6).map((c, i) => (
                      <div
                        key={i}
                        className="h-3.5 w-3.5 rounded-sm border border-white/70"
                        style={{ backgroundColor: c }}
                      />
                    ))}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Per-series color overrides (visible when chart has identifiable series). */}
          {!isTableLike && availableSeriesKeys.length > 0 && (
            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1.5 block">
                Series colors
              </label>
              <div className="space-y-1.5">
                {availableSeriesKeys.map(({ key, label }, i) => {
                  const current = styleConfig.seriesColors?.[key] ?? '';
                  const fallback = (CHART_PALETTES.find((p) => p.name === (styleConfig.palette || 'default'))?.colors ?? [])[i] || '#888';
                  return (
                    <div key={key} className="flex items-center gap-2">
                      <span className="flex-1 truncate text-xs text-text-secondary" title={label}>
                        {label}
                      </span>
                      <input
                        type="color"
                        value={current || fallback}
                        onChange={(e) => updStyle({
                          seriesColors: { ...(styleConfig.seriesColors ?? {}), [key]: e.target.value },
                        })}
                        className="h-7 w-10 cursor-pointer rounded border border-[rgb(var(--border-line))]"
                      />
                      {current && (
                        <button
                          type="button"
                          onClick={() => {
                            const next = { ...(styleConfig.seriesColors ?? {}) };
                            delete next[key];
                            updStyle({ seriesColors: next });
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
            </div>
          )}

          {/* Data labels */}
          {!isScatterLike && (
            <Toggle label="Data Labels" checked={styleConfig.showDataLabels ?? false}
              onChange={v => updStyle({ showDataLabels: v })} />
          )}

          {/* Number format */}
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">Number Format</label>
            <select value={styleConfig.numberFormat || 'compact'}
              onChange={e => updStyle({ numberFormat: e.target.value as NumberFormat })}
              className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1">
              <option value="auto">Auto (raw)</option>
              <option value="compact">Compact (1.2K, 3.4M)</option>
              <option value="number">Full Number (1,234)</option>
              <option value="percent">Percent (%)</option>
              <option value="currency">Currency ($)</option>
            </select>
          </div>

          {/* Legend position */}
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">Legend</label>
            <select value={styleConfig.legendPosition || 'bottom'}
              onChange={e => updStyle({ legendPosition: e.target.value as LegendPosition })}
              className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1">
              <option value="top">Top</option>
              <option value="bottom">Bottom</option>
              <option value="left">Left</option>
              <option value="right">Right</option>
              <option value="none">Hidden</option>
            </select>
          </div>

        </Disclosure>

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Appearance: Axis ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
        </SectionPanel>
      )}
      {hasAdvancedControls && (
        <SectionPanel
          step={advancedStep}
          title="Advanced"
          description="Open these only when you need extra control over scale, reference lines, or chart-specific shape details."
        >
        {hasAxis && (
        <Disclosure title="Axes & Scale">
          <Toggle label="Grid Lines" checked={styleConfig.showGrid ?? true}
            onChange={v => updStyle({ showGrid: v })} />
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">X Axis Label</label>
            <input type="text" value={styleConfig.xAxisLabel || ''} placeholder="auto"
              onChange={e => updStyle({ xAxisLabel: e.target.value })}
              className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md" />
          </div>
          <div>
            <label className="text-xs font-semibold text-text-secondary mb-1 block">Y Axis Label</label>
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
            <label className="text-xs font-semibold text-text-secondary mb-1 block">Font Size: {styleConfig.fontSize || 12}px</label>
            <input type="range" min={9} max={18} step={1} value={styleConfig.fontSize || 12}
              onChange={e => updStyle({ fontSize: Number(e.target.value) })}
              className="w-full h-1.5 bg-surface-3 rounded-lg accent-blue-500 cursor-pointer" />
          </div>
        </Disclosure>
      )}

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Appearance: Bar options ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      {supportsBenchmarkLine && (
        <Disclosure title="Benchmark Line" hint="Optional reference line for the numeric axis.">
          <Toggle
            label="Benchmark line"
            checked={normalizedStyleConfig.showBenchmarkLine ?? false}
            onChange={v => updStyle({ showBenchmarkLine: v })}
          />

          {normalizedStyleConfig.showBenchmarkLine && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-semibold text-text-secondary mb-1 block">Benchmark Value</label>
                  <input
                    type="number"
                    value={normalizedStyleConfig.benchmarkValue ?? ''}
                    placeholder="1000"
                    onChange={e => updStyle({
                      benchmarkValue: e.target.value === '' ? '' : Number(e.target.value),
                    })}
                    className={`w-full px-2 py-1.5 text-xs border rounded-md ${
                      normalizedStyleConfig.benchmarkValue === ''
                        ? 'border-warning/40 bg-warning/10'
                        : 'border-[rgb(var(--border-strong))]'
                    }`}
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-text-secondary mb-1 block">Label</label>
                  <input
                    type="text"
                    value={normalizedStyleConfig.benchmarkLabel ?? ''}
                    placeholder="Benchmark"
                    onChange={e => updStyle({ benchmarkLabel: e.target.value })}
                    className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <ColorField
                  label="Line Color"
                  value={normalizedStyleConfig.benchmarkColor || '#dc2626'}
                  onChange={value => updStyle({ benchmarkColor: value })}
                />

                <div>
                  <label className="text-xs font-semibold text-text-secondary mb-1 block">Line Style</label>
                  <select
                    value={normalizedStyleConfig.benchmarkLineStyle || 'dashed'}
                    onChange={e => updStyle({ benchmarkLineStyle: e.target.value as ChartBenchmarkLineStyle })}
                    className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1"
                  >
                    <option value="solid">Solid</option>
                    <option value="dashed">Dashed</option>
                  </select>
                </div>
              </div>
            </>
          )}
        </Disclosure>
      )}

      {isBarType && (
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
          <Toggle label="Show Dots" checked={styleConfig.showDots ?? true}
            onChange={v => updStyle({ showDots: v })} />
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
              {allCols.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </div>
        </Disclosure>
      )}

      {/* Sort & Limit */}
      {supportsDataSection && (
        <Disclosure title="Sort & Limit" hint="Sort by the chart output columns before rendering, then optionally cap the number of displayed rows.">
          {/* Sort rules */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-text-secondary">Sort Rules</span>
              <button type="button"
                onClick={() => {
                  if (sortLimitCols.length === 0) return;
                  updStyle({ chartSortRules: [...chartSortRules, { field: sortLimitCols[0].name, direction: 'asc' }] });
                }}
                disabled={sortLimitCols.length === 0}
                className="text-xs text-brand hover:text-brand disabled:cursor-not-allowed disabled:text-text-quaternary">+ Add rule</button>
            </div>
            {chartSortRules.length === 0 && sortLimitCols.length === 0 && (
              <p className="text-[11px] text-text-quaternary italic">Run query first to enable sorting.</p>
            )}
            {chartSortRules.map((rule, i) => (
              <div key={i} className="flex items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 p-2">
                <span className="text-[11px] text-text-quaternary w-4 text-center">{i + 1}</span>
                <select value={rule.field}
                  onChange={e => updStyle({ chartSortRules: chartSortRules.map((r, ri) => ri === i ? { ...r, field: e.target.value } : r) })}
                  className="flex-1 px-1.5 py-1 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1 min-w-0">
                  {sortLimitCols.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
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

          {/* Top N limit */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1 block">Show</label>
              <select value={styleConfig.dataLimitDirection || 'top'}
                onChange={e => updStyle({ dataLimitDirection: e.target.value as 'top' | 'bottom' })}
                className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md bg-surface-1">
                <option value="top">Top N</option>
                <option value="bottom">Bottom N</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-text-secondary mb-1 block">Limit (rows)</label>
              <input type="number" min={1} value={styleConfig.dataLimit ?? ''} placeholder="all"
                onChange={e => updStyle({ dataLimit: e.target.value === '' ? '' : Number(e.target.value) })}
                className="w-full px-2 py-1.5 text-xs border border-[rgb(var(--border-strong))] rounded-md" />
            </div>
          </div>
        </Disclosure>
      )}
        </SectionPanel>
      )}
    </div>
  );
}
