import { applyFiltersToRows } from '@/lib/filters';
import type { BaseFilter } from '@/lib/filters';
import {
  metricKey,
  metricLabel,
  normalizeRoleConfig,
  type ChartRoleConfig,
  type MetricConfig,
} from './ExploreChartConfig';

export const MAX_CHART_POINTS = 2000;

export interface ChartSeriesDef {
  key: string;
  label: string;
  metric?: MetricConfig;
}

export interface ExploreChartModel {
  roleConfig: ChartRoleConfig;
  xField?: string;
  tableColumns: string[];
  truncated: boolean;
  totalPoints: number;
  categoricalData: Record<string, any>[];
  categoricalSeries: ChartSeriesDef[];
  comboData: Record<string, any>[];
  comboBarSeries: ChartSeriesDef[];
  comboLineSeries: ChartSeriesDef[];
  pieData: Array<{ name: string; value: number }>;
  kpiValue?: number;
  kpiMetric?: MetricConfig;
  scatterPoints: Array<{ x: number; y: number; label?: any }>;
}

function dedupeMetrics(metrics: MetricConfig[]): MetricConfig[] {
  const seen = new Set<string>();
  const deduped: MetricConfig[] = [];
  for (const metric of metrics) {
    const key = metricKey(metric);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(metric);
  }
  return deduped;
}

function aggregateMetricValue(
  rows: Record<string, any>[],
  metric: MetricConfig,
  valueField: string = metric.field,
): number {
  const values = rows.map(row => Number(row[valueField]) || 0);
  switch (metric.agg) {
    case 'avg':
      return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
    case 'count':
      return rows.length;
    case 'min':
      return values.length > 0 ? Math.min(...values) : 0;
    case 'max':
      return values.length > 0 ? Math.max(...values) : 0;
    case 'count_distinct':
      return new Set(rows.map(row => row[valueField])).size;
    case 'sum':
    default:
      return values.reduce((sum, value) => sum + value, 0);
  }
}

export function applyGroupByAgg(
  data: Record<string, any>[],
  dimField: string,
  metrics: MetricConfig[],
): Record<string, any>[] {
  if (!dimField || metrics.length === 0 || data.length === 0) return data;

  const groups = new Map<string, Record<string, any>[]>();
  for (const row of data) {
    const key = String(row[dimField] ?? '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  return Array.from(groups.entries()).map(([dimValue, rows]) => {
    const result: Record<string, any> = { [dimField]: dimValue };
    for (const metric of dedupeMetrics(metrics)) {
      result[metricKey(metric)] = aggregateMetricValue(rows, metric);
    }
    return result;
  });
}

export function pivotByBreakdown(
  data: Record<string, any>[],
  dimField: string,
  metric: MetricConfig,
  breakdownField: string,
  preAggregated = false,
  havingFilters: BaseFilter[] = [],
): { data: Record<string, any>[]; series: ChartSeriesDef[] } {
  const breakdownKeys = [...new Set(data.map(row => String(row[breakdownField] ?? '')))].slice(0, 12);
  const valueField = preAggregated ? metricKey(metric) : metric.field;

  const groupMap = new Map<string, Map<string, Record<string, any>[]>>();
  for (const row of data) {
    const dimValue = String(row[dimField] ?? '');
    const breakdownValue = String(row[breakdownField] ?? '');
    if (!groupMap.has(dimValue)) groupMap.set(dimValue, new Map());
    const breakdownMap = groupMap.get(dimValue)!;
    if (!breakdownMap.has(breakdownValue)) breakdownMap.set(breakdownValue, []);
    breakdownMap.get(breakdownValue)!.push(row);
  }

  const pivoted = Array.from(groupMap.entries()).map(([dimValue, breakdownMap]) => {
    const result: Record<string, any> = { [dimField]: dimValue };
    breakdownKeys.forEach(key => {
      result[key] = 0;
    });
    for (const [breakdownValue, rows] of breakdownMap.entries()) {
      if (!breakdownKeys.includes(breakdownValue)) continue;
      result[breakdownValue] = aggregateMetricValue(rows, metric, valueField);
    }
    return result;
  });

  const filtered = havingFilters.length > 0 ? applyFiltersToRows(pivoted, havingFilters) : pivoted;
  return {
    data: filtered,
    series: breakdownKeys.map(key => ({ key, label: key })),
  };
}

function limitRows(rows: Record<string, any>[]) {
  const truncated = rows.length > MAX_CHART_POINTS;
  return {
    rows: truncated ? rows.slice(0, MAX_CHART_POINTS) : rows,
    truncated,
    totalPoints: rows.length,
  };
}

export function buildExploreChartModel(args: {
  type: string;
  data: Record<string, any>[];
  roleConfig: ChartRoleConfig;
  havingFilters?: BaseFilter[];
  preAggregated?: boolean;
}): ExploreChartModel {
  const { type, data, roleConfig, havingFilters = [], preAggregated = false } = args;
  const normalizedRoleConfig = normalizeRoleConfig(type, roleConfig);
  const { dimension, metrics, breakdown, lineMetric, timeField, scatterX, scatterY, selectedColumns } = normalizedRoleConfig;
  const xField = type === 'TIME_SERIES' ? (timeField || dimension) : dimension;
  const tableColumns = selectedColumns ?? (data.length > 0 ? Object.keys(data[0]) : []);

  const emptyModel: ExploreChartModel = {
    roleConfig: normalizedRoleConfig,
    xField,
    tableColumns,
    truncated: false,
    totalPoints: data.length,
    categoricalData: data,
    categoricalSeries: metrics.map(metric => ({
      key: metricKey(metric),
      label: metricLabel(metric),
      metric,
    })),
    comboData: data,
    comboBarSeries: metrics.map(metric => ({
      key: metricKey(metric),
      label: metricLabel(metric),
      metric,
    })),
    comboLineSeries: lineMetric
      ? [{ key: metricKey(lineMetric), label: metricLabel(lineMetric), metric: lineMetric }]
      : [],
    pieData: [],
    scatterPoints: [],
  };

  if (!data.length) {
    return emptyModel;
  }

  if (type === 'TABLE') {
    return emptyModel;
  }

  if (type === 'SCATTER') {
    return {
      ...emptyModel,
      scatterPoints: scatterX && scatterY
        ? data.map(row => ({
            x: Number(row[scatterX]) || 0,
            y: Number(row[scatterY]) || 0,
            ...(dimension ? { label: row[dimension] } : {}),
          }))
        : [],
    };
  }

  if (type === 'KPI') {
    const metric = metrics[0];
    return {
      ...emptyModel,
      kpiMetric: metric,
      kpiValue: metric
        ? (preAggregated
            ? Number(data[0]?.[metricKey(metric)]) || 0
            : aggregateMetricValue(data, metric))
        : undefined,
    };
  }

  if (type === 'PIE') {
    const metric = metrics[0];
    const aggregated = xField && metric
      ? (preAggregated ? data : applyGroupByAgg(data, xField, [metric]))
      : data;
    return {
      ...emptyModel,
      pieData: dimension && metric
        ? aggregated.slice(0, 20).map(row => ({
            name: String(row[dimension] ?? 'Unknown'),
            value: Number(row[metricKey(metric)]) || 0,
          }))
        : [],
    };
  }

  if (!xField || metrics.length === 0) {
    return emptyModel;
  }

  const aggregated = preAggregated ? data : applyGroupByAgg(data, xField, metrics);
  const filteredAgg = havingFilters.length > 0 ? applyFiltersToRows(aggregated, havingFilters) : aggregated;
  const limitedAgg = limitRows(filteredAgg);

  if (type === 'BAR_LINE') {
    const comboMetrics = dedupeMetrics(lineMetric ? [...metrics, lineMetric] : [...metrics]);
    const comboAgg = preAggregated ? data : applyGroupByAgg(data, xField, comboMetrics);
    const filteredCombo = havingFilters.length > 0 ? applyFiltersToRows(comboAgg, havingFilters) : comboAgg;
    const limitedCombo = limitRows(filteredCombo);

    return {
      ...emptyModel,
      truncated: limitedCombo.truncated,
      totalPoints: limitedCombo.totalPoints,
      comboData: limitedCombo.rows,
      comboBarSeries: metrics.map(metric => ({
        key: metricKey(metric),
        label: metricLabel(metric),
        metric,
      })),
      comboLineSeries: lineMetric
        ? [{ key: metricKey(lineMetric), label: metricLabel(lineMetric), metric: lineMetric }]
        : [],
    };
  }

  if (breakdown && ['STACKED_BAR', 'LINE', 'AREA', 'BAR', 'HORIZONTAL_BAR', 'GROUPED_BAR', 'TIME_SERIES'].includes(type)) {
    const pivoted = pivotByBreakdown(data, xField, metrics[0], breakdown, preAggregated, havingFilters);
    const limitedPivot = limitRows(pivoted.data);
    return {
      ...emptyModel,
      truncated: limitedPivot.truncated,
      totalPoints: limitedPivot.totalPoints,
      categoricalData: limitedPivot.rows,
      categoricalSeries: pivoted.series,
    };
  }

  return {
    ...emptyModel,
    truncated: limitedAgg.truncated,
    totalPoints: limitedAgg.totalPoints,
    categoricalData: limitedAgg.rows,
    categoricalSeries: metrics.map(metric => ({
      key: metricKey(metric),
      label: metricLabel(metric),
      metric,
    })),
  };
}
