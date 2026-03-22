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
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ZAxis,
} from 'recharts';
import { ChartType } from '@/types/api';
import { TableVisualization } from '@/components/visualizations/TableVisualization';
import { KpiCard } from '@/components/visualizations/KpiCard';
import { getPalette, buildDimensionColorMap, ChartPaletteName, DEFAULT_CHART_THEME } from '@/lib/chartColors';

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

export function ChartPreview({ chartType, data, config }: ChartPreviewProps) {
  // Get palette
  const paletteName = (config.palette as ChartPaletteName) ?? DEFAULT_CHART_THEME.defaultPalette;
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

  const showLegend = config.showLegend !== false;
  const showGrid = config.showGrid !== false;

  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 bg-gray-50 border border-gray-200 rounded-lg">
        <p className="text-gray-500">No data to display</p>
      </div>
    );
  }

  // Render Bar Chart
  if (chartType === ChartType.BAR && config.xField && config.yFields) {
    // If color_by_dimension is set and it's the xField, color each bar by category
    const usesDimensionColoring = dimensionColorMap && config.color_by_dimension === config.xField;
    
    return (
      <div className="h-full">
        {config.title && (
          <h3 className="text-lg font-semibold mb-4 text-center">{config.title}</h3>
        )}
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            {showGrid && <CartesianGrid strokeDasharray="3 3" />}
            <XAxis dataKey={config.xField} />
            <YAxis />
            <Tooltip />
            {showLegend && <Legend />}
            {usesDimensionColoring && config.yFields.length === 1 ? (
              // Single measure with dimension-based coloring
              <Bar dataKey={config.yFields[0]}>
                {data.map((entry, index) => {
                  const key = String(entry[config.color_by_dimension!]);
                  const fill = dimensionColorMap?.[key] ?? palette.colors[index % palette.colors.length];
                  return <Cell key={`cell-${index}`} fill={fill} />;
                })}
              </Bar>
            ) : (
              // Series-based coloring (default)
              config.yFields.map((field, index) => (
                <Bar
                  key={field}
                  dataKey={field}
                  fill={getSeriesColor(field, index)}
                />
              ))
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // Render Line Chart
  if (chartType === ChartType.LINE && config.xField && config.yFields) {
    return (
      <div className="h-full">
        {config.title && (
          <h3 className="text-lg font-semibold mb-4 text-center">{config.title}</h3>
        )}
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            {showGrid && <CartesianGrid strokeDasharray="3 3" />}
            <XAxis dataKey={config.xField} />
            <YAxis />
            <Tooltip />
            {showLegend && <Legend />}
            {config.yFields.map((field, index) => (
              <Line
                key={field}
                type="monotone"
                dataKey={field}
                stroke={getSeriesColor(field, index)}
                strokeWidth={2}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // Render Area Chart
  if (chartType === ChartType.AREA && config.xField && config.yFields) {
    return (
      <div className="h-full">
        {config.title && (
          <h3 className="text-lg font-semibold mb-4 text-center">{config.title}</h3>
        )}
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            {showGrid && <CartesianGrid strokeDasharray="3 3" />}
            <XAxis dataKey={config.xField} />
            <YAxis />
            <Tooltip />
            {showLegend && <Legend />}
            {config.yFields.map((field, index) => (
              <Area
                key={field}
                type="monotone"
                dataKey={field}
                stroke={getSeriesColor(field, index)}
                fill={getSeriesColor(field, index)}
                fillOpacity={0.6}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // Render Grouped Bar Chart
  if (chartType === ChartType.GROUPED_BAR && config.xField && config.yFields) {
    const usesDimensionColoring = dimensionColorMap && config.color_by_dimension === config.xField;
    
    return (
      <div className="h-full">
        {config.title && (
          <h3 className="text-lg font-semibold mb-4 text-center">{config.title}</h3>
        )}
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            {showGrid && <CartesianGrid strokeDasharray="3 3" />}
            <XAxis dataKey={config.xField} />
            <YAxis />
            <Tooltip />
            {showLegend && <Legend />}
            {usesDimensionColoring && config.yFields.length === 1 ? (
              <Bar dataKey={config.yFields[0]}>
                {data.map((entry, index) => {
                  const key = String(entry[config.color_by_dimension!]);
                  const fill = dimensionColorMap?.[key] ?? palette.colors[index % palette.colors.length];
                  return <Cell key={`cell-${index}`} fill={fill} />;
                })}
              </Bar>
            ) : (
              config.yFields.map((field, index) => (
                <Bar
                  key={field}
                  dataKey={field}
                  fill={getSeriesColor(field, index)}
                />
              ))
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // Render Stacked Bar Chart
  if (chartType === ChartType.STACKED_BAR && config.xField && config.yFields) {
    // For stacked bar, dimension coloring applies to the series (not individual bars)
    return (
      <div className="h-full">
        {config.title && (
          <h3 className="text-lg font-semibold mb-4 text-center">{config.title}</h3>
        )}
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            {showGrid && <CartesianGrid strokeDasharray="3 3" />}
            <XAxis dataKey={config.xField} />
            <YAxis />
            <Tooltip />
            {showLegend && <Legend />}
            {config.yFields.map((field, index) => (
              <Bar
                key={field}
                dataKey={field}
                stackId="stack"
                fill={getSeriesColor(field, index)}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
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
            <XAxis dataKey={config.xField} name={config.xField} />
            <YAxis dataKey={config.yFields[0]} name={config.yFields[0]} />
            <ZAxis range={[60, 400]} />
            <Tooltip cursor={{ strokeDasharray: '3 3' }} />
            {showLegend && <Legend />}
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
              label
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
            <Tooltip />
            {showLegend && <Legend />}
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
              tickFormatter={(value) => {
                // Format timestamp to readable date
                const date = new Date(value);
                return date.toLocaleDateString();
              }}
            />
            <YAxis />
            <Tooltip
              labelFormatter={(value) => {
                const date = new Date(value);
                return date.toLocaleString();
              }}
            />
            {showLegend && <Legend />}
            <Line
              type="monotone"
              dataKey={config.valueField}
              stroke={config.color || getSeriesColor(config.valueField, 0)}
              strokeWidth={2}
            />
          </LineChart>
        </ResponsiveContainer>
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
