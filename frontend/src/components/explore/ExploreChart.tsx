/**
 * Chart visualization component for Explore page
 */
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

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

type ChartType = 'BAR' | 'LINE' | 'PIE';

interface ExploreChartProps {
  type: ChartType;
  data: Record<string, any>[];
  dimensions: string[];
  measures: string[];
}

export function ExploreChart({ type, data, dimensions, measures }: ExploreChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500">
        <p>No data to display</p>
      </div>
    );
  }

  if (dimensions.length === 0 || measures.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500">
        <p>Select at least one dimension and one measure to view chart</p>
      </div>
    );
  }

  const xAxisKey = dimensions[0];
  const yAxisKeys = measures;

  // For pie chart, use first measure only
  if (type === 'PIE') {
    const pieData = data.map((row) => ({
      name: String(row[xAxisKey] || 'Unknown'),
      value: Number(row[measures[0]]) || 0,
    }));

    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={pieData}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            outerRadius={150}
            label={(entry) => `${entry.name}: ${entry.value}`}
          >
            {pieData.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (type === 'LINE') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey={xAxisKey} />
          <YAxis />
          <Tooltip />
          <Legend />
          {yAxisKeys.map((key, index) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={COLORS[index % COLORS.length]}
              strokeWidth={2}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  // Default: BAR
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey={xAxisKey} />
        <YAxis />
        <Tooltip />
        <Legend />
        {yAxisKeys.map((key, index) => (
          <Bar key={key} dataKey={key} fill={COLORS[index % COLORS.length]} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
