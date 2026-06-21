'use client';

import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { X, Loader2, Pencil, Check, SlidersHorizontal, Eye, Palette, MoreHorizontal, ArrowRightLeft, ExternalLink, AlertTriangle, RefreshCw, Sparkles } from 'lucide-react';
import { useChart, useChartData } from '@/hooks/use-charts';
import { useDatasetModel } from '@/hooks/use-dataset-model';
import { buildSemanticLabelMap, buildSemanticFormatMap } from '@/lib/chart-semantic-maps';
import { ChartPreview } from '@/components/charts/ChartPreview';
import { ExploreChart } from '@/components/explore/ExploreChart';
import { useDashboardChartTheme } from '@/components/dashboards/DashboardThemeProvider';
import { applyFilters } from '@/lib/explore-utils';
import {
  getRoleConfigDimensionFields,
  metricKey,
  metricLabel,
  normalizeRoleConfig,
} from '@/components/explore/ExploreChartConfig';
import { getActiveChartRoleConfig } from '@/lib/chart-config';
import { getEffectiveDashboardChartStyleConfig } from '@/lib/dashboard-chart-style';
import { useExportMode } from '@/lib/export-mode';
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
import { useI18n } from '@/providers/LanguageProvider';
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
  /** Cross-highlight (PBI-parity). The active selection's P filter, resolved
   *  at the page level. When set AND interactions mode = highlight, this tile
   *  computes a highlighted overlay (source: locally; target: a parallel
   *  P-filtered query) and renders it dim+solid WITHOUT narrowing baseline. */
  highlightFilter?: BaseFilter | null;
  isHighlightSource?: boolean;
  instanceParameters?: Record<string, any>;
  availablePages?: DashboardPageConfig[];
  currentPageId?: string | null;
  onMoveToPage?: (pageId: string) => void;
  /** Phase-15.81 v6 — tile focus is a Canvas/Grid highlight signal only
   *  (the FilterPane "Filters on this visual" scope was removed). Kept
   *  so Canvas can outline the most-recently-clicked tile during layout
   *  edits. onFocus fires on tile body click. */
  isFocused?: boolean;
  onFocus?: (dashboardChartId: number) => void;
  /** Phase-B17 — a collaborator currently editing this tile (GG-Sheets cursor). */
  editingBy?: { name: string; color: string } | null;
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
 * Track a tile's viewport relationship for two distinct purposes:
 *  - `visible` (STICKY): true once the tile has ever entered the viewport, and
 *    stays true. Drives mount/render so scrolling away never drops the cached
 *    chart + its last data (we keep showing real numbers).
 *  - `current` (LIVE): true only while the tile is in/near the viewport right
 *    now. Drives the *active data fetch* — so a filter change re-runs queries
 *    ONLY for the tiles you're actually looking at; off-screen tiles defer
 *    their refetch until you scroll back to them (instead of all 32 charts
 *    hammering BigQuery at once on every filter apply).
 */
function useStickyVisibility(rootMargin = '300px') {
  const [visible, setVisible] = useState(false);
  const [current, setCurrent] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  // Callback ref so we re-attach the observer whenever the host node changes.
  // The tile renders different roots across its lifecycle (off-screen
  // placeholder → skeleton → real chart card); a plain useRef+useEffect would
  // keep observing the FIRST node (the placeholder) after it unmounts, leaving
  // `current` frozen at true and defeating the off-screen deferral. Observing
  // whatever node is currently mounted keeps `current` honest as you scroll.
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      setCurrent(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const isVisible = entries.some((entry) => entry.isIntersecting);
        setCurrent(isVisible);
        if (isVisible) setVisible(true);
      },
      { rootMargin },
    );
    observer.observe(node);
    observerRef.current = observer;
  }, [rootMargin]);
  useEffect(() => () => observerRef.current?.disconnect(), []);
  return { ref, visible, current };
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (!error) return fallback;
  if (typeof error === 'string') return error;
  // Prefer the BACKEND-provided detail. An axios error is an `Error` whose
  // `.message` is the useless generic "Request failed with status code 400";
  // the real semantic explanation (missing relationship, grain-validator
  // rejection, removed column, BigQuery cost guard…) lives in
  // `response.data.detail`. Checking `error.message` first — as this used to —
  // masked every BE 400/500 message behind the generic axios string, so a DA
  // saw "Request failed" instead of "Bảng X chưa có relationship…".
  if (typeof error === 'object' && error !== null) {
    const maybeResponse = error as { response?: { data?: { detail?: unknown; message?: unknown } }; message?: unknown };
    const detail = maybeResponse.response?.data?.detail ?? maybeResponse.response?.data?.message;
    if (typeof detail === 'string' && detail.trim()) return detail;
  }
  if (error instanceof Error && error.message) return error.message;
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
  highlightFilter = null,
  isHighlightSource = false,
  instanceParameters,
  availablePages = [],
  currentPageId = null,
  onMoveToPage,
  isFocused = false,
  onFocus,
  editingBy = null,
}: ChartTileProps) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  // During PDF export, force the tile "visible" so it fetches + renders even
  // when off-screen (the exporter never scrolls). Without this, ChartTile's own
  // IntersectionObserver gate keeps below-fold tiles at a blank placeholder and
  // they capture empty. (LazyChartSlot's force-visible only covers the wrapper.)
  const exportingPdf = useExportMode();
  const { ref: visibilityRef, visible: stickyVisible, current: currentlyVisible } = useStickyVisibility();
  const hasBeenVisible = stickyVisible || exportingPdf;
  // Gate the active data fetch on CURRENT viewport presence (PDF export forces
  // it on). A filter change refetches only what you're looking at; off-screen
  // tiles wait until scrolled into view. They keep showing their prior data
  // (keepPrevious) so deferral is invisible until you reach them.
  const isActiveViewport = currentlyVisible || exportingPdf;
  const { data: chart, isLoading: isLoadingChart } = useChart(chartId, { enabled: hasBeenVisible });
  const chartSemanticBinding = useMemo(() => {
    const config = chart?.config as any;
    return (config?.semanticBinding && typeof config.semanticBinding === 'object')
      ? config.semanticBinding as ChartSemanticBinding
      : null;
  }, [chart?.config]);

  // Pull the dataset's semantic model so the tile labels + number-formats the
  // chart IDENTICALLY to the Explore editor. Without these maps the KPI/percent
  // format (and friendly labels) were dropped on the dashboard — the same chart
  // showed e.g. "36.2%" in Explore but "0.4" here. react-query dedupes the
  // fetch across tiles on the same dataset.
  const tileDatasetId = chartSemanticBinding?.datasetId
    ?? ((chart?.config as any)?.dataset_id ?? null);
  const { data: tileDatasetModel } = useDatasetModel(
    typeof tileDatasetId === 'number' ? tileDatasetId : null,
  );
  const tileLabelMap = useMemo(
    () => buildSemanticLabelMap(tileDatasetModel?.views),
    [tileDatasetModel],
  );
  const tileFormatMap = useMemo(
    () => buildSemanticFormatMap(tileDatasetModel?.views),
    [tileDatasetModel],
  );

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

  // Phase-15.81 v6 — "Filters on this visual" was removed from the
  // FilterPane UI (per-visual filtering moved into each chart's own
  // editor). Runtime stops honoring `layout.tileFilters` so legacy tile
  // configs don't keep silently AND-ing extra predicates that the user
  // can no longer see or edit. Saved tile layouts may still carry the
  // field; one warn per tile mount keeps it visible during cleanup.
  useEffect(() => {
    if (Array.isArray(currentLayout?.tileFilters) && currentLayout.tileFilters.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        '[ChartTile] Ignoring legacy layout.tileFilters on dashboardChartId=',
        dashboardChartId,
        '— per-visual scope was removed. Save the tile to drop the dead field.',
      );
    }
    // Intentionally fire once per dashboardChartId, not per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardChartId]);

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

  // Cross-highlight: resolve the active selection's P filter into the server
  // shape FOR THIS CHART (same resolution the baseline serverFilters uses).
  // Returns [] when this chart can't bind P (no field / no join path) — the
  // caller treats that as "not affected" and renders the tile unchanged.
  const highlightServerEntries = useMemo(() => {
    if (!highlightFilter || !isFilterValueActive(highlightFilter)) return [] as Record<string, unknown>[];
    const out: Record<string, unknown>[] = [];
    for (const targetFilter of expandLinkedFilterTargets(highlightFilter)) {
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
      out.push({
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
    return out;
  }, [highlightFilter, chartSemanticBinding]);

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

  // #2 — viewer date-hierarchy: the end-user's drill grain (BE re-query).
  // undefined ⇒ the chart's saved grain.
  const [viewerGrain, setViewerGrain] = useState<string | undefined>(undefined);
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
    { enabled: isActiveViewport && !isLoadingChart && Boolean(chart), keepPrevious: true },
    viewerGrain,
  );

  // Cross-highlight overlay query (target tiles only): the SAME chart, the
  // SAME baseline filters, PLUS the active selection P. Returns the
  // P-contribution per category WITHOUT touching the baseline query above, so
  // the existing filter pipeline runs byte-identically. Source tiles derive
  // their highlight locally (no extra request) and skip this.
  const overlayFilters = useMemo(() => {
    if (!highlightFilter || isHighlightSource) return undefined;
    if (highlightServerEntries.length === 0) return undefined;
    return [...(debouncedFilters ?? []), ...highlightServerEntries];
  }, [highlightFilter, isHighlightSource, highlightServerEntries, debouncedFilters]);
  const overlayFilterKey = useMemo(
    () => (overlayFilters ? JSON.stringify(overlayFilters) : null),
    [overlayFilters],
  );
  const debouncedOverlayKey = useDebouncedValue(overlayFilterKey, 300);
  const debouncedOverlayFilters = useMemo(
    () => (debouncedOverlayKey ? JSON.parse(debouncedOverlayKey) as Record<string, unknown>[] : undefined),
    [debouncedOverlayKey],
  );
  const { data: overlayChartData } = useChartData(
    chartId,
    debouncedOverlayFilters,
    'dashboard',
    { enabled: isActiveViewport && !isLoadingChart && Boolean(chart) && Boolean(debouncedOverlayFilters) },
    viewerGrain,
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
  // Phase-B21 — the ⋯ menu overflows the tile, but each react-grid-layout item
  // has its own stacking context (transform), so a LATER sibling tile paints
  // OVER the menu (the recurring "UI layout clipping"). While the menu is open
  // we lift THIS tile's grid-item z-index above its siblings so the menu shows
  // in front. Reset on close. Direct DOM (the grid-item div is owned by RGL).
  const tileMenuAnchorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const gridItem = tileMenuAnchorRef.current?.closest('.react-grid-item') as HTMLElement | null;
    if (!gridItem) return;
    if (isTileMenuOpen || isMovePageOpen) {
      gridItem.style.zIndex = '30';
    } else {
      gridItem.style.zIndex = '';
    }
    return () => { if (gridItem) gridItem.style.zIndex = ''; };
  }, [isTileMenuOpen, isMovePageOpen]);
  // Phase-B13 — the per-tile Top/Bottom-N quick control was REMOVED from the
  // dashboard tile: letting a viewer change row count on the dashboard added
  // little analytical value, conflicted with the chart's saved config, and was
  // unstable. Top/Bottom-N is now configured ONLY in Explore (the chart still
  // respects its saved dataLimit when rendering here).
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

  // Per-chart cross-highlight opt-out (default ON, Power BI parity). Persisted
  // in the tile layout; DashboardGrid/Canvas gate BOTH the click-source and the
  // highlight-target on this flag, so turning it off makes the chart fully
  // inert to highlighting (not clickable, doesn't dim when others are clicked).
  //
  // Optimistic flip: the old handler only persisted (updateLayout → invalidate
  // → full dashboard refetch) and read the flag back from currentLayout, so the
  // switch visually changed only AFTER the round-trip (the "click then wait a
  // few seconds" delay DA reported). hlOverride flips the UI instantly; the
  // effect drops it once the server value catches up so external changes still
  // win.
  const [hlOverride, setHlOverride] = useState<boolean | null>(null);
  useEffect(() => { setHlOverride(null); }, [currentLayout?.highlightEnabled]);
  const highlightEnabled = hlOverride ?? (currentLayout?.highlightEnabled !== false);
  const toggleHighlightEnabled = useCallback(() => {
    if (!canEdit) return;
    const next = !highlightEnabled;
    setHlOverride(next); // instant visual — no wait for the persist round-trip
    dashboardApi.updateLayout(dashboardId, [{
      id: dashboardChartId,
      layout: { ...currentLayout, highlightEnabled: next },
    }]).then(() => {
      queryClient.invalidateQueries({ queryKey: ['dashboards', dashboardId] });
    }).catch(() => { /* layout save is best-effort */ });
  }, [canEdit, dashboardId, dashboardChartId, currentLayout, highlightEnabled, queryClient]);

  const effectiveStyleConfig = useMemo(
    () => getEffectiveDashboardChartStyleConfig(chart, currentLayout),
    [chart, currentLayout],
  );
  const customTitle = typeof currentLayout?.custom_title === 'string'
    ? currentLayout.custom_title.trim()
    : '';
  const configuredChartTitle =
    effectiveStyleConfig.chartTitle?.trim()
    || (typeof (chart?.config as any)?.title === 'string' ? (chart?.config as any).title.trim() : '');
  const chartName = typeof chart?.name === 'string' ? chart.name.trim() : '';
  // Phase-B11 (revised) — PRIORITY: a per-tile custom title the DA set on the
  // dashboard wins; otherwise fall back to the chart's Explore title/name. (The
  // earlier draft dropped the Explore-name fallback entirely — wrong; the DA
  // wants the chart name shown when they haven't set a custom one.)
  const displayTitle = customTitle || configuredChartTitle || chartName;
  // Phase-B15 — dashboard theme title font/color (empty {} standalone).
  const dashTheme = useDashboardChartTheme();
  const themeTitleStyle: React.CSSProperties | undefined =
    dashTheme.titleFontSize || dashTheme.titleColor
      ? { fontSize: dashTheme.titleFontSize, color: dashTheme.titleColor }
      : undefined;
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

  // KPI-header — KPI cards usually carry no separate tile title; the metric
  // label IS the title. Surface it in the header row (level with the toolbar)
  // instead of leaving that row empty + the label floating mid-card. The card
  // then hides its own label (kpiLabelInHeader) and focuses on the value.
  // Explicit custom/config titles still win. NOTE: this block reads
  // `exploreConfig`, so it MUST sit after that useMemo — declaring it earlier
  // is a TDZ ("used before declaration") that fails the production build.
  const isKpiCard = String(chart?.chart_type || '').toUpperCase() === 'KPI';
  const kpiMetricLabel = isKpiCard && exploreConfig
    ? (exploreConfig.styleConfig?.kpiLabel?.trim()
       || (exploreConfig.roleConfig?.metrics?.[0]
            ? metricLabel(exploreConfig.roleConfig.metrics[0], tileLabelMap)
            : ''))
    : '';
  const kpiHeaderTitle = customTitle || configuredChartTitle || kpiMetricLabel || chartName;

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
    // Phase-15.81 v6 — per-visual tileFilters removed; runtime set is
    // global + cross only.
    const runtimeFilters = [...globalFilters, ...crossFilters];
    if (runtimeFilters.length > 0 && rows.length > 0) {
      const applicable = resolveClientFilters(runtimeFilters);
      if (applicable.length > 0) {
        rows = applyFiltersToRows(rows, applicable);
      }
    }
    return rows;
  }, [rawRows, exploreConfig, dashboardFilters, globalFilters, crossFilters, preAggregated, chartSemanticBinding]);

  // Cross-highlight data passed to the chart renderer:
  //   • null  → no highlight active OR this tile can't bind the selection
  //             (renders unchanged — "not affected", PBI-style).
  //   • array → the P-filtered subset (same row shape as filteredData).
  //       - source tile: the selected category's own baseline rows (local).
  //       - target tile: the parallel overlay query's rows.
  const highlightData = useMemo<Record<string, any>[] | null>(() => {
    if (!highlightFilter) return null;
    if (isHighlightSource) {
      const field = highlightFilter.field;
      // Date bucket (between [start,end]): match rows whose day falls in range.
      if (highlightFilter.operator === 'between' && Array.isArray(highlightFilter.value)) {
        const [start, end] = (highlightFilter.value as any[]).map((v) => String(v).slice(0, 10));
        return filteredData.filter((r) => {
          const day = String(r?.[field] ?? '').slice(0, 10);
          return day && (!start || day >= start) && (!end || day <= end);
        });
      }
      const target = String(highlightFilter.value);
      return filteredData.filter((r) => String(r?.[field]) === target);
    }
    if (highlightServerEntries.length === 0) return null;
    return overlayChartData?.data ?? null;
  }, [highlightFilter, isHighlightSource, highlightServerEntries, filteredData, overlayChartData]);

  const handleCrossFilterSelection = React.useCallback((selection: { field: string; value: unknown; dateRange?: [string, string]; dateGrain?: string } | null) => {
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

    // Time-bucketed click (Year/Quarter/Month/Week): the value is the bucket
    // START. Equality would match nothing (raw rows fall mid-bucket), so bound
    // the whole bucket with a `between` date range. Drives source-dim AND the
    // cross-filter/highlight on every target.
    if (selection.dateRange) {
      onSelectCrossFilter({
        id: `cross-${chartId}-${selection.field}-${selection.dateRange[0]}-${selection.dateRange[1]}`,
        field: selection.field,
        fieldKey: semanticField,
        semanticField,
        datasetId: chartSemanticBinding.datasetId,
        type: 'date',
        operator: 'between',
        value: selection.dateRange,
        label: selection.field,
      });
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
          title={t('dashboards.tile.removeChart')}
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
        <p className="text-text-tertiary">{t('dashboards.tile.failedToLoadChart')}</p>
      </div>,
      'danger'
    );
  }

  return (
    <div
      ref={visibilityRef}
      /* Phase-B12 — no `overflow-hidden` on the tile: the ⋯ menu popup was
         clipped when the tile was small. The chart body has its own
         overflow-hidden (so the chart never spills), and tile content is inset
         by p-3 so it won't poke the rounded corners — only the menu escapes. */
      className={`dashboard-tile bi-card-hover relative group flex h-full flex-col rounded-lg border bg-surface-1 p-3 ${
        isCrossFilterSource || isHighlightSource
          ? 'border-warning/40 ring-1 ring-warning'
          : isFocused
            ? 'border-brand/50 ring-2 ring-brand/40'
            : 'border-[rgb(var(--border-line))]'
      }`}
      /* Phase-B14 — honor the dashboard theme's card radius/border (fallbacks
         keep the default flat look). Border COLOR only in the default state so
         the cross-filter/focus rings still read. */
      style={{
        borderRadius: 'var(--dashboard-card-radius, 0.5rem)',
        borderWidth: 'var(--dashboard-card-border-width, 1px)',
        ...(isCrossFilterSource || isHighlightSource || isFocused
          ? {}
          : { borderColor: 'var(--dashboard-card-border-color, rgb(var(--border-line)))' }),
        // Phase-B16 — translucent "glass" tile that floats over a bg image.
        ...(dashTheme.cardBg
          ? {
              background: dashTheme.cardBg,
              backdropFilter: dashTheme.cardBackdrop,
              WebkitBackdropFilter: dashTheme.cardBackdrop,
              boxShadow: '0 10px 30px -14px rgba(2, 6, 23, 0.45)',
            }
          : {}),
        // Phase-B17 — a collaborator is editing THIS tile: colored ring.
        ...(editingBy ? { boxShadow: `0 0 0 2px ${editingBy.color}`, borderColor: editingBy.color } : {}),
      }}
      // Phase-15.81 v6 — click body marks this tile as focused for
      // Canvas/Grid highlight only (the FilterPane "this visual"
      // scope was removed). onMouseDown stop-prop on inner buttons
      // keeps the focus click from firing during drag-handle / menu
      // interactions.
      onClick={onFocus ? () => onFocus(dashboardChartId) : undefined}
    >
      {/* Phase-B17 — GG-Sheets cursor: a small avatar dot marks who's on this
          tile (full name on hover); the colored ring shows the location. */}
      {editingBy && (
        <div
          className="absolute -top-2 left-2 z-20 flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold uppercase text-white shadow-sm ring-2 ring-surface-1"
          style={{ backgroundColor: editingBy.color }}
          title={t('dashboards.tile.collaboratorEditing', { name: editingBy.name })}
        >
          {editingBy.name.trim().charAt(0) || '?'}
        </div>
      )}
      {/* Remove button Ã¢â‚¬â€ outside drag handle so clicks always register */}
      {onRemove && (
      <button
        onMouseDown={e => e.stopPropagation()}
        onClick={() => onRemove(dashboardChartId)}
        disabled={isRemoving}
        className="absolute top-2 right-2 z-10 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 p-1.5 shadow-linear-sm opacity-0 transition-opacity group-hover:opacity-100 hover:border-danger/40 hover:bg-danger/10 disabled:opacity-50"
        title={t('dashboards.tile.removeChart')}
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
            {isKpiCard ? (
              kpiHeaderTitle ? (
                <h3 data-pdf-tile-title className="text-sm font-semibold truncate flex-1" style={themeTitleStyle} title={kpiHeaderTitle}>{kpiHeaderTitle}</h3>
              ) : (
                <span className="flex-1" aria-hidden />
              )
            ) : displayTitle ? (
              <h3 data-pdf-tile-title className="text-sm font-semibold truncate flex-1" style={themeTitleStyle}>{displayTitle}</h3>
            ) : canEdit ? (
              /* Phase-B11 — no auto chart-name title; nudge the DA to add one. */
              <button
                onMouseDown={e => e.stopPropagation()}
                onClick={startEditingTitle}
                className="flex-1 truncate text-left text-sm italic text-text-quaternary opacity-0 transition hover:text-brand group-hover:opacity-100"
                title={t('dashboards.tile.addTitleHint')}
              >
                {t('dashboards.tile.addTitle')}
              </button>
            ) : (
              <span className="flex-1" aria-hidden />
            )}
            {/* PBI parity (2026-06): NOT gated on canEdit. A viewer who applied a
                dashboard filter must see when it didn't reach this chart — otherwise
                the tile shows a number computed without their filter, silently. */}
            {(skippedGlobalFilters.length > 0 || droppedByBackend.length > 0) && (
              <span
                className="flex-shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded"
                title={(() => {
                  const lines: string[] = [];
                  const total = skippedGlobalFilters.length + droppedByBackend.length;
                  lines.push(
                    total !== 1
                      ? t('dashboards.tile.couldNotApplyFiltersPlural', { count: total })
                      : t('dashboards.tile.couldNotApplyFiltersOne', { count: total }),
                  );
                  for (const f of skippedGlobalFilters) {
                    lines.push(t('dashboards.tile.skippedNotInModel', { field: getFilterDisplayLabel(f) }));
                  }
                  for (const d of droppedByBackend) {
                    const ref = d.semantic_field || d.field || t('dashboards.tile.unknownField');
                    const reason = d.detail || d.reason;
                    lines.push(`• ${ref} — ${reason}`);
                  }
                  return lines.join('\n');
                })()}
              >
                <AlertTriangle className="h-3 w-3" />
                {t('dashboards.tile.skippedBadge', { count: skippedGlobalFilters.length + droppedByBackend.length })}
              </span>
            )}
            <a
              href={`/explore/${chartId}`}
              target="_blank"
              rel="noreferrer"
              onMouseDown={e => e.stopPropagation()}
              className="flex-shrink-0 rounded-md p-1 text-text-quaternary opacity-0 transition hover:bg-surface-2 hover:text-brand focus:opacity-100 group-hover:opacity-100"
              title={t('dashboards.tile.openInExploreNewTab')}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>

            {/* HAVING badge stays separate; it has active state and opens the inline editor. */}
            {canEdit && exploreConfig && havingOptions.length > 0 && (
              <button
                onMouseDown={e => e.stopPropagation()}
                onClick={() => setIsHavingOpen(v => !v)}
                /* Phase-B9 — match the toolbar icons: muted gray even when
                   active; the blue dot signals the active filter. */
                className={`relative flex-shrink-0 transition-opacity text-text-quaternary hover:text-brand ${
                  isHavingOpen || havingFilters.length > 0
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100'
                }`}
                title={t('dashboards.tile.perChartFilters')}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                {havingFilters.length > 0 && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 bg-brand rounded-full" />
                )}
              </button>
            )}

            {/* Phase-B13 — Top/Bottom-N quick-control removed from the tile
                (configured in Explore only; see note near state). */}

            {/* Single overflow menu for View, Appearance, Rename, and Move to page. */}
            <div ref={tileMenuAnchorRef} className="relative flex-shrink-0">
              <button
                onMouseDown={e => e.stopPropagation()}
                onClick={() => { setIsTileMenuOpen(v => !v); setIsMovePageOpen(false); }}
                className={`transition-opacity text-text-quaternary hover:text-brand ${
                  isTileMenuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}
                title={t('dashboards.tile.moreOptions')}
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
                      {t('dashboards.tile.viewDetails')}
                    </button>
                    <a
                      href={`/explore/${chartId}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => setIsTileMenuOpen(false)}
                      className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(0,0,0,0.04)] hover:text-text-primary"
                    >
                      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                      {t('dashboards.tile.openInExplore')}
                    </a>
                    {allowAppearanceEdit && (
                      <button
                        onClick={() => { openDetailModal('appearance'); setIsTileMenuOpen(false); }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(0,0,0,0.04)] hover:text-text-primary"
                      >
                        <Palette className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                        {t('dashboards.tile.editAppearance')}
                      </button>
                    )}
                    {canEdit && (
                      <button
                        onClick={() => { startEditingTitle(); setIsTileMenuOpen(false); }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(0,0,0,0.04)] hover:text-text-primary"
                      >
                        <Pencil className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                        {t('dashboards.tile.renameTitle')}
                      </button>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={highlightEnabled}
                        /* Toggle in place (do NOT close the menu) + flip the
                           switch optimistically so the state change is visible
                           instantly without reading text. */
                        onClick={(e) => { e.stopPropagation(); toggleHighlightEnabled(); }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(0,0,0,0.04)] hover:text-text-primary"
                        title={t('dashboards.tile.highlightOnClickHint')}
                      >
                        <Sparkles className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                        <span className="flex-1 text-left">{t('dashboards.tile.highlightOnClick')}</span>
                        {/* Visual on/off switch — read at a glance, no label needed. */}
                        <span
                          className={`relative inline-flex h-[16px] w-[28px] shrink-0 items-center rounded-full transition-colors duration-150 ${
                            highlightEnabled ? 'bg-brand' : 'bg-[rgb(var(--border-strong))]'
                          }`}
                        >
                          <span
                            className={`inline-block h-[12px] w-[12px] transform rounded-full bg-white shadow-sm transition-transform duration-150 ${
                              highlightEnabled ? 'translate-x-[14px]' : 'translate-x-[2px]'
                            }`}
                          />
                        </span>
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
                          <span className="flex-1 text-left">{t('dashboards.tile.moveToPage')}</span>
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
                <span className="font-mono opacity-60 text-[0.6rem] uppercase">{t('dashboards.tile.havingLabel')}</span>
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
              <option value="gt">{t('dashboards.tile.opGt')}</option>
              <option value="gte">{t('dashboards.tile.opGte')}</option>
              <option value="lt">{t('dashboards.tile.opLt')}</option>
              <option value="lte">{t('dashboards.tile.opLte')}</option>
              <option value="eq">{t('dashboards.tile.opEq')}</option>
              <option value="neq">{t('dashboards.tile.opNeq')}</option>
            </select>
            <input
              type="number"
              value={draftHavingValue}
              onChange={e => setDraftHavingValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') confirmHaving();
                if (e.key === 'Escape') setIsHavingOpen(false);
              }}
              placeholder={t('dashboards.tile.valuePlaceholder')}
              className="text-xs border border-[rgb(var(--border-strong))] rounded px-1.5 py-0.5 w-20 focus:outline-none focus:ring-1 focus:ring-brand"
            />
            <button
              onClick={confirmHaving}
              className="text-xs px-2 py-0.5 bg-brand text-white rounded hover:bg-brand-hover"
            >
              {t('dashboards.tile.apply')}
            </button>
            {havingFilters.length > 0 && (
              <button
                onClick={() => setHavingFilters([])}
                className="text-xs text-text-quaternary hover:text-text-secondary"
              >
                {t('dashboards.tile.clearAll')}
              </button>
            )}
          </div>
        )}
        {/* Phase-B13 — Top/Bottom-N editor panel removed (configured in Explore only). */}
      </div>

      {/* Chart visualization. Phase-15.6: hint cursor + title attr when the
          chart is wired for cross-filter, so users discover the click-to-
          filter affordance instead of having to read docs. */}
      <div
        className={`relative flex-1 min-h-0 overflow-hidden ${
          onSelectCrossFilter && chartSemanticBinding?.datasetId != null
            ? 'cursor-crosshair'
            : ''
        }`}
        title={
          onSelectCrossFilter && chartSemanticBinding?.datasetId != null
            ? t('dashboards.tile.crossFilterHint')
            : undefined
        }
        onClick={(e) => {
          // Click on EMPTY chart space → clear the dashboard selection (revert
          // to baseline; slicer/page filters are untouched). A click on a data
          // mark selects instead (handled by the chart's own onSelectDataPoint),
          // so we bail when the target is a mark. Scoped to Recharts charts.
          if (!onSelectCrossFilter || chartSemanticBinding?.datasetId == null) return;
          const target = e.target as Element | null;
          if (!target?.closest?.('.recharts-wrapper')) return;
          if (target.closest('.recharts-bar-rectangle, .recharts-rectangle, .recharts-sector, .recharts-dot, .recharts-active-dot, .recharts-symbols, .recharts-pie-sector')) return;
          onSelectCrossFilter(null);
        }}
      >
        {isLoadingData ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-brand" />
          </div>
        ) : chartDataError ? (
          <div className="flex h-full items-center justify-center rounded-md border border-warning/30 bg-warning/5 p-4 text-center">
            <div className="max-w-sm">
              <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-warning" />
              <p className="text-sm font-semibold text-text-primary">{t('dashboards.tile.loadDataFailed')}</p>
              <p className="mt-1 text-xs uppercase tracking-[0.14em] text-text-quaternary">
                {String(chart.chart_type).replace(/_/g, ' ')}
              </p>
              <p className="mt-2 line-clamp-3 text-xs text-text-tertiary">
                {getErrorMessage(chartDataError, t('dashboards.tile.couldNotLoadData'))}
              </p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  onMouseDown={e => e.stopPropagation()}
                  onClick={() => refetchChartData()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-2"
                >
                  {isFetchingData ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  {t('dashboards.tile.retry')}
                </button>
                <button
                  type="button"
                  onMouseDown={e => e.stopPropagation()}
                  onClick={() => openDetailModal('data')}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[rgb(var(--border-strong))] bg-surface-1 px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-2"
                >
                  <Eye className="h-3.5 w-3.5" />
                  {t('dashboards.tile.details')}
                </button>
                <a
                  href={`/explore/${chartId}`}
                  target="_blank"
                  rel="noreferrer"
                  onMouseDown={e => e.stopPropagation()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-brand/30 bg-brand/10 px-2.5 py-1.5 text-xs font-medium text-brand hover:bg-brand/15"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {t('dashboards.tile.explore')}
                </a>
              </div>
            </div>
          </div>
        ) : !chartData ? (
          <div className="flex h-full items-center justify-center rounded-md border border-[rgb(var(--border-line))] bg-surface-2 p-4 text-center">
            <div>
              <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-warning" />
              <p className="text-sm font-medium text-text-primary">{t('dashboards.tile.noChartData')}</p>
              <p className="mt-1 text-xs text-text-tertiary">{t('dashboards.tile.noChartDataHint')}</p>
            </div>
          </div>
        ) : exploreConfig ? (
          // Phase-15.78 — `key` on a chart-type wrapper triggers a clean
          // remount + fade-in on chart-type change. Recharts components
          // don't smoothly cross-fade between Bar/Line/Area (different
          // primitives), so we lean on a CSS fade to soften what would
          // otherwise be a hard cut. bi-fade-in is the project's
          // standard 150ms ease-out used by filter cards.
          <div key={exploreConfig.chartType} className="h-full bi-fade-in">
            <ExploreChart
              type={exploreConfig.chartType}
              data={filteredData}
              roleConfig={exploreConfig.roleConfig}
              styleConfig={exploreConfig.styleConfig}
              labelMap={tileLabelMap}
              formatMap={tileFormatMap}
              havingFilters={havingFilters}
              preAggregated={preAggregated}
              embedded
              kpiLabelInHeader={isKpiCard}
              onViewerDrill={setViewerGrain}
              viewerGrain={viewerGrain}
              highlightData={highlightData}
              onSelectDataPoint={onSelectCrossFilter && chartSemanticBinding?.datasetId != null
                ? handleCrossFilterSelection
                : undefined}
            />
          </div>
        ) : (
          <div key={chart.chart_type} className="h-full bi-fade-in">
            <ChartPreview
              chartType={chart.chart_type}
              data={filteredData}
              config={legacyRenderChartConfig}
              styleConfig={chartRenderStyleConfig}
              onSelectDataPoint={onSelectCrossFilter && chartSemanticBinding?.datasetId != null
                ? handleCrossFilterSelection
                : undefined}
            />
          </div>
        )}
        {/* keepPrevious overlay — while a filter/grain change re-runs the query
            we render the PREVIOUS data underneath; dim it + spin so the tile
            reads as "refreshing" rather than blanking. Only when we already
            have data on screen (not the first load) and aren't in an error. */}
        {isFetchingData && chartData && !isLoadingData && !chartDataError ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-surface-1/45 backdrop-blur-[0.5px] transition-opacity duration-150">
            <Loader2 className="h-5 w-5 animate-spin text-brand" />
          </div>
        ) : null}
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
  if (prev.isHighlightSource !== next.isHighlightSource) return false;
  if (prev.highlightFilter !== next.highlightFilter) return false;
  if (prev.isFocused !== next.isFocused) return false;
  if (prev.currentPageId !== next.currentPageId) return false;
  // Layout reference change is fine — we render the same DOM either way;
  // the parent grid moves the wrapper via CSS transform. Skip deep
  // compare to keep this hot path cheap.
  //
  // Phase-15.81 — exception: when `currentLayout.tileFilters` (per-visual
  // PowerBI-style scope) changes, the tile MUST re-render so the new
  // filter is folded into serverFilters + chart-data request. Same for
  // styleConfigOverride (Phase-15.78 Top-N panel writes data limit / sort
  // rules here). Both are user-driven config rather than grid geometry,
  // so the perf concern that originally motivated the skip doesn't apply.
  if (prev.currentLayout?.tileFilters !== next.currentLayout?.tileFilters) return false;
  if (prev.currentLayout?.styleConfigOverride !== next.currentLayout?.styleConfigOverride) return false;
  // Per-chart highlight opt-out toggles the ⋯ menu label + (via the grid) the
  // click-source/target gating, so the tile must re-render when it flips.
  if (prev.currentLayout?.highlightEnabled !== next.currentLayout?.highlightEnabled) return false;
  if (prev.onRemove !== next.onRemove) return false;
  if (prev.onDataLoaded !== next.onDataLoaded) return false;
  if (prev.onSelectCrossFilter !== next.onSelectCrossFilter) return false;
  if (prev.onMoveToPage !== next.onMoveToPage) return false;
  if (prev.onFocus !== next.onFocus) return false;
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
