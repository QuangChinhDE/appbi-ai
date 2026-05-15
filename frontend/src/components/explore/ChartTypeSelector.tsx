'use client';

import React from 'react';
import { ChartType } from '@/types/api';
import { BarChart3, LineChart, PieChart, TrendingUp, Table, AreaChart, BarChart4, BarChart2, ScatterChart, Activity, Trophy } from 'lucide-react';
import { Button } from '@/components/ui/Button';

type ChartTypeMeta = {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

/**
 * Display metadata for every value in {@link ChartType}. Keyed by the enum
 * literal so adding a new type to `ChartType` causes a TypeScript compile
 * error here — preventing the Phase-3 incident where two new types
 * (HORIZONTAL_BAR, BAR_LINE) shipped in the enum but were silently missing
 * from the picker for weeks.
 */
const CHART_TYPE_META: Record<ChartType, ChartTypeMeta> = {
  [ChartType.BAR]: { label: 'Bar', icon: BarChart3 },
  [ChartType.HORIZONTAL_BAR]: { label: 'Horizontal Bar', icon: BarChart2 },
  [ChartType.GROUPED_BAR]: { label: 'Grouped Bar', icon: BarChart2 },
  [ChartType.STACKED_BAR]: { label: 'Stacked Bar', icon: BarChart4 },
  [ChartType.LINE]: { label: 'Line', icon: LineChart },
  [ChartType.BAR_LINE]: { label: 'Bar + Line', icon: BarChart4 },
  [ChartType.AREA]: { label: 'Area', icon: AreaChart },
  [ChartType.SCATTER]: { label: 'Scatter', icon: ScatterChart },
  [ChartType.BUBBLE]: { label: 'Bubble', icon: ScatterChart },
  [ChartType.PIE]: { label: 'Pie', icon: PieChart },
  [ChartType.DONUT]: { label: 'Donut', icon: PieChart },
  [ChartType.POLAR_AREA]: { label: 'Polar Area', icon: PieChart },
  [ChartType.RADAR]: { label: 'Radar', icon: TrendingUp },
  [ChartType.TIME_SERIES]: { label: 'Time Series', icon: TrendingUp },
  [ChartType.TABLE]: { label: 'Table', icon: Table },
  [ChartType.MATRIX]: { label: 'Matrix', icon: Table },
  [ChartType.HEATMAP]: { label: 'Heatmap', icon: Table },
  [ChartType.TREEMAP]: { label: 'Treemap', icon: BarChart4 },
  [ChartType.FUNNEL]: { label: 'Funnel', icon: BarChart4 },
  [ChartType.GAUGE]: { label: 'Gauge', icon: Activity },
  [ChartType.WATERFALL]: { label: 'Waterfall', icon: BarChart3 },
  [ChartType.MAP_POINT]: { label: 'Point Map', icon: ScatterChart },
  [ChartType.MAP_REGION]: { label: 'Region Map', icon: Table },
  [ChartType.BOXPLOT]: { label: 'Boxplot', icon: BarChart2 },
  [ChartType.BULLET]: { label: 'Bullet', icon: Activity },
  [ChartType.SANKEY]: { label: 'Sankey', icon: TrendingUp },
  [ChartType.SUNBURST]: { label: 'Sunburst', icon: PieChart },
  [ChartType.RIBBON]: { label: 'Ribbon', icon: TrendingUp },
  [ChartType.TIMELINE]: { label: 'Timeline', icon: TrendingUp },
  [ChartType.WORD_CLOUD]: { label: 'Word Cloud', icon: BarChart3 },
  [ChartType.KPI]: { label: 'KPI', icon: Activity },
  [ChartType.PODIUM]: { label: 'Podium', icon: Trophy },
};

// Build options list by iterating the enum directly — single source of
// truth. Order follows enum declaration order.
const chartTypeOptions = Object.values(ChartType).map((type) => ({
  type,
  ...CHART_TYPE_META[type],
}));

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
