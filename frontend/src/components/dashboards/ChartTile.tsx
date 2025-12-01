'use client';

import React from 'react';
import { X, Loader2 } from 'lucide-react';
import { useChart, useChartData } from '@/hooks/use-charts';
import { ChartPreview } from '@/components/charts/ChartPreview';

interface ChartTileProps {
  chartId: number;
  dashboardChartId: number;
  onRemove: (dashboardChartId: number) => void;
  isRemoving?: boolean;
}

export function ChartTile({ chartId, dashboardChartId, onRemove, isRemoving }: ChartTileProps) {
  const { data: chart, isLoading: isLoadingChart } = useChart(chartId);
  const { data: chartData, isLoading: isLoadingData } = useChartData(chartId);

  if (isLoadingChart || isLoadingData) {
    return (
      <div className="h-full bg-white rounded-lg border border-gray-200 p-6 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (!chart || !chartData) {
    return (
      <div className="h-full bg-white rounded-lg border border-gray-200 p-6 flex items-center justify-center">
        <p className="text-gray-500">Failed to load chart</p>
      </div>
    );
  }

  return (
    <div className="h-full bg-white rounded-lg border border-gray-200 p-4 overflow-hidden relative group">
      {/* Remove button - shows on hover */}
      <button
        onClick={() => onRemove(dashboardChartId)}
        disabled={isRemoving}
        className="absolute top-2 right-2 z-10 p-1.5 bg-white border border-gray-300 rounded-md shadow-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-50 hover:border-red-300 disabled:opacity-50"
        title="Remove chart"
      >
        {isRemoving ? (
          <Loader2 className="h-4 w-4 text-red-600 animate-spin" />
        ) : (
          <X className="h-4 w-4 text-red-600" />
        )}
      </button>

      {/* Chart title */}
      <div className="mb-3">
        <h3 className="text-sm font-semibold truncate">{chart.name}</h3>
        {chart.description && (
          <p className="text-xs text-gray-500 truncate">{chart.description}</p>
        )}
      </div>

      {/* Chart visualization */}
      <div className="h-[calc(100%-3rem)] overflow-hidden">
        <ChartPreview
          chartType={chart.chart_type}
          data={chartData.data}
          config={chart.config}
        />
      </div>
    </div>
  );
}
