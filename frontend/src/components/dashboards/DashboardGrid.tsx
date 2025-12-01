'use client';

import React from 'react';
import { Responsive, WidthProvider, Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { ChartTile } from './ChartTile';
import { DashboardChart } from '@/types/api';

const ResponsiveGridLayout = WidthProvider(Responsive);

interface DashboardGridProps {
  dashboardCharts: DashboardChart[];
  onLayoutChange: (layouts: Layout[]) => void;
  onRemoveChart: (dashboardChartId: number) => void;
  removingChartId?: number;
}

export function DashboardGrid({
  dashboardCharts,
  onLayoutChange,
  onRemoveChart,
  removingChartId,
}: DashboardGridProps) {
  // Convert backend layout to react-grid-layout format
  const layouts = dashboardCharts.map((dc) => {
    const layout = dc.layout as Record<string, number>;
    return {
      i: dc.id.toString(),
      x: layout.x || 0,
      y: layout.y || 0,
      w: layout.w || 4,
      h: layout.h || 4,
      minW: 2,
      minH: 2,
    };
  });

  const handleLayoutChange = (newLayout: Layout[]) => {
    // Only trigger if layout actually changed
    const hasChanged = newLayout.some((item, index) => {
      const oldItem = layouts[index];
      return (
        oldItem &&
        (item.x !== oldItem.x ||
          item.y !== oldItem.y ||
          item.w !== oldItem.w ||
          item.h !== oldItem.h)
      );
    });

    if (hasChanged) {
      onLayoutChange(newLayout);
    }
  };

  if (dashboardCharts.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 bg-gray-50 border-2 border-dashed border-gray-300 rounded-lg">
        <p className="text-gray-500">
          No charts in this dashboard. Click "Add Chart" to get started.
        </p>
      </div>
    );
  }

  return (
    <ResponsiveGridLayout
      className="layout"
      layouts={{ lg: layouts }}
      breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
      cols={{ lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 }}
      rowHeight={80}
      onLayoutChange={handleLayoutChange}
      draggableHandle=".drag-handle"
      isDraggable={true}
      isResizable={true}
      compactType="vertical"
      preventCollision={false}
    >
      {dashboardCharts.map((dc) => (
        <div key={dc.id.toString()} className="drag-handle">
          <ChartTile
            chartId={dc.chart_id}
            dashboardChartId={dc.id}
            onRemove={onRemoveChart}
            isRemoving={removingChartId === dc.id}
          />
        </div>
      ))}
    </ResponsiveGridLayout>
  );
}
