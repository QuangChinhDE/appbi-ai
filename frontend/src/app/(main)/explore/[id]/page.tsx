/**
 * Explore editor - view/edit a specific chart, or create a new one (/explore/new).
 */
'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Save, ArrowLeft, ChevronDown, ChevronRight, Pencil, Check, Search, Plus, Trash2, Tag, Settings2, Bot, Play, RotateCcw, Database, Code2 } from 'lucide-react';
import { useDataset, useTablePreview, useExecuteDatasetTableQueryMutation, type ColumnMetadata } from '@/hooks/use-datasets';
import { ExploreSourceSelector } from '@/components/explore/ExploreSourceSelector';
import { ExploreColumnPanel } from '@/components/explore/ExploreColumnPanel';
import { DatasetTableGrid } from '@/components/datasets/DatasetTableGrid';
import { ExploreChart } from '@/components/explore/ExploreChart';
import { FilterBuilder, type Filter } from '@/components/explore/FilterBuilder';
import { useChart, useCreateChart, useUpdateChart, useUpsertChartMetadata, useReplaceChartParameters } from '@/hooks/use-charts';
import { ExploreChartConfig, type ExploreChartType, type ChartRoleConfig, type ChartStyleConfig, DEFAULT_STYLE_CONFIG, normalizeRoleConfig } from '@/components/explore/ExploreChartConfig';
import { toast } from 'sonner';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { ChartDescriptionPanel } from '@/components/explore/ChartDescriptionPanel';
import { AppModalShell } from '@/components/common/AppModalShell';
import { useExecuteQuery } from '@/hooks/use-datasources';
import {
  buildExploreChartResult,
  buildExploreExecuteRequest,
  buildExploreSqlPreview,
  buildQuerySignature,
  inferRoleConfigFromCustomSql,
  inferQueryColumns,
  normalizeExecuteResponseColumns,
  sqlHasExplicitRowLimit,
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
  chartPreAggregated: boolean;
  executionTimeMs?: number;
}

function hasRoleConfigSelection(roleConfig: ChartRoleConfig | null | undefined): boolean {
  return Boolean(
    roleConfig?.dimension ||
    roleConfig?.breakdown ||
    roleConfig?.timeField ||
    roleConfig?.scatterX ||
    roleConfig?.scatterY ||
    roleConfig?.lineMetric ||
    roleConfig?.metrics?.length ||
    roleConfig?.selectedColumns?.length,
  );
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
      normalized.lineMetric && columnNames.has(normalized.lineMetric.outputField ?? normalized.lineMetric.field)
        ? normalized.lineMetric
        : undefined,
    metrics: normalized.metrics.filter((metric) => columnNames.has(metric.outputField ?? metric.field)),
    selectedColumns: normalized.selectedColumns?.filter((column) => columnNames.has(column)),
  };

  if (next.selectedColumns && next.selectedColumns.length === 0) {
    next.selectedColumns = undefined;
  }

  if (chartType === 'TABLE') {
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
  const [isFiltersOpen, setIsFiltersOpen] = useState(false);
  // resultTab removed - new layout shows chart + table simultaneously, SQL via sqlMode toggle
  const [queryLimit, setQueryLimit] = useState(100);
  const [sqlMode, setSqlMode] = useState<QueryMode>('generated');
  const [isSqlEditorOpen, setIsSqlEditorOpen] = useState(false);
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
  const executeCustomSql = useExecuteQuery();

  const { data: chart, isLoading: isChartLoading } = useChart(chartId ?? 0);
  const { data: dataset } = useDataset(selectedDatasetId);
  const resPerms = getResourcePermissions(isNew ? 'full' : chart?.user_permission);

  // Load existing chart config into editor state on first data arrival
  useEffect(() => {
    if (isChartLoaded || isNew) return;
    if (!chart) return;

    const config = chart.config as any;
    if (chart.dataset_table_id) {
      setSelectedTableId(chart.dataset_table_id);
      if (config?.dataset_id) setSelectedDatasetId(config.dataset_id);
    } else if (config?.source?.kind === 'dataset_table') {
      setSelectedDatasetId(config.source.datasetId);
      setSelectedTableId(config.source.tableId);
    }
    setFilters(config?.filters ?? []);
    setChartType(config?.chartType ?? 'TABLE');
    if (config?.styleConfig) {
      setChartStyleConfig({ ...DEFAULT_STYLE_CONFIG, ...config.styleConfig });
    }
    if (config?.roleConfig) {
      const initialRoleConfig = normalizeRoleConfig(
        config?.chartType ?? chart.chart_type,
        config.roleConfig as ChartRoleConfig,
      );
      setGeneratedRoleConfig(initialRoleConfig);
      setCustomRoleConfig(initialRoleConfig);
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
    isLoading: isPreviewLoading,
    error: previewError,
  } = useTablePreview(selectedDatasetId, selectedTableId, {});
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
      request: executeRequest,
      customSql: customSqlDraft,
    }),
    [selectedDatasetId, selectedTableId, queryLimit, sqlMode, executeRequest, customSqlDraft],
  );
  const activeQueryState = sqlMode === 'custom' ? customQueryState : generatedQueryState;
  const activeLastRunSignature = sqlMode === 'custom'
    ? customLastRunSignature
    : generatedLastRunSignature;
  const isQueryDirty = activeQueryState !== null && currentQuerySignature !== activeLastRunSignature;
  const isRunningQuery = executeDatasetQuery.isPending || executeCustomSql.isPending;
  const customConfigColumns = customQueryState?.columns ?? null;
  const configColumns = sqlMode === 'custom' && customConfigColumns?.length
    ? customConfigColumns
    : previewColumns;
  const displayedQueryState = useMemo(() => {
    if (!activeQueryState) return null;
    if (sqlMode !== 'custom') return activeQueryState;

    const chartResult = buildExploreChartResult({
      rows: activeQueryState.rows,
      columns: activeQueryState.columns,
      chartType,
      roleConfig: normalizedCustomRoleConfig,
      source: 'custom',
    });

    return {
      ...activeQueryState,
      chartRows: chartResult.rows,
      chartPreAggregated: chartResult.preAggregated,
    };
  }, [activeQueryState, chartType, normalizedCustomRoleConfig, sqlMode]);

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
    setCustomRoleConfig((prev) => syncRoleConfigWithColumns(chartType, prev, customConfigColumns));
  }, [chartType, customConfigColumns]);

  useEffect(() => {
    setGeneratedQueryState(null);
    setCustomQueryState(null);
    setQueryError(null);
    setGeneratedLastRunSignature('');
    setCustomLastRunSignature('');
    setSqlMode('generated');
    setIsSqlEditorOpen(false);
    setCustomSqlDraft('');
  }, [selectedDatasetId, selectedTableId]);

  const handleEditSql = () => {
    setSqlMode('custom');
    setIsSqlEditorOpen(true);
    setCustomSqlDraft((current) => (current.trim() ? current : stripTrailingSqlLimit(generatedSql)));
    setCustomRoleConfig((current) => (hasRoleConfigSelection(current) ? current : generatedRoleConfig));
  };

  const handleCloseSqlEditor = () => {
    setIsSqlEditorOpen(false);
    if (!customQueryState) {
      setSqlMode('generated');
    }
  };

  const handleUseGeneratedQuery = () => {
    setIsSqlEditorOpen(false);
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
        const hasExplicitLimit = sqlHasExplicitRowLimit(sql);

        const response = await executeCustomSql.mutateAsync({
          data_source_id: selectedTable.datasource_id,
          sql_query: sql,
          limit: hasExplicitLimit ? undefined : queryLimit,
        });
        const columns = inferQueryColumns(response.columns, response.data);
        const inferredRoleConfig = inferRoleConfigFromCustomSql({
          sql,
          chartType,
          columns,
        });
        const resolvedCustomRoleConfig = inferredRoleConfig.customRoleConfig
          ? normalizeRoleConfig(chartType, inferredRoleConfig.customRoleConfig)
          : normalizedCustomRoleConfig;
        const chartResult = buildExploreChartResult({
          rows: response.data,
          columns,
          chartType,
          roleConfig: resolvedCustomRoleConfig,
          source: 'custom',
        });

        if (inferredRoleConfig.customRoleConfig) {
          setCustomRoleConfig(resolvedCustomRoleConfig);
        }

        if (inferredRoleConfig.generatedRoleConfig) {
          const resolvedGeneratedRoleConfig = normalizeRoleConfig(
            chartType,
            inferredRoleConfig.generatedRoleConfig,
          );
          const nextGeneratedRequest = buildExploreExecuteRequest({
            chartType,
            roleConfig: resolvedGeneratedRoleConfig,
            filters,
            limit: queryLimit,
          });
          const nextGeneratedSql = buildExploreSqlPreview({
            table: selectedTable,
            chartType,
            roleConfig: resolvedGeneratedRoleConfig,
            filters,
            limit: queryLimit,
          });
          const generatedChartResult = buildExploreChartResult({
            rows: response.data,
            columns,
            chartType,
            roleConfig: resolvedGeneratedRoleConfig,
            source: 'generated',
          });

          setGeneratedRoleConfig(resolvedGeneratedRoleConfig);
          setGeneratedQueryState({
            source: 'generated',
            sql: nextGeneratedSql,
            columns,
            rows: response.data,
            chartRows: generatedChartResult.rows,
            chartPreAggregated: generatedChartResult.preAggregated,
            executionTimeMs: response.execution_time_ms,
          });
          setGeneratedLastRunSignature(buildQuerySignature({
            datasetId: selectedDatasetId,
            tableId: selectedTableId,
            limit: queryLimit,
            sqlMode: 'generated',
            request: nextGeneratedRequest,
            customSql: '',
          }));
        } else {
          setGeneratedQueryState(null);
          setGeneratedLastRunSignature('');
        }

        setCustomQueryState({
          source: 'custom',
          sql,
          columns,
          rows: response.data,
          chartRows: chartResult.rows,
          chartPreAggregated: chartResult.preAggregated,
          executionTimeMs: response.execution_time_ms,
        });
        setCustomLastRunSignature(currentQuerySignature);
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
    const exploreConfig = {
      dataset_id: selectedDatasetId,
      filters,
      chartType,
      roleConfig: generatedRoleConfig,
      styleConfig: chartStyleConfig,
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
    if (!previewColumns.length) return;
    setParamRows((rows) => rows.map((row) => {
      const column = row.column_mapping?.column;
      if (!column) return row;
      const columnMeta = previewColumns.find((item) => item.name === column);
      if (!columnMeta) return row;
      if (row.column_mapping?.type === columnMeta.type) return row;
      return {
        ...row,
        column_mapping: { column, type: columnMeta.type },
      };
    }));
  }, [previewColumns]);

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

  // JSX
  // centerContent: non-null = show this full-bleed in center; null = show the split chart+table view
  let centerContent: React.ReactNode = null;
  if (!selectedTableId) {
    centerContent = (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <Search className="w-12 h-12 text-gray-300 mx-auto mb-3" />
          <h3 className="text-base font-medium text-gray-800 mb-1">No table selected</h3>
          <p className="text-sm text-gray-400">Pick a dataset and table in the left panel</p>
        </div>
      </div>
    );
  } else if (isPreviewLoading) {
    centerContent = (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block w-7 h-7 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-3" />
          <p className="text-sm text-gray-500">Loading source schema...</p>
        </div>
      </div>
    );
  } else if (previewError) {
    centerContent = (
      <div className="h-full flex items-center justify-center text-red-600 text-sm">
        Error loading source schema
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Header - compact single-line */}
      <div className="bg-white border-b border-gray-200 px-4 py-2 shrink-0">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => router.push('/explore')}
              className="text-gray-400 hover:text-gray-700 flex items-center gap-1 text-xs shrink-0"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              All Charts
            </button>
            <span className="text-gray-200">/</span>
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
                  className="text-sm font-semibold text-gray-900 border-b border-blue-400 bg-transparent outline-none px-0.5 min-w-[10rem]"
                />
                <Check className="w-3.5 h-3.5 text-blue-500" />
              </div>
            ) : (
              <div className="flex items-center gap-1.5 group/name">
                <span className="text-sm font-semibold text-gray-900 truncate max-w-xs">
                  {chartNameInput || (chartId ? 'Chart' : 'New Chart')}
                </span>
                {resPerms.canEdit && (
                  <button onClick={() => setIsEditingName(true)}
                    className="opacity-0 group-hover/name:opacity-100 text-gray-400 hover:text-gray-600 transition-opacity">
                    <Pencil className="w-3 h-3" />
                  </button>
                )}
              </div>
            )}
            {selectedTable && (
              <span className="text-xs text-gray-400 truncate shrink-0">
                - {dataset?.name} / {(selectedTable as any).display_name || 'Table'}
              </span>
            )}
          </div>

          {/* Right actions */}
          <div className="flex items-center gap-2 shrink-0">
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
                className="text-xs text-gray-600 border-b border-blue-400 bg-transparent outline-none px-0.5 w-52"
              />
            ) : resPerms.canEdit ? (
              <div onClick={() => setIsEditingDesc(true)}
                className="group/desc flex items-center gap-1 cursor-text text-xs text-gray-400 hover:text-gray-600">
                {chartDescInput || <span className="italic">Add note...</span>}
                <Pencil className="w-3 h-3 opacity-0 group-hover/desc:opacity-100 transition-opacity" />
              </div>
            ) : chartDescInput ? (
              <span className="text-xs text-gray-400">{chartDescInput}</span>
            ) : null}
            {!isNew && chartId && (
              <button onClick={() => setIsDescModalOpen(true)}
                className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                title="AI Description">
                <Bot className="w-4 h-4" />
              </button>
            )}
            {resPerms.canEdit && (
              <button
                onClick={handleSaveLook}
                disabled={!selectedTableId}
                className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 border border-blue-600 rounded-md
                  hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                <Save className="w-3.5 h-3.5" />
                {chartId ? 'Update' : 'Save Chart'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 3-panel body */}
      <div className="flex-1 flex overflow-hidden">

        {/* LEFT PANEL: Data Source + Columns + Filters */}
        <div className="w-56 shrink-0 flex flex-col border-r border-gray-200 bg-white overflow-hidden">
          {/* Dataset / Table selector */}
          <div className="px-3 pt-3 pb-2 border-b shrink-0">
            <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">Data Source</p>
            <ExploreSourceSelector
              selectedDatasetId={selectedDatasetId}
              selectedTableId={selectedTableId}
              onDatasetChange={setSelectedDatasetId}
              onTableChange={setSelectedTableId}
            />
          </div>

          {/* Column browser - scrollable */}
          {selectedTableId ? (
            <div className="flex-1 overflow-y-auto min-h-0">
              <ExploreColumnPanel
                datasetId={selectedDatasetId}
                selectedTableId={selectedTableId}
              />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-gray-400 px-4 text-center">
              Select a dataset and table above
            </div>
          )}

          {/* Filters - pinned to bottom of left panel */}
          {selectedTableId && (
            <div className="border-t shrink-0">
              <button
                onClick={() => setIsFiltersOpen((o) => !o)}
                className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-semibold text-gray-700">Filters</span>
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
                <div className="px-3 pb-3 max-h-56 overflow-y-auto">
                  <p className="text-[10px] text-gray-400 mb-2">Applied every time chart renders</p>
                  <FilterBuilder
                    filters={filters}
                    onChange={setFilters}
                    columns={previewColumns}
                    dataRows={previewRows}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* CENTER: Visualization + Results */}
        <div className="flex-1 flex flex-col overflow-hidden bg-[#f4f5f7]">
          {/* Center toolbar */}
          {selectedTableId && !centerContent && (
            <div className="bg-white border-b border-gray-200 px-3 py-1.5 flex items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-2">
                {/* SQL mode toggle */}
                {!isSqlEditorOpen ? (
                  <button
                    onClick={handleEditSql}
                    className="px-2 py-1 text-xs font-medium text-gray-600 border border-gray-300 rounded hover:bg-gray-50 flex items-center gap-1"
                  >
                    <Code2 className="w-3 h-3" />
                    Edit SQL
                  </button>
                ) : (
                  <button
                    onClick={handleCloseSqlEditor}
                    className="px-2 py-1 text-xs font-medium text-indigo-600 border border-indigo-300 bg-indigo-50 rounded hover:bg-indigo-100 flex items-center gap-1"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Back to Chart
                  </button>
                )}
                {sqlMode === 'custom' && (
                  <button
                    onClick={handleUseGeneratedQuery}
                    className="px-2 py-1 text-xs font-medium text-gray-600 border border-gray-300 rounded hover:bg-gray-50 flex items-center gap-1"
                  >
                    <Database className="w-3 h-3" />
                    Use Generated
                  </button>
                )}
                {isQueryDirty && (
                  <span className="text-xs text-amber-600 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
                    Unsaved changes
                  </span>
                )}
                {activeQueryState && (
                  <span className="text-xs text-gray-400">
                    {activeQueryState.source === 'custom' ? 'Custom' : 'Generated'} -{' '}
                    {activeQueryState.rows.length} row{activeQueryState.rows.length === 1 ? '' : 's'}
                    {activeQueryState.executionTimeMs != null ? ` - ${activeQueryState.executionTimeMs}ms` : ''}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1 text-xs text-gray-500">
                  Limit
                  <select
                    value={queryLimit}
                    onChange={(e) => setQueryLimit(Number(e.target.value))}
                    className="px-1.5 py-0.5 border border-gray-200 rounded bg-white text-xs"
                  >
                    {[50, 100, 250, 500, 1000].map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
                <button
                  onClick={() => void handleRunQuery()}
                  disabled={isRunningQuery || isPreviewLoading}
                  className="px-3 py-1 text-xs font-medium text-white bg-blue-600 rounded hover:bg-blue-700
                    disabled:opacity-50 flex items-center gap-1.5"
                >
                  {isRunningQuery
                    ? <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    : <Play className="w-3 h-3" />}
                  {isRunningQuery ? 'Running...' : 'Run'}
                </button>
              </div>
            </div>
          )}

          {/* Center body */}
          {centerContent ?? (
            <div className="flex-1 flex flex-col overflow-hidden p-3 gap-3">
              {/* Top: SQL editor or Chart visualization */}
              <div className="flex-1 min-h-0 bg-white rounded-lg border border-gray-200 overflow-hidden flex flex-col">
                {queryError && (
                  <div className="px-3 py-1.5 border-b bg-red-50 text-xs text-red-600 shrink-0">
                    {queryError}
                  </div>
                )}

                {isSqlEditorOpen ? (
                  /* SQL editor */
                  <>
                    <div className="px-3 py-2 border-b bg-gray-50 flex items-center justify-between gap-2 shrink-0">
                      <div>
                        <p className="text-xs font-medium text-gray-700">Custom SQL</p>
                        <p className="text-xs text-gray-400">
                          Change aliases freely, then click Run to refresh the field mapping. Back to Chart keeps the custom result active until you switch back to generated.
                        </p>
                      </div>
                      <button onClick={handleResetCustomSqlDraft}
                        className="px-2 py-1 text-xs text-gray-600 border border-gray-300 rounded hover:bg-white flex items-center gap-1">
                        <RotateCcw className="w-3 h-3" /> Reset
                      </button>
                    </div>
                    <div className="flex-1 p-3 overflow-auto">
                      <textarea
                        value={customSqlDraft}
                        onChange={(e) => setCustomSqlDraft(e.target.value)}
                        spellCheck={false}
                        className="w-full h-full min-h-[12rem] rounded border border-blue-200 px-3 py-2 text-xs font-mono
                          resize-none outline-none bg-white text-gray-900 focus:ring-2 focus:ring-blue-200"
                      />
                    </div>
                  </>
                ) : !displayedQueryState ? (
                  /* Run prompt */
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-center max-w-xs px-6">
                      <Database className="w-10 h-10 text-gray-300 mx-auto mb-3" />
                      <p className="text-sm font-medium text-gray-700 mb-1">Run the query to see results</p>
                      <p className="text-xs text-gray-400 mb-4">
                        Configure chart fields on the right, then run.
                      </p>
                      <button
                        onClick={() => void handleRunQuery()}
                        disabled={isRunningQuery}
                        className="px-3 py-1.5 text-xs font-medium text-white bg-blue-600 rounded hover:bg-blue-700
                          disabled:opacity-50 inline-flex items-center gap-1.5"
                      >
                        <Play className="w-3.5 h-3.5" /> Run Query
                      </button>
                    </div>
                  </div>
                ) : chartType === 'TABLE' ? (
                  /* TABLE chart type: show grid in top area */
                  <DatasetTableGrid columns={displayedQueryState.columns} rows={displayedQueryState.rows} />
                ) : (
                  /* Chart visualization */
                  <div className="flex-1 p-4 min-h-0">
                    <ExploreChart
                      type={chartType}
                      data={displayedQueryState.chartRows}
                      roleConfig={normalizedRoleConfig}
                      styleConfig={chartStyleConfig}
                      preAggregated={displayedQueryState.chartPreAggregated}
                    />
                  </div>
                )}
              </div>

              {/* Bottom: SQL preview or Results table */}
              <div className="h-52 shrink-0 bg-white rounded-lg border border-gray-200 overflow-hidden flex flex-col">
                {sqlMode === 'generated' && !displayedQueryState ? (
                  /* SQL preview when no query run yet */
                  <>
                    <div className="px-3 py-1.5 border-b bg-gray-50 shrink-0 flex items-center justify-between">
                      <span className="text-xs font-medium text-gray-500">
                        SQL Preview{hasActiveTransforms && ' (transforms applied server-side)'}
                      </span>
                    </div>
                    <div className="flex-1 overflow-auto p-3">
                      <pre className="text-[11px] font-mono text-gray-600 whitespace-pre-wrap">{generatedSql}</pre>
                    </div>
                  </>
                ) : displayedQueryState ? (
                  /* Results table */
                  <>
                    <div className="px-3 py-1.5 border-b bg-gray-50 shrink-0 flex items-center gap-2">
                      <span className="text-xs font-medium text-gray-500">
                        Results - {displayedQueryState.rows.length} row{displayedQueryState.rows.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="flex-1 overflow-hidden">
                      <DatasetTableGrid columns={displayedQueryState.columns} rows={displayedQueryState.rows} />
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-xs text-gray-400">
                    Run the query to see results
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT PANEL: Chart Config + Metadata + Parameters */}
        {selectedTableId && (
          <div className="w-72 shrink-0 flex flex-col border-l border-gray-200 bg-white overflow-y-auto">

            {/* Chart type + field mapping + styling */}
            <ExploreChartConfig
              chartType={chartType}
              roleConfig={activeRoleConfig}
              styleConfig={chartStyleConfig}
              availableColumns={configColumns}
              onChartTypeChange={setChartType}
              onRoleConfigChange={sqlMode === 'custom' ? setCustomRoleConfig : setGeneratedRoleConfig}
              onStyleConfigChange={setChartStyleConfig}
            />

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
                <div className="px-4 pb-4 space-y-3">
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
                <div className="px-4 pb-4 space-y-2">
                  <p className="text-[10px] text-gray-400">Filters this chart accepts from a dashboard.</p>
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
                          const columnMeta = previewColumns.find((c) => c.name === column);
                          updateParamRow(row._key, 'column_mapping',
                            column ? { column, type: columnMeta?.type ?? 'string' } : null);
                        }}
                        className="w-full px-2 py-1 border border-gray-200 rounded text-xs bg-white"
                      >
                        <option value="">Column mapping (optional)</option>
                        {previewColumns.map((col) => (
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
