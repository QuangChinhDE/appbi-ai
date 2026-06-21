'use client';

import React, { useMemo, useRef, useState, useEffect } from 'react';
import { useI18n } from '@/providers/LanguageProvider';
import { TableVisualization } from '@/components/visualizations/TableVisualization';
import { applyFiltersToRows, type BaseFilter } from '@/lib/filters';
import type { ChartStyleConfig, MetricConfig } from './ExploreChartConfig';
import { fieldLabel, metricKey, metricLabel } from './ExploreChartConfig';
import type { ExploreChartModel } from './chartDataAdapter';
import { buildExploreChartModel } from './chartDataAdapter';

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

/**
 * Phase-15.86 — local copy of the data-label template expander used by
 * ExploreChart. Kept here so AdvancedExploreCharts.tsx doesn't need a
 * circular import.
 *
 * Tokens: {value} {label} {dimension} {series} {percent}
 */
export function expandLabelTemplate(opts: {
  template?: string;
  formatted: string;
  rawName: string;
  percent?: number;
}): string {
  const { template, formatted, rawName, percent } = opts;
  if (!template) return formatted;
  return template
    .replace(/\{value\}/g, formatted)
    .replace(/\{label\}/g, rawName)
    .replace(/\{series\}/g, rawName)
    .replace(/\{dimension\}/g, rawName)
    .replace(/\{percent\}/g, percent == null ? '' : (percent * 100).toFixed(1));
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
  onSelectDataPoint?: (selection: { field: string; value: unknown; dateRange?: [string, string]; dateGrain?: string } | null) => void;
  /** Cross-highlight (PBI-parity): the P-filtered subset of `data` (same row
   *  shape). When set, this chart (the selection SOURCE) dims its non-selected
   *  marks. null ⇒ no highlight. */
  highlightData?: Record<string, any>[] | null;
  /** Phase-15.13: same semantic label map used by ExploreChart; forwarded to
   *  TableVisualization when rendering MATRIX so headers humanise. */
  labelMap?: import('./ExploreChartConfig').SemanticLabelMap;
  /** Phase-16.x: per-column number format (field → percent/currency/number)
   *  forwarded to MATRIX's TableVisualization so a percent/currency measure
   *  formats in its own column. */
  formatMap?: Map<string, import('./ExploreChartConfig').NumberFormat>;
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
    const name = String(row[field] ?? '(blank)');
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
    const source = String(row[sourceField] ?? '(blank)');
    const target = String(row[targetField] ?? '(blank)');
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

/**
 * Phase-16.x — responsive SVG sizing.
 *
 * DA-reported: advanced (hand-rolled SVG) charts used a FIXED
 * `viewBox="0 0 800 420"`. On a dashboard tile whose aspect ratio differs
 * from 800:420, the default `preserveAspectRatio="xMidYMid meet"` scaled the
 * whole drawing to FIT + centred it — so the content stayed small in the
 * middle with large empty bands (the "kéo rộng → khoảng trống lớn" bug).
 *
 * `useElementSize` measures the actual rendered pixel box via ResizeObserver,
 * and `ResponsiveSvg` sets the `viewBox` to those real pixels so 1 user unit =
 * 1 px (no scaling, no letterbox). Every renderer draws into the measured
 * (w, h) it receives, so the content reflows to fill the tile exactly the way
 * Recharts' ResponsiveContainer does for the cartesian charts.
 */
function useElementSize<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: SVG_W, height: SVG_H });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setSize((prev) =>
          Math.abs(prev.width - r.width) > 0.5 || Math.abs(prev.height - r.height) > 0.5
            ? { width: r.width, height: r.height }
            : prev,
        );
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width: size.width, height: size.height };
}

function ResponsiveSvg({ children }: { children: (w: number, h: number) => React.ReactNode }) {
  const { ref, width, height } = useElementSize<HTMLDivElement>();
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return (
    <div ref={ref} className="h-full w-full">
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="100%" className="block">
        {children(w, h)}
      </svg>
    </div>
  );
}

function DonutOrPolarChart({
  type,
  items,
  style,
  palette,
  onSelect,
  highlightNames,
}: {
  type: string;
  items: NameValue[];
  style: ChartStyleConfig;
  palette: string[];
  onSelect?: (name: string) => void;
  highlightNames?: Set<string> | null;
}) {
  const { t } = useI18n();
  const total = items.reduce((sum, item) => sum + Math.max(item.value, 0), 0);
  const max = Math.max(...items.map((item) => Math.max(item.value, 0)), 1);
  if (total <= 0) return <EmptyAdvanced message={t('explore.advancedCharts.noPositiveValues')} />;
  return (
    <ResponsiveSvg>
      {(W, H) => {
        // Phase-16.x — donut/polar fills the tile; ring grows to the shorter
        // side of the plot area (legend reserved on the right).
        const legendW = Math.min(200, Math.max(118, W * 0.28));
        const areaW = Math.max(40, W - legendW);
        const cx = areaW / 2;
        const cy = H / 2;
        const outer = Math.max(24, Math.min(areaW, H) / 2 - 38);
        const inner = type === 'DONUT' ? Math.max(outer * 0.3, outer * ((style.pieInnerRadius ?? 55) / 100)) : 0;
        const legendCount = Math.min(items.length, 12);
        const legendY = Math.max(12, (H - legendCount * 22) / 2);
        let cursor = 0;
        return (
          <>
            {items.map((item, index) => {
              const angle = type === 'POLAR_AREA' ? 360 / items.length : (Math.max(item.value, 0) / total) * 360;
              const radius = type === 'POLAR_AREA' ? (outer * 0.24) + (safeSqrtShare(item.value, max) * (outer - outer * 0.24)) : outer;
              const path = ringSegment(cx, cy, radius, type === 'DONUT' ? inner : 0, cursor, cursor + angle);
              const mid = cursor + angle / 2;
              const labelPoint = polar(cx, cy, Math.max(radius + 16, outer * 0.6), mid);
              const dlc = style.dataLabelConfig;
              const labelsEnabled = dlc?.enabled ?? style.showDataLabels ?? false;
              const sliceOverride = dlc?.overrides?.[item.name];
              const sliceFontColor = sliceOverride?.fontColor ?? dlc?.fontColor ?? 'rgb(var(--text-secondary))';
              const sliceFontSize = sliceOverride?.fontSize ?? dlc?.fontSize ?? 11;
              const effectiveFormat = sliceOverride?.format ?? style.seriesFormats?.[item.name] ?? dlc?.format ?? style.numberFormat;
              const styleForLabel = effectiveFormat ? { ...style, numberFormat: effectiveFormat } : style;
              const sharePct = item.value / Math.max(total, 1);
              let labelText: string;
              if (labelsEnabled) {
                if (style.dataLabelTemplate) {
                  labelText = expandLabelTemplate({ template: style.dataLabelTemplate, formatted: formatNumber(item.value, styleForLabel), rawName: item.name, percent: sharePct });
                } else {
                  labelText = `${item.name.slice(0, 12)} ${formatNumber(item.value, styleForLabel)} (${formatPercent(item.value, total)})`;
                }
              } else {
                labelText = item.name.slice(0, 16);
              }
              cursor += angle;
              const sliceColor = resolveSliceColor(style, palette, item.name, index);
              const showLabelForSlice = labelsEnabled ? sharePct >= 0.03 && index < 10 : index < 10;
              return (
                <g key={item.name} onClick={() => onSelect?.(item.name)} className="cursor-pointer">
                  <path d={path} fill={sliceColor} opacity={highlightNames ? (highlightNames.has(item.name) ? 1 : 0.25) : 0.9} stroke="rgb(var(--surface-1))" strokeWidth={2} />
                  {showLabelForSlice && (
                    <text x={labelPoint.x} y={labelPoint.y} fontSize={sliceFontSize} textAnchor="middle" fill={sliceFontColor}>{labelText}</text>
                  )}
                  <title>{item.name}: {formatNumber(item.value, style)}</title>
                </g>
              );
            })}
            <g transform={`translate(${areaW + 8} ${legendY})`}>
              {items.slice(0, 12).map((item, index) => (
                <g key={item.name} transform={`translate(0 ${index * 22})`}>
                  <rect width={10} height={10} rx={2} fill={resolveSliceColor(style, palette, item.name, index)} />
                  <text x={18} y={9} fontSize={11} fill="rgb(var(--text-secondary))">{item.name.slice(0, 24)}</text>
                </g>
              ))}
            </g>
          </>
        );
      }}
    </ResponsiveSvg>
  );
}

function RadarChartSvg({ rows, metrics, field, palette, style, preAggregated }: {
  rows: ChartRow[];
  metrics: MetricConfig[];
  field?: string;
  palette: string[];
  style: ChartStyleConfig;
  preAggregated?: boolean;
}) {
  const { t } = useI18n();
  if (!field || metrics.length === 0) return <EmptyAdvanced message={t('explore.advancedCharts.selectAxisAndValues')} />;
  const labels = Array.from(new Set(rows.map((row) => String(row[field] ?? '(blank)')))).slice(0, 10);
  if (labels.length < 3) return <EmptyAdvanced message={t('explore.advancedCharts.radarNeedsThree')} />;
  const groupedRows = new Map(labels.map((label) => [label, rows.filter((row) => String(row[field] ?? '(blank)') === label)]));
  const series = metrics.slice(0, 4).map((metric) => ({
    metric,
    values: labels.map((label) => aggregateMetric(groupedRows.get(label) ?? [], metric, preAggregated)),
  }));
  const max = Math.max(...series.flatMap((item) => item.values.map((value) => Math.abs(value))), 1);
  const angles = labels.map((_, index) => index * 360 / labels.length);
  return (
    <ResponsiveSvg>
      {(W, H) => {
        // Phase-16.x — radar grows to the shorter side of the tile, centred.
        const cx = W / 2;
        const cy = H / 2;
        const radius = Math.max(24, Math.min(W, H) / 2 - 44);
        return (
          <>
            {[0.25, 0.5, 0.75, 1].map((scale) => (
              <polygon key={scale} points={angles.map((angle) => {
                const p = polar(cx, cy, radius * scale, angle);
                return `${p.x},${p.y}`;
              }).join(' ')} fill="none" stroke="rgb(var(--border-line))" />
            ))}
            {angles.map((angle, index) => {
              const p = polar(cx, cy, radius + 20, angle);
              const axis = polar(cx, cy, radius, angle);
              return (
                <g key={labels[index]}>
                  <line x1={cx} y1={cy} x2={axis.x} y2={axis.y} stroke="rgb(var(--border-line))" />
                  <text x={p.x} y={p.y} fontSize={11} textAnchor="middle" fill="rgb(var(--text-secondary))">{labels[index].slice(0, 16)}</text>
                </g>
              );
            })}
            {series.map((item, index) => {
              const mKey = metricKey(item.metric);
              const points = item.values.map((value, valueIndex) => {
                const p = polar(cx, cy, radius * positiveShare(value, max), angles[valueIndex]);
                return `${p.x},${p.y}`;
              }).join(' ');
              const radarColor = resolveSliceColor(style, palette, mKey, index);
              const dlc = style.dataLabelConfig;
              const labelsEnabled = dlc?.enabled ?? style.showDataLabels ?? false;
              const override = dlc?.overrides?.[mKey];
              const fontColor = override?.fontColor ?? dlc?.fontColor ?? radarColor;
              const fontSize = override?.fontSize ?? dlc?.fontSize ?? 10;
              const fmt = override?.format ?? style.seriesFormats?.[mKey] ?? dlc?.format ?? style.numberFormat;
              const styleForLabel = fmt ? { ...style, numberFormat: fmt } : style;
              return (
                <g key={mKey}>
                  <polygon points={points} fill={radarColor} opacity={0.16} stroke={radarColor} strokeWidth={2} />
                  <text x={20} y={24 + index * 18} fontSize={11} fill={radarColor}>{metricLabel(item.metric)}</text>
                  {labelsEnabled && item.values.map((value, valueIndex) => {
                    const p = polar(cx, cy, radius * positiveShare(value, max), angles[valueIndex]);
                    return (
                      <text key={`${mKey}-${valueIndex}`} x={p.x} y={p.y - 4} fontSize={fontSize} textAnchor="middle" fill={fontColor} style={{ pointerEvents: 'none' }}>
                        {formatNumber(value, styleForLabel)}
                      </text>
                    );
                  })}
                  <title>{metricLabel(item.metric)}</title>
                </g>
              );
            })}
          </>
        );
      }}
    </ResponsiveSvg>
  );
}

function FunnelChartSvg({ items, style, palette, onSelect, highlightNames }: { items: NameValue[]; style: ChartStyleConfig; palette: string[]; onSelect?: (name: string) => void; highlightNames?: Set<string> | null }) {
  const { t } = useI18n();
  if (!items.length) return <EmptyAdvanced message={t('explore.advancedCharts.noFunnelStages')} />;
  const max = Math.max(...items.map((item) => item.value), 1);
  const dlc = style.dataLabelConfig;
  const labelsEnabled = dlc?.enabled ?? style.showDataLabels ?? true;
  return (
    <ResponsiveSvg>
      {(W, H) => {
        // Phase-16.x — stages stack to fill the tile height; widths scale to W.
        const padT = 36, padB = 18, gap = 8;
        const n = Math.max(items.length, 1);
        const h = Math.max(3, Math.min(72, (H - padT - padB) / n - gap));
        const cx = W / 2;
        const maxW = W * 0.78;
        return (
          <>
            {items.map((item, index) => {
              const topWidth = maxW * positiveShare(item.value, max);
              const next = items[index + 1]?.value ?? item.value * 0.82;
              const bottomWidth = maxW * positiveShare(next, max);
              const y = padT + index * (h + gap);
              const x1 = cx - topWidth / 2;
              const x2 = cx + topWidth / 2;
              const x3 = cx + bottomWidth / 2;
              const x4 = cx - bottomWidth / 2;
              const override = dlc?.overrides?.[item.name];
              const fontSize = override?.fontSize ?? dlc?.fontSize ?? 12;
              const fontColor = override?.fontColor ?? dlc?.fontColor ?? '#fff';
              const fmt = override?.format ?? style.seriesFormats?.[item.name] ?? dlc?.format ?? style.numberFormat;
              const styleForLabel = fmt ? { ...style, numberFormat: fmt } : style;
              const labelText = labelsEnabled
                ? (style.dataLabelTemplate
                    ? expandLabelTemplate({ template: style.dataLabelTemplate, formatted: formatNumber(item.value, styleForLabel), rawName: item.name, percent: item.value / max })
                    : `${item.name.slice(0, 28)} - ${formatNumber(item.value, styleForLabel)}`)
                : item.name.slice(0, 28);
              return (
                <g key={item.name} onClick={() => onSelect?.(item.name)} className="cursor-pointer">
                  <path d={`M ${x1} ${y} L ${x2} ${y} L ${x3} ${y + h} L ${x4} ${y + h} Z`} fill={resolveSliceColor(style, palette, item.name, index)} opacity={highlightNames ? (highlightNames.has(item.name) ? 1 : 0.25) : 0.9} />
                  <text x={cx} y={y + h / 2 + 4} fontSize={fontSize} textAnchor="middle" fill={fontColor}>{labelText}</text>
                  <title>{item.name}: {formatNumber(item.value, styleForLabel)}</title>
                </g>
              );
            })}
          </>
        );
      }}
    </ResponsiveSvg>
  );
}

/**
 * Pick the effective NumberFormat for a no-dimension metric chart
 * (GAUGE / BULLET — mirrors the same precedence Podium/KPI use in
 * ExploreChart.tsx). DataLabel-level format wins over seriesFormats
 * which wins over the chart-wide numberFormat. Returns a derived style
 * so the existing `formatNumber(value, style)` call sites stay untouched.
 */
function styleWithEffectiveNumberFormat(
  style: ChartStyleConfig,
  seriesKey: string | undefined,
): ChartStyleConfig {
  const dlc = style.dataLabelConfig;
  const dataLabelFormat = (seriesKey && dlc?.overrides?.[seriesKey]?.format) ?? dlc?.format;
  const perSeriesFormat = seriesKey ? style.seriesFormats?.[seriesKey] : undefined;
  const effective = dataLabelFormat ?? perSeriesFormat ?? style.numberFormat;
  return effective ? { ...style, numberFormat: effective } : style;
}

function GaugeChartSvg({ value, target, style, palette, seriesKey }: { value: number; target: number; style: ChartStyleConfig; palette: string[]; seriesKey?: string }) {
  const { t } = useI18n();
  const arcColor = (seriesKey && style.seriesColors?.[seriesKey]) ?? palette[0];
  const hasTarget = target > 0;
  const scaleMax = hasTarget ? target : Math.max(value * 2, 1);
  const pct = Math.max(0, Math.min(value / scaleMax, 1));
  const start = -115;
  const end = 115;
  const valueEnd = start + (end - start) * pct;
  const labelStyle = styleWithEffectiveNumberFormat(style, seriesKey);
  return (
    <ResponsiveSvg>
      {(W, H) => {
        // Phase-16.x — gauge scales with the tile; needle + value text below.
        const r = Math.max(28, Math.min(W * 0.4, H * 0.46));
        const cx = W / 2;
        const cy = Math.min(H * 0.62, H - r * 0.5 - 10);
        const arc = (rr: number, a0: number, a1: number) => {
          const p0 = polar(cx, cy, rr, a0);
          const p1 = polar(cx, cy, rr, a1);
          return `M ${p0.x} ${p0.y} A ${rr} ${rr} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${p1.x} ${p1.y}`;
        };
        const needle = polar(cx, cy, r * 0.75, valueEnd);
        const stroke = Math.max(10, r * 0.22);
        const valFont = Math.max(16, Math.min(40, r * 0.24));
        return (
          <>
            <path d={arc(r, start, end)} fill="none" stroke="rgb(var(--surface-3))" strokeWidth={stroke} strokeLinecap="round" />
            <path d={arc(r, start, valueEnd)} fill="none" stroke={arcColor} strokeWidth={stroke} strokeLinecap="round" />
            <line x1={cx} y1={cy} x2={needle.x} y2={needle.y} stroke="rgb(var(--text-primary))" strokeWidth={4} strokeLinecap="round" />
            <circle cx={cx} cy={cy} r={8} fill="rgb(var(--text-primary))" />
            <text x={cx} y={cy + r * 0.46} fontSize={valFont} fontWeight={700} textAnchor="middle" fill="rgb(var(--text-primary))">{formatNumber(value, labelStyle)}</text>
            <text x={cx} y={cy + r * 0.46 + 22} fontSize={12} textAnchor="middle" fill="rgb(var(--text-tertiary))">{hasTarget ? t('explore.advancedCharts.targetValue', { value: formatNumber(target, labelStyle) }) : t('explore.advancedCharts.noTargetSet')}</text>
          </>
        );
      }}
    </ResponsiveSvg>
  );
}

function BulletChartSvg({ value, target, style, palette, seriesKey }: { value: number; target: number; style: ChartStyleConfig; palette: string[]; seriesKey?: string }) {
  const { t } = useI18n();
  const hasTarget = target > 0;
  const max = (hasTarget ? Math.max(value, target) : value * 1.25) || 1;
  const barColor = (seriesKey && style.seriesColors?.[seriesKey]) ?? palette[0];
  const labelStyle = styleWithEffectiveNumberFormat(style, seriesKey);
  return (
    <ResponsiveSvg>
      {(W, H) => {
        // Phase-16.x — value bar fills the tile width; centred vertically.
        const padX = Math.min(120, Math.max(24, W * 0.1));
        const barX = padX;
        const barW = Math.max(20, W - 2 * padX);
        const barH = Math.max(26, Math.min(84, H * 0.3));
        const barY = H / 2 - barH / 2;
        const valueWidth = barW * Math.max(0, value / max);
        const targetX = barX + barW * Math.max(0, target / max);
        const valFont = Math.max(18, Math.min(36, H * 0.13));
        return (
          <>
            <rect x={barX} y={barY} width={barW} height={barH} rx={8} fill="rgb(var(--surface-3))" />
            <rect x={barX} y={barY} width={valueWidth} height={barH} rx={8} fill={barColor} />
            {hasTarget && <line x1={targetX} y1={barY - 18} x2={targetX} y2={barY + barH + 18} stroke="rgb(var(--text-primary))" strokeWidth={4} />}
            <text x={barX} y={barY + barH + 22} fontSize={13} fill="rgb(var(--text-tertiary))">0</text>
            <text x={barX + barW} y={barY + barH + 22} fontSize={13} textAnchor="end" fill="rgb(var(--text-tertiary))">{formatNumber(max, labelStyle)}</text>
            <text x={W / 2} y={barY - 22} fontSize={valFont} textAnchor="middle" fontWeight={700} fill="rgb(var(--text-primary))">{formatNumber(value, labelStyle)}</text>
            <text x={W / 2} y={barY - 6} fontSize={12} textAnchor="middle" fill="rgb(var(--text-tertiary))">{hasTarget ? t('explore.advancedCharts.targetValue', { value: formatNumber(target, labelStyle) }) : t('explore.advancedCharts.noTargetSet')}</text>
          </>
        );
      }}
    </ResponsiveSvg>
  );
}

function TreemapChart({ items, style, palette, onSelect, highlightNames }: { items: NameValue[]; style: ChartStyleConfig; palette: string[]; onSelect?: (name: string) => void; highlightNames?: Set<string> | null }) {
  const { t } = useI18n();
  if (!items.length) return <EmptyAdvanced message={t('explore.advancedCharts.noCategories')} />;
  const total = items.reduce((sum, item) => sum + Math.max(item.value, 0), 0) || 1;
  const dlc = style.dataLabelConfig;
  const labelsEnabled = dlc?.enabled ?? style.showDataLabels ?? true;
  const sorted = [...items].sort((a, b) => Math.max(b.value, 0) - Math.max(a.value, 0));
  return (
    <ResponsiveSvg>
      {(W, H) => {
        // Phase-16.x — row-strip treemap that ALWAYS fits the tile: rows split
        // the height by value share, cells split each row's width by share, so
        // total height === tile height (no overflow / clipping, no big gaps).
        const pad = 6;
        const innerW = Math.max(10, W - pad * 2);
        const innerH = Math.max(10, H - pad * 2);
        const perRow = Math.max(1, Math.round(Math.sqrt(sorted.length)));
        const rows: NameValue[][] = [];
        for (let i = 0; i < sorted.length; i += perRow) rows.push(sorted.slice(i, i + perRow));
        const cells: Array<{ item: NameValue; x: number; y: number; w: number; h: number; index: number }> = [];
        let y = pad;
        let gi = 0;
        for (const row of rows) {
          const rowSum = row.reduce((s, it) => s + Math.max(it.value, 0), 0) || 1;
          const rowH = innerH * (rowSum / total);
          let x = pad;
          for (const it of row) {
            const cw = innerW * (Math.max(it.value, 0) / rowSum);
            cells.push({ item: it, x, y, w: Math.max(1, cw - 3), h: Math.max(1, rowH - 3), index: gi++ });
            x += cw;
          }
          y += rowH;
        }
        return (
          <>
            {cells.map(({ item, x, y, w, h, index }) => {
              const override = dlc?.overrides?.[item.name];
              const nameFontSize = override?.fontSize ?? dlc?.fontSize ?? 12;
              const valueFontSize = Math.max((override?.fontSize ?? dlc?.fontSize ?? 12) - 1, 9);
              const fontColor = override?.fontColor ?? dlc?.fontColor ?? '#fff';
              const fmt = override?.format ?? style.seriesFormats?.[item.name] ?? dlc?.format ?? style.numberFormat;
              const styleForLabel = fmt ? { ...style, numberFormat: fmt } : style;
              const valueLabel = style.dataLabelTemplate
                ? expandLabelTemplate({ template: style.dataLabelTemplate, formatted: formatNumber(item.value, styleForLabel), rawName: item.name, percent: item.value / total })
                : formatNumber(item.value, styleForLabel);
              const showName = w >= 44 && h >= 22;
              const showVal = labelsEnabled && w >= 50 && h >= 38;
              return (
                <g key={item.name} onClick={() => onSelect?.(item.name)} className="cursor-pointer">
                  <rect x={x} y={y} width={w} height={h} rx={6} fill={resolveSliceColor(style, palette, item.name, index)} opacity={highlightNames ? (highlightNames.has(item.name) ? 1 : 0.25) : 0.88} />
                  {showName && <text x={x + 8} y={y + 18} fontSize={nameFontSize} fontWeight={600} fill={fontColor}>{item.name.slice(0, 22)}</text>}
                  {showVal && <text x={x + 8} y={y + 34} fontSize={valueFontSize} fill={fontColor}>{valueLabel}</text>}
                  <title>{item.name}: {formatNumber(item.value, styleForLabel)}</title>
                </g>
              );
            })}
          </>
        );
      }}
    </ResponsiveSvg>
  );
}

function WaterfallChartSvg({ items, style, palette, onSelect }: { items: NameValue[]; style: ChartStyleConfig; palette: string[]; onSelect?: (name: string) => void }) {
  const { t } = useI18n();
  if (!items.length) return <EmptyAdvanced message={t('explore.advancedCharts.noCategories')} />;
  const steps = items.slice(0, 24);
  let cumulative = 0;
  const bars = steps.map((item) => {
    const start = cumulative;
    cumulative += item.value;
    return { ...item, start, end: cumulative };
  });
  const min = Math.min(0, ...bars.flatMap((bar) => [bar.start, bar.end]));
  const max = Math.max(0, ...bars.flatMap((bar) => [bar.start, bar.end]));
  // Phase-15.86 — WATERFALL DataLabels master switch + format precedence.
  const dlc = style.dataLabelConfig;
  const labelsEnabled = dlc?.enabled ?? style.showDataLabels ?? false;
  return (
    <ResponsiveSvg>
      {(W, H) => {
        // Phase-16.x — bars fill the tile width; value axis fills the height.
        const padL = 58, padR = 36, padT = 22, padB = 58;
        const plotTop = padT;
        const plotBottom = Math.max(plotTop + 10, H - padB);
        const plotH = plotBottom - plotTop;
        const scaleY = (value: number) => plotBottom - ((value - min) / Math.max(max - min, 1)) * plotH;
        const gap = 8;
        const barW = Math.max(8, Math.max(10, W - padL - padR) / Math.max(bars.length, 1) - gap);
        const labelY = H - 18;
        return (
          <>
            <line x1={padL - 10} y1={scaleY(0)} x2={W - padR + 10} y2={scaleY(0)} stroke="rgb(var(--border-line))" />
            {bars.map((bar, index) => {
        const x = padL + index * (barW + gap);
        const y1 = scaleY(bar.start);
        const y2 = scaleY(bar.end);
        const y = Math.min(y1, y2);
        const h = Math.max(2, Math.abs(y2 - y1));
        // Phase-15.86 — explicit user override beats sign-based fallback.
        // Previously WATERFALL hardcoded palette[0]/palette[3] by sign and
        // ignored seriesColors entirely. Now: user-picked color > sign-
        // based default. Lets DA recolour individual steps (eg. "Refunds"
        // bar to amber) without losing the positive/negative semantics
        // for un-customised bars.
        const userColor = style.seriesColors?.[bar.name];
        const signColor = bar.value >= 0 ? palette[0] : (palette[3] ?? '#ef4444');
        const color = userColor ?? signColor;
        const override = dlc?.overrides?.[bar.name];
        const labelFontSize = override?.fontSize ?? dlc?.fontSize ?? 10;
        const labelColor = override?.fontColor ?? dlc?.fontColor ?? 'rgb(var(--text-secondary))';
        const fmt = override?.format ?? style.seriesFormats?.[bar.name] ?? dlc?.format ?? style.numberFormat;
        const styleForLabel = fmt ? { ...style, numberFormat: fmt } : style;
        const labelText = style.dataLabelTemplate
          ? expandLabelTemplate({
              template: style.dataLabelTemplate,
              formatted: formatNumber(bar.value, styleForLabel),
              rawName: bar.name,
            })
          : formatNumber(bar.value, styleForLabel);
        return (
          <g key={bar.name} onClick={() => onSelect?.(bar.name)} className="cursor-pointer">
            <rect x={x} y={y} width={barW} height={h} rx={4} fill={color} />
            {labelsEnabled && (
              <text x={x + barW / 2} y={Math.max(14, y - 6)} fontSize={labelFontSize} textAnchor="middle" fill={labelColor}>
                {labelText}
              </text>
            )}
            <text x={x + barW / 2} y={labelY} fontSize={10} textAnchor="end" transform={`rotate(-35 ${x + barW / 2} ${labelY})`} fill="rgb(var(--text-tertiary))">{bar.name.slice(0, 12)}</text>
            <title>{bar.name}: {formatNumber(bar.value, styleForLabel)}</title>
          </g>
        );
            })}
          </>
        );
      }}
    </ResponsiveSvg>
  );
}

function XYBubbleChart({ rows, type, roleConfig, metric, style, palette, preAggregated, onSelect, labelMap }: {
  rows: ChartRow[];
  type: string;
  roleConfig: ExploreChartModel['roleConfig'];
  metric?: MetricConfig;
  style: ChartStyleConfig;
  palette: string[];
  preAggregated?: boolean;
  onSelect?: (field: string, value: unknown) => void;
  labelMap?: import('./ExploreChartConfig').SemanticLabelMap;
}) {
  const { t } = useI18n();
  const { scatterX, scatterY, dimension } = roleConfig;
  if (!scatterX || !scatterY) return <EmptyAdvanced message={t('explore.advancedCharts.selectXY')} />;
  const points = rows
    .map((row) => ({
      x: Number(row[scatterX]),
      y: Number(row[scatterY]),
      r: metric ? Math.abs(metricValue(row, metric, preAggregated)) : 1,
      label: dimension ? row[dimension] : undefined,
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .slice(0, 1000);
  if (!points.length) return <EmptyAdvanced message={t('explore.advancedCharts.noCoordinateRows')} />;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const rs = points.map((point) => point.r);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const maxR = Math.max(...rs, 1);
  // MAP_POINT geographic projection: when the X/Y fields are longitude/latitude
  // (by name), place points at their TRUE position via an equirectangular
  // projection (fixed -180..180 / -90..90) instead of stretching the data
  // min/max to fill the box — so a point at (lng=105, lat=21) lands where
  // Hanoi actually is. Name-based only (no value-range guess) so a non-geo
  // MAP_POINT never gets silently mis-projected. BUBBLE always uses data scale.
  const isGeoProjected = type === 'MAP_POINT'
    && /\b(lon|lng|long|longitude)\b/i.test(scatterX)
    && /\b(lat|latitude)\b/i.test(scatterY);
  // Phase-15.86 — BUBBLE/MAP_POINT DataLabels. Master switch shows the
  // dimension label next to each point. fontSize/fontColor per-point
  // override (keyed by label).
  const dlc = style.dataLabelConfig;
  const labelsEnabled = dlc?.enabled ?? style.showDataLabels ?? false;
  return (
    <ResponsiveSvg>
      {(W, H) => {
        // Plot rect derived from the live tile size so the scatter/bubble
        // field fills the tile (Phase-16.x responsive rewrite).
        const padL = 58, padR = 28, padT = 28, padB = 46;
        const fx0 = padL, fy0 = padT;
        const plotW = Math.max(10, W - padL - padR);
        const plotH = Math.max(10, H - padT - padB);
        const fy1 = fy0 + plotH;
        const sx = isGeoProjected
          ? (value: number) => fx0 + ((value + 180) / 360) * plotW
          : (value: number) => fx0 + ((value - minX) / Math.max(maxX - minX, 1)) * plotW;
        const sy = isGeoProjected
          ? (value: number) => fy1 - ((value + 90) / 180) * plotH
          : (value: number) => fy1 - ((value - minY) / Math.max(maxY - minY, 1)) * plotH;
        // Bubble radius scales with the plot so big tiles get bigger bubbles.
        const rMax = Math.max(8, Math.min(34, Math.min(plotW, plotH) * 0.14));
        const sr = (value: number) => type === 'BUBBLE' || type === 'MAP_POINT' ? 4 + safeSqrtShare(value, maxR) * rMax : 5;
        return (
          <>
            <rect x={fx0} y={fy0} width={plotW} height={plotH} fill={type === 'MAP_POINT' ? 'rgb(var(--surface-2))' : 'transparent'} stroke="rgb(var(--border-line))" rx={10} />
            <text x={fx0 + 6} y={H - 14} fontSize={11} fill="rgb(var(--text-tertiary))">{fieldLabel(scatterX, labelMap)}</text>
            <text x={18} y={fy0 + 18} fontSize={11} fill="rgb(var(--text-tertiary))" transform={`rotate(-90 18 ${fy0 + 18})`}>{fieldLabel(scatterY, labelMap)}</text>
            {points.map((point, index) => {
              const pointKey = String(point.label ?? index);
              const override = dlc?.overrides?.[pointKey];
              const labelFontSize = override?.fontSize ?? dlc?.fontSize ?? 10;
              const labelFontColor = override?.fontColor ?? dlc?.fontColor ?? 'rgb(var(--text-tertiary))';
              return (
                <g key={`${point.x}-${point.y}-${index}`} onClick={() => dimension && onSelect?.(dimension, point.label)} className="cursor-pointer">
                  <circle cx={sx(point.x)} cy={sy(point.y)} r={sr(point.r)} fill={resolveSliceColor(style, palette, pointKey, index)} opacity={0.68} stroke="rgb(var(--surface-1))" />
                  {labelsEnabled && point.label !== undefined && (
                    <text x={sx(point.x)} y={sy(point.y) - sr(point.r) - 4}
                      fontSize={labelFontSize}
                      textAnchor="middle"
                      fill={labelFontColor}
                      style={{ pointerEvents: 'none' }}>
                      {String(point.label).slice(0, 16)}
                    </text>
                  )}
                  <title>{point.label ? `${point.label}: ` : ''}{scatterX} {formatNumber(point.x, style)}, {scatterY} {formatNumber(point.y, style)}</title>
                </g>
              );
            })}
          </>
        );
      }}
    </ResponsiveSvg>
  );
}

function HeatmapChart({ pairs, style, palette, onSelect }: { pairs: PairValue[]; style: ChartStyleConfig; palette: string[]; onSelect?: (source: string) => void }) {
  const { t } = useI18n();
  if (!pairs.length) return <EmptyAdvanced message={t('explore.advancedCharts.selectRowColValue')} />;
  const sources = Array.from(new Set(pairs.map((pair) => pair.source))).slice(0, 18);
  const targets = Array.from(new Set(pairs.map((pair) => pair.target))).slice(0, 14);
  const max = Math.max(...pairs.map((pair) => Math.abs(pair.value)), 1);
  const gradientBase = style.seriesColors?.['__heatmap__']
    ?? (targets[0] && style.seriesColors?.[targets[0]])
    ?? palette[0];
  const dlc = style.dataLabelConfig;
  const labelsEnabled = dlc?.enabled ?? style.showDataLabels ?? false;
  const dlFontSize = dlc?.fontSize ?? 10;
  const dlFontColor = dlc?.fontColor ?? 'rgb(var(--text-primary))';
  const dlFormat = dlc?.format ?? style.numberFormat;
  const styleForLabel = dlFormat ? { ...style, numberFormat: dlFormat } : style;
  const valueMap = new Map(pairs.map((pair) => [JSON.stringify([pair.source, pair.target]), pair.value]));
  return (
    <ResponsiveSvg>
      {(W, H) => {
        // Phase-16.x — grid fills the tile (minus label gutters) at the live size.
        const gutterL = Math.min(150, Math.max(64, W * 0.16));
        const gutterT = 44;
        const padR = 14, padB = 12;
        const gridW = Math.max(10, W - gutterL - padR);
        const gridH = Math.max(10, H - gutterT - padB);
        const cellW = gridW / Math.max(targets.length, 1);
        const cellH = gridH / Math.max(sources.length, 1);
        const gx = gutterL, gy = gutterT;
        return (
          <>
            {sources.map((source, row) => (
              <text key={source} x={gx - 8} y={gy + row * cellH + cellH / 2 + 3} textAnchor="end" fontSize={10} fill="rgb(var(--text-tertiary))">{source.slice(0, 18)}</text>
            ))}
            {targets.map((target, col) => (
              <text key={target} x={gx + col * cellW + cellW / 2} y={gy - 10} textAnchor="middle" fontSize={10} fill="rgb(var(--text-tertiary))">{target.slice(0, 10)}</text>
            ))}
            {sources.map((source, row) => targets.map((target, col) => {
              const value = valueMap.get(JSON.stringify([source, target])) ?? 0;
              const opacity = value !== 0 ? 0.12 + (Math.abs(value) / max) * 0.84 : 0.05;
              return (
                <g key={`${source}-${target}`} onClick={() => onSelect?.(source)} className="cursor-pointer">
                  <rect x={gx + col * cellW} y={gy + row * cellH} width={Math.max(cellW - 2, 1)} height={Math.max(cellH - 2, 1)} rx={3} fill={gradientBase} opacity={opacity} />
                  {labelsEnabled && cellW >= 42 && cellH >= 20 && value !== 0 && (
                    <text x={gx + col * cellW + cellW / 2} y={gy + row * cellH + cellH / 2 + 4} textAnchor="middle" fontSize={dlFontSize} fill={dlFontColor}>
                      {style.dataLabelTemplate
                        ? expandLabelTemplate({ template: style.dataLabelTemplate, formatted: formatNumber(value, styleForLabel), rawName: `${source}/${target}` })
                        : formatNumber(value, styleForLabel)}
                    </text>
                  )}
                  <title>{source} / {target}: {formatNumber(value, styleForLabel)}</title>
                </g>
              );
            }))}
          </>
        );
      }}
    </ResponsiveSvg>
  );
}

function RegionChart({ items, style, palette, onSelect }: { items: NameValue[]; style: ChartStyleConfig; palette: string[]; onSelect?: (name: string) => void }) {
  const max = Math.max(...items.map((item) => item.value), 1);
  // Phase-15.86 — DataLabels master switch hides the value column.
  // The region name stays visible (identifier). Per-region format
  // precedence honoured.
  const dlc = style.dataLabelConfig;
  const labelsEnabled = dlc?.enabled ?? style.showDataLabels ?? true;
  return (
    <div className="h-full overflow-auto p-4">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {items.map((item, index) => {
          const override = dlc?.overrides?.[item.name];
          const fmt = override?.format ?? style.seriesFormats?.[item.name] ?? dlc?.format ?? style.numberFormat;
          const styleForLabel = fmt ? { ...style, numberFormat: fmt } : style;
          return (
            <button key={item.name} onClick={() => onSelect?.(item.name)}
              className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3 text-left hover:bg-surface-2">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate text-sm font-medium text-text-secondary">{item.name}</span>
                {labelsEnabled && (
                  <span className="text-sm font-semibold text-text-primary"
                    style={override?.fontColor ? { color: override.fontColor } : undefined}>
                    {formatNumber(item.value, styleForLabel)}
                  </span>
                )}
              </div>
              {/* Choropleth semantics: a region map encodes value as colour
                  INTENSITY (one hue, darker = higher), not a categorical
                  per-region colour. Ramp the bar opacity by value share so the
                  card reads as a region-intensity view even without map
                  boundaries (a literal boundary choropleth needs a geo topology
                  dependency we don't bundle). */}
              <div className="mt-2 h-2 rounded-full bg-surface-3">
                <div className="h-2 rounded-full"
                  style={{
                    width: `${Math.max(3, positiveShare(item.value, max) * 100)}%`,
                    backgroundColor: palette[0] ?? resolveSliceColor(style, palette, item.name, index),
                    opacity: 0.3 + positiveShare(item.value, max) * 0.7,
                  }} />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BoxplotChart({ rows, field, metric, style, palette, onSelect }: { rows: ChartRow[]; field?: string; metric?: MetricConfig; style: ChartStyleConfig; palette: string[]; onSelect?: (name: string) => void }) {
  const { t } = useI18n();
  if (!field || !metric) return <EmptyAdvanced message={t('explore.advancedCharts.selectCategoryValue')} />;
  const grouped = new Map<string, number[]>();
  for (const row of rows) {
    const key = String(row[field] ?? '(blank)');
    const value = metricValueForRawDistribution(row, metric);
    if (!Number.isFinite(value)) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(value);
  }
  const quantile = (values: number[], q: number) => values[Math.floor((values.length - 1) * q)] ?? 0;
  // Proper Tukey boxplot: whiskers extend to the most extreme value still
  // within Q1-1.5·IQR / Q3+1.5·IQR; values beyond the fences are OUTLIERS,
  // drawn as separate dots (not as whisker ends). This is the statistically
  // correct definition and means a lone 10M row no longer stretches the box —
  // it shows up as an outlier dot while the box reflects the real spread.
  const stats = Array.from(grouped.entries()).slice(0, 18).map(([name, raw]) => {
    const values = [...raw].sort((a, b) => a - b);
    const q1 = quantile(values, 0.25);
    const med = quantile(values, 0.5);
    const q3 = quantile(values, 0.75);
    const iqr = q3 - q1;
    const lowerFence = q1 - 1.5 * iqr;
    const upperFence = q3 + 1.5 * iqr;
    const inFence = values.filter((v) => v >= lowerFence && v <= upperFence);
    const whiskerLow = inFence.length ? inFence[0] : (values[0] ?? 0);
    const whiskerHigh = inFence.length ? inFence[inFence.length - 1] : (values[values.length - 1] ?? 0);
    const outliers = values.filter((v) => v < lowerFence || v > upperFence).slice(0, 50);
    return { name, q1, med, q3, whiskerLow, whiskerHigh, outliers };
  });
  if (!stats.length) return <EmptyAdvanced message={t('explore.advancedCharts.noDistributionRows')} />;
  // Default scale = the whisker range across all boxes so the boxes fill the
  // plot. Y Min/Y Max override when set (SVG `allowDataOverflow` equivalent:
  // values outside the range — incl. outlier dots — clamp to the plot edge).
  const whiskerMin = Math.min(...stats.map((item) => item.whiskerLow));
  const whiskerMax = Math.max(...stats.map((item) => item.whiskerHigh));
  const yMinSet = style.yAxisMin !== undefined && style.yAxisMin !== '' && Number.isFinite(Number(style.yAxisMin));
  const yMaxSet = style.yAxisMax !== undefined && style.yAxisMax !== '' && Number.isFinite(Number(style.yAxisMax));
  const min = yMinSet ? Number(style.yAxisMin) : whiskerMin;
  const max = yMaxSet ? Number(style.yAxisMax) : whiskerMax;
  return (
    <ResponsiveSvg>
      {(W, H) => {
        // Phase-16.x — box row fills the tile width; value axis fills the height.
        const padL = 56, padR = 20, padT = 28, padB = 64;
        const plotTop = padT;
        const plotBottom = Math.max(plotTop + 10, H - padB);
        const plotH = plotBottom - plotTop;
        const sy = (value: number) => {
          const raw = plotBottom - ((value - min) / Math.max(max - min, 1)) * plotH;
          return Math.max(plotTop, Math.min(plotBottom, raw));
        };
        const step = Math.max(10, W - padL - padR) / Math.max(stats.length, 1);
        const labelY = H - 16;
        return (
          <>
            {stats.map((item, index) => {
        const x = padL + index * step + step / 2;
        const boxW = Math.min(40, step * 0.55);
        const boxColor = resolveSliceColor(style, palette, item.name, index);
        // Phase-15.86 — BOXPLOT median value label (DataLabels enabled).
        const dlc = style.dataLabelConfig;
        const labelsEnabled = dlc?.enabled ?? style.showDataLabels ?? false;
        const override = dlc?.overrides?.[item.name];
        const labelFontSize = override?.fontSize ?? dlc?.fontSize ?? 9;
        const labelFontColor = override?.fontColor ?? dlc?.fontColor ?? 'rgb(var(--text-primary))';
        const fmt = override?.format ?? style.seriesFormats?.[item.name] ?? dlc?.format ?? style.numberFormat;
        const styleForLabel = fmt ? { ...style, numberFormat: fmt } : style;
        return (
          <g key={item.name} onClick={() => onSelect?.(item.name)} className="cursor-pointer">
            {/* Tukey whisker (within 1.5·IQR) with end caps */}
            <line x1={x} x2={x} y1={sy(item.whiskerLow)} y2={sy(item.whiskerHigh)} stroke="rgb(var(--text-tertiary))" />
            <line x1={x - boxW / 4} x2={x + boxW / 4} y1={sy(item.whiskerHigh)} y2={sy(item.whiskerHigh)} stroke="rgb(var(--text-tertiary))" />
            <line x1={x - boxW / 4} x2={x + boxW / 4} y1={sy(item.whiskerLow)} y2={sy(item.whiskerLow)} stroke="rgb(var(--text-tertiary))" />
            <rect x={x - boxW / 2} y={sy(item.q3)} width={boxW} height={Math.max(2, sy(item.q1) - sy(item.q3))} rx={3} fill={boxColor} opacity={0.35} stroke={boxColor} />
            <line x1={x - boxW / 2} x2={x + boxW / 2} y1={sy(item.med)} y2={sy(item.med)} stroke="rgb(var(--text-primary))" strokeWidth={2} />
            {/* outliers beyond the fences — dots (clamped to the plot edge) */}
            {item.outliers.map((ov, oi) => (
              <circle key={oi} cx={x} cy={sy(ov)} r={2.5} fill={boxColor} opacity={0.75}>
                <title>{`${item.name} · outlier ${formatNumber(ov, styleForLabel)}`}</title>
              </circle>
            ))}
            {labelsEnabled && (
              <text x={x + boxW / 2 + 4} y={sy(item.med) + 3} fontSize={labelFontSize} fill={labelFontColor}>
                {formatNumber(item.med, styleForLabel)}
              </text>
            )}
            <text x={x} y={labelY} fontSize={10} textAnchor="end" transform={`rotate(-35 ${x} ${labelY})`} fill="rgb(var(--text-tertiary))">{item.name.slice(0, 12)}</text>
            <title>{item.name}: median {formatNumber(item.med, styleForLabel)}</title>
          </g>
        );
            })}
          </>
        );
      }}
    </ResponsiveSvg>
  );
}

function SankeyChart({ pairs, style, palette, onSelect }: { pairs: PairValue[]; style: ChartStyleConfig; palette: string[]; onSelect?: (source: string) => void }) {
  const { t } = useI18n();
  const flows = applyLimit(pairs, style, 18);
  if (!flows.length) return <EmptyAdvanced message={t('explore.advancedCharts.selectSourceTargetValue')} />;
  const sources = Array.from(new Set(flows.map((flow) => flow.source)));
  const targets = Array.from(new Set(flows.map((flow) => flow.target)));
  const max = Math.max(...flows.map((flow) => flow.value), 1);
  const dlc = style.dataLabelConfig;
  const labelsEnabled = dlc?.enabled ?? style.showDataLabels ?? false;
  const dlFontSize = dlc?.fontSize ?? 10;
  const dlFontColor = dlc?.fontColor ?? 'rgb(var(--text-secondary))';
  const dlFormat = dlc?.format ?? style.numberFormat;
  const styleForLabel = dlFormat ? { ...style, numberFormat: dlFormat } : style;
  return (
    <ResponsiveSvg>
      {(W, H) => {
        // Phase-16.x — node columns span the tile width; rows fill the height.
        const padT = 40, padB = 40;
        const nodeW = Math.min(140, Math.max(70, W * 0.17));
        const leftX = 10;
        const rightX = W - nodeW - 10;
        const srcRightX = leftX + nodeW;
        const c1 = srcRightX + (rightX - srcRightX) * 0.35;
        const c2 = srcRightX + (rightX - srcRightX) * 0.65;
        const midX = (srcRightX + rightX) / 2;
        const maxStroke = Math.max(10, Math.min(36, (H - padT - padB) / Math.max(sources.length, targets.length, 1) * 0.55));
        const yFor = (items: string[], name: string) => padT + Math.max(0, items.indexOf(name)) * ((H - padT - padB) / Math.max(items.length - 1, 1));
        return (
          <>
            {flows.map((flow, index) => {
              const y1 = yFor(sources, flow.source);
              const y2 = yFor(targets, flow.target);
              const width = 2 + positiveShare(flow.value, max) * maxStroke;
              const midY = (y1 + y2) / 2;
              const flowOverride = dlc?.overrides?.[flow.source];
              const flowFontColor = flowOverride?.fontColor ?? dlFontColor;
              const flowFontSize = flowOverride?.fontSize ?? dlFontSize;
              const flowFmt = flowOverride?.format ?? style.seriesFormats?.[flow.source] ?? dlFormat;
              const flowStyle = flowFmt ? { ...style, numberFormat: flowFmt } : styleForLabel;
              return (
                <g key={`${flow.source}-${flow.target}-${index}`}>
                  <path d={`M ${srcRightX} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${rightX} ${y2}`}
                    fill="none" stroke={resolveSliceColor(style, palette, flow.source, index)} strokeWidth={width} opacity={0.38}
                    onClick={() => onSelect?.(flow.source)} className="cursor-pointer">
                    <title>{flow.source}{' -> '}{flow.target}: {formatNumber(flow.value, flowStyle)}</title>
                  </path>
                  {labelsEnabled && (
                    <text x={midX} y={midY - 4} fontSize={flowFontSize} textAnchor="middle" fill={flowFontColor} style={{ pointerEvents: 'none' }}>
                      {formatNumber(flow.value, flowStyle)}
                    </text>
                  )}
                </g>
              );
            })}
            {sources.map((source, index) => (
              <g key={source} onClick={() => onSelect?.(source)} className="cursor-pointer">
                <rect x={leftX} y={yFor(sources, source) - 13} width={nodeW} height={26} rx={6} fill={resolveSliceColor(style, palette, source, index)} opacity={0.85} />
                <text x={leftX + nodeW / 2} y={yFor(sources, source) + 4} textAnchor="middle" fontSize={11} fill="#fff">{source.slice(0, 18)}</text>
              </g>
            ))}
            {targets.map((target) => (
              <g key={target}>
                <rect x={rightX} y={yFor(targets, target) - 13} width={nodeW} height={26} rx={6} fill="rgb(var(--surface-3))" stroke="rgb(var(--border-line))" />
                <text x={rightX + nodeW / 2} y={yFor(targets, target) + 4} textAnchor="middle" fontSize={11} fill="rgb(var(--text-secondary))">{target.slice(0, 18)}</text>
              </g>
            ))}
          </>
        );
      }}
    </ResponsiveSvg>
  );
}

function SunburstChart({ pairs, style, palette, onSelect }: { pairs: PairValue[]; style: ChartStyleConfig; palette: string[]; onSelect?: (source: string) => void }) {
  const { t } = useI18n();
  if (!pairs.length) return <EmptyAdvanced message={t('explore.advancedCharts.selectHierarchyValue')} />;
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
  const dlc = style.dataLabelConfig;
  const labelsEnabled = dlc?.enabled ?? style.showDataLabels ?? false;
  const dlFontSize = dlc?.fontSize ?? 11;
  const dlFontColor = dlc?.fontColor ?? '#fff';
  return (
    <ResponsiveSvg>
      {(W, H) => {
        // Phase-16.x — sunburst rings grow to the shorter side (legend reserved).
        const legendW = Math.min(200, Math.max(118, W * 0.26));
        const areaW = Math.max(40, W - legendW);
        const cx = areaW / 2;
        const cy = H / 2;
        const R = Math.max(28, Math.min(areaW, H) / 2 - 12);
        const r1in = R * 0.25, r1out = R * 0.55, r2in = R * 0.57, r2out = R;
        const labelR = R * 0.4;
        const sourceAngles = new Map<string, { start: number; end: number }>();
        let cursor = 0;
        return (
          <>
            {inner.map((item, index) => {
              const angle = (item.value / total) * 360;
              const start = cursor;
              const end = cursor + angle;
              sourceAngles.set(item.name, { start, end });
              cursor = end;
              const sharePct = item.value / total;
              const mid = (start + end) / 2;
              const labelPos = polar(cx, cy, labelR, mid);
              const override = dlc?.overrides?.[item.name];
              const fontColor = override?.fontColor ?? dlFontColor;
              const fontSize = override?.fontSize ?? dlFontSize;
              const fmt = override?.format ?? style.seriesFormats?.[item.name] ?? dlc?.format ?? style.numberFormat;
              const styleForLabel = fmt ? { ...style, numberFormat: fmt } : style;
              return (
                <g key={item.name}>
                  <path d={ringSegment(cx, cy, r1out, r1in, start, end)} fill={resolveSliceColor(style, palette, item.name, index)} opacity={0.86}
                    onClick={() => onSelect?.(item.name)} className="cursor-pointer">
                    <title>{item.name}: {formatNumber(item.value, styleForLabel)}</title>
                  </path>
                  {labelsEnabled && sharePct >= 0.05 && (
                    <text x={labelPos.x} y={labelPos.y} textAnchor="middle" fontSize={fontSize} fill={fontColor} style={{ pointerEvents: 'none' }}>
                      {style.dataLabelTemplate
                        ? expandLabelTemplate({ template: style.dataLabelTemplate, formatted: formatNumber(item.value, styleForLabel), rawName: item.name, percent: sharePct })
                        : formatNumber(item.value, styleForLabel)}
                    </text>
                  )}
                </g>
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
                <path key={`${pair.source}-${pair.target}-${index}`} d={ringSegment(cx, cy, r2out, r2in, start, end)} fill={resolveSliceColor(style, palette, pair.target, index)} opacity={0.62}>
                  <title>{pair.source} / {pair.target}: {formatNumber(pair.value, style)}</title>
                </path>
              );
            })}
            {inner.map((item, index) => {
              const sharePct = item.value / total;
              const label = item.name === '' || item.name == null ? '(blank)' : String(item.name).slice(0, 16);
              return (
                <g key={`sb-legend-${item.name}`} transform={`translate(${areaW + 8} ${16 + index * 20})`} className="cursor-pointer" onClick={() => onSelect?.(item.name)}>
                  <rect width={11} height={11} rx={2} fill={resolveSliceColor(style, palette, item.name, index)} />
                  <text x={17} y={10} fontSize={11} fill="rgb(var(--text-secondary))">
                    {`${label} · ${(sharePct * 100).toFixed(sharePct < 0.1 ? 1 : 0)}%`}
                  </text>
                </g>
              );
            })}
          </>
        );
      }}
    </ResponsiveSvg>
  );
}

function RibbonChart({ pairs, palette, style, onSelect }: { pairs: PairValue[]; palette: string[]; style: ChartStyleConfig; onSelect?: (source: string) => void }) {
  const { t } = useI18n();
  // RIBBON's X is the time field — the axis MUST be chronological. Sort by
  // parsed date (string fallback) BEFORE slicing so the rank-flow reads
  // left-to-right in time order.
  const times = Array.from(new Set(pairs.map((pair) => pair.source)))
    .sort((a, b) => {
      const ta = new Date(String(a)).getTime();
      const tb = new Date(String(b)).getTime();
      if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
      return String(a).localeCompare(String(b));
    })
    .slice(0, 20);
  const cats = Array.from(new Set(pairs.map((pair) => pair.target))).slice(0, 8);
  if (times.length < 2 || cats.length === 0) return <EmptyAdvanced message={t('explore.advancedCharts.selectTimeSeriesValue')} />;
  const valueMap = new Map(pairs.map((pair) => [JSON.stringify([pair.source, pair.target]), pair.value]));
  const rankByTime = new Map<string, Map<string, number>>();
  for (const time of times) {
    const ranked = cats
      .map((cat) => ({ cat, value: valueMap.get(JSON.stringify([time, cat])) ?? 0 }))
      .sort((a, b) => b.value - a.value);
    rankByTime.set(time, new Map(ranked.map((item, index) => [item.cat, index])));
  }
  const dlc = style.dataLabelConfig;
  const labelsEnabled = dlc?.enabled ?? style.showDataLabels ?? false;
  return (
    <ResponsiveSvg>
      {(W, H) => {
        // Phase-16.x — ribbon flow fills the tile at the live size.
        const padL = 60, padR = 86, padT = 40, padB = 58;
        const x = (index: number) => padL + index * ((W - padL - padR) / Math.max(times.length - 1, 1));
        const y = (rank: number) => padT + rank * ((H - padT - padB) / Math.max(cats.length - 1, 1));
        const labelY = H - 16;
        const ribbonW = Math.max(4, Math.min(14, (H - padT - padB) / Math.max(cats.length, 1) * 0.4));
        return (
          <>
            {cats.map((cat, catIndex) => {
              const d = times.map((time, timeIndex) => `${timeIndex === 0 ? 'M' : 'L'} ${x(timeIndex)} ${y(rankByTime.get(time)?.get(cat) ?? cats.length - 1)}`).join(' ');
              const catColor = resolveSliceColor(style, palette, cat, catIndex);
              const override = dlc?.overrides?.[cat];
              const labelFontSize = override?.fontSize ?? dlc?.fontSize ?? 10;
              const labelFontColor = override?.fontColor ?? dlc?.fontColor ?? catColor;
              const lastTime = times[times.length - 1];
              const lastRank = rankByTime.get(lastTime)?.get(cat) ?? cats.length - 1;
              return (
                <g key={cat}>
                  <path d={d} fill="none" stroke={catColor} strokeWidth={ribbonW} strokeLinecap="round" strokeLinejoin="round" opacity={0.72}
                    onClick={() => onSelect?.(cat)} className="cursor-pointer">
                    <title>{cat}</title>
                  </path>
                  {labelsEnabled && (
                    <text x={x(times.length - 1) + 8} y={y(lastRank) + 4} fontSize={labelFontSize} fill={labelFontColor} style={{ pointerEvents: 'none' }}>
                      {cat.slice(0, 18)}
                    </text>
                  )}
                </g>
              );
            })}
            {times.map((time, index) => (
              <text key={time} x={x(index)} y={labelY} fontSize={10} textAnchor="end" transform={`rotate(-35 ${x(index)} ${labelY})`} fill="rgb(var(--text-tertiary))">{time.slice(0, 12)}</text>
            ))}
          </>
        );
      }}
    </ResponsiveSvg>
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
  const { t } = useI18n();
  const { timeField, dimension } = roleConfig;
  if (!timeField || !dimension) return <EmptyAdvanced message={t('explore.advancedCharts.selectTimeAndLabel')} />;
  const events = rows
    .map((row) => ({ label: String(row[dimension] ?? t('explore.advancedCharts.eventFallback')), time: new Date(String(row[timeField] ?? '')).getTime(), value: metricValue(row, metric, preAggregated) }))
    .filter((event) => Number.isFinite(event.time))
    .sort((a, b) => a.time - b.time)
    .slice(0, 80);
  if (!events.length) return <EmptyAdvanced message={t('explore.advancedCharts.noTimelineRows')} />;
  const min = Math.min(...events.map((event) => event.time));
  const max = Math.max(...events.map((event) => event.time));
  const maxValue = Math.max(...events.map((event) => Math.abs(event.value)), 1);
  // Phase-15.86 — DataLabels master switch. Master defaults to true so
  // existing charts (where labels always rendered for first 18 events)
  // don't lose their identifiers; turning the switch off hides them.
  const dlc = style.dataLabelConfig;
  const labelsEnabled = dlc?.enabled ?? style.showDataLabels ?? true;
  return (
    <ResponsiveSvg>
      {(W, H) => {
        // Phase-16.x — timeline spans the tile width; events alternate above/
        // below a centred axis that scales with the tile height.
        const padL = 60, padR = 60;
        const axisY = H / 2;
        const off = Math.min(Math.max(H * 0.18, 40), 120);
        const x = (time: number) => padL + ((time - min) / Math.max(max - min, 1)) * Math.max(10, W - padL - padR);
        return (
          <>
            <line x1={padL} y1={axisY} x2={W - padR} y2={axisY} stroke="rgb(var(--border-line))" strokeWidth={2} />
            {events.map((event, index) => {
        const yy = index % 2 === 0 ? axisY - off : axisY + off;
        const r = metric ? 5 + Math.sqrt(Math.abs(event.value) / maxValue) * 12 : 7;
        // Phase-15.86 — per-event style override.
        const override = dlc?.overrides?.[event.label];
        const labelFontSize = override?.fontSize ?? dlc?.fontSize ?? 10;
        const labelFontColor = override?.fontColor ?? dlc?.fontColor ?? 'rgb(var(--text-tertiary))';
        const fmt = override?.format ?? style.seriesFormats?.[event.label] ?? dlc?.format ?? style.numberFormat;
        const styleForLabel = fmt ? { ...style, numberFormat: fmt } : style;
        return (
          <g key={`${event.label}-${event.time}-${index}`} onClick={() => onSelect?.(dimension, event.label)} className="cursor-pointer">
            <line x1={x(event.time)} y1={axisY} x2={x(event.time)} y2={yy} stroke="rgb(var(--border-line))" />
            <circle cx={x(event.time)} cy={yy} r={r} fill={resolveSliceColor(style, palette, event.label, index)} opacity={0.82} />
            {labelsEnabled && index < 18 && (
              <text x={x(event.time)} y={yy + (yy < axisY ? -14 : 24)} fontSize={labelFontSize} textAnchor="middle" fill={labelFontColor}>
                {event.label.slice(0, 14)}
              </text>
            )}
            <title>{event.label}: {new Date(event.time).toISOString().slice(0, 10)}{metric ? `, ${formatNumber(event.value, styleForLabel)}` : ''}</title>
          </g>
        );
            })}
          </>
        );
      }}
    </ResponsiveSvg>
  );
}

function WordCloudChart({ items, style, palette, onSelect }: { items: NameValue[]; style: ChartStyleConfig; palette: string[]; onSelect?: (name: string) => void }) {
  const max = Math.max(...items.map((item) => Math.abs(item.value)), 1);
  // Phase-15.86 — WORD_CLOUD: the words ARE the labels, so the
  // master switch doesn't hide them (that'd leave an empty cloud).
  // We honour fontSize/fontColor overrides per word, and per-word
  // format precedence flows into the hover title.
  const dlc = style.dataLabelConfig;
  return (
    <div className="flex h-full items-center justify-center overflow-hidden p-6">
      <div className="flex max-w-full flex-wrap items-center justify-center gap-x-5 gap-y-3">
        {items.map((item, index) => {
          const override = dlc?.overrides?.[item.name];
          const fontSize = override?.fontSize ?? (14 + safeSqrtShare(item.value, max) * 34);
          const fontColor = override?.fontColor ?? resolveSliceColor(style, palette, item.name, index);
          const fmt = override?.format ?? style.seriesFormats?.[item.name] ?? dlc?.format ?? style.numberFormat;
          const styleForLabel = fmt ? { ...style, numberFormat: fmt } : style;
          return (
            <button key={item.name} onClick={() => onSelect?.(item.name)}
              className="font-semibold leading-none hover:opacity-80"
              style={{
                color: fontColor,
                fontSize: typeof fontSize === 'number' ? `${fontSize}px` : fontSize,
              }}
              title={`${item.name}: ${formatNumber(item.value, styleForLabel)}`}>
              {item.name}
            </button>
          );
        })}
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
  highlightData,
  labelMap,
  formatMap,
}: AdvancedExploreChartProps) {
  const { t } = useI18n();
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
    // Return 0 (not the value itself) when NO target is configured. The
    // gauge/bullet renderers read `target > 0` to decide whether to draw a
    // target marker / "Target X" label and how to scale. Defaulting to the
    // value made every target-less gauge read as "goal met at 100%".
    return Number.isFinite(staticTarget) && staticTarget > 0 ? staticTarget : 0;
  }, [benchmarkMetric, data, preAggregated, style.benchmarkValue, style.kpiBenchmarkValue]);

  // Cross-highlight (source-dim): names present in the P-filtered subset stay
  // solid; the rest dim. null ⇒ no highlight (render unchanged).
  const HIGHLIGHT_DIM = 0.25;
  const highlightNames = useMemo<Set<string> | null>(() => {
    if (highlightData == null) return null;
    const grouped = groupByMetric(highlightData, dimension, primaryMetric, preAggregated);
    return new Set(grouped.map((g) => String(g.name)));
  }, [highlightData, dimension, primaryMetric, preAggregated]);
  // For MATRIX (a pivot table): dim rows whose dimension cells aren't in the
  // P subset. Key by all string (dimension) cells — same on both sides.
  const matrixRowDimKey = (row: Record<string, any>) =>
    Object.keys(row).filter((k) => typeof row[k] === 'string').sort().map((k) => `${k}=${row[k]}`).join('|');
  const matrixHighlightKeys = useMemo<Set<string> | null>(() => {
    if (highlightData == null) return null;
    const hm = buildExploreChartModel({ type: 'MATRIX', data: highlightData, roleConfig, havingFilters: havingFilters ?? [], preAggregated });
    return new Set((hm.tableData ?? []).map(matrixRowDimKey));
  }, [highlightData, roleConfig, havingFilters, preAggregated]);

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
          columnFormats={formatMap}
          highlightRowKeys={matrixHighlightKeys}
          rowDimKey={matrixRowDimKey}
          enableDrilldown={Boolean(onSelectDataPoint && dimension)}
          onRowClick={onSelectDataPoint && dimension ? (row) => emitDimension(row?.[dimension]) : undefined}
        />
      </ChartFrame>
    );
  }

  return (
    <ChartFrame title={title} titleFontSize={titleFontSize}>
      {type === 'DONUT' || type === 'POLAR_AREA' ? (
        <DonutOrPolarChart type={type} items={items} style={style} palette={palette} onSelect={emitDimension} highlightNames={highlightNames} />
      ) : type === 'RADAR' ? (
        <RadarChartSvg rows={data} metrics={roleConfig.metrics} field={dimension} palette={palette} style={style} preAggregated={preAggregated} />
      ) : type === 'FUNNEL' ? (
        <FunnelChartSvg items={items} style={style} palette={palette} onSelect={emitDimension} highlightNames={highlightNames} />
      ) : type === 'GAUGE' ? (
        <GaugeChartSvg value={totalValue} target={targetValue} style={style} palette={palette} seriesKey={primaryMetric ? metricKey(primaryMetric) : undefined} />
      ) : type === 'BULLET' ? (
        <BulletChartSvg value={totalValue} target={targetValue} style={style} palette={palette} seriesKey={primaryMetric ? metricKey(primaryMetric) : undefined} />
      ) : type === 'TREEMAP' ? (
        <TreemapChart items={items} style={style} palette={palette} onSelect={emitDimension} highlightNames={highlightNames} />
      ) : type === 'WATERFALL' ? (
        <WaterfallChartSvg items={items} style={style} palette={palette} onSelect={emitDimension} />
      ) : type === 'BUBBLE' || type === 'MAP_POINT' ? (
        <XYBubbleChart rows={data} type={type} roleConfig={roleConfig} metric={primaryMetric} style={style} palette={palette} preAggregated={preAggregated} onSelect={emitField} labelMap={labelMap} />
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
        <EmptyAdvanced message={t('explore.advancedCharts.unsupportedType')} />
      )}
    </ChartFrame>
  );
}
