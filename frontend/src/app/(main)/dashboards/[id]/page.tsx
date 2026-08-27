'use client';

import React, { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Plus, Loader2, Edit2, Check, X, Share2, Globe, Sparkles, Trash2, LayoutGrid, Download, MoreHorizontal, ChevronDown, Filter, Clock, GripVertical, Lock, Hand } from 'lucide-react';
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
import { DashboardThemeProvider, getDashboardGridMargin } from '@/components/dashboards/DashboardThemeProvider';
import { resolveStyleTokens } from '@/lib/dashboard-theme-tokens';
import { AiDesignPanel } from '@/components/dashboards/ai-design/AiDesignPanel';
import { planFromTemplate } from '@/lib/dashboard-presentation/templates';
import { buildPresentationSnapshot, tilesOnPage } from '@/lib/dashboard-presentation/snapshot';
import { buildPresentationMutation, tilesWithLocalEdits, toLocalLayoutOverrides } from '@/lib/dashboard-presentation/executor';
import { useAiDesign } from '@/components/dashboards/ai-design/useAiDesign';
import { DashboardThemeModal } from '@/components/dashboards/DashboardThemeModal';
import { DashboardCanvas } from '@/components/dashboards/DashboardCanvas';
import { Palette, Move, Undo2, Redo2, ArrowUpToLine } from 'lucide-react';
import { ChartTile } from '@/components/dashboards/ChartTile';
import { WidgetEditModal } from '@/components/dashboards/WidgetEditModal';
import { ParameterBindModal } from '@/components/dashboards/ParameterBindModal';
import { AddChartModal } from '@/components/dashboards/AddChartModal';
import { DashboardChartManagerModal } from '@/components/dashboards/DashboardChartManagerModal';
import { DashboardHtmlImportModal } from '@/components/dashboards/DashboardHtmlImportModal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { useDashboardPresence } from '@/hooks/use-dashboard-presence';
import { useCurrentUser } from '@/hooks/use-current-user';
import {
  ExportModeContext,
  PDF_PREVIEW_TAB_ENABLED,
  openPdfPreviewTab,
  safePdfFilename,
  type ExportRenderMode,
} from '@/lib/export-mode';
import { ExportPdfDialog, type ExportPdfChoices } from '@/components/dashboards/ExportPdfDialog';
import type { PdfProgress } from '@/lib/export-pdf';
import { ShareDialog } from '@/components/common/ShareDialog';
import { PublicLinksManager } from '@/components/common/PublicLinksManager';
import FilterMapModal from '@/components/dashboards/FilterMapModal';
import { FilterPane } from '@/components/dashboards/FilterPane';
import { DashboardFilterBar } from '@/components/dashboards/DashboardFilterBar';
import { SlicerCluster } from '@/components/dashboards/SlicerCluster';
import { DashboardChartLayout, DashboardPageConfig } from '@/types/api';
import type { BaseFilter, ColumnInfo, FilterType, Filter as TypedFilter } from '@/lib/filters';
import {
  applyScopeBound,
  collectJoinKeySemanticFields,
  dockLayoutClasses,
  fromBaseFilter,
  getColumnDisplayLabel,
  getDistinctValueFilterContext,
  getFilterDisplayLabel,
  getFriendlyFieldLabel,
  getColumnKey,
  getFilterKey,
  inferColumnTypeFromData,
  isSemanticDimensionFilterableForDashboard,
  resolveEffectiveFilterSet,
  toBaseFilter,
  resolveFilterDock,
} from '@/lib/filters';
import { extractParamDefs, seedParamValues, paramsToFilters } from '@/lib/dashboard-params';
import { fetchDatasetModel, fetchDatasetModelDistinctValues, SLICER_DISTINCT_PREFETCH_LIMIT, modelKeys, type DatasetModelResponse } from '@/hooks/use-dataset-model';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import {
  createDashboardPageId,
  ensureDashboardPageId,
  getDashboardChartPageId,
  getDashboardChartsForPage,
  normalizeDashboardPages,
  tidyPageLayout,
  normalizeDashboardGridForRender,
  GRID_VERSION,
} from '@/lib/dashboard-pages';
import {
  ensureCanvasLayout,
  hasCanvasCoords,
  mergeCanvasLayout,
  mergeGridLayout,
} from '@/lib/dashboard-layout-convert';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';

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
  const { t } = useI18n();
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
  // An AI-Design theme that has been APPLIED to the draft but NOT persisted. A
  // manual theme change (the modal) saves instantly; an AI redesign must not,
  // because "Apply" is a draft step — the report only truly changes colour on
  // Save/Publish, and Discard drops it. Painted into the query cache for the
  // preview; the server keeps the published theme until a save flushes this.
  const [pendingThemeConfig, setPendingThemeConfig] = useState<any | null>(null);
  const slicersSeededRef = React.useRef(false);
  const [isApplyingFilters, setIsApplyingFilters] = useState(false);
  const [crossFilterState, setCrossFilterState] = useState<{
    sourceChartId: number;
    filter: BaseFilter;
  } | null>(null);
  // C4 anti-spam — timestamp of the last APPLIED cross-filter selection. Rapid
  // re-clicks (accidental double-clicks, mashing) within this window are
  // dropped so they don't thrash the dashboard or accidentally toggle-clear the
  // selection mid-fetch. Clears are never debounced; deliberate re-targeting
  // (>window) always lands so a slow BQ fetch never makes clicks feel "locked".
  const lastCrossFilterAtRef = React.useRef(0);
  const [availableColumns, setAvailableColumns] = useState<ColumnInfo[]>([]);
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [isPublicShareOpen, setIsPublicShareOpen] = useState(false);
  const [isFilterMapOpen, setIsFilterMapOpen] = useState(false);
  const [isThemeOpen, setIsThemeOpen] = useState(false);
  const [isWidgetMenuOpen, setIsWidgetMenuOpen] = useState(false);
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
  const [isPagesMenuOpen, setIsPagesMenuOpen] = useState(false);
  // Drag-to-reorder page tabs in the Pages dropdown.
  const [draggingPageId, setDraggingPageId] = useState<string | null>(null);
  const [dragOverPageId, setDragOverPageId] = useState<string | null>(null);
  // Phase-15.81 — kept for backward compat with onClick handlers in other
  // menus that still call setIsFilterPopoverOpen(false). The Filter popover
  // itself is gone — the right-dock FilterPane (isFilterPaneOpen) replaces
  // it. Both states stay in sync via the menu close-out pattern.
  const [, setIsFilterPopoverOpen] = useState(false);
  const [isWidgetSubmenuOpen, setIsWidgetSubmenuOpen] = useState(false);
  const [editingWidgetId, setEditingWidgetId] = useState<number | null>(null);
  // What-if parameter — which chart tile's bind modal is open (null = closed).
  const [bindingChartId, setBindingChartId] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const [currentPageId, setCurrentPageId] = useState<string | null>(null);
  const [localPagesConfig, setLocalPagesConfig] = useState<DashboardPageConfig[] | null>(null);
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [editedPageName, setEditedPageName] = useState('');
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  // Which export is running — see ExportRenderMode. Snapshot (default) renders
  // lazy tiles only; full also expands every table.
  const [exportRenderMode, setExportRenderMode] = useState<ExportRenderMode>(false);
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);
  const [exportProgress, setExportProgress] = useState<PdfProgress | null>(null);
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
  // Gate the tiles' data fetch until BOTH the filter + slicer seeds (below)
  // have run. Without it the tiles fetch UNFILTERED on first render (before the
  // seed effects populate the applied filters), flashing wrong (unfiltered)
  // numbers and wasting a warehouse scan per chart. The public page already
  // gates its fetch this way (`filtersSeeded`); the Builder didn't.
  const [filtersReady, setFiltersReady] = React.useState(false);
  const filtersSnapshotRef = React.useRef<string>('[]');
  const distinctValuesRef = React.useRef<Map<string, Set<string>>>(new Map());
  const [distinctValues, setDistinctValues] = useState<Record<string, string[]>>({});

  const { data: rawServerDashboard, isLoading: isLoadingDashboard } = useDashboard(dashboardId);
  // Finer-grid lazy upscale: legacy (12-col) tiles + BE draft layouts are scaled
  // ×3 for render here at the source, so the ENTIRE downstream pipeline (overlay
  // memo, resolveDashboardChartLayout, DashboardGrid, save baselines) sees finer
  // 36-col coords consistently. No persisted data is mutated (see
  // scaleGridLayoutForRender); edited tiles save back tagged gv=GRID_VERSION.
  const serverDashboard = React.useMemo(
    () => normalizeDashboardGridForRender(rawServerDashboard),
    [rawServerDashboard],
  );

  // Phase-15.66 — local layout overrides (no auto-save). Drag/resize
  // only updates this map; explicit Save buttons flush to BE.
  const [localLayoutOverrides, setLocalLayoutOverrides] = useState<
    Record<number, Record<string, any>>
  >({});
  const hasLocalLayoutChanges = Object.keys(localLayoutOverrides).length > 0;
  const hasAnyPendingChanges = hasLocalLayoutChanges || Boolean(serverDashboard?.has_draft) || Boolean(pendingThemeConfig);
  // Always-current mirror of localLayoutOverrides so undo-capture can read the
  // pre-change value without adding it to every handler's dep array.
  const localLayoutOverridesRef = React.useRef(localLayoutOverrides);
  localLayoutOverridesRef.current = localLayoutOverrides;

  // A proposed design being LOOKED at, not yet accepted. It sits above the
  // local edits and below nothing: the grid renders it, and Save Draft never
  // sees it, because saving reads `localLayoutOverrides` and this is a separate
  // buffer. That is what makes Discard free — there is nothing to roll back,
  // only a layer to drop. It is a view state, like a drag ghost, not a third
  // place presentation is stored.
  const [previewLayoutOverrides, setPreviewLayoutOverrides] = useState<
    Record<number, Record<string, any>> | null
  >(null);

  // Memoized dashboard view: server data overlaid with (1) BE draft_layouts,
  // (2) in-progress local edits, (3) an AI design being previewed.
  const dashboard = React.useMemo(() => {
    if (!serverDashboard) return serverDashboard;
    const beDrafts = serverDashboard.draft_layouts;
    if (
      !hasLocalLayoutChanges
      && !previewLayoutOverrides
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
        const previewOverride = previewLayoutOverrides?.[dc.id];
        if (!beOverride && !localOverride && !previewOverride) return dc;
        return {
          ...dc,
          layout: {
            ...(dc.layout ?? {}),
            ...(beOverride ?? {}),
            ...(localOverride ?? {}),
            ...(previewOverride ?? {}),
          },
        };
      }),
    };
  }, [serverDashboard, localLayoutOverrides, hasLocalLayoutChanges, previewLayoutOverrides]);

  // The dock the CLUSTER will actually use. Resolved here too so the wrapper
  // that positions the cluster beside the grid cannot disagree with the
  // cluster's own decision — the theme supplies the default composition, an
  // explicit author placement overrides it.
  // Track the viewport so the dock can answer "is there room for a rail?".
  // A rail on a phone takes the width the charts need, and squeezing every
  // slicer into one horizontal row instead is not the answer either.
  const [viewportWidth, setViewportWidth] = React.useState(
    () => (typeof window === 'undefined' ? 1440 : window.innerWidth),
  );
  React.useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const preferredFilterDock = React.useMemo(
    () => draftSlicerClusterLayout?.position
      ?? resolveStyleTokens((dashboard?.theme_config ?? null) as any).filterDock,
    [draftSlicerClusterLayout?.position, dashboard?.theme_config],
  );


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
  // Phase-B17 — publish conflict (someone else published the SAME tiles).
  const [publishConflict, setPublishConflict] = useState<{ editor: string | null; tiles?: string[] } | null>(null);
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

  // ── Undo / Redo (Ctrl+Z / Ctrl+Shift+Z) ───────────────────────────────────
  // SCOPE by design (see plan): LAYOUT (Tier-1 `localLayoutOverrides`, a pure
  // client buffer that Save-draft flushes) + THEME (re-applied via the SAME live
  // update a manual theme change uses). Filters/slicers (auto-staged to the
  // server draft) and widget/chart add-remove (live create/delete) are NOT
  // undoable — those actions instead call resetUndo() so a restore can never
  // desync the multi-tier draft/save flow. History caps at 50, lives in refs; a
  // tick state re-renders the toolbar buttons.
  // A third kind, for a change that is ONE thing to the person who made it. An
  // AI redesign moves a dozen tiles, repaints the report and re-docks the
  // filters in a single click; recording that as fourteen entries would mean
  // fourteen Ctrl+Z presses to get back, with the report in a nonsense
  // intermediate state at every step. The transaction boundary follows the
  // user's action, not the number of fields it touched.
  type PresentationState = {
    layout: Record<number, Record<string, any>>;
    theme: any;
    slicerCluster: any;
  };
  type UndoEntry =
    | { kind: 'layout'; prev: Record<number, Record<string, any>>; next: Record<number, Record<string, any>> }
    | { kind: 'theme'; prev: any; next: any }
    | { kind: 'ai-presentation'; prev: PresentationState; next: PresentationState };
  const undoRef = React.useRef<UndoEntry[]>([]);
  const redoRef = React.useRef<UndoEntry[]>([]);
  const [, setHistoryTick] = React.useState(0);
  const bumpHistory = () => setHistoryTick((n) => n + 1);
  const pushUndo = (entry: UndoEntry) => {
    undoRef.current.push(entry);
    if (undoRef.current.length > 50) undoRef.current.shift();
    redoRef.current = []; // a fresh action invalidates the redo branch
    bumpHistory();
  };
  const resetUndo = () => {
    if (undoRef.current.length || redoRef.current.length) {
      undoRef.current = [];
      redoRef.current = [];
      bumpHistory();
    }
  };
  // Apply a theme_config (live update) — reused by the modal onSave and by theme
  // undo/redo so both go through one path. Persist, then AUTHORITATIVELY patch the
  // detail cache so the theme provider repaints live. A plain invalidate+refetch
  // did NOT repaint in-session: the dashboard GET can be response-cached and
  // return the pre-change theme, leaving the cached dashboard stale until a hard
  // reload. setQueryData (the same pattern the draft-layout save uses, which is
  // why layout edits repaint live) guarantees the in-session restyle for BOTH a
  // manual theme change AND theme undo/redo. Only the LIST is invalidated (card
  // refresh); the detail query is written directly to avoid racing a stale refetch.
  /**
   * Persist a theme, and hand the filter dock back to it when the user picked a
   * LAYOUT.
   *
   * `slicer_cluster_layout.position` outranks the theme's `filterDock` on
   * purpose — an author who drags the filter rail somewhere must keep it. The
   * trap is that `DEFAULT_LAYOUT` carries `position: 'top'` and every draft save
   * writes the whole object, so a dashboard that has merely BEEN EDITED holds a
   * stored 'top' that is indistinguishable from a deliberate choice. Measured on
   * dash 67: the theme resolved `filterDock: left`, the draft held
   * `position: 'top'`, and the rail never moved — every template's dock was
   * silently dead on any dashboard with an edit history, which is all of them.
   *
   * Picking a layout template IS picking where the filters go, so applying one
   * clears the stored position and lets the template drive. Dragging the cluster
   * afterwards writes it back and that choice sticks until the next template.
   */
  const applyThemeConfig = async (theme: any, opts?: { releaseDock?: boolean }) => {
    // Optimistic-first: repaint the cached dashboard IMMEDIATELY so a manual theme
    // change and (especially) Ctrl+Z undo feel instant, then persist in the
    // background. On success reconcile with the server-normalized value; on
    // failure a reload reconciles (the theme is already visually applied).
    queryClient.setQueryData(['dashboards', dashboardId], (old: any) =>
      old ? { ...old, theme_config: theme } : old);
    // Local draft state first, so the rail moves on the same frame as the paint.
    const clearedDock = opts?.releaseDock && draftSlicerClusterLayout
      ? { ...draftSlicerClusterLayout, position: undefined, direction: undefined }
      : null;
    if (clearedDock) {
      setDraftSlicerClusterLayout(clearedDock);
      setAppliedSlicerClusterLayout(clearedDock);
    }
    try {
      const updated = await dashboardApi.update(dashboardId, {
        theme_config: theme,
        ...(clearedDock ? { slicer_cluster_layout: clearedDock } : {}),
      } as any);
      queryClient.setQueryData(['dashboards', dashboardId], (old: any) =>
        old ? { ...old, theme_config: updated?.theme_config ?? theme } : old);
      queryClient.invalidateQueries({ queryKey: ['dashboards'], exact: true });
    } catch (err) {
      console.error('Failed to persist theme:', err);
    }
  };
  /** Paint an AI-Design theme WITHOUT persisting — the draft path. The report
   *  shows the new surface immediately (cache paint), the server keeps the
   *  published theme, and `persistPendingTheme` / Discard decide its fate. */
  const paintThemeDraft = (theme: any) => {
    setPendingThemeConfig(theme);
    queryClient.setQueryData(['dashboards', dashboardId], (old: any) =>
      old ? { ...old, theme_config: theme } : old);
  };

  /** Flush a drafted AI theme to the server. Called by Save draft and Publish so
   *  the colour only becomes real when the author commits, matching the layout. */
  const persistPendingTheme = async (): Promise<boolean> => {
    if (!pendingThemeConfig) return true;
    try {
      await applyThemeConfig(pendingThemeConfig);
      setPendingThemeConfig(null);
      return true;
    } catch {
      return false;
    }
  };

  const applyUndoEntry = (entry: UndoEntry, dir: 'prev' | 'next') => {
    const value = dir === 'prev' ? entry.prev : entry.next;
    if (entry.kind === 'layout') { setLocalLayoutOverrides(value as any); return; }
    if (entry.kind === 'ai-presentation') {
      const state = value as PresentationState;
      setLocalLayoutOverrides(state.layout);
      if (state.slicerCluster !== undefined) {
        setDraftSlicerClusterLayout(state.slicerCluster);
        setAppliedSlicerClusterLayout(state.slicerCluster);
      }
      // Undo/redo of an AI redesign stays in the DRAFT — repaint the theme
      // without persisting, the same way Apply did, so a stray Ctrl+Z can never
      // write the live report.
      if (state.theme !== undefined) paintThemeDraft(state.theme);
      return;
    }
    void applyThemeConfig(value);
  };
  const doUndo = () => {
    const entry = undoRef.current.pop();
    if (!entry) { toast.info(t('dashboards.detail.nothingToUndo')); return; }
    redoRef.current.push(entry);
    applyUndoEntry(entry, 'prev');
    bumpHistory();
    toast.success(t(entry.kind === 'theme' ? 'dashboards.detail.undoTheme' : 'dashboards.detail.undoLayout'));
  };
  const doRedo = () => {
    const entry = redoRef.current.pop();
    if (!entry) return;
    undoRef.current.push(entry);
    applyUndoEntry(entry, 'next');
    bumpHistory();
    toast.success(t('dashboards.detail.redoDone'));
  };
  const canUndo = undoRef.current.length > 0;
  const canRedo = redoRef.current.length > 0;
  // Latest-closure ref so the once-mounted keydown listener always calls current.
  const undoActionsRef = React.useRef<{ undo: () => void; redo: () => void }>({ undo: () => {}, redo: () => {} });
  undoActionsRef.current = { undo: doUndo, redo: doRedo };
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
  const resolveDashboardChartLayout = useCallback((
    dashboardChartId: number,
    localSnapshot: Record<number, Record<string, any>> = localLayoutOverrides,
  ): DashboardChartLayout => {
    const existing = serverDashboard?.dashboard_charts?.find((dc) => dc.id === dashboardChartId);
    const draftKey = String(dashboardChartId);
    const draftLayout = serverDashboard?.draft_layouts
      ? ((serverDashboard.draft_layouts as any)[dashboardChartId] ?? (serverDashboard.draft_layouts as any)[draftKey])
      : null;
    return {
      ...({ x: 0, y: 0, w: 4, h: 4 } as DashboardChartLayout),
      ...(existing?.layout ?? {}),
      ...(draftLayout ?? {}),
      ...(localSnapshot[dashboardChartId] ?? {}),
    } as DashboardChartLayout;
  }, [serverDashboard, localLayoutOverrides]);

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
    // Both seeds have now run (the filter seed above shares the same
    // [dashboard] dep and, being defined earlier, runs first) → release the
    // tile-fetch gate so tiles fetch ONCE, already filtered. Set even when the
    // seed is empty (no filters/slicers) so a filter-less dashboard still loads.
    setFiltersReady(true);
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

  // Per-page slicers (scope='page') — live on pages_config[activePage].slicers,
  // the mirror of per-page filters above. A slicer tagged scope='all' stays in
  // dashboard.slicers_config (draftGlobalSlicers) and applies to every page; a
  // scope='page' slicer only renders + filters on its own page. Re-seeds when
  // the active page changes so page A's slicer never leaks onto page B.
  const activePageSlicers = React.useMemo<any[]>(
    () => Array.isArray((currentPage as any)?.slicers) ? (currentPage as any).slicers as any[] : [],
    [currentPage],
  );
  const [draftPageSlicers, setDraftPageSlicers] = useState<any[]>([]);

  // The template states a preference; the content and the viewport decide
  // whether it holds. See `resolveFilterDock` for the cases and why each one
  // exists.
  const filterDockDecision = React.useMemo(
    () => resolveFilterDock({
      preferred: preferredFilterDock,
      slicerCount: draftGlobalSlicers.length + draftPageSlicers.length,
      viewportWidth,
      canEdit: canEditResource,
    }),
    [preferredFilterDock, draftGlobalSlicers.length, draftPageSlicers.length, viewportWidth, canEditResource],
  );
  const effectiveFilterDock = filterDockDecision.dock;

  // ── AI Design ─────────────────────────────────────────────────────────────
  // The panel and everything behind it live in `components/dashboards/ai-design`
  // and `lib/dashboard-presentation`. What stays here is orchestration: which
  // mode is showing, and what "commit" means — because committing has to reach
  // the same three pieces of state a manual edit reaches, and that state lives
  // in this file.
  const [designMode, setDesignMode] = useState<'manual' | 'ai'>('manual');
  // The AI drawer collapses to a floating bubble so the report underneath is
  // never hidden — the popup sits OVER the report, it does not shrink it.
  const [aiPanelCollapsed, setAiPanelCollapsed] = useState(false);

  const commitPresentation = React.useCallback((commit: {
    layoutOverrides: Record<number, Record<string, any>>;
    themePatch: Record<string, any> | null;
    slicerClusterPatch: Record<string, any> | null;
  }) => {
    // One undo entry for one click (§14). The `before` half is captured here,
    // from live state, rather than being handed in — a caller that snapshotted
    // earlier would record a baseline that has since moved.
    const nextTheme = commit.themePatch
      ? { ...(dashboard?.theme_config ?? {}), ...commit.themePatch }
      : undefined;
    const nextCluster = commit.slicerClusterPatch
      ? { ...(draftSlicerClusterLayout ?? {}), ...commit.slicerClusterPatch }
      : undefined;

    pushUndo({
      kind: 'ai-presentation',
      prev: {
        layout: localLayoutOverrides,
        theme: nextTheme === undefined ? undefined : (dashboard?.theme_config ?? {}),
        slicerCluster: nextCluster === undefined ? undefined : draftSlicerClusterLayout,
      },
      next: {
        layout: commit.layoutOverrides,
        theme: nextTheme,
        slicerCluster: nextCluster,
      },
    });

    setPreviewLayoutOverrides(null);
    setLocalLayoutOverrides(commit.layoutOverrides);
    if (nextCluster !== undefined) {
      setDraftSlicerClusterLayout(nextCluster);
      setAppliedSlicerClusterLayout(nextCluster);
    }
    // Draft, don't persist: the colour lands on Save/Publish and Discard drops
    // it — an AI Apply must not silently repaint the live report (§ theme-draft).
    if (nextTheme !== undefined) paintThemeDraft(nextTheme);
  }, [dashboard?.theme_config, draftSlicerClusterLayout, localLayoutOverrides]);

  // Tile focus (Canvas/Grid highlight). Declared here — above useAiDesign —
  // because in AI mode a focused tile scopes the redesign to that one visual
  // (click-chart-to-edit), so the hook needs to read it.
  const [focusedTileId, setFocusedTileId] = useState<number | null>(null);

  const aiDesign = useAiDesign({
    dashboardId: Number(dashboardId),
    dashboard,
    activePageId,
    activePageName: currentPage?.name ?? activePageId,
    pageCount: dashboardPages.length,
    localLayoutOverrides,
    slicers: [...draftGlobalSlicers, ...draftPageSlicers],
    slicerDock: effectiveFilterDock,
    currentTheme: dashboard?.theme_config,
    slicerClusterLayout: draftSlicerClusterLayout,
    gridGapPx: getDashboardGridMargin(dashboard?.theme_config)[1],
    // Only a click while the AI panel is open means "restyle just this one".
    focusedChartId: designMode === 'ai' ? focusedTileId : null,
    onCommit: commitPresentation,
  });

  // The preview is a view layer, so it is pushed into the render overlay rather
  // than returned by the hook and threaded through every child.
  React.useEffect(() => {
    setPreviewLayoutOverrides(
      aiDesign.pending ? (aiDesign.pending.mutation.layoutOverrides as any) : null,
    );
  }, [aiDesign.pending]);

  // Clicking a chart while the AI panel is minimised should bring the panel
  // back — otherwise the "Editing: X" chip the click just armed is invisible.
  React.useEffect(() => {
    if (designMode === 'ai' && focusedTileId != null && aiPanelCollapsed) {
      setAiPanelCollapsed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedTileId, designMode]);

  // A report-scoped redesign changes the SURFACE — a dark ground, a violet
  // accent, softer cards — and that is the biggest thing "make this a dark
  // modern report" asks for. Previewing only the layout would hide it until
  // Apply, so the pending theme patch is overlaid on the live theme for as long
  // as the preview is on screen. It is derived from `pending`, never stored, so
  // Discard reverts it for free. Page-scoped previews carry no theme patch, so
  // this is exactly the live theme for them.
  const previewTheme = React.useMemo(() => {
    const patch = aiDesign.pending?.mutation.themePatch;
    if (!patch || Object.keys(patch).length === 0) return dashboard?.theme_config;
    // Preview the SURFACE and the slicer's LOOK, but not its POSITION. The dock
    // and variant reflow the filter cluster — reflowing it mid-preview shoves the
    // whole grid sideways (the "charts jumping" §) — so those land on Apply.
    // `slicerStyle` (card/pill/glass/…) only repaints the chips, no reflow, so it
    // rides in the preview: a "modern glass filter" should look modern before you
    // commit, not after.
    const { filterDock, slicerVariant, ...surface } = patch as Record<string, any>;
    void filterDock; void slicerVariant;
    return { ...(dashboard?.theme_config ?? {}), ...surface };
  }, [aiDesign.pending, dashboard?.theme_config]);

  const pageSlicersServerSignatureRef = React.useRef<string>('');
  React.useEffect(() => {
    const sig = `${activePageId}::${JSON.stringify(activePageSlicers)}`;
    if (pageSlicersServerSignatureRef.current === sig) return;
    pageSlicersServerSignatureRef.current = sig;
    setDraftPageSlicers(activePageSlicers);
  }, [activePageId, activePageSlicers]);

  // ── Slicer scope evaluation (PBI "Sync slicers" model) ───────────────
  // A slicer decides, per page, whether it FILTERS that page's data and
  // whether it shows a VISIBLE control there:
  //   scope 'all'    → every page (filter + visible)        [slicers_config]
  //   scope 'page'   → only its home page (filter + visible)[pages_config]
  //   scope 'custom' → per pageScope[pageId] = {filter, visible} [slicers_config]
  // 'page'-scoped slicers live in draftPageSlicers (current page), so they're
  // inherently for activePageId; only globals need per-page evaluation.
  const slicerVisibleOnPage = React.useCallback((s: any, pageId: string | undefined): boolean => {
    if (!s || typeof s !== 'object') return false;
    const sc = (s as any).scope || 'all';
    if (sc === 'custom') return Boolean((s as any).pageScope?.[pageId ?? '']?.visible);
    return true; // 'all' (page-scoped ones aren't in the globals list)
  }, []);
  const slicerFiltersPage = React.useCallback((s: any, pageId: string | undefined): boolean => {
    if (!s || typeof s !== 'object') return false;
    const sc = (s as any).scope || 'all';
    if (sc === 'custom') return Boolean((s as any).pageScope?.[pageId ?? '']?.filter);
    return true;
  }, []);
  const slicerKeyOf = (s: any): string =>
    `${s?.datasetId ?? ''}|${String(s?.semanticField ?? s?.field ?? s?.id ?? '').toLowerCase()}`;

  // Split a combined SlicerCluster child list back into global vs per-page.
  // Images + scope 'all'/'custom' → global; scope 'page' → current page.
  // Globals NOT visible on the active page were never shown to the cluster,
  // so preserve them (else a 'custom' slicer hidden on this page would vanish).
  const handleSlicerChildrenChange = React.useCallback((next: any[]) => {
    const incomingPage: any[] = [];
    const incomingGlobal: any[] = [];
    for (const c of next) {
      if (c && typeof c === 'object' && (c as any).scope === 'page' && (c as any).type !== 'image') {
        incomingPage.push(c);
      } else {
        incomingGlobal.push(c);
      }
    }
    setDraftGlobalSlicers((prev) => {
      const incomingKeys = new Set(incomingGlobal.map(slicerKeyOf));
      const preserved = prev.filter((s) =>
        (s as any)?.type !== 'image'
        && (s as any)?.scope !== 'page'
        && !slicerVisibleOnPage(s, activePageId)
        && !incomingKeys.has(slicerKeyOf(s)),
      );
      return [...preserved, ...incomingGlobal];
    });
    setDraftPageSlicers(incomingPage);
  }, [activePageId, slicerVisibleOnPage]);

  // Change a slicer's scope (from the ⚙ config popover). Moves it between the
  // global list and the page list as needed, carrying pageScope for 'custom'.
  const handleUpdateSlicerScope = React.useCallback((
    slicerKey: string,
    scope: 'all' | 'page' | 'custom',
    pageScope?: Record<string, { filter: boolean; visible: boolean }>,
  ) => {
    // Find the slicer in either list.
    const fromGlobal = draftGlobalSlicers.find((s) => slicerKeyOf(s) === slicerKey);
    const fromPage = draftPageSlicers.find((s) => slicerKeyOf(s) === slicerKey);
    const base = fromGlobal ?? fromPage;
    if (!base) return;
    const updated = { ...base, scope } as any;
    if (scope === 'custom') updated.pageScope = pageScope ?? (base as any).pageScope ?? {};
    else delete updated.pageScope;
    if (scope === 'page') {
      // → page list (current page). Remove from globals.
      setDraftGlobalSlicers((prev) => prev.filter((s) => slicerKeyOf(s) !== slicerKey));
      setDraftPageSlicers((prev) => {
        const rest = prev.filter((s) => slicerKeyOf(s) !== slicerKey);
        return [...rest, updated];
      });
    } else {
      // → global list ('all' or 'custom'). Remove from page list.
      setDraftPageSlicers((prev) => prev.filter((s) => slicerKeyOf(s) !== slicerKey));
      setDraftGlobalSlicers((prev) => {
        const rest = prev.filter((s) => slicerKeyOf(s) !== slicerKey);
        return [...rest, updated];
      });
    }
  }, [draftGlobalSlicers, draftPageSlicers]);

  // ── Stable slicer DISPLAY order (fixes the scope-toggle "jump") ───────
  // The cluster renders the two source arrays concatenated as
  // [...global, ...page]. Changing a slicer's SCOPE (⚙ "Chỉ trang này" /
  // "Tất cả trang") moves it across that global|page boundary, so the card
  // jumped to a new column — dragging the open ⚙ popover with it. Verified
  // on dash 53: clicking "Chỉ trang này" on the 1st slicer threw its open
  // popover from x=109 → x=987 and slid the 2nd slicer into its slot, i.e.
  // "ấn thì nhảy sang filter khác". We pin the display order by slicer id:
  // a scope flip keeps the id, so the card stays put; add → appended,
  // remove → pruned. Transient (not persisted) — on reload the saved
  // global/page grouping reseeds it, which is fine.
  const combinedSlicerChildren = React.useMemo(
    () => [...draftGlobalSlicers, ...draftPageSlicers],
    [draftGlobalSlicers, draftPageSlicers],
  );
  const [slicerDisplayOrder, setSlicerDisplayOrder] = React.useState<string[]>([]);
  React.useEffect(() => {
    const idOf = (s: any) => String(s?.id ?? slicerKeyOf(s));
    const ids = combinedSlicerChildren.map(idOf);
    setSlicerDisplayOrder((prev) => {
      const present = new Set(ids);
      const kept = prev.filter((id) => present.has(id));
      const keptSet = new Set(kept);
      const added = ids.filter((id) => !keptSet.has(id));
      const next = [...kept, ...added];
      const unchanged = next.length === prev.length && next.every((v, i) => v === prev[i]);
      return unchanged ? prev : next;
    });
  }, [combinedSlicerChildren]);
  const orderedSlicerChildren = React.useMemo(() => {
    const idOf = (s: any) => String(s?.id ?? slicerKeyOf(s));
    const idx = new Map(slicerDisplayOrder.map((id, i) => [id, i] as const));
    return [...combinedSlicerChildren].sort(
      (a, b) => (idx.get(idOf(a)) ?? 1e9) - (idx.get(idOf(b)) ?? 1e9),
    );
  }, [combinedSlicerChildren, slicerDisplayOrder]);

  // Phase-15.81 v11 — pending flag must light up for BOTH scopes so
  // the Apply button surfaces when a DA edits page filters too.
  // Phase-C THẬT — slicer drafts also count toward pending.
  const hasPendingFilterChanges = React.useMemo(
    () =>
      JSON.stringify(draftGlobalFilters) !== JSON.stringify(appliedGlobalFilters)
      || JSON.stringify(draftPageFilters) !== JSON.stringify(activePageFilters)
      || JSON.stringify(draftGlobalSlicers) !== JSON.stringify(appliedGlobalSlicers)
      || JSON.stringify(draftPageSlicers) !== JSON.stringify(activePageSlicers)
      || JSON.stringify(draftSlicerClusterLayout) !== JSON.stringify(appliedSlicerClusterLayout),
    [draftGlobalFilters, appliedGlobalFilters, draftPageFilters, activePageFilters,
     draftGlobalSlicers, appliedGlobalSlicers, draftPageSlicers, activePageSlicers,
     draftSlicerClusterLayout, appliedSlicerClusterLayout],
  );

  // Combined view fed into DashboardGrid/Canvas/ChartTile. Both scopes
  // contribute to the chart WHERE; per-page wins on field collision
  // (PowerBI page-level override semantic, mirrors the public viewer
  // seed effect's "page entries take precedence" rule). Driven by
  // APPLIED state — adding a half-built filter card mustn't shake the
  // chart grid.
  // Phase-H — editor precedence MUST match the BE public merge order
  // (filter-semantics.md §3 / filter_layered_merge._LAYER_ORDER):
  //
  //   visible filters (default) < slicers < locked/hidden filters (authoritative)
  //
  // Later sets override earlier ones on the same field key. The key fix:
  // a publicMode=locked/hidden dashboard filter is AUTHORITATIVE — it
  // must win over a slicer on the same field, so it's applied LAST.
  // (No link layer in the editor preview.) Without this split the editor
  // preview diverged from the public link, which is what users hit.
  // Phase-H — resolution extracted to `resolveEffectiveFilterSet` (lib/filters)
  // so the distinct-value cascade collapses the SAME set (chart↔dropdown
  // parity — see `dashboard_filter_dual_path`). Behaviour here is unchanged:
  // SELECTIONS (visible defaults + page-scoped slicers, active-valued wins) →
  // applyScopeBound(page hard bounds) → authoritative (locked/hidden) last.
  const effectivePageScopeFilters = React.useMemo<BaseFilter[]>(
    () =>
      resolveEffectiveFilterSet({
        globalFilters: appliedGlobalFiltersLegacy,
        pageFilters: activePageFilters,
        globalSlicers: appliedGlobalSlicers,
        pageSlicers: activePageSlicers,
        activePageId,
        slicerFiltersPage,
      }),
    [appliedGlobalFiltersLegacy, activePageFilters, appliedGlobalSlicers, activePageSlicers, activePageId, slicerFiltersPage],
  );
  // What-if / field parameters (parameter_switcher widgets on the active page).
  // Definitions come from each switcher's widget_config; values live in page
  // state (not persisted). A filter-bound param becomes a page-scoped filter
  // that flows through the normal chart-filter path; text widgets read the raw
  // value via {{param('name')}}.
  const paramDefs = React.useMemo(
    () => extractParamDefs(visibleDashboardCharts),
    [visibleDashboardCharts],
  );
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  React.useEffect(() => {
    setParamValues((prev) => seedParamValues(paramDefs, prev));
  }, [paramDefs]);
  const handleParamChange = React.useCallback(
    (name: string, value: any) =>
      setParamValues((prev) => ({ ...prev, [name]: value == null ? '' : String(value) })),
    [],
  );
  // `paramFilters` / `effectiveFiltersWithParams` are computed lower down, once
  // `resolvedAvailableColumns` exists — a filter-bound param needs the column's
  // semantic identity to resolve on a semantic dataset.

  // Phase-15.81 — tile focus state (Canvas/Grid highlight only) is declared
  // above useAiDesign so AI mode can scope a redesign to the focused tile.
  // Phase-B17/B19 — presence + per-page co-edit rights: heartbeat my focused
  // tile + page, learn where others edit, and resolve who may edit THIS page
  // (owner priority). `editLock.can_edit` is server-resolved.
  const { data: me } = useCurrentUser();
  const {
    editors: otherEditors,
    lock: editLock,
    requestEdit,
    respond: respondEditRequest,
  } = useDashboardPresence(dashboardId, canEditResource, focusedTileId, activePageId);
  // Owner of the dashboard (raw owner_id — `user_permission` collapses owner→'full'
  // so it can't distinguish). Prefer the server's resolved flag once presence has
  // beat; fall back to the local comparison before the first heartbeat.
  const isOwner = editLock?.i_am_owner ?? (!!me?.id && me.id === dashboard?.owner_id);
  // May the current user edit the CURRENT page? Editing is gated on this so a
  // non-owner viewing a page the owner holds can't drag/resize/theme/add until
  // the owner approves. Defaults to the base resource right until presence beats.
  const canEditThisPage = canEditResource && (editLock?.can_edit ?? true);
  // Pending edit requests on the active page (owner sees these to approve/deny).
  const pendingEditRequests = editLock?.pending_requests ?? [];
  // Stable color per collaborator (shared by the toolbar avatar + tile ring).
  const colorFor = React.useCallback((key: string) => {
    const palette = ['#e8590c', '#9c36b5', '#1971c2', '#2f9e44', '#e64980', '#0c8599', '#f08c00'];
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  }, []);
  // Compact deduped avatar chips for the toolbar (GG-Sheets style).
  const editorChips = React.useMemo(() => {
    const seen = new Map<string, { name: string; color: string; initials: string }>();
    for (const e of otherEditors) {
      if (seen.has(e.user_key)) continue;
      const parts = (e.name || '?').trim().split(/\s+/);
      const initials = ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
      seen.set(e.user_key, { name: e.name, color: colorFor(e.user_key), initials });
    }
    return [...seen.values()];
  }, [otherEditors, colorFor]);
  // Map dashboard_chart id -> the collaborator editing it (for the tile ring).
  const presenceByChart = React.useMemo(() => {
    const m: Record<number, { name: string; color: string }> = {};
    for (const e of otherEditors) {
      if (e.editing_chart_id != null) m[e.editing_chart_id] = { name: e.name, color: colorFor(e.user_key) };
    }
    return m;
  }, [otherEditors, colorFor]);
  // Phase-15.81 — replace the old top-bar popover with a docked right-hand
  // FilterPane sidebar. Persisted in window only (intentionally not URL),
  // since pane state is a viewing preference.
  const [isFilterPaneOpen, setIsFilterPaneOpen] = useState(false);

  // Read-only snapshot freshness ("data as of"). Refresh itself now lives in the
  // Dataset (scheduled / manual Sync & Publish, with history) — the per-dashboard
  // "Refresh data" action + its polling were removed, so we only READ freshness.
  const [snapshotAsOf, setSnapshotAsOf] = useState<string | null>(null);
  // Populate the "Số tính đến" label on load (not only after a Refresh) so the
  // builder always shows when the snapshot data was last updated.
  useEffect(() => {
    let cancelled = false;
    dashboardApi
      .getSnapshotInfo(dashboardId)
      .then((res) => { if (!cancelled) setSnapshotAsOf(res?.as_of ?? null); })
      .catch(() => { /* materialization off / not eligible → no label */ });
    return () => { cancelled = true; };
  }, [dashboardId]);

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
    // One gesture = one chart: DashboardGrid forwards ONLY the moved tile, so we
    // touch exactly the charts in `newLayout` and never re-read/re-write siblings.
    // For each such chart, compare to its server+draft baseline (no local):
    //   • back AT baseline  → DELETE its override, so returning a chart to its
    //     original spot fully clears the "changed" state (no stale override, no
    //     stuck "Unsaved" — dirty is derived from the override key count);
    //   • otherwise         → record/update its override.
    const prevOverrides = localLayoutOverridesRef.current;
    const nextOverrides: Record<number, Record<string, any>> = { ...prevOverrides };
    let changed = false;
    for (const item of newLayout) {
      const id = Number(item.i);
      const existing = serverDashboard.dashboard_charts?.find((dc) => dc.id === id);
      if (!existing) continue;
      const baseline = resolveDashboardChartLayout(id, {});
      const atBaseline =
        baseline.x === item.x && baseline.y === item.y
        && baseline.w === item.w && baseline.h === item.h;
      if (atBaseline) {
        if (id in nextOverrides) { delete nextOverrides[id]; changed = true; }
      } else {
        nextOverrides[id] = mergeGridLayout(resolveDashboardChartLayout(id), item);
        changed = true;
      }
    }
    if (!changed) return; // net no-op → keep unrelated (e.g. canvas) local edits intact
    pushUndo({ kind: 'layout', prev: prevOverrides, next: nextOverrides });
    setLocalLayoutOverrides(nextOverrides);
  };

  // Phase-18 — "Sắp xếp gọn": re-flow the active page's tiles into a clean,
  // aligned, equal-height-row grid (kills the ragged "thò thụt" look). Writes
  // to the same local-override → Save-draft path as a manual drag, so it's
  // staged (not auto-saved) and reversible via Discard.
  const handleTidyLayout = useCallback(() => {
    if (!dashboard) return;
    const pageCharts = getDashboardChartsForPage(dashboard.dashboard_charts, activePageId);
    if (pageCharts.length === 0) return;
    const tiles = pageCharts.map((dc) => ({
      id: dc.id,
      x: Number(dc.layout?.x) || 0,
      y: Number(dc.layout?.y) || 0,
      w: Number(dc.layout?.w) || 4,
      h: Number(dc.layout?.h) || 4,
    }));
    const tidied = tidyPageLayout(tiles);
    const next: Record<number, Record<string, any>> = {};
    for (const t of tidied) {
      next[t.id] = mergeGridLayout(resolveDashboardChartLayout(t.id), t);
    }
    const prevOverrides = localLayoutOverridesRef.current;
    const merged = { ...prevOverrides, ...next };
    pushUndo({ kind: 'layout', prev: prevOverrides, next: merged });
    setLocalLayoutOverrides(merged);
    toast.success(t('dashboards.detail.tidyDone'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard, activePageId, resolveDashboardChartLayout, t]);

  // Explicit "Dồn lên trên" — the ON-DEMAND replacement for the auto-lift that was
  // removed from render (P0). Unlike Tidy (which re-flows tiles into clean rows),
  // this ONLY removes the empty band above the topmost tile, preserving the DA's
  // horizontal arrangement. Same local-override → Save-draft path (staged, undoable).
  const handleCompactUp = useCallback(() => {
    if (!dashboard) return;
    const pageCharts = getDashboardChartsForPage(dashboard.dashboard_charts, activePageId);
    if (pageCharts.length === 0) return;
    const tiles = pageCharts.map((dc) => ({
      id: dc.id,
      x: Number(dc.layout?.x) || 0,
      y: Number(dc.layout?.y) || 0,
      w: Number(dc.layout?.w) || 4,
      h: Number(dc.layout?.h) || 4,
    }));
    const minY = Math.min(...tiles.map((tl) => tl.y));
    if (!Number.isFinite(minY) || minY <= 0) {
      toast.info(t('dashboards.detail.compactUpNoop'));
      return;
    }
    const next: Record<number, Record<string, any>> = {};
    for (const tl of tiles) {
      next[tl.id] = mergeGridLayout(resolveDashboardChartLayout(tl.id), { x: tl.x, y: tl.y - minY, w: tl.w, h: tl.h });
    }
    const prevOverrides = localLayoutOverridesRef.current;
    const merged = { ...prevOverrides, ...next };
    pushUndo({ kind: 'layout', prev: prevOverrides, next: merged });
    setLocalLayoutOverrides(merged);
    toast.success(t('dashboards.detail.compactUpDone'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard, activePageId, resolveDashboardChartLayout, t]);

  // Canvas-mode layout updates: same pattern — local state only.
  const handleCanvasLayoutChange = useCallback(
    (
      updates: Array<{ id: number; xPx: number; yPx: number; wPx: number; hPx: number; z: number }>,
    ) => {
      if (!serverDashboard) return;
      const prevOverrides = localLayoutOverridesRef.current;
      const merged = { ...prevOverrides };
      for (const u of updates) {
        merged[u.id] = mergeCanvasLayout(resolveDashboardChartLayout(u.id, prevOverrides), u);
      }
      pushUndo({ kind: 'layout', prev: prevOverrides, next: merged });
      setLocalLayoutOverrides(merged);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverDashboard, resolveDashboardChartLayout],
  );

  // Flush helpers — used by Save draft / Save & Publish buttons.
  const flushLocalLayoutsToDraft = async () => {
    if (!hasLocalLayoutChanges) return true;
    // Send the COMPLETE layout for each changed tile, not the bare override. A
    // focused AI restyle produces a style-only override ({styleConfigOverride})
    // with no x/y/w/h; the draft-layout endpoint replaces the row and requires
    // geometry, so a raw style-only override 422s and sinks the whole save.
    // resolveDashboardChartLayout merges base + draft + override → always has
    // x/y/w/h, and carries the styleConfigOverride along.
    const chartLayouts = Object.keys(localLayoutOverrides).map((id) => ({
      id: Number(id),
      layout: resolveDashboardChartLayout(Number(id)),
    }));
    try {
      // Clear the local overrides in the mutation's onSuccess — the SAME batch as
      // the hook's setQueryData(draft_layouts) — so the cache already reflects the
      // saved coords in the commit that drops the overlay. Prevents a one-frame
      // flash of the pre-save layout between "cache updated" and "overlay cleared".
      await updateDraftLayoutMutation.mutateAsync(
        { dashboardId, chartLayouts },
        { onSuccess: () => setLocalLayoutOverrides({}) },
      );
      return true;
    } catch (err) {
      console.error('Failed to flush draft layout:', err);
      return false;
    }
  };

  const handleSaveDraft = async () => {
    const ok = await flushLocalLayoutsToDraft();
    // A drafted AI theme becomes real on Save, together with the layout.
    await persistPendingTheme();
    if (ok) {
      // Save flushes local overrides → the pre-save snapshots in the undo stack
      // no longer map cleanly onto the now-empty override buffer, so clear the
      // history (hard boundary) rather than allow a half-broken restore.
      resetUndo();
      toast.success(t('dashboards.detail.draftSaved'));
    } else {
      toast.error(t('dashboards.detail.draftSaveFailed'));
    }
  };

  // Phase-B18 — auto-save the current page's unsaved layout edits into the
  // draft BEFORE switching pages, so nothing is lost when moving around a
  // multi-page dashboard. Switch happens regardless (a failed save keeps the
  // edits in local state, not lost). The PDF-export loop sets currentPageId
  // directly (not via this), so it isn't affected.
  const handleSwitchPage = useCallback(async (pageId: string) => {
    if (pageId === activePageId) { setIsPagesMenuOpen(false); return; }
    setIsPagesMenuOpen(false);
    // Silent auto-save (like Google Docs) — the "DRAFT" badge reflects state;
    // no toast so frequent page switches don't spam the notification center.
    if (canEditResource && hasLocalLayoutChanges) {
      await flushLocalLayoutsToDraft();
    }
    // Page switch flushes overrides + changes which charts are on-screen — the
    // undo entries (keyed to the previous page's override map) no longer apply.
    resetUndo();
    setCurrentPageId(pageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePageId, canEditResource, hasLocalLayoutChanges]);

  // Phase-B18 — Ctrl/Cmd+S saves the draft quickly (and blocks the browser's
  // Save-page dialog). A ref holds the latest closure so the listener stays
  // mounted once but always sees current state.
  const ctrlSRef = React.useRef<() => void>(() => {});
  ctrlSRef.current = () => {
    if (hasLocalLayoutChanges) handleSaveDraft();
  };
  React.useEffect(() => {
    if (!canEditResource) return;
    const isEditableTarget = (el: EventTarget | null) => {
      const node = el as HTMLElement | null;
      if (!node || !node.tagName) return false;
      const tag = node.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        ctrlSRef.current();
        return;
      }
      // Undo / Redo — skip while typing in a field so the browser's native
      // text-undo keeps working; only the builder canvas is undone here.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !isEditableTarget(e.target)) {
        const key = e.key.toLowerCase();
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault();
          undoActionsRef.current.undo();
          return;
        }
        if ((key === 'z' && e.shiftKey) || key === 'y') {
          e.preventDefault();
          undoActionsRef.current.redo();
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canEditResource]);

  // Phase-B17 — per-tile base versions for the tiles we're about to publish,
  // from the LIVE layout we loaded (layout._v). Lets the BE flag only the tiles
  // a colleague republished since we loaded — independent tiles never conflict.
  const buildTileBaseV = (): Record<string, number> => {
    const liveById = new Map<number, number>(
      (serverDashboard?.dashboard_charts ?? []).map((dc) => [dc.id, Number((dc.layout as any)?._v ?? 0)]),
    );
    const ids = new Set<number>([
      ...Object.keys(localLayoutOverrides).map(Number),
      ...Object.keys((serverDashboard as any)?.draft_layouts ?? {}).map(Number),
    ]);
    const out: Record<string, number> = {};
    ids.forEach((id) => { out[String(id)] = liveById.get(id) ?? 0; });
    return out;
  };

  const handlePublish = async () => {
    // Capture base versions BEFORE the flush clears local overrides.
    const tileBaseV = buildTileBaseV();
    const ok = await flushLocalLayoutsToDraft();
    if (!ok) {
      toast.error(t('dashboards.detail.publishAbortedDraftFailed'));
      return;
    }
    // A drafted AI theme becomes real on Publish, together with the layout.
    await persistPendingTheme();
    resetUndo();
    try {
      await publishDashboardMutation.mutateAsync({ dashboardId, tileBaseV });
      toast.success(t('dashboards.detail.publishedNewVersion'));
    } catch (err: any) {
      if (err?.response?.status === 409) {
        setPublishConflict({
          editor: err?.response?.data?.detail?.last_editor ?? null,
          tiles: err?.response?.data?.detail?.tiles ?? [],
        });
      } else {
        toast.error(t('dashboards.detail.publishFailed'));
      }
    }
  };

  // Phase-B17 — user chose "overwrite" in the conflict dialog: republish with force.
  const handleForcePublish = async () => {
    setPublishConflict(null);
    try {
      await publishDashboardMutation.mutateAsync({ dashboardId, force: true });
      toast.success(t('dashboards.detail.publishedOverwrote'));
    } catch {
      toast.error(t('dashboards.detail.publishFailed'));
    }
  };

  const handleDiscardAll = async () => {
    setLocalLayoutOverrides({});
    // A drafted AI theme was only painted into the cache, never persisted — drop
    // it and refetch the server's published theme so Discard reverts colour too.
    if (pendingThemeConfig) {
      setPendingThemeConfig(null);
      queryClient.invalidateQueries({ queryKey: ['dashboards', dashboardId] });
    }
    resetUndo();
    if (serverDashboard?.has_draft) {
      try {
        await discardDraftMutation.mutateAsync(dashboardId);
        toast.success(t('dashboards.detail.revertedToPublished'));
      } catch (err) {
        toast.error(t('dashboards.detail.discardDraftFailed'));
      }
    }
  };

  const handleAddWidget = useCallback(
    async (widgetType: 'text' | 'countdown' | 'image' | 'shape' | 'parameter_switcher' | 'section_header' | 'callout' | 'hero_strip') => {
      if (!dashboard) return;
      const defaults: Record<string, any> = {
        text: { template: 'Hello {{today()}}', align: 'left', fontSize: 18 },
        countdown: { target: new Date(Date.now() + 7 * 86400000).toISOString(), label: 'Time left' },
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
        // Modern/SaaS "element" widgets (decorative inserts).
        section_header: { eyebrow: 'KHU VỰC', title: 'Tiêu đề mục', subtitle: '' },
        callout: { title: 'Chú thích', text: 'Nhập insight hoặc ghi chú cho khu vực này…', tone: 'accent' },
        hero_strip: { title: dashboard.name || 'Tên báo cáo', subtitle: 'Mô tả ngắn về báo cáo', metric: '', metricLabel: '' },
      };

      // Default footprint per widget type — picked so the widget is visible
      // immediately after dropping (a 4×2 grid cell is too short for text/countdown).
      const sizeByType: Record<string, { w: number; h: number; wPx: number; hPx: number }> = {
        // Text/heading widgets are almost always a one-line section header, so
        // default to a slim band (1 grid row) instead of a 2-row box that leaves
        // a big empty gap under the text. The DA can still stretch it for a
        // multi-line note.
        // Grid w/h are in the finer 36-col grid (×3 of the old 12-col sizes so a
        // widget keeps the same default footprint); wPx/hPx are canvas pixels
        // (unchanged — independent of grid resolution).
        text: { w: 12, h: 3, wPx: 360, hPx: 64 },
        countdown: { w: 12, h: 9, wPx: 360, hPx: 200 },
        image: { w: 12, h: 12, wPx: 360, hPx: 240 },
        shape: { w: 12, h: 3, wPx: 360, hPx: 80 },
        parameter_switcher: { w: 12, h: 6, wPx: 360, hPx: 120 },
        // Section header + hero span full width (36); callout is a small note.
        section_header: { w: 36, h: 3, wPx: 1080, hPx: 56 },
        hero_strip: { w: 36, h: 6, wPx: 1080, hPx: 120 },
        callout: { w: 12, h: 6, wPx: 360, hPx: 110 },
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
            gv: GRID_VERSION, // sizeByType is already finer (36-col) — mark so it's not re-scaled on read
          } as any,
          defaults[widgetType],
        );
        await queryClient.invalidateQueries({ queryKey: ['dashboards', dashboardId] });
        resetUndo(); // chart/widget set changed — prior layout undo entries are stale
        // Open edit modal for the freshly-created widget — auto-increment id
        // means the largest id in the response is the one we just inserted.
        const newest = (updated?.dashboard_charts ?? []).reduce<number | null>((acc, dc) => {
          if (dc.widget_type && dc.widget_type !== 'chart') {
            return acc === null || dc.id > acc ? dc.id : acc;
          }
          return acc;
        }, null);
        if (newest !== null) setEditingWidgetId(newest);
        toast.success(t('dashboards.detail.widgetAdded', { type: widgetType.replace('_', ' ') }));
      } catch (err) {
        console.error('Failed to add widget:', err);
        const detail = (err as any)?.response?.data?.detail;
        toast.error(typeof detail === 'string' ? detail : t('dashboards.detail.widgetAddFailed'));
      } finally {
        setIsWidgetMenuOpen(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dashboard, dashboardId, activePageId, queryClient],
  );

  const handleToggleLayoutMode = useCallback(async () => {
    if (!dashboard) return;
    // Grid (x/y cells) ↔ canvas (px) use different coordinate spaces, so undo
    // entries captured in one mode can't be replayed in the other.
    resetUndo();
    const next = (dashboard.layout_mode ?? 'grid') === 'grid' ? 'canvas' : 'grid';
    if (next === 'canvas') {
      const canvasWidth = Number((dashboard.canvas_config as any)?.width ?? 1440);
      setLocalLayoutOverrides((prev) => {
        const bootstrapped: Record<number, Record<string, any>> = {};
        for (const [index, dc] of (dashboard.dashboard_charts ?? []).entries()) {
          const baseline = resolveDashboardChartLayout(dc.id, prev);
          if (!hasCanvasCoords(baseline)) {
            bootstrapped[dc.id] = ensureCanvasLayout(baseline, canvasWidth, Number(baseline.z ?? index + 1));
          }
        }
        return Object.keys(bootstrapped).length > 0 ? { ...prev, ...bootstrapped } : prev;
      });
    }
    try {
      await dashboardApi.update(dashboardId, { layout_mode: next });
      await updateDashboardMutation.mutateAsync({
        id: dashboardId,
        data: { layout_mode: next },
      }).catch(() => {});
    } catch (err) {
      console.error('Failed to toggle layout mode:', err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard, dashboardId, resolveDashboardChartLayout, updateDashboardMutation]);

  const handleCrossFilterChange = useCallback((sourceChartId: number, filter: BaseFilter | null) => {
    // One selection drives the whole dashboard (PBI parity): the SOURCE chart
    // dims its non-selected marks (highlight-local, see grid wiring) and every
    // OTHER chart FILTERS to the clicked value (cross-filter). Toggling the same
    // point clears it; a null emit (click on empty chart space) clears
    // unconditionally — reverting to the dashboard baseline. Slicer/page filters
    // are separate state, so this never touches them.
    // C4 anti-spam — an accidental double-click on a mark fires twice ~130ms
    // apart. The 1st click selects; the 2nd lands AFTER the source chart
    // re-rendered (dimmed), so it misses the bar and the tile's empty-space
    // handler emits a `null` CLEAR — which would wipe the just-made selection.
    // So debounce BOTH: a rapid re-select AND a rapid clear within 300ms of the
    // last selection are dropped. The explicit "Clear" button calls
    // setCrossFilterState(null) directly (never here), and a deliberate
    // empty-space clear or re-target is always >300ms later, so both still work.
    {
      const now = Date.now();
      if (now - lastCrossFilterAtRef.current < 300) return;
      if (filter) lastCrossFilterAtRef.current = now;
    }
    setCrossFilterState((current) => {
      if (!filter) {
        return null;
      }
      if (
        current?.sourceChartId === sourceChartId &&
        areFiltersEquivalent(current.filter, filter)
      ) {
        return null;
      }
      return { sourceChartId, filter };
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
          gv: GRID_VERSION, // AddChartModal packs on the finer 36-col grid — tag so read doesn't re-scale
        },
        parameters,
      });
      resetUndo(); // chart set changed — prior layout undo entries are stale
      // Modal-close is owned by AddChartModal now — it closes ONCE after the
      // whole batch finishes (DA6-F3 multi-add), so adding N charts doesn't
      // dismiss the picker after the first one.
    } catch (error) {
      console.error('Failed to add chart:', error);
      const detail = (error as any)?.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : t('dashboards.detail.chartAddFailed'));
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
      resetUndo(); // chart set changed — prior layout undo entries are stale
      toast.success(t('dashboards.detail.chartRemoved'));
    } catch (error) {
      console.error('Failed to remove chart:', error);
      toast.error(t('dashboards.detail.chartRemoveFailed'));
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
      toast.error(t('dashboards.detail.nameUpdateFailed'));
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
          const next: any = { ...p };
          // Per-page filters
          if (draftPageFilters.length > 0) next.filters = draftPageFilters;
          else delete next.filters;
          // Per-page slicers (scope='page'). Strip images defensively — they
          // belong to the global cluster (slicers_config), never per page.
          const pageSlicers = draftPageSlicers.filter((s) => !(s && typeof s === 'object' && (s as any).type === 'image'));
          if (pageSlicers.length > 0) next.slicers = pageSlicers;
          else delete next.slicers;
          return next;
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
          ? t('dashboards.detail.filterDraftSavedAll')
          : t('dashboards.detail.filterDraftSavedPage'),
      );
    } catch (error) {
      console.error('Failed to save dashboard filters:', error);
      setLocalPagesConfig(null);
      toast.error(t('dashboards.detail.filterSaveFailed'));
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

  // Pages CRUD writes go through the draft pipeline (same as filter /
  // slicer edits) so Publish/Discard treats them atomically. Writing
  // straight to live `pages_config` would be overwritten by a later
  // publish flush that copies snapshot.pages_config back onto live.
  const persistPagesConfig = useCallback(async (pages: DashboardPageConfig[]) => {
    setLocalPagesConfig(pages);
    try {
      await dashboardApi.updateDraftFilters(dashboardId, { pages_config: pages });
      queryClient.invalidateQueries({ queryKey: ['dashboards', dashboardId] });
    } catch (error) {
      setLocalPagesConfig(null);
      throw error;
    }
  }, [dashboardId, queryClient]);

  // Drag-to-reorder the page tabs. Reorders the FULL page objects (each keeps
  // its filters/slicers/layout) and persists the new order to the draft — same
  // path as add/rename/delete. The active page is unchanged. Dropping onto a
  // target inserts the dragged page at that target's slot.
  const handleReorderPages = useCallback(async (fromId: string, toId: string) => {
    if (!fromId || !toId || fromId === toId) return;
    const fromIdx = dashboardPages.findIndex((page) => page.id === fromId);
    const toIdx = dashboardPages.findIndex((page) => page.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...dashboardPages];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    try {
      await persistPagesConfig(next);
    } catch (error) {
      console.error('Failed to reorder dashboard pages:', error);
      toast.error(t('dashboards.detail.pageReorderFailed'));
    }
  }, [dashboardPages, persistPagesConfig, t]);

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
      toast.success(t('dashboards.detail.pageAdded'));
    } catch (error) {
      console.error('Failed to add dashboard page:', error);
      toast.error(t('dashboards.detail.pageAddFailed'));
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
      toast.success(t('dashboards.detail.pageRenamed'));
    } catch (error) {
      console.error('Failed to rename page:', error);
      toast.error(t('dashboards.detail.pageRenameFailed'));
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
        // Stage chart moves into draft_layouts (combined with any pending
        // local layout overrides) so Discard reverts the move together
        // with the page delete; otherwise charts would stay moved on
        // LIVE while the page reappeared on discard.
        const mergedLayouts: Record<number, Record<string, any>> = {};
        for (const [id, layout] of Object.entries(localLayoutOverrides)) {
          mergedLayouts[Number(id)] = layout;
        }
        for (const move of chartsToMove) {
          mergedLayouts[move.id] = {
            ...(localLayoutOverrides[move.id] ?? {}),
            ...move.layout,
          };
        }
        const chartLayoutsPayload = Object.entries(mergedLayouts).map(([id, layout]) => ({
          id: Number(id),
          layout,
        }));
        await updateDraftLayoutMutation.mutateAsync({
          dashboardId,
          chartLayouts: chartLayoutsPayload,
        });
        setLocalLayoutOverrides({});
        resetUndo(); // page deleted + overrides flushed — undo history is stale
      }
      await persistPagesConfig(dashboardPages.filter((page) => page.id !== pendingDeletePageId));
      if (activePageId === pendingDeletePageId) {
        setCurrentPageId(fallbackPage.id);
      }
      setEditingPageId((current) => current === pendingDeletePageId ? null : current);
      toast.success(t('dashboards.detail.pageDeleted'));
    } catch (error) {
      console.error('Failed to delete page:', error);
      toast.error(t('dashboards.detail.pageDeleteFailed'));
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
      resetUndo(); // chart moved pages — layout undo entries reference the old page set
      toast.success(t('dashboards.detail.chartMoved'));
    } catch (error) {
      console.error('Failed to move chart to page:', error);
      const detail = (error as any)?.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : t('dashboards.detail.chartMoveFailed'));
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
    // COLUMN DISCOVERY set — the raw union (incl. inactive slots via
    // allowInactive) decides WHICH fields get a distinct dropdown. Never dedupe
    // here or a just-dragged-in slot could lose its dropdown.
    const combinedFilters: BaseFilter[] = [
      ...legacyDraftAll,
      ...draftPageFilters,
      ...draftGlobalSlicers,
      ...draftPageSlicers,
    ];

    if (semanticColumnsResult.columns.length === 0 || combinedFilters.length === 0) {
      return [];
    }

    // CASCADE CONTEXT set — resolve same-field EXACTLY like the chart-data path
    // (effectivePageScopeFilters) so each dropdown cascades on the value the
    // CHARTS actually use. Without this a same-field visible default + slicer
    // (e.g. Trung_tam=RC02 default + Trung_tam=PKD4.1 slicer) were both passed
    // as context → the BE ANDs them → `WHERE Trung_tam=RC02 AND Trung_tam=PKD4.1`
    // → impossible → every OTHER dropdown came back EMPTY, while the charts show
    // the slicer's value. Chart↔dropdown parity (`dashboard_filter_dual_path`).
    // applyScopeBound is preserved inside, so locked/page-scope hard bounds are
    // never escaped by the dropdown cascade either.
    const resolvedContextFilters = resolveEffectiveFilterSet({
      globalFilters: legacyDraftAll,
      pageFilters: draftPageFilters,
      globalSlicers: draftGlobalSlicers as BaseFilter[],
      pageSlicers: draftPageSlicers as BaseFilter[],
      activePageId,
      slicerFiltersPage,
    });

    const columnsByKey = new Map(
      semanticColumnsResult.columns.map((column) => [getColumnKey(column), column]),
    );
    const activeColumns = new Map<string, ColumnInfo>();

    for (const filter of combinedFilters) {
      const key = getFilterKey(filter);
      // Prefer the chart-binding-derived column (accurate semantic type/label).
      // Fall back to a column synthesized from the slicer/filter itself when the
      // field isn't reachable from any chart binding — this guarantees a canvas
      // slicer ALWAYS resolves a queryable column. Notably CALENDAR ROLE-PLAY
      // fields (e.g. `…__order_date__date_dim.year`) live in a SYNTHETIC view
      // that is NOT part of `model.views`, so they never entered
      // `semanticColumnsResult.columns` → this lookup failed → the slicer's
      // distinct query never fired → the dropdown hung on "Loading values…".
      // Public links don't hit this because the BE guarantees slicer fields via
      // `_augment_with_slicer_fields` + `_build_public_calendar_filter_fields`.
      let column = columnsByKey.get(key);
      if (
        (!column?.datasetId || !column.semanticField)
        && filter.datasetId
        && (filter.semanticField || filter.fieldKey)
      ) {
        column = {
          key,
          name: filter.field,
          label: filter.label ?? filter.field,
          type: filter.type,
          datasetId: filter.datasetId,
          semanticField: filter.semanticField ?? filter.fieldKey,
          chartCoverage: 0,
          datasetChartCount: 0,
          sharedAcrossDataset: false,
        };
      }
      if (!column?.datasetId || !column.semanticField) continue;
      // Fetch distinct values for categorical columns (dropdown/text) AND
      // for numeric/date columns used as a multi-select slicer
      // (operator 'in'/'not_in' → value checklist). Without the latter a
      // numeric dimension like `year` rendered an EMPTY checklist while the
      // BE already had the cascaded values — an FE↔BE parity gap. Range /
      // scalar number+date modes (between/eq/gt…) keep their own UI and
      // don't need a distinct list.
      const isCategorical = column.type === 'dropdown' || column.type === 'text';
      const isListMode = filter.operator === 'in' || filter.operator === 'not_in';
      if (!isCategorical && !isListMode) continue;
      activeColumns.set(key, column);
    }

    return Array.from(activeColumns.values()).map((column) => {
      const filterContext = getDistinctValueFilterContext(resolvedContextFilters, column);
      return {
        column,
        filterContext,
        filterContextKey: JSON.stringify(filterContext),
      };
    });
  }, [draftGlobalFilters, draftPageFilters, draftGlobalSlicers, draftPageSlicers, semanticColumnsResult.columns, activePageId, slicerFiltersPage]);

  const semanticDistinctQueries = useQueries({
    queries: activeSemanticDistinctTargets.map(({ column, filterContext, filterContextKey }) => ({
      queryKey: [...modelKeys.distinct(column.datasetId!, column.semanticField!), 'filters', filterContextKey],
      queryFn: () => fetchDatasetModelDistinctValues(column.datasetId!, column.semanticField!, SLICER_DISTINCT_PREFETCH_LIMIT, filterContext),
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

  // Phase-7.6 — per-column distinct query status. Without this the slicer
  // dropdown couldn't tell "still fetching" from "fetched and got []", and
  // showed "Loading values..." indefinitely when a cross-list filter (e.g.
  // a page filter on `project.dept_id` with no join path to `dept.name`)
  // produced 0 cascade results. With the status the FilterCard renders a
  // clear "No values match current filter" message in the latter case.
  const semanticDistinctStatus = React.useMemo(() => {
    const status: Record<string, {
      isLoading: boolean;
      isError: boolean;
      hasFilterContext: boolean;
      total?: number;
      hasMore?: boolean;
    }> = {};
    activeSemanticDistinctTargets.forEach(({ column, filterContext }, index) => {
      const q = semanticDistinctQueries[index];
      status[getColumnKey(column)] = {
        isLoading: Boolean(q?.isLoading || q?.isFetching),
        isError: Boolean(q?.isError),
        hasFilterContext: Array.isArray(filterContext) && filterContext.length > 0,
        total: q?.data?.total,
        hasMore: q?.data?.has_more,
      };
    });
    return status;
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

  // What-if parameters (part 2) — turn filter-bound params into BaseFilter
  // entries, resolving each param's column against the dashboard's available
  // columns so it carries the semantic identity the engine needs, then append
  // to the page's effective filter set fed into every tile.
  const paramFilters = React.useMemo(
    () => paramsToFilters(paramDefs, paramValues, resolvedAvailableColumns),
    [paramDefs, paramValues, resolvedAvailableColumns],
  );
  const effectiveFiltersWithParams = React.useMemo<BaseFilter[]>(
    () =>
      paramFilters.length
        ? [...effectivePageScopeFilters, ...paramFilters]
        : effectivePageScopeFilters,
    [effectivePageScopeFilters, paramFilters],
  );

  // Phase-12 — parity with the public link (`usePublicFilterDistinctValues`)
  // which MERGES the BE /distinct-values response with chart-row-derived
  // values (so a column shows options even when the cascade-narrowed BE
  // query returns []). Previously the editor's A/B choice
  // `hasSemanticFilterColumns ? api : chart` returned ONLY the API values
  // and produced misleading "No values match" panels in the editor while
  // the same field on the public link showed valid options. Merge with
  // chart-row fallback so the editor sees what the viewer will see.
  const resolvedDistinctValues = React.useMemo(() => {
    if (!hasSemanticFilterColumns) return distinctValues;
    const merged: Record<string, string[]> = { ...distinctValues };
    for (const [key, vals] of Object.entries(semanticDistinctValues)) {
      // Prefer the API response when it returned at least one value (it
      // reflects the cascade context the user actually set). When the API
      // came back empty BUT the chart-row fallback has values, keep the
      // fallback — that's the case shown on the public link.
      if (Array.isArray(vals) && vals.length > 0) {
        merged[key] = vals;
      }
    }
    return merged;
  }, [hasSemanticFilterColumns, semanticDistinctValues, distinctValues]);

  // Phase-B22 — hybrid export: tables as real text+links (all rows), other
  // charts as images, paginated legibly, with an applied-filters header.
  // NOTE: must stay ABOVE the early returns below — hooks can't run
  // conditionally (React #310 if placed after `if (isLoadingDashboard) return`).
  const summarizeAppliedFilters = useCallback((): string => {
    const active = (appliedGlobalFiltersLegacy || []).filter((f: any) => {
      const v = f?.value;
      return Array.isArray(v) ? v.length > 0 : (v != null && v !== '');
    });
    return active.map((f: any) => {
      const v = f.value;
      const val = Array.isArray(v) ? v.slice(0, 5).join(', ') + (v.length > 5 ? ` +${v.length - 5}` : '') : String(v);
      const label = f.label || f.semanticField || f.field || 'Filter';
      return `${label}: ${val}`;
    }).join('  ·  ');
  }, [appliedGlobalFiltersLegacy]);

  const doExportPdf = useCallback(async (choices: ExportPdfChoices) => {
    if (!dashboard) return;
    // Open the preview tab synchronously inside the click (see openPdfPreviewTab).
    const previewWindow = openPdfPreviewTab();
    setIsExportingPdf(true);
    setExportRenderMode(choices.layout === 'snapshot' ? 'snapshot' : 'full');
    setExportProgress({ phase: 'prepare', ratio: 0, message: t('dashboards.detail.exportPreparing') });
    const originalPageId = activePageId;
    try {
      const { exportDashboardPdf } = await import('@/lib/export-pdf');
      const safeName = safePdfFilename(dashboard.name, 'dashboard');
      const filtersSummary = summarizeAppliedFilters();
      const chosen = dashboardPages.filter((p) => choices.pageIds.includes(p.id));
      const result = await exportDashboardPdf({
        previewWindow,
        filename: `${safeName}.pdf`,
        title: dashboard.name || 'Dashboard',
        orientation: choices.orientation,
        format: choices.format,
        layout: choices.layout,
        onProgress: setExportProgress,
        pages: chosen.map((p) => ({
          name: p.name,
          filtersSummary,
          getRoot: async () => {
            setCurrentPageId(p.id);
            // Let the switched-to page's tiles mount + fire their own fetches
            // (build-page tiles fetch individually — there's no central fetch to
            // await). The exporter then runs the shared readiness protocol
            // (waitForRenderReady) before capturing, so the duplicate poll that
            // used to live here is gone: one implementation, one behaviour on
            // all three surfaces.
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 250)));
            });
            return dashboardContentRef.current;
          },
        })),
      });
      setIsExportDialogOpen(false);
      if (result === 'saved' && PDF_PREVIEW_TAB_ENABLED) {
        // See the public view: with the preview tab off, 'saved' is success and
        // the pop-up hint would be nonsense.
        try { previewWindow?.close(); } catch { /* noop */ }
        toast.info(t('dashboards.detail.pdfDownloaded'), {
          description: t('dashboards.detail.pdfPopupBlocked'),
        });
      }
    } catch (err) {
      console.error('PDF export failed', err);
      try { previewWindow?.close(); } catch { /* noop */ }
      toast.error(t('dashboards.detail.exportFailed'));
    } finally {
      setCurrentPageId(originalPageId);
      setIsExportingPdf(false);
      setExportRenderMode(false);
      setExportProgress(null);
    }
  }, [dashboard, dashboardPages, activePageId, summarizeAppliedFilters]);

  if (isLoadingDashboard) {
    return (
      <div className="min-h-full bg-surface-2">
        <div className="w-full px-8 py-6">
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-brand" />
            <span className="ml-2">{t('dashboards.detail.loadingDashboard')}</span>
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
            <p className="text-text-tertiary">{t('dashboards.detail.notFound')}</p>
            <Link
              href="/dashboards"
              className="inline-flex items-center text-brand hover:text-brand mt-4"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              {t('dashboards.detail.backToDashboards')}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const activeCrossFilter = crossFilterState?.filter ?? null;
  // Source-dim is driven by the SAME selection: the grid passes this only to
  // the source tile (others get null), so the clicked chart dims its
  // non-selected marks while everyone else filters.
  const activeHighlight = crossFilterState?.filter ?? null;
  const highlightSourceChartId = crossFilterState?.sourceChartId ?? null;

  const isRenamingCurrentPage = editingPageId === currentPage?.id;
  const emptyPageMessage = currentPage
    ? t('dashboards.detail.emptyPageNamed', { name: currentPage.name })
    : t('dashboards.detail.emptyDashboard');
  const fallbackDeletePage = pendingDeletePageId
    ? dashboardPages.find((page) => page.id !== pendingDeletePageId) ?? null
    : null;
  const activeCrossFilterSourceTitle = crossFilterState
    ? (visibleDashboardCharts.find((dc) => dc.chart_id === crossFilterState.sourceChartId)?.layout?.custom_title
      ?? visibleDashboardCharts.find((dc) => dc.chart_id === crossFilterState.sourceChartId)?.chart?.name
      ?? t('dashboards.detail.chartFallbackName', { id: crossFilterState.sourceChartId }))
    : null;

  // The name of the tile the user clicked to restyle in AI mode — shown as the
  // "Editing: X" chip. Only meaningful while the AI panel is open.
  const focusedChartName = (designMode === 'ai' && focusedTileId != null)
    ? (() => {
        const dc = visibleDashboardCharts.find((c) => c.id === focusedTileId);
        return dc?.layout?.custom_title
          ?? dc?.chart?.name
          ?? t('dashboards.detail.chartFallbackName', { id: focusedTileId });
      })()
    : null;

  return (
    <DashboardThemeProvider theme={previewTheme} className="min-h-full bg-surface-2">
      {/* ── Sticky compact header (single row) ── */}
      <div className="sticky top-0 z-20 bg-surface-2 px-4 pt-3 pb-2 sm:px-6 lg:px-8">
        <div className="rounded-xl border border-[rgba(255,255,255,0.08)] bg-surface-1 shadow-linear-sm overflow-visible">

          <div className="flex h-11 items-center gap-2 px-3">
            {/* Back */}
            <Link
              href="/dashboards"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-secondary"
              title={t('dashboards.detail.backToDashboards')}
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
                    title={t('dashboards.detail.save')}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={handleCancelEditName}
                    className="rounded-md p-1 text-text-tertiary hover:bg-[rgba(255,255,255,0.04)]"
                    title={t('common.cancel')}
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
                      title={t('dashboards.detail.renameDashboard')}
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
                        title={t('dashboards.detail.savePageName')}
                      >
                        <Check className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={handleCancelRenamePage}
                        className="rounded-md p-1 text-text-tertiary hover:bg-[rgba(255,255,255,0.04)]"
                        title={t('common.cancel')}
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
                        title={t('dashboards.detail.switchPage')}
                      >
                        <span className="max-w-[10rem] truncate">{currentPage?.name ?? t('dashboards.detail.pageFallback')}</span>
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
                                const isDragging = draggingPageId === page.id;
                                const isDragOver = dragOverPageId === page.id && draggingPageId !== page.id;
                                return (
                                  <div
                                    key={page.id}
                                    draggable={canEditResource}
                                    onDragStart={(e) => {
                                      if (!canEditResource) return;
                                      setDraggingPageId(page.id);
                                      e.dataTransfer.effectAllowed = 'move';
                                      try { e.dataTransfer.setData('text/plain', page.id); } catch { /* noop */ }
                                    }}
                                    onDragOver={(e) => {
                                      if (!canEditResource || !draggingPageId) return;
                                      e.preventDefault();
                                      e.dataTransfer.dropEffect = 'move';
                                      if (dragOverPageId !== page.id) setDragOverPageId(page.id);
                                    }}
                                    onDrop={(e) => {
                                      if (!canEditResource) return;
                                      e.preventDefault();
                                      const fromId = draggingPageId || e.dataTransfer.getData('text/plain');
                                      setDraggingPageId(null);
                                      setDragOverPageId(null);
                                      if (fromId) handleReorderPages(fromId, page.id);
                                    }}
                                    onDragEnd={() => { setDraggingPageId(null); setDragOverPageId(null); }}
                                    className={`group/pagerow flex w-full items-center gap-1.5 border-t-2 px-2 py-2 text-[13px] font-[510] transition-colors ${
                                      isActive
                                        ? 'bg-[rgba(94,106,210,0.15)] text-brand'
                                        : 'text-text-secondary hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary'
                                    } ${isDragging ? 'opacity-40' : ''} ${isDragOver ? 'border-brand' : 'border-transparent'}`}
                                    title={canEditResource ? t('dashboards.detail.dragToReorderPage') : undefined}
                                  >
                                    {canEditResource && (
                                      <GripVertical
                                        className="h-3.5 w-3.5 shrink-0 cursor-grab text-text-quaternary opacity-40 transition-opacity group-hover/pagerow:opacity-100 active:cursor-grabbing"
                                        aria-hidden
                                      />
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => handleSwitchPage(page.id)}
                                      className="flex min-w-0 flex-1 items-center gap-2 bg-transparent text-left"
                                    >
                                      <span className="flex-1 truncate">{page.name}</span>
                                      {isActive && <Check className="h-3 w-3 shrink-0" />}
                                    </button>
                                  </div>
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
                                  {t('dashboards.detail.renameCurrentPage')}
                                </button>
                                <button
                                  onClick={() => { setPendingDeletePageId(activePageId); setIsPagesMenuOpen(false); }}
                                  disabled={dashboardPages.length <= 1}
                                  className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-secondary"
                                >
                                  <Trash2 className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                                  {t('dashboards.detail.deleteCurrentPage')}
                                </button>
                                <button
                                  onClick={() => { handleAddPage(); setIsPagesMenuOpen(false); }}
                                  className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                                >
                                  <Plus className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                                  {t('dashboards.detail.addPage')}
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
                  {/* Phase-B17 — compact presence: small avatars of others editing
                      now (name on hover). Replaces the bulky banner. */}
                  {canEditResource && editorChips.length > 0 && (
                    <div className="ml-2 flex shrink-0 items-center" title={t('dashboards.detail.coEditing')}>
                      {editorChips.slice(0, 3).map((c, i) => (
                        <span
                          key={i}
                          className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold text-white ring-2 ring-surface-1"
                          style={{ backgroundColor: c.color, marginLeft: i === 0 ? 0 : -6 }}
                          title={t('dashboards.detail.editorEditing', { name: c.name })}
                        >
                          {c.initials}
                        </span>
                      ))}
                      {editorChips.length > 3 && (
                        <span className="ml-1 text-[11px] text-text-tertiary">+{editorChips.length - 3}</span>
                      )}
                    </div>
                  )}
                  {/* Undo / Redo (Ctrl+Z / Ctrl+Shift+Z) — layout + theme only.
                      Shown whenever there's history (a theme change is a live
                      write with no "pending" badge, so gate on the stacks). */}
                  {canEditResource && (canUndo || canRedo) && (
                    <div className="ml-2 flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={doUndo}
                        disabled={!canUndo}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] disabled:opacity-40"
                        title={t('dashboards.detail.undo')}
                      >
                        <Undo2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={doRedo}
                        disabled={!canRedo}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] disabled:opacity-40"
                        title={t('dashboards.detail.redo')}
                      >
                        <Redo2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
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
                            ? t('dashboards.detail.unsavedTooltip')
                            : t('dashboards.detail.draftTooltip')
                        }
                      >
                        {hasLocalLayoutChanges ? t('dashboards.detail.badgeUnsaved') : t('dashboards.detail.badgeDraft')}
                      </span>
                      <button
                        type="button"
                        onClick={handleSaveDraft}
                        disabled={
                          !hasLocalLayoutChanges
                          || updateDraftLayoutMutation.isPending
                        }
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-2.5 text-[12px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] disabled:opacity-50"
                        title={t('dashboards.detail.saveDraftTooltip')}
                      >
                        {updateDraftLayoutMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        {t('dashboards.detail.saveDraft')}
                        <kbd className="ml-1 hidden rounded bg-[rgba(255,255,255,0.08)] px-1 text-[9px] text-text-tertiary sm:inline">⌘S</kbd>
                      </button>
                      <button
                        type="button"
                        onClick={handlePublish}
                        disabled={
                          publishDashboardMutation.isPending
                          || updateDraftLayoutMutation.isPending
                        }
                        className="inline-flex h-7 items-center gap-1 rounded-md bg-brand px-2.5 text-[12px] font-[510] text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
                        title={t('dashboards.detail.publishTooltip')}
                      >
                        {publishDashboardMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        {t('dashboards.detail.saveAndPublish')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setIsDiscardConfirmOpen(true)}
                        disabled={discardDraftMutation.isPending}
                        className="inline-flex h-7 items-center rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-2 text-[12px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] disabled:opacity-50"
                        title={t('dashboards.detail.discardTooltip')}
                      >
                        {t('dashboards.detail.discard')}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Primary actions — collapsed to [Filter] [⋯] [+ Add] */}
            <div className="flex shrink-0 items-center gap-1">
              {/* Data freshness — READ-ONLY. The dashboard reads the dataset's
                  refreshed data; refresh itself now happens IN THE DATASET
                  (scheduled or manual Sync & Publish, with history), so the old
                  per-dashboard "Refresh data" action was removed — a dashboard
                  rebuild never advanced a PUBLISHED dataset's pinned generation
                  anyway (misleading no-op). This just surfaces "data as of". */}
              {snapshotAsOf && (
                <span
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-2 text-[11px] font-[510] text-text-tertiary"
                  title={t('dashboards.detail.dataAsOfHint')}
                >
                  <Clock className="h-3 w-3 text-text-quaternary" />
                  <span>
                    {t('dashboards.detail.snapshotAsOf', {
                      time: new Date(snapshotAsOf).toLocaleString([], { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
                    })}
                  </span>
                </span>
              )}

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
                  title={isFilterPaneOpen ? t('dashboards.detail.hideFilterPane') : t('dashboards.detail.showFilterPane')}
                >
                  <Filter className="h-3 w-3" />
                  <span>{t('dashboards.detail.filters')}</span>
                  {appliedGlobalFilters.length > 0 && (
                    <span className="rounded-full bg-brand/20 px-1.5 text-[10px] font-[600] leading-[1.4] text-brand">
                      {appliedGlobalFilters.length}
                    </span>
                  )}
                  {hasPendingFilterChanges && (
                    <span className="h-1.5 w-1.5 rounded-full bg-warning" title={t('dashboards.detail.unappliedChanges')} />
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
                  title={t('dashboards.detail.moreOptions')}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>

                {isMoreMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => { setIsMoreMenuOpen(false); setIsWidgetSubmenuOpen(false); }} />
                    <div className="absolute right-0 z-50 mt-1.5 w-56 overflow-y-auto max-h-[80vh] rounded-lg border border-[rgba(255,255,255,0.12)] bg-surface-1 py-1 shadow-[0_4px_24px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,255,255,0.06)]">
                      {/* Export */}
                      <button
                        onClick={() => { setIsExportDialogOpen(true); setIsMoreMenuOpen(false); }}
                        disabled={isExportingPdf || !allChartsReady}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                        title={!allChartsReady ? t('dashboards.detail.loadingChartData') : t('dashboards.detail.exportAsPdf')}
                      >
                        {isExportingPdf || !allChartsReady ? (
                          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-text-quaternary" />
                        ) : (
                          <Download className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                        )}
                        {isExportingPdf ? t('dashboards.detail.exporting') : t('dashboards.detail.exportPdf')}
                      </button>

                      {/* Share team */}
                      {canShare && (
                        <button
                          onClick={() => { setIsShareDialogOpen(true); setIsMoreMenuOpen(false); }}
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                        >
                          <Share2 className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                          {t('dashboards.detail.shareWithTeam')}
                        </button>
                      )}

                      {/* Edit actions require edit rights on the CURRENT page
                          (owner-priority): a non-owner viewing a page the owner
                          holds keeps Export/Share but loses every mutation entry
                          point until the owner approves their edit request. */}
                      {canEditThisPage && (
                        <>
                          <button
                            onClick={() => { setIsPublicShareOpen(true); setIsMoreMenuOpen(false); }}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                          >
                            <Globe className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                            {t('dashboards.detail.publicLinks')}
                          </button>

                          <button
                            onClick={() => { setIsFilterMapOpen(true); setIsMoreMenuOpen(false); }}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                            title={t('dashboards.detail.filterMapTooltip')}
                          >
                            <Filter className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                            {t('dashboards.detail.filterMap')}
                          </button>

                          <div className="mx-3 my-1 border-t border-[rgba(255,255,255,0.06)]" />

                          {/* Canvas is LOCKED for now — Grid (tiled) is the standard editor.
                              "Switch to Canvas" is disabled so nobody starts a canvas layout
                              the public report can't yet render WYSIWYG. "Switch to Grid" stays
                              enabled so any dashboard already in canvas can move back to Grid. */}
                          <button
                            onClick={() => { handleToggleLayoutMode(); setIsMoreMenuOpen(false); }}
                            disabled={(dashboard?.layout_mode ?? 'grid') === 'grid'}
                            className={`flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] transition-colors ${
                              (dashboard?.layout_mode ?? 'grid') === 'grid'
                                ? 'cursor-not-allowed text-text-quaternary opacity-60'
                                : 'text-text-secondary hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary'
                            }`}
                            title={(dashboard?.layout_mode ?? 'grid') === 'grid' ? t('dashboards.detail.canvasLocked') : t('dashboards.detail.switchToGridMode')}
                          >
                            {(dashboard?.layout_mode ?? 'grid') === 'grid' ? (
                              <Move className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                            ) : (
                              <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                            )}
                            <span className="flex-1 text-left">
                              {(dashboard?.layout_mode ?? 'grid') === 'grid' ? t('dashboards.detail.switchToCanvas') : t('dashboards.detail.switchToGrid')}
                            </span>
                            {(dashboard?.layout_mode ?? 'grid') === 'grid' && (
                              <span className="rounded bg-[rgba(255,255,255,0.06)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-quaternary">
                                {t('dashboards.detail.canvasOffBadge')}
                              </span>
                            )}
                          </button>

                          {(dashboard?.layout_mode ?? 'grid') === 'grid' && (
                            <button
                              onClick={() => { handleTidyLayout(); setIsMoreMenuOpen(false); }}
                              className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                              title={t('dashboards.detail.tidyTooltip')}
                            >
                              <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                              {t('dashboards.detail.tidyLayout')}
                            </button>
                          )}

                          {(dashboard?.layout_mode ?? 'grid') === 'grid' && (
                            <button
                              onClick={() => { handleCompactUp(); setIsMoreMenuOpen(false); }}
                              className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                              title={t('dashboards.detail.compactUpTooltip')}
                            >
                              <ArrowUpToLine className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                              {t('dashboards.detail.compactUp')}
                            </button>
                          )}

                          <button
                            onClick={() => { setIsThemeOpen(true); setIsMoreMenuOpen(false); }}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                          >
                            <Palette className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                            {t('dashboards.detail.theme')}
                          </button>

                          {/* Cross-highlight is now default-on with a per-chart toggle in each
                              tile's ⋯ menu — no dashboard-wide switch needed. */}

                          <button
                            onClick={() => { setIsChartManagerOpen(true); setIsMoreMenuOpen(false); }}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                          >
                            <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                            {t('dashboards.detail.manageCharts')}
                          </button>

                          <button
                            onClick={() => { setIsHtmlImportOpen(true); setIsMoreMenuOpen(false); }}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                          >
                            <Sparkles className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                            {t('dashboards.detail.importHtml')}
                          </button>

                          {/* Widgets submenu */}
                          <div className="mx-3 my-1 border-t border-[rgba(255,255,255,0.06)]" />
                          <button
                            onClick={() => setIsWidgetSubmenuOpen((v) => !v)}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                          >
                            <Plus className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                            <span className="flex-1 text-left">{t('dashboards.detail.addWidget')}</span>
                            <ChevronDown className={`h-3 w-3 transition-transform ${isWidgetSubmenuOpen ? 'rotate-180' : ''}`} />
                          </button>
                          {isWidgetSubmenuOpen && (
                            <div className="bg-[rgba(255,255,255,0.02)]">
                              {([
                                ['section_header', t('dashboards.detail.widgetSectionHeader')],
                                ['hero_strip', t('dashboards.detail.widgetHeroStrip')],
                                ['callout', t('dashboards.detail.widgetCallout')],
                                ['text', t('dashboards.detail.widgetText')],
                                ['countdown', t('dashboards.detail.widgetCountdown')],
                                ['image', t('dashboards.detail.widgetImage')],
                                ['shape', t('dashboards.detail.widgetShape')],
                                ['parameter_switcher', t('dashboards.detail.widgetParamSwitcher')],
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

              {/* Design mode. A segmented control rather than a menu item: it
                  changes what the whole right-hand side of the screen is for,
                  and a person needs to see which mode they are in without
                  opening anything. Grid only — a canvas dashboard has no grid
                  for a composition to compile onto. */}
              {canEditThisPage && (dashboard?.layout_mode ?? 'grid') === 'grid' && (
                <div
                  className="inline-flex h-7 items-center rounded-md border border-[rgb(var(--border-line))] p-0.5"
                  role="radiogroup"
                  aria-label={t('dashboards.aiDesign.modeLabel')}
                >
                  {(['manual', 'ai'] as const).map((mode) => {
                    const active = designMode === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => {
                          // Leaving AI mode drops a preview rather than keeping
                          // it invisibly pending — an unapplied design that
                          // survives a mode switch is a change nobody can see.
                          if (mode === 'manual' && aiDesign.pending) aiDesign.discard();
                          setDesignMode(mode);
                        }}
                        className={`inline-flex h-6 items-center gap-1 rounded px-2 text-[12px] font-[510] transition-colors ${
                          active
                            ? 'bg-brand text-white'
                            : 'text-text-secondary hover:bg-[rgba(255,255,255,0.06)] hover:text-text-primary'
                        }`}
                      >
                        {mode === 'ai' && <Sparkles className="h-3 w-3" />}
                        {t(mode === 'manual' ? 'dashboards.aiDesign.modeManual' : 'dashboards.aiDesign.modeAi')}
                      </button>
                    );
                  })}
                </div>
              )}

              {canEditThisPage && (
                <button
                  onClick={() => setIsAddChartModalOpen(true)}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md bg-brand px-2.5 text-[12px] font-[510] text-white shadow-sm transition-colors hover:bg-brand-hover"
                >
                  <Plus className="h-3 w-3" />
                  <span>{t('dashboards.detail.addChart')}</span>
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
      {/* The content row goes side-by-side only when something is docked to the
          right of the grid. Without this the dock renders as a full-width block
          BELOW the report — which is what the AI panel did on first wiring: it
          was in the DOM, 380px wide, and 2000px down the page. */}
      <div className={`px-4 pb-8 sm:px-6 lg:px-8 ${isFilterPaneOpen ? 'flex gap-3 items-stretch min-h-[calc(100vh-12rem)]' : ''}`}>

        <div className={isFilterPaneOpen ? 'min-w-0 flex-1' : 'w-full'}>
        {activeCrossFilter && (
          <div className="mb-4 flex items-center gap-3 rounded-lg border border-warning/20 bg-[rgba(245,158,11,0.05)] px-4 py-2.5 text-[13px] font-[510] text-warning">
            <span>
              {t('dashboards.detail.crossFilterFrom', { title: activeCrossFilterSourceTitle ?? '' })}
            </span>
            <span className="truncate font-[400] text-text-secondary">
              {getFilterDisplayLabel(activeCrossFilter)} = {formatFilterValue(activeCrossFilter.value)}
            </span>
            {/* C3 — while the other tiles refetch against the new selection, show a
                single clear "đang lọc…" so the viewer knows the dashboard is
                updating (per-tile spinners alone read as scattered/uncertain). */}
            {chartsFetching > 0 && (
              <span className="inline-flex items-center gap-1.5 font-[400] text-text-tertiary">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('dashboards.detail.crossFilterApplying')}
              </span>
            )}
            <button
              type="button"
              onClick={() => setCrossFilterState(null)}
              className="ml-auto inline-flex items-center rounded border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-2.5 py-1 text-[12px] font-[510] text-text-secondary transition-colors hover:text-text-primary"
            >
              {t('dashboards.detail.clear')}
            </button>
          </div>
        )}

        {/* SlicerCluster and the dashboard grid share the selected dock layout. */}
        <div
          className={dockLayoutClasses(effectiveFilterDock).wrapper}
          style={effectiveFilterDock === 'drawer' ? { position: 'relative' } : undefined}
        >
        {(draftGlobalSlicers.length > 0 || draftPageSlicers.length > 0 || canEditResource) && (
          <SlicerCluster
            // Editor shows ALL slicers (incl. ones a 'custom' scope hides on
            // this page) so the author can always open ⚙ to reconfigure; the
            // per-page VISIBLE hiding is applied only on the public viewer.
            // The chart PREVIEW still respects scope via effectivePageScopeFilters
            // (only slicers that filter the active page are applied).
            items={orderedSlicerChildren}
            onChildrenChange={handleSlicerChildrenChange}
            layout={draftSlicerClusterLayout}
            onLayoutChange={setDraftSlicerClusterLayout}
            columns={resolvedAvailableColumns}
            columnChartCount={resolvedColumnChartCount}
            distinctValues={resolvedDistinctValues}
            distinctStatus={semanticDistinctStatus}
            // Type-to-search over the FULL cached distinct set (high-cardinality
            // slicers). Hits the BE result cache (no per-keystroke BigQuery). The
            // search results cascade by the OTHER active slicers/filters — same
            // context the prefetch uses — so a searched value is still narrowed
            // consistently (getDistinctValueFilterContext self-strips this field).
            fetchServerDistinct={async (column, search) => {
              if (!column.datasetId || !column.semanticField) return [];
              try {
                const legacyDraftAll = draftGlobalFilters
                  .map((f) => toBaseFilter(f, { allowInactive: true }))
                  .filter((b): b is BaseFilter => b !== null);
                const ctx = resolveEffectiveFilterSet({
                  globalFilters: legacyDraftAll,
                  pageFilters: draftPageFilters,
                  globalSlicers: draftGlobalSlicers as BaseFilter[],
                  pageSlicers: draftPageSlicers as BaseFilter[],
                  activePageId,
                  slicerFiltersPage,
                });
                const filterContext = getDistinctValueFilterContext(ctx, column);
                const res = await fetchDatasetModelDistinctValues(
                  column.datasetId, column.semanticField, 500, filterContext, search,
                );
                return res.values ?? [];
              } catch {
                return [];
              }
            }}
            // Per-slicer scope config (⚙): Chỉ trang này / Tất cả trang /
            // Tùy chọn theo trang (ma trận Lọc/Hiện). Build only.
            showScopeToggle={canEditResource}
            dashboardPages={dashboardPages.map((p) => ({ id: p.id, name: (p as any).name || p.id }))}
            activePageId={activePageId}
            onUpdateSlicerScope={handleUpdateSlicerScope}
            onOpenFilterMap={canEditResource ? () => setIsFilterMapOpen(true) : undefined}
            hasPendingChanges={JSON.stringify(draftGlobalSlicers) !== JSON.stringify(appliedGlobalSlicers)
              || JSON.stringify(draftPageSlicers) !== JSON.stringify(activePageSlicers)
              || JSON.stringify(draftSlicerClusterLayout) !== JSON.stringify(appliedSlicerClusterLayout)}
            onApply={canEditResource ? () => handleApplyFilters('all') : undefined}
            onReset={canEditResource ? () => {
              setDraftGlobalSlicers(appliedGlobalSlicers);
              setDraftPageSlicers(activePageSlicers);
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
          className={dockLayoutClasses(effectiveFilterDock).content}
        >
        {/* Phase-B19 — per-page co-edit banners (owner-priority + request→approve).
            Never shown during PDF export. */}
        {!isExportingPdf && canEditResource && editLock && !editLock.i_am_owner && !editLock.can_edit && activePageId && (
          <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-200">
            <span className="flex items-center gap-2">
              <Lock className="h-3.5 w-3.5 shrink-0" />
              {editLock.holder_name
                ? t('dashboards.detail.pageHeldBy', { name: editLock.holder_name })
                : t('dashboards.detail.pageViewOnly')}
            </span>
            {pendingEditRequests.some((r) => r.requester_key === me?.id) ? (
              <span className="shrink-0 text-amber-300/80">{t('dashboards.detail.editRequested')}</span>
            ) : (
              <button
                type="button"
                onClick={() => requestEdit(activePageId)}
                className="shrink-0 rounded-md bg-amber-500/20 px-2.5 py-1 text-[12px] font-[510] text-amber-100 transition-colors hover:bg-amber-500/30"
              >
                {t('dashboards.detail.requestEdit')}
              </button>
            )}
          </div>
        )}
        {!isExportingPdf && isOwner && activePageId && pendingEditRequests.length > 0 && (
          <div className="mb-2 space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            {pendingEditRequests.map((r) => (
              <div key={r.requester_key} className="flex items-center justify-between gap-3 text-[13px] text-amber-200">
                <span className="flex items-center gap-2">
                  <Hand className="h-3.5 w-3.5 shrink-0" />
                  {t('dashboards.detail.editRequestFrom', { name: r.name || r.email || '?' })}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => respondEditRequest(activePageId, r.requester_key, true)}
                    className="rounded-md bg-emerald-500/25 px-2.5 py-1 text-[12px] font-[510] text-emerald-100 transition-colors hover:bg-emerald-500/35"
                  >
                    {t('dashboards.detail.approve')}
                  </button>
                  <button
                    type="button"
                    onClick={() => respondEditRequest(activePageId, r.requester_key, false)}
                    className="rounded-md bg-[rgba(255,255,255,0.08)] px-2.5 py-1 text-[12px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.12)]"
                  >
                    {t('dashboards.detail.deny')}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        <ExportModeContext.Provider value={exportRenderMode}>
        {(dashboard?.layout_mode ?? 'grid') === 'canvas' ? (
          <DashboardCanvas
            dashboardId={dashboardId}
            dashboardCharts={visibleDashboardCharts}
            canvasConfig={dashboard?.canvas_config}
            canEdit={canEditThisPage}
            allowAppearanceEdit={canEditThisPage}
            onLayoutChange={canEditThisPage ? handleCanvasLayoutChange : undefined}
            onRemoveChart={canEditThisPage ? handleRemoveChart : undefined}
            onEditWidget={canEditThisPage ? setEditingWidgetId : undefined}
            removingChartId={removingChartId}
            filtersReady={filtersReady}
            globalFilters={effectiveFiltersWithParams}
            crossFilters={activeCrossFilter ? [activeCrossFilter] : []}
            crossFilterSourceChartId={crossFilterState?.sourceChartId ?? null}
            highlightFilter={activeHighlight}
            highlightSourceChartId={highlightSourceChartId}
            onChartDataLoaded={semanticColumnsResult.columns.length > 0 ? undefined : handleChartDataLoaded}
            onSelectCrossFilter={handleCrossFilterChange}
            availablePages={dashboardPages}
            onMoveChartToPage={canEditThisPage ? handleMoveChartToPage : undefined}
            emptyMessage={emptyPageMessage}
            focusedDashboardChartId={focusedTileId}
            onFocusChart={setFocusedTileId}
            params={paramValues}
            onParamChange={handleParamChange}
            onBindParameter={canEditThisPage ? setBindingChartId : undefined}
          />
        ) : (
          <DashboardGrid
            dashboardId={dashboardId}
            dashboardCharts={visibleDashboardCharts}
            canEdit={canEditThisPage}
            allowAppearanceEdit={canEditThisPage}
            themeConfig={dashboard?.theme_config}
            onLayoutChange={canEditThisPage ? handleLayoutChange : undefined}
            presenceByChart={presenceByChart}
            onRemoveChart={canEditThisPage ? handleRemoveChart : undefined}
            onEditWidget={canEditThisPage ? setEditingWidgetId : undefined}
            removingChartId={removingChartId}
            filtersReady={filtersReady}
            globalFilters={effectiveFiltersWithParams}
            crossFilters={activeCrossFilter ? [activeCrossFilter] : []}
            crossFilterSourceChartId={crossFilterState?.sourceChartId ?? null}
            highlightFilter={activeHighlight}
            highlightSourceChartId={highlightSourceChartId}
            onChartDataLoaded={semanticColumnsResult.columns.length > 0 ? undefined : handleChartDataLoaded}
            onSelectCrossFilter={handleCrossFilterChange}
            availablePages={dashboardPages}
            onMoveChartToPage={canEditThisPage ? handleMoveChartToPage : undefined}
            emptyMessage={emptyPageMessage}
            focusedDashboardChartId={focusedTileId}
            onFocusChart={setFocusedTileId}
            aiDesignMode={designMode === 'ai'}
            params={paramValues}
            onParamChange={handleParamChange}
            onBindParameter={canEditThisPage ? setBindingChartId : undefined}
          />
        )}
        </ExportModeContext.Provider>
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

        {/* Right dock: AI Design — a FLOATING overlay, not a flex sibling.
            Docking it in the flow shrank the grid the model was redesigning, and
            when the slicer rail then took its share the grid collapsed to a
            single stacked column: the "charts jumping" a person sees. As a fixed
            drawer it sits OVER the report at a stable width, the grid keeps the
            frame it will publish at (the page reserves `lg:pr` for the drawer so
            nothing hides behind it), and typing a long instruction grows the box
            inside the drawer instead of reflowing the whole page. */}
        {designMode === 'ai' && (aiPanelCollapsed ? (
          <button
            type="button"
            onClick={() => setAiPanelCollapsed(false)}
            aria-label={t('dashboards.aiDesign.title')}
            className="fixed right-5 bottom-5 z-30 inline-flex h-12 w-12 items-center justify-center rounded-full bg-brand text-white shadow-xl transition-transform hover:scale-105"
          >
            <Sparkles className="h-5 w-5" />
            {/* A dot when a design is waiting, so a collapsed bubble still says
                "there is something to look at". */}
            {aiDesign.pending && (
              <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full bg-warning ring-2 ring-[rgb(var(--surface-1))]" />
            )}
          </button>
        ) : (
          <div className="fixed right-3 top-[64px] bottom-3 z-30 w-[380px] max-w-[calc(100vw-1.5rem)] shadow-xl rounded-xl">
            <AiDesignPanel
              turns={aiDesign.turns}
              busy={aiDesign.busy}
              scope={aiDesign.scope}
              onScopeChange={aiDesign.setScope}
              onSubmit={aiDesign.submit}
              pendingDiff={aiDesign.pending?.diff ?? null}
              onApply={aiDesign.apply}
              onDiscard={aiDesign.discard}
              onCollapse={() => setAiPanelCollapsed(true)}
              onClose={() => { aiDesign.discard(); setDesignMode('manual'); }}
              visualCount={aiDesign.visualCount}
              pageName={currentPage?.name ?? activePageId}
              focusedChartName={focusedChartName}
              onClearFocus={() => setFocusedTileId(null)}
              onRetryEntireReport={aiDesign.retryEntireReport}
            />
          </div>
        ))}

        {/* Right dock: Filter Pane (Phase-15.81). Sticky alongside the
            canvas; sections own visual / page / all-pages scope. */}
        {isFilterPaneOpen && (
          <aside className="hidden lg:flex w-[300px] flex-shrink-0 flex-col overflow-hidden rounded-lg border border-[rgb(var(--border-line))] self-stretch">
            <FilterPane
              columns={resolvedAvailableColumns}
              distinctValues={resolvedDistinctValues}
              distinctStatus={semanticDistinctStatus}
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

        {/* Phase-B17 — publish conflict: someone else published since load. */}
        {publishConflict && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-sm rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4 shadow-linear-lg">
              <h2 className="text-sm font-semibold text-text-primary">{t('dashboards.detail.publishConflictTitle')}</h2>
              <p className="mt-1.5 text-[13px] leading-5 text-text-secondary">
                {t('dashboards.detail.publishConflictSaved', { editor: publishConflict.editor || t('dashboards.detail.someoneElse') })}{' '}
                <b>{publishConflict.tiles && publishConflict.tiles.length > 0 ? publishConflict.tiles.join(', ') : t('dashboards.detail.thisChart')}</b>.
              </p>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPublishConflict(null)}
                  className="rounded-md px-2.5 py-1.5 text-[13px] text-text-tertiary hover:text-text-primary"
                >
                  {t('dashboards.detail.conflictLater')}
                </button>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="rounded-md bg-brand px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90"
                >
                  {t('dashboards.detail.conflictReload')}
                </button>
                <button
                  type="button"
                  onClick={handleForcePublish}
                  className="rounded-md border border-danger/40 px-3 py-1.5 text-[13px] font-medium text-danger hover:bg-danger/10"
                >
                  {t('dashboards.detail.conflictOverwrite')}
                </button>
              </div>
            </div>
          </div>
        )}

        <ExportPdfDialog
          isOpen={isExportDialogOpen}
          onClose={() => { if (!isExportingPdf) setIsExportDialogOpen(false); }}
          pages={dashboardPages.map((p) => ({ id: p.id, name: p.name }))}
          isExporting={isExportingPdf}
          progress={exportProgress}
          onExport={doExportPdf}
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
          title="Discard layout changes?"
          description="All changes (local edits + saved draft) will be discarded. The dashboard reverts to the last published layout. This cannot be undone."
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
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

        {/* Bản đồ filter — read-only at-a-glance overview of every filter source */}
        {isFilterMapOpen && dashboard && (
          <FilterMapModal
            dashboard={dashboard}
            onClose={() => setIsFilterMapOpen(false)}
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

        <ParameterBindModal
          isOpen={bindingChartId !== null}
          onClose={() => setBindingChartId(null)}
          dashboardId={dashboardId}
          chart={
            bindingChartId !== null
              ? (dashboard.dashboard_charts ?? []).find((dc) => dc.id === bindingChartId) ?? null
              : null
          }
          paramDefs={paramDefs}
        />

        {isThemeOpen && dashboard && (
          <DashboardThemeModal
            initial={dashboard.theme_config}
            onClose={() => setIsThemeOpen(false)}
            onSave={async (theme) => {
              // Snapshot the current theme so Ctrl+Z can restore it (same live
              // update path a manual change uses → cannot corrupt the draft).
              // Use {} (→ server defaults) not null: normalize_dashboard_theme_config
              // does dict(x) and would throw on a null restore.
              pushUndo({ kind: 'theme', prev: dashboard?.theme_config ?? {}, next: theme });
              // A templateId in the payload means the user chose a LAYOUT, and a
              // layout owns the filter dock — so release any stored position.
              await applyThemeConfig(theme, { releaseDock: Boolean((theme as any)?.templateId) });
            }}
            onApplyLayout={async (templateId) => {
              // The other half of picking a template. Snapshot first: this moves
              // every tile, and someone who tried it on a report they had
              // arranged by hand needs one keystroke back.
              //
              // Snapshotting the OVERRIDES alone is not that keystroke. An undo
              // restores `localLayoutOverrides`, and those merge over whatever
              // the server holds -- so once the server has been re-flowed, an
              // empty override map "restores" the new shape and Ctrl+Z appears
              // to do nothing. What has to be captured is the geometry ITSELF,
              // as an override per re-flowed tile, which both redraws the old
              // shape and is what a later save would persist.
              const reflowedTiles = (serverDashboard?.dashboard_charts ?? []).filter((dc) => {
                const page = (dc.layout as any)?.pageId ?? null;
                return activePageId ? page === activePageId || page === null : true;
              });
              const geometryBefore: Record<number, Record<string, any>> = {};
              for (const dc of reflowedTiles) {
                const layout = (dc.layout ?? {}) as Record<string, any>;
                if (typeof layout.x !== 'number' || typeof layout.y !== 'number') continue;
                geometryBefore[dc.id] = {
                  ...(localLayoutOverrides[dc.id] ?? {}),
                  x: layout.x, y: layout.y, w: layout.w, h: layout.h,
                  ...(layout.gv != null ? { gv: layout.gv } : {}),
                };
              }
              pushUndo({ kind: 'layout', prev: geometryBefore, next: {} });
              try {
                // Templates and AI Design go through the SAME compiler (§19).
                // This used to POST to a server-side relayout that had its own
                // copy of the recipes, which meant a quality fix -- a readable
                // KPI height, a chart that never gets a third of the width --
                // landed on one path and not the other. Compiling here keeps
                // one engine, and Apply lands in the same draft a drag does.
                const pageTiles = tilesOnPage(dashboard, activePageId);
                const baseline = tilesWithLocalEdits(dashboard, localLayoutOverrides, pageTiles);
                if (baseline.length === 0) {
                  toast.info(t('dashboards.themeModal.relayoutEmpty'));
                  return;
                }
                const snapshot = buildPresentationSnapshot({
                  dashboard: dashboard!,
                  tiles: baseline,
                  pageId: activePageId,
                  pageName: currentPage?.name ?? activePageId,
                  pageCount: dashboardPages.length,
                  slicers: [...draftGlobalSlicers, ...draftPageSlicers],
                  slicerDock: effectiveFilterDock,
                });
                // Layout only. Picking a template in the modal already applies
                // its colours through the theme path; re-applying them here
                // would repaint every page as a side effect of a layout button.
                const plan = planFromTemplate(templateId, snapshot, 'page');
                const built = buildPresentationMutation({
                  plan,
                  snapshot,
                  tiles: baseline,
                  pageId: activePageId,
                  currentTheme: dashboard?.theme_config,
                  gridGapPx: getDashboardGridMargin(dashboard?.theme_config)[1],
                });
                if (!built.ok) {
                  toast.error(t('dashboards.themeModal.relayoutFailed'));
                  return;
                }
                setLocalLayoutOverrides((previous) => toLocalLayoutOverrides(built.mutation, previous));
                toast.success(t('dashboards.themeModal.relayoutDone'));
              } catch {
                toast.error(t('dashboards.themeModal.relayoutFailed'));
              }
            }}
          />
        )}
    </DashboardThemeProvider>
  );
}
