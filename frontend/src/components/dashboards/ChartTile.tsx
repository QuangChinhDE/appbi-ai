'use client';

import React, { useMemo } from 'react';
import { X, Loader2 } from 'lucide-react';
import { useChart, useChartData } from '@/hooks/use-charts';
import { ChartPreview } from '@/components/charts/ChartPreview';
import { DashboardFilter, applyFiltersToRows } from '@/lib/filters';

interface ChartTileProps {
  chartId: number;
  dashboardChartId: number;
  datasetId: number;
  onRemove: (dashboardChartId: number) => void;
  isRemoving?: boolean;
  dashboardFilters?: DashboardFilter[];
  onDataLoaded?: (datasetId: number, data: any[]) => void;
}

export function ChartTile({ 
  chartId, 
  dashboardChartId, 
  datasetId,
  onRemove, 
  isRemoving,
  dashboardFilters = [],
  onDataLoaded,
}: ChartTileProps) {
  const { data: chart, isLoading: isLoadingChart } = useChart(chartId);
  const { data: chartData, isLoading: isLoadingData } = useChartData(chartId);

  // Notify parent when data is loaded (for filter dropdown options)
  React.useEffect(() => {
    if (chartData?.data && onDataLoaded && datasetId) {
      onDataLoaded(datasetId, chartData.data);
    }
  }, [chartData?.data, onDataLoaded, datasetId]);

  // Filter chart data based on dashboard filters for this dataset
  const filteredData = useMemo(() => {
    if (!chartData?.data) return [];
    
    // Get filters that apply to this chart's dataset
    const filtersForThisChart = dashboardFilters.filter(
      (f) => f.datasetId === datasetId
    );
    
    // Apply filters (client-side v1)
    return applyFiltersToRows(chartData.data, filtersForThisChart);
  }, [chartData?.data, dashboardFilters, datasetId]);

  // Transform Explore config to ChartPreview config
  const chartConfig = useMemo(() => {
    if (!chart?.config) return {};
    
    const config = chart.config as any;
    
    // If config has dimensions/measures (from Explore), transform it
    if (config.dimensions || config.measures) {
      return {
        xField: config.dimensions?.[0], // First dimension as X axis
        yFields: config.measures || [], // All measures as Y fields
        showLegend: true,
        showGrid: true,
        ...config, // Keep other config properties
      };
    }
    
    // Otherwise use config as-is (standard chart config)
    return config;
  }, [chart?.config]);

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
          data={filteredData}
          config={chartConfig}
        />
      </div>
    </div>
  );
}
