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
): { pivoted: Record<string, any>[]; seriesKeys: string[] } {
  const seriesKeys = [...new Set(data.map(r => String(r[breakdownField] ?? '')))].slice(0, 12);

  const map: Record<string, Record<string, any>> = {};
  for (const row of data) {
    const dk = String(row[dimField] ?? '');
    const bk = String(row[breakdownField] ?? '');
    if (!map[dk]) {
      map[dk] = { [dimField]: dk };
      seriesKeys.forEach(k => { map[dk][k] = 0; });
    }
    const val = Number(row[metric.field]) || 0;
    map[dk][bk] = (Number(map[dk][bk]) || 0) + val;
  }
  return { pivoted: Object.values(map), seriesKeys };
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
}

export function ExploreChart({ type, data, roleConfig, havingFilters = [] }: ExploreChartProps) {
  const { dimension, metrics, breakdown, timeField, scatterX, scatterY } = roleConfig;
  const xField = type === 'TIME_SERIES' ? (timeField || dimension) : dimension;

  // Compute aggregated data for all chart types that use dimension+metrics
  const aggData = useMemo(() => {
    if (!xField || metrics.length === 0) return data;
    if (['SCATTER', 'KPI', 'TABLE'].includes(type)) return data;
    let agg = applyGroupByAgg(data, xField, metrics);
    if (havingFilters.length > 0) {
      agg = applyFiltersToRows(agg, havingFilters);
    }
    return agg;
  }, [data, type, xField, metrics, havingFilters]);

  // Pivot for breakdown-based charts
  const breakdownResult = useMemo(() => {
    if (!breakdown || !xField || metrics.length === 0) return null;
    if (!['STACKED_BAR', 'LINE', 'AREA'].includes(type)) return null;
    return pivotByBreakdown(data, xField, metrics[0], breakdown);
  }, [data, type, xField, metrics, breakdown]);

  if (!data || data.length === 0) {
    return <EmptyState message="No data — run the query first." />;
  }

  // ── KPI ───────────────────────────────────────────────────────────────────
  if (type === 'KPI') {
    const m = metrics[0];
    if (!m) return <EmptyState message="Add a Value field in Field Mapping." />;
    const total = data.reduce((s, r) => s + (Number(r[m.field]) || 0), 0);
    const agg = m.agg === 'avg' ? total / Math.max(data.length, 1) : total;
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
    const pts = data.map(r => ({ x: Number(r[scatterX]) || 0, y: Number(r[scatterY]) || 0 }));
    return (
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="x" name={scatterX} type="number" tick={{ fontSize: 11 }}
            label={{ value: scatterX, position: 'insideBottom', offset: -5, fontSize: 11 }} />
          <YAxis dataKey="y" name={scatterY} type="number" tick={{ fontSize: 11 }}
            label={{ value: scatterY, angle: -90, position: 'insideLeft', fontSize: 11 }} />
          <ZAxis range={[40, 40]} />
          <Tooltip cursor={{ strokeDasharray: '3 3' }} />
          <Scatter name={`${scatterX} vs ${scatterY}`} data={pts} fill={PALETTE[0]} />
        </ScatterChart>
      </ResponsiveContainer>
    );
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
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={aggData}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey={xField} tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} />
        <Tooltip formatter={MetricTooltipFormatter(seriesMetrics)} />
        <Legend />
        {seriesMetrics.map((m, i) => (
          <Bar key={metricKey(m)} dataKey={metricKey(m)}
            name={metricLabel(m)}
            fill={PALETTE[i % PALETTE.length]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
