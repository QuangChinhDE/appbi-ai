/**
 * Explore editor — view/edit a specific chart, or create a new one (/explore/new).
 */
'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Save, ArrowLeft, ChevronDown, ChevronUp, Pencil, Check, Search, Plus, Trash2, Tag, Settings2 } from 'lucide-react';
import { useWorkspace, useTablePreview } from '@/hooks/use-dataset-workspaces';
import { ExploreSourceSelector } from '@/components/explore/ExploreSourceSelector';
import { DatasetTableGrid } from '@/components/datasets/DatasetTableGrid';
import { ExploreChart } from '@/components/explore/ExploreChart';
import { FilterBuilder, type Filter } from '@/components/explore/FilterBuilder';
import { useChart, useCreateChart, useUpdateChart, useUpsertChartMetadata, useReplaceChartParameters } from '@/hooks/use-charts';
import { applyFilters } from '@/lib/explore-utils';
import { ExploreChartConfig, type ExploreChartType, type ChartRoleConfig, type AggFn } from '@/components/explore/ExploreChartConfig';
import { toast } from 'sonner';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import type { ChartMetadataUpsert, ChartParameterCreate } from '@/types/api';

type ChartType = ExploreChartType;

const DOMAIN_OPTIONS = ['sales', 'marketing', 'finance', 'operations', 'hr', 'product', 'logistics'];
const INTENT_OPTIONS = ['trend', 'comparison', 'ranking', 'summary', 'distribution', 'composition'];
const PARAM_TYPE_OPTIONS = [
  { value: 'time_range', label: 'Time Range' },
  { value: 'dimension', label: 'Dimension' },
  { value: 'measure', label: 'Measure' },
];

export default function ExploreDetailPage() {
  const params = useParams();
  const router = useRouter();
  const isNew = params.id === 'new';
  const chartId = isNew ? null : Number(params.id);

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<number | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [chartType, setChartType] = useState<ChartType>('TABLE');
  const [chartRoleConfig, setChartRoleConfig] = useState<ChartRoleConfig>({ metrics: [] });
  const [isSourceOpen, setIsSourceOpen] = useState(true);
  const [chartNameInput, setChartNameInput] = useState('');
  const [isEditingName, setIsEditingName] = useState(isNew);
  const [chartDescInput, setChartDescInput] = useState('');
  const [isEditingDesc, setIsEditingDesc] = useState(false);
  const [isChartLoaded, setIsChartLoaded] = useState(isNew); // skip load for new charts

  const [isConfigOpen, setIsConfigOpen] = useState(true);
  const [isFiltersOpen, setIsFiltersOpen] = useState(false);

  // ── Metadata state ───────────────────────────────────────────────────────
  const [isMetaOpen, setIsMetaOpen] = useState(false);
  const [metaDomain, setMetaDomain] = useState('');
  const [metaIntent, setMetaIntent] = useState('');
  const [metaMetrics, setMetaMetrics] = useState<string[]>([]);
  const [metaDimensions, setMetaDimensions] = useState<string[]>([]);
  const [metaTags, setMetaTags] = useState<string[]>([]);
  const [metaChipInput, setMetaChipInput] = useState({ metric: '', dimension: '', tag: '' });

  // ── Parameters state ─────────────────────────────────────────────────────
  const [isParamsOpen, setIsParamsOpen] = useState(false);
  type ParamRow = ChartParameterCreate & { _key: string };
  const [paramRows, setParamRows] = useState<ParamRow[]>([]);

  const createChart = useCreateChart();
  const updateChart = useUpdateChart();
  const upsertMetadata = useUpsertChartMetadata();
  const replaceParams = useReplaceChartParameters();

  const { data: chart, isLoading: isChartLoading } = useChart(chartId ?? 0);
  const { data: workspace } = useWorkspace(selectedWorkspaceId);
  const resPerms = getResourcePermissions(isNew ? 'full' : chart?.user_permission);

  // Load existing chart config into editor state on first data arrival
  useEffect(() => {
    if (isChartLoaded || isNew) return;
    if (!chart) return;

    const config = chart.config as any;
    if (chart.workspace_table_id) {
      setSelectedTableId(chart.workspace_table_id);
      if (config?.workspace_id) setSelectedWorkspaceId(config.workspace_id);
    } else if (config?.source?.kind === 'workspace_table') {
      setSelectedWorkspaceId(config.source.workspaceId);
      setSelectedTableId(config.source.tableId);
    }
    setFilters(config?.filters ?? []);
    setChartType(config?.chartType ?? 'TABLE');
    if (config?.roleConfig) {
      const rc = config.roleConfig as ChartRoleConfig;
      // Migrate legacy metrics format (string[] → {field, agg}[])
      if (rc.metrics?.length > 0 && typeof (rc.metrics as any)[0] === 'string') {
        rc.metrics = (rc.metrics as unknown as string[]).map((f) => ({ field: f, agg: 'sum' as AggFn }));
      }
      setChartRoleConfig(rc);
    }
    setChartNameInput(chart.name);
    setChartDescInput(chart.description ?? '');
    // Load metadata
    if (chart.metadata) {
      setMetaDomain(chart.metadata.domain ?? '');
      setMetaIntent(chart.metadata.intent ?? '');
      setMetaMetrics(chart.metadata.metrics ?? []);
      setMetaDimensions(chart.metadata.dimensions ?? []);
      setMetaTags(chart.metadata.tags ?? []);
    }
    // Load parameters
    if (chart.parameters?.length) {
      setParamRows(chart.parameters.map((p) => ({
        ...p,
        column_mapping: p.column_mapping ?? null,
        default_value: p.default_value ?? null,
        description: p.description ?? null,
        _key: String(p.id),
      })));
    }
    setIsChartLoaded(true);
  }, [chart, isChartLoaded, isNew]);

  const {
    data: previewData,
    isLoading,
    error,
    refetch,
  } = useTablePreview(selectedWorkspaceId, selectedTableId, {});

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

  // Reset config when user manually changes the table (skip during initial chart load)
  const isInitialTableSet = useRef(false);
  useEffect(() => {
    if (!selectedTableId) return;
    if (!isInitialTableSet.current) {
      isInitialTableSet.current = true;
      return;
    }
    setFilters([]);
    setChartRoleConfig({ metrics: [] });
  }, [selectedTableId]);

  // Auto-suggest fields when switching to a chart type
  useEffect(() => {
    if (chartType === 'TABLE') return;
    const cols = previewData?.columns;
    if (!cols?.length) return;
    setChartRoleConfig((prev) => {
      if (prev.dimension || prev.metrics.length > 0) return prev;
      const firstDim = cols.find((c) => c.type !== 'number')?.name;
      const firstNum = cols.find((c) => c.type === 'number')?.name;
      return {
        ...prev,
        dimension: firstDim,
        metrics: firstNum ? [{ field: firstNum, agg: 'sum' as AggFn }] : [],
      };
    });
  }, [chartType, previewData?.columns]);

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

    const metaPayload: ChartMetadataUpsert = {
      domain: metaDomain || null,
      intent: metaIntent || null,
      metrics: metaMetrics,
      dimensions: metaDimensions,
      tags: metaTags,
    };
    const hasMetadata = metaDomain || metaIntent || metaMetrics.length || metaDimensions.length || metaTags.length;

    try {
      if (chartId !== null) {
        await updateChart.mutateAsync({
          id: chartId,
          data: {
            name: chartNameInput.trim() || undefined,
            description: chartDescInput.trim() || null,
            chart_type: chartType as any,
            workspace_table_id: selectedTableId,
            config: exploreConfig as unknown as import('@/types/api').ChartConfig,
          },
        });
        await Promise.all([
          hasMetadata ? upsertMetadata.mutateAsync({ id: chartId, data: metaPayload }) : Promise.resolve(),
          replaceParams.mutateAsync({ id: chartId, params: paramRows }),
        ]);
        toast.success('Chart updated successfully!');
      } else {
        const name = chartNameInput.trim();
        if (!name) {
          setIsEditingName(true);
          toast.error('Please enter a chart name');
          return;
        }
        const newChart = await createChart.mutateAsync({
          name,
          description: chartDescInput.trim() || undefined,
          chart_type: chartType as any,
          workspace_table_id: selectedTableId,
          config: exploreConfig as unknown as import('@/types/api').ChartConfig,
        });
        await Promise.all([
          hasMetadata ? upsertMetadata.mutateAsync({ id: newChart.id, data: metaPayload }) : Promise.resolve(),
          paramRows.length ? replaceParams.mutateAsync({ id: newChart.id, params: paramRows }) : Promise.resolve(),
        ]);
        toast.success(`Chart "${name}" saved!`);
        router.replace('/explore/' + newChart.id);
      }
    } catch (error: any) {
      console.error('Error saving chart:', error);
      toast.error(`Failed to save chart: ${error?.response?.data?.detail || error.message}`);
    }
  };

  // ── Metadata helpers ─────────────────────────────────────────────────────
  const addChip = (field: 'metric' | 'dimension' | 'tag') => {
    const val = metaChipInput[field].trim();
    if (!val) return;
    if (field === 'metric') setMetaMetrics((p) => (p.includes(val) ? p : [...p, val]));
    if (field === 'dimension') setMetaDimensions((p) => (p.includes(val) ? p : [...p, val]));
    if (field === 'tag') setMetaTags((p) => (p.includes(val) ? p : [...p, val]));
    setMetaChipInput((p) => ({ ...p, [field]: '' }));
  };
  const removeChip = (field: 'metric' | 'dimension' | 'tag', val: string) => {
    if (field === 'metric') setMetaMetrics((p) => p.filter((v) => v !== val));
    if (field === 'dimension') setMetaDimensions((p) => p.filter((v) => v !== val));
    if (field === 'tag') setMetaTags((p) => p.filter((v) => v !== val));
  };

  // ── Parameter helpers ─────────────────────────────────────────────────────
  const addParamRow = () =>
    setParamRows((p) => [...p, { _key: String(Date.now()), parameter_name: '', parameter_type: 'dimension', column_mapping: null, default_value: null, description: null }]);
  const updateParamRow = (key: string, field: string, value: any) =>
    setParamRows((p) => p.map((r) => (r._key === key ? { ...r, [field]: value } : r)));
  const removeParamRow = (key: string) => setParamRows((p) => p.filter((r) => r._key !== key));

  const selectedTable = workspace?.tables?.find((t: any) => t.id === selectedTableId);

  // Show loading skeleton while fetching existing chart
  if (!isNew && isChartLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="inline-block w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-3" />
          <p className="text-sm text-gray-600">Loading chart…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => router.push('/explore')}
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
                    onChange={(e) => setChartNameInput(e.target.value)}
                    onBlur={() => {
                      setIsEditingName(false);
                      if (chartId && chartNameInput.trim()) {
                        updateChart.mutate({ id: chartId, data: { name: chartNameInput.trim() } });
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') {
                        setChartNameInput(chart?.name ?? '');
                        setIsEditingName(false);
                      }
                    }}
                    placeholder="Chart name…"
                    className="text-lg font-semibold text-gray-900 border-b border-blue-400 bg-transparent outline-none px-0.5 min-w-[10rem]"
                  />
                  <Check className="w-4 h-4 text-blue-500" />
                </div>
              ) : (
                <div className="flex items-center gap-1.5 group/name">
                  <h1 className="text-lg font-semibold text-gray-900">
                    {chartNameInput || (chartId ? 'Chart' : 'New Chart')}
                  </h1>
                  {resPerms.canEdit && (
                  <button
                    onClick={() => setIsEditingName(true)}
                    className="opacity-0 group-hover/name:opacity-100 text-gray-400 hover:text-gray-600 transition-opacity"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  )}
                </div>
              )}
            </div>
            {selectedTable && (
              <p className="text-sm text-gray-500 mt-0.5 ml-[calc(1rem+4px+8px)]">
                {workspace?.name} / {(selectedTable as any).display_name || 'Table'}
              </p>
            )}
            {/* Description — inline editable */}
            <div className="mt-1 ml-[calc(1rem+4px+8px)]">
              {isEditingDesc ? (
                <input
                  autoFocus
                  type="text"
                  value={chartDescInput}
                  onChange={(e) => setChartDescInput(e.target.value)}
                  onBlur={() => {
                    setIsEditingDesc(false);
                    if (chartId) {
                      updateChart.mutate({ id: chartId, data: { description: chartDescInput.trim() || null } });
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') { setChartDescInput(chart?.description ?? ''); setIsEditingDesc(false); }
                  }}
                  placeholder="Add a description…"
                  className="text-xs text-gray-600 border-b border-blue-400 bg-transparent outline-none px-0.5 w-80"
                />
              ) : (
                resPerms.canEdit ? (
                  <div
                    onClick={() => setIsEditingDesc(true)}
                    className="group/desc flex items-center gap-1 cursor-text"
                  >
                    {chartDescInput ? (
                      <span className="text-xs text-gray-500">{chartDescInput}</span>
                    ) : (
                      <span className="text-xs text-gray-300 italic">Add a description…</span>
                    )}
                    <Pencil className="w-3 h-3 text-gray-300 opacity-0 group-hover/desc:opacity-100 transition-opacity" />
                  </div>
                ) : (
                  chartDescInput ? (
                    <span className="text-xs text-gray-500">{chartDescInput}</span>
                  ) : null
                )
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {resPerms.canEdit && (
            <button
              onClick={handleSaveLook}
              disabled={!selectedTableId}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <Save className="w-4 h-4" />
              {chartId ? 'Update Chart' : 'Save Chart'}
            </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar */}
        <div className="w-80 bg-white border-r border-gray-200 flex flex-col overflow-hidden">
          <div className="border-b">
            <button
              onClick={() => setIsSourceOpen((o) => !o)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
            >
              <h2 className="text-sm font-semibold text-gray-900">Data Source</h2>
              {isSourceOpen ? (
                <ChevronUp className="w-4 h-4 text-gray-400" />
              ) : (
                <ChevronDown className="w-4 h-4 text-gray-400" />
              )}
            </button>
            {isSourceOpen && (
              <div className="px-4 pb-4">
                <ExploreSourceSelector
                  selectedWorkspaceId={selectedWorkspaceId}
                  selectedTableId={selectedTableId}
                  onWorkspaceChange={setSelectedWorkspaceId}
                  onTableChange={setSelectedTableId}
                />
              </div>
            )}
          </div>

          {selectedTableId && (
            <div className="flex-1 overflow-y-auto">
              {/* ── Chart Config panel ─────────────────────────────────── */}
              <div className="border-b">
                <button
                  onClick={() => setIsConfigOpen((o) => !o)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
                >
                  <span className="text-sm font-semibold text-gray-900">Chart Config</span>
                  {isConfigOpen ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                </button>
                {isConfigOpen && (
                  <ExploreChartConfig
                    chartType={chartType}
                    roleConfig={chartRoleConfig}
                    availableColumns={previewData?.columns || []}
                    onChartTypeChange={setChartType}
                    onRoleConfigChange={setChartRoleConfig}
                  />
                )}
              </div>

              {/* ── Filters panel ──────────────────────────────────────── */}
              <div className="border-b">
                <button
                  onClick={() => setIsFiltersOpen((o) => !o)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-gray-900">Filters</span>
                    {filters.length > 0 && (
                      <span className="px-1.5 py-0.5 text-xs bg-orange-100 text-orange-700 rounded-full">{filters.length}</span>
                    )}
                  </div>
                  {isFiltersOpen ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                </button>
                {isFiltersOpen && (
                  <div className="px-4 pb-4">
                    <p className="text-xs text-gray-500 mb-2">Static filters — always applied when chart renders.</p>
                    <FilterBuilder
                      filters={filters}
                      onChange={setFilters}
                      availableFields={previewData?.columns?.map((c) => c.name) || []}
                    />
                  </div>
                )}
              </div>

              {/* ── Metadata panel ─────────────────────────────────────── */}
              <div className="border-t">
                <button
                  onClick={() => setIsMetaOpen((o) => !o)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <Tag className="w-3.5 h-3.5 text-gray-400" />
                    <span className="text-sm font-semibold text-gray-900">Metadata</span>
                    {(metaDomain || metaIntent || metaMetrics.length > 0 || metaTags.length > 0) && (
                      <span className="w-2 h-2 rounded-full bg-blue-500" />
                    )}
                  </div>
                  {isMetaOpen ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                </button>
                {isMetaOpen && (
                  <div className="px-4 pb-4 space-y-3 text-sm">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Domain</label>
                        <select value={metaDomain} onChange={(e) => setMetaDomain(e.target.value)} className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs">
                          <option value="">None</option>
                          {DOMAIN_OPTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Intent</label>
                        <select value={metaIntent} onChange={(e) => setMetaIntent(e.target.value)} className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs">
                          <option value="">None</option>
                          {INTENT_OPTIONS.map((i) => <option key={i} value={i}>{i}</option>)}
                        </select>
                      </div>
                    </div>

                    {/* Metrics */}
                    {(() => {
                      const chips = metaMetrics;
                      const suggestedMetrics = chartRoleConfig.metrics.map((m) => m.field).filter((f) => !chips.includes(f));
                      return (
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-0.5">Metrics</label>
                          <p className="text-xs text-gray-400 mb-1.5">Business name of <em>what you're measuring</em> — e.g. <code className="bg-gray-100 px-0.5 rounded">revenue</code>, <code className="bg-gray-100 px-0.5 rounded">order_count</code></p>
                          {suggestedMetrics.length > 0 && (
                            <div className="flex flex-wrap gap-1 mb-1.5">
                              <span className="text-xs text-gray-400 self-center">Suggest:</span>
                              {suggestedMetrics.map((s) => (
                                <button key={s} type="button" onClick={() => setMetaMetrics((p) => [...p, s])}
                                  className="px-1.5 py-0.5 text-xs border border-dashed border-blue-300 text-blue-500 rounded-full hover:bg-blue-50">
                                  + {s}
                                </button>
                              ))}
                            </div>
                          )}
                          <div className="flex flex-wrap gap-1 mb-1">
                            {chips.map((v) => (
                              <span key={v} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs rounded-full bg-blue-100 text-blue-700">
                                {v}<button type="button" onClick={() => removeChip('metric', v)} className="hover:opacity-70">×</button>
                              </span>
                            ))}
                          </div>
                          <div className="flex gap-1">
                            <input value={metaChipInput.metric} onChange={(e) => setMetaChipInput((p) => ({ ...p, metric: e.target.value }))}
                              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addChip('metric'))}
                              placeholder="Type business name, press Enter"
                              className="flex-1 px-2 py-1 border border-gray-200 rounded text-xs" />
                            <button type="button" onClick={() => addChip('metric')} className="px-2 py-1 bg-gray-100 border border-gray-200 rounded text-xs hover:bg-gray-200">+</button>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Dimensions */}
                    {(() => {
                      const chips = metaDimensions;
                      const suggestedDims = (chartRoleConfig.dimension ? [chartRoleConfig.dimension] : []).filter((f) => !chips.includes(f));
                      return (
                        <div>
                          <label className="block text-xs font-medium text-gray-600 mb-0.5">Dimensions</label>
                          <p className="text-xs text-gray-400 mb-1.5">Business name of <em>how you're grouping</em> — e.g. <code className="bg-gray-100 px-0.5 rounded">month</code>, <code className="bg-gray-100 px-0.5 rounded">region</code></p>
                          {suggestedDims.length > 0 && (
                            <div className="flex flex-wrap gap-1 mb-1.5">
                              <span className="text-xs text-gray-400 self-center">Suggest:</span>
                              {suggestedDims.map((s) => (
                                <button key={s} type="button" onClick={() => setMetaDimensions((p) => [...p, s])}
                                  className="px-1.5 py-0.5 text-xs border border-dashed border-green-300 text-green-600 rounded-full hover:bg-green-50">
                                  + {s}
                                </button>
                              ))}
                            </div>
                          )}
                          <div className="flex flex-wrap gap-1 mb-1">
                            {chips.map((v) => (
                              <span key={v} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs rounded-full bg-green-100 text-green-700">
                                {v}<button type="button" onClick={() => removeChip('dimension', v)} className="hover:opacity-70">×</button>
                              </span>
                            ))}
                          </div>
                          <div className="flex gap-1">
                            <input value={metaChipInput.dimension} onChange={(e) => setMetaChipInput((p) => ({ ...p, dimension: e.target.value }))}
                              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addChip('dimension'))}
                              placeholder="Type business name, press Enter"
                              className="flex-1 px-2 py-1 border border-gray-200 rounded text-xs" />
                            <button type="button" onClick={() => addChip('dimension')} className="px-2 py-1 bg-gray-100 border border-gray-200 rounded text-xs hover:bg-gray-200">+</button>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Tags */}
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-0.5">Tags</label>
                      <p className="text-xs text-gray-400 mb-1.5">Free labels for search — e.g. <code className="bg-gray-100 px-0.5 rounded">weekly</code>, <code className="bg-gray-100 px-0.5 rounded">executive</code>, <code className="bg-gray-100 px-0.5 rounded">q1-2026</code></p>
                      <div className="flex flex-wrap gap-1 mb-1">
                        {metaTags.map((v) => (
                          <span key={v} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs rounded-full bg-gray-100 text-gray-600">
                            {v}<button type="button" onClick={() => removeChip('tag', v)} className="hover:opacity-70">×</button>
                          </span>
                        ))}
                      </div>
                      <div className="flex gap-1">
                        <input value={metaChipInput.tag} onChange={(e) => setMetaChipInput((p) => ({ ...p, tag: e.target.value }))}
                          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addChip('tag'))}
                          placeholder="Type tag, press Enter"
                          className="flex-1 px-2 py-1 border border-gray-200 rounded text-xs" />
                        <button type="button" onClick={() => addChip('tag')} className="px-2 py-1 bg-gray-100 border border-gray-200 rounded text-xs hover:bg-gray-200">+</button>
                      </div>
                    </div>

                    {!isNew && (
                      <p className="text-xs text-gray-400 italic">Saved automatically on "Update Chart"</p>
                    )}
                  </div>
                )}
              </div>

              {/* ── Parameters panel ───────────────────────────────────── */}
              <div className="border-t">
                <button
                  onClick={() => setIsParamsOpen((o) => !o)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <Settings2 className="w-3.5 h-3.5 text-gray-400" />
                    <span className="text-sm font-semibold text-gray-900">Parameters</span>
                    {paramRows.length > 0 && (
                      <span className="px-1.5 py-0.5 text-xs bg-purple-100 text-purple-700 rounded-full">{paramRows.length}</span>
                    )}
                  </div>
                  {isParamsOpen ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
                </button>
                {isParamsOpen && (
                  <div className="px-4 pb-4 space-y-2">
                    <p className="text-xs text-gray-500">Define filters this chart can accept when added to a dashboard.</p>
                    {paramRows.map((row) => (
                      <div key={row._key} className="bg-gray-50 rounded border border-gray-200 p-2 space-y-1.5">
                        <div className="flex items-center gap-1">
                          <input
                            value={row.parameter_name}
                            onChange={(e) => updateParamRow(row._key, 'parameter_name', e.target.value)}
                            placeholder="param_name"
                            className="flex-1 px-2 py-1 border border-gray-200 rounded text-xs"
                          />
                          {resPerms.canEdit && (
                          <button type="button" onClick={() => removeParamRow(row._key)} className="text-gray-400 hover:text-red-500 p-0.5">
                            <Trash2 className="w-3 h-3" />
                          </button>
                          )}
                        </div>
                        <select
                          value={row.parameter_type}
                          onChange={(e) => updateParamRow(row._key, 'parameter_type', e.target.value)}
                          className="w-full px-2 py-1 border border-gray-200 rounded text-xs"
                        >
                          {PARAM_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                        <input
                          value={row.column_mapping?.column ?? ''}
                          onChange={(e) => updateParamRow(row._key, 'column_mapping', e.target.value ? { column: e.target.value, type: 'string' } : null)}
                          placeholder="Column mapping (optional)"
                          className="w-full px-2 py-1 border border-gray-200 rounded text-xs"
                        />
                        <input
                          value={row.default_value ?? ''}
                          onChange={(e) => updateParamRow(row._key, 'default_value', e.target.value || null)}
                          placeholder="Default value (optional)"
                          className="w-full px-2 py-1 border border-gray-200 rounded text-xs"
                        />
                      </div>
                    ))}
                    {resPerms.canEdit && (
                    <button
                      type="button"
                      onClick={addParamRow}
                      className="flex items-center gap-1 text-xs text-purple-600 hover:text-purple-700 font-medium"
                    >
                      <Plus className="w-3 h-3" /> Add Parameter
                    </button>
                    )}
                    {!isNew && (
                      <p className="text-xs text-gray-400 italic">Saved automatically on "Update Chart"</p>
                    )}
                  </div>
                )}
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
                  <div className="inline-block w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-3" />
                  <p className="text-sm text-gray-600">Loading data…</p>
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
                  (() => {
                    const sel = chartRoleConfig.selectedColumns;
                    const cols =
                      sel && sel.length > 0
                        ? (displayData?.columns || []).filter((c) => sel.includes(c.name))
                        : displayData?.columns || [];
                    const rows = (displayData?.rows || []).map((row) =>
                      sel && sel.length > 0 ? Object.fromEntries(sel.map((k) => [k, row[k]])) : row
                    );
                    return <DatasetTableGrid columns={cols} rows={rows} />;
                  })()
                ) : (
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
