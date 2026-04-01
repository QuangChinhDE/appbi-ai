'use client';

import React, { useMemo } from 'react';
import {
  BarChart, Bar,
  LineChart, Line,
  AreaChart, Area,
  ScatterChart, Scatter, ZAxis,
  PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts';
import type { ChartRoleConfig, MetricConfig, AggFn } from './ExploreChartConfig';
import { metricKey, metricLabel } from './ExploreChartConfig';
import { TableVisualization } from '@/components/visualizations/TableVisualization';
import { applyFiltersToRows } from '@/lib/filters';
import type { BaseFilter } from '@/lib/filters';

const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

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

// ── Custom Tooltip showing metric labels ──────────────────────────────────────
function MetricTooltipFormatter(metrics: MetricConfig[]) {
  return (value: any, name: string) => {
    const m = metrics.find(m => metricKey(m) === name);
    return [typeof value === 'number' ? value.toLocaleString() : value, m ? metricLabel(m) : name];
  };
}

export interface ExploreChartProps {
  type: string;
  data: Record<string, any>[];
  roleConfig: ChartRoleConfig;
  /** Post-aggregation (HAVING) filters — applied after group-by+agg */
  havingFilters?: BaseFilter[];
  /** When true, backend already ran GROUP BY aggregation — skip client-side applyGroupByAgg */
  preAggregated?: boolean;
}

export function ExploreChart({ type, data, roleConfig, havingFilters = [], preAggregated = false }: ExploreChartProps) {
  const { dimension, metrics, breakdown, timeField, scatterX, scatterY } = roleConfig;
  const xField = type === 'TIME_SERIES' ? (timeField || dimension) : dimension;

  // Compute aggregated data for all chart types that use dimension+metrics
  const aggData = useMemo(() => {
    if (!xField || metrics.length === 0) return data;
    if (['SCATTER', 'KPI', 'TABLE'].includes(type)) return data;
    let agg: Record<string, any>[];
    if (preAggregated) {
      // Backend already did GROUP BY — rows use aliased metric columns (e.g. "sum__field")
      agg = data;
    } else {
      agg = applyGroupByAgg(data, xField, metrics);
    }
    if (havingFilters.length > 0) {
      agg = applyFiltersToRows(agg, havingFilters);
    }
    return agg;
  }, [data, type, xField, metrics, havingFilters, preAggregated]);

  // Pivot for breakdown-based charts (Bug 1+2 fix: added BAR and TIME_SERIES)
  const breakdownResult = useMemo(() => {
    if (!breakdown || !xField || metrics.length === 0) return null;
    if (!['STACKED_BAR', 'LINE', 'AREA', 'BAR', 'GROUPED_BAR', 'TIME_SERIES'].includes(type)) return null;
    return pivotByBreakdown(data, xField, metrics[0], breakdown, preAggregated, havingFilters);
  }, [data, type, xField, metrics, breakdown, preAggregated, havingFilters]);

  if (!data || data.length === 0) {
    return <EmptyState message="No data — run the query first." />;
  }

  // ── KPI ───────────────────────────────────────────────────────────────────
  if (type === 'KPI') {
    const m = metrics[0];
    if (!m) return <EmptyState message="Add a Value field in Field Mapping." />;
    let agg: number;
    if (preAggregated) {
      // Backend returned a single-row aggregate; value is in aliased column
      agg = Number(data[0]?.[metricKey(m)]) || 0;
    } else {
      // Bug 3 fix: correctly handle all agg functions
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
    const fmt =
      agg >= 1_000_000 ? `${(agg / 1_000_000).toFixed(2)}M`
      : agg >= 1_000   ? `${(agg / 1_000).toFixed(1)}K`
      : agg.toLocaleString();
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
            label={({ name, percent }) => percent > 0.03 ? `${name} (${(percent * 100).toFixed(0)}%)` : ''}
          >
            {pieData.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
          </Pie>
          <Tooltip formatter={(v: any) => [typeof v === 'number' ? v.toLocaleString() : v, metricLabel(m)]} />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  // ── SCATTER ───────────────────────────────────────────────────────────────
  if (type === 'SCATTER') {
    if (!scatterX || !scatterY) return <EmptyState message="Set X Axis and Y Axis fields in Field Mapping." />;
    // Bug 5 fix: include dimension (label) field in each point so tooltip can show it
    const pts = data.map(r => ({
      x: Number(r[scatterX]) || 0,
      y: Number(r[scatterY]) || 0,
      ...(dimension ? { label: r[dimension] } : {}),
    }));
    const ScatterTooltip = ({ active, payload }: any) => {
      if (!active || !payload?.length) return null;
      const pt = payload[0]?.payload;
      return (
        <div className="bg-white border border-gray-200 rounded px-3 py-2 text-xs shadow-sm">
          {dimension && pt.label !== undefined && (
            <div className="font-semibold text-gray-800 mb-1">{String(pt.label)}</div>
          )}
          <div className="text-gray-600">{scatterX}: <span className="font-medium text-gray-800">{pt.x?.toLocaleString()}</span></div>
          <div className="text-gray-600">{scatterY}: <span className="font-medium text-gray-800">{pt.y?.toLocaleString()}</span></div>
        </div>
      );
    };
    return (
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="x" name={scatterX} type="number" tick={{ fontSize: 11 }}
            label={{ value: scatterX, position: 'insideBottom', offset: -5, fontSize: 11 }} />
          <YAxis dataKey="y" name={scatterY} type="number" tick={{ fontSize: 11 }}
            label={{ value: scatterY, angle: -90, position: 'insideLeft', fontSize: 11 }} />
          <ZAxis range={[40, 40]} />
          <Tooltip content={<ScatterTooltip />} cursor={{ strokeDasharray: '3 3' }} />
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
    return (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={pivoted}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey={xField} tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip />
          <Legend />
          {seriesKeys.map((k, i) => (
            <Bar key={k} dataKey={k} stackId="s" fill={PALETTE[i % PALETTE.length]}
              name={breakdownResult ? k : metricLabel(metrics[0])} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  // ── AREA ──────────────────────────────────────────────────────────────────
  if (type === 'AREA') {
    const { pivoted, seriesKeys } = breakdownResult ?? {
      pivoted: aggData,
      seriesKeys: seriesMetrics.map(metricKey),
    };
    return (
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={pivoted}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey={xField} tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip formatter={MetricTooltipFormatter(seriesMetrics)} />
          <Legend />
          {seriesKeys.map((k, i) => {
            const m = seriesMetrics.find(m => metricKey(m) === k);
            return (
              <Area key={k} type="monotone" dataKey={k}
                name={m ? metricLabel(m) : k}
                stroke={PALETTE[i % PALETTE.length]}
                fill={PALETTE[i % PALETTE.length]}
                fillOpacity={0.2} strokeWidth={2} />
            );
          })}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  // ── LINE / TIME_SERIES ─────────────────────────────────────────────────────
  if (type === 'LINE' || type === 'TIME_SERIES') {
    const { pivoted, seriesKeys } = breakdownResult ?? {
      pivoted: aggData,
      seriesKeys: seriesMetrics.map(metricKey),
    };
    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={pivoted}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey={xField} tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip formatter={MetricTooltipFormatter(seriesMetrics)} />
          <Legend />
          {seriesKeys.map((k, i) => {
            const m = seriesMetrics.find(m => metricKey(m) === k);
            return (
              <Line key={k} type="monotone" dataKey={k}
                name={m ? metricLabel(m) : k}
                stroke={PALETTE[i % PALETTE.length]}
                strokeWidth={2}
                dot={pivoted.length <= 60} />
            );
          })}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  // ── BAR / GROUPED_BAR (default) ────────────────────────────────────────────
  // Bug 1 fix: use breakdownResult (pivoted) when breakdown is configured
  const { pivoted: barData, seriesKeys: barKeys } = breakdownResult ?? {
    pivoted: aggData,
    seriesKeys: seriesMetrics.map(metricKey),
  };
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={barData}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey={xField} tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip formatter={MetricTooltipFormatter(seriesMetrics)} />
        <Legend />
        {barKeys.map((k, i) => {
          const m = seriesMetrics.find(m => metricKey(m) === k);
          return (
            <Bar key={k} dataKey={k}
              name={m ? metricLabel(m) : k}
              fill={PALETTE[i % PALETTE.length]} />
          );
        })}
      </BarChart>
    </ResponsiveContainer>
  );
}
