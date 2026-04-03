'use client';

import React, { useMemo } from 'react';
import {
  BarChart, Bar, LabelList,
  LineChart, Line,
  AreaChart, Area,
  ScatterChart, Scatter, ZAxis,
  PieChart, Pie, Cell,
  ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts';
import type { ChartRoleConfig, MetricConfig, AggFn, ChartStyleConfig } from './ExploreChartConfig';
import { metricKey, metricLabel, DEFAULT_STYLE_CONFIG } from './ExploreChartConfig';
import { TableVisualization } from '@/components/visualizations/TableVisualization';
import { applyFiltersToRows } from '@/lib/filters';
import type { BaseFilter } from '@/lib/filters';
import { getPalette, type ChartPaletteName } from '@/lib/chartColors';

/** Maximum data points to render in a chart (BAR/LINE/AREA/STACKED_BAR etc.).
 *  Beyond this Recharts DOM rendering becomes unusably slow. */
const MAX_CHART_POINTS = 2000;

// ── X-axis smart helpers ──────────────────────────────────────────────────────
/** Number of items beyond which bars are rendered in a scrollable container. */
const SCROLL_THRESHOLD = 40;
/** Minimum px allocated per bar/category when the chart is scrollable. */
const MIN_ITEM_WIDTH = 38;

/**
 * Return XAxis props that adapt angle, height and tick interval to the number
 * of data points so labels never overlap regardless of screen size.
 */
function buildXAxisProps(count: number, fontSize: number, xAxisLabel?: string) {
  const angle   = count > 60 ? -45 : count > 25 ? -30 : 0;
  const height  = count > 25 ? 60 : 30;
  const textAnchor: 'end' | 'middle' = angle !== 0 ? 'end' : 'middle';
  // When scrollable we show every tick; otherwise thin out high-cardinality axes.
  const interval = count > SCROLL_THRESHOLD
    ? 0
    : count > 80
      ? Math.ceil(count / 30)
      : count > 40
        ? Math.ceil(count / 40)
        : 'preserveStartEnd';
  return { angle, height, textAnchor, interval, labelOffset: angle !== 0 ? -10 : -5, xAxisLabel };
}

/**
 * Wrap a Recharts chart element in a horizontally-scrollable container when
 * the number of categories exceeds SCROLL_THRESHOLD. The chart is given
 * sufficient horizontal space so every bar/point has breathing room.
 */
function wrapScrollable(el: React.ReactNode, count: number): React.ReactNode {
  if (count <= SCROLL_THRESHOLD) {
    return (
      <ResponsiveContainer width="100%" height="100%">
        {el as React.ReactElement}
      </ResponsiveContainer>
    );
  }
  const chartWidth = Math.max(count * MIN_ITEM_WIDTH, 700);
  return (
    <div style={{ width: '100%', height: '100%', overflowX: 'auto', overflowY: 'hidden' }}>
      <div style={{ width: chartWidth, height: '100%' }}>
        <ResponsiveContainer width="100%" height="100%">
          {el as React.ReactElement}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ── Number formatting ─────────────────────────────────────────────────────────
function formatNumber(value: any, style?: ChartStyleConfig): string {
  const n = Number(value);
  if (isNaN(n)) return String(value);
  const fmt = style?.numberFormat || 'compact';
  const dec = style?.decimalPlaces ?? 1;
  switch (fmt) {
    case 'compact':
      if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(dec)}B`;
      if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(dec)}M`;
      if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(dec)}K`;
      return n % 1 !== 0 ? n.toFixed(dec) : n.toLocaleString();
    case 'percent':
      return `${(n * 100).toFixed(dec)}%`;
    case 'currency':
      return `${style?.currencySymbol || '$'}${n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
    case 'number':
      return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: dec });
    default: // 'auto'
      return typeof value === 'number' ? value.toLocaleString() : String(value);
  }
}

function yAxisTickFormatter(style?: ChartStyleConfig) {
  return (value: any) => formatNumber(value, style);
}

function tooltipFormatter(metrics: MetricConfig[], style?: ChartStyleConfig) {
  return (value: any, name: string) => {
    const m = metrics.find(m => metricKey(m) === name);
    return [formatNumber(value, style), m ? metricLabel(m) : name];
  };
}

function dataLabelFormatter(style?: ChartStyleConfig) {
  return (value: any) => formatNumber(value, style);
}

// ── Client-side group-by + aggregation (like PowerBI) ─────────────────────────
function applyGroupByAgg(
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

  return Array.from(groups.entries()).map(([dimVal, rows]) => {
    const result: Record<string, any> = { [dimField]: dimVal };
    for (const m of metrics) {
      const key = metricKey(m);
      const vals = rows.map(r => Number(r[m.field]) || 0);
      switch (m.agg) {
        case 'sum':            result[key] = vals.reduce((a, b) => a + b, 0); break;
        case 'avg':            result[key] = vals.reduce((a, b) => a + b, 0) / vals.length; break;
        case 'count':          result[key] = rows.length; break;
        case 'min':            result[key] = Math.min(...vals); break;
        case 'max':            result[key] = Math.max(...vals); break;
        case 'count_distinct': result[key] = new Set(rows.map(r => r[m.field])).size; break;
        default:               result[key] = vals.reduce((a, b) => a + b, 0);
      }
    }
    return result;
  });
}

// ── Pivot rows by breakdown field ──────────────────────────────────────────────
function pivotByBreakdown(
  data: Record<string, any>[],
  dimField: string,
  metric: MetricConfig,
  breakdownField: string,
  preAggregated = false,
  havingFilters: BaseFilter[] = [],
): { pivoted: Record<string, any>[]; seriesKeys: string[] } {
  const seriesKeys = [...new Set(data.map(r => String(r[breakdownField] ?? '')))].slice(0, 12);
  // When backend pre-aggregated, the metric value is in the aliased column (e.g. "sum__field")
  const valueKey = preAggregated ? metricKey(metric) : metric.field;

  // Two-pass: collect raw rows per (dim, breakdown) group, then aggregate properly
  const groupMap = new Map<string, Map<string, Record<string, any>[]>>();
  for (const row of data) {
    const dk = String(row[dimField] ?? '');
    const bk = String(row[breakdownField] ?? '');
    if (!groupMap.has(dk)) groupMap.set(dk, new Map());
    const bkMap = groupMap.get(dk)!;
    if (!bkMap.has(bk)) bkMap.set(bk, []);
    bkMap.get(bk)!.push(row);
  }

  const pivoted: Record<string, any>[] = [];
  for (const [dk, bkMap] of groupMap) {
    const out: Record<string, any> = { [dimField]: dk };
    seriesKeys.forEach(k => { out[k] = 0; });
    for (const [bk, rows] of bkMap) {
      if (!seriesKeys.includes(bk)) continue;
      const vals = rows.map(r => Number(r[valueKey]) || 0);
      switch (metric.agg) {
        case 'sum':            out[bk] = vals.reduce((a, b) => a + b, 0); break;
        case 'avg':            out[bk] = vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 1); break;
        case 'count':          out[bk] = rows.length; break;
        case 'min':            out[bk] = Math.min(...vals); break;
        case 'max':            out[bk] = Math.max(...vals); break;
        case 'count_distinct': out[bk] = new Set(rows.map(r => r[valueKey])).size; break;
        default:               out[bk] = vals.reduce((a, b) => a + b, 0);
      }
    }
    pivoted.push(out);
  }

  // Apply having filters to pivoted result (Bug 6 fix)
  const filtered = havingFilters.length > 0 ? applyFiltersToRows(pivoted, havingFilters) : pivoted;
  return { pivoted: filtered, seriesKeys };
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="h-full flex items-center justify-center text-gray-400">
      <p className="text-sm text-center max-w-xs px-4">{message}</p>
    </div>
  );
}

export interface ExploreChartProps {
  type: string;
  data: Record<string, any>[];
  roleConfig: ChartRoleConfig;
  styleConfig?: ChartStyleConfig;
  /** Post-aggregation (HAVING) filters — applied after group-by+agg */
  havingFilters?: BaseFilter[];
  /** When true, backend already ran GROUP BY aggregation — skip client-side applyGroupByAgg */
  preAggregated?: boolean;
}

export function ExploreChart({ type, data, roleConfig, styleConfig: _style, havingFilters = [], preAggregated = false }: ExploreChartProps) {
  const style = { ...DEFAULT_STYLE_CONFIG, ..._style };
  const PALETTE = getPalette((style.palette as ChartPaletteName) || 'default').colors;
  const fontSize = style.fontSize || 12;
  const { dimension, metrics, breakdown, timeField, scatterX, scatterY } = roleConfig;
  const xField = type === 'TIME_SERIES' ? (timeField || dimension) : dimension;

  // Compute aggregated data for all chart types that use dimension+metrics
  const { aggData, truncated } = useMemo(() => {
    if (!xField || metrics.length === 0) return { aggData: data, truncated: false };
    if (['SCATTER', 'KPI', 'TABLE'].includes(type)) return { aggData: data, truncated: false };
    let agg: Record<string, any>[];
    if (preAggregated) {
      agg = data;
    } else {
      agg = applyGroupByAgg(data, xField, metrics);
    }
    if (havingFilters.length > 0) {
      agg = applyFiltersToRows(agg, havingFilters);
    }
    const wasTruncated = agg.length > MAX_CHART_POINTS;
    if (wasTruncated) agg = agg.slice(0, MAX_CHART_POINTS);
    return { aggData: agg, truncated: wasTruncated };
  }, [data, type, xField, metrics, havingFilters, preAggregated]);

  // Pivot for breakdown-based charts (Bug 1+2 fix: added BAR and TIME_SERIES)
  const breakdownResult = useMemo(() => {
    if (!breakdown || !xField || metrics.length === 0) return null;
    if (!['STACKED_BAR', 'LINE', 'AREA', 'BAR', 'HORIZONTAL_BAR', 'GROUPED_BAR', 'TIME_SERIES'].includes(type)) return null;
    return pivotByBreakdown(data, xField, metrics[0], breakdown, preAggregated, havingFilters);
  }, [data, type, xField, metrics, breakdown, preAggregated, havingFilters]);

  if (!data || data.length === 0) {
    return <EmptyState message="No data — run the query first." />;
  }

  // Truncation banner — shown above the chart when data points exceed MAX_CHART_POINTS
  const TruncationBanner = truncated ? (
    <div className="px-3 py-1.5 bg-amber-50 border border-amber-200 rounded text-xs text-amber-700 mb-1">
      Showing top {MAX_CHART_POINTS.toLocaleString()} of {data.length.toLocaleString()} groups. Add filters or choose a lower-cardinality dimension for the full picture.
    </div>
  ) : null;

  // ── Shared rendering helpers ──────────────────────────────────────────────
  const showGrid = style.showGrid ?? true;
  const legendPos = style.legendPosition || 'bottom';
  const showLegend = legendPos !== 'none';
  const barRadius = style.barRadius ?? 4;
  const showDataLabels = style.showDataLabels ?? false;
  const showDots = style.showDots ?? true;
  const lineDash = style.lineStyle === 'dashed' ? '8 4' : undefined;

  const yDomain: [any, any] = [
    style.yAxisMin !== '' && style.yAxisMin != null ? Number(style.yAxisMin) : 'auto',
    style.yAxisMax !== '' && style.yAxisMax != null ? Number(style.yAxisMax) : 'auto',
  ];

  const xAxisLabel = style.xAxisLabel || undefined;
  const yAxisLabel = style.yAxisLabel || undefined;

  const renderXAxis = (dataKey: string, count: number = aggData.length) => {
    const { angle, height, textAnchor, interval, labelOffset } = buildXAxisProps(count, fontSize, xAxisLabel);
    return (
      <XAxis
        dataKey={dataKey}
        tick={{ fontSize, angle, textAnchor } as any}
        height={height}
        interval={interval as any}
        label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: labelOffset, fontSize } : undefined}
      />
    );
  };
  const renderYAxis = () => (
    <YAxis tick={{ fontSize }} tickFormatter={yAxisTickFormatter(style)} domain={yDomain}
      label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft', fontSize, dx: -10 } : undefined} />
  );
  const renderLegend = () => showLegend ? (
    <Legend wrapperStyle={{ fontSize }}
      verticalAlign={legendPos === 'left' || legendPos === 'right' ? 'middle' : legendPos as any}
      align={legendPos === 'left' || legendPos === 'right' ? legendPos as any : 'center'}
      layout={legendPos === 'left' || legendPos === 'right' ? 'vertical' : 'horizontal'} />
  ) : null;

  // ── KPI ───────────────────────────────────────────────────────────────────
  if (type === 'KPI') {
    const m = metrics[0];
    if (!m) return <EmptyState message="Add a Value field in Field Mapping." />;
    let agg: number;
    if (preAggregated) {
      agg = Number(data[0]?.[metricKey(m)]) || 0;
    } else {
      const vals = data.map(r => Number(r[m.field]) || 0);
      switch (m.agg) {
        case 'avg':            agg = vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 1); break;
        case 'count':          agg = data.length; break;
        case 'min':            agg = Math.min(...vals); break;
        case 'max':            agg = Math.max(...vals); break;
        case 'count_distinct': agg = new Set(data.map(r => r[m.field])).size; break;
        default:               agg = vals.reduce((a, b) => a + b, 0);
      }
    }
    const fmt = formatNumber(agg, { ...style, numberFormat: 'compact' });
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <div className="text-6xl font-bold text-blue-600 tabular-nums">{fmt}</div>
          <div className="text-sm text-gray-500 mt-3 font-medium uppercase tracking-wide">{metricLabel(m)}</div>
          <div className="text-xs text-gray-400 mt-1">{data.length.toLocaleString()} rows</div>
        </div>
      </div>
    );
  }

  // ── PIE ───────────────────────────────────────────────────────────────────
  if (type === 'PIE') {
    const m = metrics[0];
    if (!dimension || !m) return <EmptyState message="Set Legend and Value fields in Field Mapping." />;
    const pieData = aggData.slice(0, 20).map(r => ({
      name: String(r[dimension] ?? 'Unknown'),
      value: Number(r[metricKey(m)]) || 0,
    }));
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={pieData} dataKey="value" nameKey="name"
            cx="50%" cy="45%" outerRadius="60%"
            label={showDataLabels
              ? ({ name, value, percent }) => percent > 0.03
                ? `${name}: ${formatNumber(value, style)} (${(percent * 100).toFixed(0)}%)`
                : ''
              : ({ name, percent }) => percent > 0.03 ? `${name} (${(percent * 100).toFixed(0)}%)` : ''}
          >
            {pieData.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
          </Pie>
          <Tooltip formatter={(v: any) => [formatNumber(v, style), metricLabel(m)]} />
          {renderLegend()}
        </PieChart>
      </ResponsiveContainer>
    );
  }

  // ── SCATTER ───────────────────────────────────────────────────────────────
  if (type === 'SCATTER') {
    if (!scatterX || !scatterY) return <EmptyState message="Set X Axis and Y Axis fields in Field Mapping." />;
    const pts = data.map(r => ({
      x: Number(r[scatterX]) || 0,
      y: Number(r[scatterY]) || 0,
      ...(dimension ? { label: r[dimension] } : {}),
    }));
    const ScatterTooltip = ({ active, payload }: any) => {
      if (!active || !payload?.length) return null;
      const pt = payload[0]?.payload;
      return (
        <div className="bg-white border border-gray-200 rounded px-3 py-2 shadow-sm" style={{ fontSize }}>
          {dimension && pt.label !== undefined && (
            <div className="font-semibold text-gray-800 mb-1">{String(pt.label)}</div>
          )}
          <div className="text-gray-600">{scatterX}: <span className="font-medium text-gray-800">{formatNumber(pt.x, style)}</span></div>
          <div className="text-gray-600">{scatterY}: <span className="font-medium text-gray-800">{formatNumber(pt.y, style)}</span></div>
        </div>
      );
    };
    return (
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart>
          {showGrid && <CartesianGrid strokeDasharray="3 3" />}
          <XAxis dataKey="x" name={scatterX} type="number" tick={{ fontSize }}
            label={{ value: style.xAxisLabel || scatterX, position: 'insideBottom', offset: -5, fontSize }} />
          <YAxis dataKey="y" name={scatterY} type="number" tick={{ fontSize }}
            tickFormatter={yAxisTickFormatter(style)}
            label={{ value: style.yAxisLabel || scatterY, angle: -90, position: 'insideLeft', fontSize }} />
          <ZAxis range={[40, 40]} />
          <Tooltip content={<ScatterTooltip />} cursor={{ strokeDasharray: '3 3' }} />
          {renderLegend()}
          <Scatter name={`${scatterX} vs ${scatterY}`} data={pts} fill={PALETTE[0]} />
        </ScatterChart>
      </ResponsiveContainer>
    );
  }

  // ── TABLE ─────────────────────────────────────────────────────────────────
  if (type === 'TABLE') {
    const cols = roleConfig.selectedColumns ?? (data.length > 0 ? Object.keys(data[0]) : []);
    return <TableVisualization data={data} columns={cols} />;
  }

  // For remaining types: need xField + at least 1 metric
  if (!xField) return <EmptyState message="Set the X Axis field in Field Mapping." />;
  if (metrics.length === 0) return <EmptyState message="Add at least one Value field in Field Mapping." />;

  const seriesMetrics = metrics;

  // ── STACKED BAR ───────────────────────────────────────────────────────────
  if (type === 'STACKED_BAR') {
    const { pivoted, seriesKeys } = breakdownResult ?? { pivoted: aggData, seriesKeys: [metricKey(metrics[0])] };
    const displayData = pivoted.length > MAX_CHART_POINTS ? pivoted.slice(0, MAX_CHART_POINTS) : pivoted;
    return (
      <>
        {TruncationBanner}
        {wrapScrollable(
          <BarChart data={displayData}>
            {showGrid && <CartesianGrid strokeDasharray="3 3" />}
            {renderXAxis(xField, displayData.length)}
            {renderYAxis()}
            <Tooltip formatter={tooltipFormatter(seriesMetrics, style)} />
            {renderLegend()}
            {seriesKeys.map((k, i) => (
              <Bar key={k} dataKey={k} stackId="s" fill={PALETTE[i % PALETTE.length]}
                name={breakdownResult ? k : metricLabel(metrics[0])}
                radius={i === seriesKeys.length - 1 ? [barRadius, barRadius, 0, 0] : undefined}>
                {showDataLabels && i === seriesKeys.length - 1 && (
                  <LabelList dataKey={k} position="top" fontSize={fontSize - 1} formatter={dataLabelFormatter(style)} />
                )}
              </Bar>
            ))}
          </BarChart>,
          displayData.length,
        )}
      </>
    );
  }

  // ── AREA ──────────────────────────────────────────────────────────────────
  if (type === 'AREA') {
    const { pivoted, seriesKeys } = breakdownResult ?? {
      pivoted: aggData,
      seriesKeys: seriesMetrics.map(metricKey),
    };
    const displayData = pivoted.length > MAX_CHART_POINTS ? pivoted.slice(0, MAX_CHART_POINTS) : pivoted;
    return (
      <>
        {TruncationBanner}
        {wrapScrollable(
          <AreaChart data={displayData}>
            {showGrid && <CartesianGrid strokeDasharray="3 3" />}
            {renderXAxis(xField, displayData.length)}
            {renderYAxis()}
            <Tooltip formatter={tooltipFormatter(seriesMetrics, style)} />
            {renderLegend()}
            {seriesKeys.map((k, i) => {
              const m = seriesMetrics.find(m => metricKey(m) === k);
              return (
                <Area key={k} type="monotone" dataKey={k}
                  name={m ? metricLabel(m) : k}
                  stroke={PALETTE[i % PALETTE.length]}
                  fill={PALETTE[i % PALETTE.length]}
                  fillOpacity={0.2} strokeWidth={2}
                  dot={showDots && displayData.length <= 60}
                  strokeDasharray={lineDash} />
              );
            })}
          </AreaChart>,
          displayData.length,
        )}
      </>
    );
  }

  // ── LINE / TIME_SERIES ─────────────────────────────────────────────────────
  if (type === 'LINE' || type === 'TIME_SERIES') {
    const { pivoted, seriesKeys } = breakdownResult ?? {
      pivoted: aggData,
      seriesKeys: seriesMetrics.map(metricKey),
    };
    const displayData = pivoted.length > MAX_CHART_POINTS ? pivoted.slice(0, MAX_CHART_POINTS) : pivoted;
    return (
      <>
        {TruncationBanner}
        {wrapScrollable(
          <LineChart data={displayData}>
            {showGrid && <CartesianGrid strokeDasharray="3 3" />}
            {renderXAxis(xField, displayData.length)}
            {renderYAxis()}
            <Tooltip formatter={tooltipFormatter(seriesMetrics, style)} />
            {renderLegend()}
            {seriesKeys.map((k, i) => {
              const m = seriesMetrics.find(m => metricKey(m) === k);
              return (
                <Line key={k} type="monotone" dataKey={k}
                  name={m ? metricLabel(m) : k}
                  stroke={PALETTE[i % PALETTE.length]}
                  strokeWidth={2}
                  dot={showDots && displayData.length <= 60}
                  strokeDasharray={lineDash}>
                  {showDataLabels && (
                    <LabelList dataKey={k} position="top" fontSize={fontSize - 1} formatter={dataLabelFormatter(style)} />
                  )}
                </Line>
              );
            })}
          </LineChart>,
          displayData.length,
        )}
      </>
    );
  }

  // ── HORIZONTAL BAR ────────────────────────────────────────────────────────
  if (type === 'HORIZONTAL_BAR') {
    const { pivoted: barData, seriesKeys: barKeys } = breakdownResult ?? {
      pivoted: aggData,
      seriesKeys: seriesMetrics.map(metricKey),
    };
    const displayData = barData.length > MAX_CHART_POINTS ? barData.slice(0, MAX_CHART_POINTS) : barData;
    const MIN_ROW_HEIGHT = 32; // px per row for horizontal bars
    const chartHeight = displayData.length > SCROLL_THRESHOLD
      ? Math.max(displayData.length * MIN_ROW_HEIGHT, 400)
      : undefined; // let ResponsiveContainer fill parent
    const innerChart = (
      <BarChart data={displayData} layout="vertical">
        {showGrid && <CartesianGrid strokeDasharray="3 3" />}
        <YAxis dataKey={xField} type="category" tick={{ fontSize }} width={120}
          label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft', fontSize, dx: -10 } : undefined} />
        <XAxis type="number" tick={{ fontSize }} tickFormatter={yAxisTickFormatter(style)}
          label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: -5, fontSize } : undefined} />
        <Tooltip formatter={tooltipFormatter(seriesMetrics, style)} />
        {renderLegend()}
        {barKeys.map((k, i) => {
          const m = seriesMetrics.find(m => metricKey(m) === k);
          return (
            <Bar key={k} dataKey={k}
              name={m ? metricLabel(m) : k}
              fill={PALETTE[i % PALETTE.length]}
              radius={[0, barRadius, barRadius, 0]}>
              {showDataLabels && (
                <LabelList dataKey={k} position="right" fontSize={fontSize - 1} formatter={dataLabelFormatter(style)} />
              )}
            </Bar>
          );
        })}
      </BarChart>
    );
    return (
      <>
        {TruncationBanner}
        {displayData.length > SCROLL_THRESHOLD ? (
          <div style={{ width: '100%', height: '100%', overflowY: 'auto', overflowX: 'hidden' }}>
            <div style={{ width: '100%', height: chartHeight }}>
              <ResponsiveContainer width="100%" height="100%">
                {innerChart}
              </ResponsiveContainer>
            </div>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {innerChart}
          </ResponsiveContainer>
        )}
      </>
    );
  }

  // ── BAR + LINE (Combo) ─────────────────────────────────────────────────────
  if (type === 'BAR_LINE') {
    const m = metrics[0];
    if (!m || !breakdown) return <EmptyState message="Set Bar Values and Line Value in Field Mapping." />;
    const barKey = metricKey(m);
    // For BAR_LINE, "breakdown" is repurposed as the line metric field name
    const lineKey = `sum__${breakdown}`;
    // Aggregate both metrics
    let comboData: Record<string, any>[];
    if (preAggregated) {
      comboData = aggData;
    } else {
      comboData = applyGroupByAgg(data, xField!, [
        m,
        { field: breakdown, agg: 'sum' },
      ]);
    }
    const displayData = comboData.length > MAX_CHART_POINTS ? comboData.slice(0, MAX_CHART_POINTS) : comboData;
    return (
      <>
        {TruncationBanner}
        {wrapScrollable(
          <ComposedChart data={displayData}>
            {showGrid && <CartesianGrid strokeDasharray="3 3" />}
            {renderXAxis(xField!, displayData.length)}
            {renderYAxis()}
            <Tooltip formatter={(value: any, name: string) => {
              return [formatNumber(value, style), name === barKey ? metricLabel(m) : breakdown];
            }} />
            {renderLegend()}
            <Bar dataKey={barKey} name={metricLabel(m)}
              fill={PALETTE[0]} radius={[barRadius, barRadius, 0, 0]}>
              {showDataLabels && (
                <LabelList dataKey={barKey} position="top" fontSize={fontSize - 1} formatter={dataLabelFormatter(style)} />
              )}
            </Bar>
            <Line dataKey={lineKey} name={breakdown}
              type="monotone" stroke={PALETTE[1]} strokeWidth={2}
              dot={showDots && displayData.length <= 60}
              strokeDasharray={lineDash}
              yAxisId={0} />
          </ComposedChart>,
          displayData.length,
        )}
      </>
    );
  }

  // ── BAR / GROUPED_BAR (default) ────────────────────────────────────────────
  const { pivoted: barData, seriesKeys: barKeys } = breakdownResult ?? {
    pivoted: aggData,
    seriesKeys: seriesMetrics.map(metricKey),
  };
  const displayBarData = barData.length > MAX_CHART_POINTS ? barData.slice(0, MAX_CHART_POINTS) : barData;
  return (
    <>
      {TruncationBanner}
      {wrapScrollable(
        <BarChart data={displayBarData}>
          {showGrid && <CartesianGrid strokeDasharray="3 3" />}
          {renderXAxis(xField, displayBarData.length)}
          {renderYAxis()}
          <Tooltip formatter={tooltipFormatter(seriesMetrics, style)} />
          {renderLegend()}
          {barKeys.map((k, i) => {
            const m = seriesMetrics.find(m => metricKey(m) === k);
            return (
              <Bar key={k} dataKey={k}
                name={m ? metricLabel(m) : k}
                fill={PALETTE[i % PALETTE.length]}
                radius={[barRadius, barRadius, 0, 0]}>
                {showDataLabels && (
                  <LabelList dataKey={k} position="top" fontSize={fontSize - 1} formatter={dataLabelFormatter(style)} />
                )}
              </Bar>
            );
          })}
        </BarChart>,
        displayBarData.length,
      )}
    </>
  );
}
