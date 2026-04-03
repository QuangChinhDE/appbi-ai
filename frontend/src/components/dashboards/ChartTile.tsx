'use client';

import React, { useMemo, useState, useRef, useEffect } from 'react';
import { X, Loader2, Pencil, Check, SlidersHorizontal, Plus } from 'lucide-react';
import { useChart, useChartData } from '@/hooks/use-charts';
import { ChartPreview } from '@/components/charts/ChartPreview';
import { ExploreChart } from '@/components/explore/ExploreChart';
import { applyFilters } from '@/lib/explore-utils';
import type { ChartRoleConfig, AggFn, MetricConfig } from '@/components/explore/ExploreChartConfig';
import { metricKey, metricLabel } from '@/components/explore/ExploreChartConfig';
import { DashboardFilter, applyFiltersToRows } from '@/lib/filters';
import type { BaseFilter, FilterOperator } from '@/lib/filters';
import { dashboardApi } from '@/lib/api/dashboards';
import { useQueryClient } from '@tanstack/react-query';

interface ChartTileProps {
  chartId: number;
  dashboardChartId: number;
  dashboardId: number;
  currentLayout: Record<string, any>;
  onRemove?: (dashboardChartId: number) => void;
  isRemoving?: boolean;
  dashboardFilters?: DashboardFilter[];
  globalFilters?: BaseFilter[];
  onDataLoaded?: (chartId: number, data: any[], meta: { dimensionFields: string[] }) => void;
  instanceParameters?: Record<string, any>;
}

export function ChartTile({ 
  chartId, 
  dashboardChartId,
  dashboardId,
  currentLayout,
  onRemove, 
  isRemoving,
  dashboardFilters = [],
  globalFilters = [],
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

  // Per-tile HAVING filter state (post-aggregation)
  const [havingFilters, setHavingFilters] = useState<BaseFilter[]>([]);
  const [isHavingOpen, setIsHavingOpen] = useState(false);
  const [draftHavingField, setDraftHavingField] = useState('');
  const [draftHavingOp, setDraftHavingOp] = useState<FilterOperator>('gt');
  const [draftHavingValue, setDraftHavingValue] = useState('');

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

  // Notify parent when data is loaded — report ALL fields for PowerBI-style global filtering
  React.useEffect(() => {
    if (chartData?.data?.length && onDataLoaded) {
      const allFields = Object.keys(chartData.data[0]);
      onDataLoaded(chartId, chartData.data, { dimensionFields: allFields });
    }
  }, [chartData?.data, onDataLoaded, chartId, chart?.config]);

  const rawRows: Record<string, any>[] = chartData?.data ?? [];
  const preAggregated = chartData?.pre_aggregated ?? false;

  // Detect whether this is an Explore-format chart (has roleConfig)
  const exploreConfig = useMemo(() => {
    const config = chart?.config as any;
    if (!config?.roleConfig) return null;
    const rc = config.roleConfig as ChartRoleConfig;
    // Migrate legacy string[] metrics
    if (rc.metrics?.length > 0 && typeof (rc.metrics as any)[0] === 'string') {
      rc.metrics = (rc.metrics as unknown as string[]).map(f => ({ field: f, agg: 'sum' as AggFn }));
    }
    return { chartType: config.chartType as string, roleConfig: rc, filters: config.filters ?? [], styleConfig: config.styleConfig };
  }, [chart?.config]);

  // Apply Explore-style filters (from stored config) then dashboard filters client-side
  const filteredData = useMemo(() => {
    if (rawRows.length === 0) return rawRows;
    // When backend pre-aggregated, it already applied stored filters in SQL — skip client-side re-apply
    let rows = (!preAggregated && exploreConfig?.filters?.length)
      ? applyFilters(rawRows, exploreConfig.filters)
      : rawRows;
    if (!exploreConfig && dashboardFilters.length > 0) {
      rows = applyFiltersToRows(rows, dashboardFilters);
    }
    // Apply global dashboard filters to ALL chart types.
    // A filter matches a chart if its primary field OR any linkedField exists in the data.
    if (globalFilters.length > 0 && rows.length > 0) {
      const applicable = globalFilters
        .map(f => {
          const candidates = [f.field, ...(f.linkedFields ?? [])];
          const match = candidates.find(c => c in rows[0]);
          if (!match) return null;
          // Remap field to the matched column name for this chart
          return match !== f.field ? { ...f, field: match } : f;
        })
        .filter((f): f is BaseFilter => f !== null);
      if (applicable.length > 0) {
        rows = applyFiltersToRows(rows, applicable);
      }
    }
    return rows;
  }, [rawRows, exploreConfig, dashboardFilters, globalFilters, preAggregated]);

  // Available metric keys for HAVING filter
  const havingOptions = useMemo(() =>
    exploreConfig?.roleConfig.metrics?.map(m => ({
      key: metricKey(m),
      label: metricLabel(m),
    })) ?? [],
  [exploreConfig]);

  // Initialize draftHavingField when options become available
  React.useEffect(() => {
    if (havingOptions.length > 0 && !draftHavingField) {
      setDraftHavingField(havingOptions[0].key);
    }
  }, [havingOptions, draftHavingField]);

  const confirmHaving = () => {
    const field = draftHavingField || havingOptions[0]?.key;
    if (!field || draftHavingValue === '') return;
    setHavingFilters(prev => [...prev, {
      id: `hv-${Date.now()}`,
      field,
      type: 'number',
      operator: draftHavingOp,
      value: Number(draftHavingValue),
    }]);
    setDraftHavingValue('');
  };

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
      {onRemove && (
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
      )}

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
            {exploreConfig && havingOptions.length > 0 && (
              <button
                onMouseDown={e => e.stopPropagation()}
                onClick={() => setIsHavingOpen(v => !v)}
                className={`relative flex-shrink-0 transition-opacity ${
                  isHavingOpen || havingFilters.length > 0
                    ? 'opacity-100 text-indigo-600'
                    : 'opacity-0 group-hover:opacity-100 text-gray-400 hover:text-indigo-600'
                }`}
                title="Per-chart filters (HAVING)"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {havingFilters.length > 0 && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 bg-indigo-500 rounded-full" />
                )}
              </button>
            )}
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
        {/* HAVING filter chips */}
        {havingFilters.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {havingFilters.map(f => (
              <span key={f.id} className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-indigo-50 border border-indigo-200 text-indigo-700 text-xs rounded">
                <span className="font-mono opacity-60 text-[0.6rem] uppercase">having</span>
                {havingOptions.find(o => o.key === f.field)?.label ?? f.field}
                {` ${f.operator} ${f.value}`}
                <button
                  onMouseDown={e => e.stopPropagation()}
                  onClick={() => setHavingFilters(prev => prev.filter(x => x.id !== f.id))}
                  className="text-indigo-400 hover:text-indigo-700"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}
        {/* HAVING filter editor panel */}
        {isHavingOpen && exploreConfig && havingOptions.length > 0 && (
          <div
            className="border border-indigo-100 bg-indigo-50/50 rounded p-2 flex flex-wrap items-center gap-1.5"
            onMouseDown={e => e.stopPropagation()}
          >
            <select
              value={draftHavingField}
              onChange={e => setDraftHavingField(e.target.value)}
              className="text-xs border border-gray-300 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white"
            >
              {havingOptions.map(o => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
            <select
              value={draftHavingOp}
              onChange={e => setDraftHavingOp(e.target.value as FilterOperator)}
              className="text-xs border border-gray-300 rounded px-1.5 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-400"
            >
              <option value="gt">&gt; greater than</option>
              <option value="gte">≥ greater or equal</option>
              <option value="lt">&lt; less than</option>
              <option value="lte">≤ less or equal</option>
              <option value="eq">= equals</option>
              <option value="neq">≠ not equals</option>
            </select>
            <input
              type="number"
              value={draftHavingValue}
              onChange={e => setDraftHavingValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') confirmHaving();
                if (e.key === 'Escape') setIsHavingOpen(false);
              }}
              placeholder="value"
              className="text-xs border border-gray-300 rounded px-1.5 py-0.5 w-20 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
            <button
              onClick={confirmHaving}
              className="text-xs px-2 py-0.5 bg-indigo-500 text-white rounded hover:bg-indigo-600"
            >
              Apply
            </button>
            {havingFilters.length > 0 && (
              <button
                onClick={() => setHavingFilters([])}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                Clear all
              </button>
            )}
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
            styleConfig={exploreConfig.styleConfig}
            havingFilters={havingFilters}
            preAggregated={preAggregated}
          />
        ) : (
          <ChartPreview
            chartType={chart.chart_type}
            data={filteredData}
            config={legacyChartConfig}
            styleConfig={(chart?.config as any)?.styleConfig}
          />
        )}
      </div>
    </div>
  );
}
