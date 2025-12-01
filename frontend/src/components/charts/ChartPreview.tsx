'use client';

import React from 'react';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { ChartType } from '@/types/api';

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
    showLegend?: boolean;
    showGrid?: boolean;
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
  const colors = config.colors || DEFAULT_COLORS;
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
    return (
      <div className="w-full">
        {config.title && (
          <h3 className="text-lg font-semibold mb-4 text-center">{config.title}</h3>
        )}
        <ResponsiveContainer width="100%" height={400}>
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
                fill={colors[index % colors.length]}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // Render Line Chart
  if (chartType === ChartType.LINE && config.xField && config.yFields) {
    return (
      <div className="w-full">
        {config.title && (
          <h3 className="text-lg font-semibold mb-4 text-center">{config.title}</h3>
        )}
        <ResponsiveContainer width="100%" height={400}>
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
                stroke={colors[index % colors.length]}
                strokeWidth={2}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // Render Pie Chart
  if (chartType === ChartType.PIE && config.labelField && config.valueField) {
    return (
      <div className="w-full">
        {config.title && (
          <h3 className="text-lg font-semibold mb-4 text-center">{config.title}</h3>
        )}
        <ResponsiveContainer width="100%" height={400}>
          <PieChart>
            <Pie
              data={data}
              dataKey={config.valueField}
              nameKey={config.labelField}
              cx="50%"
              cy="50%"
              outerRadius={120}
              label
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
              ))}
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
      <div className="w-full">
        {config.title && (
          <h3 className="text-lg font-semibold mb-4 text-center">{config.title}</h3>
        )}
        <ResponsiveContainer width="100%" height={400}>
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
              stroke={colors[0]}
              strokeWidth={2}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-64 bg-gray-50 border border-gray-200 rounded-lg">
      <p className="text-gray-500">Invalid chart configuration</p>
    </div>
  );
}
