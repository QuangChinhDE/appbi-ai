'use client';

import React, { useMemo } from 'react';
import { ChartType, SortConfig, ConditionalFormatRule, DimensionConfig, MeasureConfig } from '@/types/api';
import { Loader2, AlertCircle } from 'lucide-react';
import { ChartPreview } from '@/components/charts/ChartPreview';
import { TableVisualization } from '@/components/visualizations/TableVisualization';
import { ChartPaletteName } from '@/lib/chartColors';

interface VisualizationPanelProps {
  queryResult: any;
  isExecuting: boolean;
  error: string | null;
  chartType: ChartType;
  viewMode: 'table' | 'chart';
  selectedDimensions: string[];
  selectedMeasures: string[];
  dimensionConfigs?: DimensionConfig[];
  measureConfigs?: MeasureConfig[];
  singleColor?: string | null;
  seriesColors?: Record<string, string>;
  palette?: ChartPaletteName;
  colorByDimension?: string | null;
  // Explore 2.0
  sorts?: SortConfig[];
  onSortChange?: (sorts: SortConfig[]) => void;
  conditionalFormatting?: ConditionalFormatRule[];
  onRowDrilldown?: (row: any) => void;
  enableDrilldown?: boolean;
}

export function VisualizationPanel({
  queryResult,
  isExecuting,
  error,
  chartType,
  viewMode,
  selectedDimensions,
  selectedMeasures,
  dimensionConfigs = [],
  measureConfigs = [],
  singleColor,
  seriesColors,
  palette,
  colorByDimension,
  sorts = [],
  onSortChange,
  conditionalFormatting = [],
  onRowDrilldown,
  enableDrilldown = false
}: VisualizationPanelProps) {
  // Build chart config with useMemo to ensure re-render on color change
  const chartConfig = useMemo(() => {
    const config: Record<string, any> = {};
    
    // Helper to get display key (label or field)
    const getDimensionKey = (field: string) => {
      const dimConfig = dimensionConfigs.find(dc => dc.field === field);
      return dimConfig?.label || field;
    };
    
    const getMeasureKey = (fullMeasure: string) => {
      // fullMeasure format: "field_agg" e.g. "total_gia_sum"
      const parts = fullMeasure.split('_');
      const agg = parts[parts.length - 1];
      const field = parts.slice(0, -1).join('_');
      const measureConfig = measureConfigs.find(mc => mc.field === field && mc.agg === agg);
      return measureConfig?.label || fullMeasure;
    };
    
    if (chartType === ChartType.BAR || chartType === ChartType.LINE || chartType === ChartType.TIME_SERIES ||
        chartType === ChartType.AREA || chartType === ChartType.STACKED_BAR || chartType === ChartType.GROUPED_BAR ||
        chartType === ChartType.SCATTER) {
      config.xField = getDimensionKey(selectedDimensions[0]);
      config.yFields = selectedMeasures.map(m => getMeasureKey(m));
      
      // Add stacking config for stacked bar
      if (chartType === ChartType.STACKED_BAR) {
        config.stacked = true;
      }
    } else if (chartType === ChartType.PIE) {
      config.labelField = getDimensionKey(selectedDimensions[0]);
      config.valueField = getMeasureKey(selectedMeasures[0]);
    } else if (chartType === ChartType.KPI) {
      config.valueField = getMeasureKey(selectedMeasures[0]);
      config.labelField = selectedDimensions[0] ? getDimensionKey(selectedDimensions[0]) : undefined;
    }
    
    // Add color configuration
    if (singleColor) {
      config.color = singleColor;
    }
    if (seriesColors && Object.keys(seriesColors).length > 0) {
      // Map seriesColors keys from technical names to display labels
      const mappedSeriesColors: Record<string, string> = {};
      Object.entries(seriesColors).forEach(([technicalKey, color]) => {
        const displayKey = getMeasureKey(technicalKey);
        mappedSeriesColors[displayKey] = color;
      });
      config.series_colors = mappedSeriesColors;
    }
    if (palette) {
      config.palette = palette;
    }
    if (colorByDimension) {
      // Map dimension key to display label
      const mappedColorDimension = getDimensionKey(colorByDimension);
      config.color_by_dimension = mappedColorDimension;
    }
    
    return config;
  }, [chartType, selectedDimensions, selectedMeasures, dimensionConfigs, measureConfigs, singleColor, seriesColors, palette, colorByDimension]);
  
  // For TABLE: no config needed, will use raw data

  const showChart = viewMode === 'chart' && selectedDimensions.length > 0 && selectedMeasures.length > 0;
  
  // Extract columns from data
  const columns = queryResult?.data?.[0] ? Object.keys(queryResult.data[0]) : [];

  return (
    <div className="bg-white rounded-lg shadow-sm ring-1 ring-gray-200 flex flex-col h-full">
      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {isExecuting && (
          <div className="flex flex-col items-center justify-center h-full text-gray-500">
            <Loader2 className="h-8 w-8 animate-spin mb-2" />
            <p>Executing query...</p>
          </div>
        )}

        {error && !isExecuting && (
          <div className="flex flex-col items-center justify-center h-full text-red-600">
            <AlertCircle className="h-8 w-8 mb-2" />
            <p className="font-medium">Query Error</p>
            <p className="text-sm text-gray-600 mt-1">{error}</p>
          </div>
        )}

        {!queryResult && !isExecuting && !error && (
          <div className="flex flex-col items-center justify-center h-full text-gray-400">
            <p className="text-lg font-medium">Start Exploring</p>
            <p className="text-sm mt-2">Select a dataset and choose fields to visualize</p>
          </div>
        )}

        {queryResult && !isExecuting && !error && (
          <>
            {viewMode === 'table' || !showChart ? (
              <div className="overflow-auto">
                <TableVisualization
                  data={queryResult.data}
                  columns={columns}
                  sorts={sorts}
                  onSortChange={onSortChange}
                  conditionalFormatting={conditionalFormatting}
                  onRowClick={onRowDrilldown}
                  enableDrilldown={enableDrilldown}
                />
              </div>
            ) : (
              <div className="h-[500px]">
                <ChartPreview
                  key={JSON.stringify(chartConfig.color) + JSON.stringify(chartConfig.series_colors) + JSON.stringify(chartConfig.palette) + JSON.stringify(chartConfig.color_by_dimension)}
                  chartType={chartType}
                  data={queryResult.data}
                  config={chartConfig}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
