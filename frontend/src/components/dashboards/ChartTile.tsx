'use client';

import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { X, Loader2, Pencil, Check, SlidersHorizontal, Eye, Palette } from 'lucide-react';
import { useChart, useChartData } from '@/hooks/use-charts';
import { ChartPreview } from '@/components/charts/ChartPreview';
import { ExploreChart } from '@/components/explore/ExploreChart';
import { applyFilters } from '@/lib/explore-utils';
import {
  getRoleConfigDimensionFields,
  metricKey,
  metricLabel,
  normalizeRoleConfig,
} from '@/components/explore/ExploreChartConfig';
import { getActiveChartRoleConfig } from '@/lib/chart-config';
import { getEffectiveDashboardChartStyleConfig } from '@/lib/dashboard-chart-style';
import {
  DashboardFilter,
  applyFiltersToRows,
  canDeferFilterToChartSemanticBinding,
  inferColumnTypeFromData,
  resolveCalendarFieldMapping,
  resolveChartFieldForFilter,
  resolveChartSemanticField,
  resolveFilterForChartData,
} from '@/lib/filters';
import type { BaseFilter, FilterOperator } from '@/lib/filters';
import { dashboardApi } from '@/lib/api/dashboards';
import { useQueryClient } from '@tanstack/react-query';
import type { ChartSemanticBinding, DashboardPageConfig } from '@/types/api';
import { ChartDetailModal } from './ChartDetailModal';

interface ChartTileProps {
  chartId: number;
  dashboardChartId: number;
  dashboardId: number;
  currentLayout: Record<string, any>;
  canEdit?: boolean;
  allowAppearanceEdit?: boolean;
  onRemove?: (dashboardChartId: number) => void;
  isRemoving?: boolean;
  dashboardFilters?: DashboardFilter[];
  globalFilters?: BaseFilter[];
  crossFilters?: BaseFilter[];
  onDataLoaded?: (chartId: number, data: any[], meta: { dimensionFields: string[] }) => void;
  onSelectCrossFilter?: (filter: BaseFilter | null) => void;
  isCrossFilterSource?: boolean;
  instanceParameters?: Record<string, any>;
  availablePages?: DashboardPageConfig[];
  currentPageId?: string | null;
  onMoveToPage?: (pageId: string) => void;
}

/** Debounce a value — avoids cascading API calls on rapid filter changes. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

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

function expandLinkedFilterTargets(filter: BaseFilter): BaseFilter[] {
  const primaryTarget = filter.fieldKey ?? filter.semanticField ?? filter.field;
  const refs = [primaryTarget, ...(filter.linkedFields ?? [])]
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);

  const targets: BaseFilter[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);

    const isSemanticRef = ref.includes('.');
    targets.push({
      ...filter,
      field: isSemanticRef ? ref.split('.').pop() ?? filter.field : ref,
      fieldKey: ref,
      semanticField: isSemanticRef ? ref : undefined,
      linkedFields: undefined,
    });
  }

  return targets.length > 0 ? targets : [{ ...filter, linkedFields: undefined }];
}

export function ChartTile({
  chartId,
  dashboardChartId,
  dashboardId,
  currentLayout,
  canEdit = false,
  allowAppearanceEdit = false,
  onRemove,
  isRemoving,
  dashboardFilters = [],
  globalFilters = [],
  crossFilters = [],
  onDataLoaded,
  onSelectCrossFilter,
  isCrossFilterSource = false,
  instanceParameters,
  availablePages = [],
  currentPageId = null,
  onMoveToPage,
}: ChartTileProps) {
  const queryClient = useQueryClient();
  const { data: chart, isLoading: isLoadingChart } = useChart(chartId);
  const chartSemanticBinding = useMemo(() => {
    const config = chart?.config as any;
    return (config?.semanticBinding && typeof config.semanticBinding === 'object')
      ? config.semanticBinding as ChartSemanticBinding
      : null;
  }, [chart?.config]);

  const parameterFilters = useMemo(() => {
    if (!chart?.parameters?.length || !instanceParameters) return [];

    const filters: Record<string, unknown>[] = [];
    for (const param of chart.parameters) {
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
          .map(part => part.trim())
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
          .map(part => String(part).trim())
          .filter(Boolean)
          .map(part => coerceParameterAtom(part, mappingType));
        if (values.length > 0) {
          filters.push({ field: mappedColumn, operator: 'in', value: values });
          continue;
        }
      }

      filters.push({ field: mappedColumn, operator: 'eq', value: coerceParameterAtom(rawValue, mappingType) });
    }

    return filters;
  }, [chart?.parameters, instanceParameters]);

  // Build server-side filters from dashboard + global filters for server-side push-down
  const serverFilters = useMemo(() => {
    const filters: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    filters.push(...parameterFilters);

    const appendServerFilters = (sourceFilter: BaseFilter) => {
      if (sourceFilter.value === undefined || sourceFilter.value === null || sourceFilter.value === '') {
        return;
      }

      for (const targetFilter of expandLinkedFilterTargets(sourceFilter)) {
        const semanticRef = targetFilter.semanticField ?? targetFilter.fieldKey;
        const hasSemanticRef = Boolean(semanticRef && semanticRef.includes('.'));
        const resolvedField = hasSemanticRef && !chartSemanticBinding
          ? null
          : resolveChartFieldForFilter(targetFilter, chartSemanticBinding);
        const canDeferToSemanticJoin = hasSemanticRef
          && canDeferFilterToChartSemanticBinding(targetFilter, chartSemanticBinding);
        if (!resolvedField && !canDeferToSemanticJoin) continue;

        const field = resolvedField ?? targetFilter.field;
        const calendarMapping = resolveCalendarFieldMapping(chartSemanticBinding, semanticRef);
        const dedupeKey = JSON.stringify([
          field,
          targetFilter.operator,
          targetFilter.value,
          targetFilter.semanticField ?? null,
          targetFilter.datasetId ?? null,
          calendarMapping?.sourceField ?? null,
        ]);
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        filters.push({
          field,
          operator: targetFilter.operator,
          value: targetFilter.value,
          semanticField: targetFilter.semanticField,
          datasetId: targetFilter.datasetId,
          ...(calendarMapping ? {
            calendarField: calendarMapping.calendarField,
            calendarSourceField: calendarMapping.sourceField,
          } : {}),
        });
      }
    };

    [...globalFilters, ...crossFilters].forEach(appendServerFilters);
    dashboardFilters.forEach(appendServerFilters);

    return filters.length > 0 ? filters : undefined;
  }, [globalFilters, crossFilters, dashboardFilters, parameterFilters, chartSemanticBinding]);

  // Debounce server filters to avoid cascading API calls on rapid cross-filter / dashboard filter changes
  const serverFilterKey = useMemo(
    () => (serverFilters ? JSON.stringify(serverFilters) : null),
    [serverFilters],
  );
  const debouncedFilterKey = useDebouncedValue(serverFilterKey, 300);
  const debouncedFilters = useMemo(
    () => (debouncedFilterKey ? JSON.parse(debouncedFilterKey) as Record<string, unknown>[] : undefined),
    [debouncedFilterKey],
  );

  const { data: chartData, isLoading: isLoadingData } = useChartData(
    chartId,
    debouncedFilters,
    'dashboard',
    { enabled: !isLoadingChart && Boolean(chart) },
  );

  // Title editing state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState('');
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [detailModalInitialTab, setDetailModalInitialTab] = useState<'appearance' | 'data'>('data');
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Per-tile HAVING filter state (post-aggregation) — persisted in dashboard layout
  const [havingFilters, setHavingFilters] = useState<BaseFilter[]>(
    () => (Array.isArray(currentLayout?.havingFilters) ? currentLayout.havingFilters : []),
  );
  const [isHavingOpen, setIsHavingOpen] = useState(false);
  const [draftHavingField, setDraftHavingField] = useState('');
  const [draftHavingOp, setDraftHavingOp] = useState<FilterOperator>('gt');
  const [draftHavingValue, setDraftHavingValue] = useState('');

  // Persist HAVING filters into dashboard layout so they survive navigation
  const havingFiltersKey = useMemo(() => JSON.stringify(havingFilters), [havingFilters]);
  const initialHavingRef = useRef(havingFiltersKey);
  useEffect(() => {
    // Skip the initial mount — only persist when user actually changes filters
    if (!canEdit || havingFiltersKey === initialHavingRef.current) return;
    initialHavingRef.current = havingFiltersKey;
    dashboardApi.updateLayout(dashboardId, [{
      id: dashboardChartId,
      layout: { ...currentLayout, havingFilters },
    }]).then(() => {
      queryClient.invalidateQueries({ queryKey: ['dashboards', dashboardId] });
    }).catch(() => { /* layout save is best-effort */ });
  }, [havingFiltersKey, dashboardId, dashboardChartId, currentLayout, havingFilters, queryClient]);

  const customTitle: string | undefined = currentLayout?.custom_title;
  const displayTitle = customTitle ?? chart?.name ?? '';
  const effectiveStyleConfig = useMemo(
    () => getEffectiveDashboardChartStyleConfig(chart, currentLayout),
    [chart, currentLayout],
  );

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
    if (!canEdit || !newTitle || newTitle === displayTitle) {
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

  const openDetailModal = (tab: 'appearance' | 'data') => {
    setDetailModalInitialTab(tab);
    setIsDetailModalOpen(true);
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') saveTitle();
    if (e.key === 'Escape') setIsEditingTitle(false);
  };

  // Detect whether this is an Explore-format chart using the active mode config.
  const exploreConfig = useMemo(() => {
    const config = chart?.config as any;
    const activeRoleConfig = getActiveChartRoleConfig(config);
    if (!activeRoleConfig) return null;
    const chartType = (config.chartType as string) || String(chart?.chart_type ?? '');
    const rc = normalizeRoleConfig(chartType, activeRoleConfig);
    return {
      chartType,
      roleConfig: rc,
      filters: config.baseFilters ?? config.filters ?? [],
      styleConfig: effectiveStyleConfig,
    };
  }, [chart?.config, chart?.chart_type, effectiveStyleConfig]);

  // Notify parent when data is loaded â€” only expose true dimension fields to the global filter bar
  React.useEffect(() => {
    if (chartData?.data?.length && onDataLoaded) {
      const dimensionFields = exploreConfig
        ? getRoleConfigDimensionFields(exploreConfig.chartType, exploreConfig.roleConfig)
            .filter(field => field in chartData.data[0])
        : Object.keys(chartData.data[0]);
      onDataLoaded(chartId, chartData.data, { dimensionFields });
    }
  }, [chartData?.data, onDataLoaded, chartId, exploreConfig]);

  const rawRows: Record<string, any>[] = chartData?.data ?? [];
  const preAggregated = chartData?.pre_aggregated ?? false;


  // Apply Explore-style filters (from stored config) then dashboard filters client-side
  // When pre_aggregated, backend already applied all filters in SQL Ã¢â‚¬â€ skip client-side
  const filteredData = useMemo(() => {
    if (rawRows.length === 0) return rawRows;
    if (preAggregated) return rawRows;

    const resolveClientFilters = (sourceFilters: BaseFilter[]) => {
      if (sourceFilters.length === 0 || rows.length === 0) return [] as BaseFilter[];
      const availableFields = Object.keys(rows[0] ?? {});
      const applicable = new Map<string, BaseFilter>();

      sourceFilters.forEach((filter) => {
        expandLinkedFilterTargets(filter).forEach((targetFilter) => {
          const resolved = resolveFilterForChartData(targetFilter, {
            binding: chartSemanticBinding,
            availableFields,
          });
          if (!resolved) return;

          const key = JSON.stringify([resolved.field, resolved.operator, resolved.value]);
          if (!applicable.has(key)) {
            applicable.set(key, resolved);
          }
        });
      });

      return Array.from(applicable.values());
    };

    // Non-pre-aggregated fallback: apply filters client-side
    let rows = exploreConfig?.filters?.length
      ? applyFilters(rawRows, exploreConfig.filters)
      : rawRows;
    if (!exploreConfig && dashboardFilters.length > 0) {
      const applicableDashboardFilters = resolveClientFilters(dashboardFilters);
      if (applicableDashboardFilters.length > 0) {
        rows = applyFiltersToRows(rows, applicableDashboardFilters);
      }
    }
    const runtimeFilters = [...globalFilters, ...crossFilters];
    if (runtimeFilters.length > 0 && rows.length > 0) {
      const applicable = resolveClientFilters(runtimeFilters);
      if (applicable.length > 0) {
        rows = applyFiltersToRows(rows, applicable);
      }
    }
    return rows;
  }, [rawRows, exploreConfig, dashboardFilters, globalFilters, crossFilters, preAggregated, chartSemanticBinding]);

  const handleCrossFilterSelection = React.useCallback((selection: { field: string; value: unknown } | null) => {
    if (!onSelectCrossFilter) return;
    if (!selection || selection.value === undefined || selection.value === null || selection.value === '') {
      onSelectCrossFilter(null);
      return;
    }

    const semanticField = resolveChartSemanticField(chartSemanticBinding, selection.field);
    if (!semanticField || chartSemanticBinding?.datasetId == null) {
      onSelectCrossFilter(null);
      return;
    }

    const sampleRows = filteredData.length > 0 ? filteredData : rawRows;
    const inferredType = inferColumnTypeFromData(selection.field, sampleRows);
    const filterType = inferredType === 'date'
      ? 'date'
      : inferredType === 'number'
        ? 'number'
        : 'text';
    const value = filterType === 'number'
      ? Number(selection.value)
      : String(selection.value);

    if ((filterType === 'number' && Number.isNaN(value)) || value === '') {
      onSelectCrossFilter(null);
      return;
    }

    onSelectCrossFilter({
      id: `cross-${chartId}-${selection.field}-${String(value)}`,
      field: selection.field,
      fieldKey: semanticField,
      semanticField,
      datasetId: chartSemanticBinding.datasetId,
      type: filterType,
      operator: 'eq',
      value,
      label: selection.field,
    });
  }, [onSelectCrossFilter, chartSemanticBinding, filteredData, rawRows, chartId]);

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

  const renderStatusCard = (content: React.ReactNode, tone: 'neutral' | 'danger' = 'neutral') => (
    <div className={`relative h-full rounded-lg border p-6 ${tone === 'danger' ? 'border-red-200 bg-white' : 'border-gray-200 bg-white'}`}>
      {onRemove && (
        <button
          type="button"
          onMouseDown={e => e.stopPropagation()}
          onClick={() => onRemove(dashboardChartId)}
          disabled={isRemoving}
          className={`absolute right-2 top-2 rounded-md border p-1.5 shadow-sm disabled:cursor-not-allowed disabled:opacity-50 ${tone === 'danger' ? 'border-red-200 bg-white text-red-600 hover:bg-red-50' : 'border-gray-300 bg-white text-red-600 hover:border-red-300 hover:bg-red-50'}`}
          title="Remove chart"
        >
          {isRemoving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <X className="h-4 w-4" />
          )}
        </button>
      )}
      <div className="flex h-full items-center justify-center">
        {content}
      </div>
    </div>
  );

  if (isLoadingChart || isLoadingData) {
    return renderStatusCard(
      <div className="flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (!chart || !chartData) {
    return renderStatusCard(
      <div className="text-center">
        <p className="text-gray-500">Failed to load chart</p>
      </div>,
      'danger'
    );
  }

  return (
    <div className={`h-full bg-white rounded-lg border p-3 overflow-hidden relative group flex flex-col ${
      isCrossFilterSource
        ? 'border-amber-300 ring-1 ring-amber-200'
        : 'border-gray-200'
    }`}>
      {/* Remove button Ã¢â‚¬â€ outside drag handle so clicks always register */}
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
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={() => openDetailModal('data')}
              className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 text-gray-400 hover:text-blue-600"
              title="View chart details"
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
            {allowAppearanceEdit && (
              <button
                onMouseDown={e => e.stopPropagation()}
                onClick={() => openDetailModal('appearance')}
                className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 text-gray-400 hover:text-blue-600"
                title="Edit chart appearance"
              >
                <Palette className="h-3.5 w-3.5" />
              </button>
            )}
            {canEdit && availablePages.length > 1 && onMoveToPage && (
              <select
                value={currentPageId ?? ''}
                onMouseDown={e => e.stopPropagation()}
                onChange={e => onMoveToPage(e.target.value)}
                className="max-w-28 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] text-gray-500 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                title="Move chart to page"
              >
                {availablePages.map((page) => (
                  <option key={page.id} value={page.id}>
                    {page.name}
                  </option>
                ))}
              </select>
            )}
            {canEdit && exploreConfig && havingOptions.length > 0 && (
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
            {canEdit && (
            <button
              onMouseDown={e => e.stopPropagation()}
              onClick={startEditingTitle}
              className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 text-gray-400 hover:text-blue-600"
              title="Edit title"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            )}
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
                {canEdit && (
                <button
                  onMouseDown={e => e.stopPropagation()}
                  onClick={() => setHavingFilters(prev => prev.filter(x => x.id !== f.id))}
                  className="text-indigo-400 hover:text-indigo-700"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
                )}
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
              <option value="gte">Ã¢â€°Â¥ greater or equal</option>
              <option value="lt">&lt; less than</option>
              <option value="lte">Ã¢â€°Â¤ less or equal</option>
              <option value="eq">= equals</option>
              <option value="neq">Ã¢â€°Â  not equals</option>
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
            onSelectDataPoint={onSelectCrossFilter && chartSemanticBinding?.datasetId != null
              ? handleCrossFilterSelection
              : undefined}
          />
        ) : (
          <ChartPreview
            chartType={chart.chart_type}
            data={filteredData}
            config={legacyChartConfig}
            styleConfig={effectiveStyleConfig}
            onSelectDataPoint={onSelectCrossFilter && chartSemanticBinding?.datasetId != null
              ? handleCrossFilterSelection
              : undefined}
          />
        )}
      </div>

      <ChartDetailModal
        chartId={chartId}
        isOpen={isDetailModalOpen}
        onClose={() => setIsDetailModalOpen(false)}
        title={displayTitle}
        instanceParameters={instanceParameters}
        dashboardId={dashboardId}
        dashboardChartId={dashboardChartId}
        currentLayout={currentLayout}
        allowAppearanceEdit={allowAppearanceEdit}
        initialTab={detailModalInitialTab}
      />
    </div>
  );
}

