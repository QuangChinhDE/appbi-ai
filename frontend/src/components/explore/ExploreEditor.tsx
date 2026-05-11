/**
 * Explore editor - reusable chart builder used by Explore and dashboard flows.
 */
'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Save, ArrowLeft, ChevronDown, ChevronRight, Pencil, Check, Search, Settings2, Play, RotateCcw, Database, Code2, Eye } from 'lucide-react';
import { HelpTooltip } from '@/components/ui/HelpTooltip';
import { useDataset, useTablePreview, useExecuteDatasetTableQueryMutation, type ColumnMetadata } from '@/hooks/use-datasets';
import { ExploreSourceSelector } from '@/components/explore/ExploreSourceSelector';
import { ExploreColumnPanel } from '@/components/explore/ExploreColumnPanel';
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
  getChartRoleConfigRequirementMessage,
  getChartRoleConfigValidationMessage,
  normalizeChartStyleConfig,
  normalizeRoleConfig,
} from '@/components/explore/ExploreChartConfig';
import { toast } from '@/lib/toast';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { ChartDescriptionDrawer, ChartDescriptionTrigger } from '@/components/explore/ChartDescriptionDrawer';
import {
  buildExploreChartResult,
  buildExploreExecuteRequest,
  buildExploreSqlPreview,
  buildQuerySignature,
  inferRoleConfigFromCustomSql,
  inferQueryColumns,
  normalizeExecuteResponseColumns,
  stripTrailingSqlLimit,
} from '@/lib/explore-query';
import type { ChartMetadataUpsert, ChartParameterCreate } from '@/types/api';
import { useDatasetModel, type DimensionDefinition, type MeasureDefinition, type DatasetModelView } from '@/hooks/use-dataset-model';
import { computeReachableViews } from '@/lib/dataset-model-graph';

type ChartType = ExploreChartType;


type QueryMode = 'generated' | 'custom';

const GENERATED_QUERY_LIMIT_OPTIONS = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
const CUSTOM_QUERY_LIMIT_OPTIONS = [50, 100, 250, 500, 1000, 2500, 5000];
const TABLE_LIKE_CHART_TYPES = new Set<ChartType>(['TABLE', 'MATRIX']);
const SCATTER_LIKE_CHART_TYPES = new Set<ChartType>(['SCATTER', 'BUBBLE', 'MAP_POINT']);
const NO_DIMENSION_METRIC_CHART_TYPES = new Set<ChartType>(['KPI', 'GAUGE', 'BULLET']);
const PIE_LIKE_CHART_TYPES = new Set<ChartType>(['PIE', 'DONUT', 'POLAR_AREA']);
const SINGLE_METRIC_CHART_TYPES = new Set<ChartType>([
  'GROUPED_BAR',
  'STACKED_BAR',
  'PIE',
  'DONUT',
  'POLAR_AREA',
  'FUNNEL',
  'TREEMAP',
  'WATERFALL',
  'MAP_REGION',
  'BOXPLOT',
  'HEATMAP',
  'SANKEY',
  'SUNBURST',
  'RIBBON',
  'TIMELINE',
  'WORD_CLOUD',
  'KPI',
  'GAUGE',
  'BULLET',
  'PODIUM',
]);
const BREAKDOWN_REQUIRED_CHART_TYPES = new Set<ChartType>([
  'GROUPED_BAR',
  'STACKED_BAR',
  'HEATMAP',
  'SANKEY',
  'SUNBURST',
  'RIBBON',
]);

function getMaxQueryLimit(mode: QueryMode): number {
  return mode === 'custom' ? 5000 : 10000;
}

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

function inferSortLimitColumns(
  chartType: ChartType,
  rows: Record<string, any>[],
  roleConfig: ChartRoleConfig,
  preAggregated: boolean,
): ColumnMetadata[] {
  if (
    !rows.length ||
    TABLE_LIKE_CHART_TYPES.has(chartType) ||
    NO_DIMENSION_METRIC_CHART_TYPES.has(chartType) ||
    chartType === 'PODIUM'
  ) {
    return [];
  }

  const model = buildExploreChartModel({
    type: chartType,
    data: rows,
    roleConfig,
    preAggregated,
  });

  const sortRows = (() => {
    if (SCATTER_LIKE_CHART_TYPES.has(chartType)) {
      return model.scatterPoints;
    }
    if (PIE_LIKE_CHART_TYPES.has(chartType)) {
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

function createDefaultTableRoleConfig(
  roleConfig: ChartRoleConfig,
  tableMode: ChartRoleConfig['tableMode'] = 'standard',
): ChartRoleConfig {
  // Preserve fields the user already bound: dimensions and metric fields all
  // become candidate table columns. This avoids silently dropping cross-table
  // fields when switching from chart \u2192 table view. `syncRoleConfigWithColumns`
  // will still drop any field that isn't in `availableGeneratedColumns`.
  const preservedColumns: string[] = [];
  const pushUnique = (value?: string | null) => {
    if (!value) return;
    if (preservedColumns.includes(value)) return;
    preservedColumns.push(value);
  };
  pushUnique(roleConfig.dimension);
  pushUnique(roleConfig.breakdown);
  pushUnique(roleConfig.timeField);
  pushUnique(roleConfig.scatterX);
  pushUnique(roleConfig.scatterY);
  for (const metric of roleConfig.metrics ?? []) {
    pushUnique(metric.field);
  }
  for (const existing of roleConfig.selectedColumns ?? []) {
    pushUnique(existing);
  }

  return {
    ...roleConfig,
    dimension: undefined,
    breakdown: undefined,
    timeField: undefined,
    scatterX: undefined,
    scatterY: undefined,
    lineMetric: undefined,
    metrics: [],
    tableMode,
    tableRowDimension: undefined,
    tableColumnDimension: undefined,
    tablePivotMetric: undefined,
    selectedColumns: preservedColumns.length > 0 ? preservedColumns : undefined,
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
    tableColumnWidths: undefined,
    tableColumnAlignments: undefined,
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

function semanticAlias(fieldRef: string): string {
  return fieldRef.replace(/[^A-Za-z0-9_]/g, '_');
}

function measureAggForRole(measure: MeasureDefinition): MetricConfig['agg'] {
  return ['sum', 'avg', 'count', 'min', 'max', 'count_distinct'].includes(measure.type)
    ? measure.type as MetricConfig['agg']
    : 'sum';
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
  const pickDimensionOtherThan = (...excluded: Array<string | undefined>) => (
    categoricalColumns.find((column) => !excluded.includes(column.name))?.name
      ?? columns.find((column) => !excluded.includes(column.name))?.name
  );
  const pickMetricOtherThan = (...excluded: Array<string | undefined>) => (
    numericColumns.find((column) => !excluded.includes(column.name))?.name
      ?? fallbackMetric
  );

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

  if (TABLE_LIKE_CHART_TYPES.has(chartType)) {
    if (chartType === 'MATRIX') {
      next.tableMode = 'pivot';
    }
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

  if (SCATTER_LIKE_CHART_TYPES.has(chartType)) {
    if (!next.scatterX) next.scatterX = numericColumns[0]?.name;
    if (!next.scatterY) next.scatterY = numericColumns[1]?.name ?? numericColumns[0]?.name;
    if (!next.dimension && categoricalColumns.length > 0) {
      next.dimension = categoricalColumns[0]?.name;
    }
    if ((chartType === 'BUBBLE' || chartType === 'MAP_POINT') && next.metrics.length === 0) {
      const sizeMetric = pickMetricOtherThan(next.scatterX, next.scatterY);
      if (sizeMetric) {
        next.metrics = [{ field: sizeMetric, agg: 'sum' }];
      }
    }
    return next;
  }

  if (NO_DIMENSION_METRIC_CHART_TYPES.has(chartType)) {
    next.dimension = undefined;
    next.breakdown = undefined;
    next.timeField = undefined;
    if (next.metrics.length === 0 && fallbackMetric) {
      next.metrics = [{ field: fallbackMetric, agg: 'sum' }];
    }
    if (next.metrics.length > 1) {
      next.metrics = [next.metrics[0]];
    }
    return next;
  }

  if (chartType === 'TIME_SERIES') {
    if (!next.timeField) next.timeField = timeColumns[0]?.name ?? fallbackDimension;
    if (!next.dimension) next.dimension = next.timeField ?? fallbackDimension;
  } else if (chartType === 'TIMELINE') {
    if (!next.timeField) next.timeField = timeColumns[0]?.name ?? fallbackDimension;
    if (!next.dimension) next.dimension = pickDimensionOtherThan(next.timeField) ?? fallbackDimension;
  } else if (chartType === 'RIBBON') {
    if (!next.timeField) next.timeField = timeColumns[0]?.name ?? fallbackDimension;
    if (!next.dimension) next.dimension = next.timeField ?? fallbackDimension;
  } else if (!next.dimension) {
    next.dimension = fallbackDimension;
  }

  if (next.metrics.length === 0 && fallbackMetric) {
    next.metrics = [{ field: fallbackMetric, agg: 'sum' }];
  }

  if (BREAKDOWN_REQUIRED_CHART_TYPES.has(chartType) && !next.breakdown) {
    next.breakdown = pickDimensionOtherThan(next.dimension, next.timeField);
  }

  if (SINGLE_METRIC_CHART_TYPES.has(chartType) && next.metrics.length > 1) {
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

function isSourceTimeColumn(column: ColumnMetadata): boolean {
  const loweredType = String(column.type ?? '').toLowerCase();
  const loweredName = String(column.name ?? '').toLowerCase();
  return (
    ['date', 'datetime', 'timestamp', 'time'].includes(loweredType) ||
    /(date|time|_at|created|updated|day|month|year|start|end|deadline)/.test(loweredName)
  );
}

export interface ExploreEditorEphemeralSeed {
  chartType?: ChartType;
  chartName?: string | null;
  chartDescription?: string | null;
  queryMode?: 'generated' | 'custom';
  generatedRoleConfig?: ChartRoleConfig | null;
  customRoleConfig?: ChartRoleConfig | null;
  customSql?: string | null;
  styleConfig?: ChartStyleConfig | null;
  baseFilters?: Filter[] | null;
}

export interface ExploreEditorEphemeralResult {
  chartType: ChartType;
  chartName: string;
  chartDescription: string | null;
  queryMode: 'generated' | 'custom';
  customSql: string | null;
  generatedRoleConfig: ChartRoleConfig;
  customRoleConfig: ChartRoleConfig;
  activeRoleConfig: ChartRoleConfig;
  styleConfig: ChartStyleConfig;
  baseFilters: Filter[];
  datasetId: number | null;
  datasetTableId: number | null;
}

export interface ExploreEditorProps {
  chartId?: number | null;
  embedded?: boolean;
  embeddedVariant?: 'default' | 'dashboard-modal';
  initialDatasetId?: number | null;
  initialTableId?: number | null;
  onBack?: () => void;
  onChartSaved?: (chartId: number) => void | Promise<void>;
  /**
   * Fired whenever the currently-selected dataset changes. Lets parents (e.g.
   * a Calculated-Tables side tab) know which dataset the user is working on.
   */
  onDatasetChange?: (datasetId: number | null) => void;
  backLabel?: string;
  saveButtonLabel?: string;
  // ── Ephemeral (unsaved draft) mode ──────────────────────────────────────
  // When mode='ephemeral', no chart row is created/updated in the DB. Save
  // invokes onEphemeralSave with the full config snapshot so the caller
  // (e.g. the HTML-import wizard) can fold it back into its own state.
  mode?: 'full' | 'ephemeral';
  initialSeed?: ExploreEditorEphemeralSeed;
  onEphemeralSave?: (result: ExploreEditorEphemeralResult) => void | Promise<void>;
  // Lock the dataset dropdown — useful when the wizard has already committed
  // to a specific dataset and the user should only change tables within it.
  lockDatasetSelection?: boolean;
}

export function ExploreEditor({
  chartId = null,
  embedded = false,
  embeddedVariant = 'default',
  initialDatasetId = null,
  initialTableId = null,
  onBack,
  onChartSaved,
  onDatasetChange,
  backLabel,
  saveButtonLabel,
  mode = 'full',
  initialSeed,
  onEphemeralSave,
  lockDatasetSelection = false,
}: ExploreEditorProps) {
  const router = useRouter();
  const isEphemeral = mode === 'ephemeral';
  // Ephemeral editors are never bound to an existing chart row.
  const effectiveChartId = isEphemeral ? null : chartId;
  const isNew = effectiveChartId == null;
  const isDashboardModal = embeddedVariant === 'dashboard-modal';

  const [selectedDatasetId, setSelectedDatasetId] = useState<number | null>(initialDatasetId);
  const [selectedTableId, setSelectedTableId] = useState<number | null>(initialTableId);
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
  const [isFiltersOpen, setIsFiltersOpen] = useState(!isDashboardModal);
  const [isDescDrawerOpen, setIsDescDrawerOpen] = useState(false);
  const [previewPanelTab, setPreviewPanelTab] = useState<'chart' | 'table'>('chart');
  const [queryLimit, setQueryLimit] = useState(100);
  const [sqlMode, setSqlMode] = useState<QueryMode>('generated');
  const [customSqlDraft, setCustomSqlDraft] = useState('');
  const [generatedQueryState, setGeneratedQueryState] = useState<ExploreQueryState | null>(null);
  const [customQueryState, setCustomQueryState] = useState<ExploreQueryState | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [generatedLastRunSignature, setGeneratedLastRunSignature] = useState('');
  const [customLastRunSignature, setCustomLastRunSignature] = useState('');

  // Metadata state (persisted on save, not shown in sidebar UI)
  const [metaDomain, setMetaDomain] = useState('');
  const [metaIntent, setMetaIntent] = useState('');
  const [metaMetrics, setMetaMetrics] = useState<string[]>([]);
  const [metaDimensions, setMetaDimensions] = useState<string[]>([]);
  const [metaTags, setMetaTags] = useState<string[]>([]);

  // Parameters state
  type ParamRow = ChartParameterCreate & { _key: string };
  const [paramRows, setParamRows] = useState<ParamRow[]>([]);

  const createChart = useCreateChart();
  const updateChart = useUpdateChart();
  const upsertMetadata = useUpsertChartMetadata();
  const replaceParams = useReplaceChartParameters();
  const executeDatasetQuery = useExecuteDatasetTableQueryMutation();
  const previewChartData = usePreviewChartData();

  const { data: chart, isLoading: isChartLoading } = useChart(isEphemeral ? 0 : (chartId ?? 0));
  const { data: dataset } = useDataset(selectedDatasetId);
  const { data: datasetModel } = useDatasetModel(selectedDatasetId);
  const resPerms = getResourcePermissions(isNew ? 'full' : chart?.user_permission);
  const skipNextSourceResetRef = useRef(false);
  const seedAppliedRef = useRef(false);
  const resolvedBackLabel = backLabel ?? (embedded ? 'Back to dashboard' : 'All Charts');

  // One-shot seed of editor state from the ephemeral initialSeed. Must run
  // before the generic "sync role config with columns" effects so it wins.
  useEffect(() => {
    if (!isEphemeral || seedAppliedRef.current) return;
    if (!initialSeed) {
      seedAppliedRef.current = true;
      return;
    }
    seedAppliedRef.current = true;
    if (initialSeed.chartType) setChartType(initialSeed.chartType);
    if (initialSeed.chartName != null) setChartNameInput(initialSeed.chartName);
    if (initialSeed.chartDescription != null) setChartDescInput(initialSeed.chartDescription);
    if (initialSeed.styleConfig) {
      setChartStyleConfig(normalizeChartStyleConfig(initialSeed.styleConfig, undefined));
    }
    if (initialSeed.baseFilters) setFilters(initialSeed.baseFilters);
    const seedChartType = initialSeed.chartType ?? 'TABLE';
    if (initialSeed.generatedRoleConfig) {
      setGeneratedRoleConfig(normalizeRoleConfig(seedChartType, initialSeed.generatedRoleConfig));
    }
    if (initialSeed.customRoleConfig) {
      setCustomRoleConfig(normalizeRoleConfig(seedChartType, initialSeed.customRoleConfig));
    }
    if (initialSeed.customSql != null) setCustomSqlDraft(initialSeed.customSql);
    if (initialSeed.queryMode === 'custom' && initialSeed.customSql) {
      setSqlMode('custom');
    } else {
      setSqlMode('generated');
    }
    // Name editing starts closed once we have a real seeded name.
    if (initialSeed.chartName) setIsEditingName(false);
  }, [isEphemeral, initialSeed]);

  useEffect(() => {
    if (isDashboardModal && sqlMode !== 'generated') {
      setSqlMode('generated');
    }
  }, [isDashboardModal, sqlMode]);

  useEffect(() => {
    if (initialDatasetId != null && selectedDatasetId == null) {
      setSelectedDatasetId(initialDatasetId);
    }
  }, [initialDatasetId, selectedDatasetId]);

  useEffect(() => {
    onDatasetChange?.(selectedDatasetId);
  }, [selectedDatasetId, onDatasetChange]);

  useEffect(() => {
    if (initialTableId != null && selectedTableId == null) {
      setSelectedTableId(initialTableId);
    }
  }, [initialTableId, selectedTableId]);

  const handleExit = useCallback(() => {
    if (onBack) {
      onBack();
      return;
    }
    router.push('/explore');
  }, [onBack, router]);

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
      const datasetId = config?.dataset_id ?? chart.dataset_id;
      if (datasetId) setSelectedDatasetId(datasetId);
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
  const selectedTable = dataset?.tables?.find((table) => table.id === selectedTableId) ?? null;
  const selectedTableDisplayName = selectedTable?.display_name || 'Selected table';
  const hasActiveTransforms = Boolean(selectedTable?.transformations?.some((step) => step.enabled));
  const selectedSemanticView = useMemo(
    () => datasetModel?.views?.find((view) => view.dataset_table_id === selectedTableId) ?? null,
    [datasetModel?.views, selectedTableId],
  );
  /**
   * Cross-table support: from the selected table's semantic view, walk the
   * explore's join graph to find every reachable view. The chart builder uses
   * dimensions/measures from ALL reachable views (not just the selected one)
   * so cross-table fields can flow through to the backend semantic engine,
   * which already knows how to JOIN them via SemanticExplore.joins.
   */
  const reachableViewNames = useMemo<Set<string>>(() => {
    if (!datasetModel || !selectedSemanticView) return new Set();
    return computeReachableViews(datasetModel, selectedSemanticView.name);
  }, [datasetModel, selectedSemanticView]);
  const reachableSemanticViews = useMemo<DatasetModelView[]>(() => {
    if (!datasetModel?.views || reachableViewNames.size === 0) return [];
    return datasetModel.views.filter((view) => reachableViewNames.has(view.name));
  }, [datasetModel?.views, reachableViewNames]);
  const semanticColumns = useMemo<ColumnMetadata[]>(() => {
    if (reachableSemanticViews.length === 0) return [];
    const out: ColumnMetadata[] = [];
    for (const view of reachableSemanticViews) {
      for (const dim of view.dimensions ?? []) {
        if (dim.hidden) continue;
        out.push({
          name: `${view.name}.${dim.name}`,
          type: dim.type === 'number' ? 'number' : dim.type,
          label: (dim.label && dim.label.trim()) ? dim.label : dim.name,
          nullable: true,
        });
      }
      for (const measure of view.measures ?? []) {
        if (measure.hidden) continue;
        out.push({
          name: `${view.name}.${measure.name}`,
          type: 'number',
          label: (measure.label && measure.label.trim()) ? measure.label : measure.name,
          nullable: true,
        });
      }
    }
    return out;
  }, [reachableSemanticViews]);

  /** Map of bare column-name → friendly label, sourced from the selected
   *  view's dimensions/measures so raw preview columns can also display
   *  the user-facing label rather than the SQL identifier. Only the selected
   *  (anchor) view contributes here because preview rows belong to that table. */
  const semanticLabelByColumnName = useMemo<Map<string, string>>(() => {
    const map = new Map<string, string>();
    if (!selectedSemanticView) return map;
    for (const dim of selectedSemanticView.dimensions ?? []) {
      if (dim.label && dim.label.trim()) map.set(dim.name, dim.label.trim());
    }
    for (const measure of selectedSemanticView.measures ?? []) {
      if (measure.label && measure.label.trim()) map.set(measure.name, measure.label.trim());
    }
    return map;
  }, [selectedSemanticView]);
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
  const effectiveQueryLimit = useMemo(
    () => Math.min(queryLimit, getMaxQueryLimit(sqlMode)),
    [queryLimit, sqlMode],
  );
  const queryLimitOptions = sqlMode === 'custom'
    ? CUSTOM_QUERY_LIMIT_OPTIONS
    : GENERATED_QUERY_LIMIT_OPTIONS;
  const activeValidationMessage = useMemo(
    () => getChartRoleConfigValidationMessage(chartType, normalizedRoleConfig),
    [chartType, normalizedRoleConfig],
  );
  const generatedRoleRequirementMessage = useMemo(
    () => getChartRoleConfigRequirementMessage(chartType, normalizedGeneratedRoleConfig),
    [chartType, normalizedGeneratedRoleConfig],
  );
  const customRoleRequirementMessage = useMemo(
    () => customQueryState
      ? getChartRoleConfigRequirementMessage(chartType, normalizedCustomRoleConfig)
      : null,
    [chartType, customQueryState, normalizedCustomRoleConfig],
  );
  const previewColumns = useMemo<ColumnMetadata[]>(() => {
    const raw = previewData?.columns ?? [];
    if (semanticLabelByColumnName.size === 0) return raw;
    return raw.map((col) => {
      if (col.label && col.label.trim()) return col;
      const friendly = semanticLabelByColumnName.get(col.name);
      return friendly ? { ...col, label: friendly } : col;
    });
  }, [previewData?.columns, semanticLabelByColumnName]);
  const previewRows = previewData?.rows ?? [];
  const executeRequest = useMemo(
    () => buildExploreExecuteRequest({
      chartType,
      roleConfig: normalizedGeneratedRoleConfig,
      filters,
      limit: effectiveQueryLimit,
    }),
    [chartType, normalizedGeneratedRoleConfig, filters, effectiveQueryLimit],
  );
  const generatedSql = useMemo(
    () => buildExploreSqlPreview({
      table: selectedTable,
      chartType,
      roleConfig: normalizedGeneratedRoleConfig,
      filters,
      limit: effectiveQueryLimit,
    }),
    [selectedTable, chartType, normalizedGeneratedRoleConfig, filters, effectiveQueryLimit],
  );
  const currentQuerySignature = useMemo(
    () => buildQuerySignature({
      datasetId: selectedDatasetId,
      tableId: selectedTableId,
      limit: effectiveQueryLimit,
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
      effectiveQueryLimit,
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
    : [...previewColumns, ...semanticColumns];
  const filterColumns = sqlMode === 'custom'
    ? (customConfigColumns ?? [])
    : [...previewColumns, ...semanticColumns.filter((column) => column.type !== 'number')];
  const filterRows = sqlMode === 'custom'
    ? (customQueryState?.rows ?? [])
    : previewRows;
  const parameterColumns = sqlMode === 'custom'
    ? (customConfigColumns ?? [])
    : previewColumns;
  const displayedQueryState = activeQueryState;

  const tableDisplayColumns = useMemo(() => {
    if (!TABLE_LIKE_CHART_TYPES.has(chartType)) {
      return [];
    }

    if (displayedQueryState?.chartRows?.length) {
      const tableModel = buildExploreChartModel({
        type: chartType,
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
      type: chartType,
      data: previewRows,
      roleConfig: normalizedRoleConfig,
      preAggregated: false,
    });

    return normalizeTableDisplayColumns(
      inferQueryColumns(previewModel.tableColumns, previewModel.tableData),
      normalizedRoleConfig,
    );
  }, [chartType, displayedQueryState?.chartPreAggregated, displayedQueryState?.chartRows, normalizedRoleConfig, previewRows]);

  const previewSeriesKeys = useMemo(() => {
    const rows = displayedQueryState?.chartRows ?? [];
    if (
      !rows.length ||
      TABLE_LIKE_CHART_TYPES.has(chartType) ||
      NO_DIMENSION_METRIC_CHART_TYPES.has(chartType) ||
      chartType === 'PODIUM' ||
      SCATTER_LIKE_CHART_TYPES.has(chartType)
    ) {
      return [];
    }
    const model = buildExploreChartModel({
      type: chartType,
      data: rows,
      roleConfig: normalizedRoleConfig,
      preAggregated: displayedQueryState?.chartPreAggregated ?? false,
    });
    if (chartType === 'BAR_LINE') {
      return [...(model.comboBarSeries ?? []), ...(model.comboLineSeries ?? [])].map((s) => ({
        key: s.key,
        label: s.label,
      }));
    }
    if (PIE_LIKE_CHART_TYPES.has(chartType)) {
      return (model.pieData ?? []).slice(0, 12).map((p: any) => ({
        key: String(p?.name ?? ''),
        label: String(p?.name ?? ''),
      }));
    }
    return (model.categoricalSeries ?? []).map((s) => ({ key: s.key, label: s.label }));
  }, [chartType, displayedQueryState?.chartRows, displayedQueryState?.chartPreAggregated, normalizedRoleConfig]);

  const sortLimitColumns = useMemo(() => {
    const inferenceRows = displayedQueryState?.chartRows?.length
      ? displayedQueryState.chartRows
      : displayedQueryState?.rows?.length
        ? displayedQueryState.rows
        : (sqlMode === 'generated' ? previewRows : []);
    const inferredColumns = inferSortLimitColumns(
      chartType,
      inferenceRows,
      normalizedRoleConfig,
      displayedQueryState?.chartRows?.length ? displayedQueryState.chartPreAggregated : false,
    );

    return inferredColumns;
  }, [
    chartType,
    displayedQueryState?.chartPreAggregated,
    displayedQueryState?.chartRows,
    displayedQueryState?.rows,
    normalizedRoleConfig,
    previewRows,
    sqlMode,
  ]);

  const mappingSummary = useMemo(() => {
    if (TABLE_LIKE_CHART_TYPES.has(chartType)) {
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

    if (SCATTER_LIKE_CHART_TYPES.has(chartType)) {
      return [
        normalizedRoleConfig.scatterX ? { label: 'X', value: normalizedRoleConfig.scatterX } : null,
        normalizedRoleConfig.scatterY ? { label: 'Y', value: normalizedRoleConfig.scatterY } : null,
        normalizedRoleConfig.dimension ? { label: 'Label', value: normalizedRoleConfig.dimension } : null,
        chartType !== 'SCATTER' && normalizedRoleConfig.metrics[0]
          ? { label: 'Size', value: normalizedRoleConfig.metrics[0].field }
          : null,
      ].filter((item): item is { label: string; value: string } => item !== null);
    }

    return [
      normalizedRoleConfig.timeField ? { label: 'Time', value: normalizedRoleConfig.timeField } : null,
      normalizedRoleConfig.dimension && chartType !== 'TIME_SERIES' && chartType !== 'RIBBON' ? { label: 'X', value: normalizedRoleConfig.dimension } : null,
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

    if (!TABLE_LIKE_CHART_TYPES.has(nextType) || TABLE_LIKE_CHART_TYPES.has(chartType)) {
      return;
    }

    const nextTableMode = nextType === 'MATRIX' ? 'pivot' : 'standard';
    setGeneratedRoleConfig((prev) => createDefaultTableRoleConfig(prev, nextTableMode));
    setCustomRoleConfig((prev) => createDefaultTableRoleConfig(prev, nextTableMode));
    setChartStyleConfig((prev) => createDefaultTableStyleConfig(prev));
    setGeneratedQueryState(null);
    setCustomQueryState(null);
    setGeneratedLastRunSignature('');
    setCustomLastRunSignature('');
    setQueryError(null);
  }, [chartType]);

  const handleSelectSemanticDimension = useCallback((dim: DimensionDefinition, viewName: string) => {
    const field = `${viewName}.${dim.name}`;
    setGeneratedRoleConfig((prev) => {
      const current = normalizeRoleConfig(chartType, prev);
      if (TABLE_LIKE_CHART_TYPES.has(chartType)) {
        const selected = current.selectedColumns ?? [];
        return {
          ...current,
          selectedColumns: selected.includes(field) ? selected : [...selected, field],
        };
      }
      if (!current.dimension) {
        return { ...current, dimension: field };
      }
      if (!current.breakdown && current.dimension !== field && BREAKDOWN_REQUIRED_CHART_TYPES.has(chartType)) {
        return { ...current, breakdown: field };
      }
      return { ...current, dimension: field };
    });
    setSqlMode('generated');
  }, [chartType]);

  const handleSelectSemanticMeasure = useCallback((measure: MeasureDefinition, viewName: string) => {
    const field = `${viewName}.${measure.name}`;
    const metric: MetricConfig = {
      field,
      agg: measureAggForRole(measure),
      outputField: semanticAlias(field),
    };
    setGeneratedRoleConfig((prev) => {
      const current = normalizeRoleConfig(chartType, prev);
      const existing = current.metrics.some((item) => item.field === field);
      const metrics = existing ? current.metrics : [...current.metrics, metric];
      if (TABLE_LIKE_CHART_TYPES.has(chartType)) {
        return {
          ...current,
          metrics,
        };
      }
      if (SINGLE_METRIC_CHART_TYPES.has(chartType)) {
        return { ...current, metrics: [metric] };
      }
      return { ...current, metrics };
    });
    setSqlMode('generated');
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
    const availableGeneratedColumns = [...previewColumns, ...semanticColumns];
    if (!availableGeneratedColumns.length) return;
    setGeneratedRoleConfig((prev) => syncRoleConfigWithColumns(chartType, prev, availableGeneratedColumns));
  }, [chartType, previewColumns, semanticColumns]);

  useEffect(() => {
    const maxLimit = getMaxQueryLimit(sqlMode);
    if (queryLimit > maxLimit) {
      setQueryLimit(maxLimit);
    }
  }, [queryLimit, sqlMode]);

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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
          limit: effectiveQueryLimit,
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
          source_sample_limit: effectiveQueryLimit,
        });

        const sourceRows = sourceSampleResponse.source_rows ?? [];
        const sourceColumnNames = sourceSampleResponse.source_columns?.length
          ? sourceSampleResponse.source_columns
          : Object.keys(sourceRows[0] ?? {});
        const sourceColumns = inferQueryColumns(sourceColumnNames, sourceRows);
        const inferredConfigs = inferRoleConfigFromCustomSql({
          sql,
          chartType,
          columns: sourceColumns,
          currentRoleConfig: normalizedCustomRoleConfig,
        });
        const fallbackCustomRoleConfig = sourceColumns.length > 0
          ? (
            TABLE_LIKE_CHART_TYPES.has(chartType)
              ? {
                  ...syncRoleConfigWithColumns(chartType, normalizedCustomRoleConfig, sourceColumns),
                  selectedColumns: sourceColumns.map((column) => column.name),
                }
              : syncRoleConfigWithColumns(chartType, normalizedCustomRoleConfig, sourceColumns)
          )
          : normalizedCustomRoleConfig;
        const nextCustomRoleConfig = sourceColumns.length > 0
          ? pruneRoleConfigToColumns(
              chartType,
              inferredConfigs.customRoleConfig ?? fallbackCustomRoleConfig,
              sourceColumns,
            )
          : normalizedCustomRoleConfig;
        const nextCustomSignature = buildQuerySignature({
          datasetId: selectedDatasetId,
          tableId: selectedTableId,
          limit: effectiveQueryLimit,
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

        if (inferredConfigs.generatedRoleConfig) {
          const nextGeneratedRoleConfig = previewColumns.length > 0
            ? syncRoleConfigWithColumns(chartType, inferredConfigs.generatedRoleConfig, previewColumns)
            : normalizeRoleConfig(chartType, inferredConfigs.generatedRoleConfig);
          if (JSON.stringify(nextGeneratedRoleConfig) !== JSON.stringify(normalizedGeneratedRoleConfig)) {
            setGeneratedRoleConfig(nextGeneratedRoleConfig);
          }
        }

        const nextCustomMessage = getChartRoleConfigRequirementMessage(chartType, nextCustomRoleConfig);
        if (nextCustomMessage) {
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
          setQueryError(nextCustomMessage);
          toast.info(nextCustomMessage);
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
        if (generatedRoleRequirementMessage) {
          setQueryError(generatedRoleRequirementMessage);
          toast.error(generatedRoleRequirementMessage);
          return;
        }

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
    if (isNew || didAutoRunRef.current || !isChartLoaded || !selectedDatasetId || !selectedTableId || !selectedTable) {
      return;
    }
    didAutoRunRef.current = true;
    void handleRunQuery();
  }, [isNew, isChartLoaded, selectedDatasetId, selectedTableId, selectedTable, currentQuerySignature]);

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
      if (customRoleRequirementMessage) {
        toast.error(customRoleRequirementMessage);
        return;
      }
      if (!customQueryState || currentQuerySignature !== customLastRunSignature) {
        toast.error('Run the custom SQL before saving so the chart uses the latest output columns');
        return;
      }
    } else if (generatedRoleRequirementMessage) {
      toast.error(generatedRoleRequirementMessage);
      return;
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
      ...(TABLE_LIKE_CHART_TYPES.has(chartType) && tableConditionalFormatting?.length
        ? { conditional_formatting: tableConditionalFormatting }
        : {}),
    };

    // Ephemeral mode: don't persist anything — hand the snapshot back to the
    // caller (e.g. the HTML-import wizard) and let it fold into its own state.
    if (isEphemeral) {
      if (!onEphemeralSave) {
        toast.error('No save handler was provided for this editor.');
        return;
      }
      const name = chartNameInput.trim();
      if (!name) {
        setIsEditingName(true);
        toast.error('Please enter a chart name');
        return;
      }
      try {
        await onEphemeralSave({
          chartType: chartType as ChartType,
          chartName: name,
          chartDescription: chartDescInput.trim() || null,
          queryMode: sqlMode,
          customSql: trimmedCustomSql || null,
          generatedRoleConfig,
          customRoleConfig,
          activeRoleConfig: activeSavedRoleConfig,
          styleConfig: chartStyleConfig,
          baseFilters: filters,
          datasetId: selectedDatasetId,
          datasetTableId: selectedTableId,
        });
      } catch (error: any) {
        toast.error(getApiErrorMessage(error, 'Could not save chart changes.'));
      }
      return;
    }

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
        if (onChartSaved) {
          try {
            await onChartSaved(newChart.id);
          } catch (postSaveError: any) {
            const message = getApiErrorMessage(
              postSaveError,
              'Chart saved, but it could not be added to the dashboard.',
            );
            toast.error(message);
          }
        } else {
          router.replace('/explore/' + newChart.id);
        }
      }
    } catch (error: any) {
      console.error('Error saving chart:', error);
      toast.error(`Failed to save chart: ${error?.response?.data?.detail || error.message}`);
    }
  };


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
  const customRunMessage = sqlMode === 'custom' && customQueryState
    ? customRoleRequirementMessage
    : null;
  const modeDescription = isConfigBuilderMode
    ? 'Choose a source table, map fields directly from the left panel, and keep chart setup visible on the same screen. Generated queries can preview up to 10,000 rows.'
    : 'Write SQL once on the left, run it, and Explore will auto-bind chart roles from the SQL output when it can. Custom SQL previews are capped at 5,000 rows to keep runtime responsive.';
  const selectedSourceFieldCount = sqlMode === 'custom'
    ? (customQueryState?.columns?.length ?? 0)
    : previewColumns.length;

  // Show loading skeleton while fetching existing chart
  if (!isNew && isChartLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-surface-2">
        <div className="text-center">
          <div className="inline-block w-8 h-8 border-4 border-brand border-t-transparent rounded-full animate-spin mb-3" />
          <p className="text-sm text-text-secondary">Loading chart...</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col bg-surface-2 ${embedded ? 'h-full min-h-0' : 'h-screen'}`}>
      {!isNew && !resPerms.canEdit && resPerms.canView && (
        <div className="shrink-0 border-b border-warning/30 bg-warning/10 px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-warning">
            <Eye className="h-3.5 w-3.5 shrink-0" />
            <span className="font-medium">View only</span>
            <span className="text-warning">— You can preview this chart but cannot modify its configuration.</span>
          </div>
        </div>
      )}
      <div className="shrink-0 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* Left: back + name */}
          <div className="flex min-w-0 items-center gap-2">
            <button
              onClick={handleExit}
              className="flex shrink-0 items-center gap-1 text-xs text-text-quaternary hover:text-text-secondary"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {resolvedBackLabel}
            </button>
            <span className="text-text-secondary">/</span>
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
                  className="min-w-[10rem] border-b border-brand/50 bg-transparent px-0.5 text-sm font-semibold text-text-primary outline-none"
                />
                <Check className="h-3.5 w-3.5 text-brand" />
              </div>
            ) : (
              <div className="flex items-center gap-1.5 group/name">
                <span className="max-w-[14rem] truncate text-sm font-semibold text-text-primary">
                  {chartNameInput || (chartId ? 'Chart' : 'New Chart')}
                </span>
                {resPerms.canEdit && (
                  <button
                    type="button"
                    onClick={() => setIsEditingName(true)}
                    className="rounded-md p-1 text-text-quaternary opacity-0 transition-opacity hover:bg-surface-2 hover:text-text-secondary group-hover/name:opacity-100"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="hidden h-5 w-px bg-[rgb(var(--border-line))] md:block" />

          {/* Middle: mode + source compact */}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {!isDashboardModal && (
              <>
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">Mode</span>
                <div className="inline-flex rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-0.5">
                  <button
                    onClick={handleUseGeneratedQuery}
                    disabled={!resPerms.canEdit}
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      isConfigBuilderMode
                        ? 'bg-surface-1 text-brand shadow-linear-sm'
                        : 'text-text-secondary hover:bg-surface-1'
                    }`}
                  >
                    <Database className="h-3 w-3" />
                    Builder
                  </button>
                  <span className="group/csql relative inline-flex">
                    <button
                      disabled
                      className="inline-flex cursor-not-allowed items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-text-quaternary opacity-50"
                    >
                      <Code2 className="h-3 w-3" />
                      SQL
                    </button>
                    <span className="pointer-events-none absolute left-0 top-full z-50 mt-1.5 hidden w-52 rounded-md bg-surface-inverse px-2.5 py-2 text-[11px] text-white shadow-lg group-hover/csql:block">
                      Temporarily unavailable — will be re-enabled in a future update.
                    </span>
                  </span>
                </div>
                <div className="hidden h-5 w-px bg-[rgb(var(--border-line))] lg:block" />
              </>
            )}
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">Source</span>
            <div className="min-w-[16rem] max-w-[28rem] flex-1">
              <ExploreSourceSelector
                selectedDatasetId={selectedDatasetId}
                selectedTableId={selectedTableId}
                onDatasetChange={setSelectedDatasetId}
                onTableChange={setSelectedTableId}
                disabled={!resPerms.canEdit}
                lockDataset={lockDatasetSelection}
                variant="compact"
              />
            </div>
          </div>

          {/* Right: status + limit + run + save (+ desc note) */}
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {isQueryDirty && (
              <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
                Run to refresh
              </span>
            )}
            {activeQueryState && (
              <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-[11px] text-text-tertiary">
                {activeQueryState.rows.length} row{activeQueryState.rows.length === 1 ? '' : 's'}
                {activeQueryState.executionTimeMs != null ? ` · ${activeQueryState.executionTimeMs}ms` : ''}
              </span>
            )}
            <label className="flex items-center gap-1 text-[11px] text-text-tertiary">
              Limit
              <select
                value={effectiveQueryLimit}
                onChange={(e) => setQueryLimit(Number(e.target.value))}
                disabled={!resPerms.canEdit}
                className="rounded border border-[rgb(var(--border-line))] bg-surface-1 px-1.5 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {queryLimitOptions.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <button
              onClick={() => void handleRunQuery()}
              disabled={!selectedTableId || isRunningQuery || (isConfigBuilderMode && isPreviewLoading)}
              className="inline-flex items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRunningQuery
                ? <div className="h-3 w-3 animate-spin rounded-full border-2 border-text-secondary border-t-transparent" />
                : <Play className="h-3 w-3" />}
              {isRunningQuery ? 'Running...' : 'Run'}
            </button>
            {!isDashboardModal && (
              isEditingDesc ? (
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
                  className="w-44 border-b border-brand/50 bg-transparent px-0.5 text-xs text-text-secondary outline-none"
                />
              ) : resPerms.canEdit ? (
                <button
                  type="button"
                  onClick={() => setIsEditingDesc(true)}
                  className="group/desc flex max-w-[12rem] cursor-text items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-quaternary hover:bg-surface-2 hover:text-text-secondary"
                >
                  <span className="truncate">{chartDescInput || <span className="italic">Add note...</span>}</span>
                  <Pencil className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/desc:opacity-100" />
                </button>
              ) : chartDescInput ? (
                <span className="text-[11px] text-text-quaternary">{chartDescInput}</span>
              ) : null
            )}
            {resPerms.canEdit && (
              <button
                onClick={handleSaveLook}
                disabled={!selectedTableId}
                className="flex items-center gap-1.5 rounded-md border border-brand bg-brand px-3 py-1 text-xs font-medium text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Save className="h-3.5 w-3.5" />
                {saveButtonLabel ?? (chartId ? 'Update' : 'Save')}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full flex-col gap-4 p-4 lg:flex-row">
          <div className="flex min-h-[24rem] min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm lg:min-h-0">
            <div className={`flex items-center justify-between gap-3 border-b border-[rgb(var(--border-line))] px-4 py-2.5 ${
              sqlMode === 'custom' ? 'bg-warning/10' : 'bg-surface-2'
            }`}>
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">Configure</span>
                {selectedTableId && (
                  <>
                    <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-0.5 text-[11px] text-text-secondary">{chartType}</span>
                    {hasActiveTransforms && (
                      <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] text-warning">transforms</span>
                    )}
                    {filters.length > 0 && (
                      <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] text-warning">{filters.length} filter{filters.length === 1 ? '' : 's'}</span>
                    )}
                  </>
                )}
              </div>
              {mappingSummary.length > 0 && (
                <div className="flex max-w-[20rem] flex-wrap justify-end gap-1.5">
                  {mappingSummary.slice(0, 4).map((item) => (
                    <span
                      key={`setup-${item.label}-${item.value}`}
                      className="rounded-full border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-0.5 text-[10px] text-text-secondary"
                    >
                      <span className="font-semibold">{item.label}:</span> {item.value}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {selectedTableId ? (
                <>
                  {sqlMode === 'custom' && (
                    <div className="border-b border-[rgb(var(--border-line))]">
                      <div className="flex items-center justify-between px-5 py-3">
                        <div className="flex items-center gap-1.5">
                          <p className="text-sm font-medium text-text-secondary">Custom SQL</p>
                          <HelpTooltip text="Run SQL to refresh the output columns used by Chart Setup." />
                        </div>
                        {resPerms.canEdit && (
                          <button
                            onClick={handleResetCustomSqlDraft}
                            className="inline-flex items-center gap-1 rounded-lg border border-[rgb(var(--border-line))] px-2 py-1 text-xs text-text-secondary hover:bg-surface-2"
                          >
                            <RotateCcw className="h-3 w-3" />
                            Reset
                          </button>
                        )}
                      </div>

                      <div className="border-t border-[rgb(var(--border-line))] p-5">
                        <textarea
                          value={customSqlDraft}
                          onChange={(e) => setCustomSqlDraft(e.target.value)}
                          readOnly={!resPerms.canEdit}
                          spellCheck={false}
                          className={`h-56 w-full resize-none rounded-2xl border border-[rgb(var(--border-line))] bg-surface-inverse px-3 py-3 font-mono text-xs text-text-secondary outline-none transition focus:border-warning/40 focus:ring-2 focus:ring-warning${!resPerms.canEdit ? ' opacity-60 cursor-not-allowed' : ''}`}
                        />

                        <div className="mt-4 rounded-2xl border border-[rgb(var(--border-line))] bg-surface-2 p-4">
                          <p className="text-sm font-medium text-text-primary">Output columns</p>
                          <p className="mt-1 text-xs text-text-tertiary">
                            These columns only exist after the SQL runs. Chart Setup binds directly to them.
                          </p>
                        </div>

                        <div className="mt-3 space-y-2">
                          {customQueryState?.columns?.length ? (
                            customQueryState.columns.map((column) => (
                              <div
                                key={column.name}
                                className="flex items-center justify-between rounded-2xl border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2"
                              >
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-text-secondary">{column.name}</p>
                                  <p className="text-xs text-text-quaternary">{column.type}</p>
                                </div>
                                <span className="rounded-full bg-surface-1 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
                                  SQL
                                </span>
                              </div>
                            ))
                          ) : (
                            <div className="rounded-2xl border border-dashed border-[rgb(var(--border-line))] bg-surface-2 px-4 py-6 text-center">
                              <Code2 className="mx-auto mb-3 h-8 w-8 text-warning" />
                              <p className="text-sm font-medium text-text-secondary">Run SQL to load output columns</p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {sqlMode === 'generated' && selectedDatasetId && (
                    <div className="border-b border-[rgb(var(--border-line))] bg-surface-1">
                      <div className="flex items-center justify-between px-5 py-3">
                        <div>
                          <p className="text-sm font-medium text-text-secondary">Semantic fields</p>
                          <p className="mt-0.5 text-xs text-text-tertiary">
                            Pick governed dimensions and measures from the dataset model.
                          </p>
                        </div>
                        {selectedSemanticView && (
                          <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-[10px] text-text-tertiary">
                            {selectedSemanticView.table_display_name || selectedSemanticView.name}
                          </span>
                        )}
                      </div>
                      <div className="max-h-72 overflow-y-auto border-t border-[rgb(var(--border-line))]">
                        <ExploreColumnPanel
                          datasetId={selectedDatasetId}
                          selectedTableId={selectedTableId}
                          reachableViewNames={reachableViewNames}
                          onSelectDimension={handleSelectSemanticDimension}
                          onSelectMeasure={handleSelectSemanticMeasure}
                        />
                      </div>
                    </div>
                  )}

                  <ExploreChartConfig
                    chartType={chartType}
                    roleConfig={activeRoleConfig}
                    styleConfig={chartStyleConfig}
                    availableColumns={configColumns}
                    sortLimitColumns={sortLimitColumns}
                    tableDisplayColumns={tableDisplayColumns}
                    queryMode={sqlMode}
                    validationMessage={activeValidationMessage}
                    readOnly={!resPerms.canEdit}
                    availableSeriesKeys={previewSeriesKeys}
                    onChartTypeChange={handleChartTypeChange}
                    onRoleConfigChange={sqlMode === 'custom' ? setCustomRoleConfig : setGeneratedRoleConfig}
                    onStyleConfigChange={setChartStyleConfig}
                  />

                  <div className="border-t">
                    <button
                      onClick={() => setIsFiltersOpen((open) => !open)}
                      className="flex w-full items-center justify-between px-4 py-2.5 transition-colors hover:bg-surface-2"
                    >
                      <div className="flex items-center gap-2">
                        <Settings2 className="h-3.5 w-3.5 text-text-quaternary" />
                        <span className="text-xs font-semibold text-text-secondary">Chart Filters</span>
                        {filters.length > 0 && (
                          <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                            {filters.length}
                          </span>
                        )}
                      </div>
                      {isFiltersOpen
                        ? <ChevronDown className="h-3.5 w-3.5 text-text-quaternary" />
                        : <ChevronRight className="h-3.5 w-3.5 text-text-quaternary" />}
                    </button>
                    {isFiltersOpen && (
                      <div className="px-4 pb-4">
                        <p className="mb-2 text-[11px] text-text-tertiary">
                          Saved with this chart and still applied after you add it to a dashboard.
                        </p>
                        <p className="mb-3 text-[10px] text-text-quaternary">
                          {sqlMode === 'custom'
                            ? 'These filters run against the columns returned by the custom SQL output.'
                            : 'These filters run before dashboard-level filters.'}
                        </p>
                        {sqlMode === 'custom' && filterColumns.length === 0 ? (
                          <p className="text-xs text-text-quaternary">
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
                </>
              ) : (
                <div className="flex h-full min-h-[28rem] items-center justify-center p-8">
                  <div className="max-w-md text-center">
                    <Settings2 className="mx-auto mb-3 h-10 w-10 text-text-quaternary" />
                    <p className="text-sm font-medium text-text-secondary">Choose a source to unlock Configure</p>
                    <p className="mt-1 text-xs text-text-quaternary">
                      Pick the dataset and table in the header, then configure the chart here.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex min-h-[24rem] min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm lg:min-h-0">
            <div className="flex items-center justify-between gap-3 border-b border-[rgb(var(--border-line))] px-4 py-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">Preview</span>
                <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-[11px] text-text-tertiary">
                  {displayedQueryState
                    ? `${displayedQueryState.rows.length} row${displayedQueryState.rows.length === 1 ? '' : 's'}`
                    : 'No run yet'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="inline-flex rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-0.5">
                  {[
                    { key: 'chart', label: 'Chart' },
                    { key: 'table', label: 'Table' },
                  ].map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setPreviewPanelTab(tab.key as 'chart' | 'table')}
                      className={`rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${
                        previewPanelTab === tab.key
                          ? 'bg-surface-1 text-text-primary shadow-linear-sm'
                          : 'text-text-secondary hover:bg-surface-1'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {queryError && (
              <div className="border-b border-danger/30 bg-danger/10 px-5 py-2 text-xs text-danger">
                {queryError}
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-hidden p-5">
              {!selectedTableId ? (
                <div className="flex h-full items-center justify-center">
                  <div className="max-w-sm text-center">
                    <Search className="mx-auto mb-3 h-12 w-12 text-text-quaternary" />
                    <p className="text-sm font-medium text-text-secondary">Choose a dataset table to start</p>
                    <p className="mt-1 text-xs text-text-quaternary">The source selector lives in the header now.</p>
                  </div>
                </div>
              ) : !displayedQueryState ? (
                <div className="flex h-full items-center justify-center">
                  <div className="max-w-sm text-center">
                    {isConfigBuilderMode
                      ? <Database className="mx-auto mb-3 h-10 w-10 text-text-quaternary" />
                      : <Code2 className="mx-auto mb-3 h-10 w-10 text-warning" />}
                    <p className="text-sm font-medium text-text-secondary">Run once to generate the preview</p>
                    <p className="mt-1 text-xs text-text-quaternary">
                      Configure the chart on the left, then run to see both the visual and table result here.
                    </p>
                  </div>
                </div>
              ) : customRunMessage ? (
                <div className="flex h-full items-center justify-center">
                  <div className="max-w-sm text-center">
                    <Settings2 className="mx-auto mb-3 h-10 w-10 text-warning" />
                    <p className="text-sm font-medium text-text-secondary">Finish the chart roles in Configure</p>
                    <p className="mt-1 text-xs text-text-quaternary">{customRunMessage}</p>
                  </div>
                </div>
              ) : previewPanelTab === 'chart' ? (
                <div className="h-full overflow-hidden rounded-2xl border border-[rgb(var(--border-line))] bg-surface-2 p-3">
                  <div className="h-full overflow-hidden rounded-[20px] bg-surface-1 p-3">
                    <ExploreChart
                      type={chartType}
                      data={displayedQueryState.chartRows}
                      roleConfig={normalizedRoleConfig}
                      styleConfig={chartStyleConfig}
                      onStyleConfigChange={setChartStyleConfig}
                      preAggregated={displayedQueryState.chartPreAggregated}
                    />
                  </div>
                </div>
              ) : (
                <div className="h-full overflow-hidden rounded-2xl border border-[rgb(var(--border-line))] bg-surface-2">
                  <DatasetTableGrid columns={displayedQueryState.columns} rows={displayedQueryState.rows} />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* AI Description drawer — opened from MODE bar */}
      {!isNew && chartId && (
        <ChartDescriptionDrawer
          chartId={chartId}
          canEdit={resPerms.canEdit}
          open={isDescDrawerOpen}
          onClose={() => setIsDescDrawerOpen(false)}
        />
      )}
    </div>
  );
}
