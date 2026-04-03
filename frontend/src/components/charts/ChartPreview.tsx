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
  ResponsiveContainer,
  ZAxis,
} from 'recharts';
import { ChartType } from '@/types/api';
import { TableVisualization } from '@/components/visualizations/TableVisualization';
import { KpiCard } from '@/components/visualizations/KpiCard';
import { getPalette, buildDimensionColorMap, ChartPaletteName, DEFAULT_CHART_THEME } from '@/lib/chartColors';
import type { ChartStyleConfig, NumberFormat } from '@/components/explore/ExploreChartConfig';
import { DEFAULT_STYLE_CONFIG } from '@/components/explore/ExploreChartConfig';

function formatNumber(value: any, fmt: NumberFormat): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (isNaN(n)) return String(value ?? '');
  switch (fmt) {
    case 'compact': {
      const abs = Math.abs(n);
      if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
      if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
      if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
      return n.toLocaleString();
    }
    case 'percent':
      return `${(n * 100).toFixed(1)}%`;
    case 'currency':
      return `$${n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
    case 'number':
      return n.toLocaleString();
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
  };
  styleConfig?: ChartStyleConfig;
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

export function ChartPreview({ chartType, data, config, styleConfig }: ChartPreviewProps) {
  const style = useMemo(() => ({ ...DEFAULT_STYLE_CONFIG, ...styleConfig }), [styleConfig]);
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

  const numFmt = style.numberFormat ?? 'compact';
  const fontSize = style.fontSize ?? 12;
  const barRadius = style.barRadius ?? 4;
  const showDataLabels = style.showDataLabels ?? false;
  const showDots = style.showDots ?? true;
  const lineStyle = style.lineStyle ?? 'solid';
  const xAxisLabel = style.xAxisLabel || undefined;
  const yAxisLabel = style.yAxisLabel || undefined;
  const legendPosition = style.legendPosition ?? 'bottom';

  const yDomain: [number | 'auto', number | 'auto'] = [
    typeof style.yAxisMin === 'number' ? style.yAxisMin : 'auto',
    typeof style.yAxisMax === 'number' ? style.yAxisMax : 'auto',
  ];
  const yTickFormatter = (v: any) => formatNumber(v, numFmt);
  const legendProps = showLegend
    ? {
        layout: (legendPosition === 'left' || legendPosition === 'right' ? 'vertical' : 'horizontal') as 'vertical' | 'horizontal',
        verticalAlign: (legendPosition === 'top' ? 'top' : legendPosition === 'bottom' ? 'bottom' : 'middle') as 'top' | 'middle' | 'bottom',
        align: (legendPosition === 'left' ? 'left' : legendPosition === 'right' ? 'right' : 'center') as 'left' | 'center' | 'right',
      }
    : null;

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
    const { angle, height, textAnchor, interval, labelOffset } = buildXAxisProps(data.length, fontSize, xAxisLabel);
    return (
      <div className="h-full">
        {config.title && (
          <h3 className="text-lg font-semibold mb-4 text-center">{config.title}</h3>
        )}
        {wrapScrollable(
          <BarChart data={data}>
            {showGrid && <CartesianGrid strokeDasharray="3 3" />}
            <XAxis dataKey={config.xField} tick={{ fontSize, angle, textAnchor } as any} height={height} interval={interval as any} label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: labelOffset } : undefined} />
            <YAxis tickFormatter={yTickFormatter} domain={yDomain} tick={{ fontSize }} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
            <Tooltip formatter={(v: any) => formatNumber(v, numFmt)} />
            {showLegend && legendProps && <Legend {...legendProps} />}
            {usesDimensionColoring && config.yFields.length === 1 ? (
              // Single measure with dimension-based coloring
              <Bar dataKey={config.yFields[0]} radius={[barRadius, barRadius, 0, 0]}>
                {data.map((entry, index) => {
                  const key = String(entry[config.color_by_dimension!]);
                  const fill = dimensionColorMap?.[key] ?? palette.colors[index % palette.colors.length];
                  return <Cell key={`cell-${index}`} fill={fill} />;
                })}
                {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, numFmt)} style={{ fontSize: fontSize - 1 }} />}
              </Bar>
            ) : (
              // Series-based coloring (default)
              config.yFields.map((field, index) => (
                <Bar
                  key={field}
                  dataKey={field}
                  fill={getSeriesColor(field, index)}
                  radius={[barRadius, barRadius, 0, 0]}
                >
                  {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, numFmt)} style={{ fontSize: fontSize - 1 }} />}
                </Bar>
              ))
            )}
          </BarChart>,
          data.length,
        )}
      </div>
    );
  }
  if (chartType === ChartType.LINE && config.xField && config.yFields) {
    const { angle, height, textAnchor, interval, labelOffset } = buildXAxisProps(data.length, fontSize, xAxisLabel);
    return (
      <div className="h-full">
        {config.title && (
          <h3 className="text-lg font-semibold mb-4 text-center">{config.title}</h3>
        )}
        {wrapScrollable(
          <LineChart data={data}>
            {showGrid && <CartesianGrid strokeDasharray="3 3" />}
            <XAxis dataKey={config.xField} tick={{ fontSize, angle, textAnchor } as any} height={height} interval={interval as any} label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: labelOffset } : undefined} />
            <YAxis tickFormatter={yTickFormatter} domain={yDomain} tick={{ fontSize }} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
            <Tooltip formatter={(v: any) => formatNumber(v, numFmt)} />
            {showLegend && legendProps && <Legend {...legendProps} />}
            {config.yFields.map((field, index) => (
              <Line
                key={field}
                type="monotone"
                dataKey={field}
                stroke={getSeriesColor(field, index)}
                strokeWidth={2}
                dot={showDots}
                strokeDasharray={lineStyle === 'dashed' ? '5 5' : undefined}
              >
                {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, numFmt)} style={{ fontSize: fontSize - 1 }} />}
              </Line>
            ))}
          </LineChart>,
          data.length,
        )}
      </div>
    );
  }

  // Render Area Chart
  if (chartType === ChartType.AREA && config.xField && config.yFields) {
    const { angle, height, textAnchor, interval, labelOffset } = buildXAxisProps(data.length, fontSize, xAxisLabel);
    return (
      <div className="h-full">
        {config.title && (
          <h3 className="text-lg font-semibold mb-4 text-center">{config.title}</h3>
        )}
        {wrapScrollable(
          <AreaChart data={data}>
            {showGrid && <CartesianGrid strokeDasharray="3 3" />}
            <XAxis dataKey={config.xField} tick={{ fontSize, angle, textAnchor } as any} height={height} interval={interval as any} label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: labelOffset } : undefined} />
            <YAxis tickFormatter={yTickFormatter} domain={yDomain} tick={{ fontSize }} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
            <Tooltip formatter={(v: any) => formatNumber(v, numFmt)} />
            {showLegend && legendProps && <Legend {...legendProps} />}
            {config.yFields.map((field, index) => (
              <Area
                key={field}
                type="monotone"
                dataKey={field}
                stroke={getSeriesColor(field, index)}
                fill={getSeriesColor(field, index)}
                fillOpacity={0.6}
                dot={showDots}
              >
                {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, numFmt)} style={{ fontSize: fontSize - 1 }} />}
              </Area>
            ))}
          </AreaChart>,
          data.length,
        )}
      </div>
    );
  }

  // Render Grouped Bar Chart
  if (chartType === ChartType.GROUPED_BAR && config.xField && config.yFields) {
    const usesDimensionColoring = dimensionColorMap && config.color_by_dimension === config.xField;
    const { angle, height, textAnchor, interval, labelOffset } = buildXAxisProps(data.length, fontSize, xAxisLabel);
    return (
      <div className="h-full">
        {config.title && (
          <h3 className="text-lg font-semibold mb-4 text-center">{config.title}</h3>
        )}
        {wrapScrollable(
          <BarChart data={data}>
            {showGrid && <CartesianGrid strokeDasharray="3 3" />}
            <XAxis dataKey={config.xField} tick={{ fontSize, angle, textAnchor } as any} height={height} interval={interval as any} label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: labelOffset } : undefined} />
            <YAxis tickFormatter={yTickFormatter} domain={yDomain} tick={{ fontSize }} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
            <Tooltip formatter={(v: any) => formatNumber(v, numFmt)} />
            {showLegend && legendProps && <Legend {...legendProps} />}
            {usesDimensionColoring && config.yFields.length === 1 ? (
              <Bar dataKey={config.yFields[0]} radius={[barRadius, barRadius, 0, 0]}>
                {data.map((entry, index) => {
                  const key = String(entry[config.color_by_dimension!]);
                  const fill = dimensionColorMap?.[key] ?? palette.colors[index % palette.colors.length];
                  return <Cell key={`cell-${index}`} fill={fill} />;
                })}
                {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, numFmt)} style={{ fontSize: fontSize - 1 }} />}
              </Bar>
            ) : (
              config.yFields.map((field, index) => (
                <Bar
                  key={field}
                  dataKey={field}
                  fill={getSeriesColor(field, index)}
                  radius={[barRadius, barRadius, 0, 0]}
                >
                  {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, numFmt)} style={{ fontSize: fontSize - 1 }} />}
                </Bar>
              ))
            )}
          </BarChart>,
          data.length,
        )}
      </div>
    );
  }

  // Render Stacked Bar Chart
  if (chartType === ChartType.STACKED_BAR && config.xField && config.yFields) {
    const { angle, height, textAnchor, interval, labelOffset } = buildXAxisProps(data.length, fontSize, xAxisLabel);
    return (
      <div className="h-full">
        {config.title && (
          <h3 className="text-lg font-semibold mb-4 text-center">{config.title}</h3>
        )}
        {wrapScrollable(
          <BarChart data={data}>
            {showGrid && <CartesianGrid strokeDasharray="3 3" />}
            <XAxis dataKey={config.xField} tick={{ fontSize, angle, textAnchor } as any} height={height} interval={interval as any} label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: labelOffset } : undefined} />
            <YAxis tickFormatter={yTickFormatter} domain={yDomain} tick={{ fontSize }} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
            <Tooltip formatter={(v: any) => formatNumber(v, numFmt)} />
            {showLegend && legendProps && <Legend {...legendProps} />}
            {config.yFields.map((field, index) => (
              <Bar
                key={field}
                dataKey={field}
                stackId="stack"
                fill={getSeriesColor(field, index)}
                radius={index === config.yFields!.length - 1 ? [barRadius, barRadius, 0, 0] : undefined}
              >
                {showDataLabels && <LabelList position="center" formatter={(v: any) => formatNumber(v, numFmt)} style={{ fontSize: fontSize - 2, fill: '#fff' }} />}
              </Bar>
            ))}
          </BarChart>,
          data.length,
        )}
      </div>
    );
  }

  // Render Scatter Chart
  if (chartType === ChartType.SCATTER && config.xField && config.yFields && config.yFields.length > 0) {
    const usesDimensionColoring = dimensionColorMap && config.color_by_dimension;
    
    return (
      <div className="h-full">
        {config.title && (
          <h3 className="text-lg font-semibold mb-4 text-center">{config.title}</h3>
        )}
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart>
            {showGrid && <CartesianGrid strokeDasharray="3 3" />}
            <XAxis dataKey={config.xField} name={config.xField} tick={{ fontSize: fontSize }} label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: -5 } : undefined} />
            <YAxis dataKey={config.yFields[0]} name={config.yFields[0]} tickFormatter={yTickFormatter} domain={yDomain} tick={{ fontSize: fontSize }} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
            <ZAxis range={[60, 400]} />
            <Tooltip cursor={{ strokeDasharray: '3 3' }} formatter={(v: any) => formatNumber(v, numFmt)} />
            {showLegend && legendProps && <Legend {...legendProps} />}
            {usesDimensionColoring ? (
              <Scatter
                name={config.yFields[0]}
                data={data}
                fillOpacity={0.8}
              >
                {data.map((entry, idx) => {
                  const key = String(entry[config.color_by_dimension!]);
                  const fill = dimensionColorMap[key] ?? palette.colors[idx % palette.colors.length];
                  return <Cell key={idx} fill={fill} />;
                })}
              </Scatter>
            ) : (
              <Scatter
                name={config.yFields[0]}
                data={data}
                fill={getSeriesColor(config.yFields[0], 0)}
              />
            )}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // Render Pie Chart
  if (chartType === ChartType.PIE && config.labelField && config.valueField) {
    // Use dimension-based coloring if color_by_dimension is set, otherwise use single color or palette
    const usesDimensionColoring = dimensionColorMap && config.color_by_dimension;
    
    return (
      <div className="h-full">
        {config.title && (
          <h3 className="text-lg font-semibold mb-4 text-center">{config.title}</h3>
        )}
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey={config.valueField}
              nameKey={usesDimensionColoring ? config.color_by_dimension : config.labelField}
              cx="50%"
              cy="50%"
              outerRadius={120}
              label={showDataLabels ? ({ name, value }: any) => `${name}: ${formatNumber(value, numFmt)}` : true}
            >
              {data.map((entry, index) => {
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
            <Tooltip formatter={(v: any) => formatNumber(v, numFmt)} />
            {showLegend && legendProps && <Legend {...legendProps} />}
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // Render Time Series Chart
  if (chartType === ChartType.TIME_SERIES && config.timeField && config.valueField) {
    return (
      <div className="h-full">
        {config.title && (
          <h3 className="text-lg font-semibold mb-4 text-center">{config.title}</h3>
        )}
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            {showGrid && <CartesianGrid strokeDasharray="3 3" />}
            <XAxis
              dataKey={config.timeField}
              tick={{ fontSize: fontSize }}
              tickFormatter={(value) => {
                // Format timestamp to readable date
                const date = new Date(value);
                return date.toLocaleDateString();
              }}
              label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: -5 } : undefined}
            />
            <YAxis tickFormatter={yTickFormatter} domain={yDomain} tick={{ fontSize: fontSize }} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
            <Tooltip
              labelFormatter={(value) => {
                const date = new Date(value);
                return date.toLocaleString();
              }}
              formatter={(v: any) => formatNumber(v, numFmt)}
            />
            {showLegend && legendProps && <Legend {...legendProps} />}
            <Line
              type="monotone"
              dataKey={config.valueField}
              stroke={config.color || getSeriesColor(config.valueField, 0)}
              strokeWidth={2}
              dot={showDots}
              strokeDasharray={lineStyle === 'dashed' ? '5 5' : undefined}
            >
              {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, numFmt)} style={{ fontSize: fontSize - 1 }} />}
            </Line>
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // Render Horizontal Bar Chart
  if (chartType === ChartType.HORIZONTAL_BAR && config.xField && config.yFields) {
    const MIN_ROW_HEIGHT = 32;
    const isVertScroll = data.length > SCROLL_THRESHOLD;
    const chartHeight  = isVertScroll ? Math.max(data.length * MIN_ROW_HEIGHT, 400) : undefined;
    const inner = (
      <BarChart data={data} layout="vertical">
        {showGrid && <CartesianGrid strokeDasharray="3 3" />}
        <YAxis dataKey={config.xField} type="category" tick={{ fontSize }} width={120}
          label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
        <XAxis type="number" tickFormatter={yTickFormatter} tick={{ fontSize }}
          label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: -5 } : undefined} />
        <Tooltip formatter={(v: any) => formatNumber(v, numFmt)} />
        {showLegend && legendProps && <Legend {...legendProps} />}
        {config.yFields.map((field, index) => (
          <Bar key={field} dataKey={field} fill={getSeriesColor(field, index)}
            radius={[0, barRadius, barRadius, 0]}>
            {showDataLabels && <LabelList position="right" formatter={(v: any) => formatNumber(v, numFmt)} style={{ fontSize: fontSize - 1 }} />}
          </Bar>
        ))}
      </BarChart>
    );
    return (
      <div className="h-full">
        {config.title && (
          <h3 className="text-lg font-semibold mb-4 text-center">{config.title}</h3>
        )}
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
    );
  }

  // Render Bar + Line Combo Chart
  if (chartType === ChartType.BAR_LINE && config.xField && config.yFields && config.yFields.length >= 2) {
    const barFields = config.yFields.slice(0, -1);
    const lineField = config.yFields[config.yFields.length - 1];
    const { angle, height, textAnchor, interval, labelOffset } = buildXAxisProps(data.length, fontSize, xAxisLabel);
    return (
      <div className="h-full">
        {config.title && (
          <h3 className="text-lg font-semibold mb-4 text-center">{config.title}</h3>
        )}
        {wrapScrollable(
          <ComposedChart data={data}>
            {showGrid && <CartesianGrid strokeDasharray="3 3" />}
            <XAxis dataKey={config.xField} tick={{ fontSize, angle, textAnchor } as any} height={height} interval={interval as any} label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: labelOffset } : undefined} />
            <YAxis tickFormatter={yTickFormatter} domain={yDomain} tick={{ fontSize }} label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft' } : undefined} />
            <Tooltip formatter={(v: any) => formatNumber(v, numFmt)} />
            {showLegend && legendProps && <Legend {...legendProps} />}
            {barFields.map((field, index) => (
              <Bar key={field} dataKey={field} fill={getSeriesColor(field, index)}
                radius={[barRadius, barRadius, 0, 0]}>
                {showDataLabels && <LabelList position="top" formatter={(v: any) => formatNumber(v, numFmt)} style={{ fontSize: fontSize - 1 }} />}
              </Bar>
            ))}
            <Line type="monotone" dataKey={lineField} stroke={getSeriesColor(lineField, barFields.length)}
              strokeWidth={2} dot={showDots} strokeDasharray={lineStyle === 'dashed' ? '5 5' : undefined} />
          </ComposedChart>,
          data.length,
        )}
      </div>
    );
  }

  // Render Table
  if (chartType === ChartType.TABLE) {
    const columns = data.length > 0 ? Object.keys(data[0]) : [];
    return (
      <div className="h-full">
        {config.title && (
          <h3 className="text-lg font-semibold mb-4 text-center">{config.title}</h3>
        )}
        <TableVisualization
          data={data}
          columns={columns}
          maxRows={50}
        />
      </div>
    );
  }

  // Render KPI Card
  if (chartType === ChartType.KPI && config.valueField) {
    const value = data[0]?.[config.valueField] ?? null;
    const label = config.labelField ? String(data[0]?.[config.labelField] || config.title || 'KPI') : (config.title || 'KPI');
    
    return (
      <div className="w-full flex items-center justify-center" style={{ minHeight: '400px' }}>
        <div className="w-full max-w-md">
          <KpiCard
            value={value}
            label={label}
          />
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
