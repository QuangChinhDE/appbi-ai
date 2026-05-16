import { applyFiltersToRows } from '@/lib/filters';
import type { BaseFilter } from '@/lib/filters';
import {
  getChartRoleConfigValidationMessage,
  metricKey,
  metricLabel,
  normalizeRoleConfig,
  TABLE_PIVOT_COLUMN_LIMIT,
  type ChartRoleConfig,
  type MetricConfig,
  type SemanticLabelMap,
} from './ExploreChartConfig';

export const MAX_CHART_POINTS = 2000;

export interface ChartSeriesDef {
  key: string;
  label: string;
  metric?: MetricConfig;
}

export interface ExploreChartModel {
  roleConfig: ChartRoleConfig;
  invalidMessage?: string;
  xField?: string;
  tableData: Record<string, any>[];
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
  kpiBenchmarkValue?: number;
  kpiBenchmarkMetric?: MetricConfig;
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

function metricOutputCandidates(metric: MetricConfig): string[] {
  const candidates = [
    metricKey(metric),
    metric.outputField,
    `${metric.agg}__${metric.field}`,
    `${metric.field}_${metric.agg}`,
    `${metric.agg}_${metric.field}`,
    `${metric.field}__${metric.agg}`,
    metric.field,
  ].filter((value): value is string => Boolean(value));
  return Array.from(new Set(candidates));
}

function resolveMetricValueField(
  rows: Record<string, any>[],
  metric: MetricConfig,
  preAggregated = false,
): string {
  const candidates = preAggregated
    ? metricOutputCandidates(metric)
    : [metric.field, ...metricOutputCandidates(metric)];

  return candidates.find((candidate) => rows.some((row) => candidate in row)) ?? metric.field;
}

function aggregateMetricValue(
  rows: Record<string, any>[],
  metric: MetricConfig,
  valueField: string = metric.field,
  aggregatedInput = false,
): number {
  const values = rows.map(row => Number(row[valueField]) || 0);
  switch (metric.agg) {
    case 'avg':
      return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
    case 'count':
      return aggregatedInput
        ? values.reduce((sum, value) => sum + value, 0)
        : rows.length;
    case 'min':
      return values.length > 0 ? Math.min(...values) : 0;
    case 'max':
      return values.length > 0 ? Math.max(...values) : 0;
    case 'count_distinct':
      return aggregatedInput
        ? values.reduce((sum, value) => sum + value, 0)
        : new Set(rows.map(row => row[valueField])).size;
    case 'sum':
    default:
      return values.reduce((sum, value) => sum + value, 0);
  }
}

/**
 * Group rows by an exact-equality match on `dimField` and aggregate every
 * metric per group.
 *
 * GRANULARITY CONTRACT (DA review 2026-05-16):
 *
 * This function does NOT bucket time — it groups by string-equality of
 * `row[dimField]`. That works in two scenarios only:
 *
 *   A. `preAggregated=true` is passed by the caller because the BE has
 *      already emitted SELECT … GROUP BY date_trunc(…) on the time
 *      dimension. The rows arriving here are at the chart's intended
 *      granularity (one row per bucket). This is the standard path —
 *      see `SemanticQueryEngine._build_group_by_clause`.
 *
 *   B. `dimField` is a categorical (not a raw timestamp). Each distinct
 *      string value is its own group — correct by definition.
 *
 * Scenarios that BREAK if we get here with raw timestamps:
 *   - live_query path on a non-bucketed datetime column. Every distinct
 *     timestamp becomes its own group; the resulting line chart has one
 *     point per row instead of one per day. To prevent silent wrong
 *     output we now warn in the console so it shows up during DA QA;
 *     the fix is to either route through the semantic engine (qualify
 *     the field) or expose time_grains on the role config.
 *
 * If you need true client-side time bucketing, extend this with a
 * `timeGrain?: 'day' | 'week' | 'month'` parameter and quantize the key.
 * Don't silently re-aggregate — that re-introduces the BE/FE divergence
 * Phase-10 Issue A originally fixed.
 */
function looksLikeRawTimestamp(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  // ISO timestamps with hour/minute/second, e.g. "2026-05-16T14:23:11..."
  // or "2026-05-16 14:23:11". Plain "2026-05-16" (date-only) is OK and
  // a valid bucket.
  return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value);
}

export function applyGroupByAgg(
  data: Record<string, any>[],
  dimField: string,
  metrics: MetricConfig[],
): Record<string, any>[] {
  if (!dimField || metrics.length === 0 || data.length === 0) return data;

  // Phase-12.5 granularity warning. Only fires on raw timestamps; categorical
  // dimensions never trigger it. Keeps DA QA honest without changing output.
  const firstValue = data[0]?.[dimField];
  if (looksLikeRawTimestamp(firstValue)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[chartDataAdapter] applyGroupByAgg called with raw-timestamp values on "${dimField}". ` +
      `Each row becomes its own group, which is almost certainly wrong for a time series. ` +
      `Use the semantic engine (qualify the field as view.field) or pre-bucket on the BE.`,
    );
  }

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
  const valueField = resolveMetricValueField(data, metric, preAggregated);
  const mKey = metricKey(metric);

  // 1. Aggregate to long form: one row per (dim, breakdown) pair with the
  //    metric stored under its canonical metricKey. This is the row that
  //    measure-level filters like "Rev > 0" should be evaluated against.
  const groupMap = new Map<string, Map<string, Record<string, any>[]>>();
  for (const row of data) {
    const dimValue = String(row[dimField] ?? '');
    const breakdownValue = String(row[breakdownField] ?? '');
    if (!groupMap.has(dimValue)) groupMap.set(dimValue, new Map());
    const inner = groupMap.get(dimValue)!;
    if (!inner.has(breakdownValue)) inner.set(breakdownValue, []);
    inner.get(breakdownValue)!.push(row);
  }
  const longForm: Array<Record<string, any>> = [];
  for (const [dimValue, inner] of groupMap.entries()) {
    for (const [breakdownValue, rows] of inner.entries()) {
      longForm.push({
        [dimField]: dimValue,
        [breakdownField]: breakdownValue,
        [mKey]: aggregateMetricValue(rows, metric, valueField, preAggregated),
      });
    }
  }

  // 2. Apply HAVING / measure filters on aggregated long-form rows.
  const surviving = havingFilters.length > 0
    ? applyFiltersToRows(longForm, havingFilters)
    : longForm;

  // 3. Decide which breakdown values remain (cap at 12 distinct values for
  //    rendering). Ordering follows first-appearance to keep stable output.
  const breakdownKeys: string[] = [];
  for (const r of surviving) {
    const k = String(r[breakdownField] ?? '');
    if (!breakdownKeys.includes(k)) breakdownKeys.push(k);
    if (breakdownKeys.length >= 12) break;
  }

  // 4. Pivot only what survived for rendering.
  const dimOrder: string[] = [];
  const pivotMap = new Map<string, Record<string, any>>();
  for (const r of surviving) {
    const dimValue = String(r[dimField] ?? '');
    const breakdownValue = String(r[breakdownField] ?? '');
    if (!breakdownKeys.includes(breakdownValue)) continue;
    if (!pivotMap.has(dimValue)) {
      const seed: Record<string, any> = { [dimField]: dimValue };
      breakdownKeys.forEach((k) => { seed[k] = 0; });
      pivotMap.set(dimValue, seed);
      dimOrder.push(dimValue);
    }
    pivotMap.get(dimValue)![breakdownValue] = r[mKey];
  }

  return {
    data: dimOrder.map((d) => pivotMap.get(d)!),
    series: breakdownKeys.map((key) => ({ key, label: key })),
  };
}

function buildPivotTableModel(args: {
  data: Record<string, any>[];
  roleConfig: ChartRoleConfig;
  preAggregated: boolean;
}) {
  const { data, roleConfig, preAggregated } = args;
  const rowField = roleConfig.tableRowDimension;
  const columnField = roleConfig.tableColumnDimension;
  const metric = roleConfig.tablePivotMetric;

  if (!rowField || !columnField || !metric || data.length === 0) {
    const columns = roleConfig.selectedColumns ?? (data.length > 0 ? Object.keys(data[0]) : []);
    return {
      rows: data,
      columns,
    };
  }

  const valueField = resolveMetricValueField(data, metric, preAggregated);
  const rowGroups = new Map<string, { rowValue: any; cells: Map<string, Record<string, any>[]> }>();
  const pivotColumnValues = new Set<string>();

  for (const row of data) {
    const rowValue = row?.[rowField];
    const rowKey = String(rowValue ?? '');
    const columnValue = String(row?.[columnField] ?? '');

    pivotColumnValues.add(columnValue);

    if (!rowGroups.has(rowKey)) {
      rowGroups.set(rowKey, {
        rowValue,
        cells: new Map(),
      });
    }

    const group = rowGroups.get(rowKey)!;
    if (!group.cells.has(columnValue)) {
      group.cells.set(columnValue, []);
    }
    group.cells.get(columnValue)!.push(row);
  }

  const dynamicColumns = Array.from(pivotColumnValues).sort().slice(0, TABLE_PIVOT_COLUMN_LIMIT);
  const rows = Array.from(rowGroups.entries()).map(([, { rowValue, cells }]) => {
    const result: Record<string, any> = { [rowField]: rowValue };
    dynamicColumns.forEach((columnValue) => {
      const cellRows = cells.get(columnValue) ?? [];
      result[columnValue] = cellRows.length > 0
        ? aggregateMetricValue(cellRows, metric, valueField, preAggregated)
        : null;
    });
    return result;
  });

  return {
    rows,
    columns: [rowField, ...dynamicColumns],
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
  /** Optional map of qualified-or-bare field → display label from the
   *  semantic model. Used so legend / tooltips show measure.label instead
   *  of raw SQL identifiers. */
  labelMap?: SemanticLabelMap;
}): ExploreChartModel {
  const { type, data, roleConfig, havingFilters = [], preAggregated = false, labelMap } = args;
  const normalizedRoleConfig = normalizeRoleConfig(type, roleConfig);
  const { dimension, metrics, breakdown, lineMetric, timeField, scatterX, scatterY, selectedColumns } = normalizedRoleConfig;
  const xField = (type === 'TIME_SERIES' || type === 'RIBBON') ? (timeField || dimension) : dimension;
  const pivotTableModel = (type === 'TABLE' || type === 'MATRIX')
    ? buildPivotTableModel({ data, roleConfig: normalizedRoleConfig, preAggregated })
    : null;
  const tableData = pivotTableModel?.rows ?? data;
  const tableColumns = pivotTableModel?.columns ?? (selectedColumns ?? (data.length > 0 ? Object.keys(data[0]) : []));

  const emptyModel: ExploreChartModel = {
    roleConfig: normalizedRoleConfig,
    invalidMessage: undefined,
    xField,
    tableData,
    tableColumns,
    truncated: false,
    totalPoints: data.length,
    categoricalData: data,
    categoricalSeries: metrics.map(metric => ({
      key: metricKey(metric),
      label: metricLabel(metric, labelMap),
      metric,
    })),
    comboData: data,
    comboBarSeries: metrics.map(metric => ({
      key: metricKey(metric),
      label: metricLabel(metric, labelMap),
      metric,
    })),
    comboLineSeries: lineMetric
      ? [{ key: metricKey(lineMetric), label: metricLabel(lineMetric, labelMap), metric: lineMetric }]
      : [],
    pieData: [],
    scatterPoints: [],
  };

  if (!data.length) {
    return emptyModel;
  }

  const invalidMessage = getChartRoleConfigValidationMessage(type, normalizedRoleConfig);
  if (invalidMessage) {
    return {
      ...emptyModel,
      invalidMessage,
    };
  }

  if (type === 'TABLE' || type === 'MATRIX') {
    return {
      ...emptyModel,
      totalPoints: tableData.length,
    };
  }

  if (type === 'SCATTER' || type === 'BUBBLE' || type === 'MAP_POINT') {
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

  if (type === 'PODIUM') {
    // Podium just needs the raw rows; ChartPreview sorts + slices client-side.
    return { ...emptyModel };
  }

  if (type === 'KPI') {
    const metric = metrics[0];
    const benchmarkMetric = normalizedRoleConfig.benchmarkMetric;
    const metricValueField = metric
      ? resolveMetricValueField(data, metric, preAggregated)
      : undefined;
    const benchmarkValueField = benchmarkMetric
      ? resolveMetricValueField(data, benchmarkMetric, preAggregated)
      : undefined;
    return {
      ...emptyModel,
      kpiMetric: metric,
      kpiBenchmarkMetric: benchmarkMetric,
      kpiValue: metric
        ? (preAggregated
            ? Number(data[0]?.[metricValueField ?? metricKey(metric)]) || 0
            : aggregateMetricValue(data, metric, metricValueField ?? metric.field))
        : undefined,
      kpiBenchmarkValue: benchmarkMetric
        ? (preAggregated
            ? Number(data[0]?.[benchmarkValueField ?? metricKey(benchmarkMetric)]) || 0
            : aggregateMetricValue(data, benchmarkMetric, benchmarkValueField))
        : undefined,
    };
  }

  if (type === 'PIE' || type === 'DONUT' || type === 'POLAR_AREA') {
    const metric = metrics[0];
    const aggregated = xField && metric
      ? (preAggregated ? data : applyGroupByAgg(data, xField, [metric]))
      : data;
    const filteredAggregated = havingFilters.length > 0
      ? applyFiltersToRows(aggregated, havingFilters)
      : aggregated;
    const valueField = metric
      ? resolveMetricValueField(filteredAggregated, metric, preAggregated)
      : undefined;
    return {
      ...emptyModel,
      pieData: dimension && metric
        ? filteredAggregated.slice(0, 20).map(row => ({
            name: String(row[dimension] ?? 'Unknown'),
            value: Number(row[valueField ?? metricKey(metric)]) || 0,
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
        label: metricLabel(metric, labelMap),
        metric,
      })),
      comboLineSeries: lineMetric
        ? [{ key: metricKey(lineMetric), label: metricLabel(lineMetric, labelMap), metric: lineMetric }]
        : [],
    };
  }

  if (breakdown && ['STACKED_BAR', 'GROUPED_BAR', 'LINE', 'AREA', 'TIME_SERIES'].includes(type)) {
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
      label: metricLabel(metric, labelMap),
      metric,
    })),
  };
}
