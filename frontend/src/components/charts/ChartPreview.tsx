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

function getBenchmarkValue(style?: ChartStyleConfig): number | null {
  if (style?.benchmarkValue === '' || style?.benchmarkValue == null) return null;
  const value = Number(style.benchmarkValue);
  return Number.isFinite(value) ? value : null;
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

export function ChartPreview({
  chartType,
  data,
  config,
  styleConfig,
  onSelectDataPoint,
  onStyleConfigChange,
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

  const showLegend = config.showLegend !== false && (style.legendPosition ?? 'bottom') !== 'none';
  const showGrid = config.showGrid !== false && (style.showGrid ?? true);

  const fontSize = style.fontSize ?? 12;
  const barRadius = style.barRadius ?? 4;
  const showDataLabels = style.showDataLabels ?? false;
  const showDots = style.showDots ?? true;
  const lineStyle = style.lineStyle ?? 'solid';
  const benchmarkValue = getBenchmarkValue(style);
  const showBenchmarkLine = Boolean(style.showBenchmarkLine && benchmarkValue !== null);
  const benchmarkColor = style.benchmarkColor || '#dc2626';
  const benchmarkDash = style.benchmarkLineStyle === 'solid' ? undefined : '6 4';
  const benchmarkLabel = style.benchmarkLabel?.trim() || undefined;
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
  const scatterLabelField = style.scatterLabelField?.trim() || undefined;
  const sortRules = style.chartSortRules ?? [];
  const dataLimit = style.dataLimit;
  const dataLimitDir = style.dataLimitDirection ?? 'top';
  const lineDash = style.lineStyle === 'dashed' ? '5 5' : undefined;
  const timeSeriesGranularity = (style.timeGranularity as TimeGranularity) ?? 'raw';
  const timeSeriesValueFields = config.yFields?.length ? config.yFields : (config.valueField ? [config.valueField] : []);

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
    <div className="text-center text-sm font-semibold text-gray-700 mb-1">{chartTitle}</div>
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
  const renderBenchmarkLine = (axis: 'x' | 'y') => {
    if (!showBenchmarkLine || benchmarkValue === null) return null;

    return (
      <ReferenceLine
        ifOverflow="extendDomain"
        stroke={benchmarkColor}
        strokeWidth={2}
        strokeDasharray={benchmarkDash}
        label={benchmarkLabel
          ? {
              value: benchmarkLabel,
              position: 'insideTopRight',
              fill: benchmarkColor,
              fontSize: Math.max(fontSize - 1, 10),
            }
          : undefined}
        {...(axis === 'x' ? { x: benchmarkValue } : { y: benchmarkValue })}
      />
    );
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
      <div className="flex items-center justify-center h-64 bg-gray-50 border border-gray-200 rounded-lg">
        <p className="text-gray-500">No data to display</p>
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
                <Bar dataKey={config.yFields[0]} radius={[barRadius, barRadius, 0, 0]} barSize={barSize}>
                  {sortedData.map((entry, index) => {
                    const key = String(entry[config.color_by_dimension!]);
                    const fill = dimensionColorMap?.[key] ?? palette.colors[index % palette.colors.length];
                    return <Cell key={`cell-${index}`} fill={fill} />;
                  })}
                  {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, style)} style={{ fontSize: fontSize - 1 }} />}
                </Bar>
              ) : (
                config.yFields.map((field, index) => (
                  <Bar key={field} dataKey={field} fill={getSeriesColor(field, index)}
                    radius={[barRadius, barRadius, 0, 0]} barSize={barSize}>
                    {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, style)} style={{ fontSize: fontSize - 1 }} />}
                  </Bar>
                ))
              )}
              {renderBenchmarkLine('y')}
            </BarChart>,
            sortedData.length,
          )}
        </div>
      </div>
    );
  }
  if (chartType === ChartType.LINE && config.xField && config.yFields) {
    const { angle, height, textAnchor, interval, labelOffset } = buildXAxisProps(sortedData.length, fontSize, xAxisLabel);
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          {wrapScrollable(
            <LineChart data={sortedData} onClick={(event) => handleCategoricalChartClick(event, config.xField)}>
              {showGrid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis dataKey={config.xField} tick={{ fontSize, angle, textAnchor } as any} height={height} interval={interval as any} label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: labelOffset } : undefined} />
              <YAxis tickFormatter={yTickFormatter} domain={yDomain} tick={{ fontSize }} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
              <Tooltip formatter={(v: any) => formatNumber(v, style)} />
              {showLegend && legendProps && <Legend {...legendProps} />}
              {config.yFields.map((field, index) => (
                <Line key={field} type="monotone" dataKey={field}
                  stroke={getSeriesColor(field, index)}
                  strokeWidth={lineWidth}
                  dot={showDots}
                  strokeDasharray={lineDash}>
                  {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, style)} style={{ fontSize: fontSize - 1 }} />}
                </Line>
              ))}
              {renderBenchmarkLine('y')}
            </LineChart>,
            sortedData.length,
          )}
        </div>
      </div>
    );
  }

  // Render Area Chart
  if (chartType === ChartType.AREA && config.xField && config.yFields) {
    const { angle, height, textAnchor, interval, labelOffset } = buildXAxisProps(sortedData.length, fontSize, xAxisLabel);
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          {wrapScrollable(
            <AreaChart data={sortedData} onClick={(event) => handleCategoricalChartClick(event, config.xField)}>
              {showGrid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis dataKey={config.xField} tick={{ fontSize, angle, textAnchor } as any} height={height} interval={interval as any} label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: labelOffset } : undefined} />
              <YAxis tickFormatter={yTickFormatter} domain={yDomain} tick={{ fontSize }} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
              <Tooltip formatter={(v: any) => formatNumber(v, style)} />
              {showLegend && legendProps && <Legend {...legendProps} />}
              {config.yFields.map((field, index) => (
                <Area key={field} type="monotone" dataKey={field}
                  stroke={getSeriesColor(field, index)}
                  fill={getSeriesColor(field, index)}
                  fillOpacity={areaOpacity}
                  strokeWidth={lineWidth}
                  strokeDasharray={lineDash}
                  dot={showDots}>
                  {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, style)} style={{ fontSize: fontSize - 1 }} />}
                </Area>
              ))}
              {renderBenchmarkLine('y')}
            </AreaChart>,
            sortedData.length,
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
                <Bar dataKey={config.yFields[0]} radius={[barRadius, barRadius, 0, 0]} barSize={barSize}>
                  {sortedData.map((entry, index) => {
                    const key = String(entry[config.color_by_dimension!]);
                    const fill = dimensionColorMap?.[key] ?? palette.colors[index % palette.colors.length];
                    return <Cell key={`cell-${index}`} fill={fill} />;
                  })}
                  {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, style)} style={{ fontSize: fontSize - 1 }} />}
                </Bar>
              ) : (
                config.yFields.map((field, index) => (
                  <Bar key={field} dataKey={field} fill={getSeriesColor(field, index)}
                    radius={[barRadius, barRadius, 0, 0]} barSize={barSize}>
                    {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, style)} style={{ fontSize: fontSize - 1 }} />}
                  </Bar>
                ))
              )}
              {renderBenchmarkLine('y')}
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
              {config.yFields.map((field, index) => (
                <Bar key={field} dataKey={field} stackId="stack"
                  fill={getSeriesColor(field, index)} barSize={barSize}
                  radius={index === config.yFields!.length - 1 ? [barRadius, barRadius, 0, 0] : undefined}>
                  {showDataLabels && <LabelList position="center" formatter={(v: any) => formatNumber(v, style)} style={{ fontSize: fontSize - 2, fill: '#fff' }} />}
                </Bar>
              ))}
              {renderBenchmarkLine('y')}
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
                <Scatter name={config.yFields[0]} data={sortedData} fillOpacity={0.8}>
                  {sortedData.map((entry, idx) => {
                    const key = String(entry[config.color_by_dimension!]);
                    const fill = dimensionColorMap[key] ?? palette.colors[idx % palette.colors.length];
                    return <Cell key={idx} fill={fill} />;
                  })}
                  {scatterLabelField && <LabelList dataKey={scatterLabelField} position="top" style={{ fontSize: fontSize - 1 }} />}
                </Scatter>
              ) : (
                <Scatter name={config.yFields[0]} data={sortedData} fill={getSeriesColor(config.yFields[0], 0)}>
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
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={sortedData}
                dataKey={config.valueField}
                nameKey={usesDimensionColoring ? config.color_by_dimension : config.labelField}
                cx="50%" cy="45%" outerRadius="60%"
                innerRadius={pieInnerRadius > 0 ? `${pieInnerRadius}%` : undefined}
                onClick={handlePieClick}
                label={showDataLabels ? ({ name, value }: any) => `${name}: ${formatNumber(value, style)}` : true}
              >
                {sortedData.map((entry, index) => {
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
    const tsData = sortedData;
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          {wrapScrollable(
            <LineChart data={tsData} onClick={(event) => handleCategoricalChartClick(event, config.timeField)}>
              {showGrid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis dataKey={config.timeField} tick={{ fontSize }}
                tickFormatter={(value) => gran === 'raw' ? new Date(value).toLocaleDateString() : String(value)}
                label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: -5 } : undefined} />
              <YAxis tickFormatter={yTickFormatter} domain={yDomain} tick={{ fontSize }} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
              <Tooltip
                labelFormatter={(value) => gran === 'raw' ? new Date(value).toLocaleString() : String(value)}
                formatter={(v: any) => formatNumber(v, style)} />
              {showLegend && legendProps && <Legend {...legendProps} />}
              {tsValueFields.map((field, index) => (
                <Line key={field} type="monotone" dataKey={field}
                  stroke={config.color || getSeriesColor(field, index)}
                  strokeWidth={lineWidth} dot={showDots} strokeDasharray={lineDash}>
                  {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, style)} style={{ fontSize: fontSize - 1 }} />}
                </Line>
              ))}
              {renderBenchmarkLine('y')}
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
          <Bar key={field} dataKey={field} fill={getSeriesColor(field, index)}
            barSize={barSize} radius={[0, barRadius, barRadius, 0]}>
            {showDataLabels && <LabelList position="right" formatter={(v: any) => formatNumber(v, style)} style={{ fontSize: fontSize - 1 }} />}
          </Bar>
        ))}
        {renderBenchmarkLine('x')}
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
                <Bar key={field} dataKey={field} fill={getSeriesColor(field, index)}
                  radius={[barRadius, barRadius, 0, 0]} barSize={barSize}>
                  {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, style)} style={{ fontSize: fontSize - 1 }} />}
                </Bar>
              ))}
              <Line type="monotone" dataKey={lineField} stroke={getSeriesColor(lineField, barFields.length)}
                strokeWidth={lineWidth} dot={showDots} strokeDasharray={lineDash}
                yAxisId={dualYAxis ? 'right' : 0} />
              {renderBenchmarkLine('y')}
            </ComposedChart>,
            sortedData.length,
          )}
        </div>
      </div>
    );
  }

  // Render Table
  if (chartType === ChartType.TABLE) {
    const columns = data.length > 0 ? Object.keys(data[0]) : [];
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
    const kpiBenchmarkValue = style.kpiBenchmarkValue === '' || style.kpiBenchmarkValue == null
      ? null
      : Number(style.kpiBenchmarkValue);
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 flex items-center justify-center">
          <div className="w-full max-w-xl">
            <KpiCard
              value={value}
              label={label}
              format={style.numberFormat ?? 'compact'}
              decimalPlaces={style.decimalPlaces}
              currencySymbol={style.currencySymbol}
              contextTemplate={style.kpiContextTemplate}
              benchmarkValue={kpiBenchmarkValue}
              benchmarkLabel={style.kpiBenchmarkLabel}
              showDelta={style.kpiShowDelta}
              goalDirection={style.kpiGoalDirection}
              accentColor={style.kpiAccentColor}
              enableColorRules={style.kpiEnableColorRules}
              colorRules={style.kpiColorRules}
              rowCount={data.length}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-64 bg-gray-50 border border-gray-200 rounded-lg">
      <p className="text-gray-500">Invalid chart configuration</p>
    </div>
  );
}
