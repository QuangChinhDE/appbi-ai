'use client';

import React, { useMemo } from 'react';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  ScatterChart,
  Scatter,
  PieChart,
  Pie,
  Cell,
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  ZAxis,
} from 'recharts';
import { ChartType } from '@/types/api';
import { TableVisualization } from '@/components/visualizations/TableVisualization';
import { KpiCard } from '@/components/visualizations/KpiCard';
import { getPalette, buildDimensionColorMap, ChartPaletteName, DEFAULT_CHART_THEME } from '@/lib/chartColors';
import { resolveBenchmarkLines, applyKpiBenchmarkCalc } from '@/lib/exploreAggregations';
import type { ChartStyleConfig, NumberFormat } from '@/components/explore/ExploreChartConfig';
import { normalizeChartStyleConfig } from '@/components/explore/ExploreChartConfig';
import type { ConditionalFormatRule, ChartSortRule, TimeGranularity } from '@/types/api';

function formatNumber(value: any, style: ChartStyleConfig | NumberFormat): string {
  const styleObj: ChartStyleConfig = typeof style === 'string' ? { numberFormat: style as NumberFormat } : style;
  const fmt = styleObj.numberFormat ?? 'compact';
  const dec = styleObj.decimalPlaces ?? 1;
  const sym = styleObj.currencySymbol || '$';
  const n = typeof value === 'number' ? value : Number(value);
  if (isNaN(n)) return String(value ?? '');
  switch (fmt) {
    case 'compact': {
      const abs = Math.abs(n);
      if (abs >= 1e9) return `${(n / 1e9).toFixed(dec)}B`;
      if (abs >= 1e6) return `${(n / 1e6).toFixed(dec)}M`;
      if (abs >= 1e3) return `${(n / 1e3).toFixed(dec)}K`;
      return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: dec });
    }
    case 'percent':
      return `${(n * 100).toFixed(dec)}%`;
    case 'currency':
      return `${sym}${n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
    case 'number':
      return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: dec });
    default:
      return n.toLocaleString();
  }
}

interface ChartPreviewProps {
  chartType: ChartType;
  data: Array<Record<string, any>>;
  config: {
    xField?: string;
    yFields?: string[];
    labelField?: string;
    valueField?: string;
    timeField?: string;
    title?: string;
    colors?: string[];
    color?: string;
    series_colors?: Record<string, string>;
    palette?: string;
    color_by_dimension?: string;
    showLegend?: boolean;
    showGrid?: boolean;
    stacked?: boolean;
    conditional_formatting?: ConditionalFormatRule[];
  };
  styleConfig?: ChartStyleConfig;
  onSelectDataPoint?: (selection: { field: string; value: unknown } | null) => void;
  onStyleConfigChange?: (nextStyleConfig: ChartStyleConfig) => void;
  embedded?: boolean;
  kpiLabelInHeader?: boolean;
}

const DEFAULT_COLORS = [
  '#3b82f6', // blue-500
  '#10b981', // green-500
  '#f59e0b', // amber-500
  '#ef4444', // red-500
  '#8b5cf6', // violet-500
  '#ec4899', // pink-500
  '#06b6d4', // cyan-500
  '#f97316', // orange-500
];

// ── X-axis smart helpers (mirrors ExploreChart) ───────────────────────────────
const SCROLL_THRESHOLD = 40;
const MIN_ITEM_WIDTH   = 38;

function buildXAxisProps(count: number, fontSize: number, xAxisLabel?: string) {
  const angle       = count > 60 ? -45 : count > 25 ? -30 : 0;
  const height      = count > 25 ? 60 : 30;
  const textAnchor: 'end' | 'middle' = angle !== 0 ? 'end' : 'middle';
  const interval    = count > SCROLL_THRESHOLD
    ? 0
    : count > 80
      ? Math.ceil(count / 30)
      : count > 40
        ? Math.ceil(count / 40)
        : 'preserveStartEnd';
  const labelOffset = angle !== 0 ? -10 : -5;
  return { angle, height, textAnchor, interval, labelOffset };
}

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


function applySortRules(data: Record<string, any>[], rules: ChartSortRule[]): Record<string, any>[] {
  if (!rules || rules.length === 0) return data;
  return [...data].sort((a, b) => {
    for (const rule of rules) {
      const av = a[rule.field];
      const bv = b[rule.field];
      const aNum = Number(av);
      const bNum = Number(bv);
      const numeric = !isNaN(aNum) && !isNaN(bNum);
      let cmp = numeric ? aNum - bNum : String(av ?? '').localeCompare(String(bv ?? ''));
      if (cmp !== 0) return rule.direction === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
}

function applyDataLimit(data: Record<string, any>[], limit: number | '' | undefined, direction: 'top' | 'bottom' | undefined): Record<string, any>[] {
  if (!limit || typeof limit !== 'number' || limit <= 0) return data;
  return direction === 'bottom' ? data.slice(-limit) : data.slice(0, limit);
}

function bucketTimestamp(ts: any, granularity: TimeGranularity): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  switch (granularity) {
    case 'day':    return d.toISOString().slice(0, 10);
    case 'week': {
      const day = d.getDay();
      const diff = day === 0 ? -6 : 1 - day;
      const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
      return `W${mon.toISOString().slice(0, 10)}`;
    }
    case 'month':   return d.toISOString().slice(0, 7);
    case 'quarter': return `${d.getFullYear()}-Q${Math.ceil((d.getMonth() + 1) / 3)}`;
    case 'year':    return String(d.getFullYear());
    default:        return String(ts);
  }
}

function applyTimeGranularity(
  data: Record<string, any>[],
  timeField: string,
  valueFields: string[],
  granularity: TimeGranularity,
): Record<string, any>[] {
  if (!granularity || granularity === 'raw' || !timeField || valueFields.length === 0) return data;
  const buckets = new Map<string, Record<string, any>[]>();
  for (const row of data) {
    const key = bucketTimestamp(row[timeField], granularity);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(row);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, rows]) => {
      const out: Record<string, any> = { [timeField]: bucket };
      for (const field of valueFields) {
        const vals = rows.map(r => Number(r[field]) || 0);
        out[field] = vals.reduce((a, b) => a + b, 0);
      }
      return out;
    });
}

function parseDateAxisValue(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }

  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !/(\d{4}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|T\d{2}:|\d{4})/.test(trimmed)) {
    return null;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function isDateLikeAxis(data: Record<string, any>[], field?: string, label?: string): boolean {
  if (!field) return false;
  const axisText = `${field} ${label ?? ''}`.toLowerCase();
  const fieldLooksDateLike = /(date|time|timestamp|_at|created|updated|day|month|year|start|end|deadline)/.test(axisText);
  const samples = data
    .map((row) => row?.[field])
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== '')
    .slice(0, 25);

  if (samples.length === 0) return false;
  const parseable = samples.filter((value) => parseDateAxisValue(value) !== null).length;
  return parseable / samples.length >= 0.6 && (fieldLooksDateLike || parseable === samples.length);
}

function formatDateAxisValue(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}$/.test(trimmed) || /^\d{4}[-/]\d{1,2}$/.test(trimmed)) return trimmed;
  }

  const parsed = parseDateAxisValue(value);
  if (parsed === null) return String(value ?? '');
  return new Date(parsed).toLocaleDateString();
}

function sortRowsByDateAxis(data: Record<string, any>[], field: string | undefined, enabled: boolean): Record<string, any>[] {
  if (!enabled || !field) return data;
  return [...data].sort((a, b) => (parseDateAxisValue(a?.[field]) ?? 0) - (parseDateAxisValue(b?.[field]) ?? 0));
}

export function ChartPreview({
  chartType,
  data,
  config,
  styleConfig,
  onSelectDataPoint,
  onStyleConfigChange,
  embedded = false,
  kpiLabelInHeader = false,
}: ChartPreviewProps) {
  const style = useMemo(
    () => normalizeChartStyleConfig(styleConfig, config.conditional_formatting),
    [config.conditional_formatting, styleConfig],
  );
  // Get palette — styleConfig palette takes precedence
  const paletteName = (style.palette as ChartPaletteName) ?? (config.palette as ChartPaletteName) ?? DEFAULT_CHART_THEME.defaultPalette;
  const palette = getPalette(paletteName);

  // Build dimension color map if color_by_dimension is set
  const dimensionColorMap = useMemo(() => {
    if (config.color_by_dimension && data && data.length > 0) {
      try {
        return buildDimensionColorMap(data, config.color_by_dimension, paletteName);
      } catch (error) {
        console.error('Error building dimension color map:', error);
        return null;
      }
    }
    return null;
  }, [data, config.color_by_dimension, paletteName]);

  // Helper to get color for a series
  const getSeriesColor = (field: string, index: number): string => {
    // Priority: series_colors > colors array > palette
    if (config.series_colors?.[field]) {
      return config.series_colors[field];
    }
    if (config.colors && config.colors[index]) {
      return config.colors[index];
    }
    return palette.colors[index % palette.colors.length];
  };
  const getSeriesLabel = (field: string): string => style.seriesLabels?.[field]?.trim() || field;

  const showLegend = config.showLegend !== false && (style.legendPosition ?? 'bottom') !== 'none';
  const showGrid = config.showGrid !== false && (style.showGrid ?? true);

  const fontSize = style.fontSize ?? 12;
  const barRadius = style.barRadius ?? 4;
  const showDataLabels = style.showDataLabels ?? false;
  const showDots = style.showDots ?? true;
  const lineStyle = style.lineStyle ?? 'solid';
  const xAxisLabel = style.xAxisLabel || undefined;
  const yAxisLabel = style.yAxisLabel || undefined;
  const legendPosition = style.legendPosition ?? 'bottom';
  // New style variables
  const barSize = typeof style.barSize === 'number' && style.barSize > 0 ? style.barSize : undefined;
  const lineWidth = style.lineWidth ?? 2;
  const areaOpacity = style.areaOpacity ?? 0.6;
  const chartTitle = style.chartTitle?.trim() || config.title || undefined;
  const pieInnerRadius = style.pieInnerRadius ?? 0;
  const stackMode = style.stackMode ?? 'normal';
  const dualYAxis = style.dualYAxis ?? false;
  const yAxisRightLabel = style.yAxisRightLabel?.trim() || undefined;
  const yAxisRightSeriesKey = style.yAxisRightSeriesKey?.trim() || undefined;
  const scatterLabelField = style.scatterLabelField?.trim() || undefined;
  const sortRules = style.chartSortRules ?? [];
  const dataLimit = style.dataLimit;
  const dataLimitDir = style.dataLimitDirection ?? 'top';
  const lineDash = style.lineStyle === 'dashed' ? '5 5' : undefined;
  const timeSeriesGranularity = (style.timeGranularity as TimeGranularity) ?? 'raw';
  const timeSeriesValueFields = config.yFields?.length ? config.yFields : (config.valueField ? [config.valueField] : []);
  const chartTitleFontSize = Math.max(style.chartTitleFontSize ?? fontSize, 14);
  const hasExplicitFontSize = Boolean(
    styleConfig && Object.prototype.hasOwnProperty.call(styleConfig, 'fontSize') && style.fontSize !== 12,
  );
  const kpiValueFontSize = style.kpiValueFontSize ?? (hasExplicitFontSize ? style.fontSize : undefined);
  const tableNumberFormat = style.numberFormat && style.numberFormat !== 'compact' ? style.numberFormat : 'auto';

  const chartOutputData = useMemo(() => {
    if (chartType !== ChartType.TIME_SERIES || !config.timeField || timeSeriesValueFields.length === 0) {
      return data;
    }

    return timeSeriesGranularity !== 'raw'
      ? applyTimeGranularity(data, config.timeField, timeSeriesValueFields, timeSeriesGranularity)
      : data;
  }, [chartType, config.timeField, data, timeSeriesGranularity, timeSeriesValueFields]);

  // Sorted + limited data for categorical charts
  const sortedData = useMemo(() => {
    let d = applySortRules(chartOutputData, sortRules);
    d = applyDataLimit(d, dataLimit, dataLimitDir);
    return d;
  }, [chartOutputData, sortRules, dataLimit, dataLimitDir]);

  const ChartTitleEl = chartTitle ? (
    <div className="text-center font-semibold text-text-secondary mb-1" style={{ fontSize: chartTitleFontSize }}>{chartTitle}</div>
  ) : null;

  const yDomain: [number | 'auto', number | 'auto'] = [
    typeof style.yAxisMin === 'number' ? style.yAxisMin : 'auto',
    typeof style.yAxisMax === 'number' ? style.yAxisMax : 'auto',
  ];
  const yTickFormatter = (v: any) => formatNumber(v, style);
  const legendProps = showLegend
    ? {
        layout: (legendPosition === 'left' || legendPosition === 'right' ? 'vertical' : 'horizontal') as 'vertical' | 'horizontal',
        verticalAlign: (legendPosition === 'top' ? 'top' : legendPosition === 'bottom' ? 'bottom' : 'middle') as 'top' | 'middle' | 'bottom',
        align: (legendPosition === 'left' ? 'left' : legendPosition === 'right' ? 'right' : 'center') as 'left' | 'center' | 'right',
      }
    : null;
  const renderBenchmarkLines = (axis: 'x' | 'y', rows: Record<string, any>[]) => {
    const lines = resolveBenchmarkLines(style, rows);
    if (lines.length === 0) return null;
    return lines.map((line, i) => (
      <ReferenceLine
        key={`benchmark-${i}`}
        ifOverflow="extendDomain"
        stroke={line.color}
        strokeWidth={2}
        strokeDasharray={line.dash}
        label={line.label
          ? {
              value: line.label,
              position: 'insideTopRight',
              fill: line.color,
              fontSize: Math.max(fontSize - 1, 10),
            }
          : undefined}
        {...(axis === 'x' ? { x: line.value } : { y: line.value })}
      />
    ));
  };
  const emitSelection = (field: string | undefined, value: unknown) => {
    if (!onSelectDataPoint || !field || value === undefined || value === null || value === '') return;
    onSelectDataPoint({ field, value });
  };
  const handleCategoricalChartClick = (event: any, field: string | undefined) => {
    const payload = event?.activePayload?.[0]?.payload;
    const value = field ? payload?.[field] ?? event?.activeLabel : undefined;
    emitSelection(field, value);
  };
  const handlePieClick = (entry: any) => {
    const labelField = config.color_by_dimension ?? config.labelField;
    emitSelection(labelField, labelField ? entry?.payload?.[labelField] ?? entry?.name : entry?.name);
  };
  const handleScatterClick = (event: any) => {
    const payload = event?.payload ?? event?.activePayload?.[0]?.payload;
    const labelField = config.labelField ?? config.color_by_dimension;
    emitSelection(labelField, labelField ? payload?.[labelField] : undefined);
  };
  const handleTableColumnWidthsChange = (nextWidths: Record<string, number>) => {
    onStyleConfigChange?.({
      ...style,
      tableColumnWidths: Object.keys(nextWidths).length > 0 ? nextWidths : undefined,
    });
  };

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 bg-surface-2 border border-[rgb(var(--border-line))] rounded-lg">
        <p className="text-text-tertiary">No data to display</p>
      </div>
    );
  }

  // Render Bar Chart
  if (chartType === ChartType.BAR && config.xField && config.yFields) {
    const usesDimensionColoring = dimensionColorMap && config.color_by_dimension === config.xField;
    const { angle, height, textAnchor, interval, labelOffset } = buildXAxisProps(sortedData.length, fontSize, xAxisLabel);
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          {wrapScrollable(
            <BarChart data={sortedData} onClick={(event) => handleCategoricalChartClick(event, config.xField)}>
              {showGrid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis dataKey={config.xField} tick={{ fontSize, angle, textAnchor } as any} height={height} interval={interval as any} label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: labelOffset } : undefined} />
              <YAxis tickFormatter={yTickFormatter} domain={yDomain} tick={{ fontSize }} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
              <Tooltip formatter={(v: any) => formatNumber(v, style)} />
              {showLegend && legendProps && <Legend {...legendProps} />}
              {usesDimensionColoring && config.yFields.length === 1 ? (
                <Bar dataKey={config.yFields[0]} name={getSeriesLabel(config.yFields[0])} radius={[barRadius, barRadius, 0, 0]} barSize={barSize}>
                  {sortedData.map((entry, index) => {
                    const key = String(entry[config.color_by_dimension!]);
                    const fill = dimensionColorMap?.[key] ?? palette.colors[index % palette.colors.length];
                    return <Cell key={`cell-${index}`} fill={fill} />;
                  })}
                  {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, style)} style={{ fontSize: fontSize - 1 }} />}
                </Bar>
              ) : (
                config.yFields.map((field, index) => (
                  <Bar key={field} dataKey={field} name={getSeriesLabel(field)} fill={getSeriesColor(field, index)}
                    radius={[barRadius, barRadius, 0, 0]} barSize={barSize}>
                    {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, style)} style={{ fontSize: fontSize - 1 }} />}
                  </Bar>
                ))
              )}
              {renderBenchmarkLines('y', sortedData)}
            </BarChart>,
            sortedData.length,
          )}
        </div>
      </div>
    );
  }
  if (chartType === ChartType.LINE && config.xField && config.yFields) {
    const dateLikeXAxis = isDateLikeAxis(sortedData, config.xField, xAxisLabel);
    const displayData = sortRowsByDateAxis(sortedData, config.xField, dateLikeXAxis && sortRules.length === 0);
    const { angle, height, textAnchor, interval, labelOffset } = buildXAxisProps(displayData.length, fontSize, xAxisLabel);
    const rightAxisField = dualYAxis && config.yFields.length >= 2
      ? (config.yFields.includes(yAxisRightSeriesKey || '') ? yAxisRightSeriesKey! : config.yFields[1])
      : undefined;
    const rightAxisIndex = rightAxisField ? Math.max(0, config.yFields.indexOf(rightAxisField)) : 0;
    const rightAxisColor = rightAxisField ? getSeriesColor(rightAxisField, rightAxisIndex) : undefined;
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          {wrapScrollable(
            <LineChart data={displayData} onClick={(event) => handleCategoricalChartClick(event, config.xField)}>
              {showGrid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis dataKey={config.xField} tick={{ fontSize, angle, textAnchor } as any} height={height} interval={interval as any} tickFormatter={dateLikeXAxis ? formatDateAxisValue : undefined} label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: labelOffset } : undefined} />
              <YAxis tickFormatter={yTickFormatter} domain={yDomain} tick={{ fontSize }} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
              {rightAxisField && (
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fontSize, fill: rightAxisColor }}
                  tickFormatter={(value: any) => formatNumber(value, style)}
                  axisLine={{ stroke: rightAxisColor }}
                  tickLine={{ stroke: rightAxisColor }}
                  label={{ value: yAxisRightLabel || getSeriesLabel(rightAxisField), angle: 90, position: 'insideRight', fontSize, dx: 15, fill: rightAxisColor }}
                />
              )}
              <Tooltip formatter={(v: any) => formatNumber(v, style)} labelFormatter={dateLikeXAxis ? formatDateAxisValue : undefined} />
              {showLegend && legendProps && <Legend {...legendProps} />}
              {config.yFields.map((field, index) => (
                <Line key={field} type="monotone" dataKey={field} name={getSeriesLabel(field)}
                  stroke={getSeriesColor(field, index)}
                  strokeWidth={lineWidth}
                  dot={showDots}
                  strokeDasharray={lineDash}
                  yAxisId={field === rightAxisField ? 'right' : 0}>
                  {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, style)} style={{ fontSize: fontSize - 1 }} />}
                </Line>
              ))}
              {renderBenchmarkLines('y', displayData)}
            </LineChart>,
            displayData.length,
          )}
        </div>
      </div>
    );
  }

  // Render Area Chart
  if (chartType === ChartType.AREA && config.xField && config.yFields) {
    const dateLikeXAxis = isDateLikeAxis(sortedData, config.xField, xAxisLabel);
    const displayData = sortRowsByDateAxis(sortedData, config.xField, dateLikeXAxis && sortRules.length === 0);
    const { angle, height, textAnchor, interval, labelOffset } = buildXAxisProps(displayData.length, fontSize, xAxisLabel);
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          {wrapScrollable(
            <AreaChart data={displayData} onClick={(event) => handleCategoricalChartClick(event, config.xField)}>
              {showGrid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis dataKey={config.xField} tick={{ fontSize, angle, textAnchor } as any} height={height} interval={interval as any} tickFormatter={dateLikeXAxis ? formatDateAxisValue : undefined} label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: labelOffset } : undefined} />
              <YAxis tickFormatter={yTickFormatter} domain={yDomain} tick={{ fontSize }} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
              <Tooltip formatter={(v: any) => formatNumber(v, style)} labelFormatter={dateLikeXAxis ? formatDateAxisValue : undefined} />
              {showLegend && legendProps && <Legend {...legendProps} />}
              {config.yFields.map((field, index) => (
                <Area key={field} type="monotone" dataKey={field} name={getSeriesLabel(field)}
                  stroke={getSeriesColor(field, index)}
                  fill={getSeriesColor(field, index)}
                  fillOpacity={areaOpacity}
                  strokeWidth={lineWidth}
                  strokeDasharray={lineDash}
                  dot={showDots}>
                  {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, style)} style={{ fontSize: fontSize - 1 }} />}
                </Area>
              ))}
              {renderBenchmarkLines('y', displayData)}
            </AreaChart>,
            displayData.length,
          )}
        </div>
      </div>
    );
  }

  // Render Grouped Bar Chart
  if (chartType === ChartType.GROUPED_BAR && config.xField && config.yFields) {
    const usesDimensionColoring = dimensionColorMap && config.color_by_dimension === config.xField;
    const { angle, height, textAnchor, interval, labelOffset } = buildXAxisProps(sortedData.length, fontSize, xAxisLabel);
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          {wrapScrollable(
            <BarChart data={sortedData} onClick={(event) => handleCategoricalChartClick(event, config.xField)}>
              {showGrid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis dataKey={config.xField} tick={{ fontSize, angle, textAnchor } as any} height={height} interval={interval as any} label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: labelOffset } : undefined} />
              <YAxis tickFormatter={yTickFormatter} domain={yDomain} tick={{ fontSize }} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
              <Tooltip formatter={(v: any) => formatNumber(v, style)} />
              {showLegend && legendProps && <Legend {...legendProps} />}
              {usesDimensionColoring && config.yFields.length === 1 ? (
                <Bar dataKey={config.yFields[0]} name={getSeriesLabel(config.yFields[0])} radius={[barRadius, barRadius, 0, 0]} barSize={barSize}>
                  {sortedData.map((entry, index) => {
                    const key = String(entry[config.color_by_dimension!]);
                    const fill = dimensionColorMap?.[key] ?? palette.colors[index % palette.colors.length];
                    return <Cell key={`cell-${index}`} fill={fill} />;
                  })}
                  {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, style)} style={{ fontSize: fontSize - 1 }} />}
                </Bar>
              ) : (
                config.yFields.map((field, index) => (
                  <Bar key={field} dataKey={field} name={getSeriesLabel(field)} fill={getSeriesColor(field, index)}
                    radius={[barRadius, barRadius, 0, 0]} barSize={barSize}>
                    {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, style)} style={{ fontSize: fontSize - 1 }} />}
                  </Bar>
                ))
              )}
              {renderBenchmarkLines('y', sortedData)}
            </BarChart>,
            sortedData.length,
          )}
        </div>
      </div>
    );
  }

  // Render Stacked Bar Chart
  if (chartType === ChartType.STACKED_BAR && config.xField && config.yFields) {
    const isPercent = stackMode === 'percent';
    const { angle, height, textAnchor, interval, labelOffset } = buildXAxisProps(sortedData.length, fontSize, xAxisLabel);
    const stackTotalsByIndex = sortedData.map((row) =>
      config.yFields!.reduce((acc, field) => acc + (Number(row[field]) || 0), 0),
    );
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          {wrapScrollable(
            <BarChart data={sortedData} onClick={(event) => handleCategoricalChartClick(event, config.xField)}
              stackOffset={isPercent ? 'expand' : undefined}>
              {showGrid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis dataKey={config.xField} tick={{ fontSize, angle, textAnchor } as any} height={height} interval={interval as any} label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: labelOffset } : undefined} />
              {isPercent
                ? <YAxis tick={{ fontSize }} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} domain={[0, 1]} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
                : <YAxis tickFormatter={yTickFormatter} domain={yDomain} tick={{ fontSize }} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />}
              <Tooltip formatter={isPercent
                ? (v: any, name: string) => [`${(Number(v) * 100).toFixed(1)}%`, name]
                : (v: any) => formatNumber(v, style)} />
              {showLegend && legendProps && <Legend {...legendProps} />}
              {config.yFields.map((field, index) => {
                const isTopOfStack = index === config.yFields!.length - 1;
                return (
                  <Bar key={field} dataKey={field} name={getSeriesLabel(field)} stackId="stack"
                    fill={getSeriesColor(field, index)} barSize={barSize}
                    radius={isTopOfStack ? [barRadius, barRadius, 0, 0] : undefined}>
                    {showDataLabels && isPercent && (
                      <LabelList
                        dataKey={field}
                        position="center"
                        content={(props: any) => {
                          const { x, y, width, height, value, index: rowIndex } = props;
                          const total = stackTotalsByIndex[rowIndex] || 0;
                          if (!total) return null;
                          const pct = (Number(value) / total) * 100;
                          if (pct < 4) return null;
                          return (
                            <text
                              x={x + width / 2}
                              y={y + height / 2}
                              textAnchor="middle"
                              dominantBaseline="middle"
                              fill="#fff"
                              fontSize={fontSize - 1}
                            >
                              {`${pct.toFixed(0)}%`}
                            </text>
                          );
                        }}
                      />
                    )}
                    {showDataLabels && !isPercent && isTopOfStack && (
                      <LabelList
                        dataKey={field}
                        position="top"
                        content={(props: any) => {
                          const { x, y, width, index: rowIndex } = props;
                          const total = stackTotalsByIndex[rowIndex] || 0;
                          if (!total) return null;
                          return (
                            <text
                              x={x + width / 2}
                              y={Math.max(12, y - 6)}
                              textAnchor="middle"
                              fill="rgb(var(--text-secondary))"
                              fontSize={fontSize - 1}
                            >
                              {formatNumber(total, style)}
                            </text>
                          );
                        }}
                      />
                    )}
                  </Bar>
                );
              })}
              {renderBenchmarkLines('y', sortedData)}
            </BarChart>,
            sortedData.length,
          )}
        </div>
      </div>
    );
  }

  // Render Scatter Chart
  if (chartType === ChartType.SCATTER && config.xField && config.yFields && config.yFields.length > 0) {
    const usesDimensionColoring = dimensionColorMap && config.color_by_dimension;
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart onClick={handleScatterClick}>
              {showGrid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis dataKey={config.xField} name={config.xField} tick={{ fontSize }} label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: -5 } : undefined} />
              <YAxis dataKey={config.yFields[0]} name={config.yFields[0]} tickFormatter={yTickFormatter} domain={yDomain} tick={{ fontSize }} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
              <ZAxis range={[60, 400]} />
              <Tooltip cursor={{ strokeDasharray: '3 3' }} formatter={(v: any) => formatNumber(v, style)} />
              {showLegend && legendProps && <Legend {...legendProps} />}
              {usesDimensionColoring ? (
                <Scatter name={getSeriesLabel(config.yFields[0])} data={sortedData} fillOpacity={0.8}>
                  {sortedData.map((entry, idx) => {
                    const key = String(entry[config.color_by_dimension!]);
                    const fill = dimensionColorMap[key] ?? palette.colors[idx % palette.colors.length];
                    return <Cell key={idx} fill={fill} />;
                  })}
                  {scatterLabelField && <LabelList dataKey={scatterLabelField} position="top" style={{ fontSize: fontSize - 1 }} />}
                </Scatter>
              ) : (
                <Scatter name={getSeriesLabel(config.yFields[0])} data={sortedData} fill={getSeriesColor(config.yFields[0], 0)}>
                  {scatterLabelField && <LabelList dataKey={scatterLabelField} position="top" style={{ fontSize: fontSize - 1 }} />}
                </Scatter>
              )}
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  }

  // Render Pie Chart
  if (chartType === ChartType.PIE && config.labelField && config.valueField) {
    const usesDimensionColoring = dimensionColorMap && config.color_by_dimension;
    const pieNameField = usesDimensionColoring ? config.color_by_dimension! : config.labelField;
    const pieDisplayNameField = '__displayName';
    const pieData: Record<string, any>[] = sortedData.map((row) => ({
      ...row,
      [pieDisplayNameField]: getSeriesLabel(String(row?.[pieNameField] ?? '')),
    }));
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={pieData}
                dataKey={config.valueField}
                nameKey={pieDisplayNameField}
                cx="50%" cy="45%" outerRadius="60%"
                innerRadius={pieInnerRadius > 0 ? `${pieInnerRadius}%` : undefined}
                onClick={handlePieClick}
                label={showDataLabels ? ({ name, value }: any) => `${name}: ${formatNumber(value, style)}` : true}
              >
                {pieData.map((entry, index) => {
                  let fill: string;
                  if (usesDimensionColoring) {
                    const key = String(entry[config.color_by_dimension!]);
                    fill = dimensionColorMap[key] ?? palette.colors[index % palette.colors.length];
                  } else if (config.color) {
                    fill = config.color;
                  } else {
                    fill = palette.colors[index % palette.colors.length];
                  }
                  return <Cell key={`cell-${index}`} fill={fill} />;
                })}
              </Pie>
              <Tooltip formatter={(v: any) => formatNumber(v, style)} />
              {showLegend && legendProps && <Legend {...legendProps} />}
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  }

  // Render Time Series Chart
  if (chartType === ChartType.TIME_SERIES && config.timeField && config.valueField) {
    const gran = timeSeriesGranularity;
    const tsValueFields = timeSeriesValueFields;
    const tsData = sortRowsByDateAxis(sortedData, config.timeField, gran === 'raw' && sortRules.length === 0);
    const rightAxisField = dualYAxis && tsValueFields.length >= 2
      ? (tsValueFields.includes(yAxisRightSeriesKey || '') ? yAxisRightSeriesKey! : tsValueFields[1])
      : undefined;
    const rightAxisIndex = rightAxisField ? Math.max(0, tsValueFields.indexOf(rightAxisField)) : 0;
    const rightAxisColor = rightAxisField ? getSeriesColor(rightAxisField, rightAxisIndex) : undefined;
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          {wrapScrollable(
            <LineChart data={tsData} onClick={(event) => handleCategoricalChartClick(event, config.timeField)}>
              {showGrid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis dataKey={config.timeField} tick={{ fontSize }}
                tickFormatter={(value) => gran === 'raw' ? formatDateAxisValue(value) : String(value)}
                label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: -5 } : undefined} />
              <YAxis tickFormatter={yTickFormatter} domain={yDomain} tick={{ fontSize }} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
              {rightAxisField && (
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fontSize, fill: rightAxisColor }}
                  tickFormatter={(value: any) => formatNumber(value, style)}
                  axisLine={{ stroke: rightAxisColor }}
                  tickLine={{ stroke: rightAxisColor }}
                  label={{ value: yAxisRightLabel || getSeriesLabel(rightAxisField), angle: 90, position: 'insideRight', fontSize, dx: 15, fill: rightAxisColor }}
                />
              )}
              <Tooltip
                labelFormatter={(value) => gran === 'raw' ? formatDateAxisValue(value) : String(value)}
                formatter={(v: any) => formatNumber(v, style)} />
              {showLegend && legendProps && <Legend {...legendProps} />}
              {tsValueFields.map((field, index) => (
                <Line key={field} type="monotone" dataKey={field} name={getSeriesLabel(field)}
                  stroke={config.color || getSeriesColor(field, index)}
                  strokeWidth={lineWidth} dot={showDots} strokeDasharray={lineDash}
                  yAxisId={field === rightAxisField ? 'right' : 0}>
                  {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, style)} style={{ fontSize: fontSize - 1 }} />}
                </Line>
              ))}
              {renderBenchmarkLines('y', tsData)}
            </LineChart>,
            tsData.length,
          )}
        </div>
      </div>
    );
  }

  // Render Horizontal Bar Chart
  if (chartType === ChartType.HORIZONTAL_BAR && config.xField && config.yFields) {
    const MIN_ROW_HEIGHT = 32;
    const isVertScroll = sortedData.length > SCROLL_THRESHOLD;
    const chartHeight  = isVertScroll ? Math.max(sortedData.length * MIN_ROW_HEIGHT, 400) : undefined;
    const inner = (
      <BarChart data={sortedData} layout="vertical" onClick={(event) => handleCategoricalChartClick(event, config.xField)}>
        {showGrid && <CartesianGrid strokeDasharray="3 3" />}
        <YAxis dataKey={config.xField} type="category" tick={{ fontSize }} width={120}
          label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
        <XAxis type="number" tickFormatter={yTickFormatter} tick={{ fontSize }}
          label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: -5 } : undefined} />
        <Tooltip formatter={(v: any) => formatNumber(v, style)} />
        {showLegend && legendProps && <Legend {...legendProps} />}
        {config.yFields.map((field, index) => (
          <Bar key={field} dataKey={field} name={getSeriesLabel(field)} fill={getSeriesColor(field, index)}
            barSize={barSize} radius={[0, barRadius, barRadius, 0]}>
            {showDataLabels && <LabelList position="right" formatter={(v: any) => formatNumber(v, style)} style={{ fontSize: fontSize - 1 }} />}
          </Bar>
        ))}
        {renderBenchmarkLines('x', sortedData)}
      </BarChart>
    );
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          {isVertScroll ? (
            <div style={{ width: '100%', height: '100%', overflowY: 'auto', overflowX: 'hidden' }}>
              <div style={{ width: '100%', height: chartHeight }}>
                <ResponsiveContainer width="100%" height="100%">{inner}</ResponsiveContainer>
              </div>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">{inner}</ResponsiveContainer>
          )}
        </div>
      </div>
    );
  }

  // Render Bar + Line Combo Chart
  if (chartType === ChartType.BAR_LINE && config.xField && config.yFields && config.yFields.length >= 2) {
    const barFields = config.yFields.slice(0, -1);
    const lineField = config.yFields[config.yFields.length - 1];
    const { angle, height, textAnchor, interval, labelOffset } = buildXAxisProps(sortedData.length, fontSize, xAxisLabel);
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          {wrapScrollable(
            <ComposedChart data={sortedData} onClick={(event) => handleCategoricalChartClick(event, config.xField)}>
              {showGrid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis dataKey={config.xField} tick={{ fontSize, angle, textAnchor } as any} height={height} interval={interval as any} label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: labelOffset } : undefined} />
              <YAxis tickFormatter={yTickFormatter} domain={yDomain} tick={{ fontSize }} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
              {dualYAxis && (
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize }}
                  tickFormatter={yTickFormatter}
                  label={yAxisRightLabel ? { value: yAxisRightLabel, angle: 90, position: 'insideRight', fontSize, dx: 15 } : undefined} />
              )}
              <Tooltip formatter={(v: any) => formatNumber(v, style)} />
              {showLegend && legendProps && <Legend {...legendProps} />}
              {barFields.map((field, index) => (
                <Bar key={field} dataKey={field} name={getSeriesLabel(field)} fill={getSeriesColor(field, index)}
                  radius={[barRadius, barRadius, 0, 0]} barSize={barSize}>
                  {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, style)} style={{ fontSize: fontSize - 1 }} />}
                </Bar>
              ))}
              <Line type="monotone" dataKey={lineField} name={getSeriesLabel(lineField)} stroke={getSeriesColor(lineField, barFields.length)}
                strokeWidth={lineWidth} dot={showDots} strokeDasharray={lineDash}
                yAxisId={dualYAxis ? 'right' : 0} />
              {renderBenchmarkLines('y', sortedData)}
            </ComposedChart>,
            sortedData.length,
          )}
        </div>
      </div>
    );
  }

  // Render Table
  if (chartType === ChartType.TABLE) {
    // Phase-15.24: `data[0] ?? {}` guard against null rows from the BE.
    const columns = data.length > 0 ? Object.keys(data[0] ?? {}) : [];
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          <TableVisualization
            data={data}
            columns={columns}
            maxRows={50}
            conditionalFormatting={style.tableEnableConditionalFormatting ? style.tableConditionalFormatting : undefined}
            heatmapRules={style.tableEnableHeatmap ? style.tableHeatmapRules : undefined}
            summaryRows={style.tableSummaryRows}
            showSummaryRow={style.tableShowSummaryRow}
            summaryLabel={style.tableSummaryLabel}
            summaryLabelColumn={style.tableSummaryLabelColumn}
            columnWidths={style.tableColumnWidths}
            onColumnWidthsChange={onStyleConfigChange ? handleTableColumnWidthsChange : undefined}
            columnAlignments={style.tableColumnAlignments}
            hyperlinkRules={style.tableHyperlinkRules}
            numberFormat={tableNumberFormat}
            decimalPlaces={style.decimalPlaces}
            currencySymbol={style.currencySymbol}
            columnLabels={style.tableColumnLabels}
          />
        </div>
      </div>
    );
  }

  // Render KPI Card
  if (chartType === ChartType.KPI) {
    const fallbackValueField = config.valueField
      || config.yFields?.[0]
      || Object.keys(data[0] ?? {}).find((field) => typeof data[0]?.[field] === 'number');
    const value = fallbackValueField ? data[0]?.[fallbackValueField] ?? null : null;
    const label = style.kpiLabel?.trim()
      || (config.labelField ? String(data[0]?.[config.labelField] || '') : '')
      || chartTitle
      || fallbackValueField
      || 'KPI';
    const kpiBenchmarkBase = style.kpiBenchmarkValue === '' || style.kpiBenchmarkValue == null
      ? null
      : Number(style.kpiBenchmarkValue);
    const kpiBenchmarkValue = applyKpiBenchmarkCalc(kpiBenchmarkBase, style);
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className={`flex-1 flex ${embedded ? 'items-stretch' : 'items-center justify-center'}`}>
          <div className={embedded ? 'w-full h-full' : 'w-full max-w-xl'}>
            <KpiCard
              value={value}
              label={label}
              format={style.numberFormat ?? 'compact'}
              decimalPlaces={style.decimalPlaces}
              currencySymbol={style.currencySymbol}
              contextTemplate={style.kpiContextTemplate}
              benchmarkValue={kpiBenchmarkValue}
              benchmarkLabel={style.kpiBenchmarkLabel}
              showBenchmarkValue={style.kpiShowBenchmarkValue}
              showDelta={style.kpiShowDelta}
              goalDirection={style.kpiGoalDirection}
              backgroundMode={style.kpiBackgroundMode}
              accentColor={style.kpiAccentColor}
              enableColorRules={style.kpiEnableColorRules}
              colorRules={style.kpiColorRules}
              rowCount={data.length}
              iconName={style.kpiIconName}
              iconColor={style.kpiIconColor}
              accentBorder={style.kpiAccentBorder}
              gradientBg={style.kpiGradientBg}
              valueFontSize={kpiValueFontSize}
              hideLabel={kpiLabelInHeader}
              embedded={embedded}
            />
          </div>
        </div>
      </div>
    );
  }

  // Render PODIUM (top-N ranking with medal styling)
  if (chartType === ChartType.PODIUM) {
    const nameField = style.podiumNameField || config.labelField || config.xField
      || Object.keys(data[0] ?? {}).find((f) => typeof data[0]?.[f] === 'string');
    const valueField = style.podiumValueField || config.valueField || config.yFields?.[0]
      || Object.keys(data[0] ?? {}).find((f) => typeof data[0]?.[f] === 'number');
    const top = Math.min(Math.max(style.podiumTop ?? 3, 1), 5);
    const ranked = [...data]
      .sort((a, b) => Number(b?.[valueField as string] ?? 0) - Number(a?.[valueField as string] ?? 0))
      .slice(0, top);
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 flex items-center justify-center">
          <PodiumDisplay
            entries={ranked}
            nameField={nameField as string}
            valueField={valueField as string}
            colors={[
              style.podiumGoldColor || '#fbbf24',
              style.podiumSilverColor || '#cbd5e1',
              style.podiumBronzeColor || '#d97706',
              '#64748b',
              '#475569',
            ]}
            format={style.numberFormat ?? 'compact'}
            decimalPlaces={style.decimalPlaces}
            currencySymbol={style.currencySymbol}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-64 bg-surface-2 border border-[rgb(var(--border-line))] rounded-lg">
      <p className="text-text-tertiary">Invalid chart configuration</p>
    </div>
  );
}

function PodiumDisplay({
  entries,
  nameField,
  valueField,
  colors,
  format,
  decimalPlaces,
  currencySymbol,
}: {
  entries: any[];
  nameField: string;
  valueField: string;
  colors: string[];
  format: NumberFormat;
  decimalPlaces?: number;
  currencySymbol?: string;
}) {
  const fmt = (v: any): string => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return '--';
    const dp = decimalPlaces ?? 1;
    if (format === 'compact') {
      const a = Math.abs(n);
      if (a >= 1e9) return `${(n / 1e9).toFixed(dp)}B`;
      if (a >= 1e6) return `${(n / 1e6).toFixed(dp)}M`;
      if (a >= 1e3) return `${(n / 1e3).toFixed(dp)}K`;
      return n.toLocaleString();
    }
    if (format === 'currency') return `${currencySymbol || '$'}${n.toLocaleString()}`;
    if (format === 'percent') return `${(n * 100).toFixed(dp)}%`;
    return n.toLocaleString();
  };
  const labels = ['Winner', 'Runner-up', 'Rank 3', 'Rank 4', 'Rank 5'];
  // Order for podium display: place #1 in the center
  const display = entries.length >= 3
    ? [entries[1], entries[0], entries[2], ...entries.slice(3)]
    : entries;
  const indexFor = (e: any) => entries.indexOf(e);
  return (
    <div className="flex items-end justify-center gap-4 px-4 w-full">
      {display.map((e, i) => {
        const rank = indexFor(e);
        const color = colors[rank] || colors[colors.length - 1];
        const isFirst = rank === 0;
        return (
          <div
            key={i}
            className="flex flex-col items-center rounded-2xl border p-4 transition"
            style={{
              borderColor: color,
              borderWidth: isFirst ? 2 : 1,
              minWidth: 140,
              transform: isFirst ? 'scale(1.05)' : undefined,
              background: `linear-gradient(180deg, ${color}10, transparent 70%)`,
            }}
          >
            <div
              className="text-[10px] font-bold uppercase tracking-[0.2em]"
              style={{ color }}
            >
              {labels[rank] || `Rank ${rank + 1}`}
            </div>
            <div className="mt-2 text-sm font-semibold text-text-primary text-center break-words">
              {String(e?.[nameField] ?? '--')}
            </div>
            <div
              className="mt-1 text-2xl font-semibold tabular-nums"
              style={{ color }}
            >
              {fmt(e?.[valueField])}
            </div>
          </div>
        );
      })}
    </div>
  );
}
