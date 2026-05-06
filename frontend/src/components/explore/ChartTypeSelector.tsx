'use client';

import React from 'react';
import { ChartType } from '@/types/api';
import { BarChart3, LineChart, PieChart, TrendingUp, Table, AreaChart, BarChart4, BarChart2, ScatterChart, Activity, Trophy } from 'lucide-react';
import { Button } from '@/components/ui/Button';

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
  { type: ChartType.BUBBLE, label: 'Bubble', icon: ScatterChart },
  { type: ChartType.PIE, label: 'Pie', icon: PieChart },
  { type: ChartType.DONUT, label: 'Donut', icon: PieChart },
  { type: ChartType.POLAR_AREA, label: 'Polar Area', icon: PieChart },
  { type: ChartType.RADAR, label: 'Radar', icon: TrendingUp },
  { type: ChartType.TIME_SERIES, label: 'Time Series', icon: TrendingUp },
  { type: ChartType.TABLE, label: 'Table', icon: Table },
  { type: ChartType.MATRIX, label: 'Matrix', icon: Table },
  { type: ChartType.HEATMAP, label: 'Heatmap', icon: Table },
  { type: ChartType.TREEMAP, label: 'Treemap', icon: BarChart4 },
  { type: ChartType.FUNNEL, label: 'Funnel', icon: BarChart4 },
  { type: ChartType.GAUGE, label: 'Gauge', icon: Activity },
  { type: ChartType.WATERFALL, label: 'Waterfall', icon: BarChart3 },
  { type: ChartType.MAP_POINT, label: 'Point Map', icon: ScatterChart },
  { type: ChartType.MAP_REGION, label: 'Region Map', icon: Table },
  { type: ChartType.BOXPLOT, label: 'Boxplot', icon: BarChart2 },
  { type: ChartType.BULLET, label: 'Bullet', icon: Activity },
  { type: ChartType.SANKEY, label: 'Sankey', icon: TrendingUp },
  { type: ChartType.SUNBURST, label: 'Sunburst', icon: PieChart },
  { type: ChartType.RIBBON, label: 'Ribbon', icon: TrendingUp },
  { type: ChartType.TIMELINE, label: 'Timeline', icon: TrendingUp },
  { type: ChartType.WORD_CLOUD, label: 'Word Cloud', icon: BarChart3 },
  { type: ChartType.KPI, label: 'KPI', icon: Activity },
  { type: ChartType.PODIUM, label: 'Podium', icon: Trophy },
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
          <Button
            key={option.type}
            size="sm"
            variant={isSelected ? 'primary' : 'secondary'}
            onClick={() => onChange(option.type)}
            leadingIcon={<Icon className="h-3.5 w-3.5" />}
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}
