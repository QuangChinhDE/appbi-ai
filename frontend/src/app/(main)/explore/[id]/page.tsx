/**
 * Explore editor - view/edit a specific chart, or create a new one (/explore/new).
 */
'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Save, ArrowLeft, ChevronDown, ChevronRight, Pencil, Check, Search, Plus, Trash2, Tag, Settings2, Bot, Play, RotateCcw, Database, Code2, Eye } from 'lucide-react';
import { useDataset, useTablePreview, useExecuteDatasetTableQueryMutation, type ColumnMetadata } from '@/hooks/use-datasets';
import { ExploreSourceSelector } from '@/components/explore/ExploreSourceSelector';
import { DatasetTableGrid } from '@/components/datasets/DatasetTableGrid';
import { ExploreChart } from '@/components/explore/ExploreChart';
import { buildExploreChartModel } from '@/components/explore/chartDataAdapter';
import { FilterBuilder, type Filter } from '@/components/explore/FilterBuilder';
import {
  useChart,
  useCreateChart,
  usePreviewChartData,
  useReplaceChartParameters,
  useUpdateChart,
  useUpsertChartMetadata,
} from '@/hooks/use-charts';
import {
  ExploreChartConfig,
  type ExploreChartType,
  type ChartRoleConfig,
  type ChartStyleConfig,
  type MetricConfig,
  DEFAULT_STYLE_CONFIG,
  normalizeChartStyleConfig,
  normalizeRoleConfig,
} from '@/components/explore/ExploreChartConfig';
import { toast } from 'sonner';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { ChartDescriptionPanel } from '@/components/explore/ChartDescriptionPanel';
import { AppModalShell } from '@/components/common/AppModalShell';
import {
  buildExploreChartResult,
  buildExploreExecuteRequest,
  buildExploreSqlPreview,
  buildQuerySignature,
  inferQueryColumns,
  normalizeExecuteResponseColumns,
  stripTrailingSqlLimit,
} from '@/lib/explore-query';
import type { ChartMetadataUpsert, ChartParameterCreate } from '@/types/api';

type ChartType = ExploreChartType;

const DOMAIN_OPTIONS = ['sales', 'marketing', 'finance', 'operations', 'hr', 'product', 'logistics'];
const INTENT_OPTIONS = ['trend', 'comparison', 'ranking', 'summary', 'distribution', 'composition'];
const PARAM_TYPE_OPTIONS = [
  { value: 'time_range', label: 'Time Range' },
  { value: 'dimension', label: 'Dimension' },
  { value: 'measure', label: 'Measure' },
];

type QueryMode = 'generated' | 'custom';

interface ExploreQueryState {
  source: QueryMode;
  sql: string;
  columns: ColumnMetadata[];
  rows: Record<string, any>[];
  chartRows: Record<string, any>[];
  chartColumns: ColumnMetadata[];
  chartPreAggregated: boolean;
  executionTimeMs?: number;
}

function normalizeSavedQueryMode(config: Record<string, any> | null | undefined): QueryMode {
  const mode = config?.queryMode === 'custom' ? 'custom' : 'generated';
  const customSql = typeof config?.customSql === 'string' ? config.customSql.trim() : '';
  return mode === 'custom' && customSql ? 'custom' : 'generated';
}

function metricMatchesColumns(metric: MetricConfig | null | undefined, columnNames: Set<string>): boolean {
  if (!metric) return false;

  const candidates = [
    metric.field,
    metric.outputField,
    `${metric.agg}__${metric.field}`,
    `${metric.field}_${metric.agg}`,
    `${metric.agg}_${metric.field}`,
    `${metric.field}__${metric.agg}`,
  ].filter((value): value is string => Boolean(value));

  return candidates.some((candidate) => columnNames.has(candidate));
}

function normalizeTableDisplayColumns(
  columns: ColumnMetadata[],
  roleConfig: ChartRoleConfig,
): ColumnMetadata[] {
  if (roleConfig.tableMode !== 'pivot' || !roleConfig.tableRowDimension) {
    return columns;
  }

  return columns.map((column, index) => (
    index === 0
      ? column
      : { ...column, type: 'number' }
  ));
}

function createDefaultTableRoleConfig(roleConfig: ChartRoleConfig): ChartRoleConfig {
  return {
    ...roleConfig,
    dimension: undefined,
    breakdown: undefined,
    timeField: undefined,
    scatterX: undefined,
    scatterY: undefined,
    lineMetric: undefined,
    metrics: [],
    tableMode: 'standard',
    tableRowDimension: undefined,
    tableColumnDimension: undefined,
    tablePivotMetric: undefined,
    selectedColumns: undefined,
  };
}

function createDefaultTableStyleConfig(styleConfig: ChartStyleConfig): ChartStyleConfig {
  return {
    ...styleConfig,
    tableEnableConditionalFormatting: false,
    tableEnableHeatmap: false,
    tableConditionalFormatting: undefined,
    tableHeatmapRules: undefined,
    tableShowSummaryRow: false,
    tableSummaryLabel: DEFAULT_STYLE_CONFIG.tableSummaryLabel,
    tableSummaryLabelColumn: undefined,
    tableSummaryRows: undefined,
  };
}

function getApiErrorMessage(error: any, fallback: string): string {
  const detail = error?.response?.data?.detail ?? error?.response?.data;
  if (typeof detail === 'string' && detail.trim()) {
    const trimmed = detail.trim();
    if (!trimmed.startsWith('<')) {
      return trimmed;
    }
  }
  if (detail?.message) {
    return detail.message;
  }
  if (typeof error?.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

function syncRoleConfigWithColumns(
  chartType: ChartType,
  roleConfig: ChartRoleConfig,
  columns: ColumnMetadata[],
): ChartRoleConfig {
  const normalized = normalizeRoleConfig(chartType, roleConfig);
  if (!columns.length) return normalized;

  const columnNames = new Set(columns.map((column) => column.name));
  const numericColumns = columns.filter((column) => column.type === 'number');
  const categoricalColumns = columns.filter((column) => column.type !== 'number');
  const timeColumns = columns.filter((column) => column.type === 'date' || column.type === 'datetime');
  const fallbackDimension = categoricalColumns[0]?.name ?? columns[0]?.name;
  const fallbackMetric = numericColumns.find((column) => column.name !== fallbackDimension)?.name
    ?? numericColumns[0]?.name;

  const next: ChartRoleConfig = {
    ...normalized,
    dimension: normalized.dimension && columnNames.has(normalized.dimension) ? normalized.dimension : undefined,
    breakdown: normalized.breakdown && columnNames.has(normalized.breakdown) ? normalized.breakdown : undefined,
    timeField: normalized.timeField && columnNames.has(normalized.timeField) ? normalized.timeField : undefined,
    scatterX: normalized.scatterX && columnNames.has(normalized.scatterX) ? normalized.scatterX : undefined,
    scatterY: normalized.scatterY && columnNames.has(normalized.scatterY) ? normalized.scatterY : undefined,
    lineMetric:
      normalized.lineMetric && metricMatchesColumns(normalized.lineMetric, columnNames)
        ? normalized.lineMetric
        : undefined,
    benchmarkMetric:
      normalized.benchmarkMetric && metricMatchesColumns(normalized.benchmarkMetric, columnNames)
        ? normalized.benchmarkMetric
        : undefined,
    metrics: normalized.metrics.filter((metric) => metricMatchesColumns(metric, columnNames)),
    tableRowDimension: normalized.tableRowDimension && columnNames.has(normalized.tableRowDimension)
      ? normalized.tableRowDimension
      : undefined,
    tableColumnDimension: normalized.tableColumnDimension && columnNames.has(normalized.tableColumnDimension)
      ? normalized.tableColumnDimension
      : undefined,
    tablePivotMetric:
      normalized.tablePivotMetric && metricMatchesColumns(normalized.tablePivotMetric, columnNames)
        ? normalized.tablePivotMetric
        : undefined,
    selectedColumns: normalized.selectedColumns?.filter((column) => columnNames.has(column)),
  };

  if (next.selectedColumns && next.selectedColumns.length === 0) {
    next.selectedColumns = undefined;
  }

  if (chartType === 'TABLE') {
    if (next.tableMode === 'pivot') {
      const rowDimensionFallback = categoricalColumns[0]?.name ?? fallbackDimension;
      const columnDimensionFallback = categoricalColumns.find((column) => column.name !== rowDimensionFallback)?.name
        ?? columns.find((column) => column.name !== rowDimensionFallback)?.name;
      const pivotMetricFallback = numericColumns.find((column) => (
        column.name !== rowDimensionFallback && column.name !== columnDimensionFallback
      ))?.name ?? fallbackMetric;

      if (!next.tableRowDimension) {
        next.tableRowDimension = rowDimensionFallback;
      }
      if (!next.tableColumnDimension || next.tableColumnDimension === next.tableRowDimension) {
        next.tableColumnDimension = columnDimensionFallback;
      }
      if (!next.tablePivotMetric && pivotMetricFallback) {
        next.tablePivotMetric = { field: pivotMetricFallback, agg: 'sum' };
      }
    }
    return next;
  }

  if (chartType === 'SCATTER') {
    if (!next.scatterX) next.scatterX = numericColumns[0]?.name;
    if (!next.scatterY) next.scatterY = numericColumns[1]?.name ?? numericColumns[0]?.name;
    if (!next.dimension && categoricalColumns.length > 0) {
      next.dimension = categoricalColumns[0]?.name;
    }
    return next;
  }

  if (chartType === 'TIME_SERIES') {
    if (!next.timeField) next.timeField = timeColumns[0]?.name ?? fallbackDimension;
    if (!next.dimension) next.dimension = next.timeField ?? fallbackDimension;
  } else if (chartType !== 'KPI' && !next.dimension) {
    next.dimension = fallbackDimension;
  }

  if (next.metrics.length === 0 && fallbackMetric) {
    next.metrics = [{ field: fallbackMetric, agg: 'sum' }];
  }

  if (chartType === 'KPI' && next.metrics.length > 1) {
    next.metrics = [next.metrics[0]];
  }

  if (chartType === 'BAR_LINE' && !next.lineMetric && numericColumns[1]) {
    next.lineMetric = { field: numericColumns[1].name, agg: 'sum' };
  }

  return next;
}

function pruneRoleConfigToColumns(
  chartType: ChartType,
  roleConfig: ChartRoleConfig,
  columns: ColumnMetadata[],
): ChartRoleConfig {
  const normalized = normalizeRoleConfig(chartType, roleConfig);
  if (!columns.length) return normalized;

  const columnNames = new Set(columns.map((column) => column.name));

  const next: ChartRoleConfig = {
    ...normalized,
    dimension: normalized.dimension && columnNames.has(normalized.dimension) ? normalized.dimension : undefined,
    breakdown: normalized.breakdown && columnNames.has(normalized.breakdown) ? normalized.breakdown : undefined,
    timeField: normalized.timeField && columnNames.has(normalized.timeField) ? normalized.timeField : undefined,
    scatterX: normalized.scatterX && columnNames.has(normalized.scatterX) ? normalized.scatterX : undefined,
    scatterY: normalized.scatterY && columnNames.has(normalized.scatterY) ? normalized.scatterY : undefined,
    lineMetric:
      normalized.lineMetric && metricMatchesColumns(normalized.lineMetric, columnNames)
        ? normalized.lineMetric
        : undefined,
    benchmarkMetric:
      normalized.benchmarkMetric && metricMatchesColumns(normalized.benchmarkMetric, columnNames)
        ? normalized.benchmarkMetric
        : undefined,
    metrics: normalized.metrics.filter((metric) => metricMatchesColumns(metric, columnNames)),
    tableRowDimension: normalized.tableRowDimension && columnNames.has(normalized.tableRowDimension)
      ? normalized.tableRowDimension
      : undefined,
    tableColumnDimension: normalized.tableColumnDimension && columnNames.has(normalized.tableColumnDimension)
      ? normalized.tableColumnDimension
      : undefined,
    tablePivotMetric:
      normalized.tablePivotMetric && metricMatchesColumns(normalized.tablePivotMetric, columnNames)
        ? normalized.tablePivotMetric
        : undefined,
    selectedColumns: normalized.selectedColumns?.filter((column) => columnNames.has(column)),
  };

  if (next.selectedColumns && next.selectedColumns.length === 0) {
    next.selectedColumns = undefined;
  }

  return next;
}

function customChartNeedsValueColumn(chartType: ChartType): boolean {
  return chartType !== 'TABLE' && chartType !== 'SCATTER';
}

function isSourceTimeColumn(column: ColumnMetadata): boolean {
  const loweredType = String(column.type ?? '').toLowerCase();
  const loweredName = String(column.name ?? '').toLowerCase();
  return (
    ['date', 'datetime', 'timestamp', 'time'].includes(loweredType) ||
    /(date|time|_at|created|updated|day|month|year|start|end|deadline)/.test(loweredName)
  );
}

export default function ExploreDetailPage() {
  const params = useParams();
  const router = useRouter();
  const isNew = params.id === 'new';
  const chartId = isNew ? null : Number(params.id);

  const [selectedDatasetId, setSelectedDatasetId] = useState<number | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<number | null>(null);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [chartType, setChartType] = useState<ChartType>('TABLE');
  const [generatedRoleConfig, setGeneratedRoleConfig] = useState<ChartRoleConfig>({ metrics: [] });
  const [customRoleConfig, setCustomRoleConfig] = useState<ChartRoleConfig>({ metrics: [] });
  const [chartStyleConfig, setChartStyleConfig] = useState<ChartStyleConfig>({ ...DEFAULT_STYLE_CONFIG });
  // isSourceOpen removed - source selector is always visible in left panel
  const [chartNameInput, setChartNameInput] = useState('');
  const [isEditingName, setIsEditingName] = useState(isNew);
  const [chartDescInput, setChartDescInput] = useState('');
  const [isEditingDesc, setIsEditingDesc] = useState(false);
  const [isChartLoaded, setIsChartLoaded] = useState(isNew); // skip load for new charts

  // isConfigOpen removed - chart config panel is always visible in right panel
  const [isFiltersOpen, setIsFiltersOpen] = useState(true);
  const [isSchemaSnapshotOpen, setIsSchemaSnapshotOpen] = useState(false);
  // resultTab removed - new layout shows chart + table simultaneously, SQL via sqlMode toggle
  const [queryLimit, setQueryLimit] = useState(100);
  const [sqlMode, setSqlMode] = useState<QueryMode>('generated');
  const [customSqlDraft, setCustomSqlDraft] = useState('');
  const [generatedQueryState, setGeneratedQueryState] = useState<ExploreQueryState | null>(null);
  const [customQueryState, setCustomQueryState] = useState<ExploreQueryState | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [generatedLastRunSignature, setGeneratedLastRunSignature] = useState('');
  const [customLastRunSignature, setCustomLastRunSignature] = useState('');

  // Metadata state
  const [isMetaOpen, setIsMetaOpen] = useState(false);
  const [metaDomain, setMetaDomain] = useState('');
  const [metaIntent, setMetaIntent] = useState('');
  const [metaMetrics, setMetaMetrics] = useState<string[]>([]);
  const [metaDimensions, setMetaDimensions] = useState<string[]>([]);
  const [metaTags, setMetaTags] = useState<string[]>([]);
  const [metaChipInput, setMetaChipInput] = useState({ metric: '', dimension: '', tag: '' });

  // Parameters state
  const [isParamsOpen, setIsParamsOpen] = useState(false);
  const [isDescModalOpen, setIsDescModalOpen] = useState(false);
  type ParamRow = ChartParameterCreate & { _key: string };
  const [paramRows, setParamRows] = useState<ParamRow[]>([]);

  const createChart = useCreateChart();
  const updateChart = useUpdateChart();
  const upsertMetadata = useUpsertChartMetadata();
  const replaceParams = useReplaceChartParameters();
  const executeDatasetQuery = useExecuteDatasetTableQueryMutation();
  const previewChartData = usePreviewChartData();

  const { data: chart, isLoading: isChartLoading } = useChart(chartId ?? 0);
  const { data: dataset } = useDataset(selectedDatasetId);
  const resPerms = getResourcePermissions(isNew ? 'full' : chart?.user_permission);
  const skipNextSourceResetRef = useRef(false);

  // Load existing chart config into editor state on first data arrival
  useEffect(() => {
    if (isChartLoaded || isNew) return;
    if (!chart) return;

    const config = chart.config as any;
    const savedQueryMode = normalizeSavedQueryMode(config);
    const savedChartType = config?.chartType ?? chart.chart_type;
    if (chart.dataset_table_id) {
      skipNextSourceResetRef.current = true;
      setSelectedTableId(chart.dataset_table_id);
      if (config?.dataset_id) setSelectedDatasetId(config.dataset_id);
    } else if (config?.source?.kind === 'dataset_table') {
      skipNextSourceResetRef.current = true;
      setSelectedDatasetId(config.source.datasetId);
      setSelectedTableId(config.source.tableId);
    }
    const persistedFilters = Array.isArray(config?.baseFilters) && config.baseFilters.length > 0
      ? config.baseFilters
      : (config?.filters ?? []);
    setFilters(persistedFilters);
    setChartType(savedChartType);
    setChartStyleConfig(normalizeChartStyleConfig(config?.styleConfig, config?.conditional_formatting));
    const initialGeneratedRoleConfig = normalizeRoleConfig(
      savedChartType,
      (config?.generatedRoleConfig ?? (savedQueryMode === 'generated' ? config?.roleConfig : null)) as ChartRoleConfig,
    );
    const initialCustomRoleConfig = normalizeRoleConfig(
      savedChartType,
      (config?.customRoleConfig
        ?? (savedQueryMode === 'custom' ? config?.roleConfig : null)) as ChartRoleConfig,
    );
    setGeneratedRoleConfig(initialGeneratedRoleConfig);
    setCustomRoleConfig(initialCustomRoleConfig);
    setSqlMode(savedQueryMode);
    setCustomSqlDraft(typeof config?.customSql === 'string' ? config.customSql.trim() : '');
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
    isLoading: isPreviewLoading,
    error: previewError,
  } = useTablePreview(selectedDatasetId, selectedTableId, {});
  const previewErrorMessage = useMemo(
    () => getApiErrorMessage(
      previewError,
      'Could not load table preview. The backend request did not complete.'
    ),
    [previewError],
  );
  const selectedTable = dataset?.tables?.find((t: any) => t.id === selectedTableId) ?? null;
  const hasActiveTransforms = Boolean(selectedTable?.transformations?.some((step: any) => step.enabled));
  const normalizedGeneratedRoleConfig = useMemo(
    () => normalizeRoleConfig(chartType, generatedRoleConfig),
    [generatedRoleConfig, chartType],
  );
  const normalizedCustomRoleConfig = useMemo(
    () => normalizeRoleConfig(chartType, customRoleConfig),
    [customRoleConfig, chartType],
  );
  const activeRoleConfig = sqlMode === 'custom' ? customRoleConfig : generatedRoleConfig;
  const normalizedRoleConfig = sqlMode === 'custom'
    ? normalizedCustomRoleConfig
    : normalizedGeneratedRoleConfig;
  const previewColumns = previewData?.columns ?? [];
  const previewRows = previewData?.rows ?? [];
  const executeRequest = useMemo(
    () => buildExploreExecuteRequest({
      chartType,
      roleConfig: normalizedGeneratedRoleConfig,
      filters,
      limit: queryLimit,
    }),
    [chartType, normalizedGeneratedRoleConfig, filters, queryLimit],
  );
  const generatedSql = useMemo(
    () => buildExploreSqlPreview({
      table: selectedTable,
      chartType,
      roleConfig: normalizedGeneratedRoleConfig,
      filters,
      limit: queryLimit,
    }),
    [selectedTable, chartType, normalizedGeneratedRoleConfig, filters, queryLimit],
  );
  const currentQuerySignature = useMemo(
    () => buildQuerySignature({
      datasetId: selectedDatasetId,
      tableId: selectedTableId,
      limit: queryLimit,
      sqlMode,
      chartType,
      roleConfig: normalizedRoleConfig,
      filters,
      request: executeRequest,
      customSql: customSqlDraft,
    }),
    [
      selectedDatasetId,
      selectedTableId,
      queryLimit,
      sqlMode,
      chartType,
      normalizedRoleConfig,
      filters,
      executeRequest,
      customSqlDraft,
    ],
  );
  const activeQueryState = sqlMode === 'custom' ? customQueryState : generatedQueryState;
  const activeLastRunSignature = sqlMode === 'custom'
    ? customLastRunSignature
    : generatedLastRunSignature;
  const isQueryDirty = activeQueryState !== null && currentQuerySignature !== activeLastRunSignature;
  const isRunningQuery = executeDatasetQuery.isPending || previewChartData.isPending;
  const customConfigColumns = customQueryState?.columns ?? null;
  const configColumns = sqlMode === 'custom'
    ? (customConfigColumns ?? [])
    : previewColumns;
  const filterColumns = sqlMode === 'custom'
    ? (customConfigColumns ?? [])
    : previewColumns;
  const filterRows = sqlMode === 'custom'
    ? (customQueryState?.rows ?? [])
    : previewRows;
  const parameterColumns = sqlMode === 'custom'
    ? (customConfigColumns ?? [])
    : previewColumns;
  const displayedQueryState = activeQueryState;

  const tableDisplayColumns = useMemo(() => {
    if (chartType !== 'TABLE') {
      return [];
    }

    if (displayedQueryState?.chartRows?.length) {
      const tableModel = buildExploreChartModel({
        type: 'TABLE',
        data: displayedQueryState.chartRows,
        roleConfig: normalizedRoleConfig,
        preAggregated: displayedQueryState.chartPreAggregated,
      });

      return normalizeTableDisplayColumns(
        inferQueryColumns(tableModel.tableColumns, tableModel.tableData),
        normalizedRoleConfig,
      );
    }

    const previewModel = buildExploreChartModel({
      type: 'TABLE',
      data: previewRows,
      roleConfig: normalizedRoleConfig,
      preAggregated: false,
    });

    return normalizeTableDisplayColumns(
      inferQueryColumns(previewModel.tableColumns, previewModel.tableData),
      normalizedRoleConfig,
    );
  }, [chartType, displayedQueryState?.chartPreAggregated, displayedQueryState?.chartRows, normalizedRoleConfig, previewRows]);

  const mappingSummary = useMemo(() => {
    if (chartType === 'TABLE') {
      if (normalizedRoleConfig.tableMode === 'pivot') {
        return [
          normalizedRoleConfig.tableRowDimension ? { label: 'Rows', value: normalizedRoleConfig.tableRowDimension } : null,
          normalizedRoleConfig.tableColumnDimension ? { label: 'Columns', value: normalizedRoleConfig.tableColumnDimension } : null,
          normalizedRoleConfig.tablePivotMetric ? { label: 'Value', value: normalizedRoleConfig.tablePivotMetric.field } : null,
        ].filter((item): item is { label: string; value: string } => item !== null);
      }

      const selectedCount = normalizedRoleConfig.selectedColumns?.length ?? configColumns.length;
      return selectedCount > 0 ? [{ label: 'Columns', value: `${selectedCount} selected` }] : [];
    }

    if (chartType === 'SCATTER') {
      return [
        normalizedRoleConfig.scatterX ? { label: 'X', value: normalizedRoleConfig.scatterX } : null,
        normalizedRoleConfig.scatterY ? { label: 'Y', value: normalizedRoleConfig.scatterY } : null,
        normalizedRoleConfig.dimension ? { label: 'Label', value: normalizedRoleConfig.dimension } : null,
      ].filter((item): item is { label: string; value: string } => item !== null);
    }

    return [
      normalizedRoleConfig.timeField ? { label: 'Time', value: normalizedRoleConfig.timeField } : null,
      normalizedRoleConfig.dimension && chartType !== 'TIME_SERIES' ? { label: 'X', value: normalizedRoleConfig.dimension } : null,
      normalizedRoleConfig.metrics.length > 0
        ? { label: 'Y', value: normalizedRoleConfig.metrics.map((metric) => metric.field).join(', ') }
        : null,
      normalizedRoleConfig.lineMetric ? { label: 'Line', value: normalizedRoleConfig.lineMetric.field } : null,
      normalizedRoleConfig.breakdown ? { label: 'Breakdown', value: normalizedRoleConfig.breakdown } : null,
    ].filter((item): item is { label: string; value: string } => item !== null);
  }, [chartType, configColumns.length, normalizedRoleConfig]);

  const configBuilderSourceStats = useMemo(() => {
    if (!previewColumns.length) {
      return {
        timeColumns: [] as ColumnMetadata[],
        measureColumns: [] as ColumnMetadata[],
        dimensionColumns: [] as ColumnMetadata[],
      };
    }

    const timeColumns = previewColumns.filter(isSourceTimeColumn);
    const measureColumns = previewColumns.filter((column) => column.type === 'number' && !isSourceTimeColumn(column));
    const dimensionColumns = previewColumns.filter((column) => column.type !== 'number' && !isSourceTimeColumn(column));

    return {
      timeColumns,
      measureColumns,
      dimensionColumns,
    };
  }, [previewColumns]);

  const handleChartTypeChange = useCallback((nextType: ChartType) => {
    if (nextType === chartType) {
      return;
    }

    setChartType(nextType);

    if (nextType !== 'TABLE' || chartType === 'TABLE') {
      return;
    }

    setGeneratedRoleConfig((prev) => createDefaultTableRoleConfig(prev));
    setCustomRoleConfig((prev) => createDefaultTableRoleConfig(prev));
    setChartStyleConfig((prev) => createDefaultTableStyleConfig(prev));
    setGeneratedQueryState(null);
    setCustomQueryState(null);
    setGeneratedLastRunSignature('');
    setCustomLastRunSignature('');
    setQueryError(null);
  }, [chartType]);

  // Auto-select first table when dataset changes
  useEffect(() => {
    if (dataset?.tables && dataset.tables.length > 0 && !selectedTableId) {
      setSelectedTableId(dataset.tables[0].id);
    }
  }, [dataset?.tables, selectedTableId]);

  // Reset config when user manually changes the table (skip during initial chart load)
  const isInitialTableSet = useRef(false);
  useEffect(() => {
    if (!selectedTableId) return;
    if (!isInitialTableSet.current) {
      isInitialTableSet.current = true;
      return;
    }
    setFilters([]);
    setGeneratedRoleConfig({ metrics: [] });
    setCustomRoleConfig({ metrics: [] });
  }, [selectedTableId]);

  useEffect(() => {
    if (!previewColumns.length) return;
    setGeneratedRoleConfig((prev) => syncRoleConfigWithColumns(chartType, prev, previewColumns));
  }, [chartType, previewColumns]);

  useEffect(() => {
    if (!customConfigColumns?.length) return;
    setCustomRoleConfig((prev) => pruneRoleConfigToColumns(chartType, prev, customConfigColumns));
  }, [chartType, customConfigColumns]);

  useEffect(() => {
    if (skipNextSourceResetRef.current) {
      skipNextSourceResetRef.current = false;
      return;
    }
    setGeneratedQueryState(null);
    setCustomQueryState(null);
    setQueryError(null);
    setGeneratedLastRunSignature('');
    setCustomLastRunSignature('');
    setSqlMode('generated');
    setCustomSqlDraft('');
  }, [selectedDatasetId, selectedTableId]);

  const handleEditSql = () => {
    setSqlMode('custom');
    setCustomSqlDraft((current) => (current.trim() ? current : stripTrailingSqlLimit(generatedSql)));
  };

  const handleUseGeneratedQuery = () => {
    setSqlMode('generated');
  };

  const handleResetCustomSqlDraft = () => {
    setCustomSqlDraft(stripTrailingSqlLimit(generatedSql));
    setCustomQueryState(null);
    setCustomLastRunSignature('');
  };

  const handleRunQuery = async () => {
    if (!selectedDatasetId || !selectedTableId || !selectedTable) {
      toast.error('Please select a dataset table first');
      return;
    }

    setQueryError(null);

    try {
      if (sqlMode === 'custom') {
        const sql = customSqlDraft.trim();
        if (!sql) {
          toast.error('Custom SQL cannot be empty');
          return;
        }
        const buildCustomPreviewConfig = (roleConfig: ChartRoleConfig) => ({
          chartType,
          queryMode: 'custom' as const,
          customSql: sql,
          roleConfig,
          customRoleConfig: roleConfig,
          filters,
          baseFilters: filters,
        });

        const sourceSampleResponse = await previewChartData.mutateAsync({
          dataset_table_id: selectedTableId,
          chart_type: chartType,
          config: buildCustomPreviewConfig({ metrics: [] }),
          include_source_sample: true,
          source_sample_limit: queryLimit,
        });

        const sourceRows = sourceSampleResponse.source_rows ?? [];
        const sourceColumnNames = sourceSampleResponse.source_columns?.length
          ? sourceSampleResponse.source_columns
          : Object.keys(sourceRows[0] ?? {});
        const sourceColumns = inferQueryColumns(sourceColumnNames, sourceRows);
        const nextCustomRoleConfig = sourceColumns.length > 0
          ? pruneRoleConfigToColumns(chartType, normalizedCustomRoleConfig, sourceColumns)
          : normalizedCustomRoleConfig;
        const nextCustomSignature = buildQuerySignature({
          datasetId: selectedDatasetId,
          tableId: selectedTableId,
          limit: queryLimit,
          sqlMode: 'custom',
          chartType,
          roleConfig: nextCustomRoleConfig,
          filters,
          request: executeRequest,
          customSql: sql,
        });
        const roleConfigChanged = JSON.stringify(nextCustomRoleConfig) !== JSON.stringify(normalizedCustomRoleConfig);

        if (roleConfigChanged) {
          setCustomRoleConfig(nextCustomRoleConfig);
        }

        if (customChartNeedsValueColumn(chartType) && nextCustomRoleConfig.metrics.length === 0) {
          setCustomQueryState({
            source: 'custom',
            sql,
            columns: sourceColumns,
            rows: sourceRows,
            chartRows: [],
            chartColumns: [],
            chartPreAggregated: false,
            executionTimeMs: sourceSampleResponse.execution_time_ms,
          });
          setCustomLastRunSignature('');
          toast.info('SQL ran successfully. Choose a value column from the SQL output to preview the chart.');
          return;
        }

        const previewResponse = await previewChartData.mutateAsync({
          dataset_table_id: selectedTableId,
          chart_type: chartType,
          config: buildCustomPreviewConfig(nextCustomRoleConfig),
          include_source_sample: false,
        });

        const chartRows = previewResponse.data ?? [];
        const chartColumns = inferQueryColumns(Object.keys(chartRows[0] ?? {}), chartRows);
        setCustomQueryState({
          source: 'custom',
          sql,
          columns: sourceColumns,
          rows: sourceRows,
          chartRows,
          chartColumns,
          chartPreAggregated: Boolean(previewResponse.pre_aggregated),
          executionTimeMs: previewResponse.execution_time_ms,
        });
        setCustomLastRunSignature(nextCustomSignature);
      } else {
        const response = await executeDatasetQuery.mutateAsync({
          datasetId: selectedDatasetId,
          tableId: selectedTableId,
          request: executeRequest,
        });
        const columns = normalizeExecuteResponseColumns(response);
        const chartResult = buildExploreChartResult({
          rows: response.rows,
          columns,
          chartType,
          roleConfig: normalizedGeneratedRoleConfig,
          source: 'generated',
        });

        setGeneratedQueryState({
          source: 'generated',
          sql: generatedSql,
          columns,
          rows: response.rows,
          chartRows: chartResult.rows,
          chartColumns: chartResult.columns,
          chartPreAggregated: chartResult.preAggregated,
        });
        setGeneratedLastRunSignature(currentQuerySignature);
      }
    } catch (runError: any) {
      const detail = runError?.response?.data?.detail;
      const message = typeof detail === 'string'
        ? detail
        : detail?.message || runError?.message || 'Failed to run query';
      setQueryError(String(message));
      toast.error(String(message));
    }
  };

  const didAutoRunRef = useRef(false);
  useEffect(() => {
    if (isNew || didAutoRunRef.current || !isChartLoaded || !selectedDatasetId || !selectedTableId) {
      return;
    }
    didAutoRunRef.current = true;
    void handleRunQuery();
  }, [isNew, isChartLoaded, selectedDatasetId, selectedTableId, currentQuerySignature]);

  const handleSaveLook = async () => {
    if (!selectedTableId) {
      toast.error('Please select a dataset table first');
      return;
    }
    const trimmedCustomSql = customSqlDraft.trim();
    if (sqlMode === 'custom') {
      if (!trimmedCustomSql) {
        toast.error('Custom SQL cannot be empty');
        return;
      }
      if (!customQueryState || currentQuerySignature !== customLastRunSignature) {
        toast.error('Run the custom SQL before saving so the chart uses the latest output columns');
        return;
      }
    }

    const activeSavedRoleConfig = sqlMode === 'custom' ? customRoleConfig : generatedRoleConfig;
    const tableConditionalFormatting = chartStyleConfig.tableConditionalFormatting;
    const exploreConfig = {
      dataset_id: selectedDatasetId,
      filters,
      baseFilters: filters,
      chartType,
      queryMode: sqlMode,
      roleConfig: activeSavedRoleConfig,
      generatedRoleConfig,
      customRoleConfig,
      ...(trimmedCustomSql ? { customSql: trimmedCustomSql } : {}),
      styleConfig: chartStyleConfig,
      ...(chartType === 'TABLE' && tableConditionalFormatting?.length
        ? { conditional_formatting: tableConditionalFormatting }
        : {}),
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
            dataset_table_id: selectedTableId,
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
          dataset_table_id: selectedTableId,
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

  // Metadata helpers
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

  // Parameter helpers
  const addParamRow = () =>
    setParamRows((p) => [...p, { _key: String(Date.now()), parameter_name: '', parameter_type: 'dimension', column_mapping: null, default_value: null, description: null }]);
  const updateParamRow = (key: string, field: string, value: any) =>
    setParamRows((p) => p.map((r) => (r._key === key ? { ...r, [field]: value } : r)));
  const removeParamRow = (key: string) => setParamRows((p) => p.filter((r) => r._key !== key));

  useEffect(() => {
    if (!parameterColumns.length) return;
    setParamRows((rows) => rows.map((row) => {
      const column = row.column_mapping?.column;
      if (!column) return row;
      const columnMeta = parameterColumns.find((item) => item.name === column);
      if (!columnMeta) return row;
      if (row.column_mapping?.type === columnMeta.type) return row;
      return {
        ...row,
        column_mapping: { column, type: columnMeta.type },
      };
    }));
  }, [parameterColumns]);

  const isConfigBuilderMode = sqlMode === 'generated';
  const needsCustomMetricSelection = sqlMode === 'custom'
    && Boolean(customQueryState)
    && customChartNeedsValueColumn(chartType)
    && normalizedCustomRoleConfig.metrics.length === 0;
  const modeDescription = isConfigBuilderMode
    ? 'Choose a source table, map fields directly from the left panel, and keep chart setup visible on the same screen.'
    : 'Write SQL once on the left, run it, then continue configuring the chart from the output columns without leaving this screen.';

  // Show loading skeleton while fetching existing chart
  if (!isNew && isChartLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="inline-block w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-3" />
          <p className="text-sm text-gray-600">Loading chart...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-slate-100">
      {!isNew && !resPerms.canEdit && resPerms.canView && (
        <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-amber-700">
            <Eye className="h-3.5 w-3.5 shrink-0" />
            <span className="font-medium">View only</span>
            <span className="text-amber-600">— You can preview this chart but cannot modify its configuration.</span>
          </div>
        </div>
      )}
      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => router.push('/explore')}
              className="flex shrink-0 items-center gap-1 text-xs text-slate-400 hover:text-slate-700"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              All Charts
            </button>
            <span className="text-slate-200">/</span>
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
                    if (e.key === 'Escape') { setChartNameInput(chart?.name ?? ''); setIsEditingName(false); }
                  }}
                  placeholder="Chart name..."
                  className="min-w-[10rem] border-b border-blue-400 bg-transparent px-0.5 text-sm font-semibold text-slate-900 outline-none"
                />
                <Check className="h-3.5 w-3.5 text-blue-500" />
              </div>
            ) : (
              <div className="flex items-center gap-1.5 group/name">
                <span className="max-w-xs truncate text-sm font-semibold text-slate-900">
                  {chartNameInput || (chartId ? 'Chart' : 'New Chart')}
                </span>
                {resPerms.canEdit && (
                  <button
                    type="button"
                    onClick={() => setIsEditingName(true)}
                    className="rounded-md p-1 text-slate-400 opacity-0 transition-opacity hover:bg-slate-100 hover:text-slate-600 group-hover/name:opacity-100"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
              </div>
            )}
            {selectedTable && (
              <span className="shrink-0 truncate text-xs text-slate-400">
                - {dataset?.name} / {(selectedTable as any).display_name || 'Table'}
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2 pr-2">
            {isEditingDesc ? (
              <input
                autoFocus
                type="text"
                value={chartDescInput}
                onChange={(e) => setChartDescInput(e.target.value)}
                onBlur={() => {
                  setIsEditingDesc(false);
                  if (chartId) updateChart.mutate({ id: chartId, data: { description: chartDescInput.trim() || null } });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') { setChartDescInput(chart?.description ?? ''); setIsEditingDesc(false); }
                }}
                placeholder="Add note..."
                className="w-52 border-b border-blue-400 bg-transparent px-0.5 text-xs text-slate-600 outline-none"
              />
            ) : resPerms.canEdit ? (
              <div
                onClick={() => setIsEditingDesc(true)}
                className="group/desc mr-1 flex cursor-text items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                {chartDescInput || <span className="italic">Add note...</span>}
                <Pencil className="h-3 w-3 opacity-0 transition-opacity group-hover/desc:opacity-100" />
              </div>
            ) : chartDescInput ? (
              <span className="text-xs text-slate-400">{chartDescInput}</span>
            ) : null}
            {!isNew && chartId && (
              <button
                onClick={() => setIsDescModalOpen(true)}
                className="rounded p-1.5 text-slate-400 transition-colors hover:bg-blue-50 hover:text-blue-600"
                title="AI Description"
              >
                <Bot className="h-4 w-4" />
              </button>
            )}
            {resPerms.canEdit && (
              <button
                onClick={handleSaveLook}
                disabled={!selectedTableId}
                className="flex items-center gap-1.5 rounded-md border border-blue-600 bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Save className="h-3.5 w-3.5" />
                {chartId ? 'Update' : 'Save Chart'}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-start gap-4">
            <div className="shrink-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">Mode</p>
              <div className="mt-1 inline-flex rounded-2xl border border-slate-200 bg-slate-100 p-1">
                <button
                  onClick={handleUseGeneratedQuery}
                  disabled={!resPerms.canEdit}
                  className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    isConfigBuilderMode
                      ? 'bg-white text-blue-700 shadow-sm'
                      : 'text-slate-600 hover:bg-white/70'
                  }`}
                >
                  <Database className="h-3.5 w-3.5" />
                  Config Builder
                </button>
                <button
                  onClick={handleEditSql}
                  disabled={!resPerms.canEdit}
                  className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    !isConfigBuilderMode
                      ? 'bg-white text-amber-700 shadow-sm'
                      : 'text-slate-600 hover:bg-white/70'
                  }`}
                >
                  <Code2 className="h-3.5 w-3.5" />
                  Custom SQL
                </button>
              </div>
            </div>

            <div className="min-w-0 pt-0.5">
              <p className="text-sm font-medium text-slate-700">
                {isConfigBuilderMode ? 'Build from a table' : 'Shape the source with SQL'}
              </p>
              <p className="text-xs text-slate-500">{modeDescription}</p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {isQueryDirty && (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
                Run again to refresh preview
              </span>
            )}
            {activeQueryState && (
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-500">
                {activeQueryState.rows.length} row{activeQueryState.rows.length === 1 ? '' : 's'}
                {activeQueryState.executionTimeMs != null ? ` in ${activeQueryState.executionTimeMs}ms` : ''}
              </span>
            )}
            <label className="flex items-center gap-1 text-xs text-slate-500">
              Limit
              <select
                value={queryLimit}
                onChange={(e) => setQueryLimit(Number(e.target.value))}
                disabled={!resPerms.canEdit}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {[50, 100, 250, 500, 1000].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <button
              onClick={() => void handleRunQuery()}
              disabled={isRunningQuery || (isConfigBuilderMode && isPreviewLoading)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {isRunningQuery
                ? <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                : <Play className="h-3.5 w-3.5" />}
              {isRunningQuery ? 'Running...' : 'Run'}
            </button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex h-full min-w-[1320px] gap-4 p-4">
          <div className={`flex shrink-0 flex-col overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm ${
            isConfigBuilderMode ? 'w-72' : 'w-[25rem]'
          }`}>
            <div className="border-b border-slate-200 px-4 py-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                {isConfigBuilderMode ? 'Source' : 'SQL / Output'}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {isConfigBuilderMode
                  ? 'Choose the dataset and table here. Open schema only when you need to confirm field types before mapping on the right.'
                  : 'The SQL result becomes the chart source after each run.'}
              </p>
              <div className="mt-3">
                <ExploreSourceSelector
                  selectedDatasetId={selectedDatasetId}
                  selectedTableId={selectedTableId}
                  onDatasetChange={setSelectedDatasetId}
                  onTableChange={setSelectedTableId}
                  disabled={!resPerms.canEdit}
                />
              </div>

            </div>

            {isConfigBuilderMode ? (
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {!selectedTableId ? (
                  <div className="flex h-full items-center justify-center px-2 text-center">
                    <div>
                      <Search className="mx-auto mb-3 h-10 w-10 text-slate-300" />
                      <p className="text-sm font-medium text-slate-700">Choose a table to load its schema</p>
                      <p className="mt-1 text-xs text-slate-400">Chart Setup on the right will use this source as the only field universe.</p>
                    </div>
                  </div>
                ) : isPreviewLoading ? (
                  <div className="flex h-full items-center justify-center">
                    <div className="text-center">
                      <div className="mx-auto mb-3 inline-block h-7 w-7 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
                      <p className="text-sm text-slate-500">Loading source schema...</p>
                    </div>
                  </div>
                ) : previewError ? (
                  <div className="flex h-full items-center justify-center px-6">
                    <div className="max-w-xs text-center">
                      <p className="text-sm font-medium text-red-600">Could not load source schema</p>
                      <p className="mt-1 text-xs text-red-500/90">{previewErrorMessage}</p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-slate-800">
                            {(selectedTable as any)?.display_name || 'Selected table'}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {dataset?.name ? `${dataset.name} dataset` : 'Source table'}
                          </p>
                        </div>
                        {hasActiveTransforms && (
                          <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                            transforms on
                          </span>
                        )}
                      </div>

                      <div className="mt-4 grid grid-cols-2 gap-2">
                        <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                          <p className="text-[11px] uppercase tracking-wide text-slate-400">Columns</p>
                          <p className="mt-1 text-sm font-semibold text-slate-800">{previewColumns.length}</p>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                          <p className="text-[11px] uppercase tracking-wide text-slate-400">Measures</p>
                          <p className="mt-1 text-sm font-semibold text-slate-800">{configBuilderSourceStats.measureColumns.length}</p>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                          <p className="text-[11px] uppercase tracking-wide text-slate-400">Dimensions</p>
                          <p className="mt-1 text-sm font-semibold text-slate-800">{configBuilderSourceStats.dimensionColumns.length}</p>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                          <p className="text-[11px] uppercase tracking-wide text-slate-400">Time Fields</p>
                          <p className="mt-1 text-sm font-semibold text-slate-800">{configBuilderSourceStats.timeColumns.length}</p>
                        </div>
                      </div>
                    </div>

                    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                      <button
                        type="button"
                        onClick={() => setIsSchemaSnapshotOpen((open) => !open)}
                        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50"
                      >
                        <div>
                          <p className="text-sm font-medium text-slate-800">Schema Snapshot</p>
                          <p className="mt-1 text-xs text-slate-500">
                            Open only when you want to confirm column types before binding fields in Chart Setup.
                          </p>
                        </div>
                        {isSchemaSnapshotOpen
                          ? <ChevronDown className="h-4 w-4 text-slate-400" />
                          : <ChevronRight className="h-4 w-4 text-slate-400" />}
                      </button>

                      {isSchemaSnapshotOpen && (
                        <>
                          <div className="max-h-72 overflow-y-auto border-t border-slate-100">
                            {previewColumns.slice(0, 14).map((column) => {
                              const kind = isSourceTimeColumn(column)
                                ? 'time'
                                : column.type === 'number'
                                  ? 'measure'
                                  : 'dimension';
                              return (
                                <div
                                  key={column.name}
                                  className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0"
                                >
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-medium text-slate-700">{column.name}</p>
                                    <p className="text-xs text-slate-400">{column.type}</p>
                                  </div>
                                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                                    kind === 'time'
                                      ? 'bg-emerald-50 text-emerald-700'
                                      : kind === 'measure'
                                        ? 'bg-blue-50 text-blue-700'
                                        : 'bg-slate-100 text-slate-600'
                                  }`}>
                                    {kind}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                          {previewColumns.length > 14 && (
                            <div className="border-t border-slate-100 bg-slate-50 px-4 py-2 text-xs text-slate-500">
                              + {previewColumns.length - 14} more columns available in this source
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-slate-700">Custom SQL</p>
                    <p className="text-xs text-slate-400">Run SQL to refresh the output columns used by Chart Setup.</p>
                  </div>
                  {resPerms.canEdit && (
                    <button
                      onClick={handleResetCustomSqlDraft}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
                    >
                      <RotateCcw className="h-3 w-3" />
                      Reset
                    </button>
                  )}
                </div>

                <div className="border-b border-slate-200 p-4">
                  <textarea
                    value={customSqlDraft}
                    onChange={(e) => setCustomSqlDraft(e.target.value)}
                    readOnly={!resPerms.canEdit}
                    spellCheck={false}
                    className={`h-64 w-full resize-none rounded-2xl border border-slate-200 bg-slate-950 px-3 py-3 font-mono text-xs text-slate-100 outline-none transition focus:border-amber-300 focus:ring-2 focus:ring-amber-100${!resPerms.canEdit ? ' opacity-60 cursor-not-allowed' : ''}`}
                  />
                </div>

                <div className="min-h-0 flex-1 overflow-hidden">
                  <div className="border-b border-slate-200 px-4 py-3">
                    <p className="text-sm font-medium text-slate-700">Output Columns</p>
                    <p className="text-xs text-slate-400">These are the columns Chart Setup can bind to after the latest run.</p>
                  </div>
                  <div className="min-h-0 space-y-2 overflow-y-auto px-4 py-4">
                    {customQueryState?.columns?.length ? (
                      customQueryState.columns.map((column) => (
                        <div
                          key={column.name}
                          className="flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-slate-700">{column.name}</p>
                            <p className="text-xs text-slate-400">{column.type}</p>
                          </div>
                          <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                            SQL
                          </span>
                        </div>
                      ))
                    ) : (
                      <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center">
                        <Code2 className="mx-auto mb-3 h-8 w-8 text-amber-300" />
                        <p className="text-sm font-medium text-slate-700">Run SQL to load output columns</p>
                        <p className="mt-1 text-xs text-slate-400">After that, the right-side Chart Setup will work directly on the SQL result set.</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-4">

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-5 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Chart Preview</p>
                  <h2 className="mt-1 truncate text-lg font-semibold text-slate-900">
                    {chartNameInput || 'Untitled chart'}
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    {isConfigBuilderMode
                      ? 'Build from the selected table, run once, then fine-tune the chart without changing screens.'
                      : 'The preview uses the latest SQL output together with the chart mapping and style settings on the right.'}
                  </p>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                    isConfigBuilderMode ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'
                  }`}>
                    {isConfigBuilderMode ? 'Config Builder' : 'Custom SQL'}
                  </span>
                </div>
              </div>
            </div>

            {queryError && (
              <div className="border-b border-red-100 bg-red-50 px-5 py-2 text-xs text-red-600">
                {queryError}
              </div>
            )}

            <div className="min-h-0 flex-1 p-5">
              {!selectedTableId ? (
                <div className="flex h-full items-center justify-center">
                  <div className="max-w-sm text-center">
                    <Search className="mx-auto mb-3 h-12 w-12 text-slate-300" />
                    <p className="text-sm font-medium text-slate-700">Choose a dataset table to start</p>
                    <p className="mt-1 text-xs text-slate-400">The source selector on the left defines what this chart can use.</p>
                  </div>
                </div>
              ) : !displayedQueryState ? (
                <div className="flex h-full items-center justify-center">
                  <div className="max-w-sm text-center">
                    {isConfigBuilderMode
                      ? <Database className="mx-auto mb-3 h-10 w-10 text-slate-300" />
                      : <Code2 className="mx-auto mb-3 h-10 w-10 text-amber-300" />}
                    <p className="text-sm font-medium text-slate-700">Run the query to preview the chart</p>
                    <p className="mt-1 text-xs text-slate-400">
                      {isConfigBuilderMode
                        ? 'Choose fields in Chart Setup, then run once to populate the preview.'
                        : 'Run the SQL on the left so the chart can bind to the returned columns.'}
                    </p>
                  </div>
                </div>
              ) : needsCustomMetricSelection ? (
                <div className="flex h-full items-center justify-center">
                  <div className="max-w-sm text-center">
                    <Settings2 className="mx-auto mb-3 h-10 w-10 text-amber-300" />
                    <p className="text-sm font-medium text-slate-700">Choose a value column in Chart Setup</p>
                    <p className="mt-1 text-xs text-slate-400">Your SQL ran successfully. Pick the metric to draw from the SQL output columns on the right.</p>
                  </div>
                </div>
              ) : (
                <ExploreChart
                  type={chartType}
                  data={displayedQueryState.chartRows}
                  roleConfig={normalizedRoleConfig}
                  styleConfig={chartStyleConfig}
                  preAggregated={displayedQueryState.chartPreAggregated}
                />
              )}
            </div>
          </div>

            <div className="flex h-[22rem] shrink-0 flex-col overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 px-5 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                      {isConfigBuilderMode ? 'SQL + Data Preview' : 'SQL Output Sample'}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {isConfigBuilderMode
                        ? 'Keep the generated SQL and result rows in view while you tweak the chart.'
                        : 'These sample rows come from the latest SQL run and feed the chart setup on the right.'}
                    </p>
                  </div>
                  {displayedQueryState && (
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-500">
                      {displayedQueryState.rows.length} row{displayedQueryState.rows.length === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
              </div>

              {isConfigBuilderMode && (
                <div className="border-b border-slate-200 bg-slate-50 px-5 py-3">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-600">
                      SQL Preview{hasActiveTransforms && ' (transforms applied server-side)'}
                    </span>
                  </div>
                  <pre className="max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-slate-600">
                    {generatedSql}
                  </pre>
                </div>
              )}

              {displayedQueryState ? (
                <>
                  {!isConfigBuilderMode && (
                    <div className="border-b border-amber-100 bg-amber-50 px-5 py-2 text-[10px] text-amber-700">
                      The rows below are sampled from the SQL output. The chart preview above uses these output columns together with your chart mapping and filters.
                    </div>
                  )}
                  <div className="min-h-0 flex-1 overflow-hidden">
                    <DatasetTableGrid columns={displayedQueryState.columns} rows={displayedQueryState.rows} />
                  </div>
                </>
              ) : (
                <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center">
                  <div className="max-w-sm">
                    {isConfigBuilderMode
                      ? <Database className="mx-auto mb-3 h-8 w-8 text-slate-300" />
                      : <Code2 className="mx-auto mb-3 h-8 w-8 text-amber-300" />}
                    <p className="text-sm font-medium text-slate-700">
                      {isConfigBuilderMode ? 'Run to inspect result rows' : 'Run SQL to inspect sampled rows'}
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      {isConfigBuilderMode
                        ? 'The generated SQL stays visible here so you can compare structure and output without leaving the editor.'
                        : 'After a successful run, this panel will show the SQL output columns and sample data on the same screen.'}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

        {/* RIGHT PANEL: Chart Config + Metadata + Parameters */}
        {selectedTableId && (
          <div className="flex w-[25rem] shrink-0 flex-col overflow-y-auto rounded-[24px] border border-slate-200 bg-white shadow-sm">
            <div className={`border-b border-slate-200 px-5 py-4 ${
              sqlMode === 'custom' ? 'bg-amber-50/70' : 'bg-slate-50'
            }`}>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Chart Setup
              </p>
              <p className={`mt-2 text-sm font-medium ${
                sqlMode === 'custom' ? 'text-amber-800' : 'text-slate-700'
              }`}>
                {sqlMode === 'custom' ? 'Map directly from SQL output columns' : 'Keep mapping and styling in one place'}
              </p>
              <p className={`mt-1 text-xs ${
                sqlMode === 'custom' ? 'text-amber-700' : 'text-slate-500'
              }`}>
                {sqlMode === 'custom'
                  ? 'Everything below works against the latest SQL result set. Run SQL again whenever you change aliases, joins, or selected columns.'
                  : 'Build the chart entirely from the steps below. Use the left panel only to switch tables or inspect schema.'}
              </p>
              {sqlMode === 'generated' && (
                <p className="mt-2 text-[11px] text-slate-500">
                  Switch to Custom SQL when you need calculated fields, CTEs, or a pre-shaped table before visualization.
                </p>
              )}
              {sqlMode === 'custom' && (
                <p className="mt-2 text-[11px] text-amber-700">
                  Save uses the latest SQL you ran together with the chart options below.
                </p>
              )}
              {mappingSummary.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {mappingSummary.map((item) => (
                    <span
                      key={`setup-${item.label}-${item.value}`}
                      className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-600"
                    >
                      <span className="font-semibold text-slate-700">{item.label}:</span> {item.value}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Chart type + field mapping + styling */}
            <ExploreChartConfig
              chartType={chartType}
              roleConfig={activeRoleConfig}
              styleConfig={chartStyleConfig}
              availableColumns={configColumns}
              tableDisplayColumns={tableDisplayColumns}
              queryMode={sqlMode}
              readOnly={!resPerms.canEdit}
              onChartTypeChange={handleChartTypeChange}
              onRoleConfigChange={sqlMode === 'custom' ? setCustomRoleConfig : setGeneratedRoleConfig}
              onStyleConfigChange={setChartStyleConfig}
            />

            <div className="border-t">
              <button
                onClick={() => setIsFiltersOpen((open) => !open)}
                className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Settings2 className="w-3.5 h-3.5 text-gray-400" />
                  <span className="text-xs font-semibold text-gray-700">Chart Filters</span>
                  {filters.length > 0 && (
                    <span className="px-1.5 py-0.5 text-[10px] bg-orange-100 text-orange-700 rounded-full font-medium">
                      {filters.length}
                    </span>
                  )}
                </div>
                {isFiltersOpen
                  ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
                  : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
              </button>
              {isFiltersOpen && (
                <div className="px-4 pb-4">
                  <p className="mb-2 text-[11px] text-gray-500">
                    Saved with this chart and still applied after you add the chart to a dashboard.
                  </p>
                  <p className="mb-3 text-[10px] text-gray-400">
                    {sqlMode === 'custom'
                      ? 'These filters run against the columns returned by the custom SQL output.'
                      : 'These filters run before dashboard-level filters.'}
                  </p>
                  {sqlMode === 'custom' && filterColumns.length === 0 ? (
                    <p className="text-xs text-gray-400">
                      Run the custom SQL once to load output columns for chart filters.
                    </p>
                  ) : (
                    <FilterBuilder
                      filters={filters}
                      onChange={setFilters}
                      columns={filterColumns}
                      dataRows={filterRows}
                      readOnly={!resPerms.canEdit}
                    />
                  )}
                </div>
              )}
            </div>

            {/* Metadata */}
            <div className="border-t">
              <button
                onClick={() => setIsMetaOpen((o) => !o)}
                className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Tag className="w-3.5 h-3.5 text-gray-400" />
                  <span className="text-xs font-semibold text-gray-700">Metadata</span>
                  {(metaDomain || metaIntent || metaMetrics.length > 0 || metaTags.length > 0) && (
                    <span className="w-2 h-2 rounded-full bg-blue-500" />
                  )}
                </div>
                {isMetaOpen
                  ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
                  : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
              </button>
              {isMetaOpen && (
                <div className={`px-4 pb-4 space-y-3${!resPerms.canEdit ? ' pointer-events-none opacity-60' : ''}`}>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Domain</label>
                      <select value={metaDomain} onChange={(e) => setMetaDomain(e.target.value)}
                        className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs bg-white">
                        <option value="">None</option>
                        {DOMAIN_OPTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Intent</label>
                      <select value={metaIntent} onChange={(e) => setMetaIntent(e.target.value)}
                        className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs bg-white">
                        <option value="">None</option>
                        {INTENT_OPTIONS.map((i) => <option key={i} value={i}>{i}</option>)}
                      </select>
                    </div>
                  </div>

                  {/* Metrics chips */}
                  {(() => {
                    const chips = metaMetrics;
                    const suggested = activeRoleConfig.metrics.map((m) => m.field).filter((f) => !chips.includes(f));
                    return (
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Metrics</label>
                        {suggested.length > 0 && (
                          <div className="flex flex-wrap gap-1 mb-1.5">
                            <span className="text-[10px] text-gray-400 self-center">Suggest:</span>
                            {suggested.map((s) => (
                              <button key={s} type="button" onClick={() => setMetaMetrics((p) => [...p, s])}
                                className="px-1.5 py-0.5 text-[10px] border border-dashed border-blue-300 text-blue-500 rounded-full hover:bg-blue-50">
                                +{s}
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="flex flex-wrap gap-1 mb-1">
                          {chips.map((v) => (
                            <span key={v} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded-full bg-blue-100 text-blue-700">
                              {v}
                              <button type="button" onClick={() => removeChip('metric', v)} className="hover:opacity-70 ml-0.5">x</button>
                            </span>
                          ))}
                        </div>
                        <div className="flex gap-1">
                          <input value={metaChipInput.metric}
                            onChange={(e) => setMetaChipInput((p) => ({ ...p, metric: e.target.value }))}
                            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addChip('metric'))}
                            placeholder="Business name, Enter to add"
                            className="flex-1 px-2 py-1 border border-gray-200 rounded text-xs" />
                          <button type="button" onClick={() => addChip('metric')}
                            className="px-2 py-1 bg-gray-100 border border-gray-200 rounded text-xs hover:bg-gray-200">+</button>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Dimensions chips */}
                  {(() => {
                    const chips = metaDimensions;
                    const suggested = (activeRoleConfig.dimension ? [activeRoleConfig.dimension] : []).filter((f) => !chips.includes(f));
                    return (
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">Dimensions</label>
                        {suggested.length > 0 && (
                          <div className="flex flex-wrap gap-1 mb-1.5">
                            <span className="text-[10px] text-gray-400 self-center">Suggest:</span>
                            {suggested.map((s) => (
                              <button key={s} type="button" onClick={() => setMetaDimensions((p) => [...p, s])}
                                className="px-1.5 py-0.5 text-[10px] border border-dashed border-green-300 text-green-600 rounded-full hover:bg-green-50">
                                +{s}
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="flex flex-wrap gap-1 mb-1">
                          {chips.map((v) => (
                            <span key={v} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded-full bg-green-100 text-green-700">
                              {v}
                              <button type="button" onClick={() => removeChip('dimension', v)} className="hover:opacity-70 ml-0.5">x</button>
                            </span>
                          ))}
                        </div>
                        <div className="flex gap-1">
                          <input value={metaChipInput.dimension}
                            onChange={(e) => setMetaChipInput((p) => ({ ...p, dimension: e.target.value }))}
                            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addChip('dimension'))}
                            placeholder="Business name, Enter to add"
                            className="flex-1 px-2 py-1 border border-gray-200 rounded text-xs" />
                          <button type="button" onClick={() => addChip('dimension')}
                            className="px-2 py-1 bg-gray-100 border border-gray-200 rounded text-xs hover:bg-gray-200">+</button>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Tags */}
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Tags</label>
                    <div className="flex flex-wrap gap-1 mb-1">
                      {metaTags.map((v) => (
                        <span key={v} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded-full bg-gray-100 text-gray-600">
                          {v}
                          <button type="button" onClick={() => removeChip('tag', v)} className="hover:opacity-70 ml-0.5">x</button>
                        </span>
                      ))}
                    </div>
                    <div className="flex gap-1">
                      <input value={metaChipInput.tag}
                        onChange={(e) => setMetaChipInput((p) => ({ ...p, tag: e.target.value }))}
                        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addChip('tag'))}
                        placeholder="Tag, Enter to add"
                        className="flex-1 px-2 py-1 border border-gray-200 rounded text-xs" />
                      <button type="button" onClick={() => addChip('tag')}
                        className="px-2 py-1 bg-gray-100 border border-gray-200 rounded text-xs hover:bg-gray-200">+</button>
                    </div>
                  </div>
                  {!isNew && <p className="text-[10px] text-gray-400 italic">Saved on "Update"</p>}
                </div>
              )}
            </div>

            {/* Parameters */}
            <div className="border-t">
              <button
                onClick={() => setIsParamsOpen((o) => !o)}
                className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Settings2 className="w-3.5 h-3.5 text-gray-400" />
                  <span className="text-xs font-semibold text-gray-700">Parameters</span>
                  {paramRows.length > 0 && (
                    <span className="px-1.5 py-0.5 text-[10px] bg-purple-100 text-purple-700 rounded-full font-medium">
                      {paramRows.length}
                    </span>
                  )}
                </div>
                {isParamsOpen
                  ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
                  : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
              </button>
              {isParamsOpen && (
                <div className={`px-4 pb-4 space-y-2${!resPerms.canEdit ? ' pointer-events-none opacity-60' : ''}`}>
                  <p className="text-[10px] text-gray-400">
                    {sqlMode === 'custom'
                      ? 'Filters this chart accepts from a dashboard, based on the SQL output columns.'
                      : 'Filters this chart accepts from a dashboard.'}
                  </p>
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
                          <button type="button" onClick={() => removeParamRow(row._key)}
                            className="text-gray-400 hover:text-red-500 p-0.5">
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                      <select
                        value={row.parameter_type}
                        onChange={(e) => updateParamRow(row._key, 'parameter_type', e.target.value)}
                        className="w-full px-2 py-1 border border-gray-200 rounded text-xs bg-white"
                      >
                        {PARAM_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      <select
                        value={row.column_mapping?.column ?? ''}
                        onChange={(e) => {
                          const column = e.target.value;
                          const columnMeta = parameterColumns.find((c) => c.name === column);
                          updateParamRow(row._key, 'column_mapping',
                            column ? { column, type: columnMeta?.type ?? 'string' } : null);
                        }}
                        className="w-full px-2 py-1 border border-gray-200 rounded text-xs bg-white"
                      >
                        <option value="">Column mapping (optional)</option>
                        {parameterColumns.map((col) => (
                          <option key={col.name} value={col.name}>{col.name} ({col.type})</option>
                        ))}
                      </select>
                      <input
                        value={row.default_value ?? ''}
                        onChange={(e) => updateParamRow(row._key, 'default_value', e.target.value || null)}
                        placeholder="Default value (optional)"
                        className="w-full px-2 py-1 border border-gray-200 rounded text-xs"
                      />
                    </div>
                  ))}
                  {resPerms.canEdit && (
                    <button type="button" onClick={addParamRow}
                      className="flex items-center gap-1 text-xs text-purple-600 hover:text-purple-700 font-medium">
                      <Plus className="w-3 h-3" /> Add Parameter
                    </button>
                  )}
                  {!isNew && <p className="text-[10px] text-gray-400 italic">Saved on "Update"</p>}
                </div>
              )}
            </div>

          </div>
        )}
      </div>
      </div>

      {/* AI Description Modal */}
      {isDescModalOpen && chartId && (
        <AppModalShell
          onClose={() => setIsDescModalOpen(false)}
          title="AI Description"
          description="Separate from the manual note shown under the chart title."
          icon={<Bot className="h-5 w-5" />}
          maxWidthClass="max-w-3xl"
          panelClassName="max-h-[85vh]"
          bodyClassName="p-6"
        >
          <ChartDescriptionPanel chartId={chartId} canEdit={resPerms.canEdit} />
        </AppModalShell>
      )}
    </div>
  );
}
