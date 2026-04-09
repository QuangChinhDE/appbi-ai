'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Check, Info, X, ChevronDown } from 'lucide-react';
import { CHART_PALETTES, type ChartPaletteName } from '@/lib/chartColors';
import type {
  ChartBenchmarkLineStyle,
  ConditionalFormatRule,
  KpiGoalDirection,
  KpiValueColorRule,
  TableHeatmapRule,
  TableSummaryCalculation,
  TableSummaryRowConfig,
} from '@/types/api';

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Types ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
export type ExploreChartType =
  | 'TABLE' | 'BAR' | 'HORIZONTAL_BAR' | 'GROUPED_BAR' | 'STACKED_BAR'
  | 'LINE' | 'AREA' | 'TIME_SERIES' | 'BAR_LINE'
  | 'PIE' | 'SCATTER' | 'KPI';

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
  // Table
  tableEnableConditionalFormatting?: boolean;
  tableEnableHeatmap?: boolean;
  tableConditionalFormatting?: ConditionalFormatRule[];
  tableHeatmapRules?: TableHeatmapRule[];
  tableShowSummaryRow?: boolean;
  tableSummaryLabel?: string;
  tableSummaryLabelColumn?: string;
  tableSummaryRows?: TableSummaryRowConfig[];
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
  const normalizedMetrics = (roleConfig?.metrics ?? [])
    .map(metric => normalizeMetricConfig(metric as MetricConfig | string))
    .filter((metric): metric is MetricConfig => metric !== null);

  let lineMetric = normalizeMetricConfig(roleConfig?.lineMetric);
  if (!lineMetric && chartType === 'BAR_LINE' && roleConfig?.breakdown) {
    lineMetric = { field: roleConfig.breakdown, agg: 'sum' };
  }
  const benchmarkMetric = normalizeMetricConfig(roleConfig?.benchmarkMetric);
  const tablePivotMetric = normalizeMetricConfig(roleConfig?.tablePivotMetric);
  const tableMode: TableLayoutMode = chartType === 'TABLE' && roleConfig?.tableMode === 'pivot'
    ? 'pivot'
    : 'standard';

  return {
    ...(roleConfig ?? EMPTY_ROLE_CONFIG),
    metrics: normalizedMetrics,
    tableMode,
    ...(benchmarkMetric ? { benchmarkMetric } : {}),
    ...(tablePivotMetric ? { tablePivotMetric } : {}),
    ...(lineMetric ? { lineMetric } : {}),
  };
}

export function getRoleConfigDimensionFields(chartType: string, roleConfig: ChartRoleConfig | null | undefined): string[] {
  const normalized = normalizeRoleConfig(chartType, roleConfig);
  const fields = [normalized.dimension, normalized.timeField];
  if (chartType === 'TABLE' && normalized.tableMode === 'pivot') {
    fields.push(normalized.tableRowDimension, normalized.tableColumnDimension);
  }
  if (chartType !== 'BAR_LINE' && normalized.breakdown) {
    fields.push(normalized.breakdown);
  }
  return fields.filter((field): field is string => Boolean(field));
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Chart type list ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
const CHART_TYPE_GRID: { value: ExploreChartType; label: string; icon: string }[] = [
  { value: 'TABLE',          label: 'Table',          icon: 'TB' },
  { value: 'BAR',            label: 'Bar',            icon: 'BR' },
  { value: 'HORIZONTAL_BAR', label: 'Horizontal Bar', icon: 'HB' },
  { value: 'GROUPED_BAR',    label: 'Grouped Bar',    icon: 'GB' },
  { value: 'STACKED_BAR',    label: 'Stacked Bar',    icon: 'SB' },
  { value: 'BAR_LINE',       label: 'Bar + Line',     icon: 'BL' },
  { value: 'LINE',           label: 'Line',           icon: 'LN' },
  { value: 'AREA',           label: 'Area',           icon: 'AR' },
  { value: 'TIME_SERIES',    label: 'Time Series',    icon: 'TS' },
  { value: 'PIE',            label: 'Pie',            icon: 'PI' },
  { value: 'SCATTER',        label: 'Scatter',        icon: 'XY' },
  { value: 'KPI',            label: 'KPI',            icon: 'KP' },
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
      <Info className="h-3.5 w-3.5 text-gray-400 transition-colors group-hover/help:text-blue-500" />
      <span className="pointer-events-none absolute right-0 top-full z-20 mt-2 hidden w-56 rounded-md bg-slate-900 px-2.5 py-2 text-[11px] font-normal normal-case tracking-normal text-white shadow-lg group-hover/help:block">
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
    <div className="border-t border-gray-100 pt-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-1 group"
      >
        <span className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">
          <span>{title}</span>
          {hint && <HelpTooltip text={hint} />}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="mt-2 space-y-3">{children}</div>}
    </div>
  );
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Toggle switch ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 transition-colors ${
        checked ? 'border-blue-200 bg-blue-50/80' : 'border-gray-200 bg-white'
      }`}
    >
      <div className="min-w-0">
        <div className={`text-xs font-semibold ${checked ? 'text-blue-700' : 'text-gray-600'}`}>{label}</div>
        <div className={`text-[11px] ${checked ? 'text-blue-500' : 'text-gray-400'}`}>
          {checked ? 'Enabled' : 'Disabled'}
        </div>
      </div>
      <button
        type="button"
        aria-pressed={checked}
        aria-label={`${checked ? 'Disable' : 'Enable'} ${label}`}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-10 rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-blue-200 ${
          checked ? 'border-blue-500 bg-blue-500' : 'border-gray-300 bg-gray-200'
        }`}
      >
        <span
          className={`absolute top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        >
          {checked && <Check className="h-2.5 w-2.5 text-blue-600" />}
        </span>
      </button>
    </div>
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
      <label className="flex items-center gap-1 text-xs font-semibold text-gray-600 mb-1">
        {label}
        {required && <span className="text-red-400">*</span>}
        {hint && <HelpTooltip text={hint} />}
      </label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`w-full px-2 py-1.5 text-xs border rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 ${
          missing ? 'border-red-300 bg-red-50' : 'border-gray-300'
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
  label, required, hint, single, value, options, onChange,
}: {
  label: string; required?: boolean; hint?: string;
  single?: boolean;
  value: MetricConfig[]; options: Col[];
  onChange: (v: MetricConfig[]) => void;
}) {
  const missing = required && value.length === 0;

  const addField = (fieldName: string) => {
    if (!fieldName) return;
    if (value.find(m => m.field === fieldName)) return;
    const next: MetricConfig = { field: fieldName, agg: 'sum' };
    onChange(single ? [next] : [...value, next]);
  };

  const removeField = (fieldName: string) => onChange(value.filter(m => m.field !== fieldName));

  const changeAgg = (fieldName: string, agg: AggFn) =>
    onChange(value.map(m => m.field === fieldName ? { ...m, agg } : m));

  const available = options.filter(o => !value.find(m => m.field === o.name));

  return (
    <div>
      <label className="flex items-center gap-1 text-xs font-semibold text-gray-600 mb-1.5">
        {label}
        {required && <span className="text-red-400">*</span>}
        {hint && <HelpTooltip text={hint} />}
      </label>

      {/* Metric pills */}
      {value.length > 0 && (
        <div className="space-y-1.5 mb-2">
          {value.map(m => (
            <div key={m.field}
              className="flex items-center gap-1 pl-2 pr-1 py-1 rounded-md border border-blue-200 bg-blue-50"
            >
              <select
                value={m.agg}
                onChange={e => changeAgg(m.field, e.target.value as AggFn)}
                className="text-xs font-bold text-blue-700 bg-transparent border-none outline-none cursor-pointer"
              >
                {AGG_OPTIONS.map(a => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
              <span className="flex-1 text-xs text-blue-800 truncate" title={m.field}>{m.field}</span>
              <button onClick={() => removeField(m.field)}
                className="p-0.5 rounded hover:bg-blue-200 text-blue-500 flex-shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add field */}
      {(!single || value.length === 0) && (
        <select
          value=""
          onChange={e => addField(e.target.value)}
          className={`w-full px-2 py-1.5 text-xs border rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 ${
            missing ? 'border-red-300 bg-red-50 text-red-400' : 'border-dashed border-gray-300 text-gray-400'
          }`}
        >
          <option value="">{available.length === 0 ? 'all fields added' : '+ add field...'}</option>
          {available.map(o => <option key={o.name} value={o.name}>{o.name}</option>)}
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

  useEffect(() => {
    setDraft(normalizedValue);
  }, [normalizedValue]);

  const commitDraft = () => {
    const next = normalizeColorInput(draft, normalizedValue);
    setDraft(next);
    onChange(next);
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-white px-2 py-1.5">
        <span className="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          {label}
        </span>

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
          className="w-24 rounded border border-gray-200 bg-gray-50 px-1.5 py-1 text-[11px] font-mono uppercase text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />

        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="flex items-center gap-1 rounded-md border border-gray-200 px-1.5 py-1 hover:border-gray-300 hover:bg-gray-50"
        >
          <span
            className="h-4 w-4 rounded border border-gray-200 shadow-inner"
            style={{ backgroundColor: normalizedValue }}
          />
          <ChevronDown className={`h-3 w-3 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-44 rounded-lg border border-gray-200 bg-white p-2 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              Quick Colors
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              title="Close color picker"
            >
              <X className="h-3 w-3" />
            </button>
          </div>

          <div className="grid grid-cols-6 gap-1">
            {COLOR_PRESET_SWATCHES.map((preset) => {
              const active = normalizedValue === preset;
              return (
                <button
                  key={`${label}-${preset}`}
                  type="button"
                  onClick={() => {
                    setDraft(preset);
                    onChange(preset);
                    setOpen(false);
                  }}
                  className={`h-5 rounded-md border transition-transform hover:scale-105 ${
                    active ? 'border-slate-900 ring-1 ring-slate-900/20' : 'border-gray-200'
                  }`}
                  style={{ backgroundColor: preset }}
                  title={preset}
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
  tableDisplayColumns?: Col[];
  queryMode?: 'generated' | 'custom';
  onChartTypeChange: (t: ExploreChartType) => void;
  onRoleConfigChange: (c: ChartRoleConfig) => void;
  onStyleConfigChange: (c: ChartStyleConfig) => void;
}

export function ExploreChartConfig({
  chartType,
  roleConfig,
  styleConfig,
  availableColumns,
  tableDisplayColumns = [],
  queryMode = 'generated',
  onChartTypeChange,
  onRoleConfigChange,
  onStyleConfigChange,
}: ExploreChartConfigProps) {
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

  const isBarType = ['BAR', 'HORIZONTAL_BAR', 'GROUPED_BAR', 'STACKED_BAR', 'BAR_LINE'].includes(chartType);
  const isLineType = ['LINE', 'TIME_SERIES', 'AREA', 'BAR_LINE'].includes(chartType);
  const hasAxis = !['PIE', 'KPI', 'TABLE'].includes(chartType);
  const supportsBenchmarkLine = ['BAR', 'HORIZONTAL_BAR', 'GROUPED_BAR', 'STACKED_BAR', 'LINE', 'AREA', 'TIME_SERIES', 'BAR_LINE'].includes(chartType);
  const roleSectionTitle = queryMode === 'custom' ? 'SQL Output Columns' : 'Field Mapping';
  const tableRoleSectionHint = queryMode === 'custom'
    ? 'Choose directly from the columns returned by your SQL. Nothing is inferred back into Config Builder fields.'
    : 'Standard table stays as-is. Enable pivot only when you want dynamic cross-tab headers driven by distinct column values.';
  const chartRoleSectionHint = queryMode === 'custom'
    ? 'Choose which SQL output columns drive this chart. These selections work directly on your SQL output.'
    : undefined;

  const setTableConditionalFormatting = (rules: ConditionalFormatRule[]) => {
    updStyle({ tableConditionalFormatting: rules.length > 0 ? rules : undefined });
  };

  const setTableHeatmapRules = (rules: TableHeatmapRule[]) => {
    updStyle({ tableHeatmapRules: rules.length > 0 ? rules : undefined });
  };

  const setTableSummaryRows = (rows: TableSummaryRowConfig[]) => {
    updStyle({ tableSummaryRows: rows.length > 0 ? rows : undefined });
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

  return (
    <div className="p-4 space-y-3">

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Chart Type ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ visual grid ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Chart Type</p>
        <div className="grid grid-cols-4 gap-1">
          {CHART_TYPE_GRID.map(({ value, label, icon }) => (
            <button key={value} onClick={() => onChartTypeChange(value)}
              className={`flex flex-col items-center gap-0.5 px-1 py-1.5 rounded-md text-[10px] leading-tight transition-colors border
                ${chartType === value
                  ? 'border-blue-400 bg-blue-50 text-blue-700 font-semibold'
                  : 'border-transparent hover:bg-gray-50 text-gray-600'
                }`}
              title={label}
            >
              <span className="text-sm">{icon}</span>
              <span className="truncate w-full text-center">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ TABLE: column picker ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      {chartType === 'TABLE' && availableColumns.length > 0 && (
        <Disclosure
          title={roleSectionTitle}
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
                  className="text-xs text-blue-600 hover:text-blue-800"
                >
                  {!normalizedRoleConfig.selectedColumns || normalizedRoleConfig.selectedColumns.length === availableColumns.length ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
                {availableColumns.map(col => {
                  const checked = !normalizedRoleConfig.selectedColumns || normalizedRoleConfig.selectedColumns.includes(col.name);
                  return (
                    <label key={col.name} className="flex items-center gap-2 py-1 px-2 rounded hover:bg-gray-50 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const current = normalizedRoleConfig.selectedColumns ?? availableColumns.map(c => c.name);
                          const next = checked ? current.filter(n => n !== col.name) : [...current, col.name];
                          upd({ selectedColumns: next });
                        }}
                        className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-xs text-gray-700 truncate flex-1">{col.name}</span>
                      <span className="text-xs text-gray-400 opacity-0 group-hover:opacity-100">{col.type}</span>
                    </label>
                  );
                })}
              </div>
            </>
          )}
        </Disclosure>
      )}

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Field Mapping ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      {chartType === 'TABLE' && (
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

      {chartType === 'TABLE' && isSummaryRowEnabled && tableNumericColumns.length > 0 && (
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
                    className="space-y-2.5 rounded-lg border border-gray-200 bg-gray-50 p-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                        Summary Row {index + 1}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeTableSummaryRow(index)}
                        className="rounded p-1 text-gray-400 hover:bg-white hover:text-red-500"
                        title="Remove summary row"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="mb-1 block text-xs font-semibold text-gray-600">Label</label>
                        <input
                          type="text"
                          value={summaryRow.label || ''}
                          onChange={e => updateTableSummaryRow(index, { label: e.target.value || `Summary ${index + 1}` })}
                          className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs"
                          placeholder="Total"
                        />
                      </div>

                      <div>
                        <label className="mb-1 block text-xs font-semibold text-gray-600">Formula</label>
                        <select
                          value={summaryRow.calculation}
                          onChange={e => updateTableSummaryRow(index, {
                            calculation: e.target.value as TableSummaryCalculation,
                          })}
                          className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs"
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
                        <span className="text-xs font-semibold text-gray-600">Columns</span>
                        <div className="inline-flex rounded-md border border-gray-200 bg-white p-1">
                          <button
                            type="button"
                            onClick={() => toggleTableSummaryRowColumnMode(index, true)}
                            className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                              usesAllColumns ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-50'
                            }`}
                          >
                            All numeric
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleTableSummaryRowColumnMode(index, false)}
                            className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                              !usesAllColumns ? 'bg-blue-50 text-blue-700' : 'text-gray-500 hover:bg-gray-50'
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
                                    ? 'border-blue-200 bg-blue-50 text-blue-700'
                                    : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
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
            className="w-full rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100"
          >
            + Add summary row
          </button>
        </Disclosure>
      )}

      {chartType === 'TABLE' && isHeatmapEnabled && tableNumericColumns.length > 0 && (
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
                  className="space-y-2.5 rounded-lg border border-gray-200 bg-gray-50 p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                      Heatmap {index + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeTableHeatmapRule(index)}
                      className="rounded p-1 text-gray-400 hover:bg-white hover:text-red-500"
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
                    <label className="mb-1 block text-xs font-semibold text-gray-600">Bands</label>
                    <select
                      value={String(rule.steps ?? 5)}
                      onChange={e => updateTableHeatmapRule(index, { steps: Number(e.target.value) })}
                      className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs"
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

      {chartType === 'TABLE' && isConditionalFormattingEnabled && tableFormattingColumns.length > 0 && (
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
                    className="space-y-2.5 rounded-lg border border-gray-200 bg-gray-50 p-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                        Rule {index + 1}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeTableRule(index)}
                        className="rounded p-1 text-gray-400 hover:bg-white hover:text-red-500"
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
                        <label className="mb-1 block text-xs font-semibold text-gray-600">Operator</label>
                        <select
                          value={rule.operator}
                          onChange={e => updateTableRule(index, {
                            operator: e.target.value as ConditionalFormatRule['operator'],
                          })}
                          className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs"
                        >
                          {CONDITIONAL_OPERATOR_OPTIONS.map(option => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="mb-1 block text-xs font-semibold text-gray-600">Benchmark Type</label>
                        <select
                          value={benchmarkMode}
                          onChange={e => {
                            const nextMode = e.target.value as TableBenchmarkMode;
                            updateTableRule(index, nextMode === 'field'
                              ? { benchmarkField: rule.benchmarkField ?? tableBenchmarkColumns[0]?.name }
                              : { benchmarkField: undefined });
                          }}
                          className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs"
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
                        <label className="mb-1 block text-xs font-semibold text-gray-600">Benchmark</label>
                        <input
                          type="text"
                          value={String(rule.value ?? '')}
                          onChange={e => updateTableRule(index, { value: e.target.value })}
                          placeholder="e.g. 1000"
                          className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-xs"
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
                      <p className="text-[11px] text-amber-600">
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
            className="w-full rounded-md border border-dashed border-blue-300 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700 hover:bg-blue-100"
          >
            + Add rule
          </button>

        </Disclosure>
      )}

      {chartType === 'KPI' && (
        <Disclosure title="Card Options" hint="Make the KPI card smarter with labels, context, benchmark, and value rules.">
          <div>
            <label className="text-xs font-semibold text-gray-600 mb-1 block">Card Label</label>
            <input
              type="text"
              value={normalizedStyleConfig.kpiLabel || ''}
              placeholder="Use metric label"
              onChange={e => updStyle({ kpiLabel: e.target.value })}
              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md"
            />
          </div>

          <div>
            <label className="flex items-center gap-1 text-xs font-semibold text-gray-600 mb-1">
              Context Template
              <HelpTooltip text="Use tokens like {value}, {benchmark}, {delta}, {deltaPercent}, {benchmarkLabel}, {label}, {rows}, {rawValue}. If Benchmark Metric is set, the card uses that dynamic value before the manual benchmark value." />
            </label>
            <textarea
              value={normalizedStyleConfig.kpiContextTemplate || ''}
              placeholder="Example: {delta} above {benchmarkLabel} {benchmark}"
              onChange={e => updStyle({ kpiContextTemplate: e.target.value })}
              rows={3}
              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md resize-none"
            />
            <div className="mt-2 flex flex-wrap gap-1">
              {KPI_TEMPLATE_TOKENS.map((token) => (
                <button
                  key={token}
                  type="button"
                  onClick={() => updStyle({
                    kpiContextTemplate: `${normalizedStyleConfig.kpiContextTemplate || ''}${token}`,
                  })}
                  className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700 hover:bg-blue-100"
                >
                  {token}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-semibold text-gray-600 mb-1 block">Manual Benchmark</label>
              <input
                type="number"
                value={normalizedStyleConfig.kpiBenchmarkValue ?? ''}
                placeholder="Optional"
                onChange={e => updStyle({
                  kpiBenchmarkValue: e.target.value === '' ? '' : Number(e.target.value),
                })}
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-gray-600 mb-1 block">Benchmark Label</label>
              <input
                type="text"
                value={normalizedStyleConfig.kpiBenchmarkLabel || ''}
                placeholder="Target"
                onChange={e => updStyle({ kpiBenchmarkLabel: e.target.value })}
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md"
              />
            </div>
          </div>

          {normalizedRoleConfig.benchmarkMetric && (
            <p className="text-[11px] text-gray-500">
              Dynamic benchmark is currently driven by {metricLabel(normalizedRoleConfig.benchmarkMetric)}.
              Manual Benchmark is only used when no Benchmark Metric is set, and you can keep the benchmark hidden while still using it in the template or delta.
            </p>
          )}

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
              <label className="text-xs font-semibold text-gray-600 mb-1 block">Goal Direction</label>
              <select
                value={normalizedStyleConfig.kpiGoalDirection || 'up'}
                onChange={e => updStyle({ kpiGoalDirection: e.target.value as KpiGoalDirection })}
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white"
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
                <div key={`kpi-rule-${index}`} className="rounded-lg border border-gray-200 bg-gray-50/80 p-2 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                      Rule {index + 1}
                    </div>
                    <button
                      type="button"
                      onClick={() => updStyle({
                        kpiColorRules: (normalizedStyleConfig.kpiColorRules ?? []).filter((_, ruleIndex) => ruleIndex !== index),
                      })}
                      className="rounded p-1 text-gray-400 hover:bg-white hover:text-red-500"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>

                  <div className="grid grid-cols-[96px_1fr] gap-2">
                    <div>
                      <label className="text-[11px] font-semibold text-gray-500 mb-1 block">Operator</label>
                      <select
                        value={rule.operator}
                        onChange={e => updStyle({
                          kpiColorRules: (normalizedStyleConfig.kpiColorRules ?? []).map((currentRule, ruleIndex) => (
                            ruleIndex === index
                              ? { ...currentRule, operator: e.target.value as KpiValueColorRule['operator'] }
                              : currentRule
                          )),
                        })}
                        className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white"
                      >
                        {CONDITIONAL_OPERATOR_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-[11px] font-semibold text-gray-500 mb-1 block">Value</label>
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
                        className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-[11px] font-semibold text-gray-500 mb-1 block">Status Label</label>
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
                      className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white"
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
                className="w-full rounded-md border border-dashed border-gray-300 px-3 py-2 text-xs font-medium text-gray-500 hover:border-gray-400 hover:text-gray-700"
              >
                + Add Color Rule
              </button>
            </div>
          )}
        </Disclosure>
      )}

      {chartType !== 'TABLE' && (
        <Disclosure title={roleSectionTitle} hint={chartRoleSectionHint} defaultOpen>

          {(chartType === 'BAR' || chartType === 'HORIZONTAL_BAR') && <>
            <SelectSlot label={chartType === 'HORIZONTAL_BAR' ? 'Y Axis' : 'X Axis'} hint="group by" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label={chartType === 'HORIZONTAL_BAR' ? 'Values (X)' : 'Values (Y)'} required value={normalizedRoleConfig.metrics} options={numOrAll}
              onChange={v => upd({ metrics: v })} />
            <SelectSlot label="Breakdown" hint="optional" value={brk} options={dimOrAll}
              placeholder="none"
              onChange={v => upd({ breakdown: v || undefined })} />
          </>}

          {chartType === 'GROUPED_BAR' && <>
            <SelectSlot label="X Axis" hint="group by" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Values (Y)" hint="each = one bar group" required value={normalizedRoleConfig.metrics} options={numOrAll}
              onChange={v => upd({ metrics: v })} />
          </>}

          {chartType === 'STACKED_BAR' && <>
            <SelectSlot label="X Axis" hint="group by" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Value (Y)" required single value={normalizedRoleConfig.metrics} options={numOrAll}
              onChange={v => upd({ metrics: v })} />
            <SelectSlot label="Stack by" required value={brk} options={dimOrAll}
              placeholder="select field"
              onChange={v => upd({ breakdown: v || undefined })} />
          </>}

          {chartType === 'BAR_LINE' && <>
            <SelectSlot label="X Axis" hint="group by" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Bar Values" hint="shown as bars" required value={normalizedRoleConfig.metrics} options={numOrAll}
              onChange={v => upd({ metrics: v })} />
            <MetricSlot label="Line Value" hint="shown as line" required single value={lineMetric} options={numOrAll}
              onChange={v => upd({ lineMetric: v[0], breakdown: undefined })} />
          </>}


          {chartType === 'LINE' && <>
            <SelectSlot label="X Axis" required value={dim} options={allCols}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Values (Y)" required value={normalizedRoleConfig.metrics} options={numOrAll}
              onChange={v => upd({ metrics: v })} />
            <SelectSlot label="Breakdown" hint="optional" value={brk} options={dimOrAll}
              placeholder="none"
              onChange={v => upd({ breakdown: v || undefined })} />
          </>}

          {chartType === 'AREA' && <>
            <SelectSlot label="X Axis" required value={dim} options={allCols}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Values (Y)" required value={normalizedRoleConfig.metrics} options={numOrAll}
              onChange={v => upd({ metrics: v })} />
            <SelectSlot label="Breakdown" hint="optional" value={brk} options={dimOrAll}
              placeholder="none"
              onChange={v => upd({ breakdown: v || undefined })} />
          </>}

          {chartType === 'TIME_SERIES' && <>
            <SelectSlot label="Time Field (X)" required value={tf} options={timeOrAll}
              placeholder="select time field"
              onChange={v => upd({ timeField: v || undefined })} />
            <MetricSlot label="Values (Y)" required value={normalizedRoleConfig.metrics} options={numOrAll}
              onChange={v => upd({ metrics: v })} />
            <SelectSlot label="Breakdown" hint="optional" value={brk} options={dimOrAll}
              placeholder="none"
              onChange={v => upd({ breakdown: v || undefined })} />
          </>}

          {chartType === 'PIE' && <>
            <SelectSlot label="Legend" hint="slice label" required value={dim} options={dimOrAll}
              onChange={v => upd({ dimension: v || undefined })} />
            <MetricSlot label="Value" hint="slice size" required single value={normalizedRoleConfig.metrics} options={numOrAll}
              onChange={v => upd({ metrics: v })} />
          </>}

          {chartType === 'SCATTER' && <>
            <SelectSlot label="X Axis" hint="numeric" required value={sx} options={numOrAll}
              placeholder="select X"
              onChange={v => upd({ scatterX: v || undefined })} />
            <SelectSlot label="Y Axis" hint="numeric" required value={sy} options={numOrAll}
              placeholder="select Y"
              onChange={v => upd({ scatterY: v || undefined })} />
            <SelectSlot label="Label" hint="optional" value={dim} options={dimOrAll}
              placeholder="none"
              onChange={v => upd({ dimension: v || undefined })} />
          </>}

          {chartType === 'KPI' && <>
            <MetricSlot label="Value" required single value={normalizedRoleConfig.metrics} options={numOrAll}
              onChange={v => upd({ metrics: v })} />
            <MetricSlot label="Benchmark Metric" hint="optional dynamic comparison" single value={benchmarkMetric} options={numOrAll}
              onChange={v => upd({ benchmarkMetric: v[0] || undefined })} />
            <p className="text-[11px] text-gray-500">
              In Custom SQL mode, choose a second numeric SQL output column for Benchmark Metric, then use {`{benchmark}`}, {`{delta}`}, or {`{deltaPercent}`} in the Context Template.
            </p>
          </>}

        </Disclosure>
      )}

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Appearance: General ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      {chartType !== 'TABLE' && (
        <Disclosure title="General" defaultOpen>
          {/* Color palette ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â compact horizontal row */}
          {chartType !== 'KPI' && (
            <div>
              <label className="text-xs font-semibold text-gray-600 mb-1.5 block">Color Palette</label>
              <div className="space-y-1">
                {CHART_PALETTES.map(p => (
                  <button key={p.name} onClick={() => updStyle({ palette: p.name })}
                    className={`w-full flex items-center gap-2 px-2 py-1 rounded-md border text-xs transition-colors ${
                      (styleConfig.palette || 'default') === p.name
                        ? 'border-blue-400 bg-blue-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}>
                    <div className="flex gap-0.5">
                      {p.colors.slice(0, 6).map((c, i) => (
                        <div key={i} className="w-3 h-3 rounded-sm" style={{ backgroundColor: c }} />
                      ))}
                    </div>
                    <span className="text-gray-700">{p.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Data labels */}
          {chartType !== 'KPI' && chartType !== 'SCATTER' && (
            <Toggle label="Data Labels" checked={styleConfig.showDataLabels ?? false}
              onChange={v => updStyle({ showDataLabels: v })} />
          )}

          {/* Number format */}
          <div>
            <label className="text-xs font-semibold text-gray-600 mb-1 block">Number Format</label>
            <select value={styleConfig.numberFormat || 'compact'}
              onChange={e => updStyle({ numberFormat: e.target.value as NumberFormat })}
              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white">
              <option value="auto">Auto (raw)</option>
              <option value="compact">Compact (1.2K, 3.4M)</option>
              <option value="number">Full Number (1,234)</option>
              <option value="percent">Percent (%)</option>
              <option value="currency">Currency ($)</option>
            </select>
          </div>

          {/* Legend position */}
          {chartType !== 'KPI' && (
            <div>
              <label className="text-xs font-semibold text-gray-600 mb-1 block">Legend</label>
              <select value={styleConfig.legendPosition || 'bottom'}
                onChange={e => updStyle({ legendPosition: e.target.value as LegendPosition })}
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white">
                <option value="top">Top</option>
                <option value="bottom">Bottom</option>
                <option value="left">Left</option>
                <option value="right">Right</option>
                <option value="none">Hidden</option>
              </select>
            </div>
          )}

          {chartType !== 'KPI' && (
            <Toggle label="Grid Lines" checked={styleConfig.showGrid ?? true}
              onChange={v => updStyle({ showGrid: v })} />
          )}
        </Disclosure>
      )}

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Appearance: Axis ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      {hasAxis && (
        <Disclosure title="Axis">
          <div>
            <label className="text-xs font-semibold text-gray-600 mb-1 block">X Axis Label</label>
            <input type="text" value={styleConfig.xAxisLabel || ''} placeholder="auto"
              onChange={e => updStyle({ xAxisLabel: e.target.value })}
              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md" />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-600 mb-1 block">Y Axis Label</label>
            <input type="text" value={styleConfig.yAxisLabel || ''} placeholder="auto"
              onChange={e => updStyle({ yAxisLabel: e.target.value })}
              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-semibold text-gray-600 mb-1 block">Y Min</label>
              <input type="number" value={styleConfig.yAxisMin ?? ''} placeholder="auto"
                onChange={e => updStyle({ yAxisMin: e.target.value === '' ? '' : Number(e.target.value) })}
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md" />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-600 mb-1 block">Y Max</label>
              <input type="number" value={styleConfig.yAxisMax ?? ''} placeholder="auto"
                onChange={e => updStyle({ yAxisMax: e.target.value === '' ? '' : Number(e.target.value) })}
                className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md" />
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-600 mb-1 block">Font Size: {styleConfig.fontSize || 12}px</label>
            <input type="range" min={9} max={18} step={1} value={styleConfig.fontSize || 12}
              onChange={e => updStyle({ fontSize: Number(e.target.value) })}
              className="w-full h-1.5 bg-gray-200 rounded-lg accent-blue-500 cursor-pointer" />
          </div>
        </Disclosure>
      )}

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Appearance: Bar options ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      {supportsBenchmarkLine && (
        <Disclosure title="Benchmark" hint="Optional reference line for the numeric axis.">
          <Toggle
            label="Benchmark line"
            checked={normalizedStyleConfig.showBenchmarkLine ?? false}
            onChange={v => updStyle({ showBenchmarkLine: v })}
          />

          {normalizedStyleConfig.showBenchmarkLine && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-semibold text-gray-600 mb-1 block">Benchmark Value</label>
                  <input
                    type="number"
                    value={normalizedStyleConfig.benchmarkValue ?? ''}
                    placeholder="1000"
                    onChange={e => updStyle({
                      benchmarkValue: e.target.value === '' ? '' : Number(e.target.value),
                    })}
                    className={`w-full px-2 py-1.5 text-xs border rounded-md ${
                      normalizedStyleConfig.benchmarkValue === ''
                        ? 'border-amber-300 bg-amber-50'
                        : 'border-gray-300'
                    }`}
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-gray-600 mb-1 block">Label</label>
                  <input
                    type="text"
                    value={normalizedStyleConfig.benchmarkLabel ?? ''}
                    placeholder="Benchmark"
                    onChange={e => updStyle({ benchmarkLabel: e.target.value })}
                    className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md"
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
                  <label className="text-xs font-semibold text-gray-600 mb-1 block">Line Style</label>
                  <select
                    value={normalizedStyleConfig.benchmarkLineStyle || 'dashed'}
                    onChange={e => updStyle({ benchmarkLineStyle: e.target.value as ChartBenchmarkLineStyle })}
                    className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white"
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
        <Disclosure title="Bar Options">
          <div>
            <label className="text-xs font-semibold text-gray-600 mb-1 block">Bar Radius: {styleConfig.barRadius ?? 4}px</label>
            <input type="range" min={0} max={12} step={1} value={styleConfig.barRadius ?? 4}
              onChange={e => updStyle({ barRadius: Number(e.target.value) })}
              className="w-full h-1.5 bg-gray-200 rounded-lg accent-blue-500 cursor-pointer" />
          </div>
        </Disclosure>
      )}

      {/* ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Appearance: Line options ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ */}
      {isLineType && (
        <Disclosure title="Line Options">
          <Toggle label="Show Dots" checked={styleConfig.showDots ?? true}
            onChange={v => updStyle({ showDots: v })} />
          <div>
            <label className="text-xs font-semibold text-gray-600 mb-1 block">Line Style</label>
            <select value={styleConfig.lineStyle || 'solid'}
              onChange={e => updStyle({ lineStyle: e.target.value as 'solid' | 'dashed' })}
              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded-md bg-white">
              <option value="solid">Solid</option>
              <option value="dashed">Dashed</option>
            </select>
          </div>
        </Disclosure>
      )}
    </div>
  );
}
