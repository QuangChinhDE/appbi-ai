'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, Plus, Search, Sparkles } from 'lucide-react';

import { ChartEditorWithTabs } from '@/components/explore/ChartEditorWithTabs';
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
          className="rounded-md border border-[rgb(var(--border-strong))] px-4 py-2 text-sm hover:bg-surface-2"
          disabled={isAdding}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleAddExisting()}
          disabled={!selectedChartId || isAdding}
          className="inline-flex items-center rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="mr-2 h-4 w-4" />
          {isAdding ? 'Adding...' : 'Add Chart'}
        </button>
      </>
    )
    : undefined;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Add Chart to Dashboard"
      size="full"
      footer={footer}
      bodyClassName="overflow-hidden p-0"
      contentClassName={mode === 'create' ? 'max-w-[96rem]' : 'max-w-[92rem]'}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-[rgb(var(--border-line))] bg-surface-2/90 px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-0.5 shadow-linear-sm">
              <button
                type="button"
                onClick={() => setMode('existing')}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  mode === 'existing'
                    ? 'bg-brand text-white shadow-sm'
                    : 'text-text-secondary hover:bg-surface-2'
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
                    ? 'bg-brand text-white shadow-sm'
                    : 'text-text-secondary hover:bg-surface-2'
                }`}
              >
                <Sparkles className="h-3.5 w-3.5" />
                Create New
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {mode === 'existing' && currentPageName && (
                <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-1 text-[11px] font-medium text-text-secondary shadow-linear-sm">
                  Page: {currentPageName}
                </span>
              )}
              <div className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 px-3 py-2 shadow-linear-sm">
              <div className="flex items-center gap-2">
                <label className="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">W</label>
                <input
                  type="number"
                  value={width}
                  onChange={(event) => setWidth(clampGridValue(Number(event.target.value), 2, 12, 4))}
                  min={2}
                  max={12}
                  className="h-8 w-14 rounded-md border border-[rgb(var(--border-strong))] px-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand"
                  disabled={isAdding}
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">H</label>
                <input
                  type="number"
                  value={height}
                  onChange={(event) => setHeight(clampGridValue(Number(event.target.value), 2, 10, 4))}
                  min={2}
                  max={10}
                  className="h-8 w-14 rounded-md border border-[rgb(var(--border-strong))] px-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand"
                  disabled={isAdding}
                />
              </div>
              </div>
              <span className="rounded-full bg-brand/12 px-3 py-1 text-[11px] font-medium text-brand">
                Placement {width}w x {height}h
              </span>
            </div>
          </div>
        </div>

        {mode === 'existing' ? (
          <div className="grid h-full min-h-0 gap-4 px-5 py-4 xl:grid-cols-[minmax(22rem,0.92fr)_minmax(30rem,1.08fr)]">
            <div className="min-h-0 overflow-hidden rounded-[22px] border border-[rgb(var(--border-line))] bg-surface-2/80 shadow-linear-sm">
              <div className="border-b border-[rgb(var(--border-line))] px-4 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative min-w-[16rem] flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-quaternary" />
                    <input
                      type="text"
                      value={searchText}
                      onChange={(event) => setSearchText(event.target.value)}
                      placeholder="Search saved charts"
                      className="h-10 w-full rounded-lg border border-[rgb(var(--border-strong))] bg-surface-1 py-2 pl-9 pr-3 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand"
                    />
                  </div>

                  <select
                    value={typeFilter}
                    onChange={(event) => setTypeFilter(event.target.value as ChartTypeFilter)}
                    className="h-10 w-[11rem] rounded-lg border border-[rgb(var(--border-strong))] bg-surface-1 px-3 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand"
                  >
                    {CHART_TYPE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>

                  <select
                    value={scopeFilter}
                    onChange={(event) => setScopeFilter(event.target.value as ChartListScope)}
                    className="h-10 w-[10rem] rounded-lg border border-[rgb(var(--border-strong))] bg-surface-1 px-3 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand"
                  >
                    <option value="all">All accessible</option>
                    <option value="mine">Mine only</option>
                    <option value="shared">Shared only</option>
                  </select>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <p className="text-text-tertiary">
                    Search, narrow the catalog, then inspect the full chart preview before adding it.
                  </p>
                  <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-1 px-2.5 py-1 text-[11px] font-medium text-text-secondary">
                    {isLoading
                      ? 'Loading chart catalog...'
                      : `${availableCharts.length} chart${availableCharts.length !== 1 ? 's' : ''} available`}
                  </span>
                </div>

                {currentPageName && currentPageChartIds.size > 0 && (
                  <div className="mt-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
                    Charts already added to <span className="font-semibold">{currentPageName}</span> are hidden from this picker.
                  </div>
                )}
              </div>

              <div className="h-full min-h-0 overflow-y-auto px-4 py-4">
                {!isLoading && availableCharts.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-[rgb(var(--border-strong))] bg-surface-1 px-4 py-10 text-center text-sm text-text-tertiary">
                    No charts match the current search or filters.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {sectionedCharts.map((section) => (
                      <div key={section.key}>
                        <div className="mb-2">
                          <h3 className="text-sm font-semibold text-text-primary">{section.title}</h3>
                          <p className="text-xs text-text-tertiary">{section.helper}</p>
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
                                className={`w-full rounded-[18px] border px-4 py-3 text-left transition-colors ${
                                  isSelected
                                    ? 'border-brand bg-brand/10 shadow-sm'
                                    : 'border-[rgb(var(--border-line))] bg-surface-1 hover:border-brand/40 hover:bg-brand/5'
                                }`}
                              >
                                <div className="flex flex-wrap items-start justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <p className="truncate text-sm font-semibold text-text-primary">{chart.name}</p>
                                      {chart.is_shared && (
                                        <span className="rounded-full bg-brand/15 px-2 py-0.5 text-[11px] font-medium text-brand">
                                          Shared
                                        </span>
                                      )}
                                      <OwnerBadge email={chart.owner_email} />
                                    </div>

                                    {sourceLabel && (
                                      <p className="mt-1 truncate text-xs font-medium text-text-secondary">{sourceLabel}</p>
                                    )}

                                    {chart.description && (
                                      <p className="mt-1 line-clamp-2 text-xs text-text-tertiary">{chart.description}</p>
                                    )}

                                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-text-tertiary">
                                      <span className="rounded-full bg-brand/10 px-2 py-1 font-medium text-brand">
                                        {buildChartTypeLabel(chart.chart_type)}
                                      </span>
                                      {pageLabels.length > 0 && (
                                        <span className="rounded-full bg-surface-2 px-2 py-1 font-medium text-text-secondary">
                                          Used on {pageLabels.join(', ')}
                                        </span>
                                      )}
                                      <span className="rounded-full bg-surface-2 px-2 py-1 font-medium text-text-secondary">
                                        Updated {new Date(chart.updated_at).toLocaleDateString()}
                                      </span>
                                    </div>
                                  </div>

                                  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
                                    isSelected ? 'bg-brand text-white' : 'bg-surface-2 text-text-secondary'
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

            <div className="flex min-h-0 flex-col gap-4">
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
                <div className="border-b border-[rgb(var(--border-line))] px-4 py-3.5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">Preview</p>
                      {selectedChart ? (
                        <>
                          <h3 className="mt-1 truncate text-base font-semibold text-text-primary">{selectedChart.name}</h3>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <span className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">
                              {buildChartTypeLabel(selectedChart.chart_type)}
                            </span>
                            <OwnerBadge email={selectedChart.owner_email} />
                          </div>
                          {buildChartSourceLabel(selectedChart) && (
                            <p className="mt-2 text-sm text-text-secondary">{buildChartSourceLabel(selectedChart)}</p>
                          )}
                          {selectedChart.description && (
                            <p className="mt-1 line-clamp-2 text-sm text-text-tertiary">{selectedChart.description}</p>
                          )}
                        </>
                      ) : (
                        <p className="mt-2 text-sm text-text-tertiary">
                          Pick a chart from the catalog to review it here before adding it.
                        </p>
                      )}
                    </div>
                    <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-text-secondary">
                      Saved chart preview
                    </span>
                  </div>
                </div>

                <div className="min-h-[24rem] flex-1 p-4">
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
                    <div className="flex h-full items-center justify-center rounded-[20px] border border-dashed border-[rgb(var(--border-strong))] bg-surface-2 text-center">
                      <div>
                        <BarChart3 className="mx-auto mb-2 h-8 w-8 text-text-quaternary" />
                        <p className="text-sm text-text-tertiary">Select a chart to preview it here.</p>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {chartParams.length > 0 && (
                <div className="overflow-hidden rounded-[22px] border border-brand/25 bg-surface-1 shadow-linear-sm">
                  <div className="border-b border-brand/25 bg-brand/10 px-4 py-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-brand">
                      Instance parameters
                    </p>
                    <p className="mt-1 text-xs text-brand">Leave blank to keep the chart default values.</p>
                  </div>
                  <div className="max-h-[18rem] space-y-3 overflow-y-auto p-4">
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
                          <label className="mb-1 block text-xs font-medium text-text-secondary">
                            {param.parameter_name}
                            <span className="ml-1 font-normal text-text-quaternary">({param.parameter_type})</span>
                            {param.description && (
                              <span className="ml-1 font-normal text-text-quaternary">- {param.description}</span>
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
                            className="w-full rounded-md border border-[rgb(var(--border-strong))] px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand"
                            disabled={isAdding}
                          />
                          {inputKind === 'date_range' && (
                            <p className="mt-1 text-[11px] text-text-tertiary">Use `start..end` or `start,end`.</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="rounded-[20px] border border-brand/25 bg-brand/8 px-4 py-3 text-sm text-brand">
                The chart will be added at the top{currentPageName ? ` of ${currentPageName}` : ''}. You can drag or resize it after adding.
              </div>
            </div>
          </div>
        ) : (
          <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-hidden">
              <ChartEditorWithTabs
                embedded
                embeddedVariant="dashboard-modal"
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
