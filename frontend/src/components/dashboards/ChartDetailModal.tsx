'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, Database, Loader2, Palette, Table2 } from 'lucide-react';
import { toast } from '@/lib/toast';

import { AppModalShell } from '@/components/common/AppModalShell';
import { DatasetTableGrid } from '@/components/datasets/DatasetTableGrid';
import { ChartPreview } from '@/components/charts/ChartPreview';
import { ExploreChart } from '@/components/explore/ExploreChart';
import {
  ExploreChartConfig,
  normalizeChartStyleConfig,
  normalizeRoleConfig,
  type ChartRoleConfig,
  type ChartStyleConfig,
} from '@/components/explore/ExploreChartConfig';
import { buildExploreChartModel } from '@/components/explore/chartDataAdapter';
import { useChart, useChartData } from '@/hooks/use-charts';
import { useDataset } from '@/hooks/use-datasets';
import { chartApi } from '@/lib/api/charts';
import { dashboardApi } from '@/lib/api/dashboards';
import { getActiveChartRoleConfig, getSavedChartQueryMode } from '@/lib/chart-config';
import {
  buildDashboardChartLayoutWithStyleOverride,
  buildDashboardChartStyleOverride,
  getBaseChartStyleConfig,
  getEffectiveDashboardChartStyleConfig,
} from '@/lib/dashboard-chart-style';
import { inferQueryColumns } from '@/lib/explore-query';
import type { ChartParameter, ColumnMetadata } from '@/types/api';

interface ChartDetailModalProps {
  chartId: number;
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  instanceParameters?: Record<string, any>;
  dashboardId?: number;
  dashboardChartId?: number;
  currentLayout?: Record<string, any> | null;
  allowAppearanceEdit?: boolean;
  initialTab?: 'appearance' | 'data';
}

type DetailPanelTab = 'appearance' | 'data';

const NUMERIC_MAPPING_TYPES = new Set(['number', 'integer', 'float', 'double', 'decimal', 'numeric', 'bigint', 'int']);
const DATE_MAPPING_TYPES = new Set(['date', 'datetime', 'timestamp', 'time']);

function resolveParameterMappingType(param: {
  parameter_type?: string | null;
  column_mapping?: { type?: string | null } | null;
}) {
  const mappingType = (param.column_mapping?.type ?? '').toLowerCase();
  if (mappingType && mappingType !== 'string') return mappingType;

  const parameterType = (param.parameter_type ?? '').toLowerCase();
  if (parameterType === 'time_range') return 'date';
  if (parameterType === 'measure') return 'number';
  return mappingType || 'string';
}

function coerceParameterAtom(rawValue: unknown, mappingType: string) {
  if (rawValue === undefined || rawValue === null) return rawValue;
  if (NUMERIC_MAPPING_TYPES.has(mappingType)) {
    const num = typeof rawValue === 'number' ? rawValue : Number(String(rawValue).trim());
    return Number.isFinite(num) ? num : String(rawValue).trim();
  }
  return typeof rawValue === 'string' ? rawValue.trim() : rawValue;
}

function buildParameterFilters(
  chartParameters: ChartParameter[] | null | undefined,
  instanceParameters: Record<string, any> | null | undefined,
) {
  if (!chartParameters?.length || !instanceParameters) {
    return undefined;
  }

  const filters: Record<string, unknown>[] = [];
  for (const param of chartParameters) {
    const mappedColumn = param.column_mapping?.column;
    const rawValue = instanceParameters[param.parameter_name];
    if (!mappedColumn || rawValue === undefined || rawValue === null) continue;

    const mappingType = resolveParameterMappingType(param);
    const isDateType = DATE_MAPPING_TYPES.has(mappingType);
    const textValue = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (typeof rawValue === 'string' && !textValue) continue;

    const isRangeValue = typeof rawValue === 'string'
      && (textValue.includes('..') || (isDateType && textValue.includes(',')));
    if (isRangeValue) {
      const parts = (textValue.includes('..') ? textValue.split('..') : textValue.split(','))
        .map((part) => part.trim())
        .filter(Boolean);
      if (parts.length > 0) {
        filters.push({
          field: mappedColumn,
          operator: 'between',
          value: [
            parts[0] ? coerceParameterAtom(parts[0], mappingType) : null,
            parts[1] ? coerceParameterAtom(parts[1], mappingType) : null,
          ],
        });
        continue;
      }
    }

    if (Array.isArray(rawValue) || (typeof rawValue === 'string' && textValue.includes(','))) {
      const values = (Array.isArray(rawValue) ? rawValue : textValue.split(','))
        .map((part) => String(part).trim())
        .filter(Boolean)
        .map((part) => coerceParameterAtom(part, mappingType));
      if (values.length > 0) {
        filters.push({ field: mappedColumn, operator: 'in', value: values });
        continue;
      }
    }

    filters.push({
      field: mappedColumn,
      operator: 'eq',
      value: coerceParameterAtom(rawValue, mappingType),
    });
  }

  return filters.length > 0 ? filters : undefined;
}

function getErrorMessage(error: unknown, fallback: string) {
  const responseError = error as any;
  const detail = responseError?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (typeof detail?.message === 'string' && detail.message.trim()) return detail.message.trim();
  if (typeof responseError?.message === 'string' && responseError.message.trim()) return responseError.message.trim();
  return fallback;
}

function isNumericColumnType(type: string | undefined) {
  return NUMERIC_MAPPING_TYPES.has((type ?? '').toLowerCase());
}

function isDateColumnType(type: string | undefined) {
  return DATE_MAPPING_TYPES.has((type ?? '').toLowerCase());
}

function deriveAppearanceRoleConfig(columns: ColumnMetadata[], chartType: string): ChartRoleConfig {
  if (columns.length === 0) {
    return { metrics: [] };
  }

  const numericColumns = columns.filter((column) => isNumericColumnType(column.type));
  const dateColumns = columns.filter((column) => isDateColumnType(column.type));
  const dimensionColumns = columns.filter((column) => !isNumericColumnType(column.type));
  const firstColumnName = columns[0]?.name;
  const primaryDimension = dimensionColumns[0]?.name ?? firstColumnName;
  const secondaryDimension = dimensionColumns[1]?.name;
  const primaryTimeField = dateColumns[0]?.name ?? primaryDimension;
  const metricFields = numericColumns.slice(0, 3).map((column) => ({
    field: column.name,
    agg: 'sum' as const,
    outputField: column.name,
  }));
  const firstMetric = metricFields[0];
  const secondMetric = metricFields[1];

  switch (chartType) {
    case 'TABLE':
      return {
        metrics: [],
        selectedColumns: columns.map((column) => column.name),
      };
    case 'KPI':
      return {
        metrics: firstMetric ? [firstMetric] : [],
        ...(secondMetric ? { benchmarkMetric: secondMetric } : {}),
      };
    case 'TIME_SERIES':
      return {
        metrics: metricFields,
        ...(primaryTimeField ? { timeField: primaryTimeField } : {}),
        ...(secondaryDimension ? { breakdown: secondaryDimension } : {}),
      };
    case 'SCATTER':
      return {
        metrics: [],
        scatterX: numericColumns[0]?.name ?? firstColumnName,
        scatterY: numericColumns[1]?.name ?? numericColumns[0]?.name ?? firstColumnName,
        ...(primaryDimension ? { dimension: primaryDimension } : {}),
      };
    case 'PIE':
      return {
        metrics: firstMetric ? [firstMetric] : [],
        ...(primaryDimension ? { dimension: primaryDimension } : {}),
      };
    case 'BAR_LINE':
      return {
        metrics: firstMetric ? [firstMetric] : [],
        ...(secondMetric ? { lineMetric: secondMetric } : {}),
        ...(primaryDimension ? { dimension: primaryDimension } : {}),
      };
    case 'STACKED_BAR':
      return {
        metrics: firstMetric ? [firstMetric] : [],
        ...(primaryDimension ? { dimension: primaryDimension } : {}),
        ...(secondaryDimension ? { breakdown: secondaryDimension } : {}),
      };
    default:
      return {
        metrics: metricFields,
        ...(primaryDimension ? { dimension: primaryDimension } : {}),
        ...(secondaryDimension ? { breakdown: secondaryDimension } : {}),
      };
  }
}

function inferSortLimitColumns(
  chartType: string,
  rows: Record<string, any>[],
  roleConfig: ChartRoleConfig,
  preAggregated: boolean,
): ColumnMetadata[] {
  if (!rows.length || chartType === 'TABLE' || chartType === 'KPI') {
    return [];
  }

  const model = buildExploreChartModel({
    type: chartType,
    data: rows,
    roleConfig,
    preAggregated,
  });

  const sortRows = (() => {
    if (chartType === 'SCATTER') {
      return model.scatterPoints;
    }
    if (chartType === 'PIE') {
      return model.pieData;
    }
    if (chartType === 'BAR_LINE') {
      return model.comboData;
    }
    return model.categoricalData;
  })();

  if (!sortRows.length) {
    return [];
  }

  return inferQueryColumns(Object.keys(sortRows[0] ?? {}), sortRows);
}

export function ChartDetailModal({
  chartId,
  isOpen,
  onClose,
  title,
  instanceParameters,
  dashboardId,
  dashboardChartId,
  currentLayout = null,
  allowAppearanceEdit = false,
  initialTab = 'data',
}: ChartDetailModalProps) {
  const queryClient = useQueryClient();
  const { data: chart, isLoading: isLoadingChart } = useChart(isOpen ? chartId : 0);
  const config = (chart?.config as Record<string, any> | undefined) ?? {};
  const queryMode = getSavedChartQueryMode(config);
  const activeRoleConfig = useMemo(
    () => getActiveChartRoleConfig(config),
    [config],
  );
  const normalizedRoleConfig = useMemo(
    () => (activeRoleConfig ? normalizeRoleConfig(String(chart?.chart_type ?? ''), activeRoleConfig) : null),
    [activeRoleConfig, chart?.chart_type],
  );
  const parameterFilters = useMemo(
    () => buildParameterFilters(chart?.parameters, instanceParameters),
    [chart?.parameters, instanceParameters],
  );
  const { data: chartRuntime, isLoading: isLoadingRuntime, error: runtimeError } = useChartData(
    isOpen ? chartId : 0,
    parameterFilters,
    'dashboard',
    { enabled: isOpen && !isLoadingChart && Boolean(chart) },
  );

  const datasetId = useMemo(() => {
    const directId = Number(config?.dataset_id);
    if (Number.isFinite(directId) && directId > 0) return directId;

    const sourceId = Number(config?.source?.datasetId);
    if (Number.isFinite(sourceId) && sourceId > 0) return sourceId;

    const bindingId = Number(config?.semanticBinding?.datasetId);
    if (Number.isFinite(bindingId) && bindingId > 0) return bindingId;

    return null;
  }, [config]);
  const { data: dataset } = useDataset(isOpen ? datasetId : null);
  const datasetTable = useMemo(
    () => dataset?.tables?.find((table) => table.id === chart?.dataset_table_id) ?? null,
    [chart?.dataset_table_id, dataset?.tables],
  );

  const customSourcePreview = useQuery({
    queryKey: ['charts', chartId, chart?.updated_at ?? 'unknown', 'detail-source-preview'],
    queryFn: () => chartApi.previewData({
      dataset_table_id: chart!.dataset_table_id!,
      chart_type: String(chart!.chart_type),
      config,
      include_source_sample: true,
      source_sample_limit: 100,
    }),
    enabled: isOpen && queryMode === 'custom' && Boolean(chart?.dataset_table_id),
    staleTime: 60 * 1000,
  });

  const displayTitle = title || chart?.name || `Chart ${chartId}`;
  const exploreChartType = chart?.chart_type ? String(chart.chart_type) : '';
  const canEditAppearance = Boolean(allowAppearanceEdit && dashboardId && dashboardChartId);
  const baseStyleConfig = useMemo(
    () => getBaseChartStyleConfig(chart),
    [chart],
  );
  const savedStyleConfig = useMemo(
    () => getEffectiveDashboardChartStyleConfig(chart, currentLayout),
    [chart, currentLayout],
  );
  const [draftStyleConfig, setDraftStyleConfig] = useState<ChartStyleConfig>(savedStyleConfig);
  const [isSavingAppearance, setIsSavingAppearance] = useState(false);
  const defaultTab: DetailPanelTab = canEditAppearance && initialTab === 'appearance'
    ? 'appearance'
    : 'data';
  const [activeTab, setActiveTab] = useState<DetailPanelTab>(defaultTab);
  const legacyChartConfig = useMemo(() => {
    if (!chart?.config || activeRoleConfig) return {};
    const currentConfig = chart.config as any;
    if (currentConfig.dimensions || currentConfig.measures) {
      return {
        xField: currentConfig.dimensions?.[0],
        yFields: currentConfig.measures || [],
        showLegend: true,
        showGrid: true,
        ...currentConfig,
      };
    }
    return currentConfig;
  }, [activeRoleConfig, chart?.config]);
  const hasAppearanceChanges = useMemo(
    () => JSON.stringify(normalizeChartStyleConfig(draftStyleConfig)) !== JSON.stringify(normalizeChartStyleConfig(savedStyleConfig)),
    [draftStyleConfig, savedStyleConfig],
  );

  const runtimeRows = chartRuntime?.data ?? [];
  const runtimeColumns = useMemo(
    () => inferQueryColumns(Object.keys(runtimeRows[0] ?? {}), runtimeRows),
    [runtimeRows],
  );
  const customSourceRows = customSourcePreview.data?.source_rows ?? [];
  const customSourceColumns = useMemo(() => {
    if (!customSourceRows.length) return [];
    const columnNames = customSourcePreview.data?.source_columns?.length
      ? customSourcePreview.data.source_columns
      : Object.keys(customSourceRows[0] ?? {});
    return inferQueryColumns(columnNames, customSourceRows);
  }, [customSourcePreview.data?.source_columns, customSourceRows]);

  const dataPreviewRows = queryMode === 'custom' && customSourceRows.length > 0
    ? customSourceRows
    : runtimeRows;
  const dataPreviewColumns = queryMode === 'custom' && customSourceColumns.length > 0
    ? customSourceColumns
    : runtimeColumns;
  const dataPreviewTitle = queryMode === 'custom' && customSourceRows.length > 0
    ? 'SQL output sample'
    : 'Chart data preview';
  const dataPreviewDescription = queryMode === 'custom' && customSourceRows.length > 0
    ? 'Sample rows returned by the saved SQL before chart rendering.'
    : 'Rows currently feeding this saved chart configuration.';
  const dataPreviewError = queryMode === 'custom'
    ? (customSourcePreview.error && customSourceRows.length === 0
      ? getErrorMessage(customSourcePreview.error, '')
      : '')
    : getErrorMessage(runtimeError, '');
  const appearanceColumns = runtimeColumns.length > 0 ? runtimeColumns : dataPreviewColumns;
  const appearanceRoleConfig = useMemo(() => {
    if (activeRoleConfig && normalizedRoleConfig) {
      return normalizedRoleConfig;
    }
    return deriveAppearanceRoleConfig(appearanceColumns, exploreChartType);
  }, [activeRoleConfig, appearanceColumns, exploreChartType, normalizedRoleConfig]);
  const sortLimitColumns = useMemo(() => {
    if (!activeRoleConfig || !normalizedRoleConfig) {
      return appearanceColumns;
    }

    return inferSortLimitColumns(
      exploreChartType,
      runtimeRows,
      normalizedRoleConfig,
      chartRuntime?.pre_aggregated ?? false,
    );
  }, [activeRoleConfig, appearanceColumns, chartRuntime?.pre_aggregated, exploreChartType, normalizedRoleConfig, runtimeRows]);
  const previewStyleConfig = canEditAppearance ? draftStyleConfig : savedStyleConfig;

  const isLoadingPreview = isLoadingChart || isLoadingRuntime || (queryMode === 'custom' && customSourcePreview.isLoading);

  useEffect(() => {
    if (!isOpen) return;
    setDraftStyleConfig(savedStyleConfig);
  }, [isOpen, savedStyleConfig]);

  useEffect(() => {
    if (!isOpen) return;
    setActiveTab(defaultTab);
  }, [defaultTab, isOpen]);

  if (!isOpen) return null;

  const handleSaveAppearance = async () => {
    if (!chart || !canEditAppearance || !dashboardId || !dashboardChartId) return;

    setIsSavingAppearance(true);
    try {
      const styleOverride = buildDashboardChartStyleOverride(baseStyleConfig, draftStyleConfig);
      const nextLayout = buildDashboardChartLayoutWithStyleOverride(currentLayout, styleOverride);
      await dashboardApi.updateLayout(dashboardId, [{
        id: dashboardChartId,
        layout: nextLayout,
      }]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboards'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboards', dashboardId] }),
      ]);
      toast.success(styleOverride
        ? 'Chart appearance updated for this dashboard tile'
        : 'Chart appearance reset to the original chart style');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to save chart appearance.'));
    } finally {
      setIsSavingAppearance(false);
    }
  };

  const modalContent = (
    <AppModalShell
      onClose={onClose}
      title={displayTitle}
      description={canEditAppearance
        ? 'Preview the saved chart, inspect its data, and adjust only appearance settings for this dashboard tile. Chart type and field bindings stay locked.'
        : 'Read-only preview of the saved chart setup and sample data.'}
      icon={<BarChart3 className="h-5 w-5" />}
      maxWidthClass="max-w-[97vw]"
      panelClassName="h-[94vh]"
      bodyClassName="flex min-h-0 flex-1 flex-col overflow-hidden p-0"
      closeDisabled={isSavingAppearance}
      footer={(
        <>
          {canEditAppearance && (
            <button
              type="button"
              onClick={() => setDraftStyleConfig(baseStyleConfig)}
              disabled={isSavingAppearance || JSON.stringify(normalizeChartStyleConfig(draftStyleConfig)) === JSON.stringify(normalizeChartStyleConfig(baseStyleConfig))}
              className="rounded-md border border-[rgb(var(--border-strong))] px-4 py-2 text-sm text-text-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Reset to chart default
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={isSavingAppearance}
            className="rounded-md border border-[rgb(var(--border-strong))] px-4 py-2 text-sm text-text-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Close
          </button>
          {canEditAppearance && (
            <button
              type="button"
              onClick={handleSaveAppearance}
              disabled={!chart || !hasAppearanceChanges || isSavingAppearance}
              className="inline-flex items-center rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSavingAppearance && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save appearance
            </button>
          )}
        </>
      )}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 space-y-4 px-6 pb-4 pt-6">
          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">Chart type</p>
              <p className="mt-2 text-sm font-medium text-text-primary">{chart?.chart_type ?? 'Unknown'}</p>
            </div>
            <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">Query mode</p>
              <p className="mt-2 text-sm font-medium capitalize text-text-primary">{queryMode}</p>
            </div>
            <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">Source table</p>
              <p className="mt-2 text-sm font-medium text-text-primary">
                {datasetTable?.display_name || datasetTable?.source_table_name || (chart?.dataset_table_id ? `Table #${chart.dataset_table_id}` : 'Not linked')}
              </p>
            </div>
            <div className="rounded-xl border border-[rgb(var(--border-line))] bg-surface-2 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">Instance params</p>
              <p className="mt-2 text-sm font-medium text-text-primary">
                {instanceParameters && Object.keys(instanceParameters).length > 0
                  ? `${Object.keys(instanceParameters).length} override(s)`
                  : 'None'}
              </p>
            </div>
          </div>

          {instanceParameters && Object.keys(instanceParameters).length > 0 && (
            <div className="flex flex-wrap gap-2 rounded-xl border border-brand/30 bg-brand/10 px-4 py-3">
              {Object.entries(instanceParameters).map(([key, value]) => (
                <span
                  key={key}
                  className="inline-flex items-center rounded-full border border-brand/30 bg-surface-1 px-2.5 py-1 text-xs text-brand"
                >
                  <span className="mr-1 font-semibold">{key}:</span>
                  {String(value)}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 px-6 pb-6">
          <div className="grid h-full min-h-0 gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
          <div className="border-b border-[rgb(var(--border-line))] px-5 py-4">
            <div className="flex items-center gap-2 text-text-primary">
              <BarChart3 className="h-4 w-4 text-brand" />
              <h3 className="text-sm font-semibold">Chart preview</h3>
            </div>
            <p className="mt-1 text-xs text-text-tertiary">
              Saved visualization rendered from the current chart configuration.
            </p>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-5">
            {isLoadingPreview ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-brand" />
              </div>
            ) : runtimeError ? (
              <div className="flex h-full items-center justify-center text-center">
                <div>
                  <p className="text-sm font-medium text-text-primary">Failed to load chart preview</p>
                  <p className="mt-1 text-xs text-text-tertiary">{getErrorMessage(runtimeError, 'Could not load chart preview.')}</p>
                </div>
              </div>
            ) : !chartRuntime ? (
              <div className="flex h-full items-center justify-center text-sm text-text-tertiary">
                No chart preview available.
              </div>
            ) : activeRoleConfig && normalizedRoleConfig ? (
              <ExploreChart
                type={exploreChartType as any}
                data={runtimeRows}
                roleConfig={normalizedRoleConfig}
                styleConfig={previewStyleConfig}
                onStyleConfigChange={setDraftStyleConfig}
                preAggregated={chartRuntime.pre_aggregated ?? false}
              />
            ) : chart ? (
              <ChartPreview
                chartType={chart.chart_type}
                data={runtimeRows}
                config={legacyChartConfig}
                styleConfig={previewStyleConfig}
                onStyleConfigChange={setDraftStyleConfig}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-text-tertiary">
                No chart preview available.
              </div>
            )}
          </div>
        </section>

        <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
          <div className="border-b border-[rgb(var(--border-line))] px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-text-primary">
                {activeTab === 'appearance' ? (
                  <Palette className="h-4 w-4 text-brand" />
                ) : (
                  <Table2 className="h-4 w-4 text-brand" />
                )}
                <h3 className="text-sm font-semibold">
                  {activeTab === 'appearance' ? 'Appearance controls' : dataPreviewTitle}
                </h3>
              </div>
              {canEditAppearance && (
                <div className="inline-flex rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-1">
                  <button
                    type="button"
                    onClick={() => setActiveTab('appearance')}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                      activeTab === 'appearance'
                        ? 'bg-surface-1 text-brand shadow-linear-sm'
                        : 'text-text-tertiary hover:text-text-secondary'
                    }`}
                  >
                    Appearance
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('data')}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                      activeTab === 'data'
                        ? 'bg-surface-1 text-brand shadow-linear-sm'
                        : 'text-text-tertiary hover:text-text-secondary'
                    }`}
                  >
                    Data
                  </button>
                </div>
              )}
            </div>
            <p className="mt-1 text-xs text-text-tertiary">
              {activeTab === 'appearance'
                ? 'Only presentation settings can change here. The original chart type, source, dimensions, and metrics remain locked.'
                : dataPreviewDescription}
            </p>
          </div>

          {activeTab === 'appearance' ? (
            <div className="min-h-0 flex-1 overflow-y-auto bg-surface-2/50">
              <div className="border-b border-brand/20 bg-brand/10 px-5 py-3 text-[11px] text-brand">
                Appearance edits are saved only on this dashboard tile, so the owner&apos;s original chart stays unchanged everywhere else.
              </div>
              {!chart ? (
                <div className="flex h-full items-center justify-center p-6">
                  <Loader2 className="h-6 w-6 animate-spin text-brand" />
                </div>
              ) : (
                <ExploreChartConfig
                  chartType={exploreChartType as any}
                  roleConfig={appearanceRoleConfig}
                  styleConfig={draftStyleConfig}
                  availableColumns={appearanceColumns}
                  sortLimitColumns={sortLimitColumns}
                  tableDisplayColumns={appearanceColumns}
                  queryMode={queryMode}
                  mode="styleOnly"
                  onChartTypeChange={() => {}}
                  onRoleConfigChange={() => {}}
                  onStyleConfigChange={setDraftStyleConfig}
                />
              )}
            </div>
          ) : (
            <>
              {queryMode === 'custom' && customSourceRows.length > 0 && (
                <div className="border-b border-warning/20 bg-warning/10 px-5 py-2 text-[11px] text-warning">
                  This follows the Explore setup view: the table below is the sampled SQL output, while the chart preview on the left shows the saved visualization.
                </div>
              )}
              {datasetTable && (
                <div className="border-b border-[rgb(var(--border-line))] bg-surface-2 px-5 py-3 text-xs text-text-tertiary">
                  <span className="inline-flex items-center gap-1.5">
                    <Database className="h-3.5 w-3.5" />
                    {dataset?.name ? `${dataset.name} / ` : ''}
                    {datasetTable.display_name || datasetTable.source_table_name}
                  </span>
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-hidden">
                {isLoadingPreview ? (
                  <div className="flex h-full items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-brand" />
                  </div>
                ) : dataPreviewError ? (
                  <div className="flex h-full items-center justify-center px-6 text-center">
                    <div>
                      <p className="text-sm font-medium text-text-primary">Failed to load data preview</p>
                      <p className="mt-1 text-xs text-text-tertiary">{dataPreviewError}</p>
                    </div>
                  </div>
                ) : dataPreviewRows.length === 0 ? (
                  <div className="flex h-full items-center justify-center px-6 text-center">
                    <div>
                      <p className="text-sm font-medium text-text-primary">No preview rows available</p>
                      <p className="mt-1 text-xs text-text-tertiary">This chart currently has no sample rows to display.</p>
                    </div>
                  </div>
                ) : (
                  <DatasetTableGrid columns={dataPreviewColumns} rows={dataPreviewRows} readOnly />
                )}
              </div>
            </>
          )}
        </section>
          </div>
        </div>
      </div>
    </AppModalShell>
  );

  if (typeof document === 'undefined') {
    return modalContent;
  }

  return createPortal(modalContent, document.body);
}
