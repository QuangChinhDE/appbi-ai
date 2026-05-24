'use client';

import React, { useMemo } from 'react';
import { TableVisualization } from '@/components/visualizations/TableVisualization';
import { applyFiltersToRows, type BaseFilter } from '@/lib/filters';
import type { ChartStyleConfig, MetricConfig } from './ExploreChartConfig';
import { metricKey, metricLabel } from './ExploreChartConfig';
import type { ExploreChartModel } from './chartDataAdapter';

type ChartRow = Record<string, unknown>;

/**
 * Phase-15.85 — slice colour resolver.
 *
 * DA-reported: in DONUT (and every other AdvancedExploreCharts
 * renderer) the "Series colors" editor in the Style tab wrote into
 * `style.seriesColors[sliceName] = '#xxx'`, but the renderers iterated
 * `palette[index]` from the active palette, ignoring the override. The
 * editor looked broken to DA — pick a colour, chart doesn't change.
 *
 * This helper walks the same precedence as ExploreChart's
 * `getSeriesColor`: explicit override > palette[i % palette.length].
 * Series colours are keyed by the user-visible name (slice label /
 * dimension value / metric key) so the editor's dropdown and the
 * resolver agree.
 */
export function resolveSliceColor(
  style: ChartStyleConfig | undefined,
  palette: string[],
  name: string,
  index: number,
): string {
  const override = style?.seriesColors?.[name];
  if (override) return override;
  return palette[index % palette.length];
}

export const ADVANCED_EXPLORE_CHART_TYPES = new Set<string>([
  'DONUT',
  'RADAR',
  'POLAR_AREA',
  'MATRIX',
  'BUBBLE',
  'HEATMAP',
  'TREEMAP',
  'FUNNEL',
  'GAUGE',
  'WATERFALL',
  'MAP_POINT',
  'MAP_REGION',
  'BOXPLOT',
  'BULLET',
  'SANKEY',
  'SUNBURST',
  'RIBBON',
  'TIMELINE',
  'WORD_CLOUD',
]);

interface AdvancedExploreChartProps {
  type: string;
  data: ChartRow[];
  model: ExploreChartModel;
  style: ChartStyleConfig;
  palette: string[];
  havingFilters?: BaseFilter[];
  preAggregated?: boolean;
  onStyleConfigChange?: (nextStyleConfig: ChartStyleConfig) => void;
  onSelectDataPoint?: (selection: { field: string; value: unknown } | null) => void;
  /** Phase-15.13: same semantic label map used by ExploreChart; forwarded to
   *  TableVisualization when rendering MATRIX so headers humanise. */
  labelMap?: import('./ExploreChartConfig').SemanticLabelMap;
}

interface NameValue {
  name: string;
  value: number;
  row?: ChartRow;
}

interface PairValue {
  source: string;
  target: string;
  value: number;
}

const SVG_W = 800;
const SVG_H = 420;

function formatNumber(value: unknown, style?: ChartStyleConfig): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  const dec = style?.decimalPlaces ?? 1;
  switch (style?.numberFormat || 'compact') {
    case 'currency':
      return `${style?.currencySymbol || '$'}${n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
    case 'percent':
      return `${(n * 100).toFixed(dec)}%`;
    case 'number':
      return n.toLocaleString(undefined, { maximumFractionDigits: dec });
    case 'compact':
    default:
      if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(dec)}B`;
      if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(dec)}M`;
      if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(dec)}K`;
      return n.toLocaleString(undefined, { maximumFractionDigits: dec });
  }
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function metricCandidates(metric: MetricConfig, preAggregated = false): string[] {
  const aggregatedCandidates = [
    metricKey(metric),
    metric.outputField,
    `${metric.agg}__${metric.field}`,
    `${metric.field}_${metric.agg}`,
    `${metric.agg}_${metric.field}`,
    `${metric.field}__${metric.agg}`,
    metric.field,
  ];
  return preAggregated
    ? uniqueStrings(aggregatedCandidates)
    : uniqueStrings([metric.field, metric.outputField, ...aggregatedCandidates]);
}

function readMetricValue(row: ChartRow, metric: MetricConfig, preAggregated = false): number | null {
  for (const candidate of metricCandidates(metric, preAggregated)) {
    if (candidate in row) {
      const value = Number(row[candidate]);
      return Number.isFinite(value) ? value : null;
    }
  }
  return null;
}

function metricValue(row: ChartRow, metric?: MetricConfig, preAggregated = false): number {
  if (!metric) return 0;
  return readMetricValue(row, metric, preAggregated) ?? 0;
}

function countDistinctRawValues(rows: ChartRow[], field: string): number {
  const values = new Set<unknown>();
  rows.forEach((row) => {
    const value = row[field];
    if (value !== null && value !== undefined && value !== '') {
      values.add(value);
    }
  });
  return values.size;
}

function aggregateMetric(rows: ChartRow[], metric?: MetricConfig, preAggregated = false): number {
  if (!metric) return 0;
  if (metric.agg === 'count') {
    if (!preAggregated) return rows.length;
    const values = rows
      .map((row) => readMetricValue(row, metric, true))
      .filter((value): value is number => value !== null);
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : rows.length;
  }
  if (metric.agg === 'count_distinct') {
    if (!preAggregated) return countDistinctRawValues(rows, metric.field);
    const values = rows
      .map((row) => readMetricValue(row, metric, true))
      .filter((value): value is number => value !== null);
    return values.length > 0
      ? values.reduce((sum, value) => sum + value, 0)
      : countDistinctRawValues(rows, metric.field);
  }
  const values = rows.map((row) => metricValue(row, metric, preAggregated));
  switch (metric.agg) {
    case 'avg':
      return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
    case 'min':
      return values.length ? Math.min(...values) : 0;
    case 'max':
      return values.length ? Math.max(...values) : 0;
    case 'sum':
    default:
      return values.reduce((sum, value) => sum + value, 0);
  }
}

function formatPercent(value: number, total: number): string {
  if (!Number.isFinite(value) || total <= 0) return '0%';
  return `${((Math.max(value, 0) / total) * 100).toFixed(0)}%`;
}

function applyNameValueHaving(
  items: NameValue[],
  field: string | undefined,
  metric: MetricConfig | undefined,
  havingFilters: BaseFilter[] | undefined,
): NameValue[] {
  if (!items.length || !metric || !havingFilters?.length) return items;
  const mKey = metricKey(metric);
  const rows = items.map((item, index) => ({
    ...(item.row ?? {}),
    __advancedIndex: index,
    ...(field ? { [field]: item.name } : {}),
    [mKey]: item.value,
  }));
  const kept = new Set(applyFiltersToRows(rows, havingFilters).map((row) => Number(row.__advancedIndex)));
  return items.filter((_, index) => kept.has(index));
}

function applyPairHaving(
  pairs: PairValue[],
  sourceField: string | undefined,
  targetField: string | undefined,
  metric: MetricConfig | undefined,
  havingFilters: BaseFilter[] | undefined,
): PairValue[] {
  if (!pairs.length || !metric || !havingFilters?.length) return pairs;
  const mKey = metricKey(metric);
  const rows = pairs.map((pair, index) => ({
    __advancedIndex: index,
    ...(sourceField ? { [sourceField]: pair.source } : {}),
    ...(targetField ? { [targetField]: pair.target } : {}),
    [mKey]: pair.value,
  }));
  const kept = new Set(applyFiltersToRows(rows, havingFilters).map((row) => Number(row.__advancedIndex)));
  return pairs.filter((_, index) => kept.has(index));
}

function groupByMetric(
  rows: ChartRow[],
  field: string | undefined,
  metric: MetricConfig | undefined,
  preAggregated = false,
): NameValue[] {
  if (!field || !metric) return [];
  const groups = new Map<string, ChartRow[]>();
  for (const row of rows) {
    const name = String(row[field] ?? 'Unknown');
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(row);
  }
  return Array.from(groups.entries())
    .map(([name, groupRows]) => ({
      name,
      value: aggregateMetric(groupRows, metric, preAggregated),
      row: groupRows[0],
    }))
    .filter((item) => Number.isFinite(item.value));
}

function groupPairs(
  rows: ChartRow[],
  sourceField?: string,
  targetField?: string,
  metric?: MetricConfig,
  preAggregated = false,
): PairValue[] {
  if (!sourceField || !targetField || !metric) return [];
  const groups = new Map<string, ChartRow[]>();
  for (const row of rows) {
    const source = String(row[sourceField] ?? 'Unknown');
    const target = String(row[targetField] ?? 'Unknown');
    const key = `${source}\u0000${target}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  return Array.from(groups.entries()).map(([key, groupRows]) => {
    const [source, target] = key.split('\u0000');
    return { source, target, value: aggregateMetric(groupRows, metric, preAggregated) };
  });
}

function positiveShare(value: number, max: number): number {
  if (!Number.isFinite(value) || max <= 0) return 0;
  return Math.max(value, 0) / max;
}

function safeSqrtShare(value: number, max: number): number {
  return Math.sqrt(positiveShare(value, max));
}

function metricValueForRawDistribution(row: ChartRow, metric?: MetricConfig): number {
  if (!metric) return 0;
  const value = readMetricValue(row, metric, false);
  if (value !== null) return value;
  const fallback = Number(row[metric.field]);
  return Number.isFinite(fallback) ? fallback : 0;
}

function applyLimit<T extends { value: number }>(items: T[], style: ChartStyleConfig, fallback = 24): T[] {
  const limit = typeof style.dataLimit === 'number' && style.dataLimit > 0 ? style.dataLimit : fallback;
  const sorted = [...items].sort((a, b) => b.value - a.value);
  return (style.dataLimitDirection === 'bottom' ? sorted.slice(-limit) : sorted.slice(0, limit));
}

function polar(cx: number, cy: number, radius: number, angleDeg: number) {
  const angle = (angleDeg - 90) * Math.PI / 180;
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
}

function ringSegment(cx: number, cy: number, outer: number, inner: number, start: number, end: number) {
  const large = end - start > 180 ? 1 : 0;
  const p1 = polar(cx, cy, outer, end);
  const p2 = polar(cx, cy, outer, start);
  const p3 = polar(cx, cy, inner, start);
  const p4 = polar(cx, cy, inner, end);
  return [
    `M ${p1.x} ${p1.y}`,
    `A ${outer} ${outer} 0 ${large} 0 ${p2.x} ${p2.y}`,
    `L ${p3.x} ${p3.y}`,
    `A ${inner} ${inner} 0 ${large} 1 ${p4.x} ${p4.y}`,
    'Z',
  ].join(' ');
}

function EmptyAdvanced({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-text-tertiary">
      {message}
    </div>
  );
}

function ChartFrame({ title, titleFontSize, children }: { title?: string; titleFontSize?: number; children: React.ReactNode }) {
  return (
    <div className="h-full min-h-0 flex flex-col">
      {title ? <div className="text-center font-semibold text-text-secondary mb-1" style={{ fontSize: titleFontSize }}>{title}</div> : null}
      <div className="flex-1 min-h-0">{children}</div>
    </div>
  );
}

function DonutOrPolarChart({
  type,
  items,
  style,
  palette,
  onSelect,
}: {
  type: string;
  items: NameValue[];
  style: ChartStyleConfig;
  palette: string[];
  onSelect?: (name: string) => void;
}) {
  const total = items.reduce((sum, item) => sum + Math.max(item.value, 0), 0);
  const max = Math.max(...items.map((item) => Math.max(item.value, 0)), 1);
  if (total <= 0) return <EmptyAdvanced message="No positive values to render this chart." />;

  let cursor = 0;
  const cx = 300;
  const cy = 205;
  const outer = 145;
  const inner = type === 'DONUT' ? Math.max(45, outer * ((style.pieInnerRadius ?? 55) / 100)) : 0;
  return (
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="h-full w-full">
      {items.map((item, index) => {
        const angle = type === 'POLAR_AREA' ? 360 / items.length : (Math.max(item.value, 0) / total) * 360;
        const radius = type === 'POLAR_AREA' ? 35 + (safeSqrtShare(item.value, max) * (outer - 35)) : outer;
        const path = ringSegment(cx, cy, radius, type === 'DONUT' ? inner : 0, cursor, cursor + angle);
        const mid = cursor + angle / 2;
        const labelPoint = polar(cx, cy, Math.max(radius + 24, 80), mid);
        // Phase-15.84 — DONUT/POLAR_AREA read the new DataLabelConfig
        // master switch + per-slice format override (if any). Position /
        // rotation / background aren't meaningful for this radial layout
        // so we honour only the parts that have visual meaning here.
        const dlc = style.dataLabelConfig;
        const labelsEnabled = dlc?.enabled ?? style.showDataLabels ?? false;
        const sliceOverride = dlc?.overrides?.[item.name];
        const sliceFormat = sliceOverride?.format ?? dlc?.format;
        const sliceStyle = sliceFormat ? { ...style, numberFormat: sliceFormat } : style;
        const sliceFontColor = sliceOverride?.fontColor ?? dlc?.fontColor ?? 'rgb(var(--text-secondary))';
        const sliceFontSize = sliceOverride?.fontSize ?? dlc?.fontSize ?? 11;
        const labelText = labelsEnabled
          ? `${item.name.slice(0, 12)} ${formatNumber(item.value, sliceStyle)} (${formatPercent(item.value, total)})`
          : item.name.slice(0, 16);
        cursor += angle;
        // Phase-15.85 — respect per-slice colour override from
        // style.seriesColors. Previously DONUT/POLAR_AREA ignored the
        // overrides and rendered every slice with the active palette.
        const sliceColor = resolveSliceColor(style, palette, item.name, index);
        // Phase-15.85 — DA-reported overlap on DONUT (small slices at
        // similar angles produced colliding labels, e.g. "Resales" and
        // "Unknown" rendering on top of each other near the top of the
        // ring). Skip labels for slices whose share is below 3% — they
        // stay reachable via the legend on the right and the SVG
        // <title> hover. Matches the Recharts PIE behaviour we already
        // use in the main chart.
        const share = item.value / Math.max(total, 1);
        const showLabelForSlice = labelsEnabled
          ? share >= 0.03 && index < 10
          : index < 10;
        return (
          <g key={item.name} onClick={() => onSelect?.(item.name)} className="cursor-pointer">
            <path d={path} fill={sliceColor} opacity={0.9} stroke="rgb(var(--surface-1))" strokeWidth={2} />
            {showLabelForSlice && (
              <text x={labelPoint.x} y={labelPoint.y} fontSize={sliceFontSize} textAnchor="middle" fill={sliceFontColor}>
                {labelText}
              </text>
            )}
            <title>{item.name}: {formatNumber(item.value, style)}</title>
          </g>
        );
      })}
      <g transform="translate(520 84)">
        {items.slice(0, 12).map((item, index) => (
          <g key={item.name} transform={`translate(0 ${index * 22})`}>
            <rect width={10} height={10} rx={2} fill={resolveSliceColor(style, palette, item.name, index)} />
            <text x={18} y={9} fontSize={11} fill="rgb(var(--text-secondary))">{item.name.slice(0, 24)}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}

function RadarChartSvg({ rows, metrics, field, palette, style, preAggregated }: {
  rows: ChartRow[];
  metrics: MetricConfig[];
  field?: string;
  palette: string[];
  // Phase-15.85 — pass style so Series colors override resolver can run.
  style: ChartStyleConfig;
  preAggregated?: boolean;
}) {
  if (!field || metrics.length === 0) return <EmptyAdvanced message="Select an axis field and value columns." />;
  const labels = Array.from(new Set(rows.map((row) => String(row[field] ?? 'Unknown')))).slice(0, 10);
  if (labels.length < 3) return <EmptyAdvanced message="Radar needs at least three categories." />;
  const groupedRows = new Map(labels.map((label) => [label, rows.filter((row) => String(row[field] ?? 'Unknown') === label)]));
  const series = metrics.slice(0, 4).map((metric) => ({
    metric,
    values: labels.map((label) => aggregateMetric(groupedRows.get(label) ?? [], metric, preAggregated)),
  }));
  const max = Math.max(...series.flatMap((item) => item.values.map((value) => Math.abs(value))), 1);
  const cx = 400;
  const cy = 210;
  const radius = 150;
  const angles = labels.map((_, index) => index * 360 / labels.length);
  return (
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="h-full w-full">
      {[0.25, 0.5, 0.75, 1].map((scale) => (
        <polygon key={scale} points={angles.map((angle) => {
          const p = polar(cx, cy, radius * scale, angle);
          return `${p.x},${p.y}`;
        }).join(' ')} fill="none" stroke="rgb(var(--border-line))" />
      ))}
      {angles.map((angle, index) => {
        const p = polar(cx, cy, radius + 24, angle);
        const axis = polar(cx, cy, radius, angle);
        return (
          <g key={labels[index]}>
            <line x1={cx} y1={cy} x2={axis.x} y2={axis.y} stroke="rgb(var(--border-line))" />
            <text x={p.x} y={p.y} fontSize={11} textAnchor="middle" fill="rgb(var(--text-secondary))">{labels[index].slice(0, 16)}</text>
          </g>
        );
      })}
      {series.map((item, index) => {
        const points = item.values.map((value, valueIndex) => {
          const p = polar(cx, cy, radius * positiveShare(value, max), angles[valueIndex]);
          return `${p.x},${p.y}`;
        }).join(' ');
        return (
          <g key={metricKey(item.metric)}>
            {(() => {
              // Phase-15.85 — RADAR series keyed by metricKey (matches the
              // Series colors editor's metric key entries).
              const radarColor = resolveSliceColor(style, palette, metricKey(item.metric), index);
              return (
                <>
                  <polygon points={points} fill={radarColor} opacity={0.16} stroke={radarColor} strokeWidth={2} />
                  <text x={28} y={28 + index * 18} fontSize={11} fill={radarColor}>{metricLabel(item.metric)}</text>
                </>
              );
            })()}
          </g>
        );
      })}
    </svg>
  );
}

function FunnelChartSvg({ items, style, palette, onSelect }: { items: NameValue[]; style: ChartStyleConfig; palette: string[]; onSelect?: (name: string) => void }) {
  if (!items.length) return <EmptyAdvanced message="No funnel stages to render." />;
  const max = Math.max(...items.map((item) => item.value), 1);
  const h = Math.min(56, 320 / Math.max(items.length, 1));
  return (
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="h-full w-full">
      {items.map((item, index) => {
        const topWidth = 560 * positiveShare(item.value, max);
        const next = items[index + 1]?.value ?? item.value * 0.82;
        const bottomWidth = 560 * positiveShare(next, max);
        const y = 42 + index * (h + 8);
        const x1 = 400 - topWidth / 2;
        const x2 = 400 + topWidth / 2;
        const x3 = 400 + bottomWidth / 2;
        const x4 = 400 - bottomWidth / 2;
        return (
          <g key={item.name} onClick={() => onSelect?.(item.name)} className="cursor-pointer">
            <path d={`M ${x1} ${y} L ${x2} ${y} L ${x3} ${y + h} L ${x4} ${y + h} Z`} fill={resolveSliceColor(style, palette, item.name, index)} opacity={0.9} />
            <text x={400} y={y + h / 2 + 4} fontSize={12} textAnchor="middle" fill="#fff">{item.name.slice(0, 28)} - {formatNumber(item.value, style)}</text>
            <title>{item.name}: {formatNumber(item.value, style)}</title>
          </g>
        );
      })}
    </svg>
  );
}

function GaugeChartSvg({ value, target, style, palette }: { value: number; target: number; style: ChartStyleConfig; palette: string[] }) {
  const safeTarget = target > 0 ? target : Math.max(value, 1);
  const pct = Math.max(0, Math.min(value / safeTarget, 1));
  const start = -115;
  const end = 115;
  const valueEnd = start + (end - start) * pct;
  const arc = (r: number, a0: number, a1: number) => {
    const p0 = polar(400, 260, r, a0);
    const p1 = polar(400, 260, r, a1);
    return `M ${p0.x} ${p0.y} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${p1.x} ${p1.y}`;
  };
  const needle = polar(400, 260, 112, valueEnd);
  return (
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="h-full w-full">
      <path d={arc(150, start, end)} fill="none" stroke="rgb(var(--surface-3))" strokeWidth={34} strokeLinecap="round" />
      <path d={arc(150, start, valueEnd)} fill="none" stroke={palette[0]} strokeWidth={34} strokeLinecap="round" />
      <line x1={400} y1={260} x2={needle.x} y2={needle.y} stroke="rgb(var(--text-primary))" strokeWidth={4} strokeLinecap="round" />
      <circle cx={400} cy={260} r={8} fill="rgb(var(--text-primary))" />
      <text x={400} y={330} fontSize={34} fontWeight={700} textAnchor="middle" fill="rgb(var(--text-primary))">{formatNumber(value, style)}</text>
      <text x={400} y={354} fontSize={12} textAnchor="middle" fill="rgb(var(--text-tertiary))">Target {formatNumber(safeTarget, style)}</text>
    </svg>
  );
}

function BulletChartSvg({ value, target, style, palette }: { value: number; target: number; style: ChartStyleConfig; palette: string[] }) {
  const safeTarget = target > 0 ? target : Math.max(value, 1);
  const max = Math.max(value, safeTarget) * 1.18;
  const valueWidth = 560 * Math.max(0, value / max);
  const targetX = 120 + 560 * Math.max(0, safeTarget / max);
  return (
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="h-full w-full">
      <rect x={120} y={175} width={560} height={70} rx={8} fill="rgb(var(--surface-3))" />
      <rect x={120} y={175} width={valueWidth} height={70} rx={8} fill={palette[0]} />
      <line x1={targetX} y1={150} x2={targetX} y2={272} stroke="rgb(var(--text-primary))" strokeWidth={4} />
      <text x={120} y={315} fontSize={13} fill="rgb(var(--text-tertiary))">0</text>
      <text x={680} y={315} fontSize={13} textAnchor="end" fill="rgb(var(--text-tertiary))">{formatNumber(max, style)}</text>
      <text x={400} y={130} fontSize={30} textAnchor="middle" fontWeight={700} fill="rgb(var(--text-primary))">{formatNumber(value, style)}</text>
      <text x={400} y={152} fontSize={12} textAnchor="middle" fill="rgb(var(--text-tertiary))">Target {formatNumber(safeTarget, style)}</text>
    </svg>
  );
}

function TreemapChart({ items, style, palette, onSelect }: { items: NameValue[]; style: ChartStyleConfig; palette: string[]; onSelect?: (name: string) => void }) {
  if (!items.length) return <EmptyAdvanced message="No categories to render." />;
  const total = items.reduce((sum, item) => sum + Math.max(item.value, 0), 0) || 1;
  let x = 20;
  let y = 20;
  let rowH = 0;
  return (
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="h-full w-full">
      {items.map((item, index) => {
        const area = (SVG_W - 40) * (SVG_H - 40) * (Math.max(item.value, 0) / total);
        const w = Math.max(90, Math.min(300, Math.sqrt(area) * 1.55));
        const h = Math.max(46, area / w);
        if (x + w > SVG_W - 20) {
          x = 20;
          y += rowH + 8;
          rowH = 0;
        }
        const rect = { x, y, w, h };
        x += w + 8;
        rowH = Math.max(rowH, h);
        return (
          <g key={item.name} onClick={() => onSelect?.(item.name)} className="cursor-pointer">
            <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx={8} fill={resolveSliceColor(style, palette, item.name, index)} opacity={0.88} />
            <text x={rect.x + 10} y={rect.y + 20} fontSize={12} fontWeight={600} fill="#fff">{item.name.slice(0, 22)}</text>
            <text x={rect.x + 10} y={rect.y + 38} fontSize={11} fill="#fff">{formatNumber(item.value, style)}</text>
            <title>{item.name}: {formatNumber(item.value, style)}</title>
          </g>
        );
      })}
    </svg>
  );
}

function WaterfallChartSvg({ items, style, palette, onSelect }: { items: NameValue[]; style: ChartStyleConfig; palette: string[]; onSelect?: (name: string) => void }) {
  if (!items.length) return <EmptyAdvanced message="No categories to render." />;
  const steps = items.slice(0, 24);
  let cumulative = 0;
  const bars = steps.map((item) => {
    const start = cumulative;
    cumulative += item.value;
    return { ...item, start, end: cumulative };
  });
  const min = Math.min(0, ...bars.flatMap((bar) => [bar.start, bar.end]));
  const max = Math.max(0, ...bars.flatMap((bar) => [bar.start, bar.end]));
  const scaleY = (value: number) => 360 - ((value - min) / Math.max(max - min, 1)) * 300;
  const barW = Math.max(14, 650 / Math.max(bars.length, 1) - 8);
  return (
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="h-full w-full">
      <line x1={60} y1={scaleY(0)} x2={760} y2={scaleY(0)} stroke="rgb(var(--border-line))" />
      {bars.map((bar, index) => {
        const x = 70 + index * (barW + 8);
        const y1 = scaleY(bar.start);
        const y2 = scaleY(bar.end);
        const y = Math.min(y1, y2);
        const h = Math.max(2, Math.abs(y2 - y1));
        const color = bar.value >= 0 ? palette[0] : (palette[3] ?? '#ef4444');
        return (
          <g key={bar.name} onClick={() => onSelect?.(bar.name)} className="cursor-pointer">
            <rect x={x} y={y} width={barW} height={h} rx={4} fill={color} />
            {style.showDataLabels && (
              <text x={x + barW / 2} y={Math.max(18, y - 6)} fontSize={10} textAnchor="middle" fill="rgb(var(--text-secondary))">
                {formatNumber(bar.value, style)}
              </text>
            )}
            <text x={x + barW / 2} y={388} fontSize={10} textAnchor="end" transform={`rotate(-35 ${x + barW / 2} 388)`} fill="rgb(var(--text-tertiary))">{bar.name.slice(0, 12)}</text>
            <title>{bar.name}: {formatNumber(bar.value, style)}</title>
          </g>
        );
      })}
    </svg>
  );
}

function XYBubbleChart({ rows, type, roleConfig, metric, style, palette, preAggregated, onSelect }: {
  rows: ChartRow[];
  type: string;
  roleConfig: ExploreChartModel['roleConfig'];
  metric?: MetricConfig;
  style: ChartStyleConfig;
  palette: string[];
  preAggregated?: boolean;
  onSelect?: (field: string, value: unknown) => void;
}) {
  const { scatterX, scatterY, dimension } = roleConfig;
  if (!scatterX || !scatterY) return <EmptyAdvanced message="Select X and Y numeric columns." />;
  const points = rows
    .map((row) => ({
      x: Number(row[scatterX]),
      y: Number(row[scatterY]),
      r: metric ? Math.abs(metricValue(row, metric, preAggregated)) : 1,
      label: dimension ? row[dimension] : undefined,
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .slice(0, 1000);
  if (!points.length) return <EmptyAdvanced message="No valid coordinate rows to render." />;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const rs = points.map((point) => point.r);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const maxR = Math.max(...rs, 1);
  const sx = (value: number) => 70 + ((value - minX) / Math.max(maxX - minX, 1)) * 650;
  const sy = (value: number) => 360 - ((value - minY) / Math.max(maxY - minY, 1)) * 300;
  const sr = (value: number) => type === 'BUBBLE' || type === 'MAP_POINT' ? 4 + safeSqrtShare(value, maxR) * 20 : 5;
  return (
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="h-full w-full">
      <rect x={55} y={35} width={690} height={335} fill={type === 'MAP_POINT' ? 'rgb(var(--surface-2))' : 'transparent'} stroke="rgb(var(--border-line))" rx={10} />
      <text x={70} y={394} fontSize={11} fill="rgb(var(--text-tertiary))">{scatterX}</text>
      <text x={28} y={55} fontSize={11} fill="rgb(var(--text-tertiary))" transform="rotate(-90 28 55)">{scatterY}</text>
      {points.map((point, index) => (
        <g key={`${point.x}-${point.y}-${index}`} onClick={() => dimension && onSelect?.(dimension, point.label)} className="cursor-pointer">
          <circle cx={sx(point.x)} cy={sy(point.y)} r={sr(point.r)} fill={resolveSliceColor(style, palette, String(point.label ?? index), index)} opacity={0.68} stroke="rgb(var(--surface-1))" />
          <title>{point.label ? `${point.label}: ` : ''}${scatterX} ${formatNumber(point.x, style)}, ${scatterY} ${formatNumber(point.y, style)}</title>
        </g>
      ))}
    </svg>
  );
}

function HeatmapChart({ pairs, style, palette, onSelect }: { pairs: PairValue[]; style: ChartStyleConfig; palette: string[]; onSelect?: (source: string) => void }) {
  if (!pairs.length) return <EmptyAdvanced message="Select row, column, and value fields." />;
  const sources = Array.from(new Set(pairs.map((pair) => pair.source))).slice(0, 18);
  const targets = Array.from(new Set(pairs.map((pair) => pair.target))).slice(0, 14);
  const max = Math.max(...pairs.map((pair) => Math.abs(pair.value)), 1);
  const cellW = 660 / Math.max(targets.length, 1);
  const cellH = 300 / Math.max(sources.length, 1);
  const valueMap = new Map(pairs.map((pair) => [`${pair.source}\u0000${pair.target}`, pair.value]));
  return (
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="h-full w-full">
      {sources.map((source, row) => (
        <text key={source} x={112} y={65 + row * cellH + cellH / 2} textAnchor="end" fontSize={10} fill="rgb(var(--text-tertiary))">{source.slice(0, 18)}</text>
      ))}
      {targets.map((target, col) => (
        <text key={target} x={132 + col * cellW + cellW / 2} y={40} textAnchor="middle" fontSize={10} fill="rgb(var(--text-tertiary))">{target.slice(0, 10)}</text>
      ))}
      {sources.map((source, row) => targets.map((target, col) => {
        const value = valueMap.get(`${source}\u0000${target}`) ?? 0;
        const opacity = value !== 0 ? 0.12 + (Math.abs(value) / max) * 0.84 : 0.05;
        return (
          <g key={`${source}-${target}`} onClick={() => onSelect?.(source)} className="cursor-pointer">
            <rect x={125 + col * cellW} y={52 + row * cellH} width={Math.max(cellW - 2, 1)} height={Math.max(cellH - 2, 1)} rx={3} fill={palette[0]} opacity={opacity} />
            {style.showDataLabels && cellW >= 42 && cellH >= 20 && value !== 0 && (
              <text
                x={125 + col * cellW + cellW / 2}
                y={52 + row * cellH + cellH / 2 + 4}
                textAnchor="middle"
                fontSize={10}
                fill="rgb(var(--text-primary))"
              >
                {formatNumber(value, style)}
              </text>
            )}
            <title>{source} / {target}: {formatNumber(value, style)}</title>
          </g>
        );
      }))}
    </svg>
  );
}

function RegionChart({ items, style, palette, onSelect }: { items: NameValue[]; style: ChartStyleConfig; palette: string[]; onSelect?: (name: string) => void }) {
  const max = Math.max(...items.map((item) => item.value), 1);
  return (
    <div className="h-full overflow-auto p-4">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {items.map((item, index) => (
          <button key={item.name} onClick={() => onSelect?.(item.name)}
            className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3 text-left hover:bg-surface-2">
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-sm font-medium text-text-secondary">{item.name}</span>
              <span className="text-sm font-semibold text-text-primary">{formatNumber(item.value, style)}</span>
            </div>
            <div className="mt-2 h-2 rounded-full bg-surface-3">
              <div className="h-2 rounded-full" style={{ width: `${Math.max(3, positiveShare(item.value, max) * 100)}%`, backgroundColor: resolveSliceColor(style, palette, item.name, index) }} />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function BoxplotChart({ rows, field, metric, style, palette, onSelect }: { rows: ChartRow[]; field?: string; metric?: MetricConfig; style: ChartStyleConfig; palette: string[]; onSelect?: (name: string) => void }) {
  if (!field || !metric) return <EmptyAdvanced message="Select category and numeric value columns." />;
  const grouped = new Map<string, number[]>();
  for (const row of rows) {
    const key = String(row[field] ?? 'Unknown');
    const value = metricValueForRawDistribution(row, metric);
    if (!Number.isFinite(value)) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(value);
  }
  const quantile = (values: number[], q: number) => values[Math.floor((values.length - 1) * q)] ?? 0;
  const stats = Array.from(grouped.entries()).slice(0, 18).map(([name, raw]) => {
    const values = [...raw].sort((a, b) => a - b);
    return { name, min: values[0] ?? 0, q1: quantile(values, 0.25), med: quantile(values, 0.5), q3: quantile(values, 0.75), max: values[values.length - 1] ?? 0 };
  });
  if (!stats.length) return <EmptyAdvanced message="No distribution rows to render." />;
  const min = Math.min(...stats.map((item) => item.min));
  const max = Math.max(...stats.map((item) => item.max));
  const sy = (value: number) => 355 - ((value - min) / Math.max(max - min, 1)) * 300;
  const step = 680 / Math.max(stats.length, 1);
  return (
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="h-full w-full">
      {stats.map((item, index) => {
        const x = 70 + index * step + step / 2;
        const boxW = Math.min(36, step * 0.55);
        return (
          <g key={item.name} onClick={() => onSelect?.(item.name)} className="cursor-pointer">
            <line x1={x} x2={x} y1={sy(item.min)} y2={sy(item.max)} stroke="rgb(var(--text-tertiary))" />
            <rect x={x - boxW / 2} y={sy(item.q3)} width={boxW} height={Math.max(2, sy(item.q1) - sy(item.q3))} rx={3} fill={resolveSliceColor(style, palette, item.name, index)} opacity={0.35} stroke={resolveSliceColor(style, palette, item.name, index)} />
            <line x1={x - boxW / 2} x2={x + boxW / 2} y1={sy(item.med)} y2={sy(item.med)} stroke="rgb(var(--text-primary))" strokeWidth={2} />
            <text x={x} y={390} fontSize={10} textAnchor="end" transform={`rotate(-35 ${x} 390)`} fill="rgb(var(--text-tertiary))">{item.name.slice(0, 12)}</text>
            <title>{item.name}: median {formatNumber(item.med, style)}</title>
          </g>
        );
      })}
    </svg>
  );
}

function SankeyChart({ pairs, style, palette, onSelect }: { pairs: PairValue[]; style: ChartStyleConfig; palette: string[]; onSelect?: (source: string) => void }) {
  const flows = applyLimit(pairs, style, 18);
  if (!flows.length) return <EmptyAdvanced message="Select source, target, and value columns." />;
  const sources = Array.from(new Set(flows.map((flow) => flow.source)));
  const targets = Array.from(new Set(flows.map((flow) => flow.target)));
  const max = Math.max(...flows.map((flow) => flow.value), 1);
  const yFor = (items: string[], name: string) => 60 + Math.max(0, items.indexOf(name)) * (300 / Math.max(items.length - 1, 1));
  return (
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="h-full w-full">
      {flows.map((flow, index) => {
        const y1 = yFor(sources, flow.source);
        const y2 = yFor(targets, flow.target);
        const width = 2 + positiveShare(flow.value, max) * 24;
        return (
          <path key={`${flow.source}-${flow.target}-${index}`} d={`M 185 ${y1} C 330 ${y1}, 470 ${y2}, 615 ${y2}`}
            fill="none" stroke={resolveSliceColor(style, palette, flow.source, index)} strokeWidth={width} opacity={0.38}
            onClick={() => onSelect?.(flow.source)} className="cursor-pointer">
            <title>{flow.source}{' -> '}{flow.target}: {formatNumber(flow.value, style)}</title>
          </path>
        );
      })}
      {sources.map((source, index) => (
        <g key={source} onClick={() => onSelect?.(source)} className="cursor-pointer">
          <rect x={55} y={yFor(sources, source) - 13} width={130} height={26} rx={6} fill={resolveSliceColor(style, palette, source, index)} opacity={0.85} />
          <text x={120} y={yFor(sources, source) + 4} textAnchor="middle" fontSize={11} fill="#fff">{source.slice(0, 18)}</text>
        </g>
      ))}
      {targets.map((target) => (
        <g key={target}>
          <rect x={615} y={yFor(targets, target) - 13} width={130} height={26} rx={6} fill="rgb(var(--surface-3))" stroke="rgb(var(--border-line))" />
          <text x={680} y={yFor(targets, target) + 4} textAnchor="middle" fontSize={11} fill="rgb(var(--text-secondary))">{target.slice(0, 18)}</text>
        </g>
      ))}
    </svg>
  );
}

function SunburstChart({ pairs, style, palette, onSelect }: { pairs: PairValue[]; style: ChartStyleConfig; palette: string[]; onSelect?: (source: string) => void }) {
  if (!pairs.length) return <EmptyAdvanced message="Select hierarchy fields and a value column." />;
  const inner = applyLimit(
    Array.from(new Map(pairs.map((pair) => [pair.source, 0])).keys()).map((source) => ({
      name: source,
      value: pairs.filter((pair) => pair.source === source).reduce((sum, pair) => sum + pair.value, 0),
    })),
    style,
    10,
  );
  const sourceSet = new Set(inner.map((item) => item.name));
  const outerPairs = pairs.filter((pair) => sourceSet.has(pair.source));
  const total = inner.reduce((sum, item) => sum + item.value, 0) || 1;
  let cursor = 0;
  const sourceAngles = new Map<string, { start: number; end: number }>();
  return (
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="h-full w-full">
      {inner.map((item, index) => {
        const angle = (item.value / total) * 360;
        const start = cursor;
        const end = cursor + angle;
        sourceAngles.set(item.name, { start, end });
        cursor = end;
        return (
          <path key={item.name} d={ringSegment(400, 210, 115, 52, start, end)} fill={resolveSliceColor(style, palette, item.name, index)} opacity={0.86}
            onClick={() => onSelect?.(item.name)} className="cursor-pointer">
            <title>{item.name}: {formatNumber(item.value, style)}</title>
          </path>
        );
      })}
      {outerPairs.map((pair, index) => {
        const range = sourceAngles.get(pair.source);
        if (!range) return null;
        const siblings = outerPairs.filter((item) => item.source === pair.source);
        const siblingTotal = siblings.reduce((sum, item) => sum + item.value, 0) || 1;
        const before = siblings.slice(0, siblings.indexOf(pair)).reduce((sum, item) => sum + item.value, 0);
        const start = range.start + ((before / siblingTotal) * (range.end - range.start));
        const end = start + ((pair.value / siblingTotal) * (range.end - range.start));
        return (
          <path key={`${pair.source}-${pair.target}-${index}`} d={ringSegment(400, 210, 168, 118, start, end)} fill={resolveSliceColor(style, palette, pair.target, index)} opacity={0.62}>
            <title>{pair.source} / {pair.target}: {formatNumber(pair.value, style)}</title>
          </path>
        );
      })}
    </svg>
  );
}

function RibbonChart({ pairs, palette, style, onSelect }: { pairs: PairValue[]; palette: string[]; style: ChartStyleConfig; onSelect?: (source: string) => void }) {
  const times = Array.from(new Set(pairs.map((pair) => pair.source))).slice(0, 20);
  const cats = Array.from(new Set(pairs.map((pair) => pair.target))).slice(0, 8);
  if (times.length < 2 || cats.length === 0) return <EmptyAdvanced message="Select time, series, and value fields." />;
  const valueMap = new Map(pairs.map((pair) => [`${pair.source}\u0000${pair.target}`, pair.value]));
  const rankByTime = new Map<string, Map<string, number>>();
  for (const time of times) {
    const ranked = cats
      .map((cat) => ({ cat, value: valueMap.get(`${time}\u0000${cat}`) ?? 0 }))
      .sort((a, b) => b.value - a.value);
    rankByTime.set(time, new Map(ranked.map((item, index) => [item.cat, index])));
  }
  const x = (index: number) => 70 + index * (660 / Math.max(times.length - 1, 1));
  const y = (rank: number) => 55 + rank * (300 / Math.max(cats.length - 1, 1));
  return (
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="h-full w-full">
      {cats.map((cat, catIndex) => {
        const d = times.map((time, timeIndex) => `${timeIndex === 0 ? 'M' : 'L'} ${x(timeIndex)} ${y(rankByTime.get(time)?.get(cat) ?? cats.length - 1)}`).join(' ');
        return (
          <path key={cat} d={d} fill="none" stroke={resolveSliceColor(style, palette, cat, catIndex)} strokeWidth={8} strokeLinecap="round" strokeLinejoin="round" opacity={0.72}
            onClick={() => onSelect?.(cat)} className="cursor-pointer">
            <title>{cat}</title>
          </path>
        );
      })}
      {times.map((time, index) => (
        <text key={time} x={x(index)} y={392} fontSize={10} textAnchor="end" transform={`rotate(-35 ${x(index)} 392)`} fill="rgb(var(--text-tertiary))">{time.slice(0, 12)}</text>
      ))}
    </svg>
  );
}

function TimelineChart({ rows, roleConfig, metric, style, palette, preAggregated, onSelect }: {
  rows: ChartRow[];
  roleConfig: ExploreChartModel['roleConfig'];
  metric?: MetricConfig;
  style: ChartStyleConfig;
  palette: string[];
  preAggregated?: boolean;
  onSelect?: (field: string, value: unknown) => void;
}) {
  const { timeField, dimension } = roleConfig;
  if (!timeField || !dimension) return <EmptyAdvanced message="Select time and label fields." />;
  const events = rows
    .map((row) => ({ label: String(row[dimension] ?? 'Event'), time: new Date(String(row[timeField] ?? '')).getTime(), value: metricValue(row, metric, preAggregated) }))
    .filter((event) => Number.isFinite(event.time))
    .sort((a, b) => a.time - b.time)
    .slice(0, 80);
  if (!events.length) return <EmptyAdvanced message="No valid timeline rows to render." />;
  const min = Math.min(...events.map((event) => event.time));
  const max = Math.max(...events.map((event) => event.time));
  const x = (time: number) => 70 + ((time - min) / Math.max(max - min, 1)) * 660;
  const maxValue = Math.max(...events.map((event) => Math.abs(event.value)), 1);
  return (
    <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="h-full w-full">
      <line x1={70} y1={210} x2={730} y2={210} stroke="rgb(var(--border-line))" strokeWidth={2} />
      {events.map((event, index) => {
        const yy = index % 2 === 0 ? 155 : 265;
        const r = metric ? 5 + Math.sqrt(Math.abs(event.value) / maxValue) * 12 : 7;
        return (
          <g key={`${event.label}-${event.time}-${index}`} onClick={() => onSelect?.(dimension, event.label)} className="cursor-pointer">
            <line x1={x(event.time)} y1={210} x2={x(event.time)} y2={yy} stroke="rgb(var(--border-line))" />
            <circle cx={x(event.time)} cy={yy} r={r} fill={resolveSliceColor(style, palette, event.label, index)} opacity={0.82} />
            {index < 18 && <text x={x(event.time)} y={yy + (yy < 210 ? -14 : 24)} fontSize={10} textAnchor="middle" fill="rgb(var(--text-tertiary))">{event.label.slice(0, 14)}</text>}
            <title>{event.label}: {new Date(event.time).toISOString().slice(0, 10)}{metric ? `, ${formatNumber(event.value, style)}` : ''}</title>
          </g>
        );
      })}
    </svg>
  );
}

function WordCloudChart({ items, style, palette, onSelect }: { items: NameValue[]; style: ChartStyleConfig; palette: string[]; onSelect?: (name: string) => void }) {
  const max = Math.max(...items.map((item) => Math.abs(item.value)), 1);
  return (
    <div className="flex h-full items-center justify-center overflow-hidden p-6">
      <div className="flex max-w-full flex-wrap items-center justify-center gap-x-5 gap-y-3">
        {items.map((item, index) => (
          <button key={item.name} onClick={() => onSelect?.(item.name)}
            className="font-semibold leading-none hover:opacity-80"
            style={{
              color: resolveSliceColor(style, palette, item.name, index),
              fontSize: `${14 + safeSqrtShare(item.value, max) * 34}px`,
            }}
            title={`${item.name}: ${formatNumber(item.value, style)}`}>
            {item.name}
          </button>
        ))}
      </div>
    </div>
  );
}

export function AdvancedExploreChart({
  type,
  data,
  model,
  style,
  palette,
  havingFilters,
  preAggregated = false,
  onStyleConfigChange,
  onSelectDataPoint,
  labelMap,
}: AdvancedExploreChartProps) {
  const title = style.chartTitle?.trim() || undefined;
  const titleFontSize = Math.max(style.chartTitleFontSize ?? style.fontSize ?? 12, 14);
  const tableNumberFormat = style.numberFormat && style.numberFormat !== 'compact' ? style.numberFormat : 'auto';
  const roleConfig = model.roleConfig;
  const primaryMetric = roleConfig.metrics[0];
  const benchmarkMetric = roleConfig.benchmarkMetric;
  const dimension = roleConfig.dimension;
  const breakdown = roleConfig.breakdown;
  const xField = type === 'RIBBON' ? (roleConfig.timeField || dimension) : dimension;

  const items = useMemo(
    () => {
      const grouped = groupByMetric(data, dimension, primaryMetric, preAggregated);
      const filtered = applyNameValueHaving(grouped, dimension, primaryMetric, havingFilters);
      return applyLimit(filtered, style, type === 'WORD_CLOUD' ? 42 : 24);
    },
    [data, dimension, primaryMetric, havingFilters, preAggregated, style, type],
  );
  const pairs = useMemo(
    () => {
      const grouped = groupPairs(data, xField, breakdown, primaryMetric, preAggregated);
      return applyPairHaving(grouped, xField, breakdown, primaryMetric, havingFilters);
    },
    [data, xField, breakdown, primaryMetric, havingFilters, preAggregated],
  );
  const totalValue = useMemo(
    () => aggregateMetric(data, primaryMetric, preAggregated),
    [data, primaryMetric, preAggregated],
  );
  const targetValue = useMemo(() => {
    const metricTarget = benchmarkMetric ? aggregateMetric(data, benchmarkMetric, preAggregated) : 0;
    if (metricTarget > 0) return metricTarget;
    const staticTarget = style.kpiBenchmarkValue === '' || style.kpiBenchmarkValue == null
      ? Number(style.benchmarkValue)
      : Number(style.kpiBenchmarkValue);
    return Number.isFinite(staticTarget) && staticTarget > 0 ? staticTarget : Math.max(totalValue, 1);
  }, [benchmarkMetric, data, preAggregated, style.benchmarkValue, style.kpiBenchmarkValue, totalValue]);

  const emitDimension = (value: unknown) => {
    if (dimension) onSelectDataPoint?.({ field: dimension, value });
  };
  const emitField = (field: string, value: unknown) => {
    onSelectDataPoint?.({ field, value });
  };
  const tableWidthsChange = (nextWidths: Record<string, number>) => {
    onStyleConfigChange?.({
      ...style,
      tableColumnWidths: Object.keys(nextWidths).length > 0 ? nextWidths : undefined,
    });
  };

  if (type === 'MATRIX') {
    return (
      <ChartFrame title={title} titleFontSize={titleFontSize}>
        <TableVisualization
          data={model.tableData}
          columns={model.tableColumns}
          conditionalFormatting={style.tableEnableConditionalFormatting ? style.tableConditionalFormatting : undefined}
          heatmapRules={style.tableEnableHeatmap ? style.tableHeatmapRules : undefined}
          summaryRows={style.tableSummaryRows}
          showSummaryRow={style.tableShowSummaryRow}
          summaryLabel={style.tableSummaryLabel}
          summaryLabelColumn={style.tableSummaryLabelColumn}
          columnWidths={style.tableColumnWidths}
          onColumnWidthsChange={onStyleConfigChange ? tableWidthsChange : undefined}
          columnAlignments={style.tableColumnAlignments}
          hyperlinkRules={style.tableHyperlinkRules}
          numberFormat={tableNumberFormat}
          decimalPlaces={style.decimalPlaces}
          currencySymbol={style.currencySymbol}
          columnLabels={labelMap}
        />
      </ChartFrame>
    );
  }

  return (
    <ChartFrame title={title} titleFontSize={titleFontSize}>
      {type === 'DONUT' || type === 'POLAR_AREA' ? (
        <DonutOrPolarChart type={type} items={items} style={style} palette={palette} onSelect={emitDimension} />
      ) : type === 'RADAR' ? (
        <RadarChartSvg rows={data} metrics={roleConfig.metrics} field={dimension} palette={palette} style={style} preAggregated={preAggregated} />
      ) : type === 'FUNNEL' ? (
        <FunnelChartSvg items={items} style={style} palette={palette} onSelect={emitDimension} />
      ) : type === 'GAUGE' ? (
        <GaugeChartSvg value={totalValue} target={targetValue} style={style} palette={palette} />
      ) : type === 'BULLET' ? (
        <BulletChartSvg value={totalValue} target={targetValue} style={style} palette={palette} />
      ) : type === 'TREEMAP' ? (
        <TreemapChart items={items} style={style} palette={palette} onSelect={emitDimension} />
      ) : type === 'WATERFALL' ? (
        <WaterfallChartSvg items={items} style={style} palette={palette} onSelect={emitDimension} />
      ) : type === 'BUBBLE' || type === 'MAP_POINT' ? (
        <XYBubbleChart rows={data} type={type} roleConfig={roleConfig} metric={primaryMetric} style={style} palette={palette} preAggregated={preAggregated} onSelect={emitField} />
      ) : type === 'HEATMAP' ? (
        <HeatmapChart pairs={pairs} style={style} palette={palette} onSelect={(source) => xField && emitField(xField, source)} />
      ) : type === 'MAP_REGION' ? (
        <RegionChart items={items} style={style} palette={palette} onSelect={emitDimension} />
      ) : type === 'BOXPLOT' ? (
        <BoxplotChart rows={data} field={dimension} metric={primaryMetric} style={style} palette={palette} onSelect={emitDimension} />
      ) : type === 'SANKEY' ? (
        <SankeyChart pairs={pairs} style={style} palette={palette} onSelect={(source) => xField && emitField(xField, source)} />
      ) : type === 'SUNBURST' ? (
        <SunburstChart pairs={pairs} style={style} palette={palette} onSelect={(source) => xField && emitField(xField, source)} />
      ) : type === 'RIBBON' ? (
        <RibbonChart pairs={pairs} palette={palette} style={style} onSelect={(target) => breakdown && emitField(breakdown, target)} />
      ) : type === 'TIMELINE' ? (
        <TimelineChart rows={data} roleConfig={roleConfig} metric={primaryMetric} style={style} palette={palette} preAggregated={preAggregated} onSelect={emitField} />
      ) : type === 'WORD_CLOUD' ? (
        <WordCloudChart items={items} style={style} palette={palette} onSelect={emitDimension} />
      ) : (
        <EmptyAdvanced message="Unsupported advanced chart type." />
      )}
    </ChartFrame>
  );
}
