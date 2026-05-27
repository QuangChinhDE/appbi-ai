'use client';

import React, { useState, useCallback } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Plus, Loader2, Edit2, Check, X, Share2, Globe, Sparkles, Trash2, LayoutGrid, Download, MoreHorizontal, ChevronDown, Filter } from 'lucide-react';
import { Layout } from 'react-grid-layout';
import { useQueries, useIsFetching, useQueryClient } from '@tanstack/react-query';
import {
  useDashboard,
  useUpdateDashboard,
  useAddChartToDashboard,
  useRemoveChartFromDashboard,
  useUpdateDashboardLayout,
  useUpdateDashboardDraftLayout,
  usePublishDashboard,
  useDiscardDashboardDraft,
} from '@/hooks/use-dashboards';
import { dashboardApi } from '@/lib/api/dashboards';
import { DashboardGrid } from '@/components/dashboards/DashboardGrid';
import { DashboardThemeProvider } from '@/components/dashboards/DashboardThemeProvider';
import { DashboardThemeModal } from '@/components/dashboards/DashboardThemeModal';
import { DashboardCanvas } from '@/components/dashboards/DashboardCanvas';
import { Palette, Move } from 'lucide-react';
import { ChartTile } from '@/components/dashboards/ChartTile';
import { WidgetEditModal } from '@/components/dashboards/WidgetEditModal';
import { AddChartModal } from '@/components/dashboards/AddChartModal';
import { DashboardChartManagerModal } from '@/components/dashboards/DashboardChartManagerModal';
import { DashboardHtmlImportModal } from '@/components/dashboards/DashboardHtmlImportModal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ShareDialog } from '@/components/common/ShareDialog';
import { PublicLinksManager } from '@/components/common/PublicLinksManager';
import { FilterPane } from '@/components/dashboards/FilterPane';
import { DashboardFilterBar } from '@/components/dashboards/DashboardFilterBar';
import { SlicerCluster } from '@/components/dashboards/SlicerCluster';
import { DashboardChartLayout, DashboardPageConfig } from '@/types/api';
import type { BaseFilter, ColumnInfo, FilterType, Filter as TypedFilter } from '@/lib/filters';
import {
  collectJoinKeySemanticFields,
  fromBaseFilter,
  getColumnDisplayLabel,
  getDistinctValueFilterContext,
  getFilterDisplayLabel,
  getFriendlyFieldLabel,
  getColumnKey,
  getFilterKey,
  inferColumnTypeFromData,
  isSemanticDimensionFilterableForDashboard,
  toBaseFilter,
} from '@/lib/filters';
import { fetchDatasetModel, fetchDatasetModelDistinctValues, modelKeys, type DatasetModelResponse } from '@/hooks/use-dataset-model';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import {
  createDashboardPageId,
  ensureDashboardPageId,
  getDashboardChartPageId,
  getDashboardChartsForPage,
  normalizeDashboardPages,
} from '@/lib/dashboard-pages';
import { toast } from '@/lib/toast';

function semanticDimensionToFilterType(type: string | undefined): FilterType {
  switch ((type ?? '').toLowerCase()) {
    case 'date':
    case 'datetime':
      return 'date';
    case 'number':
      return 'number';
    case 'yesno':
    case 'string':
    default:
      return 'dropdown';
  }
}

// Phase-15.81 v14 — heuristic: when the semantic model mislabels a
// date/datetime column as `string` (DA forgot to set the type in the
// data model UI), the column shows up in the picker as a dropdown
// slot, gets picked by DA as a text filter, and produces 0-row
// queries because BETWEEN '2026-...' '2026-...' never matches the
// raw column. Treat well-known date-name suffixes as evidence the
// column IS a date so we route it through the calendar filter
// fan-out path instead of the field picker.
//
// Phase-15.81 v19 — tighten the pattern set after a DA-reported
// false positive: `created_by_user_id` was matching the bare
// `created` startsWith rule and got swept into the Date fan-out
// alongside real date columns, sent up to the BE as a BETWEEN
// filter on an integer FK column, and triggered 400 because the
// engine refused to cast an integer to DATE. Standalone English
// participles (`created`, `modified`, `expired`) almost never
// identify a true date column on their own; they're prefixes of
// FK / status / role columns just as often. Restrict the hint
// set to compound terms (`*_at`, `*_date`, `*_time`, …) plus the
// exact bare `date` / `time` / `datetime` / `timestamp` literals.
const DATE_NAME_SUFFIXES = [
  '_at', '_date', '_time', '_datetime', '_timestamp',
];
const DATE_NAME_EXACT = new Set([
  'date', 'time', 'datetime', 'timestamp',
]);

function nameSuggestsDate(fieldName: string): boolean {
  const n = (fieldName ?? '').toLowerCase().trim();
  if (!n) return false;
  if (DATE_NAME_EXACT.has(n)) return true;
  return DATE_NAME_SUFFIXES.some((suffix) => n.endsWith(suffix));
}

function resolveDimensionFilterType(
  storedType: string | undefined,
  fieldName: string,
): FilterType {
  const fromStored = semanticDimensionToFilterType(storedType);
  if (fromStored === 'dropdown' && nameSuggestsDate(fieldName)) {
    return 'date';
  }
  return fromStored;
}

function splitSemanticField(field: string): [string, string] | null {
  if (!field.includes('.')) return null;
  const [viewName, fieldName] = field.split('.', 2);
  if (!viewName || !fieldName) return null;
  return [viewName, fieldName];
}

function areFiltersEquivalent(left: BaseFilter | null, right: BaseFilter | null): boolean {
  if (!left || !right) return false;
  return getFilterKey(left) === getFilterKey(right)
    && left.operator === right.operator
    && JSON.stringify(left.value) === JSON.stringify(right.value);
}

function formatFilterValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(', ');
  }
  return String(value ?? '');
}

function normalizeLegacyDateFilter(filter: TypedFilter, dateColumn: ColumnInfo | null): TypedFilter {
  // Phase-15.80 — was BaseFilter; now operates on the union. Only DateFilter
  // can carry the legacy "bare 'date' field name with no semantic ref"
  // payload, so other kinds pass through unchanged.
  if (filter.kind !== 'date') return filter;
  const dateColumnKey = dateColumn ? getColumnKey(dateColumn) : null;
  const semanticField = String(filter.semanticField ?? '').trim();
  const fieldKey = String(filter.fieldKey ?? '').trim();
  const fieldName = String(filter.field ?? '').trim().toLowerCase();
  const isLegacyDateFilter = (
    fieldName === 'date'
    && !semanticField.includes('.')
    && !fieldKey.includes('.')
    && Boolean(dateColumn && dateColumnKey && dateColumn.semanticField)
  );

  if (!isLegacyDateFilter || !dateColumn || !dateColumnKey) {
    return filter;
  }

  return {
    ...filter,
    field: dateColumn.name,
    fieldKey: dateColumnKey,
    semanticField: dateColumn.semanticField,
    datasetId: dateColumn.datasetId,
    label: filter.label || getColumnDisplayLabel(dateColumn),
    linkedFields: dateColumn.defaultLinkedFields?.length ? [...dateColumn.defaultLinkedFields] : undefined,
  };
}

// Phase-15.81 v7 — URL filter param `?f=` was removed.
// The /dashboards/[id] route is the DA-only edit surface; nobody
// shares this URL with viewers (public viewers use /d/[token]).
// Filter state lives in dashboard.filters_config + pages_config —
// no second source of truth needed.

export default function DashboardDetailPage() {
  const params = useParams();
  const dashboardId = Number(params.id);

  const [isAddChartModalOpen, setIsAddChartModalOpen] = useState(false);
  const [isHtmlImportOpen, setIsHtmlImportOpen] = useState(false);
  const [isChartManagerOpen, setIsChartManagerOpen] = useState(false);
  const [removingChartId, setRemovingChartId] = useState<number | undefined>();
  const [pendingRemoveDashboardChartId, setPendingRemoveDashboardChartId] = useState<number | undefined>();
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState('');
  // Phase-15.66 — `hasUnsavedChanges` replaced by hasLocalLayoutChanges
  // (derived from localLayoutOverrides) + serverDashboard.has_draft.
  // Phase-15.80 — state holds the typed Filter union (PowerBI-style
  // discriminator). Legacy BaseFilter is reconstructed on demand for the
  // execution path (chart-data API, applyFiltersToRows) and for components
  // that still consume BaseFilter (DashboardFilterBar internals, ChartTile).
  const [draftGlobalFilters, setDraftGlobalFilters] = useState<TypedFilter[]>([]);
  const [appliedGlobalFilters, setAppliedGlobalFilters] = useState<TypedFilter[]>([]);
  // Phase-C THẬT (PBI-parity rework) — slicer state.
  // Lives in `Dashboard.slicers_config` (separate from filters_config).
  // Renders as a canvas-block SlicerBar above the grid in edit mode.
  // Per spec §2.1 slicers are always visible to viewers — no
  // publicMode/locked/hidden toggle here. Public-link overrides
  // happen at the link manager level (link_locked / link_hidden).
  // Mixed: slicer entries (BaseFilter shape) + image entries
  // (SlicerImageEntry shape with type='image'). Type widened to `any[]`
  // so the cluster component can store both without forcing a
  // discriminated union at every call site.
  const [draftGlobalSlicers, setDraftGlobalSlicers] = useState<any[]>([]);
  const [appliedGlobalSlicers, setAppliedGlobalSlicers] = useState<any[]>([]);
  // Phase-G — cluster-level layout (position/direction/gap/etc.).
  const [draftSlicerClusterLayout, setDraftSlicerClusterLayout] = useState<any | null>(null);
  const [appliedSlicerClusterLayout, setAppliedSlicerClusterLayout] = useState<any | null>(null);
  const slicersSeededRef = React.useRef(false);
  const [isApplyingFilters, setIsApplyingFilters] = useState(false);
  const [crossFilterState, setCrossFilterState] = useState<{
    sourceChartId: number;
    filter: BaseFilter;
  } | null>(null);
  const [availableColumns, setAvailableColumns] = useState<ColumnInfo[]>([]);
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [isPublicShareOpen, setIsPublicShareOpen] = useState(false);
  const [isThemeOpen, setIsThemeOpen] = useState(false);
  const [isWidgetMenuOpen, setIsWidgetMenuOpen] = useState(false);
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
  const [isPagesMenuOpen, setIsPagesMenuOpen] = useState(false);
  // Phase-15.81 — kept for backward compat with onClick handlers in other
  // menus that still call setIsFilterPopoverOpen(false). The Filter popover
  // itself is gone — the right-dock FilterPane (isFilterPaneOpen) replaces
  // it. Both states stay in sync via the menu close-out pattern.
  const [, setIsFilterPopoverOpen] = useState(false);
  const [isWidgetSubmenuOpen, setIsWidgetSubmenuOpen] = useState(false);
  const [editingWidgetId, setEditingWidgetId] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const [currentPageId, setCurrentPageId] = useState<string | null>(null);
  const [localPagesConfig, setLocalPagesConfig] = useState<DashboardPageConfig[] | null>(null);
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [editedPageName, setEditedPageName] = useState('');
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const dashboardContentRef = React.useRef<HTMLDivElement>(null);
  const chartsFetching = useIsFetching({ queryKey: ['charts'] });
  const [pendingDeletePageId, setPendingDeletePageId] = useState<string | null>(null);
  // Phase-15.56 — confirm-discard modal uses the shared ConfirmDialog
  // so the warning sits in the app's noti style instead of the browser's
  // native confirm() (which DA called out as inconsistent).
  const [isDiscardConfirmOpen, setIsDiscardConfirmOpen] = useState(false);
  // columnChartCount: how many distinct chartIds have each column
  const columnChartCountRef = React.useRef<Map<string, Set<number>>>(new Map());
  const [columnChartCount, setColumnChartCount] = useState<Map<string, number>>(new Map());
  // Refs for filter seeding
  const filtersSeededRef = React.useRef(false);
  const filtersSnapshotRef = React.useRef<string>('[]');
  const distinctValuesRef = React.useRef<Map<string, Set<string>>>(new Map());
  const [distinctValues, setDistinctValues] = useState<Record<string, string[]>>({});

  const { data: serverDashboard, isLoading: isLoadingDashboard } = useDashboard(dashboardId);

  // Phase-15.66 — local layout overrides (no auto-save). Drag/resize
  // only updates this map; explicit Save buttons flush to BE.
  const [localLayoutOverrides, setLocalLayoutOverrides] = useState<
    Record<number, Record<string, any>>
  >({});
  const hasLocalLayoutChanges = Object.keys(localLayoutOverrides).length > 0;
  const hasAnyPendingChanges = hasLocalLayoutChanges || Boolean(serverDashboard?.has_draft);

  // Memoized dashboard view: server data overlaid with (1) BE draft_layouts,
  // (2) in-progress local edits. Children see a normal dashboard_charts list.
  const dashboard = React.useMemo(() => {
    if (!serverDashboard) return serverDashboard;
    const beDrafts = serverDashboard.draft_layouts;
    if (
      !hasLocalLayoutChanges
      && (!beDrafts || Object.keys(beDrafts).length === 0)
    ) {
      return serverDashboard;
    }
    return {
      ...serverDashboard,
      dashboard_charts: serverDashboard.dashboard_charts.map((dc) => {
        const beOverride = beDrafts
          ? (beDrafts[dc.id] ?? beDrafts[String(dc.id) as any])
          : null;
        const localOverride = localLayoutOverrides[dc.id];
        if (!beOverride && !localOverride) return dc;
        return {
          ...dc,
          layout: {
            ...(dc.layout ?? {}),
            ...(beOverride ?? {}),
            ...(localOverride ?? {}),
          },
        };
      }),
    };
  }, [serverDashboard, localLayoutOverrides, hasLocalLayoutChanges]);

  const dashboardDatasetIds = React.useMemo(
    () => Array.from(new Set(
      (dashboard?.dashboard_charts ?? [])
        .map((dc) => Number((dc.chart?.config as any)?.semanticBinding?.datasetId))
        .filter((id) => Number.isFinite(id) && id > 0),
    )),
    [dashboard?.dashboard_charts],
  );
  const datasetModelQueries = useQueries({
    queries: dashboardDatasetIds.map((datasetId) => ({
      queryKey: modelKeys.detail(datasetId),
      queryFn: () => fetchDatasetModel(datasetId),
      enabled: !!dashboard,
      staleTime: 5 * 60 * 1000,
    })),
  });
  const datasetModelsById = React.useMemo(() => {
    const map = new Map<number, DatasetModelResponse>();
    datasetModelQueries.forEach((query, index) => {
      if (query.data) {
        map.set(dashboardDatasetIds[index], query.data);
      }
    });
    return map;
  }, [dashboardDatasetIds, datasetModelQueries]);
  const resPerms = getResourcePermissions(dashboard?.user_permission);
  const canShare = resPerms.canShare;
  const canEditResource = resPerms.canEdit;
  const updateDashboardMutation = useUpdateDashboard();
  const addChartMutation = useAddChartToDashboard();
  const removeChartMutation = useRemoveChartFromDashboard();
  const updateLayoutMutation = useUpdateDashboardLayout();
  // Phase-15.56 — layout edits go into draft_snapshot instead of live
  // rows so public viewers stay on the published layout until the
  // editor explicitly clicks "Lưu".
  const updateDraftLayoutMutation = useUpdateDashboardDraftLayout();
  const publishDashboardMutation = usePublishDashboard();
  const discardDraftMutation = useDiscardDashboardDraft();
  const dashboardPages = React.useMemo(
    () => normalizeDashboardPages(localPagesConfig ?? dashboard?.pages_config),
    [dashboard?.pages_config, localPagesConfig],
  );
  const activePageId = React.useMemo(
    () => ensureDashboardPageId(dashboardPages, currentPageId),
    [dashboardPages, currentPageId],
  );
  const currentPage = React.useMemo(
    () => dashboardPages.find((page) => page.id === activePageId) ?? dashboardPages[0],
    [activePageId, dashboardPages],
  );
  const visibleDashboardCharts = React.useMemo(
    () => getDashboardChartsForPage(dashboard?.dashboard_charts, activePageId),
    [dashboard?.dashboard_charts, activePageId],
  );

  // Charts for each page (used for hidden pre-warm grids and multi-page export)
  const chartsPerPage = React.useMemo(
    () => dashboardPages.map((page) => ({
      pageId: page.id,
      pageName: page.name,
      charts: getDashboardChartsForPage(dashboard?.dashboard_charts, page.id),
    })),
    [dashboard?.dashboard_charts, dashboardPages],
  );
  const totalChartCount = React.useMemo(
    () => chartsPerPage.reduce((sum, p) => sum + p.charts.length, 0),
    [chartsPerPage],
  );
  // True when no chart queries are still in-flight
  const allChartsReady = chartsFetching === 0 && totalChartCount > 0;

  React.useEffect(() => {
    if (currentPageId !== activePageId) {
      setCurrentPageId(activePageId);
    }
  }, [currentPageId, activePageId]);

  React.useEffect(() => {
    setLocalPagesConfig(null);
  }, [dashboard?.pages_config]);

  // Seed globalFilters from dashboard.filters_config once when the
  // dashboard first loads. DB stores legacy BaseFilter[]; convert
  // through fromBaseFilter() so in-memory state is union-typed.
  // Failed conversions (corrupt rows, custom operators we haven't
  // modeled) drop silently — they wouldn't render on the new UI.
  React.useEffect(() => {
    if (!dashboard || filtersSeededRef.current) return;
    filtersSeededRef.current = true;
    const legacyServerDefault: BaseFilter[] = Array.isArray(dashboard.filters_config)
      ? dashboard.filters_config as BaseFilter[]
      : [];
    const initial: TypedFilter[] = legacyServerDefault
      .map((b) => fromBaseFilter(b))
      .filter((f): f is TypedFilter => f !== null);
    filtersSnapshotRef.current = JSON.stringify(initial);
    setDraftGlobalFilters(initial);
    setAppliedGlobalFilters(initial);
  }, [dashboard]);

  // Phase-C THẬT — seed slicer state from dashboard.slicers_config.
  // Same pattern as the filter seed above but stays in legacy
  // BaseFilter[] shape (the SlicerBar component reads/writes it
  // directly without the TypedFilter union round-trip).
  // Phase-G — also seed the cluster layout (position/direction/gap).
  React.useEffect(() => {
    if (!dashboard || slicersSeededRef.current) return;
    slicersSeededRef.current = true;
    const seed = Array.isArray((dashboard as any).slicers_config)
      ? ((dashboard as any).slicers_config as any[])
      : [];
    setDraftGlobalSlicers(seed);
    setAppliedGlobalSlicers(seed);
    const layoutSeed = (dashboard as any).slicer_cluster_layout || null;
    setDraftSlicerClusterLayout(layoutSeed);
    setAppliedSlicerClusterLayout(layoutSeed);
  }, [dashboard]);

  // Phase-G — auto-stage the cluster layout (position/direction/size)
  // into the draft the moment it changes. It's a structural/visual
  // setting, not a filter value, so it must NOT wait for the filter
  // "Apply" — it behaves like chart-layout edits (auto-staged). Without
  // this, an author who picks "Left" then clicks the top-level
  // "Lưu & xuất bản" loses the change: it never reached draft_snapshot,
  // so Publish flushed nothing and the public link never saw it.
  React.useEffect(() => {
    if (!canEditResource || !dashboard || !slicersSeededRef.current) return;
    if (JSON.stringify(draftSlicerClusterLayout) === JSON.stringify(appliedSlicerClusterLayout)) return;
    const t = window.setTimeout(() => {
      dashboardApi
        .updateDraftFilters(dashboardId, { slicer_cluster_layout: draftSlicerClusterLayout ?? {} })
        .then(() => {
          setAppliedSlicerClusterLayout(draftSlicerClusterLayout);
          // Refresh so has_draft + the "Lưu & xuất bản" button reflect
          // the staged change.
          queryClient.invalidateQueries({ queryKey: ['dashboards', dashboardId] });
        })
        .catch((e) => console.error('Failed to stage slicer cluster layout:', e));
    }, 500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftSlicerClusterLayout, appliedSlicerClusterLayout, canEditResource, dashboardId]);

  React.useEffect(() => {
    if (!crossFilterState) return;
    const sourceExists = visibleDashboardCharts.some(
      (dashboardChart) => dashboardChart.chart_id === crossFilterState.sourceChartId,
    );
    if (!sourceExists) {
      setCrossFilterState(null);
    }
  }, [visibleDashboardCharts, crossFilterState]);

  // Track the last applied filter snapshot.
  React.useEffect(() => {
    if (!filtersSeededRef.current) return;
    const current = JSON.stringify(appliedGlobalFilters);
    filtersSnapshotRef.current = current;
  }, [appliedGlobalFilters]);

  // Phase-15.80 — legacy BaseFilter[] view of typed union filters,
  // memoised so downstream components (FilterPane editor, ChartTile)
  // get a stable reference. Two projections:
  //   • draft   → the FilterPane editor reads/writes this (keeps
  //     half-built filter cards with empty value alive while DA picks
  //     a value — toBaseFilter drops inactive entries so we project
  //     directly from `value`-bearing fields without isFilterActive).
  //   • applied → what the chart-data API consumes. Only ACTIVE
  //     filters survive (engine can't run `IN ()`).
  const draftGlobalFiltersLegacy = React.useMemo<BaseFilter[]>(
    () => draftGlobalFilters
      .map((f) => toBaseFilter(f, { allowInactive: true }))
      .filter((b): b is BaseFilter => b !== null),
    [draftGlobalFilters],
  );
  const appliedGlobalFiltersLegacy = React.useMemo<BaseFilter[]>(
    () => appliedGlobalFilters
      .map((f) => toBaseFilter(f))
      .filter((b): b is BaseFilter => b !== null),
    [appliedGlobalFilters],
  );

  // Phase-15.81 v11 — PowerBI-style "Filters on this page" scope.
  // Lives on pages_config[activePage].filters. Setup follows the same
  // draft → Apply gate as all-pages; the DA can wire slots up without
  // each click re-querying BigQuery. `activePageFilters` is the
  // server-persisted set (what the public viewer sees); the editor
  // edits `draftPageFilters` locally until Apply pushes them through.
  const activePageFilters = React.useMemo<BaseFilter[]>(
    () => Array.isArray(currentPage?.filters) ? currentPage!.filters as BaseFilter[] : [],
    [currentPage],
  );
  const [draftPageFilters, setDraftPageFilters] = useState<BaseFilter[]>([]);
  // Reset draft whenever the active page (or server-saved set) changes
  // — opening a different page should show its own persisted slots,
  // not the previous page's draft.
  const pageFiltersServerSignatureRef = React.useRef<string>('');
  React.useEffect(() => {
    const sig = `${activePageId}::${JSON.stringify(activePageFilters)}`;
    if (pageFiltersServerSignatureRef.current === sig) return;
    pageFiltersServerSignatureRef.current = sig;
    setDraftPageFilters(activePageFilters);
  }, [activePageId, activePageFilters]);

  // Phase-15.81 v11 — pending flag must light up for BOTH scopes so
  // the Apply button surfaces when a DA edits page filters too.
  // Phase-C THẬT — slicer drafts also count toward pending.
  const hasPendingFilterChanges = React.useMemo(
    () =>
      JSON.stringify(draftGlobalFilters) !== JSON.stringify(appliedGlobalFilters)
      || JSON.stringify(draftPageFilters) !== JSON.stringify(activePageFilters)
      || JSON.stringify(draftGlobalSlicers) !== JSON.stringify(appliedGlobalSlicers)
      || JSON.stringify(draftSlicerClusterLayout) !== JSON.stringify(appliedSlicerClusterLayout),
    [draftGlobalFilters, appliedGlobalFilters, draftPageFilters, activePageFilters,
     draftGlobalSlicers, appliedGlobalSlicers,
     draftSlicerClusterLayout, appliedSlicerClusterLayout],
  );

  // Combined view fed into DashboardGrid/Canvas/ChartTile. Both scopes
  // contribute to the chart WHERE; per-page wins on field collision
  // (PowerBI page-level override semantic, mirrors the public viewer
  // seed effect's "page entries take precedence" rule). Driven by
  // APPLIED state — adding a half-built filter card mustn't shake the
  // chart grid.
  // Phase-C THẬT — slicers (#1) and filters (#2) both contribute to
  // the chart WHERE in internal mode. Layer order matches BE
  // make_dashboard_layers: chart_base < dashboard_filter < dashboard_slicer.
  // Later layers override earlier on same field, so slicers win over
  // filters when they hit the same column (matches PBI behavior:
  // viewer-interactive slicer overrides the canvas-hidden filter).
  const effectivePageScopeFilters = React.useMemo<BaseFilter[]>(() => {
    const byKey = new Map<string, BaseFilter>();
    for (const f of appliedGlobalFiltersLegacy) byKey.set(getFilterKey(f), f);
    for (const f of activePageFilters) byKey.set(getFilterKey(f), f);
    // Phase-G — skip image children (they're decorative, not filters);
    // defensive guard even though BE also drops them.
    for (const f of appliedGlobalSlicers) {
      if (f && typeof f === 'object' && (f as any).type === 'image') continue;
      byKey.set(getFilterKey(f as BaseFilter), f as BaseFilter);
    }
    return Array.from(byKey.values());
  }, [appliedGlobalFiltersLegacy, activePageFilters, appliedGlobalSlicers]);
  // Phase-15.81 — tile focus state (Canvas/Grid highlight only).
  // Per-visual filters were removed from FilterPane: each chart edits
  // its own filters inside the chart editor, so a focused-tile filter
  // scope here was redundant.
  const [focusedTileId, setFocusedTileId] = useState<number | null>(null);
  // Phase-15.81 — replace the old top-bar popover with a docked right-hand
  // FilterPane sidebar. Persisted in window only (intentionally not URL),
  // since pane state is a viewing preference.
  const [isFilterPaneOpen, setIsFilterPaneOpen] = useState(false);

  // Filter changes are applied explicitly via the Apply action.
  //

  // Layout edits (Phase-15.66) — pure local state, NO auto-save.
  //
  // Previously (Phase 15.56–15.57) drag/resize debounced a /draft-layout
  // POST every 1s. That round-trip + onSuccess setQueryData → 150+ tile
  // re-render was the dominant source of grid lag. Bỏ auto-save hoàn
  // toàn: drag/resize chỉ update React state, không gọi BE. User chủ
  // động click "Lưu nháp" / "Lưu & xuất bản" để persist.
  //
  const handleLayoutChange = (newLayout: Layout[]) => {
    if (!serverDashboard) return;
    // Build override map from the new react-grid-layout positions.
    // Only record entries whose x/y/w/h actually differ from the
    // baseline (serverDashboard layout merged with draft if any) so the
    // "Save" button doesn't light up after a no-op gesture.
    const next: Record<number, Record<string, any>> = {};
    for (const item of newLayout) {
      const id = Number(item.i);
      const existing = serverDashboard.dashboard_charts?.find((dc) => dc.id === id);
      if (!existing) continue;
      // Baseline = server draft if present, else live layout.
      const draftKey = String(id);
      const baseline = {
        ...(existing.layout ?? {}),
        ...((serverDashboard.draft_layouts?.[id] ?? serverDashboard.draft_layouts?.[draftKey as any]) ?? {}),
      };
      if (
        baseline.x === item.x
        && baseline.y === item.y
        && baseline.w === item.w
        && baseline.h === item.h
      ) {
        continue;
      }
      next[id] = {
        ...(existing.layout ?? {}),
        x: item.x,
        y: item.y,
        w: item.w,
        h: item.h,
      };
    }
    if (Object.keys(next).length === 0) {
      // No real change — clear local diff if any.
      setLocalLayoutOverrides({});
      return;
    }
    setLocalLayoutOverrides((prev) => ({ ...prev, ...next }));
  };

  // Canvas-mode layout updates: same pattern — local state only.
  const handleCanvasLayoutChange = useCallback(
    (
      updates: Array<{ id: number; xPx: number; yPx: number; wPx: number; hPx: number; z: number }>,
    ) => {
      if (!serverDashboard) return;
      setLocalLayoutOverrides((prev) => {
        const next = { ...prev };
        for (const u of updates) {
          const existing = serverDashboard.dashboard_charts?.find((dc) => dc.id === u.id)?.layout ?? {
            x: 0, y: 0, w: 4, h: 4,
          };
          next[u.id] = {
            ...existing,
            xPx: u.xPx,
            yPx: u.yPx,
            wPx: u.wPx,
            hPx: u.hPx,
            z: u.z,
          };
        }
        return next;
      });
    },
    [serverDashboard],
  );

  // Flush helpers — used by Save draft / Save & Publish buttons.
  const flushLocalLayoutsToDraft = async () => {
    if (!hasLocalLayoutChanges) return true;
    const chartLayouts = Object.entries(localLayoutOverrides).map(([id, layout]) => ({
      id: Number(id),
      layout,
    }));
    try {
      await updateDraftLayoutMutation.mutateAsync({ dashboardId, chartLayouts });
      setLocalLayoutOverrides({});
      return true;
    } catch (err) {
      console.error('Failed to flush draft layout:', err);
      return false;
    }
  };

  const handleSaveDraft = async () => {
    const ok = await flushLocalLayoutsToDraft();
    if (ok) {
      toast.success('Đã lưu nháp.');
    } else {
      toast.error('Lưu nháp thất bại — thử lại.');
    }
  };

  const handlePublish = async () => {
    // Flush any pending local edits into draft first, then publish.
    const ok = await flushLocalLayoutsToDraft();
    if (!ok) {
      toast.error('Không lưu được nháp — chưa thể xuất bản.');
      return;
    }
    try {
      await publishDashboardMutation.mutateAsync(dashboardId);
      toast.success('Đã xuất bản — public link cập nhật phiên bản mới.');
    } catch (err) {
      toast.error('Xuất bản thất bại — thử lại.');
    }
  };

  const handleDiscardAll = async () => {
    setLocalLayoutOverrides({});
    if (serverDashboard?.has_draft) {
      try {
        await discardDraftMutation.mutateAsync(dashboardId);
        toast.success('Đã quay lại phiên bản đã xuất bản.');
      } catch (err) {
        toast.error('Không huỷ được nháp BE — thử lại.');
      }
    }
  };

  const handleAddWidget = useCallback(
    async (widgetType: 'text' | 'countdown' | 'image' | 'shape' | 'parameter_switcher') => {
      if (!dashboard) return;
      const defaults: Record<string, any> = {
        text: { template: 'Hello {{today()}}', align: 'left', fontSize: 18 },
        countdown: { target: new Date(Date.now() + 7 * 86400000).toISOString(), label: 'Còn lại' },
        image: { url: '', fit: 'contain' },
        shape: { kind: 'rect', color: '#facc15' },
        parameter_switcher: {
          paramName: 'period',
          label: 'Chu kỳ',
          layout: 'tabs',
          options: [
            { label: 'YTD', value: 'YTD' },
            { label: 'Q1', value: 'Q1' },
            { label: 'Q2', value: 'Q2' },
          ],
        },
      };

      // Default footprint per widget type — picked so the widget is visible
      // immediately after dropping (a 4×2 grid cell is too short for text/countdown).
      const sizeByType: Record<string, { w: number; h: number; wPx: number; hPx: number }> = {
        text: { w: 4, h: 2, wPx: 360, hPx: 120 },
        countdown: { w: 4, h: 3, wPx: 360, hPx: 200 },
        image: { w: 4, h: 4, wPx: 360, hPx: 240 },
        shape: { w: 4, h: 1, wPx: 360, hPx: 80 },
        parameter_switcher: { w: 4, h: 2, wPx: 360, hPx: 120 },
      };
      const size = sizeByType[widgetType];

      // Compute next non-overlapping position on the active page.
      const sameMode = (dashboard.layout_mode ?? 'grid') === 'canvas' ? 'canvas' : 'grid';
      const charts = (dashboard.dashboard_charts ?? []).filter((dc) => {
        const dcPage = (dc.layout as any)?.pageId ?? null;
        return activePageId ? dcPage === activePageId : true;
      });

      let x = 0;
      let y = 0;
      let xPx = 24;
      let yPx = 24;
      let z = 100;

      if (sameMode === 'canvas' && charts.length > 0) {
        const maxBottom = charts.reduce((acc, dc) => {
          const l = dc.layout as any;
          const top = Number(l?.yPx ?? 0);
          const h = Number(l?.hPx ?? 240);
          return Math.max(acc, top + h);
        }, 0);
        const maxZ = charts.reduce((acc, dc) => {
          const lz = Number((dc.layout as any)?.z ?? 0);
          return Math.max(acc, lz);
        }, 0);
        xPx = 24;
        yPx = maxBottom + 16;
        z = maxZ + 1;
      } else if (sameMode === 'grid' && charts.length > 0) {
        const maxBottom = charts.reduce((acc, dc) => {
          const l = dc.layout as any;
          const top = Number(l?.y ?? 0);
          const h = Number(l?.h ?? 4);
          return Math.max(acc, top + h);
        }, 0);
        x = 0;
        y = maxBottom;
      }

      try {
        const updated = await dashboardApi.addWidget(
          dashboardId,
          widgetType,
          {
            x,
            y,
            w: size.w,
            h: size.h,
            xPx,
            yPx,
            wPx: size.wPx,
            hPx: size.hPx,
            z,
            pageId: activePageId ?? undefined,
          } as any,
          defaults[widgetType],
        );
        await queryClient.invalidateQueries({ queryKey: ['dashboards', dashboardId] });
        // Open edit modal for the freshly-created widget — auto-increment id
        // means the largest id in the response is the one we just inserted.
        const newest = (updated?.dashboard_charts ?? []).reduce<number | null>((acc, dc) => {
          if (dc.widget_type && dc.widget_type !== 'chart') {
            return acc === null || dc.id > acc ? dc.id : acc;
          }
          return acc;
        }, null);
        if (newest !== null) setEditingWidgetId(newest);
        toast.success(`Added ${widgetType.replace('_', ' ')} widget`);
      } catch (err) {
        console.error('Failed to add widget:', err);
        const detail = (err as any)?.response?.data?.detail;
        toast.error(typeof detail === 'string' ? detail : 'Failed to add widget. Please try again.');
      } finally {
        setIsWidgetMenuOpen(false);
      }
    },
    [dashboard, dashboardId, activePageId, queryClient],
  );

  const handleToggleLayoutMode = useCallback(async () => {
    if (!dashboard) return;
    const next = (dashboard.layout_mode ?? 'grid') === 'grid' ? 'canvas' : 'grid';
    try {
      await dashboardApi.update(dashboardId, { layout_mode: next });
      await updateDashboardMutation.mutateAsync({
        id: dashboardId,
        data: { layout_mode: next },
      }).catch(() => {});
    } catch (err) {
      console.error('Failed to toggle layout mode:', err);
    }
  }, [dashboard, dashboardId, updateDashboardMutation]);

  const handleCrossFilterChange = useCallback((sourceChartId: number, filter: BaseFilter | null) => {
    setCrossFilterState((current) => {
      if (!filter) {
        return current?.sourceChartId === sourceChartId ? null : current;
      }

      if (
        current?.sourceChartId === sourceChartId &&
        areFiltersEquivalent(current.filter, filter)
      ) {
        return null;
      }

      return {
        sourceChartId,
        filter,
      };
    });
  }, []);

  const handleAddChart = async (chartId: number, layout: DashboardChartLayout, parameters?: Record<string, any>) => {
    try {
      await addChartMutation.mutateAsync({
        dashboardId,
        chartId,
        layout: {
          ...layout,
          pageId: activePageId,
        },
        parameters,
      });
      setIsAddChartModalOpen(false);
    } catch (error) {
      console.error('Failed to add chart:', error);
      const detail = (error as any)?.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : 'Failed to add chart. Please try again.');
    }
  };

  const handleRemoveChart = (dashboardChartId: number) => {
    if (!dashboard) return;
    const dashboardChart = dashboard.dashboard_charts?.find((dc) => dc.id === dashboardChartId);
    if (!dashboardChart) return;
    setPendingRemoveDashboardChartId(dashboardChartId);
  };

  const handleRemoveChartFromManager = (dashboardChartId: number) => {
    setIsChartManagerOpen(false);
    handleRemoveChart(dashboardChartId);
  };

  const confirmRemoveChart = async () => {
    if (!dashboard || pendingRemoveDashboardChartId === undefined) return;
    const dashboardChart = dashboard.dashboard_charts?.find((dc) => dc.id === pendingRemoveDashboardChartId);
    if (!dashboardChart) return;

    setRemovingChartId(pendingRemoveDashboardChartId);
    setPendingRemoveDashboardChartId(undefined);
    try {
      await removeChartMutation.mutateAsync({
        dashboardId,
        dashboardChartId: dashboardChart.id,
      });
      toast.success('Chart removed from dashboard');
    } catch (error) {
      console.error('Failed to remove chart:', error);
      toast.error('Failed to remove chart. Please try again.');
    } finally {
      setRemovingChartId(undefined);
    }
  };

  const handleStartEditName = () => {
    if (dashboard) {
      setEditedName(dashboard.name);
      setIsEditingName(true);
    }
  };

  const handleSaveName = async () => {
    if (!editedName.trim()) return;

    try {
      await updateDashboardMutation.mutateAsync({
        id: dashboardId,
        data: { name: editedName },
      });
      setIsEditingName(false);
    } catch (error) {
      console.error('Failed to update dashboard name:', error);
      toast.error('Failed to update name. Please try again.');
    }
  };

  const handleCancelEditName = () => {
    setIsEditingName(false);
    setEditedName('');
  };

  // Phase-15.81 v12 — Apply filter slot edits.
  //
  // Two variants so DA doesn't pay a re-query bill they didn't ask for:
  //   • `scope='page'`  → push THIS page's draft to applied + stage
  //     pages_config draft. All-pages stays untouched.
  //   • `scope='all'`   → push BOTH scopes (all-pages + this-page)
  //     to applied + stage both draft fields in one round-trip.
  //
  // "Applied" here is the in-session state ChartTile reads from; chart
  // grid re-queries BigQuery only after this point. Persistence routes
  // through the dashboard's shared draft_snapshot so Publish flushes
  // filter + layout to the public link together (no longer writes
  // straight to live `filters_config` / `pages_config`).
  const handleApplyFilters = async (scope: 'page' | 'all') => {
    if (scope === 'all') {
      setAppliedGlobalFilters(draftGlobalFilters);
    }
    if (!canEditResource) {
      // Viewers still get the in-session apply but no DB write.
      return;
    }

    setIsApplyingFilters(true);
    try {
      // Build the payload for the draft endpoint. We always send the
      // FULL slot list for the scope being applied (including empty-
      // value slots — that's the DA-authored inventory).
      // Phase-C THẬT — slicers travel under their own key in the same
      // draft payload so a single Apply round-trip ships filter pane +
      // slicer edits together.
      const body: {
        filters_config?: BaseFilter[];
        slicers_config?: any[];
        slicer_cluster_layout?: Record<string, any>;
        pages_config?: any[];
      } = {};

      if (scope === 'all') {
        body.filters_config = draftGlobalFilters
          .map((f) => toBaseFilter(f, { allowInactive: true }))
          .filter((b): b is BaseFilter => b !== null);
        body.slicers_config = draftGlobalSlicers;
        setAppliedGlobalSlicers(draftGlobalSlicers);
        // Phase-G — ship cluster layout in the same Apply round-trip.
        if (draftSlicerClusterLayout) {
          body.slicer_cluster_layout = draftSlicerClusterLayout;
          setAppliedSlicerClusterLayout(draftSlicerClusterLayout);
        }
      }

      if (activePageId) {
        // Stage the new pages_config (full page array, with current
        // page's filters set to the draft set). For scope='all' this
        // still ships since the DA may have touched both scopes in
        // the same session.
        const nextPages = dashboardPages.map((p) => {
          if (p.id !== activePageId) return p;
          return draftPageFilters.length > 0
            ? { ...p, filters: draftPageFilters }
            // Strip the `filters` field when empty so Reset feels clean.
            : (() => { const { filters: _drop, ...rest } = p as any; return rest; })();
        });
        body.pages_config = nextPages;
        // Mirror locally so the editor state stays consistent until
        // refetch lands.
        setLocalPagesConfig(nextPages);
      }

      await dashboardApi.updateDraftFilters(dashboardId, body);
      // Refresh dashboard so draft overlay surfaces from server.
      queryClient.invalidateQueries({ queryKey: ['dashboards', dashboardId] });
      filtersSnapshotRef.current = JSON.stringify(draftGlobalFilters);
      toast.success(
        scope === 'all'
          ? 'Đã lưu nháp filter cho toàn dashboard. Bấm "Lưu & xuất bản" để công khai.'
          : 'Đã lưu nháp filter cho trang hiện tại.',
      );
    } catch (error) {
      console.error('Failed to save dashboard filters:', error);
      setLocalPagesConfig(null);
      toast.error('Applied in this session, but failed to save dashboard filters.');
    } finally {
      setIsApplyingFilters(false);
    }
  };

  // Phase-15.81 v11 — Reset abandons unsaved slot/value edits on BOTH
  // scopes by restoring from the last applied/server snapshot.
  const handleResetFilters = () => {
    setDraftGlobalFilters(appliedGlobalFilters);
    setDraftPageFilters(activePageFilters);
  };

  const persistPagesConfig = useCallback(async (pages: DashboardPageConfig[]) => {
    setLocalPagesConfig(pages);
    try {
      await updateDashboardMutation.mutateAsync({
        id: dashboardId,
        data: { pages_config: pages },
      });
    } catch (error) {
      setLocalPagesConfig(null);
      throw error;
    }
  }, [dashboardId, updateDashboardMutation]);

  const handleAddPage = async () => {
    const nextPage: DashboardPageConfig = {
      id: createDashboardPageId(),
      name: `Page ${dashboardPages.length + 1}`,
    };

    try {
      await persistPagesConfig([...dashboardPages, nextPage]);
      setCurrentPageId(nextPage.id);
      setEditingPageId(nextPage.id);
      setEditedPageName(nextPage.name);
      toast.success('Dashboard page added');
    } catch (error) {
      console.error('Failed to add dashboard page:', error);
      toast.error('Failed to add page. Please try again.');
    }
  };

  const handleStartRenamePage = () => {
    if (!currentPage) return;
    setEditingPageId(currentPage.id);
    setEditedPageName(currentPage.name);
  };

  const handleCancelRenamePage = () => {
    setEditingPageId(null);
    setEditedPageName('');
  };

  const handleSavePageName = async () => {
    if (!editingPageId) return;
    const trimmedName = editedPageName.trim();
    if (!trimmedName) return;

    const nextPages = dashboardPages.map((page) => (
      page.id === editingPageId ? { ...page, name: trimmedName } : page
    ));

    try {
      await persistPagesConfig(nextPages);
      setEditingPageId(null);
      setEditedPageName('');
      toast.success('Page renamed');
    } catch (error) {
      console.error('Failed to rename page:', error);
      toast.error('Failed to rename page. Please try again.');
    }
  };

  const confirmDeletePage = async () => {
    if (!pendingDeletePageId || dashboardPages.length <= 1 || !dashboard) {
      setPendingDeletePageId(null);
      return;
    }

    const fallbackPage = dashboardPages.find((page) => page.id !== pendingDeletePageId);
    if (!fallbackPage) {
      setPendingDeletePageId(null);
      return;
    }

    const chartsToMove = (dashboard.dashboard_charts ?? [])
      .filter((dashboardChart) => getDashboardChartPageId(dashboardChart.layout) === pendingDeletePageId)
      .map((dashboardChart) => ({
        id: dashboardChart.id,
        layout: {
          ...dashboardChart.layout,
          pageId: fallbackPage.id,
        },
      }));

    try {
      if (chartsToMove.length > 0) {
        await updateLayoutMutation.mutateAsync({
          dashboardId,
          chartLayouts: chartsToMove,
        });
      }
      await persistPagesConfig(dashboardPages.filter((page) => page.id !== pendingDeletePageId));
      if (activePageId === pendingDeletePageId) {
        setCurrentPageId(fallbackPage.id);
      }
      setEditingPageId((current) => current === pendingDeletePageId ? null : current);
      toast.success('Page deleted');
    } catch (error) {
      console.error('Failed to delete page:', error);
      toast.error('Failed to delete page. Please try again.');
    } finally {
      setPendingDeletePageId(null);
    }
  };

  const handleMoveChartToPage = async (dashboardChartId: number, pageId: string) => {
    if (!dashboard) return;
    const dashboardChart = dashboard.dashboard_charts?.find((item) => item.id === dashboardChartId);
    if (!dashboardChart) return;
    if (getDashboardChartPageId(dashboardChart.layout) === pageId) return;

    try {
      await updateLayoutMutation.mutateAsync({
        dashboardId,
        chartLayouts: [{
          id: dashboardChartId,
          layout: {
            ...dashboardChart.layout,
            pageId,
          },
        }],
      });
      toast.success('Chart moved to another page');
    } catch (error) {
      console.error('Failed to move chart to page:', error);
      const detail = (error as any)?.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : 'Failed to move chart. Please try again.');
    }
  };

  // Collect typed column info from chart data as charts load
  // Only dimension/breakdown fields are eligible for the global filter bar
  const handleChartDataLoaded = useCallback((
    chartId: number,
    data: Record<string, any>[],
    meta: { dimensionFields: string[] },
  ) => {
    if (!data.length) return;
    // If we have explicit dimension fields, only expose those to the global bar
    const fields = meta.dimensionFields.length > 0
      ? meta.dimensionFields.filter(f => f in data[0])
      : Object.keys(data[0]);
    const incoming: ColumnInfo[] = fields.map(name => ({
      name,
      type: inferColumnTypeFromData(name, data),
    }));
    // Update per-column chart counts
    const tracker = columnChartCountRef.current;
    incoming.forEach(c => {
      if (!tracker.has(c.name)) tracker.set(c.name, new Set());
      tracker.get(c.name)!.add(chartId);
    });
    setColumnChartCount(new Map(Array.from(tracker.entries()).map(([k, s]) => [k, s.size])));
    setAvailableColumns(prev => {
      const map = new Map(prev.map(c => [c.name, c]));
      incoming.forEach(c => { if (!map.has(c.name)) map.set(c.name, c); });
      const merged = Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
      if (merged.length === prev.length) return prev;
      return merged;
    });

    // Collect distinct values per column for PowerBI-style multi-select filters
    const dvRef = distinctValuesRef.current;
    let dvChanged = false;
    for (const field of fields) {
      if (!dvRef.has(field)) { dvRef.set(field, new Set()); dvChanged = true; }
      const set = dvRef.get(field)!;
      const prevSize = set.size;
      for (const row of data) {
        const val = row[field];
        if (val !== null && val !== undefined && String(val) !== '') {
          set.add(String(val));
        }
      }
      if (set.size !== prevSize) dvChanged = true;
    }
    if (dvChanged) {
      const result: Record<string, string[]> = {};
      dvRef.forEach((set, field) => { result[field] = Array.from(set).sort(); });
      setDistinctValues(result);
    }
  }, []);

  const semanticColumnsResult = React.useMemo(() => {
    const columns = new Map<string, ColumnInfo>();
    const counts = new Map<string, Set<number>>();
    const datasetJoinKeyFields = new Map<number, Set<string>>();
    const totalDashboardChartCount = dashboard?.dashboard_charts?.length ?? 0;

    for (const [datasetId, model] of datasetModelsById.entries()) {
      datasetJoinKeyFields.set(datasetId, collectJoinKeySemanticFields(model));
    }

    for (const dashboardChart of dashboard?.dashboard_charts ?? []) {
      const binding = (dashboardChart.chart?.config as any)?.semanticBinding as
        | {
            datasetId?: number;
            dimensionFields?: string[];
            fieldMap?: Record<string, string>;
            reachableFields?: string[];
          }
        | undefined;

      if (!binding?.datasetId) continue;

      const model = datasetModelsById.get(binding.datasetId);
      if (!model) continue;

      const viewsByName = new Map(model.views.map((view) => [view.name, view]));
      const joinKeyFields = datasetJoinKeyFields.get(binding.datasetId) ?? new Set<string>();
      // Prefer reachableFields (multi-hop, reflects join graph) when present.
      // This matches PowerBI/Looker semantics: a chart can be filtered by any
      // field reachable through the data model joins, not only the dimensions
      // currently rendered on the chart.
      const candidateFields = binding.reachableFields?.length
        ? binding.reachableFields
        : (binding.dimensionFields?.length
            ? binding.dimensionFields
            : Object.values(binding.fieldMap ?? {}));

      for (const semanticField of candidateFields) {
        const parts = splitSemanticField(semanticField);
        if (!parts) continue;
        const [viewName, fieldName] = parts;
        const view = viewsByName.get(viewName);
        const dimension = view?.dimensions.find((item) => item.name === fieldName);
        if (!isSemanticDimensionFilterableForDashboard({
          semanticField,
          view,
          dimension,
          joinKeyFields,
        })) continue;
        if (!view || !dimension) continue;
        const key = semanticField;
        if (!columns.has(key)) {
          columns.set(key, {
            key,
            name: fieldName,
            label: getFriendlyFieldLabel(dimension.label ?? fieldName),
            tableLabel: view.table_display_name ?? view.name,
            type: resolveDimensionFilterType(dimension.type, fieldName),
            datasetId: binding.datasetId,
            datasetName: model.dataset_name,
            semanticField,
          });
        }
        if (!counts.has(key)) counts.set(key, new Set());
        counts.get(key)!.add(dashboardChart.chart_id);
      }
    }

    const sortedColumns = Array.from(columns.values())
      .map((column) => {
        const key = getColumnKey(column);
        const chartCoverage = counts.get(key)?.size ?? 0;
        return {
          ...column,
          chartCoverage,
          datasetChartCount: totalDashboardChartCount,
          sharedAcrossDataset: totalDashboardChartCount > 0 && chartCoverage === totalDashboardChartCount,
        };
      })
      .sort((left, right) => {
        const leftShared = left.sharedAcrossDataset ? 1 : 0;
        const rightShared = right.sharedAcrossDataset ? 1 : 0;
        if (leftShared !== rightShared) return rightShared - leftShared;
        if ((left.chartCoverage ?? 0) !== (right.chartCoverage ?? 0)) {
          return (right.chartCoverage ?? 0) - (left.chartCoverage ?? 0);
        }
        if ((left.datasetChartCount ?? 0) !== (right.datasetChartCount ?? 0)) {
          return (right.datasetChartCount ?? 0) - (left.datasetChartCount ?? 0);
        }
        return (left.label ?? left.name).localeCompare(right.label ?? right.name);
      });

    return {
      columns: sortedColumns,
      chartCount: new Map(Array.from(counts.entries()).map(([key, ids]) => [key, ids.size])),
    };
  }, [dashboard?.dashboard_charts, datasetModelsById]);

  const calendarDateColumns = React.useMemo<ColumnInfo[]>(() => {
    const totalDashboardChartCount = dashboard?.dashboard_charts?.length ?? 0;
    // Collect EVERY semantic date/datetime field reachable from each chart
    // — not just explicit calendarFieldMappings. The previous behaviour
    // silently excluded any chart that lacked a calendar mapping, which is
    // why BA reported "17/37 charts không chịu tác động bởi filter Date".
    // The single global "Date" filter still acts as one logical control;
    // its linkedFields fan out to every concrete semantic date field so
    // ChartTile can resolve a matching field per chart via the existing
    // canDeferFilterToChartSemanticBinding contract.
    //
    // Phase-15.81 v14 — primary semantic field MUST be a Date-dimension
    // (calendar table), NOT a fact table's date column. Previous code
    // alphabetically sorted ALL discovered date fields and took the
    // first → in a dataset where `bc_activity` (fact) sorts before
    // `dim_date`, the filter ended up bound to `bc_activity.Date` so
    // every query LEFT JOIN'd through the fact and dropped the calendar
    // semantics. Two-bucket separation now:
    //   • calendar (Path A + name match) → eligible primary
    //   • fact     (Path B only)         → linkedFields fan-out only
    const calendarSemanticFields = new Set<string>();
    const factSemanticFields = new Set<string>();
    const chartsWithDate = new Set<number>();
    const datasetIds = new Set<number>();

    // Phase-15.81 v17 — calendar-table detection now uses TWO signals
    // instead of relying solely on view-name patterns:
    //
    //   1. Name pattern (cheap, high precision): `date`, `calendar`,
    //      `dim_date*`, `d_date*`, `date_dim*`, `calendar_*`,
    //      `*_calendar`, `*_date_dim`, `bc_date`, `fact_date_*` (rare
    //      but DAs use these too).
    //   2. Date-column density (catches DA-named calendar tables that
    //      don't match the patterns): a true calendar dim table
    //      typically exposes 8+ date/datetime columns (date, year,
    //      quarter, month, week, day_of_month, month_start_date,
    //      week_end_date, ISO_week, …). Fact tables usually have 1–4
    //      (created_at, updated_at, deleted_at, occasionally one
    //      domain timestamp). The cut-off is loose on purpose — pure
    //      fact tables almost never cross 6 date columns, while
    //      calendar tables comfortably do.
    //
    // Either signal is sufficient. The DA-reported bug ("Date filter
    // mapped to fact_act") happened because the fact table sorted
    // alphabetically before any calendar table whose name didn't
    // match the v14 patterns. Density signal catches that case.
    const CALENDAR_NAME_PATTERN = /(^|_)(dim_date|d_date|date_dim|calendar)(_|$)|^date$|^calendar$|(_|^)bc_date(_|$)|(_|^)fact_date(_|$)/i;
    const CALENDAR_DATE_COUNT_THRESHOLD = 6;

    const calendarViewsByDataset = new Map<number, Set<string>>();
    for (const [datasetId, model] of datasetModelsById.entries()) {
      const calendarViews = new Set<string>();
      for (const view of model.views ?? []) {
        const viewName = String(view.name || '').trim();
        if (!viewName) continue;
        let dateColumnCount = 0;
        for (const dim of view.dimensions ?? []) {
          const dimType = String(dim.type ?? '').toLowerCase();
          const isDateType = dimType === 'date' || dimType === 'datetime';
          if (isDateType || nameSuggestsDate(dim.name ?? '')) {
            dateColumnCount += 1;
          }
        }
        const matchesName = CALENDAR_NAME_PATTERN.test(viewName);
        const dense = dateColumnCount >= CALENDAR_DATE_COUNT_THRESHOLD;
        if (matchesName || dense) {
          calendarViews.add(viewName);
        }
      }
      calendarViewsByDataset.set(datasetId, calendarViews);
    }

    const isCalendarViewName = (viewName: string, datasetId?: number): boolean => {
      const n = String(viewName || '').trim();
      if (!n) return false;
      if (datasetId != null) {
        const set = calendarViewsByDataset.get(datasetId);
        if (set && set.has(n)) return true;
      }
      // Cross-dataset fallback (multi-dataset dashboards) — pure name
      // match. Avoids losing detection when we don't know which
      // dataset the view belongs to in the calling context.
      return CALENDAR_NAME_PATTERN.test(n);
    };

    // Collect date/datetime dimension names from every dataset model.
    // v14 — also accept fields whose stored type is `string` but whose
    // name strongly suggests a date column (DA forgot to set the type
    // in the data model UI).
    const dateDimensionFieldsByDataset = new Map<number, Set<string>>();
    for (const [datasetId, model] of datasetModelsById.entries()) {
      const dateFields = new Set<string>();
      for (const view of model.views ?? []) {
        for (const dim of view.dimensions ?? []) {
          const dimType = String(dim.type ?? '').toLowerCase();
          const isDateType = dimType === 'date' || dimType === 'datetime';
          const looksLikeDate = !isDateType && nameSuggestsDate(dim.name ?? '');
          if (isDateType || looksLikeDate) {
            dateFields.add(`${view.name}.${dim.name}`);
          }
        }
      }
      dateDimensionFieldsByDataset.set(datasetId, dateFields);
    }

    for (const dashboardChart of dashboard?.dashboard_charts ?? []) {
      const binding = (dashboardChart.chart?.config as any)?.semanticBinding as
        | {
            datasetId?: number;
            dimensionFields?: string[];
            measureFields?: string[];
            fieldMap?: Record<string, string>;
            reachableFields?: string[];
            calendarFieldMappings?: Array<{
              semanticField?: string;
              calendarField?: string;
              sourceField?: string;
            }>;
          }
        | undefined;

      if (binding?.datasetId != null) {
        datasetIds.add(binding.datasetId);
      }

      let chartHasDate = false;

      // Path A (legacy): explicit calendar mappings — these are
      // ALWAYS calendar-table fields (DA wired them up specifically).
      for (const mapping of binding?.calendarFieldMappings ?? []) {
        if (mapping?.calendarField !== 'date') continue;
        const sf = mapping.semanticField;
        if (typeof sf === 'string' && sf.includes('.')) {
          calendarSemanticFields.add(sf);
          chartHasDate = true;
        }
      }

      // Path B (new): any date/datetime semantic dimension reachable
      // from the chart. Split into calendar vs fact buckets via the
      // view-name heuristic so the primary stays on a date dim.
      const datasetId = binding?.datasetId;
      const dateFieldsForDataset = datasetId != null
        ? dateDimensionFieldsByDataset.get(datasetId) ?? new Set<string>()
        : new Set<string>();
      if (dateFieldsForDataset.size > 0) {
        const candidates = new Set<string>([
          ...(binding?.dimensionFields ?? []),
          ...(binding?.measureFields ?? []),
          ...(Object.values(binding?.fieldMap ?? {}).filter(
            (v): v is string => typeof v === 'string' && v.includes('.'),
          )),
          ...(binding?.reachableFields ?? []),
        ]);
        for (const candidate of candidates) {
          if (!dateFieldsForDataset.has(candidate)) continue;
          const [viewName] = candidate.split('.', 1);
          if (isCalendarViewName(viewName, datasetId)) {
            calendarSemanticFields.add(candidate);
          } else {
            factSemanticFields.add(candidate);
          }
          chartHasDate = true;
        }
      }

      if (chartHasDate) {
        chartsWithDate.add(dashboardChart.chart_id);
      }
    }

    // Build the final ordered list: calendar fields first (primary
    // candidates), then fact fields as linkedFields fan-out.
    //
    // Phase-15.81 v19 — only emit the composite "Date" entry when a
    // calendar bucket exists. Earlier code fell back to the first
    // fact-table date column when there was no calendar dim. That
    // ended up creating one composite that fanned out across every
    // unrelated date column in every fact table — when DA clicked
    // it, the resulting WHERE merged 30+ BETWEEN predicates that the
    // BE refused (400). Without a calendar dim there's no logical
    // primary to anchor a global Date filter on, so let the DA pick
    // the per-table date column they actually want from the field
    // section instead.
    const orderedCalendarFields = Array.from(calendarSemanticFields).sort();
    if (orderedCalendarFields.length === 0) return [];

    const orderedFactFields = Array.from(factSemanticFields)
      .filter((f) => !calendarSemanticFields.has(f))
      .sort();
    const orderedSemanticFields = [...orderedCalendarFields, ...orderedFactFields];

    // Pick primary from the calendar bucket — guaranteed to exist
    // because of the early return above.
    const primarySemanticField = orderedCalendarFields[0];
    const linkedFields = orderedSemanticFields.filter((f) => f !== primarySemanticField);
    const [primaryViewName, primaryFieldName] = primarySemanticField.split('.', 2);
    const firstDatasetId = datasetIds.size === 1 ? Array.from(datasetIds)[0] : undefined;
    const firstModel = firstDatasetId ? datasetModelsById.get(firstDatasetId) : undefined;
    const primaryView = firstModel?.views.find((view) => view.name === primaryViewName);
    // Phase-15.81 v18 — resolve the primary field's actual dimension
    // label so the picker row reads correctly. Previously the entry
    // was hard-coded `name='date'` + `label='Date'`, which DAs read as
    // "the bc_activity table has a Date column" — they don't. The
    // entry is a composite slot that fans out across every reachable
    // date column; surfacing the primary field's real name + table
    // makes the binding visible at a glance.
    const primaryDimension = primaryView?.dimensions.find((d) => d.name === primaryFieldName);
    const primaryLabel = getFriendlyFieldLabel(primaryDimension?.label ?? primaryFieldName ?? 'date');

    return [{
      key: primarySemanticField,
      name: primaryFieldName || 'date',
      label: primaryLabel || 'Date',
      tableLabel: primaryView?.table_display_name ?? primaryView?.name,
      type: 'date',
      semanticField: primarySemanticField,
      datasetId: firstDatasetId,
      datasetName: firstModel?.dataset_name,
      defaultLinkedFields: linkedFields,
      chartCoverage: chartsWithDate.size,
      datasetChartCount: totalDashboardChartCount,
      sharedAcrossDataset: totalDashboardChartCount > 0 && chartsWithDate.size === totalDashboardChartCount,
    }];
  }, [dashboard?.dashboard_charts, datasetModelsById]);

  React.useEffect(() => {
    const dateColumn = calendarDateColumns[0] ?? null;
    if (!dateColumn) return;

    setDraftGlobalFilters((current) => {
      const next = current.map((filter) => normalizeLegacyDateFilter(filter, dateColumn));
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
    setAppliedGlobalFilters((current) => {
      const next = current.map((filter) => normalizeLegacyDateFilter(filter, dateColumn));
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
  }, [calendarDateColumns]);

  const activeSemanticDistinctTargets = React.useMemo(() => {
    // Phase-15.81 v11 — quét cả 2 scope ở trạng thái DRAFT (cả
    // all-pages và this-page). Trước đây quét applied/server-persisted
    // page filters → card vừa kéo vào "Filters on this page" chưa
    // Apply không có distinct values, checklist trống. Project draft
    // với allowInactive=true để giữ slot rỗng (DA chưa chọn value).
    // Phase-C THẬT — slicers (Dashboard.slicers_config) cũng là filter
    // active trên page khi đã được Apply, nên cũng tham gia vào
    // distinct-values context để dropdown cascade đúng. Bỏ qua nhánh
    // này là inconsistency với public viewer (memory
    // `dashboard_filter_dual_path` từng cảnh báo 2 nhánh distinct
    // values lệch nhau gây bug khó tìm).
    const legacyDraftAll = draftGlobalFilters
      .map((f) => toBaseFilter(f, { allowInactive: true }))
      .filter((b): b is BaseFilter => b !== null);
    const combinedFilters: BaseFilter[] = [
      ...legacyDraftAll,
      ...draftPageFilters,
      ...draftGlobalSlicers,
    ];

    if (semanticColumnsResult.columns.length === 0 || combinedFilters.length === 0) {
      return [];
    }

    const columnsByKey = new Map(
      semanticColumnsResult.columns.map((column) => [getColumnKey(column), column]),
    );
    const activeColumns = new Map<string, ColumnInfo>();

    for (const filter of combinedFilters) {
      const key = getFilterKey(filter);
      const column = columnsByKey.get(key);
      if (!column?.datasetId || !column.semanticField) continue;
      if (column.type !== 'dropdown' && column.type !== 'text') continue;
      activeColumns.set(key, column);
    }

    return Array.from(activeColumns.values()).map((column) => {
      const filterContext = getDistinctValueFilterContext(combinedFilters, column);
      return {
        column,
        filterContext,
        filterContextKey: JSON.stringify(filterContext),
      };
    });
  }, [draftGlobalFilters, draftPageFilters, draftGlobalSlicers, semanticColumnsResult.columns]);

  const semanticDistinctQueries = useQueries({
    queries: activeSemanticDistinctTargets.map(({ column, filterContext, filterContextKey }) => ({
      queryKey: [...modelKeys.distinct(column.datasetId!, column.semanticField!), 'filters', filterContextKey],
      queryFn: () => fetchDatasetModelDistinctValues(column.datasetId!, column.semanticField!, 200, filterContext),
      enabled: Boolean(column.datasetId && column.semanticField),
      staleTime: 5 * 60 * 1000,
      // Phase-15.95 — cap retries so a recurring 500 (e.g. unsupported
      // CTE inside EXISTS, BQ syntax issue) shows the empty-values
      // state quickly instead of looking like a hang for ~15s default
      // backoff × 3 retries.
      retry: 1,
      retryDelay: 1000,
    })),
  });

  const semanticDistinctValues = React.useMemo(() => {
    const values: Record<string, string[]> = {};
    activeSemanticDistinctTargets.forEach(({ column }, index) => {
      values[getColumnKey(column)] = semanticDistinctQueries[index]?.data?.values ?? [];
    });
    return values;
  }, [activeSemanticDistinctTargets, semanticDistinctQueries]);

  // Phase-15.94 — cascading dropped filters surfaced by BE so the
  // FilterCard can render an explicit banner instead of silently
  // showing a shorter values list. Keyed by columnKey.
  const semanticDistinctDroppedFilters = React.useMemo(() => {
    const dropped: Record<string, Array<{ field: string; reason: string; detail?: string }>> = {};
    activeSemanticDistinctTargets.forEach(({ column }, index) => {
      const list = semanticDistinctQueries[index]?.data?.dropped_filters;
      if (Array.isArray(list) && list.length > 0) {
        dropped[getColumnKey(column)] = list as Array<{ field: string; reason: string; detail?: string }>;
      }
    });
    return dropped;
  }, [activeSemanticDistinctTargets, semanticDistinctQueries]);

  // Phase-15.81 v19 — keep date columns in the field picker AS WELL
  // AS surfacing them via the composite "Date" entry. Previously
  // `column.type !== 'date'` hid every date column entirely; DA who
  // wanted to bind a single-table date filter (e.g. only filter the
  // calendar table's `date` without fanning out to every fact's
  // timestamp) had no way to reach it. Drop only the field that
  // backs the composite entry to avoid showing the same row twice.
  const compositeDateKey = calendarDateColumns[0]?.key;
  const semanticFieldColumns = React.useMemo(
    () => semanticColumnsResult.columns.filter((column) => {
      // Hide ONLY the field that the composite "Date" entry already
      // represents — every other date column stays visible.
      return getColumnKey(column) !== compositeDateKey;
    }),
    [semanticColumnsResult.columns, compositeDateKey],
  );
  const semanticFilterChartCount = React.useMemo(() => {
    const next = new Map(semanticColumnsResult.chartCount);
    calendarDateColumns.forEach((column) => {
      next.set(getColumnKey(column), column.chartCoverage ?? 0);
    });
    return next;
  }, [semanticColumnsResult.chartCount, calendarDateColumns]);
  const hasSemanticFilterColumns = calendarDateColumns.length > 0 || semanticFieldColumns.length > 0;

  const resolvedAvailableColumns = hasSemanticFilterColumns
    ? [...calendarDateColumns, ...semanticFieldColumns]
    : availableColumns;
  const resolvedColumnChartCount = hasSemanticFilterColumns
    ? semanticFilterChartCount
    : columnChartCount;
  const resolvedDistinctValues = hasSemanticFilterColumns
    ? semanticDistinctValues
    : distinctValues;

  if (isLoadingDashboard) {
    return (
      <div className="min-h-full bg-surface-2">
        <div className="w-full px-8 py-6">
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-brand" />
            <span className="ml-2">Loading dashboard...</span>
          </div>
        </div>
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="min-h-full bg-surface-2">
        <div className="w-full px-8 py-6">
          <div className="rounded-lg border border-[rgb(var(--border-line))] bg-surface-1 p-12 text-center shadow-linear-sm">
            <p className="text-text-tertiary">Dashboard not found</p>
            <Link
              href="/dashboards"
              className="inline-flex items-center text-brand hover:text-brand mt-4"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Dashboards
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const activeCrossFilter = crossFilterState?.filter ?? null;

  const handleExportPdf = async () => {
    const el = dashboardContentRef.current;
    if (!el) return;
    setIsExportingPdf(true);
    try {
      const safeName = (dashboard.name || 'dashboard').replace(/[^a-zA-Z0-9_\-\s]/g, '').trim();

      if (dashboardPages.length <= 1) {
        // Single page — capture the visible content
        const { exportElementToPdf } = await import('@/lib/export-pdf');
        await exportElementToPdf(el, `${safeName}.pdf`);
      } else {
        // Multi-page: switch page, wait, capture, repeat
        const { captureAndBuildPdf } = await import('@/lib/export-pdf');
        const originalPageId = activePageId;

        await captureAndBuildPdf(dashboardPages.length, async (pageIndex) => {
          const page = dashboardPages[pageIndex];
          // Only switch if not already on this page
          if (page.id !== activePageId || pageIndex > 0) {
            setCurrentPageId(page.id);
          }
          // Wait for grid to stabilise after page switch
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => {
              setTimeout(resolve, 800);
            }));
          });
          return dashboardContentRef.current;
        }, `${safeName}.pdf`);

        // Restore original page without animation
        setCurrentPageId(originalPageId);
      }
    } catch (err) {
      console.error('PDF export failed', err);
      toast.error('Failed to export PDF');
    } finally {
      setIsExportingPdf(false);
    }
  };

  const isRenamingCurrentPage = editingPageId === currentPage?.id;
  const emptyPageMessage = currentPage
    ? `No charts on ${currentPage.name} yet. Add a chart to start this page.`
    : 'No charts in this dashboard yet.';
  const fallbackDeletePage = pendingDeletePageId
    ? dashboardPages.find((page) => page.id !== pendingDeletePageId) ?? null
    : null;
  const activeCrossFilterSourceTitle = crossFilterState
    ? (visibleDashboardCharts.find((dc) => dc.chart_id === crossFilterState.sourceChartId)?.layout?.custom_title
      ?? visibleDashboardCharts.find((dc) => dc.chart_id === crossFilterState.sourceChartId)?.chart?.name
      ?? `Chart ${crossFilterState.sourceChartId}`)
    : null;

  return (
    <DashboardThemeProvider theme={dashboard?.theme_config} className="min-h-full bg-surface-2">
      {/* ── Sticky compact header (single row) ── */}
      <div className="sticky top-0 z-20 bg-surface-2 px-4 pt-3 pb-2 sm:px-6 lg:px-8">
        <div className="rounded-xl border border-[rgba(255,255,255,0.08)] bg-surface-1 shadow-linear-sm overflow-visible">

          <div className="flex h-11 items-center gap-2 px-3">
            {/* Back */}
            <Link
              href="/dashboards"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-secondary"
              title="Back to Dashboards"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>

            <div className="h-4 w-px bg-[rgba(255,255,255,0.08)]" />

            {/* Title (inline edit) */}
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {isEditingName ? (
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <input
                    type="text"
                    value={editedName}
                    onChange={(e) => setEditedName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveName();
                      if (e.key === 'Escape') handleCancelEditName();
                    }}
                    className="min-w-0 flex-1 rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-2 py-1 text-[14px] font-[590] text-text-primary focus:outline-none focus:ring-1 focus:ring-brand"
                    autoFocus
                  />
                  <button
                    onClick={handleSaveName}
                    disabled={updateDashboardMutation.isPending}
                    className="rounded-md p-1 text-success hover:bg-success/10"
                    title="Save"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={handleCancelEditName}
                    className="rounded-md p-1 text-text-tertiary hover:bg-[rgba(255,255,255,0.04)]"
                    title="Cancel"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <>
                  <h1 className="truncate text-[14px] font-[590] tracking-[-0.182px] text-text-primary">
                    {dashboard.name}
                  </h1>
                  {canEditResource && (
                    <button
                      onClick={handleStartEditName}
                      className="rounded-md p-1 text-text-quaternary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-secondary"
                      title="Rename dashboard"
                    >
                      <Edit2 className="h-3 w-3" />
                    </button>
                  )}

                  {/* Inline page-rename input (active when isRenamingCurrentPage) */}
                  {canEditResource && isRenamingCurrentPage && (
                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        value={editedPageName}
                        onChange={(e) => setEditedPageName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSavePageName();
                          if (e.key === 'Escape') handleCancelRenamePage();
                        }}
                        className="min-w-[140px] rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-2 py-0.5 text-[12px] font-[510] text-text-primary focus:outline-none focus:ring-1 focus:ring-brand"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={handleSavePageName}
                        className="rounded-md p-1 text-success hover:bg-success/10"
                        title="Save page name"
                      >
                        <Check className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={handleCancelRenamePage}
                        className="rounded-md p-1 text-text-tertiary hover:bg-[rgba(255,255,255,0.04)]"
                        title="Cancel"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  )}

                  {/* Pages dropdown — replaces the old pages row */}
                  {!isRenamingCurrentPage && dashboardPages.length > 0 && (
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => { setIsPagesMenuOpen((v) => !v); setIsMoreMenuOpen(false); }}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-2 text-[12px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                        title="Switch page"
                      >
                        <span className="max-w-[10rem] truncate">{currentPage?.name ?? 'Page'}</span>
                        <span className="text-text-quaternary">· {dashboardPages.length}</span>
                        <ChevronDown className="h-3 w-3" />
                      </button>
                      {isPagesMenuOpen && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setIsPagesMenuOpen(false)} />
                          <div className="absolute left-0 z-50 mt-1.5 w-64 overflow-hidden rounded-lg border border-[rgba(255,255,255,0.12)] bg-surface-1 py-1 shadow-[0_4px_24px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,255,255,0.06)]">
                            <div className="max-h-[60vh] overflow-y-auto">
                              {dashboardPages.map((page) => {
                                const isActive = page.id === activePageId;
                                return (
                                  <button
                                    key={page.id}
                                    type="button"
                                    onClick={() => { setCurrentPageId(page.id); setIsPagesMenuOpen(false); }}
                                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-[510] transition-colors ${
                                      isActive
                                        ? 'bg-[rgba(94,106,210,0.15)] text-brand'
                                        : 'text-text-secondary hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary'
                                    }`}
                                  >
                                    <span className="flex-1 truncate">{page.name}</span>
                                    {isActive && <Check className="h-3 w-3" />}
                                  </button>
                                );
                              })}
                            </div>
                            {canEditResource && (
                              <>
                                <div className="mx-3 my-1 border-t border-[rgba(255,255,255,0.06)]" />
                                <button
                                  onClick={() => { handleStartRenamePage(); setIsPagesMenuOpen(false); }}
                                  className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                                >
                                  <Edit2 className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                                  Rename current page
                                </button>
                                <button
                                  onClick={() => { setPendingDeletePageId(activePageId); setIsPagesMenuOpen(false); }}
                                  disabled={dashboardPages.length <= 1}
                                  className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-secondary"
                                >
                                  <Trash2 className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                                  Delete current page
                                </button>
                                <button
                                  onClick={() => { handleAddPage(); setIsPagesMenuOpen(false); }}
                                  className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                                >
                                  <Plus className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                                  Add page
                                </button>
                              </>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                  {dashboard.description && (
                    <>
                      <span className="text-text-quaternary">·</span>
                      <span className="hidden truncate text-[13px] font-[400] text-text-tertiary md:inline" title={dashboard.description}>
                        {dashboard.description}
                      </span>
                    </>
                  )}
                  {/* Phase-15.66 — Manual save UX (no auto-save).
                      Drag/resize chỉ update local state → no network call
                      → mượt. 3 button: Lưu nháp / Lưu & xuất bản / Huỷ.

                      States surfaced:
                      • Có local change (chưa save BE) → badge "Chưa lưu"
                      • Server has_draft=true → badge "Bản nháp"
                      • Cả 2 → badge "Chưa lưu (có cả bản nháp BE)" */}
                  {canEditResource && hasAnyPendingChanges && (
                    <div className="ml-2 flex shrink-0 items-center gap-1.5">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-[600] uppercase tracking-wide ${
                          hasLocalLayoutChanges
                            ? 'bg-warning/20 text-warning'
                            : 'bg-warning/10 text-warning'
                        }`}
                        title={
                          hasLocalLayoutChanges
                            ? 'Có thay đổi chưa lưu — nhấn Lưu nháp hoặc Lưu & xuất bản để giữ.'
                            : 'Có bản nháp đã lưu chưa xuất bản. Share link vẫn dùng bản cũ.'
                        }
                      >
                        {hasLocalLayoutChanges ? 'Chưa lưu' : 'Bản nháp'}
                      </span>
                      <button
                        type="button"
                        onClick={handleSaveDraft}
                        disabled={
                          !hasLocalLayoutChanges
                          || updateDraftLayoutMutation.isPending
                        }
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-2.5 text-[12px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] disabled:opacity-50"
                        title="Lưu bản nháp lên server (share link vẫn dùng bản đã xuất bản gần nhất)"
                      >
                        {updateDraftLayoutMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        Lưu nháp
                      </button>
                      <button
                        type="button"
                        onClick={handlePublish}
                        disabled={
                          publishDashboardMutation.isPending
                          || updateDraftLayoutMutation.isPending
                        }
                        className="inline-flex h-7 items-center gap-1 rounded-md bg-brand px-2.5 text-[12px] font-[510] text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
                        title="Áp dụng thay đổi lên public share link"
                      >
                        {publishDashboardMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        Lưu & xuất bản
                      </button>
                      <button
                        type="button"
                        onClick={() => setIsDiscardConfirmOpen(true)}
                        disabled={discardDraftMutation.isPending}
                        className="inline-flex h-7 items-center rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-2 text-[12px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] disabled:opacity-50"
                        title="Bỏ thay đổi, quay về bố cục đã xuất bản"
                      >
                        Huỷ
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Primary actions — collapsed to [Filter] [⋯] [+ Add] */}
            <div className="flex shrink-0 items-center gap-1">
              {/* Filter pane toggle (Phase-15.81).
                  Opens the right-dock FilterPane sidebar instead of the
                  old popover. Active state when pane is open OR when
                  filters are applied. */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => { setIsFilterPaneOpen((v) => !v); setIsMoreMenuOpen(false); setIsPagesMenuOpen(false); }}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] font-[510] transition-colors ${
                    isFilterPaneOpen
                      ? 'border-brand/40 bg-brand/15 text-brand'
                      : appliedGlobalFilters.length > 0
                        ? 'border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] text-brand hover:bg-[rgba(255,255,255,0.04)]'
                        : 'border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] text-text-secondary hover:bg-[rgba(255,255,255,0.04)]'
                  }`}
                  title={isFilterPaneOpen ? 'Hide Filter Pane' : 'Show Filter Pane'}
                >
                  <Filter className="h-3 w-3" />
                  <span>Filters</span>
                  {appliedGlobalFilters.length > 0 && (
                    <span className="rounded-full bg-brand/20 px-1.5 text-[10px] font-[600] leading-[1.4] text-brand">
                      {appliedGlobalFilters.length}
                    </span>
                  )}
                  {hasPendingFilterChanges && (
                    <span className="h-1.5 w-1.5 rounded-full bg-warning" title="Unapplied changes" />
                  )}
                </button>
                {/* Phase-15.81 — popover removed. Filter editing lives in
                    the right-dock FilterPane (see the aside at the bottom
                    of the content area). */}
              </div>

              {/* More menu — gathers Export, Share, Public links, Theme, Switch layout, Manage, Import, Widgets */}
              <div className="relative">
                <button
                  onClick={() => { setIsMoreMenuOpen((v) => !v); setIsFilterPopoverOpen(false); setIsPagesMenuOpen(false); setIsWidgetSubmenuOpen(false); }}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)]"
                  title="More options"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>

                {isMoreMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => { setIsMoreMenuOpen(false); setIsWidgetSubmenuOpen(false); }} />
                    <div className="absolute right-0 z-50 mt-1.5 w-56 overflow-y-auto max-h-[80vh] rounded-lg border border-[rgba(255,255,255,0.12)] bg-surface-1 py-1 shadow-[0_4px_24px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,255,255,0.06)]">
                      {/* Export */}
                      <button
                        onClick={() => { handleExportPdf(); setIsMoreMenuOpen(false); }}
                        disabled={isExportingPdf || !allChartsReady}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                        title={!allChartsReady ? 'Loading chart data…' : 'Export as PDF'}
                      >
                        {isExportingPdf || !allChartsReady ? (
                          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-text-quaternary" />
                        ) : (
                          <Download className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                        )}
                        {isExportingPdf ? 'Exporting…' : 'Export PDF'}
                      </button>

                      {/* Share team */}
                      {canShare && (
                        <button
                          onClick={() => { setIsShareDialogOpen(true); setIsMoreMenuOpen(false); }}
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                        >
                          <Share2 className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                          Share with team
                        </button>
                      )}

                      {canEditResource && (
                        <>
                          <button
                            onClick={() => { setIsPublicShareOpen(true); setIsMoreMenuOpen(false); }}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                          >
                            <Globe className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                            Public links
                          </button>

                          <div className="mx-3 my-1 border-t border-[rgba(255,255,255,0.06)]" />

                          <button
                            onClick={() => { handleToggleLayoutMode(); setIsMoreMenuOpen(false); }}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                            title={`Switch to ${(dashboard?.layout_mode ?? 'grid') === 'grid' ? 'canvas' : 'grid'} mode`}
                          >
                            {(dashboard?.layout_mode ?? 'grid') === 'grid' ? (
                              <Move className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                            ) : (
                              <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                            )}
                            {(dashboard?.layout_mode ?? 'grid') === 'grid' ? 'Switch to Canvas' : 'Switch to Grid'}
                          </button>

                          <button
                            onClick={() => { setIsThemeOpen(true); setIsMoreMenuOpen(false); }}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                          >
                            <Palette className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                            Theme
                          </button>

                          <button
                            onClick={() => { setIsChartManagerOpen(true); setIsMoreMenuOpen(false); }}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                          >
                            <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                            Manage charts
                          </button>

                          <button
                            onClick={() => { setIsHtmlImportOpen(true); setIsMoreMenuOpen(false); }}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                          >
                            <Sparkles className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                            Import HTML
                          </button>

                          {/* Widgets submenu */}
                          <div className="mx-3 my-1 border-t border-[rgba(255,255,255,0.06)]" />
                          <button
                            onClick={() => setIsWidgetSubmenuOpen((v) => !v)}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                          >
                            <Plus className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                            <span className="flex-1 text-left">Add widget</span>
                            <ChevronDown className={`h-3 w-3 transition-transform ${isWidgetSubmenuOpen ? 'rotate-180' : ''}`} />
                          </button>
                          {isWidgetSubmenuOpen && (
                            <div className="bg-[rgba(255,255,255,0.02)]">
                              {([
                                ['text', 'Text / Markdown'],
                                ['countdown', 'Countdown'],
                                ['image', 'Image'],
                                ['shape', 'Shape / Divider'],
                                ['parameter_switcher', 'Parameter switcher'],
                              ] as const).map(([k, label]) => (
                                <button
                                  key={k}
                                  onClick={() => { handleAddWidget(k); setIsMoreMenuOpen(false); setIsWidgetSubmenuOpen(false); }}
                                  className="flex w-full items-center gap-2.5 px-6 py-1.5 text-[12px] font-[510] text-text-tertiary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                                >
                                  {label}
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

              {canEditResource && (
                <button
                  onClick={() => setIsAddChartModalOpen(true)}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md bg-brand px-2.5 text-[12px] font-[510] text-white shadow-sm transition-colors hover:bg-brand-hover"
                >
                  <Plus className="h-3 w-3" />
                  <span>Add Chart</span>
                </button>
              )}
            </div>
          </div>

          {/* Row 2 (pages) merged into title dropdown; Row 3 (filter) merged into header Filter popover. */}
        </div>
      </div>

      {/* ── Content area ──
          Phase-15.81 — when the FilterPane is open we render a 2-column
          shell: [Canvas | FilterPane]. Picking a field happens inside
          each FilterPane section's "+ Add filter" picker — no separate
          FieldList sidebar (DA: long mouse travel was annoying). */}
      <div className={`px-4 pb-8 sm:px-6 lg:px-8 ${isFilterPaneOpen ? 'flex gap-3 items-stretch min-h-[calc(100vh-12rem)]' : ''}`}>

        <div className={isFilterPaneOpen ? 'min-w-0 flex-1' : 'w-full'}>
        {activeCrossFilter && (
          <div className="mb-4 flex items-center gap-3 rounded-lg border border-warning/20 bg-[rgba(245,158,11,0.05)] px-4 py-2.5 text-[13px] font-[510] text-warning">
            <span>
              Cross-filter from {activeCrossFilterSourceTitle}:
            </span>
            <span className="truncate font-[400] text-text-secondary">
              {getFilterDisplayLabel(activeCrossFilter)} = {formatFilterValue(activeCrossFilter.value)}
            </span>
            <button
              type="button"
              onClick={() => setCrossFilterState(null)}
              className="ml-auto inline-flex items-center rounded border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-2.5 py-1 text-[12px] font-[510] text-text-secondary transition-colors hover:text-text-primary"
            >
              Clear
            </button>
          </div>
        )}

        {/* Phase-G3 — SlicerCluster arrangement honors layout.position:
            'top'  → block above charts (default)
            'left' → flex-row [cluster | charts]
            'free' → absolute overlay (cluster positions itself; the
                     wrapper just provides position:relative anchor). */}
        <div
          className={
            (draftSlicerClusterLayout?.position === 'left')
              ? 'flex flex-row items-start gap-3'
              : ''
          }
          style={
            (draftSlicerClusterLayout?.position === 'free')
              ? { position: 'relative' }
              : undefined
          }
        >
        {(draftGlobalSlicers.length > 0 || canEditResource) && (
          <SlicerCluster
            children={draftGlobalSlicers}
            onChildrenChange={setDraftGlobalSlicers}
            layout={draftSlicerClusterLayout}
            onLayoutChange={setDraftSlicerClusterLayout}
            columns={resolvedAvailableColumns}
            columnChartCount={resolvedColumnChartCount}
            distinctValues={resolvedDistinctValues}
            hasPendingChanges={JSON.stringify(draftGlobalSlicers) !== JSON.stringify(appliedGlobalSlicers)
              || JSON.stringify(draftSlicerClusterLayout) !== JSON.stringify(appliedSlicerClusterLayout)}
            onApply={canEditResource ? () => handleApplyFilters('all') : undefined}
            onReset={canEditResource ? () => {
              setDraftGlobalSlicers(appliedGlobalSlicers);
              setDraftSlicerClusterLayout(appliedSlicerClusterLayout);
            } : undefined}
            isApplying={isApplyingFilters}
            lockSlots={!canEditResource}
          />
        )}

        {/* Dashboard Grid or Canvas. When the slicer cluster is on the
            left, this area flexes to fill the remaining width. */}
        <div
          ref={dashboardContentRef}
          className={draftSlicerClusterLayout?.position === 'left' ? 'min-w-0 flex-1' : ''}
        >
        {(dashboard?.layout_mode ?? 'grid') === 'canvas' ? (
          <DashboardCanvas
            dashboardId={dashboardId}
            dashboardCharts={visibleDashboardCharts}
            canvasConfig={dashboard?.canvas_config}
            canEdit={canEditResource}
            allowAppearanceEdit={canEditResource}
            onLayoutChange={canEditResource ? handleCanvasLayoutChange : undefined}
            onRemoveChart={canEditResource ? handleRemoveChart : undefined}
            onEditWidget={canEditResource ? setEditingWidgetId : undefined}
            removingChartId={removingChartId}
            globalFilters={effectivePageScopeFilters}
            crossFilters={activeCrossFilter ? [activeCrossFilter] : []}
            crossFilterSourceChartId={crossFilterState?.sourceChartId ?? null}
            onChartDataLoaded={semanticColumnsResult.columns.length > 0 ? undefined : handleChartDataLoaded}
            onSelectCrossFilter={handleCrossFilterChange}
            availablePages={dashboardPages}
            onMoveChartToPage={canEditResource ? handleMoveChartToPage : undefined}
            emptyMessage={emptyPageMessage}
            focusedDashboardChartId={focusedTileId}
            onFocusChart={setFocusedTileId}
          />
        ) : (
          <DashboardGrid
            dashboardId={dashboardId}
            dashboardCharts={visibleDashboardCharts}
            canEdit={canEditResource}
            allowAppearanceEdit={canEditResource}
            themeConfig={dashboard?.theme_config}
            onLayoutChange={canEditResource ? handleLayoutChange : undefined}
            onRemoveChart={canEditResource ? handleRemoveChart : undefined}
            onEditWidget={canEditResource ? setEditingWidgetId : undefined}
            removingChartId={removingChartId}
            globalFilters={effectivePageScopeFilters}
            crossFilters={activeCrossFilter ? [activeCrossFilter] : []}
            crossFilterSourceChartId={crossFilterState?.sourceChartId ?? null}
            onChartDataLoaded={semanticColumnsResult.columns.length > 0 ? undefined : handleChartDataLoaded}
            onSelectCrossFilter={handleCrossFilterChange}
            availablePages={dashboardPages}
            onMoveChartToPage={canEditResource ? handleMoveChartToPage : undefined}
            emptyMessage={emptyPageMessage}
            focusedDashboardChartId={focusedTileId}
            onFocusChart={setFocusedTileId}
          />
        )}
        </div>
        </div>{/* /Phase-G3 slicer-cluster arrangement wrapper */}

        {/* Hidden off-screen ChartTiles for non-active pages — pre-warm React Query cache.
            Renders only ChartTile (no grid layout) to avoid WidthProvider / layout interference. */}
        <div
          aria-hidden
          data-html2canvas-ignore
          style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', opacity: 0, pointerEvents: 'none' }}
        >
          {chartsPerPage
            .filter((pg) => pg.pageId !== activePageId && pg.charts.length > 0)
            .flatMap((pg) => pg.charts)
            .map((dc) => (
              <ChartTile
                key={`prewarm-${dc.id}`}
                chartId={dc.chart_id}
                dashboardChartId={dc.id}
                dashboardId={dashboardId}
                currentLayout={dc.layout as Record<string, any>}
                canEdit={false}
                allowAppearanceEdit={false}
                globalFilters={effectivePageScopeFilters}
                instanceParameters={dc.parameters ?? {}}
              />
            ))}
        </div>
        </div>

        {/* Right dock: Filter Pane (Phase-15.81). Sticky alongside the
            canvas; sections own visual / page / all-pages scope. */}
        {isFilterPaneOpen && (
          <aside className="hidden lg:flex w-[300px] flex-shrink-0 flex-col overflow-hidden rounded-lg border border-[rgb(var(--border-line))] self-stretch">
            <FilterPane
              columns={resolvedAvailableColumns}
              distinctValues={resolvedDistinctValues}
              droppedFiltersByColumn={semanticDistinctDroppedFilters}
              pageFilters={draftPageFilters}
              pageLabel={currentPage?.name ?? 'Untitled page'}
              onChangePageFilters={setDraftPageFilters}
              allFilters={draftGlobalFiltersLegacy}
              onChangeAllFilters={(nextLegacy) => {
                // Phase-15.81 v11 — DA is wiring up filter slots; do
                // NOT push to `applied` here. The chart grid keeps its
                // current data until the DA clicks Apply, so adding /
                // tweaking a filter card doesn't fire a BigQuery query
                // per keystroke. `allowInactive` bridge preserves the
                // empty-value card the user just dropped.
                const nextUnion = nextLegacy
                  .map((b) => fromBaseFilter(b))
                  .filter((f): f is TypedFilter => f !== null);
                setDraftGlobalFilters(nextUnion);
              }}
              hasPendingChanges={hasPendingFilterChanges}
              onApplyPage={() => handleApplyFilters('page')}
              onApplyAll={() => handleApplyFilters('all')}
              onReset={handleResetFilters}
              isApplying={isApplyingFilters}
            />
          </aside>
        )}
      </div>

      {/* Modals */}
      <AddChartModal
          isOpen={isAddChartModalOpen}
          onClose={() => setIsAddChartModalOpen(false)}
          onAdd={handleAddChart}
          dashboardCharts={dashboard.dashboard_charts ?? []}
          dashboardDatasetIds={dashboardDatasetIds}
          pages={dashboardPages}
          activePageId={activePageId}
          isAdding={addChartMutation.isPending}
          currentPageName={currentPage?.name}
        />

        {isHtmlImportOpen && (
          <DashboardHtmlImportModal
            isOpen={isHtmlImportOpen}
            onClose={() => setIsHtmlImportOpen(false)}
            targetMode="append_to_dashboard"
            targetDashboardId={dashboardId}
            targetDashboardName={dashboard.name}
            onBuilt={(result) => {
              if ('pages' in result) {
                const lastPage = result.pages[result.pages.length - 1];
                if (lastPage?.page_id) {
                  setCurrentPageId(lastPage.page_id);
                }
                return;
              }
              setCurrentPageId(result.page_id);
            }}
          />
        )}

        <DashboardChartManagerModal
          isOpen={isChartManagerOpen}
          onClose={() => setIsChartManagerOpen(false)}
          dashboardCharts={dashboard.dashboard_charts ?? []}
          pages={dashboardPages}
          currentPageId={activePageId}
          removingChartId={removingChartId}
          onRemoveChart={handleRemoveChartFromManager}
        />

        <ConfirmDialog
          isOpen={pendingDeletePageId !== null}
          onClose={() => setPendingDeletePageId(null)}
          onConfirm={confirmDeletePage}
          title="Delete page?"
          description={fallbackDeletePage
            ? `Charts on this page will be moved to ${fallbackDeletePage.name}.`
            : 'This page will be deleted.'}
          confirmLabel="Delete page"
          variant="danger"
        />

        {/* Confirm Remove Chart Dialog */}
        <ConfirmDialog
          isOpen={pendingRemoveDashboardChartId !== undefined}
          onClose={() => setPendingRemoveDashboardChartId(undefined)}
          onConfirm={confirmRemoveChart}
          title="Remove chart from dashboard?"
          description="This will remove the chart tile from the dashboard. The chart itself will not be deleted."
          confirmLabel="Remove"
          variant="danger"
        />

        {/* Phase-15.66 — Confirm discard: clears BOTH local draft state
            AND any saved-but-not-published BE draft. */}
        <ConfirmDialog
          isOpen={isDiscardConfirmOpen}
          onClose={() => setIsDiscardConfirmOpen(false)}
          onConfirm={handleDiscardAll}
          title="Huỷ thay đổi bố cục?"
          description="Mọi thay đổi (local + bản nháp đã lưu) sẽ bị xoá. Dashboard quay về bố cục đã xuất bản gần nhất. Hành động này không hoàn tác được."
          confirmLabel="Huỷ thay đổi"
          cancelLabel="Giữ lại"
          variant="warning"
        />

        {/* Share Dialog (team members) */}
        {isShareDialogOpen && dashboard && (
          <ShareDialog
            resourceType="dashboard"
            resourceId={dashboardId}
            resourceName={dashboard.name}
            onClose={() => setIsShareDialogOpen(false)}
          />
        )}

        {/* Public links manager */}
        {isPublicShareOpen && dashboard && (
          <PublicLinksManager
            dashboardId={dashboardId}
            dashboardName={dashboard.name}
            availableColumns={resolvedAvailableColumns}
            columnChartCount={resolvedColumnChartCount}
            distinctValues={resolvedDistinctValues}
            onClose={() => setIsPublicShareOpen(false)}
          />
        )}
        <WidgetEditModal
          isOpen={editingWidgetId !== null}
          onClose={() => setEditingWidgetId(null)}
          dashboardId={dashboardId}
          widget={
            editingWidgetId !== null
              ? (dashboard.dashboard_charts ?? []).find((dc) => dc.id === editingWidgetId) ?? null
              : null
          }
        />

        {isThemeOpen && dashboard && (
          <DashboardThemeModal
            initial={dashboard.theme_config}
            onClose={() => setIsThemeOpen(false)}
            onSave={async (theme) => {
              await dashboardApi.update(dashboardId, { theme_config: theme });
              await updateDashboardMutation.mutateAsync({
                id: dashboardId,
                data: { theme_config: theme },
              }).catch(() => {});
            }}
          />
        )}
    </DashboardThemeProvider>
  );
}
