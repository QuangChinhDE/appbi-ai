'use client';

import React from 'react';
import { ChartType } from '@/types/api';
import { BarChart3, LineChart, PieChart, TrendingUp, Table, AreaChart, BarChart4, BarChart2, ScatterChart, Activity } from 'lucide-react';

type ChartTypeOption = {
  type: ChartType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

const chartTypeOptions: ChartTypeOption[] = [
  { type: ChartType.BAR, label: 'Bar', icon: BarChart3 },
  { type: ChartType.GROUPED_BAR, label: 'Grouped Bar', icon: BarChart2 },
  { type: ChartType.STACKED_BAR, label: 'Stacked Bar', icon: BarChart4 },
  { type: ChartType.LINE, label: 'Line', icon: LineChart },
  { type: ChartType.AREA, label: 'Area', icon: AreaChart },
  { type: ChartType.SCATTER, label: 'Scatter', icon: ScatterChart },
  { type: ChartType.PIE, label: 'Pie', icon: PieChart },
  { type: ChartType.TIME_SERIES, label: 'Time Series', icon: TrendingUp },
  { type: ChartType.TABLE, label: 'Table', icon: Table },
  { type: ChartType.KPI, label: 'KPI', icon: Activity },
];

type ChartTypeSelectorProps = {
  chartType: ChartType;
  onChange: (type: ChartType) => void;
};

export function ChartTypeSelector({ chartType, onChange }: ChartTypeSelectorProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {chartTypeOptions.map((option) => {
        const Icon = option.icon;
        const isSelected = chartType === option.type;
        
        return (
          <button
            key={option.type}
            onClick={() => onChange(option.type)}
            className={`
              flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors
              ${isSelected
                ? 'bg-blue-600 text-white'
                : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'
              }
            `}
          >
            <Icon className="w-4 h-4" />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
