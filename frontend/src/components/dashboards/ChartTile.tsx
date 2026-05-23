'use client';

import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { X, Loader2, Pencil, Check, SlidersHorizontal, Eye, Palette, MoreHorizontal, ArrowRightLeft, ExternalLink, AlertTriangle, RefreshCw, TrendingUp } from 'lucide-react';
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
  isFilterValueActive,
  resolveCalendarFieldMapping,
  resolveChartFieldForFilter,
  resolveChartSemanticField,
  resolveFilterForChartData,
  getFilterDisplayLabel,
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

/** Debounce a value to avoid cascading API calls on rapid filter changes. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Defer chart fetch until the tile enters the viewport. Once visible we keep it
 * mounted so scrolling away doesn't drop the cache or refetch needlessly.
 */
function useStickyVisibility(rootMargin = '300px') {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (visible) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible, rootMargin]);
  return { ref, visible };
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (!error) return fallback;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const maybeResponse = error as { response?: { data?: { detail?: unknown; message?: unknown } }; message?: unknown };
    const detail = maybeResponse.response?.data?.detail ?? maybeResponse.response?.data?.message ?? maybeResponse.message;
    if (typeof detail === 'string' && detail.trim()) return detail;
  }
  return fallback;
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

function ChartTileBase({
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
  const { ref: visibilityRef, visible: hasBeenVisible } = useStickyVisibility();
  const { data: chart, isLoading: isLoadingChart } = useChart(chartId, { enabled: hasBeenVisible });
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
      if (!isFilterValueActive(sourceFilter)) {
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

  // Track which active global filters this chart could NOT consume. The
  // dashboard filter bar fan-outs every global filter to every tile, but
  // most charts have only a subset of fields available — silent dropping
  // here is what caused BA to report "Date filter không tác động lên 17/37
  // charts". Surface the count + names so the user knows when a filter
  // they applied is being ignored by this chart.
  const skippedGlobalFilters = useMemo(() => {
    const skipped: BaseFilter[] = [];
    for (const sourceFilter of globalFilters) {
      if (!isFilterValueActive(sourceFilter)) continue;
      let anyTargetAccepted = false;
      for (const targetFilter of expandLinkedFilterTargets(sourceFilter)) {
        const semanticRef = targetFilter.semanticField ?? targetFilter.fieldKey;
        const hasSemanticRef = Boolean(semanticRef && semanticRef.includes('.'));
        const resolvedField = hasSemanticRef && !chartSemanticBinding
          ? null
          : resolveChartFieldForFilter(targetFilter, chartSemanticBinding);
        const canDeferToSemanticJoin = hasSemanticRef
          && canDeferFilterToChartSemanticBinding(targetFilter, chartSemanticBinding);
        if (resolvedField || canDeferToSemanticJoin) {
          anyTargetAccepted = true;
          break;
        }
      }
      if (!anyTargetAccepted) skipped.push(sourceFilter);
    }
    return skipped;
  }, [globalFilters, chartSemanticBinding]);

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

  const {
    data: chartData,
    isLoading: isLoadingData,
    isFetching: isFetchingData,
    error: chartDataError,
    refetch: refetchChartData,
  } = useChartData(
    chartId,
    debouncedFilters,
    'dashboard',
    { enabled: hasBeenVisible && !isLoadingChart && Boolean(chart) },
  );

  // Title editing state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState('');
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [detailModalInitialTab, setDetailModalInitialTab] = useState<'appearance' | 'data'>('data');
  const titleInputRef = useRef<HTMLInputElement>(null);

  // Per-tile HAVING filter state (post-aggregation), persisted in dashboard layout
  const [havingFilters, setHavingFilters] = useState<BaseFilter[]>(
    () => (Array.isArray(currentLayout?.havingFilters) ? currentLayout.havingFilters : []),
  );
  const [isHavingOpen, setIsHavingOpen] = useState(false);
  const [isTileMenuOpen, setIsTileMenuOpen] = useState(false);
  const [isMovePageOpen, setIsMovePageOpen] = useState(false);
  // Phase-15.78 — per-tile Top N / Bottom N quick control. Persists into
  // styleConfigOverride.dataLimit + .dataLimitDirection so the saved
  // chart isn't mutated (other dashboards keep their own choice).
  const [isTopNOpen, setIsTopNOpen] = useState(false);
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

  const effectiveStyleConfig = useMemo(
    () => getEffectiveDashboardChartStyleConfig(chart, currentLayout),
    [chart, currentLayout],
  );
  const configuredChartTitle =
    effectiveStyleConfig.chartTitle?.trim()
    || (typeof (chart?.config as any)?.title === 'string' ? (chart?.config as any).title.trim() : '');
  const customTitle = typeof currentLayout?.custom_title === 'string'
    ? currentLayout.custom_title.trim()
    : '';
  const chartName = typeof chart?.name === 'string' ? chart.name.trim() : '';
  const displayTitle = configuredChartTitle || customTitle || chartName;
  const chartRenderStyleConfig = useMemo(() => {
    if (!effectiveStyleConfig.chartTitle) return effectiveStyleConfig;
    return { ...effectiveStyleConfig, chartTitle: '' };
  }, [effectiveStyleConfig]);

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  const startEditingTitle = (e?: React.MouseEvent) => {
    e?.stopPropagation();
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
      const currentStyleOverride = currentLayout?.styleConfigOverride;
      const styleConfigOverride = (
        currentStyleOverride
        && typeof currentStyleOverride === 'object'
        && !Array.isArray(currentStyleOverride)
      )
        ? { ...currentStyleOverride, chartTitle: newTitle }
        : { chartTitle: newTitle };
      await dashboardApi.updateLayout(dashboardId, [{
        id: dashboardChartId,
        layout: { ...currentLayout, custom_title: newTitle, styleConfigOverride },
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

  // Phase-15.78 — persist Top N / Bottom N override at the tile level
  // through styleConfigOverride. Setting limit to '' clears the override
  // so the base chart's saved dataLimit (if any) takes over.
  const saveTopN = async (limit: number | '', direction: 'top' | 'bottom') => {
    if (!canEdit) return;
    const currentStyleOverride = currentLayout?.styleConfigOverride;
    const baseOverride: Record<string, any> = (
      currentStyleOverride
      && typeof currentStyleOverride === 'object'
      && !Array.isArray(currentStyleOverride)
    )
      ? { ...currentStyleOverride }
      : {};
    if (limit === '' || limit == null) {
      delete baseOverride.dataLimit;
      delete baseOverride.dataLimitDirection;
    } else {
      baseOverride.dataLimit = limit;
      baseOverride.dataLimitDirection = direction;
    }
    const styleConfigOverride = Object.keys(baseOverride).length > 0 ? baseOverride : undefined;
    try {
      await dashboardApi.updateLayout(dashboardId, [{
        id: dashboardChartId,
        layout: { ...currentLayout, styleConfigOverride },
      }]);
      queryClient.invalidateQueries({ queryKey: ['dashboards', dashboardId] });
    } catch {
      /* layout save is best-effort */
    }
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
      styleConfig: chartRenderStyleConfig,
    };
  }, [chart?.config, chart?.chart_type, chartRenderStyleConfig]);

  // Notify parent when data is loaded â€” only expose true dimension fields to the global filter bar
  React.useEffect(() => {
    if (chartData?.data?.length && onDataLoaded) {
      // Phase-15.24: `chartData.data[0] ?? {}` guards against null rows.
      const firstRow = chartData.data[0] ?? {};
      const dimensionFields = exploreConfig
        ? getRoleConfigDimensionFields(exploreConfig.chartType, exploreConfig.roleConfig)
            .filter(field => field in firstRow)
        : Object.keys(firstRow);
      onDataLoaded(chartId, chartData.data, { dimensionFields });
    }
  }, [chartData?.data, onDataLoaded, chartId, exploreConfig]);

  const rawRows: Record<string, any>[] = chartData?.data ?? [];
  const preAggregated = chartData?.pre_aggregated ?? false;
  // Phase-15.78 — BE now reports filters it dropped before SQL (binding
  // unsupported, dataset mismatch, unreachable joined view, …). Merge
  // them into the existing "skipped" badge so the tooltip lists *both*
  // FE-side skips (resolveChartFieldForFilter rejected the filter
  // before even sending it) and BE-side drops (server saw it but had
  // no place to put it). User sees one number per tile either way.
  const droppedByBackend = chartData?.debug?.dropped_filters ?? [];


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
  const legacyRenderChartConfig = useMemo(
    () => ({ ...legacyChartConfig, title: undefined }),
    [legacyChartConfig],
  );

  const renderStatusCard = (content: React.ReactNode, tone: 'neutral' | 'danger' = 'neutral') => (
    <div className={`dashboard-tile relative h-full rounded-lg border p-6 ${tone === 'danger' ? 'border-danger/30 bg-surface-1' : 'border-[rgb(var(--border-line))] bg-surface-1'}`}>
      {onRemove && (
        <button
          type="button"
          onMouseDown={e => e.stopPropagation()}
          onClick={() => onRemove(dashboardChartId)}
          disabled={isRemoving}
          className={`absolute right-2 top-2 rounded-md border p-1.5 shadow-linear-sm disabled:cursor-not-allowed disabled:opacity-50 ${tone === 'danger' ? 'border-danger/30 bg-surface-1 text-danger hover:bg-danger/10' : 'border-[rgb(var(--border-strong))] bg-surface-1 text-danger hover:border-danger/40 hover:bg-danger/10'}`}
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

  if (!hasBeenVisible) {
    return (
      <div
        ref={visibilityRef}
        className="dashboard-tile relative h-full rounded-lg border border-[rgb(var(--border-line))] bg-surface-1"
        aria-hidden="true"
      />
    );
  }

  if (isLoadingChart) {
    return (
      <div className="dashboard-tile relative h-full rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-3 flex flex-col gap-3">
        <div className="bi-skeleton h-4 w-2/5" />
        <div className="bi-skeleton flex-1 w-full" />
        <div className="flex gap-2">
          <div className="bi-skeleton h-2.5 w-16" />
          <div className="bi-skeleton h-2.5 w-12" />
          <div className="bi-skeleton h-2.5 w-20" />
        </div>
      </div>
    );
  }

  if (!chart) {
    return renderStatusCard(
      <div className="text-center">
        <p className="text-text-tertiary">Failed to load chart</p>
      </div>,
      'danger'
    );
  }

  return (
    <div className={`dashboard-tile bi-card-hover relative group flex h-full flex-col overflow-hidden rounded-lg border bg-surface-1 p-3 ${
      isCrossFilterSource
        ? 'border-warning/40 ring-1 ring-warning'
        : 'border-[rgb(var(--border-line))]'
    }`}>
      {/* Remove button Ã¢â‚¬â€ outside drag handle so clicks always register */}
      {onRemove && (
      <button
        onMouseDown={e => e.stopPropagation()}
        onClick={() => onRemove(dashboardChartId)}
        disabled={isRemoving}
        className="absolute top-2 right-2 z-10 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 p-1.5 shadow-linear-sm opacity-0 transition-opacity group-hover:opacity-100 hover:border-danger/40 hover:bg-danger/10 disabled:opacity-50"
        title="Remove chart"
      >
        {isRemoving ? (
          <Loader2 className="h-4 w-4 text-danger animate-spin" />
        ) : (
          <X className="h-4 w-4 text-danger" />
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
              className="flex-1 text-sm font-semibold border-b border-brand/50 outline-none bg-transparent cursor-text"
            />
            {isSavingTitle && <Loader2 className="h-3.5 w-3.5 animate-spin text-brand flex-shrink-0" />}
            {!isSavingTitle && (
              <Check
                className="h-3.5 w-3.5 text-brand flex-shrink-0 cursor-pointer"
                onMouseDown={e => { e.stopPropagation(); saveTitle(); }}
              />
            )}
          </>
        ) : (
          <>
            <h3 className="text-sm font-semibold truncate flex-1">{displayTitle}</h3>
            {canEdit && (skippedGlobalFilters.length > 0 || droppedByBackend.length > 0) && (
              <span
                className="flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded"
                title={(() => {
                  const lines: string[] = [];
                  const total = skippedGlobalFilters.length + droppedByBackend.length;
                  lines.push(
                    `This chart could not apply ${total} filter${total !== 1 ? 's' : ''}:`,
                  );
                  for (const f of skippedGlobalFilters) {
                    lines.push(`• ${getFilterDisplayLabel(f)} — not in this chart's data model`);
                  }
                  for (const d of droppedByBackend) {
                    const ref = d.semantic_field || d.field || '(unknown field)';
                    const reason = d.detail || d.reason;
                    lines.push(`• ${ref} — ${reason}`);
                  }
                  return lines.join('\n');
                })()}
              >
                <AlertTriangle className="h-3 w-3" />
                {skippedGlobalFilters.length + droppedByBackend.length} skipped
              </span>
            )}
            <a
              href={`/explore/${chartId}`}
              target="_blank"
              rel="noreferrer"
              onMouseDown={e => e.stopPropagation()}
              className="flex-shrink-0 rounded-md p-1 text-text-quaternary opacity-0 transition hover:bg-surface-2 hover:text-brand focus:opacity-100 group-hover:opacity-100"
              title="Open chart in Explore in a new tab"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>

            {/* HAVING badge stays separate; it has active state and opens the inline editor. */}
            {canEdit && exploreConfig && havingOptions.length > 0 && (
              <button
                onMouseDown={e => e.stopPropagation()}
                onClick={() => setIsHavingOpen(v => !v)}
                className={`relative flex-shrink-0 transition-opacity ${
                  isHavingOpen || havingFilters.length > 0
                    ? 'opacity-100 text-brand'
                    : 'opacity-0 group-hover:opacity-100 text-text-quaternary hover:text-brand'
                }`}
                title="Per-chart filters (HAVING)"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {havingFilters.length > 0 && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 bg-brand rounded-full" />
                )}
              </button>
            )}

            {/* Phase-15.78 — Top N / Bottom N quick-control. Active state
                when an override is set; click toggles the inline editor. */}
            {canEdit && exploreConfig && (
              <button
                onMouseDown={e => e.stopPropagation()}
                onClick={() => setIsTopNOpen(v => !v)}
                className={`relative flex-shrink-0 transition-opacity ${
                  isTopNOpen || (effectiveStyleConfig.dataLimit && effectiveStyleConfig.dataLimit !== '')
                    ? 'opacity-100 text-brand'
                    : 'opacity-0 group-hover:opacity-100 text-text-quaternary hover:text-brand'
                }`}
                title="Top N / Bottom N row limit"
              >
                <TrendingUp className="h-3.5 w-3.5" />
                {effectiveStyleConfig.dataLimit && effectiveStyleConfig.dataLimit !== '' && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 bg-brand rounded-full" />
                )}
              </button>
            )}

            {/* Single overflow menu for View, Appearance, Rename, and Move to page. */}
            <div className="relative flex-shrink-0">
              <button
                onMouseDown={e => e.stopPropagation()}
                onClick={() => { setIsTileMenuOpen(v => !v); setIsMovePageOpen(false); }}
                className={`transition-opacity text-text-quaternary hover:text-brand ${
                  isTileMenuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
                title="More options"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
              {isTileMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onMouseDown={e => e.stopPropagation()}
                    onClick={() => { setIsTileMenuOpen(false); setIsMovePageOpen(false); }}
                  />
                  <div
                    className="bi-fade-in absolute right-0 z-50 mt-1.5 w-52 overflow-hidden rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 py-1.5 shadow-linear-lg"
                    onMouseDown={e => e.stopPropagation()}
                  >
                    <button
                      onClick={() => { openDetailModal('data'); setIsTileMenuOpen(false); }}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(0,0,0,0.04)] hover:text-text-primary"
                    >
                      <Eye className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                      View details
                    </button>
                    <a
                      href={`/explore/${chartId}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => setIsTileMenuOpen(false)}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(0,0,0,0.04)] hover:text-text-primary"
                    >
                      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                      Open in Explore
                    </a>
                    {allowAppearanceEdit && (
                      <button
                        onClick={() => { openDetailModal('appearance'); setIsTileMenuOpen(false); }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(0,0,0,0.04)] hover:text-text-primary"
                      >
                        <Palette className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                        Edit appearance
                      </button>
                    )}
                    {canEdit && (
                      <button
                        onClick={() => { startEditingTitle(); setIsTileMenuOpen(false); }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(0,0,0,0.04)] hover:text-text-primary"
                      >
                        <Pencil className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                        Rename title
                      </button>
                    )}
                    {canEdit && availablePages.length > 1 && onMoveToPage && (
                      <>
                        <div className="my-1 border-t border-[rgb(var(--border-line))]" />
                        <button
                          onClick={() => setIsMovePageOpen(v => !v)}
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(0,0,0,0.04)] hover:text-text-primary"
                        >
                          <ArrowRightLeft className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                          <span className="flex-1 text-left">Move to page</span>
                        </button>
                        {isMovePageOpen && (
                          <div className="bg-[rgba(0,0,0,0.02)]">
                            {availablePages.map((page) => (
                              <button
                                key={page.id}
                                onClick={() => {
                                  if (page.id !== currentPageId) onMoveToPage(page.id);
                                  setIsMovePageOpen(false);
                                  setIsTileMenuOpen(false);
                                }}
                                className={`flex w-full items-center gap-2 px-6 py-1 text-[12px] transition-colors hover:bg-[rgba(0,0,0,0.04)] ${
                                  page.id === currentPageId ? 'text-brand' : 'text-text-tertiary'
                                }`}
                              >
                                {page.id === currentPageId && <Check className="h-3 w-3" />}
                                <span className={page.id === currentPageId ? '' : 'pl-5'}>{page.name}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
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
                className="inline-flex items-center px-1.5 py-0.5 bg-brand/10 border border-brand/30 text-brand rounded text-xs font-mono"
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
              <span key={f.id} className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-brand/10 border border-brand/30 text-brand text-xs rounded">
                <span className="font-mono opacity-60 text-[0.6rem] uppercase">having</span>
                {havingOptions.find(o => o.key === f.field)?.label ?? f.field}
                {` ${f.operator} ${f.value}`}
                {canEdit && (
                <button
                  onMouseDown={e => e.stopPropagation()}
                  onClick={() => setHavingFilters(prev => prev.filter(x => x.id !== f.id))}
                  className="text-brand hover:text-brand"
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
            className="border border-brand/20 bg-brand/10/50 rounded p-2 flex flex-wrap items-center gap-1.5"
            onMouseDown={e => e.stopPropagation()}
          >
            <select
              value={draftHavingField}
              onChange={e => setDraftHavingField(e.target.value)}
              className="rounded border border-[rgb(var(--border-strong))] bg-surface-1 px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-brand"
            >
              {havingOptions.map(o => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
            <select
              value={draftHavingOp}
              onChange={e => setDraftHavingOp(e.target.value as FilterOperator)}
              className="rounded border border-[rgb(var(--border-strong))] bg-surface-1 px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-brand"
            >
              <option value="gt">&gt; greater than</option>
              <option value="gte">&gt;= greater or equal</option>
              <option value="lt">&lt; less than</option>
              <option value="lte">&lt;= less or equal</option>
              <option value="eq">= equals</option>
              <option value="neq">!= not equals</option>
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
              className="text-xs border border-[rgb(var(--border-strong))] rounded px-1.5 py-0.5 w-20 focus:outline-none focus:ring-1 focus:ring-brand"
            />
            <button
              onClick={confirmHaving}
              className="text-xs px-2 py-0.5 bg-brand text-white rounded hover:bg-brand-hover"
            >
              Apply
            </button>
            {havingFilters.length > 0 && (
              <button
                onClick={() => setHavingFilters([])}
                className="text-xs text-text-quaternary hover:text-text-secondary"
              >
                Clear all
              </button>
            )}
          </div>
        )}
        {/* Phase-15.78 — Top N / Bottom N editor panel. Sits per-tile in
            styleConfigOverride so other dashboards using the same chart
            keep their own choice. Clear restores the chart's saved default. */}
        {isTopNOpen && exploreConfig && (
          <div
            className="border border-brand/20 bg-brand/10/50 rounded p-2 flex flex-wrap items-center gap-1.5"
            onMouseDown={e => e.stopPropagation()}
          >
            <span className="text-[10px] font-mono uppercase text-text-tertiary">show</span>
            <select
              value={effectiveStyleConfig.dataLimitDirection ?? 'top'}
              onChange={e => saveTopN(effectiveStyleConfig.dataLimit ?? '', e.target.value as 'top' | 'bottom')}
              className="rounded border border-[rgb(var(--border-strong))] bg-surface-1 px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-brand"
            >
              <option value="top">Top</option>
              <option value="bottom">Bottom</option>
            </select>
            <input
              type="number"
              min={1}
              value={effectiveStyleConfig.dataLimit ?? ''}
              placeholder="N"
              onChange={e => {
                const v = e.target.value;
                saveTopN(v === '' ? '' : Number(v), effectiveStyleConfig.dataLimitDirection ?? 'top');
              }}
              onKeyDown={e => {
                if (e.key === 'Escape') setIsTopNOpen(false);
              }}
              className="text-xs border border-[rgb(var(--border-strong))] rounded px-1.5 py-0.5 w-16 focus:outline-none focus:ring-1 focus:ring-brand"
            />
            <span className="text-[10px] text-text-quaternary">rows by metric value</span>
            {effectiveStyleConfig.dataLimit && effectiveStyleConfig.dataLimit !== '' && (
              <button
                onClick={() => saveTopN('', 'top')}
                className="text-xs text-text-quaternary hover:text-text-secondary"
              >
                Clear
              </button>
            )}
          </div>
        )}
      </div>

      {/* Chart visualization. Phase-15.6: hint cursor + title attr when the
          chart is wired for cross-filter, so users discover the click-to-
          filter affordance instead of having to read docs. */}
      <div
        className={`flex-1 min-h-0 overflow-hidden ${
          onSelectCrossFilter && chartSemanticBinding?.datasetId != null
            ? 'cursor-crosshair'
            : ''
        }`}
        title={
          onSelectCrossFilter && chartSemanticBinding?.datasetId != null
            ? 'Click a data point to filter other charts in this dashboard'
            : undefined
        }
      >
        {isLoadingData ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-brand" />
          </div>
        ) : chartDataError ? (
          <div className="flex h-full items-center justify-center rounded-md border border-warning/30 bg-warning/5 p-4 text-center">
            <div className="max-w-sm">
              <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-warning" />
              <p className="text-sm font-semibold text-text-primary">Load data failed</p>
              <p className="mt-1 text-xs uppercase tracking-[0.14em] text-text-quaternary">
                {String(chart.chart_type).replace(/_/g, ' ')}
              </p>
              <p className="mt-2 line-clamp-3 text-xs text-text-tertiary">
                {getErrorMessage(chartDataError, 'Could not load data for this chart.')}
              </p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  onMouseDown={e => e.stopPropagation()}
                  onClick={() => refetchChartData()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-2"
                >
                  {isFetchingData ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  Retry
                </button>
                <button
                  type="button"
                  onMouseDown={e => e.stopPropagation()}
                  onClick={() => openDetailModal('data')}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-2"
                >
                  <Eye className="h-3.5 w-3.5" />
                  Details
                </button>
                <a
                  href={`/explore/${chartId}`}
                  target="_blank"
                  rel="noreferrer"
                  onMouseDown={e => e.stopPropagation()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-brand/30 bg-brand/10 px-2.5 py-1.5 text-xs font-medium text-brand hover:bg-brand/15"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Explore
                </a>
              </div>
            </div>
          </div>
        ) : !chartData ? (
          <div className="flex h-full items-center justify-center rounded-md border border-[rgb(var(--border-line))] bg-surface-2 p-4 text-center">
            <div>
              <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-warning" />
              <p className="text-sm font-medium text-text-primary">No chart data available</p>
              <p className="mt-1 text-xs text-text-tertiary">Open the chart details or Explore to inspect the configuration.</p>
            </div>
          </div>
        ) : exploreConfig ? (
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
            config={legacyRenderChartConfig}
            styleConfig={chartRenderStyleConfig}
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

// Phase-15.57 — memoize the tile so layout-only updates from
// react-grid-layout (drag/resize) don't trigger a full re-render of
// every tile. The comparator skips when only `currentLayout` changes
// (the grid library moves the tile via CSS transform; React doesn't
// need to re-evaluate the tile body). All other prop changes — filter
// arrays, chart id, parameters — fall through to a real re-render.
//
// Phase-15.78 — earlier the array props (filters, pages) used a
// `prev !== next && prev.length !== next.length` guard. That swallows
// the common case where the parent immutably swaps an array (new ref)
// but with the same length — e.g. user changes a filter value from
// France to Germany. The whole point of the new reference IS to signal
// "value changed", so trust it: any ref change re-renders.
function chartTilePropsEqual(prev: ChartTileProps, next: ChartTileProps): boolean {
  if (prev.chartId !== next.chartId) return false;
  if (prev.dashboardChartId !== next.dashboardChartId) return false;
  if (prev.dashboardId !== next.dashboardId) return false;
  if (prev.canEdit !== next.canEdit) return false;
  if (prev.allowAppearanceEdit !== next.allowAppearanceEdit) return false;
  if (prev.isRemoving !== next.isRemoving) return false;
  if (prev.isCrossFilterSource !== next.isCrossFilterSource) return false;
  if (prev.currentPageId !== next.currentPageId) return false;
  // Layout reference change is fine — we render the same DOM either way;
  // the parent grid moves the wrapper via CSS transform. Skip deep
  // compare to keep this hot path cheap.
  if (prev.onRemove !== next.onRemove) return false;
  if (prev.onDataLoaded !== next.onDataLoaded) return false;
  if (prev.onSelectCrossFilter !== next.onSelectCrossFilter) return false;
  if (prev.onMoveToPage !== next.onMoveToPage) return false;
  // Trust reference identity for arrays & dicts. Parent owns immutability
  // (slicer Apply path always swaps the array), so a new ref means a real
  // value change and the tile must re-render.
  if (prev.dashboardFilters !== next.dashboardFilters) return false;
  if (prev.globalFilters !== next.globalFilters) return false;
  if (prev.crossFilters !== next.crossFilters) return false;
  if (prev.availablePages !== next.availablePages) return false;
  if (prev.instanceParameters !== next.instanceParameters) return false;
  return true;
}

export const ChartTile = React.memo(ChartTileBase, chartTilePropsEqual);
