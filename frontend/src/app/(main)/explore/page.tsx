/**
 * Explore v2 - Data exploration with backend group_by, aggregations, and filters
 */
'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { Search, Play, Save, X, Table2, BarChart3, LineChart as LineChartIcon, PieChart as PieChartIcon } from 'lucide-react';
import { useWorkspace, useTablePreview, useExecuteWorkspaceTableQuery, type AggregationSpec, type FilterCondition } from '@/hooks/use-dataset-workspaces';
import { ExploreSourceSelector } from '@/components/explore/ExploreSourceSelector';
import { DatasetTableGrid } from '@/components/datasets/DatasetTableGrid';
import { ExploreChart } from '@/components/explore/ExploreChart';
import { FilterBuilder, type Filter } from '@/components/explore/FilterBuilder';
import { useCreateChart, useCharts, useUpdateChart } from '@/hooks/use-charts';
import { useDatasets, useCreateDataset } from '@/hooks/use-datasets';
import { useDataSources } from '@/hooks/use-datasources';
import { classifyFields } from '@/lib/explore-utils';
import { toast } from 'sonner';

type ChartType = 'TABLE' | 'BAR' | 'LINE' | 'PIE';
type AggFunction = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct';

interface MeasureWithAgg {
  field: string;
  aggregation: AggFunction;
}

export default function ExplorePage() {
  // Source selection
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<number | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null);
  const [previewLimit, setPreviewLimit] = useState(500);

  // Field selection
  const [selectedDimensions, setSelectedDimensions] = useState<string[]>([]);
  const [selectedMeasures, setSelectedMeasures] = useState<MeasureWithAgg[]>([]);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [chartType, setChartType] = useState<ChartType>('TABLE');
  
  // UI state
  const [fieldSearch, setFieldSearch] = useState('');
  const [selectedChartId, setSelectedChartId] = useState<number | null>(null);

  // Mutations
  const createChart = useCreateChart();
  const updateChart = useUpdateChart();
  const createDataset = useCreateDataset();
  
  // Fetch datasets, datasources and charts
  const { data: datasets } = useDatasets();
  const { data: datasources } = useDataSources();
  const { data: charts } = useCharts();

  // Fetch workspace
  const { data: workspace } = useWorkspace(selectedWorkspaceId);

  // Build query request
  const executeRequest = useMemo(() => {
    const req: any = { limit: previewLimit };

    if (selectedDimensions.length > 0) {
      req.dimensions = selectedDimensions;
    }

    if (selectedMeasures.length > 0) {
      req.measures = selectedMeasures.map(m => ({
        field: m.field,
        function: m.aggregation,
      }));
    }

    if (filters.length > 0) {
      req.filters = filters.map(f => ({
        field: f.field,
        operator: f.operator,
        value: f.value,
      }));
    }

    return req;
  }, [previewLimit, filters, selectedDimensions, selectedMeasures]);

  // Use execute query when measures are selected, otherwise use preview
  const hasAggregation = selectedMeasures.length > 0;
  
  const { 
    data: executeData, 
    isLoading: loadingExecute,
    error: executeError,
    refetch: refetchExecute 
  } = useExecuteWorkspaceTableQuery(
    hasAggregation ? selectedWorkspaceId : null, 
    hasAggregation ? selectedTableId : null, 
    executeRequest
  );

  // Always fetch preview to get available fields (dimensions/measures)
  const { 
    data: previewData, 
    isLoading: loadingPreview,
    error: previewError,
    refetch: refetchPreview 
  } = useTablePreview(
    selectedWorkspaceId, 
    selectedTableId, 
    { limit: previewLimit }
  );

  // Use execute data if aggregation, otherwise preview
  const displayData = hasAggregation ? executeData : previewData;
  const isLoading = hasAggregation ? loadingExecute : loadingPreview;
  const error = hasAggregation ? executeError : previewError;

  // Auto-select first table when workspace changes
  useEffect(() => {
    if (workspace?.tables && workspace.tables.length > 0 && !selectedTableId) {
      setSelectedTableId(workspace.tables[0].id);
    }
  }, [workspace?.tables, selectedTableId]);

  // Reset selections when table changes
  useEffect(() => {
    if (selectedTableId) {
      setSelectedDimensions([]);
      setSelectedMeasures([]);
      setFilters([]);
    }
  }, [selectedTableId]);

  // Classify fields from raw preview (without aggregations)
  const { dimensions, measures } = useMemo(() => {
    if (!previewData?.columns) {
      return { dimensions: [], measures: [] };
    }
    return classifyFields(previewData.columns);
  }, [previewData?.columns]);

  // Filter fields by search
  const filteredDimensions = useMemo(() => {
    if (!fieldSearch) return dimensions;
    const query = fieldSearch.toLowerCase();
    return dimensions.filter(d => d.name.toLowerCase().includes(query));
  }, [dimensions, fieldSearch]);

  const filteredMeasures = useMemo(() => {
    if (!fieldSearch) return measures;
    const query = fieldSearch.toLowerCase();
    return measures.filter(m => m.name.toLowerCase().includes(query));
  }, [measures, fieldSearch]);

  const handleToggleDimension = (field: string) => {
    setSelectedDimensions(prev =>
      prev.includes(field) ? prev.filter(f => f !== field) : [...prev, field]
    );
  };

  const handleToggleMeasure = (field: string) => {
    setSelectedMeasures(prev => {
      const exists = prev.find(m => m.field === field);
      if (exists) {
        return prev.filter(m => m.field !== field);
      } else {
        return [...prev, { field, aggregation: 'sum' as AggFunction }];
      }
    });
  };

  const handleUpdateMeasureAggregation = (field: string, aggregation: AggFunction) => {
    setSelectedMeasures(prev =>
      prev.map(m => (m.field === field ? { ...m, aggregation } : m))
    );
  };

  const loadChart = (chartId: number) => {
    const chart = charts?.find(c => c.id === chartId);
    if (!chart || !chart.config) return;

    const config = chart.config as any;
    
    // Load workspace/table if from workspace source
    if (config.source?.kind === 'workspace_table') {
      setSelectedWorkspaceId(config.source.workspaceId);
      setSelectedTableId(config.source.tableId);
    }
    
    // Load field selections
    setSelectedDimensions(config.dimensions || []);
    
    // Load measures with aggregations
    if (config.measures) {
      setSelectedMeasures(config.measures.map((m: any) => ({
        field: typeof m === 'string' ? m : m.field,
        aggregation: typeof m === 'string' ? 'sum' : (m.aggregation || 'sum'),
      })));
    }
    
    setFilters(config.filters || []);
    setChartType(config.chartType || 'TABLE');
    setSelectedChartId(chartId);
    
    toast.success(`Loaded chart: ${chart.name}`);
  };

  const handleSaveLook = async () => {
    if (selectedDimensions.length === 0 && selectedMeasures.length === 0) {
      toast.error('Please select at least one dimension or measure');
      return;
    }
    
    // Prepare look config
    const lookConfig = {
      source: {
        kind: 'workspace_table',
        workspaceId: selectedWorkspaceId,
        tableId: selectedTableId,
      },
      dimensions: selectedDimensions,
      measures: selectedMeasures,
      filters,
      chartType,
    };

    try {
      if (selectedChartId) {
        // Update existing chart
        await updateChart.mutateAsync({
          id: selectedChartId,
          data: {
            chart_type: chartType as any,
            config: lookConfig,
          },
        });
        toast.success('Chart updated successfully!');
      } else {
        // Create new chart
        const chartName = prompt('Enter chart name:');
        if (!chartName || !chartName.trim()) {
          return;
        }

        // Get or create a dataset for workspace charts
        let datasetId = 1;
        
        if (datasets && datasets.length > 0) {
          datasetId = datasets[0].id;
        } else {
          const sqlDatasources = datasources?.filter(ds => 
            ds.type !== 'manual' && ds.type !== 'google_sheets'
          );
          
          if (!sqlDatasources || sqlDatasources.length === 0) {
            toast.error('No SQL datasource available. Please create a PostgreSQL, MySQL, or BigQuery datasource first.');
            return;
          }
          
          try {
            const dummyDataset = await createDataset.mutateAsync({
              name: 'Workspace Charts',
              description: 'Dataset for charts created from workspace tables',
              data_source_id: sqlDatasources[0].id,
              sql_query: 'SELECT 1',
            });
            datasetId = dummyDataset.id;
          } catch (err) {
            console.error('Failed to create dummy dataset:', err);
            toast.error('Failed to create dataset. Please create a dataset manually first.');
            return;
          }
        }

        const newChart = await createChart.mutateAsync({
          name: chartName.trim(),
          chart_type: chartType as any,
          dataset_id: datasetId,
          config: lookConfig,
        });

        setSelectedChartId(newChart.id);
        toast.success(`Chart "${chartName}" saved successfully!`);
      }
    } catch (error: any) {
      console.error('Error saving chart:', error);
      toast.error(`Failed to save chart: ${error?.response?.data?.detail || error.message}`);
    }
  };

  const selectedTable = workspace?.tables?.find((t: any) => t.id === selectedTableId);

  // Compute columns for display (after grouping/aggregation)
  const displayColumns = useMemo(() => {
    if (!displayData?.columns) return [];
    
    // If we have grouping or aggregation, return the aggregated columns
    if (selectedDimensions.length > 0 || selectedMeasures.length > 0) {
      const cols = [];
      selectedDimensions.forEach(d => cols.push({ name: d, type: 'string' }));
      selectedMeasures.forEach(m => cols.push({ 
        name: `${m.field}_${m.aggregation}`, 
        type: 'number' 
      }));
      return cols;
    }
    
    return displayData.columns;
  }, [displayData?.columns, selectedDimensions, selectedMeasures]);

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-4">
              <h1 className="text-2xl font-bold text-gray-900">Explore</h1>
              
              {/* Chart Selector */}
              <select
                value={selectedChartId || ''}
                onChange={(e) => {
                  const chartId = Number(e.target.value);
                  if (chartId) {
                    loadChart(chartId);
                  } else {
                    setSelectedChartId(null);
                    setSelectedDimensions([]);
                    setSelectedMeasures([]);
                    setFilters([]);
                    setChartType('TABLE');
                  }
                }}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">New Chart</option>
                {charts?.map(chart => (
                  <option key={chart.id} value={chart.id}>
                    {chart.name}
                  </option>
                ))}
              </select>
            </div>
            
            {selectedTable && (
              <p className="text-sm text-gray-500 mt-1">
                Exploring: {workspace?.name} / {(selectedTable as any).display_name || 'Table'}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            {/* Chart Type Selector */}
            <div className="flex items-center bg-gray-100 rounded-md p-1">
              <button
                onClick={() => setChartType('TABLE')}
                className={`p-2 rounded transition-colors ${
                  chartType === 'TABLE'
                    ? 'bg-white shadow-sm text-blue-600'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
                title="Table"
              >
                <Table2 className="w-4 h-4" />
              </button>
              <button
                onClick={() => setChartType('BAR')}
                className={`p-2 rounded transition-colors ${
                  chartType === 'BAR'
                    ? 'bg-white shadow-sm text-blue-600'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
                title="Bar Chart"
              >
                <BarChart3 className="w-4 h-4" />
              </button>
              <button
                onClick={() => setChartType('LINE')}
                className={`p-2 rounded transition-colors ${
                  chartType === 'LINE'
                    ? 'bg-white shadow-sm text-blue-600'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
                title="Line Chart"
              >
                <LineChartIcon className="w-4 h-4" />
              </button>
              <button
                onClick={() => setChartType('PIE')}
                className={`p-2 rounded transition-colors ${
                  chartType === 'PIE'
                    ? 'bg-white shadow-sm text-blue-600'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
                title="Pie Chart"
              >
                <PieChartIcon className="w-4 h-4" />
              </button>
            </div>

            <button
              onClick={() => refetchPreview()}
              disabled={!selectedTableId || loadingPreview}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <Play className="w-4 h-4" />
              Run Query
            </button>
            <button
              onClick={handleSaveLook}
              disabled={!selectedTableId || (selectedDimensions.length === 0 && selectedMeasures.length === 0)}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <Save className="w-4 h-4" />
              {selectedChartId ? 'Update Chart' : 'Save Look'}
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar */}
        <div className="w-80 bg-white border-r border-gray-200 flex flex-col overflow-hidden">
          <div className="p-4 border-b">
            <h2 className="text-sm font-semibold text-gray-900 mb-4">Data Source</h2>
            <ExploreSourceSelector
              selectedWorkspaceId={selectedWorkspaceId}
              selectedTableId={selectedTableId}
              previewLimit={previewLimit}
              onWorkspaceChange={setSelectedWorkspaceId}
              onTableChange={setSelectedTableId}
              onLimitChange={setPreviewLimit}
            />
          </div>

          {/* Fields Section */}
          {selectedTableId && (
            <div className="flex-1 overflow-y-auto">
              <div className="p-4 border-b">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Search fields..."
                    value={fieldSearch}
                    onChange={(e) => setFieldSearch(e.target.value)}
                    className="w-full pl-9 pr-4 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              {/* Filters */}
              <div className="p-4 border-b">
                <FilterBuilder
                  filters={filters}
                  onChange={setFilters}
                  availableFields={[...dimensions, ...measures]}
                />
              </div>

              {/* Dimensions */}
              <div className="p-4 border-b">
                <h3 className="text-xs font-semibold text-gray-700 uppercase mb-3">
                  Dimensions ({filteredDimensions.length})
                </h3>
                <div className="space-y-1">
                  {filteredDimensions.map((field) => (
                    <button
                      key={field.name}
                      onClick={() => handleToggleDimension(field.name)}
                      className={`w-full text-left px-3 py-2 text-sm rounded transition-colors ${
                        selectedDimensions.includes(field.name)
                          ? 'bg-blue-50 text-blue-900 font-medium'
                          : 'text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      {field.name}
                    </button>
                  ))}
                  {filteredDimensions.length === 0 && (
                    <p className="text-xs text-gray-500 text-center py-2">
                      {fieldSearch ? 'No matching dimensions' : 'No dimensions available'}
                    </p>
                  )}
                </div>
              </div>

              {/* Measures with Aggregation Selector */}
              <div className="p-4">
                <h3 className="text-xs font-semibold text-gray-700 uppercase mb-3">
                  Measures ({filteredMeasures.length})
                </h3>
                <div className="space-y-2">
                  {filteredMeasures.map((field) => {
                    const selected = selectedMeasures.find(m => m.field === field.name);
                    return (
                      <div key={field.name} className="space-y-1">
                        <button
                          onClick={() => handleToggleMeasure(field.name)}
                          className={`w-full text-left px-3 py-2 text-sm rounded transition-colors ${
                            selected
                              ? 'bg-blue-50 text-blue-900 font-medium'
                              : 'text-gray-700 hover:bg-gray-50'
                          }`}
                        >
                          {field.name}
                        </button>
                        {selected && (
                          <select
                            value={selected.aggregation}
                            onChange={(e) => handleUpdateMeasureAggregation(field.name, e.target.value as AggFunction)}
                            className="w-full text-xs px-2 py-1 border border-gray-300 rounded bg-white"
                          >
                            <option value="sum">SUM</option>
                            <option value="avg">AVG</option>
                            <option value="count">COUNT</option>
                            <option value="min">MIN</option>
                            <option value="max">MAX</option>
                            <option value="count_distinct">COUNT DISTINCT</option>
                          </select>
                        )}
                      </div>
                    );
                  })}
                  {filteredMeasures.length === 0 && (
                    <p className="text-xs text-gray-500 text-center py-2">
                      {fieldSearch ? 'No matching measures' : 'No measures available'}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Main Content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Selected Fields Bar */}
          {(selectedDimensions.length > 0 || selectedMeasures.length > 0) && (
            <div className="bg-white border-b border-gray-200 p-4">
              <div className="flex items-start gap-6">
                {selectedDimensions.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-gray-700 uppercase mb-2">Dimensions</h3>
                    <div className="flex flex-wrap gap-2">
                      {selectedDimensions.map(dim => (
                        <span
                          key={dim}
                          className="inline-flex items-center gap-1 px-2 py-1 text-sm bg-blue-50 text-blue-700 rounded"
                        >
                          {dim}
                          <button
                            onClick={() => handleToggleDimension(dim)}
                            className="hover:bg-blue-100 rounded"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {selectedMeasures.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold text-gray-700 uppercase mb-2">Measures</h3>
                    <div className="flex flex-wrap gap-2">
                      {selectedMeasures.map(measure => (
                        <span
                          key={measure.field}
                          className="inline-flex items-center gap-1 px-2 py-1 text-sm bg-green-50 text-green-700 rounded"
                        >
                          {measure.aggregation.toUpperCase()}({measure.field})
                          <button
                            onClick={() => handleToggleMeasure(measure.field)}
                            className="hover:bg-green-100 rounded"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Results */}
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
                {chartType === 'TABLE' ? (
                  <DatasetTableGrid
                    columns={displayColumns}
                    rows={displayData?.rows || []}
                  />
                ) : (
                  <div className="h-full p-4">
                    <ExploreChart
                      type={chartType}
                      data={displayData?.rows || []}
                      dimensions={selectedDimensions}
                      measures={selectedMeasures.map(m => `${m.field}_${m.aggregation}`)}
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
