'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, Plus, Search, Sparkles } from 'lucide-react';

import { ExploreEditor } from '@/components/explore/ExploreEditor';
import { Modal } from '@/components/common/Modal';
import { OwnerBadge } from '@/components/common/OwnerBadge';
import { ReadonlyChartTile } from '@/components/dashboards/ReadonlyChartTile';
import { useChartData, useCharts } from '@/hooks/use-charts';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { getDashboardChartPageId } from '@/lib/dashboard-pages';
import { ChartType } from '@/types/api';
import type {
  Chart,
  ChartListScope,
  ChartParameter,
  DashboardChart,
  DashboardChartLayout,
  DashboardPageConfig,
} from '@/types/api';

interface AddChartModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (chartId: number, layout: DashboardChartLayout, parameters?: Record<string, any>) => void | Promise<void>;
  dashboardCharts: DashboardChart[];
  dashboardDatasetIds: number[];
  pages: DashboardPageConfig[];
  activePageId: string;
  isAdding: boolean;
  currentPageName?: string;
}

type AddChartModalMode = 'existing' | 'create';
type ChartTypeFilter = 'all' | ChartType;

const NUMERIC_COLUMN_TYPES = new Set(['number', 'integer', 'float', 'double', 'decimal', 'numeric', 'bigint', 'int']);
const DATE_COLUMN_TYPES = new Set(['date', 'datetime', 'timestamp', 'time']);
const CHART_TYPE_OPTIONS: Array<{ value: ChartTypeFilter; label: string }> = [
  { value: 'all', label: 'All chart types' },
  { value: ChartType.BAR, label: 'Bar' },
  { value: ChartType.HORIZONTAL_BAR, label: 'Horizontal Bar' },
  { value: ChartType.LINE, label: 'Line' },
  { value: ChartType.PIE, label: 'Pie' },
  { value: ChartType.TIME_SERIES, label: 'Time Series' },
  { value: ChartType.TABLE, label: 'Table' },
  { value: ChartType.AREA, label: 'Area' },
  { value: ChartType.STACKED_BAR, label: 'Stacked Bar' },
  { value: ChartType.GROUPED_BAR, label: 'Grouped Bar' },
  { value: ChartType.BAR_LINE, label: 'Bar + Line' },
  { value: ChartType.SCATTER, label: 'Scatter' },
  { value: ChartType.KPI, label: 'KPI' },
];

function clampGridValue(rawValue: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(rawValue)) return fallback;
  return Math.min(max, Math.max(min, Math.round(rawValue)));
}

function resolveParameterInputKind(param: ChartParameter): 'number' | 'date' | 'date_range' | 'text' {
  const mappingType = (param.column_mapping?.type ?? '').toLowerCase();
  if ((param.parameter_type ?? '').toLowerCase() === 'time_range') return 'date_range';
  if (NUMERIC_COLUMN_TYPES.has(mappingType) || (param.parameter_type ?? '').toLowerCase() === 'measure') return 'number';
  if (DATE_COLUMN_TYPES.has(mappingType)) return 'date';
  return 'text';
}

function coerceParameterValue(rawValue: string, param: ChartParameter) {
  const value = rawValue.trim();
  if (!value) return '';

  if (resolveParameterInputKind(param) === 'number') {
    const num = Number(value);
    return Number.isFinite(num) ? num : value;
  }

  return value;
}

function buildChartSourceLabel(chart: Chart): string | null {
  const parts = [chart.dataset_name, chart.dataset_table_name]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : null;
}

function buildChartTypeLabel(chartType: Chart['chart_type']): string {
  return CHART_TYPE_OPTIONS.find((option) => option.value === chartType)?.label ?? String(chartType);
}

function getApiErrorMessage(error: unknown, fallback: string): string {
  const responseError = error as any;
  const detail = responseError?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (typeof detail?.message === 'string' && detail.message.trim()) return detail.message.trim();
  if (typeof responseError?.message === 'string' && responseError.message.trim()) return responseError.message.trim();
  return fallback;
}

export function AddChartModal({
  isOpen,
  onClose,
  onAdd,
  dashboardCharts,
  dashboardDatasetIds,
  pages,
  activePageId,
  isAdding,
  currentPageName,
}: AddChartModalProps) {
  const [mode, setMode] = useState<AddChartModalMode>('existing');
  const [selectedChartId, setSelectedChartId] = useState<number | ''>('');
  const [pendingSelectionChartId, setPendingSelectionChartId] = useState<number | null>(null);
  const [width, setWidth] = useState(4);
  const [height, setHeight] = useState(4);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [searchText, setSearchText] = useState('');
  const [typeFilter, setTypeFilter] = useState<ChartTypeFilter>('all');
  const [scopeFilter, setScopeFilter] = useState<ChartListScope>('all');

  const resetState = useCallback(() => {
    setMode('existing');
    setSelectedChartId('');
    setPendingSelectionChartId(null);
    setWidth(4);
    setHeight(4);
    setParamValues({});
    setSearchText('');
    setTypeFilter('all');
    setScopeFilter('all');
  }, []);

  const debouncedSearchText = useDebouncedValue(searchText.trim(), 250);
  const { data: charts, isLoading } = useCharts({
    enabled: isOpen,
    limit: 500,
    q: debouncedSearchText || undefined,
    chart_type: typeFilter !== 'all' ? typeFilter : undefined,
    scope: scopeFilter,
    sort: debouncedSearchText ? 'relevance' : 'updated_desc',
  });

  const currentPageChartIds = useMemo(
    () => new Set(
      dashboardCharts
        .filter((dashboardChart) => getDashboardChartPageId(dashboardChart.layout) === activePageId)
        .map((dashboardChart) => dashboardChart.chart_id),
    ),
    [activePageId, dashboardCharts],
  );

  const pageNameById = useMemo(() => {
    const map = new Map<string, string>();
    pages.forEach((page) => {
      map.set(page.id, page.name);
    });
    return map;
  }, [pages]);

  const pageIdsByChartId = useMemo(() => {
    const next = new Map<number, Set<string>>();
    dashboardCharts.forEach((dashboardChart) => {
      const pageId = getDashboardChartPageId(dashboardChart.layout);
      if (!next.has(dashboardChart.chart_id)) {
        next.set(dashboardChart.chart_id, new Set<string>());
      }
      next.get(dashboardChart.chart_id)?.add(pageId);
    });
    return next;
  }, [dashboardCharts]);

  const availableCharts = useMemo(
    () => (charts ?? []).filter((chart) => !currentPageChartIds.has(chart.id)),
    [charts, currentPageChartIds],
  );

  useEffect(() => {
    if (!selectedChartId) return;
    if (pendingSelectionChartId != null) return;
    if (!availableCharts.some((chart) => chart.id === selectedChartId)) {
      setSelectedChartId('');
      setParamValues({});
    }
  }, [availableCharts, pendingSelectionChartId, selectedChartId]);

  useEffect(() => {
    if (pendingSelectionChartId == null) return;
    if (!availableCharts.some((chart) => chart.id === pendingSelectionChartId)) return;
    setSelectedChartId(pendingSelectionChartId);
    setPendingSelectionChartId(null);
  }, [availableCharts, pendingSelectionChartId]);

  useEffect(() => {
    if (mode !== 'existing') return;
    if (selectedChartId || availableCharts.length === 0) return;
    setSelectedChartId(availableCharts[0].id);
  }, [availableCharts, mode, selectedChartId]);

  useEffect(() => {
    if (isOpen) return;
    resetState();
  }, [isOpen, resetState]);

  const selectedChart = useMemo(
    () => availableCharts.find((chart) => chart.id === selectedChartId) ?? null,
    [availableCharts, selectedChartId],
  );
  const chartParams = selectedChart?.parameters ?? [];
  const preferredDatasetId = useMemo(() => {
    const validDatasetIds = dashboardDatasetIds.filter((datasetId) => Number.isFinite(datasetId) && datasetId > 0);
    return validDatasetIds.length === 1 ? validDatasetIds[0] : null;
  }, [dashboardDatasetIds]);

  const selectedChartDataQuery = useChartData(
    typeof selectedChartId === 'number' ? selectedChartId : 0,
    undefined,
    'dashboard',
    { enabled: isOpen && mode === 'existing' && typeof selectedChartId === 'number' },
  );

  const sectionedCharts = useMemo(() => {
    const dashboardDatasetIdSet = new Set(
      dashboardDatasetIds.filter((datasetId) => Number.isFinite(datasetId) && datasetId > 0),
    );
    const sections = {
      recommended: [] as Chart[],
      reuse: [] as Chart[],
      shared: [] as Chart[],
      other: [] as Chart[],
    };

    availableCharts.forEach((chart) => {
      const pageIds = pageIdsByChartId.get(chart.id) ?? new Set<string>();
      const appearsElsewhere = Array.from(pageIds).some((pageId) => pageId !== activePageId);
      const matchesDashboardDataset = chart.dataset_id != null && dashboardDatasetIdSet.has(chart.dataset_id);

      if (matchesDashboardDataset) {
        sections.recommended.push(chart);
      } else if (appearsElsewhere) {
        sections.reuse.push(chart);
      } else if (chart.is_shared) {
        sections.shared.push(chart);
      } else {
        sections.other.push(chart);
      }
    });

    return [
      {
        key: 'recommended',
        title: 'Recommended for this dashboard',
        helper: 'Charts connected to datasets already used in this dashboard.',
        items: sections.recommended,
      },
      {
        key: 'reuse',
        title: 'Already used on another page',
        helper: 'Reusable charts already attached elsewhere in this dashboard.',
        items: sections.reuse,
      },
      {
        key: 'shared',
        title: 'Shared with you',
        helper: 'Charts owned by someone else but available for this dashboard.',
        items: sections.shared,
      },
      {
        key: 'other',
        title: 'Other charts',
        helper: 'Everything else you can access.',
        items: sections.other,
      },
    ].filter((section) => section.items.length > 0);
  }, [activePageId, availableCharts, dashboardDatasetIds, pageIdsByChartId]);

  const handleChartChange = (id: number | '') => {
    setPendingSelectionChartId(null);
    setSelectedChartId(id);
    setParamValues({});
  };

  const handleAddExisting = async () => {
    if (!selectedChartId) return;

    const layout: DashboardChartLayout = {
      x: 0,
      y: 0,
      w: width,
      h: height,
    };

    const parameters: Record<string, unknown> = {};
    for (const param of chartParams) {
      const value = paramValues[param.parameter_name];
      if (value !== undefined && value !== '') {
        parameters[param.parameter_name] = coerceParameterValue(value, param);
      } else if (param.default_value) {
        parameters[param.parameter_name] = coerceParameterValue(param.default_value, param);
      }
    }

    await Promise.resolve(onAdd(
      Number(selectedChartId),
      layout,
      Object.keys(parameters).length > 0 ? (parameters as Record<string, any>) : undefined,
    ));
  };

  const handleCreateAndAdd = async (chartId: number) => {
    const layout: DashboardChartLayout = {
      x: 0,
      y: 0,
      w: width,
      h: height,
    };
    try {
      await Promise.resolve(onAdd(chartId, layout));
    } catch (error) {
      setMode('existing');
      setSearchText('');
      setTypeFilter('all');
      setScopeFilter('all');
      setSelectedChartId('');
      setParamValues({});
      setPendingSelectionChartId(chartId);
      throw error;
    }
  };

  const handleClose = () => {
    resetState();
    onClose();
  };

  const selectedChartPreviewError = selectedChartDataQuery.error
    ? getApiErrorMessage(selectedChartDataQuery.error, 'Failed to load chart preview.')
    : null;

  const footer = mode === 'existing'
    ? (
      <>
        <button
          type="button"
          onClick={handleClose}
          className="rounded-md border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
          disabled={isAdding}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleAddExisting()}
          disabled={!selectedChartId || isAdding}
          className="inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="mr-2 h-4 w-4" />
          {isAdding ? 'Adding...' : 'Add Chart'}
        </button>
      </>
    )
    : (
      <button
        type="button"
        onClick={handleClose}
        className="rounded-md border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
      >
        Close
      </button>
    );

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Add Chart to Dashboard"
      size="2xl"
      footer={footer}
      bodyClassName="overflow-hidden p-0"
      contentClassName="max-w-[90vw] xl:max-w-[82rem] h-[90vh] max-h-[90vh]"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-gray-200 bg-gray-50/90 px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 shadow-sm">
              <button
                type="button"
                onClick={() => setMode('existing')}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  mode === 'existing'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                <BarChart3 className="h-3.5 w-3.5" />
                Choose Existing
              </button>
              <button
                type="button"
                onClick={() => setMode('create')}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  mode === 'create'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                <Sparkles className="h-3.5 w-3.5" />
                Create New
              </button>
            </div>

            <div className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-sm">
              <div className="flex items-center gap-2">
                <label className="text-[11px] font-medium uppercase tracking-wide text-gray-500">W</label>
                <input
                  type="number"
                  value={width}
                  onChange={(event) => setWidth(clampGridValue(Number(event.target.value), 2, 12, 4))}
                  min={2}
                  max={12}
                  className="h-8 w-14 rounded-md border border-gray-300 px-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={isAdding}
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-[11px] font-medium uppercase tracking-wide text-gray-500">H</label>
                <input
                  type="number"
                  value={height}
                  onChange={(event) => setHeight(clampGridValue(Number(event.target.value), 2, 10, 4))}
                  min={2}
                  max={10}
                  className="h-8 w-14 rounded-md border border-gray-300 px-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
                  disabled={isAdding}
                />
              </div>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <span className="truncate">
              {mode === 'existing'
                ? 'Search saved charts, review the preview on the right, then add to the current page.'
                : 'Build a new chart without leaving the dashboard. Saving will also add it to this page.'}
            </span>
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">
              Placement: {width}w x {height}h
            </span>
          </div>
        </div>

        {mode === 'existing' ? (
          <div className="flex h-full min-h-0 gap-3 px-5 py-4">
            <div className="min-w-0 flex-[1.45] overflow-hidden rounded-xl border border-gray-200 bg-gray-50">
              <div className="border-b border-gray-200 px-4 py-3">
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_170px_150px]">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">
                      Search charts
                    </span>
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                      <input
                        type="text"
                        value={searchText}
                        onChange={(event) => setSearchText(event.target.value)}
                        placeholder="Search by name, dataset, metric, tag..."
                        className="w-full rounded-md border border-gray-300 py-2 pl-9 pr-3 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </label>

                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">
                      Chart type
                    </span>
                    <select
                      value={typeFilter}
                      onChange={(event) => setTypeFilter(event.target.value as ChartTypeFilter)}
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {CHART_TYPE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">
                      Ownership
                    </span>
                    <select
                      value={scopeFilter}
                      onChange={(event) => setScopeFilter(event.target.value as ChartListScope)}
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="all">All accessible</option>
                      <option value="mine">Mine only</option>
                      <option value="shared">Shared only</option>
                    </select>
                  </label>
                </div>

                {currentPageName && currentPageChartIds.size > 0 && (
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    Charts already added to <span className="font-semibold">{currentPageName}</span> are hidden from this picker.
                  </div>
                )}

                <div className="mt-2 text-sm text-gray-600">
                  {isLoading
                    ? 'Loading chart catalog...'
                    : `${availableCharts.length} chart${availableCharts.length !== 1 ? 's' : ''} available for this page`}
                </div>
              </div>

              <div className="h-full min-h-0 overflow-y-auto px-4 py-3">
                {!isLoading && availableCharts.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-gray-300 bg-white px-4 py-10 text-center text-sm text-gray-500">
                    No charts match the current search or filters.
                  </div>
                ) : (
                  <div className="space-y-5">
                    {sectionedCharts.map((section) => (
                      <div key={section.key}>
                        <div className="mb-2">
                          <h3 className="text-sm font-semibold text-gray-900">{section.title}</h3>
                          <p className="text-xs text-gray-500">{section.helper}</p>
                        </div>

                        <div className="space-y-2">
                          {section.items.map((chart) => {
                            const sourceLabel = buildChartSourceLabel(chart);
                            const pageLabels = Array.from(pageIdsByChartId.get(chart.id) ?? [])
                              .filter((pageId) => pageId !== activePageId)
                              .map((pageId) => pageNameById.get(pageId) ?? pageId);
                            const isSelected = selectedChartId === chart.id;

                            return (
                              <button
                                key={chart.id}
                                type="button"
                                onClick={() => handleChartChange(chart.id)}
                                className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${
                                  isSelected
                                    ? 'border-blue-500 bg-blue-50 shadow-sm'
                                    : 'border-gray-200 bg-white hover:border-blue-300 hover:bg-blue-50/40'
                                }`}
                              >
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <p className="truncate text-sm font-semibold text-gray-900">{chart.name}</p>
                                      {chart.is_shared && (
                                        <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700">
                                          Shared
                                        </span>
                                      )}
                                      <OwnerBadge email={chart.owner_email} />
                                    </div>

                                    {sourceLabel && (
                                      <p className="mt-1 truncate text-xs font-medium text-gray-600">{sourceLabel}</p>
                                    )}

                                    {chart.description && (
                                      <p className="mt-1 line-clamp-2 text-xs text-gray-500">{chart.description}</p>
                                    )}

                                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
                                      <span className="rounded-full bg-blue-50 px-2 py-1 font-medium text-blue-700">
                                        {buildChartTypeLabel(chart.chart_type)}
                                      </span>
                                      {pageLabels.length > 0 && (
                                        <span className="rounded-full bg-gray-100 px-2 py-1 font-medium text-gray-700">
                                          Used on {pageLabels.join(', ')}
                                        </span>
                                      )}
                                      <span className="rounded-full bg-gray-100 px-2 py-1 font-medium text-gray-700">
                                        Updated {new Date(chart.updated_at).toLocaleDateString()}
                                      </span>
                                    </div>
                                  </div>

                                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
                                    isSelected ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600'
                                  }`}>
                                    {isSelected ? 'Selected' : 'Select'}
                                  </span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="flex min-w-[340px] max-w-[360px] flex-1 flex-col gap-3 overflow-y-auto">
              <div className="rounded-xl border border-gray-200 bg-white p-3.5">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Selected chart</p>
                {selectedChart ? (
                  <div className="mt-2.5 space-y-2.5">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-900">{selectedChart.name}</h3>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                          {buildChartTypeLabel(selectedChart.chart_type)}
                        </span>
                        <OwnerBadge email={selectedChart.owner_email} />
                      </div>
                    </div>
                    {buildChartSourceLabel(selectedChart) && (
                      <p className="text-sm text-gray-600">{buildChartSourceLabel(selectedChart)}</p>
                    )}
                    {selectedChart.description && (
                      <p className="text-sm text-gray-500">{selectedChart.description}</p>
                    )}
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-gray-500">
                    Pick a chart from the catalog to review its details and add it to this page.
                  </p>
                )}
              </div>

              <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
                <div className="border-b border-gray-200 px-4 py-2.5">
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Preview</p>
                  <p className="mt-1 text-xs text-gray-500">Saved chart preview using its current defaults.</p>
                </div>
                <div className="h-[280px] p-3.5">
                  {selectedChart ? (
                    <ReadonlyChartTile
                      chart={selectedChart}
                      chartData={selectedChartDataQuery.data}
                      error={selectedChartPreviewError}
                      title={selectedChart.name}
                      compact
                      showChartTypeLabel={false}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-gray-300 bg-gray-50 text-center">
                      <div>
                        <BarChart3 className="mx-auto mb-2 h-8 w-8 text-gray-300" />
                        <p className="text-sm text-gray-500">Select a chart to preview it here.</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {chartParams.length > 0 && (
                <div className="overflow-hidden rounded-xl border border-violet-200 bg-white">
                  <div className="border-b border-violet-100 bg-violet-50 px-4 py-2.5">
                    <p className="text-xs font-medium uppercase tracking-wide text-violet-700">
                      Instance parameters
                    </p>
                    <p className="mt-1 text-xs text-violet-500">Leave blank to keep the chart default values.</p>
                  </div>
                  <div className="space-y-3 p-3.5">
                    {chartParams.map((param) => {
                      const inputKind = resolveParameterInputKind(param);
                      const inputType = inputKind === 'number'
                        ? 'number'
                        : inputKind === 'date'
                          ? 'date'
                          : 'text';
                      const placeholder = param.default_value
                        ?? (inputKind === 'date_range' ? 'YYYY-MM-DD..YYYY-MM-DD' : 'optional');

                      return (
                        <div key={param.parameter_name}>
                          <label className="mb-1 block text-xs font-medium text-gray-700">
                            {param.parameter_name}
                            <span className="ml-1 font-normal text-gray-400">({param.parameter_type})</span>
                            {param.description && (
                              <span className="ml-1 font-normal text-gray-400">- {param.description}</span>
                            )}
                          </label>
                          <input
                            type={inputType}
                            value={paramValues[param.parameter_name] ?? ''}
                            onChange={(event) => setParamValues((previous) => ({
                              ...previous,
                              [param.parameter_name]: event.target.value,
                            }))}
                            placeholder={placeholder}
                            inputMode={inputKind === 'number' ? 'decimal' : undefined}
                            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-violet-400"
                            disabled={isAdding}
                          />
                          {inputKind === 'date_range' && (
                            <p className="mt-1 text-[11px] text-gray-500">Use `start..end` or `start,end`.</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
                The chart will be added at the top{currentPageName ? ` of ${currentPageName}` : ''}. You can drag or resize it after adding.
              </div>
            </div>
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <div className="border-b border-gray-200 bg-white px-5 py-3">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-gray-900">Create a new chart</p>
                  <p className="mt-1 text-xs text-gray-500">
                    Save from the builder to create the chart and add it to this dashboard in one step.
                  </p>
                </div>
                {preferredDatasetId && (
                  <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
                    Prefilled from current dashboard dataset
                  </span>
                )}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              <ExploreEditor
                embedded
                chartId={null}
                initialDatasetId={preferredDatasetId}
                onBack={() => setMode('existing')}
                onChartSaved={handleCreateAndAdd}
                backLabel="Back to picker"
                saveButtonLabel="Save Chart & Add"
              />
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
