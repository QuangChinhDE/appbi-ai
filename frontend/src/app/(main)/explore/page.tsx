/**
 * Explore — list saved charts or open the editor
 */
'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { Search, Play, Save, Plus, ArrowLeft, Trash2, BarChart3, Clock, Layers, ChevronDown, ChevronUp, Pencil, Check } from 'lucide-react';
import { useWorkspace, useTablePreview } from '@/hooks/use-dataset-workspaces';
import { ExploreSourceSelector } from '@/components/explore/ExploreSourceSelector';
import { DatasetTableGrid } from '@/components/datasets/DatasetTableGrid';
import { ExploreChart } from '@/components/explore/ExploreChart';
import { FilterBuilder, type Filter } from '@/components/explore/FilterBuilder';
import { useCreateChart, useCharts, useUpdateChart, useDeleteChart } from '@/hooks/use-charts';
import { applyFilters } from '@/lib/explore-utils';
import { ExploreChartConfig, type ExploreChartType, type ChartRoleConfig, type AggFn } from '@/components/explore/ExploreChartConfig';
import { toast } from 'sonner';

type ChartType = ExploreChartType;
type PageMode = 'list' | 'editor';

export default function ExplorePage() {
  const [pageMode, setPageMode] = useState<PageMode>('list');
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<number | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null);
  const [previewLimit, setPreviewLimit] = useState(500);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [chartType, setChartType] = useState<ChartType>('TABLE');
  const [chartRoleConfig, setChartRoleConfig] = useState<ChartRoleConfig>({ metrics: [] });
  const [selectedChartId, setSelectedChartId] = useState<number | null>(null);
  const [isSourceOpen, setIsSourceOpen] = useState(true);
  const [chartNameInput, setChartNameInput] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);

  const createChart = useCreateChart();
  const updateChart = useUpdateChart();
  const deleteChart = useDeleteChart();
  const { data: charts } = useCharts();
  const { data: workspace } = useWorkspace(selectedWorkspaceId);

  const {
    data: previewData,
    isLoading,
    error,
    refetch,
  } = useTablePreview(selectedWorkspaceId, selectedTableId, { limit: previewLimit });

  // Apply filters client-side
  const displayData = useMemo(() => {
    if (!previewData) return previewData;
    if (filters.length === 0) return previewData;
    return { ...previewData, rows: applyFilters(previewData.rows, filters) };
  }, [previewData, filters]);

  // Auto-select first table when workspace changes
  useEffect(() => {
    if (workspace?.tables && workspace.tables.length > 0 && !selectedTableId) {
      setSelectedTableId(workspace.tables[0].id);
    }
  }, [workspace?.tables, selectedTableId]);

  // Reset on table change
  useEffect(() => {
    if (selectedTableId) {
      setFilters([]);
      setChartRoleConfig({ metrics: [] });
    }
  }, [selectedTableId]);

  // Auto-suggest fields when switching to chart mode
  useEffect(() => {
    if (chartType === 'TABLE') return;
    const cols = previewData?.columns;
    if (!cols?.length) return;
    setChartRoleConfig(prev => {
      if (prev.dimension || prev.metrics.length > 0) return prev;
      const firstDim = cols.find(c => c.type !== 'number')?.name;
      const firstNum = cols.find(c => c.type === 'number')?.name;
      return { ...prev, dimension: firstDim, metrics: firstNum ? [{ field: firstNum, agg: 'sum' as AggFn }] : [] };
    });
  }, [chartType, previewData?.columns]);

  const loadChart = (chartId: number) => {
    const chart = charts?.find(c => c.id === chartId);
    if (!chart || !chart.config) return;

    const config = chart.config as any;
    
    // Restore workspace and table from the FK stored on the chart
    if (chart.workspace_table_id) {
      setSelectedTableId(chart.workspace_table_id);
      // workspace_id is stored in config for lookup
      if (config.workspace_id) {
        setSelectedWorkspaceId(config.workspace_id);
      }
    } else if (config.source?.kind === 'workspace_table') {
      // Legacy format fallback
      setSelectedWorkspaceId(config.source.workspaceId);
      setSelectedTableId(config.source.tableId);
    }
    
    setFilters(config.filters || []);
    setChartType(config.chartType || 'TABLE');
    if (config.roleConfig) {
      const rc = config.roleConfig as ChartRoleConfig;
      // Migrate legacy format where metrics was string[]
      if (rc.metrics?.length > 0 && typeof (rc.metrics as any)[0] === 'string') {
        rc.metrics = (rc.metrics as unknown as string[]).map(f => ({ field: f, agg: 'sum' as AggFn }));
      }
      setChartRoleConfig(rc);
    } else {
      setChartRoleConfig({ metrics: [] });
    }
    setChartNameInput(chart.name);
    setIsEditingName(false);
    setSelectedChartId(chartId);
    setPageMode('editor');
  };

  const openNewChart = () => {
    setSelectedChartId(null);
    setFilters([]);
    setChartType('TABLE');
    setChartRoleConfig({ metrics: [] });
    setChartNameInput('');
    setIsEditingName(true);
    setPageMode('editor');
  };

  const handleDeleteChart = async (id: number, name: string) => {
    if (!confirm(`Delete chart "${name}"?`)) return;
    try {
      await deleteChart.mutateAsync(id);
      toast.success(`Chart "${name}" deleted`);
      if (selectedChartId === id) {
        setSelectedChartId(null);
      }
    } catch {
      toast.error('Failed to delete chart');
    }
  };

  const handleSaveLook = async () => {
    if (!selectedTableId) {
      toast.error('Please select a workspace table first');
      return;
    }

    const exploreConfig = {
      workspace_id: selectedWorkspaceId,
      filters,
      chartType,
      roleConfig: chartRoleConfig,
    };

    try {
      if (selectedChartId) {
        // Update existing chart
        await updateChart.mutateAsync({
          id: selectedChartId,
          data: {
            name: chartNameInput.trim() || undefined,
            chart_type: chartType as any,
            workspace_table_id: selectedTableId,
            config: exploreConfig as unknown as import('@/types/api').ChartConfig,
          },
        });
        toast.success('Chart updated successfully!');
      } else {
        // Create new chart — use inline name input
        const name = chartNameInput.trim();
        if (!name) {
          setIsEditingName(true);
          toast.error('Please enter a chart name');
          return;
        }

        const newChart = await createChart.mutateAsync({
          name,
          chart_type: chartType as any,
          workspace_table_id: selectedTableId,
          config: exploreConfig as unknown as import('@/types/api').ChartConfig,
        });

        setSelectedChartId(newChart.id);
        toast.success(`Chart "${name}" saved!`);
        setPageMode('list');
      }
    } catch (error: any) {
      console.error('Error saving chart:', error);
      toast.error(`Failed to save chart: ${error?.response?.data?.detail || error.message}`);
    }
  };

  const selectedTable = workspace?.tables?.find((t: any) => t.id === selectedTableId);

  const CHART_TYPE_LABELS: Record<string, string> = {
    BAR: 'Bar', LINE: 'Line', PIE: 'Pie', TIME_SERIES: 'Time Series',
    AREA: 'Area', STACKED_BAR: 'Stacked Bar', GROUPED_BAR: 'Grouped Bar',
    SCATTER: 'Scatter', KPI: 'KPI', TABLE: 'Table',
  };

  // ── LIST VIEW ─────────────────────────────────────────────────────────────
  if (pageMode === 'list') {
    return (
      <div className="h-screen flex flex-col bg-gray-50">
        <div className="bg-white border-b border-gray-200 px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Explore</h1>
              <p className="text-sm text-gray-500 mt-0.5">
                {charts?.length ?? 0} saved chart{charts?.length !== 1 ? 's' : ''}
              </p>
            </div>
            <button
              onClick={openNewChart}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              New Chart
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {!charts || charts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-center">
              <BarChart3 className="w-14 h-14 text-gray-300 mb-4" />
              <h3 className="text-lg font-medium text-gray-700 mb-1">No saved charts yet</h3>
              <p className="text-sm text-gray-500 mb-4">Create your first chart from a workspace table</p>
              <button
                onClick={openNewChart}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                New Chart
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {charts.map(chart => {
                const config = chart.config as any;
                const typeLabel = CHART_TYPE_LABELS[chart.chart_type] ?? chart.chart_type;
                const createdAt = new Date(chart.created_at).toLocaleDateString('vi-VN', {
                  day: '2-digit', month: '2-digit', year: 'numeric',
                });
                return (
                  <div
                    key={chart.id}
                    className="bg-white rounded-lg border border-gray-200 p-4 flex flex-col gap-3 hover:shadow-md transition-shadow cursor-pointer group"
                    onClick={() => loadChart(chart.id)}
                  >
                    <div className="flex items-start justify-between">
                      <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
                        <BarChart3 className="w-5 h-5 text-blue-600" />
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteChart(chart.id, chart.name); }}
                        className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 transition-all p-1 rounded"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-gray-900 truncate text-sm">{chart.name}</h3>
                      {config?.roleConfig?.dimension && (
                        <p className="text-xs text-gray-500 mt-0.5 truncate flex items-center gap-1">
                          <Layers className="w-3 h-3 flex-shrink-0" />
                          {config.roleConfig.dimension}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center justify-between text-xs text-gray-400">
                      <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full font-medium">
                        {typeLabel}
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {createdAt}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── EDITOR VIEW ───────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setPageMode('list')}
                className="text-gray-500 hover:text-gray-700 flex items-center gap-1 text-sm"
              >
                <ArrowLeft className="w-4 h-4" />
                All Charts
              </button>
              <span className="text-gray-300">/</span>
              {isEditingName ? (
                <div className="flex items-center gap-1.5">
                  <input
                    autoFocus
                    type="text"
                    value={chartNameInput}
                    onChange={e => setChartNameInput(e.target.value)}
                    onBlur={() => {
                      setIsEditingName(false);
                      if (selectedChartId && chartNameInput.trim()) {
                        updateChart.mutate({ id: selectedChartId, data: { name: chartNameInput.trim() } });
                      }
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') { setChartNameInput(charts?.find(c => c.id === selectedChartId)?.name ?? ''); setIsEditingName(false); }
                    }}
                    placeholder="Chart name…"
                    className="text-lg font-semibold text-gray-900 border-b border-blue-400 bg-transparent outline-none px-0.5 min-w-[10rem]"
                  />
                  <Check className="w-4 h-4 text-blue-500" />
                </div>
              ) : (
                <div className="flex items-center gap-1.5 group/name">
                  <h1 className="text-lg font-semibold text-gray-900">
                    {chartNameInput || (selectedChartId ? 'Chart' : 'New Chart')}
                  </h1>
                  <button
                    onClick={() => setIsEditingName(true)}
                    className="opacity-0 group-hover/name:opacity-100 text-gray-400 hover:text-gray-600 transition-opacity"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
            {selectedTable && (
              <p className="text-sm text-gray-500 mt-0.5 ml-[calc(1rem+4px+8px)]">
                {workspace?.name} / {(selectedTable as any).display_name || 'Table'}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => refetch()}
              disabled={!selectedTableId || isLoading}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <Play className="w-4 h-4" />
              Run Query
            </button>
            <button
              onClick={handleSaveLook}
              disabled={!selectedTableId}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <Save className="w-4 h-4" />
              {selectedChartId ? 'Update Chart' : 'Save Chart'}
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar */}
        <div className="w-80 bg-white border-r border-gray-200 flex flex-col overflow-hidden">
          <div className="border-b">
            <button
              onClick={() => setIsSourceOpen(o => !o)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
            >
              <h2 className="text-sm font-semibold text-gray-900">Data Source</h2>
              {isSourceOpen ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
            </button>
            {isSourceOpen && (
              <div className="px-4 pb-4">
                <ExploreSourceSelector
                  selectedWorkspaceId={selectedWorkspaceId}
                  selectedTableId={selectedTableId}
                  previewLimit={previewLimit}
                  onWorkspaceChange={setSelectedWorkspaceId}
                  onTableChange={setSelectedTableId}
                  onLimitChange={setPreviewLimit}
                />
              </div>
            )}
          </div>

          {/* Chart config + Filter */}
          {selectedTableId && (
            <div className="flex-1 overflow-y-auto">
              <ExploreChartConfig
                chartType={chartType}
                roleConfig={chartRoleConfig}
                availableColumns={previewData?.columns || []}
                onChartTypeChange={setChartType}
                onRoleConfigChange={setChartRoleConfig}
              />
              <div className="p-4 border-t">
                <FilterBuilder
                  filters={filters}
                  onChange={setFilters}
                  availableFields={previewData?.columns?.map(c => c.name) || []}
                />
              </div>
            </div>
          )}
        </div>

        {/* Main Content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-hidden p-4">
            {!selectedTableId ? (
              <div className="h-full flex items-center justify-center">
                <div className="text-center">
                  <Search className="w-12 h-12 text-gray-400 mx-auto mb-3" />
                  <h3 className="text-lg font-medium text-gray-900 mb-1">No table selected</h3>
                  <p className="text-sm text-gray-500">Select a workspace and table to start exploring</p>
                </div>
              </div>
            ) : isLoading ? (
              <div className="h-full flex items-center justify-center">
                <div className="text-center">
                  <div className="inline-block w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-3"></div>
                  <p className="text-sm text-gray-600">Loading data...</p>
                </div>
              </div>
            ) : error ? (
              <div className="h-full flex items-center justify-center">
                <div className="text-center text-red-600">
                  <p className="font-medium">Error loading data</p>
                  <p className="text-sm mt-1">{String(error)}</p>
                </div>
              </div>
            ) : (
              <div className="h-full bg-white rounded-lg border border-gray-200 overflow-hidden">
                {chartType === 'TABLE' ? (() => {
                  const sel = chartRoleConfig.selectedColumns;
                  const cols = sel && sel.length > 0
                    ? (displayData?.columns || []).filter(c => sel.includes(c.name))
                    : (displayData?.columns || []);
                  const rows = (displayData?.rows || []).map(row =>
                    sel && sel.length > 0
                      ? Object.fromEntries(sel.map(k => [k, row[k]]))
                      : row
                  );
                  return (
                    <DatasetTableGrid columns={cols} rows={rows} />
                  );
                })() : (
                  <div className="h-full p-4">
                    <ExploreChart
                      type={chartType}
                      data={displayData?.rows || []}
                      roleConfig={chartRoleConfig}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
