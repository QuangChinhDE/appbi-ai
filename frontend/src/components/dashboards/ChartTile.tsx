'use client';

import React, { useMemo, useState, useRef, useEffect } from 'react';
import { X, Loader2, Pencil, Check } from 'lucide-react';
import { useChart, useChartData } from '@/hooks/use-charts';
import { ChartPreview } from '@/components/charts/ChartPreview';
import { ExploreChart } from '@/components/explore/ExploreChart';
import { applyFilters } from '@/lib/explore-utils';
import type { ChartRoleConfig, AggFn } from '@/components/explore/ExploreChartConfig';
import { DashboardFilter, applyFiltersToRows } from '@/lib/filters';
import { dashboardApi } from '@/lib/api/dashboards';
import { useQueryClient } from '@tanstack/react-query';

interface ChartTileProps {
  chartId: number;
  dashboardChartId: number;
  dashboardId: number;
  currentLayout: Record<string, any>;
  datasetId: number;
  onRemove: (dashboardChartId: number) => void;
  isRemoving?: boolean;
  dashboardFilters?: DashboardFilter[];
  onDataLoaded?: (datasetId: number, data: any[]) => void;
  instanceParameters?: Record<string, any>;
}

export function ChartTile({ 
  chartId, 
  dashboardChartId,
  dashboardId,
  currentLayout,
  datasetId,
  onRemove, 
  isRemoving,
  dashboardFilters = [],
  onDataLoaded,
  instanceParameters,
}: ChartTileProps) {
  const queryClient = useQueryClient();
  const { data: chart, isLoading: isLoadingChart } = useChart(chartId);
  const { data: chartData, isLoading: isLoadingData } = useChartData(chartId);

  // Title editing state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState('');
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const customTitle: string | undefined = currentLayout?.custom_title;
  const displayTitle = customTitle ?? chart?.name ?? '';

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  const startEditingTitle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setTitleInput(displayTitle);
    setIsEditingTitle(true);
  };

  const saveTitle = async () => {
    const newTitle = titleInput.trim();
    if (!newTitle || newTitle === displayTitle) {
      setIsEditingTitle(false);
      return;
    }
    setIsSavingTitle(true);
    try {
      await dashboardApi.updateLayout(dashboardId, [{
        id: dashboardChartId,
        layout: { ...currentLayout, custom_title: newTitle },
      }]);
      queryClient.invalidateQueries({ queryKey: ['dashboards', dashboardId] });
    } finally {
      setIsSavingTitle(false);
      setIsEditingTitle(false);
    }
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') saveTitle();
    if (e.key === 'Escape') setIsEditingTitle(false);
  };

  // Notify parent when data is loaded (for filter dropdown options)
  React.useEffect(() => {
    if (chartData?.data && onDataLoaded && datasetId) {
      onDataLoaded(datasetId, chartData.data);
    }
  }, [chartData?.data, onDataLoaded, datasetId]);

  const rawRows: Record<string, any>[] = chartData?.data ?? [];

  // Detect whether this is an Explore-format chart (has roleConfig)
  const exploreConfig = useMemo(() => {
    const config = chart?.config as any;
    if (!config?.roleConfig) return null;
    const rc = config.roleConfig as ChartRoleConfig;
    // Migrate legacy string[] metrics
    if (rc.metrics?.length > 0 && typeof (rc.metrics as any)[0] === 'string') {
      rc.metrics = (rc.metrics as unknown as string[]).map(f => ({ field: f, agg: 'sum' as AggFn }));
    }
    return { chartType: config.chartType as string, roleConfig: rc, filters: config.filters ?? [] };
  }, [chart?.config]);

  // Apply Explore-style filters (from stored config) then dashboard filters client-side
  const filteredData = useMemo(() => {
    if (rawRows.length === 0) return rawRows;
    let rows = exploreConfig?.filters?.length
      ? applyFilters(rawRows, exploreConfig.filters)
      : rawRows;
    if (!exploreConfig && dashboardFilters.length > 0) {
      const forThisChart = dashboardFilters.filter(f => f.datasetId === datasetId);
      rows = applyFiltersToRows(rows, forThisChart);
    }
    return rows;
  }, [rawRows, exploreConfig, dashboardFilters, datasetId]);

  // Legacy ChartPreview config (only used for non-Explore charts)
  const legacyChartConfig = useMemo(() => {
    if (!chart?.config || exploreConfig) return {};
    const config = chart.config as any;
    if (config.dimensions || config.measures) {
      return { xField: config.dimensions?.[0], yFields: config.measures || [], showLegend: true, showGrid: true, ...config };
    }
    return config;
  }, [chart?.config, exploreConfig]);

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
    <div className="h-full bg-white rounded-lg border border-gray-200 p-3 overflow-hidden relative group flex flex-col">
      {/* Remove button — outside drag handle so clicks always register */}
      <button
        onMouseDown={e => e.stopPropagation()}
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

      {/* Drag handle + editable title + parameter chips */}
      <div className="drag-handle mb-2 flex flex-col gap-1 cursor-grab active:cursor-grabbing pr-8">
        {/* Title row */}
        <div className="flex items-center gap-1.5 min-h-[1.5rem]">
        {isEditingTitle ? (
          <>
            <input
              ref={titleInputRef}
              value={titleInput}
              onChange={e => setTitleInput(e.target.value)}
              onKeyDown={handleTitleKeyDown}
              onBlur={saveTitle}
              onMouseDown={e => e.stopPropagation()}
              className="flex-1 text-sm font-semibold border-b border-blue-400 outline-none bg-transparent cursor-text"
            />
            {isSavingTitle && <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500 flex-shrink-0" />}
            {!isSavingTitle && (
              <Check
                className="h-3.5 w-3.5 text-blue-500 flex-shrink-0 cursor-pointer"
                onMouseDown={e => { e.stopPropagation(); saveTitle(); }}
              />
            )}
          </>
        ) : (
          <>
            <h3 className="text-sm font-semibold truncate flex-1">{displayTitle}</h3>
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={startEditingTitle}
              className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 text-gray-400 hover:text-blue-600"
              title="Edit title"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </>
        )}
        </div>
        {/* Parameter chips */}
        {instanceParameters && Object.keys(instanceParameters).length > 0 && (
          <div className="flex flex-wrap gap-1">
            {Object.entries(instanceParameters).map(([key, val]) => (
              <span
                key={key}
                title={key}
                className="inline-flex items-center px-1.5 py-0.5 bg-purple-50 border border-purple-200 text-purple-700 rounded text-xs font-mono"
              >
                {String(val)}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Chart visualization */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {exploreConfig ? (
          <ExploreChart
            type={exploreConfig.chartType}
            data={filteredData}
            roleConfig={exploreConfig.roleConfig}
          />
        ) : (
          <ChartPreview
            chartType={chart.chart_type}
            data={filteredData}
            config={legacyChartConfig}
          />
        )}
      </div>
    </div>
  );
}
