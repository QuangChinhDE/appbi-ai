'use client';

import { sectionTitlesOf } from '@/lib/report-meta';
import { clearReportAnchor, reportAnchor, stampReportAnchor } from '@/lib/report-anchor';
import React, { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useIsStudioPreview, isStudioMessage, studioFrameId, type StudioMessage, type StudioPreviewState } from '@/lib/studio/preview-mode';
import { StudioPreview, STUDIO_DEVICE_WIDTH } from '@/components/dashboards/StudioPreview';
import { pendingWork } from '@/lib/dashboard-presentation/vision-review';
import { ArrowLeft, Plus, Loader2, Edit2, Check, X, Share2, Globe, Sparkles, Trash2, LayoutGrid, Download, MoreHorizontal, ChevronDown, Filter, Clock, GripVertical, Lock, Hand, PanelRight } from 'lucide-react';
import { Layout } from 'react-grid-layout';
import { useQueries, useIsFetching, useQueryClient } from '@tanstack/react-query';
import {
  useDashboard,
  useUpdateDashboard,
  useAddChartToDashboard,
  useRemoveChartFromDashboard,
  useUpdateDashboardDraftLayout,
  usePublishDashboard,
  useDiscardDashboardDraft,
} from '@/hooks/use-dashboards';
import { dashboardApi, SHARED_DRAFT_CONFLICT_EVENT } from '@/lib/api/dashboards';
import { DashboardGrid } from '@/components/dashboards/DashboardGrid';
import { DashboardThemeProvider, getDashboardGridMargin } from '@/components/dashboards/DashboardThemeProvider';
import { AiDesignPanel } from '@/components/dashboards/ai-design/AiDesignPanel';
import { planFromTemplate } from '@/lib/dashboard-presentation/templates';
import { buildFieldMetaIndex } from '@/lib/dashboard-presentation/design-context';
import { auditRenderedTiles } from '@/lib/dashboard-presentation/render-audit';
import { buildPresentationSnapshot, tilesOnPage } from '@/lib/dashboard-presentation/snapshot';
import { buildPresentationMutation, tilesWithLocalEdits, toLocalLayoutOverrides } from '@/lib/dashboard-presentation/executor';
import { useAiDesign } from '@/components/dashboards/ai-design/useAiDesign';
import { DashboardThemeModal } from '@/components/dashboards/DashboardThemeModal';
import { Palette, Undo2, Redo2, ArrowUpToLine, Eye } from 'lucide-react';
import { ChartTile } from '@/components/dashboards/ChartTile';
import { WidgetEditModal } from '@/components/dashboards/WidgetEditModal';
import { ParameterBindModal } from '@/components/dashboards/ParameterBindModal';
import { AddChartModal } from '@/components/dashboards/AddChartModal';
import { AddElementMenu } from '@/components/dashboards/AddElementMenu';
import { ReportInspector, type PendingContentSave } from '@/components/dashboards/ReportInspector';
import { getEffectiveDashboardChartStyleConfig } from '@/lib/dashboard-chart-style';
import { resolveTileFrame } from '@/lib/dashboard-presentation/tile-frame';
import { applyLayoutPattern, type LayoutPattern } from '@/lib/report-patterns';
import { measureNaturalHeight, rowsForHeight } from '@/lib/fit-content';
import { ReportMetaProvider } from '@/lib/report-meta';
import { widgetTypeLabel as WIDGET_TYPE_LABEL } from '@/components/dashboards/widget-forms';
import { planKeyForElement, PRINTABLE_ELEMENT_TYPES } from '@/lib/export-layout';
import { apiClient } from '@/lib/api-client';
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
import { DashboardChartLayout, DashboardPageConfig } from '@/types/api';
import type { BaseFilter, ColumnInfo, FilterType, Filter as TypedFilter } from '@/lib/filters';
import {
  applyScopeBound,
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
  resolveEffectiveFilterSet,
  toBaseFilter,
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
  compactPageUp,
  normalizeDashboardGridForRender,
  GRID_VERSION,
  DASHBOARD_GRID_COLS,
  mergeGridLayout,
  dashboardRowHeight,
} from '@/lib/dashboard-pages';
import { GridSlicerTile, FilterApplyBar, SlicerControlScope, stagedSlicerIds } from '@/components/dashboards/GridSlicerTile';
import { AddSlicerModal } from '@/components/dashboards/AddSlicerModal';
import { ArrangeBar, type TileFrame } from '@/components/dashboards/ArrangeBar';
import { arrangeTiles, closeVacatedBand, nudgeTiles, placeBeside, resolveDrop, type ArrangeOp, type ArrangeResult, type GridBox } from '@/lib/grid-arrange';
import {
  freezeLayout, overlayProfiles, resolveReportLayout, withCells,
  type CustomProfile, type DeviceBreakpoint, type GridItem, type ProfileDraft, type ResolvedLayout,
} from '@/lib/responsive-layout/resolve';
import { fitLayoutToContent } from '@/lib/responsive-fit';
import type { ResolvedLayoutSummary } from '@/components/dashboards/DashboardGrid';
import { adoptableUnder, lockedMemberOf, moveSection, resolveStructure, sectionForPosition, structureIssues, insertionFor, toStructTiles, type StructTile } from '@/lib/report-structure';
import { pageFilterFacts, statePageFilterFact } from '@/lib/public-page-filters';
import { settleStoredLayout } from '@/lib/grid-settle';
import {
  SLICER_CONTROL_SIZE,
  SLICER_CONTROL_WIDGET,
  nextFreeSlot,
  placedSlicerIds,
  replaceSlicerById,
  isSlicerControl,
  slicerIdOfControl,
  type SlicerTreatment,
} from '@/lib/slicer-placement';
import { createSlicerEntry, defaultInteractionFor } from '@/lib/slicer-entry';
import { toast } from '@/lib/toast';
import { useI18n } from '@/providers/LanguageProvider';
import { ReportEvidenceProvider, useReportFindings } from '@/lib/report-evidence';
import { renderFindingSentence } from '@/lib/report-findings';
import { coerceModelProposals, deriveProposals, type ContentProposal, type TileContext } from '@/lib/dashboard-presentation/proposals';

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

/** Drop keys whose value is `undefined` — a theme patch uses them to CLEAR a
 *  key, and a cleared key must not be persisted as an explicit null. */
function stripUndefined<T extends Record<string, any>>(value: T): T {
  const out: Record<string, any> = {};
  for (const [key, v] of Object.entries(value)) if (v !== undefined) out[key] = v;
  return out as T;
}

function DashboardDetailPageInner() {
  const { t, locale } = useI18n();
  const params = useParams();
  const router = useRouter();
  const dashboardId = Number(params.id);

  // One relative-date anchor for every tile of this report read (stamped during
  // render, before react-query sends the tile requests, so a load across
  // midnight cannot mix windows). Re-stamped when the opened dashboard changes.
  const anchorStampedRef = React.useRef<number | null>(null);
  if (anchorStampedRef.current !== dashboardId) {
    anchorStampedRef.current = dashboardId;
    stampReportAnchor();
  }

  const [isAddChartModalOpen, setIsAddChartModalOpen] = useState(false);
  const [isHtmlImportOpen, setIsHtmlImportOpen] = useState(false);
  const [isChartManagerOpen, setIsChartManagerOpen] = useState(false);
  const [removingChartId, setRemovingChartId] = useState<number | undefined>();
  const [pendingRemoveDashboardChartId, setPendingRemoveDashboardChartId] = useState<number | undefined>();
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState('');
  // The Inspector's report name/description differ from the saved row.
  const [reportDetailsDirty, setReportDetailsDirty] = useState(false);
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
  // A theme change (AI Design Apply, the theme menu, an undo) that is not yet
  // saved. It is an unsaved edit exactly like a drag: rendered immediately,
  // staged into the server DRAFT on Save draft, and published — together with
  // the layout, in one server transaction — on Publish. Nothing writes the
  // published theme directly any more. Discard drops it.
  const [pendingThemeConfig, setPendingThemeConfig] = useState<any | null>(null);
  // Blocks an AI Design preview adds (negative temporary ids). Rendered through
  // the same page memo as every tile, so the preview shows what Apply creates.
  const [previewBlocks, setPreviewBlocks] = useState<any[] | null>(null);
  // An AI design being LOOKED at: the theme keys and slicer-cluster keys it
  // would write. A view layer only — never staged — so the preview shows the
  // dock/variant/density exactly as Apply will, and Discard is free.
  const [previewPresentation, setPreviewPresentation] = useState<{
    theme: Record<string, any>;
    slicerCluster: Record<string, any>;
  } | null>(null);
  const slicersSeededRef = React.useRef(false);
  const [isApplyingFilters, setIsApplyingFilters] = useState(false);
  const [crossFilterState, setCrossFilterState] = useState<{
    sourceChartId: number;
    filter: BaseFilter;
  } | null>(null);
  // A changed applied read (filters, slicers, cross-filter) is a NEW logical report
  // read → fresh anchor, stamped during render so it precedes the tile refetches.
  // Leaving the report clears it, so Explore/Datasets/Datasources requests made
  // afterwards never inherit this report's relative-date anchor.
  const readSignature = JSON.stringify([appliedGlobalFilters, appliedGlobalSlicers, crossFilterState]);
  const readSignatureRef = React.useRef<string | null>(null);
  if (readSignatureRef.current !== readSignature) {
    if (readSignatureRef.current !== null) stampReportAnchor();
    readSignatureRef.current = readSignature;
  }
  // Unmount only (a dashboard change re-stamps during render above). The mount
  // half re-stamps if a dev StrictMode remount cleared it.
  React.useEffect(() => {
    if (!reportAnchor()) stampReportAnchor();
    return () => clearReportAnchor();
  }, []);
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
  const [isAddElementOpen, setIsAddElementOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
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
  // Device layouts (docs/responsive-dashboard-layouts.md). The Builder canvas
  // renders at a device's representative width; Tablet/Phone are AUTO (derived
  // from desktop) until the author customises them. Unsaved device edits live
  // here (pageId → md|xs → CUSTOM layout | reset marker) until Save draft.
  const [deviceMode, setDeviceMode] = useState<'desktop' | 'tablet' | 'phone'>('desktop');
  const [localResponsive, setLocalResponsive] = useState<Record<string, Partial<Record<DeviceBreakpoint, ProfileDraft>>>>({});
  const localResponsiveRef = React.useRef(localResponsive);
  localResponsiveRef.current = localResponsive;
  const hasLocalResponsiveChanges = Object.values(localResponsive).some((perBp) => Object.keys(perBp ?? {}).length > 0);
  const hasAnyPendingChanges = hasLocalLayoutChanges || hasLocalResponsiveChanges || Boolean(serverDashboard?.has_draft) || Boolean(pendingThemeConfig);
  /** Unsaved = not yet in the server draft: local layout / device edits or a theme. */
  const hasUnsavedPresentation = hasLocalLayoutChanges || hasLocalResponsiveChanges || Boolean(pendingThemeConfig);
  // Mirror of hasUnsavedWork (declared below, once every author buffer exists) so
  // the mount-only leave handlers see the current value.
  const unsavedWorkRef = React.useRef(false);
  const leaveGuardEntryRef = React.useRef(false);
  const leaveGuardBypassPopRef = React.useRef(false);
  // A link clicked while the guard's own history.back() is still in flight is
  // queued and followed once that pop lands — else the late pop would bounce
  // the user straight back to this dashboard.
  const queuedNavRef = React.useRef<string | null>(null);
  const leaveGuardUrlRef = React.useRef('');
  const leaveGuardKeyRef = React.useRef(`appbi-dashboard-${dashboardId}`);
  /** Confirm before discarding an unsaved theme/layout edit on navigation.
   *  Returns true when it is safe to leave. */
  const confirmLeaveIfUnsaved = React.useCallback((): boolean => {
    if (!unsavedWorkRef.current) return true;
    return window.confirm(t('dashboards.detail.unsavedLeaveConfirm'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** True for the WHOLE save (layout, then theme, then filters) — not just the
   *  layout request — so the controls never report "saved" half-way through. */
  const [isStagingDraft, setIsStagingDraft] = useState(false);
  // An AI Apply commits in steps (create its blocks, then move the tiles).
  // Save/Publish in between would stage the OLD layout with the NEW blocks —
  // the published report then had the blocks at the bottom and every chart
  // where it was. Nothing is staged or published while a commit is running.
  const [isCommittingPresentation, setIsCommittingPresentation] = useState(false);
  const committingPresentationRef = React.useRef(false);
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
      && !pendingThemeConfig
      && !previewBlocks?.length
      && (!beDrafts || Object.keys(beDrafts).length === 0)
    ) {
      return serverDashboard;
    }
    return {
      ...serverDashboard,
      ...(pendingThemeConfig ? { theme_config: pendingThemeConfig } : {}),
      dashboard_charts: [...serverDashboard.dashboard_charts, ...((previewBlocks ?? []) as any[])].map((dc) => {
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
  }, [serverDashboard, localLayoutOverrides, hasLocalLayoutChanges, previewLayoutOverrides, pendingThemeConfig, previewBlocks]);

  // The dock the CLUSTER will actually use. Resolved here too so the wrapper
  // that positions the cluster beside the grid cannot disagree with the
  // cluster's own decision — the theme supplies the default composition, an
  // explicit author placement overrides it.
  // What the page RENDERS: the draft, with an AI design under preview laid over
  // it. Staging always reads `draftSlicerClusterLayout`; only the view reads this.
  const viewSlicerClusterLayout = React.useMemo(
    () => (previewPresentation && Object.keys(previewPresentation.slicerCluster).length > 0
      ? { ...(draftSlicerClusterLayout ?? {}), ...previewPresentation.slicerCluster }
      : draftSlicerClusterLayout),
    [draftSlicerClusterLayout, previewPresentation],
  );
  const viewThemeConfig = React.useMemo(
    () => (previewPresentation && Object.keys(previewPresentation.theme).length > 0
      ? { ...(dashboard?.theme_config ?? {}), ...previewPresentation.theme }
      : dashboard?.theme_config),
    [dashboard?.theme_config, previewPresentation],
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
  const resPerms = getResourcePermissions(dashboard?.user_permission, dashboard?.capabilities);
  const canShare = resPerms.canShare;
  // The Studio preview iframe is a viewer of this page: no editing, no edit
  // lock, no presence heartbeat (it would otherwise compete with the author's
  // own tab for the page lock).
  const studioPreview = useIsStudioPreview();
  const canEditResource = resPerms.canEdit && !studioPreview;
  // Phase-B17 — publish conflict (someone else published the SAME tiles).
  const [publishConflict, setPublishConflict] = useState<{ editor: string | null; tiles?: string[] } | null>(null);
  // The shared filters/pages/theme draft holds another author's edits: Publish
  // or Discard asks whether to include them (never silently).
  const [sharedChoice, setSharedChoice] = useState<{ action: 'publish' | 'discard'; authors: string[]; rev: string; tileBaseV?: Record<string, number> } | null>(null);
  // Someone changed the shared draft since this page loaded; a write was refused.
  const [sharedStale, setSharedStale] = useState<{ by: string | null } | null>(null);
  useEffect(() => {
    const onConflict = (e: Event) => {
      const detail = (e as CustomEvent<{ dashboardId: number; by: string | null }>).detail;
      if (detail?.dashboardId === dashboardId) setSharedStale({ by: detail.by ?? null });
    };
    window.addEventListener(SHARED_DRAFT_CONFLICT_EVENT, onConflict);
    return () => window.removeEventListener(SHARED_DRAFT_CONFLICT_EVENT, onConflict);
  }, [dashboardId]);
  const updateDashboardMutation = useUpdateDashboard();
  const addChartMutation = useAddChartToDashboard();
  // Charts added from the Add palette go under the ONE selected element, as a
  // block (the picker lays a batch out in rows; the block keeps that).
  const insertBatchRef = React.useRef<{ anchorId: number; ids: number[]; closed: boolean } | null>(null);
  const [insertBatchTick, setInsertBatchTick] = useState(0);
  const removeChartMutation = useRemoveChartFromDashboard();
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
    /** Draft-only blocks this step created (next side only). Undo removes them;
     *  redo creates them again from `createdBlockSpecs` and records the new ids. */
    createdBlockIds?: number[];
    createdBlockSpecs?: { widgetType: string; widgetConfig: Record<string, unknown>; layout: Record<string, unknown> }[];
  };
  /** An element removed in the draft that was never published: Undo creates
   *  it again (draft-only) from this. */
  type RemovedDraftSpec = {
    widgetType: string;
    chartId: number | null;
    widgetConfig: Record<string, unknown>;
    layout: Record<string, unknown>;
    parameters?: Record<string, unknown>;
  };
  type UndoEntry =
    | { kind: 'layout'; prev: Record<number, Record<string, any>>; next: Record<number, Record<string, any>> }
    // A device layout edit (Customize, a drag on the tablet/phone, Reset…): the
    // page/breakpoint's unsaved draft before and after. Never touches desktop.
    | { kind: 'responsive'; pageId: string; bp: DeviceBreakpoint; prev: ProfileDraft | undefined; next: ProfileDraft | undefined }
    | { kind: 'theme'; prev: any; next: any }
    | { kind: 'ai-presentation'; prev: PresentationState; next: PresentationState }
    // Removing elements. A PUBLISHED one is only marked removed in the draft, so
    // Undo restores that same row (still published) and Redo marks it again. One
    // added in this draft was deleted: Undo creates it again and records the new
    // id for Redo. `prev`/`next` are the layout around it (a band that closed).
    | {
      kind: 'removal';
      published: number[];
      drafts: RemovedDraftSpec[];
      draftIds: number[];
      prev: Record<number, Record<string, any>>;
      next: Record<number, Record<string, any>>;
    };
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
  // Apply a theme_config — reused by the theme menu and by theme undo/redo so
  // both go through one path. It is an unsaved DRAFT edit: rendered at once
  // through the page memo (so a refetch cannot undo it), staged on Save draft,
  // published with the layout on Publish.
  /** Apply a theme as a draft edit (the theme menu, AI Apply, an undo). */
  const applyThemeConfig = async (theme: any) => {
    // A theme change is an unsaved edit: rendered now, saved with the draft,
    // published with the layout. (It used to PUT the live theme_config at once,
    // so picking a colour in the menu — or an AI "Save draft" — repainted the
    // PUBLISHED report while its layout was still the old one.)
    paintThemeDraft(theme);
  };
  /** Render a theme as an unsaved edit. The page memo overlays it, so a refetch
   *  cannot wipe it; Save draft stages it, Discard drops it. */
  const paintThemeDraft = (theme: any) => {
    setPendingThemeConfig(theme);
  };

  /** Stage the unsaved theme into the SERVER DRAFT (never the live row). Returns
   *  false — and leaves it unsaved — when the server refused, so Save/Publish
   *  can say so instead of reporting a success that did not happen. */
  const stagePendingTheme = async (): Promise<boolean> => {
    if (!pendingThemeConfig) return true;
    const theme = pendingThemeConfig;
    try {
      const updated = await dashboardApi.updateDraftFilters(dashboardId, { theme_config: theme });
      if (updated) queryClient.setQueryData(['dashboards', dashboardId], updated);
      // Only clear it if nothing newer was painted while the request was in flight.
      setPendingThemeConfig((current: any) => (current === theme ? null : current));
      return true;
    } catch (err) {
      console.error('Failed to stage theme draft:', err);
      return false;
    }
  };

  /** Stage the slicer-cluster draft NOW (it is normally staged 500ms after a
   *  change). Save/Publish must not race that debounce, or a dock change made
   *  just before publishing would be left out of the published report. */
  const stageSlicerClusterLayout = async (): Promise<boolean> => {
    if (JSON.stringify(draftSlicerClusterLayout) === JSON.stringify(appliedSlicerClusterLayout)) return true;
    const cluster = draftSlicerClusterLayout;
    try {
      await dashboardApi.updateDraftFilters(dashboardId, { slicer_cluster_layout: cluster ?? {} });
      setAppliedSlicerClusterLayout(cluster);
      return true;
    } catch (err) {
      console.error('Failed to stage slicer cluster layout:', err);
      return false;
    }
  };

  const applyUndoEntry = (entry: UndoEntry, dir: 'prev' | 'next') => {
    const value = dir === 'prev' ? entry.prev : entry.next;
    if (entry.kind === 'layout') { setLocalLayoutOverrides(value as any); return; }
    if (entry.kind === 'responsive') {
      setLocalDeviceDraft(entry.pageId, entry.bp, value as ProfileDraft | undefined, false);
      setDeviceMode(entry.bp === 'md' ? 'tablet' : 'phone');
      return;
    }
    if (entry.kind === 'ai-presentation') {
      const state = value as PresentationState;
      // Undoing a design that CREATED blocks removes those draft-only rows (they
      // were never published). Redo cannot resurrect them under the same ids, so
      // that entry leaves the redo branch rather than redo half a design.
      const created = entry.next.createdBlockIds ?? [];
      if (dir === 'prev' && created.length) {
        void Promise.all(created.map((id) => dashboardApi.removeChart(dashboardId, id).catch(() => null)))
          .then(() => queryClient.invalidateQueries({ queryKey: ['dashboards', dashboardId] }));
      }
      const specs = entry.next.createdBlockSpecs ?? [];
      if (dir === 'next' && specs.length) {
        // Redo re-creates the blocks the design added (as draft-only rows) and
        // records their new ids, so a further undo removes the right rows.
        void (async () => {
          const ids: number[] = [];
          for (const spec of specs) {
            const before = new Set(((queryClient.getQueryData(['dashboards', dashboardId]) as any)?.dashboard_charts ?? []).map((d: any) => d.id));
            try {
              const updated: any = await dashboardApi.addWidget(dashboardId, spec.widgetType, { ...spec.layout, draftOnly: true } as any, spec.widgetConfig as any);
              if (updated) queryClient.setQueryData(['dashboards', dashboardId], updated);
              const fresh = (updated?.dashboard_charts ?? []).find((d: any) => !before.has(d.id) && d.widget_type === spec.widgetType);
              if (fresh) ids.push(fresh.id);
            } catch (err) {
              console.error('Redo could not re-create a design block:', err);
            }
          }
          entry.next.createdBlockIds = ids;
        })();
      }
      setLocalLayoutOverrides(state.layout);
      if (state.slicerCluster !== undefined) {
        // Draft only: the auto-stage sees draft ≠ applied and writes it, so an
        // undone dock change also leaves the server draft.
        setDraftSlicerClusterLayout(state.slicerCluster);
      }
      // Undo/redo of an AI redesign stays in the DRAFT — repaint the theme
      // without persisting, the same way Apply did, so a stray Ctrl+Z can never
      // write the live report.
      if (state.theme !== undefined) paintThemeDraft(state.theme);
      return;
    }
    if (entry.kind === 'removal') {
      void (async () => {
        try {
          if (dir === 'prev') {
            // A published element comes back as ITSELF (same id, still
            // published); one added in this draft is created again.
            for (const id of entry.published) await dashboardApi.restoreChart(dashboardId, id);
            const ids: number[] = [];
            for (const spec of entry.drafts) {
              const before = new Set(((queryClient.getQueryData(['dashboards', dashboardId]) as any)?.dashboard_charts ?? []).map((d: any) => d.id));
              const layout = { ...spec.layout, draftOnly: true } as any;
              const updated: any = spec.widgetType === 'chart' && spec.chartId
                ? await dashboardApi.addChart(dashboardId, spec.chartId, layout, spec.parameters as any)
                : await dashboardApi.addWidget(dashboardId, spec.widgetType, layout, spec.widgetConfig as any);
              const fresh = (updated?.dashboard_charts ?? []).find((d: any) => !before.has(d.id));
              if (fresh) ids.push(fresh.id);
            }
            entry.draftIds = ids;
          } else {
            for (const id of [...entry.published, ...entry.draftIds]) await dashboardApi.removeChart(dashboardId, id);
          }
        } catch (err) {
          console.error('Undo/redo of a removal failed:', err);
          toast.error(t('dashboards.detail.chartRemoveFailed'));
        }
        await queryClient.invalidateQueries({ queryKey: ['dashboards', dashboardId] });
      })();
      setLocalLayoutOverrides(dir === 'prev' ? entry.prev : entry.next);
      return;
    }
    void applyThemeConfig(value);
  };
  const doUndo = () => {
    // Not while an Apply is still committing: its undo entry is written when
    // the last block exists, so an Undo in between undid something else and
    // left the new blocks behind.
    if (committingPresentationRef.current) return;
    const entry = undoRef.current.pop();
    if (!entry) { toast.info(t('dashboards.detail.nothingToUndo')); return; }
    redoRef.current.push(entry);
    applyUndoEntry(entry, 'prev');
    bumpHistory();
    toast.success(t(entry.kind === 'theme' ? 'dashboards.detail.undoTheme' : 'dashboards.detail.undoLayout'));
  };
  const doRedo = () => {
    if (committingPresentationRef.current) return;
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
  // ── Device layouts of this page: published, then this author's saved draft,
  //    then the unsaved edits — the input the ONE resolver draws with. ──
  const deviceBreakpoint: DeviceBreakpoint | null = deviceMode === 'tablet' ? 'md' : deviceMode === 'phone' ? 'xs' : null;
  const serverResponsiveDraft = (serverDashboard as any)?.draft_responsive_layouts as Record<string, Partial<Record<DeviceBreakpoint, ProfileDraft>>> | null | undefined;
  const pageDeviceProfiles = React.useMemo(() => overlayProfiles(
    (serverDashboard as any)?.responsive_layouts?.pages?.[activePageId] ?? null,
    { ...(serverResponsiveDraft?.[activePageId] ?? {}), ...(localResponsive[activePageId] ?? {}) },
  ), [serverDashboard, serverResponsiveDraft, localResponsive, activePageId]);
  const [deviceSummary, setDeviceSummary] = useState<ResolvedLayoutSummary | null>(null);
  const resolvedLayoutRef = React.useRef<ResolvedLayout | null>(null);
  const deviceMeasureRef = React.useRef<(() => Record<string, number>) | null>(null);
  const publishedDeviceRev = (pageId: string, bp: DeviceBreakpoint): number =>
    Number((serverDashboard as any)?.responsive_layouts?.pages?.[pageId]?.[bp]?.rev ?? 0) || 0;
  /** One page/breakpoint's unsaved device draft (undefined = drop it). */
  function setLocalDeviceDraft(pageId: string, bp: DeviceBreakpoint, next: ProfileDraft | undefined, record = true) {
    const all = localResponsiveRef.current;
    const prev = all[pageId]?.[bp];
    const page = { ...(all[pageId] ?? {}) };
    if (next) page[bp] = next; else delete page[bp];
    const updated = { ...all, [pageId]: page };
    localResponsiveRef.current = updated;
    setLocalResponsive(updated);
    if (record) pushUndo({ kind: 'responsive', pageId, bp, prev, next });
  }
  const currentCustom = (bp: DeviceBreakpoint): CustomProfile | null => {
    const p = pageDeviceProfiles[bp];
    return p && p.mode === 'custom' ? p : null;
  };
  /** Customize: freeze exactly what the device shows now (content fit included). */
  const handleCustomizeDevice = () => {
    const resolved = resolvedLayoutRef.current;
    if (!deviceBreakpoint || !resolved || resolved.breakpoint !== deviceBreakpoint || resolved.source !== 'auto') return;
    setLocalDeviceDraft(activePageId, deviceBreakpoint, freezeLayout(resolved, { source: 'auto-freeze' }));
  };
  /** Back to the derived layout (a draft change: published state untouched). */
  const handleResetDevice = () => {
    if (!deviceBreakpoint) return;
    setLocalDeviceDraft(activePageId, deviceBreakpoint, { mode: 'auto' });
  };
  /** Freeze the CURRENT desktop's derived layout as a new custom layout. */
  const handleRegenerateDevice = () => {
    if (!deviceBreakpoint) return;
    const auto = resolveReportLayout({
      tiles: visibleDashboardCharts,
      profiles: null,
      containerWidth: STUDIO_DEVICE_WIDTH[deviceMode],
      gap: getDashboardGridMargin(dashboard?.theme_config)[1],
    });
    setLocalDeviceDraft(activePageId, deviceBreakpoint, freezeLayout(auto, { source: 'regenerate' }));
  };
  /** The explicit content fit of a custom layout: measured once, written into the draft. */
  const handleFitDeviceHeights = () => {
    const profile = deviceBreakpoint ? currentCustom(deviceBreakpoint) : null;
    const resolved = resolvedLayoutRef.current;
    if (!deviceBreakpoint || !profile || !resolved) return;
    const measured = deviceMeasureRef.current?.() ?? {};
    const placed = resolved.layout.filter((c) => profile.items[c.i]);
    setLocalDeviceDraft(activePageId, deviceBreakpoint, withCells(profile, fitLayoutToContent(placed, measured, 'grow')));
  };
  /** Needs review → Add below: write where the new tiles are drawn into the layout. */
  const handleAddOrphansBelow = () => {
    const profile = deviceBreakpoint ? currentCustom(deviceBreakpoint) : null;
    const resolved = resolvedLayoutRef.current;
    if (!deviceBreakpoint || !profile || !resolved) return;
    const orphanCells = resolved.layout.filter((c) => resolved.orphans.includes(c.i));
    const kept = { ...profile, items: Object.fromEntries(Object.entries(profile.items).filter(([id]) => !resolved.dropped.includes(id))) };
    setLocalDeviceDraft(activePageId, deviceBreakpoint, withCells(kept, orphanCells));
  };
  /** A drag/resize on a custom device layout: that layout only, never desktop. */
  const handleDeviceLayoutChange = (bp: DeviceBreakpoint, cells: GridItem[]) => {
    const profile = currentCustom(bp);
    if (!profile) return;
    setLocalDeviceDraft(activePageId, bp, withCells(profile, cells));
  };
  // Slicers whose control sits on THIS page's grid (lib/slicer-placement). The
  // filter bar does not repeat them; nothing about what they filter changes.
  const placedSlicerIdsOnPage = React.useMemo(
    () => placedSlicerIds(visibleDashboardCharts),
    [visibleDashboardCharts],
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

  const commitPresentation = React.useCallback(async (commit: {
    layoutOverrides: Record<number, Record<string, any>>;
    themePatch: Record<string, any> | null;
    slicerClusterPatch: Record<string, any> | null;
    createdBlocks?: import('@/lib/dashboard-presentation/types').CreatedBlock[];
  }) => {
    committingPresentationRef.current = true;
    setIsCommittingPresentation(true);
    try {
    // Blocks first: each becomes a DRAFT-ONLY row (invisible to /d and /embed
    // until Publish, deleted by Discard), then its temporary id is swapped for
    // the real one so it moves, resizes and locks like any tile.
    let layoutOverrides = commit.layoutOverrides;
    const createdIds: number[] = [];
    const realIdOf = new Map<number, number>();
    if (commit.createdBlocks?.length) {
      layoutOverrides = { ...layoutOverrides };
      for (const block of commit.createdBlocks) {
        const before = new Set(((queryClient.getQueryData(['dashboards', dashboardId]) as any)?.dashboard_charts ?? []).map((d: any) => d.id));
        try {
          const layout = { ...block.layout, ...(layoutOverrides[block.tempId] ?? {}), pageId: block.layout.pageId ?? activePageId, draftOnly: true };
          const updated: any = await dashboardApi.addWidget(dashboardId, block.widgetType, layout as any, block.widgetConfig as any);
          const fresh = (updated?.dashboard_charts ?? []).find((d: any) => !before.has(d.id) && d.widget_type === block.widgetType);
          if (updated) queryClient.setQueryData(['dashboards', dashboardId], updated);
          delete layoutOverrides[block.tempId];
          if (fresh) { createdIds.push(fresh.id); realIdOf.set(block.tempId, fresh.id); }
        } catch (err) {
          console.error('Failed to create design block:', err);
          toast.error(t('dashboards.aiDesign.blockCreateFailed'));
        }
      }
      setPreviewBlocks(null);
      // A tile placed under a heading the design created names that heading by
      // its temporary id: now that the row exists, name it by its real one
      // (a heading that failed to create leaves the tile in no section).
      const swap = (v: unknown) => (typeof v === 'number' && v < 0 ? (realIdOf.get(v) ?? null) : v);
      for (const [key, l] of Object.entries(layoutOverrides)) {
        const s = (l as any)?.sectionId;
        if (typeof s === 'number' && s < 0) layoutOverrides[key as any] = { ...(l as any), sectionId: swap(s) };
      }
      for (const block of commit.createdBlocks) {
        const real = realIdOf.get(block.tempId);
        const s = (block.layout as any)?.sectionId;
        if (real != null && typeof s === 'number' && s < 0) {
          layoutOverrides[real] = { ...(layoutOverrides[real] ?? {}), sectionId: swap(s) };
        }
      }
    }
    // One undo entry for one click (§14). The `before` half is captured here,
    // from live state, rather than being handed in — a caller that snapshotted
    // earlier would record a baseline that has since moved.
    const nextTheme = commit.themePatch
      ? stripUndefined({ ...(dashboard?.theme_config ?? {}), ...commit.themePatch })
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
        layout: layoutOverrides,
        theme: nextTheme,
        slicerCluster: nextCluster,
        createdBlockIds: createdIds,
        createdBlockSpecs: (commit.createdBlocks ?? []).map((b) => ({
          widgetType: b.widgetType,
          widgetConfig: b.widgetConfig as Record<string, unknown>,
          layout: { ...b.layout, ...(commit.layoutOverrides[b.tempId] ?? {}), pageId: b.layout.pageId ?? activePageId } as Record<string, unknown>,
        })),
      },
    });

    setPreviewLayoutOverrides(null);
    setPreviewPresentation(null);
    setLocalLayoutOverrides(layoutOverrides);
    if (nextCluster !== undefined) {
      // Draft only. Marking it applied as well (as this used to) told the
      // auto-stage there was nothing to send, so an AI dock change never
      // reached the server draft and was silently absent from Publish.
      setDraftSlicerClusterLayout(nextCluster);
    }
    // Draft, don't persist: the colour lands on Save/Publish and Discard drops
    // it — an AI Apply must not silently repaint the live report (§ theme-draft).
    if (nextTheme !== undefined) paintThemeDraft(nextTheme);
    } finally {
      // Cleared in the same render batch as the new layout: the render that
      // re-enables Publish is the one that already holds the moved tiles.
      committingPresentationRef.current = false;
      setIsCommittingPresentation(false);
    }
  }, [dashboard?.theme_config, draftSlicerClusterLayout, localLayoutOverrides, activePageId, dashboardId, queryClient, t]);

  // Tile focus (Canvas/Grid highlight). Declared here — above useAiDesign —
  // because in AI mode a focused tile scopes the redesign to that one visual
  // (click-chart-to-edit), so the hook needs to read it.
  const [focusedTileId, setFocusedTileId] = useState<number | null>(null);
  // AI Design scope = what is selected on the canvas. Click selects one visual,
  // Shift/Ctrl/⌘+click adds or removes one. Clicking a selected element keeps
  // it selected (as in any design tool): it used to toggle it off, so a second
  // click to "make sure" silently deselected the heading a new chart was meant
  // to go under. Escape, or a click on empty canvas, clears the selection.
  const [selectedTileIds, setSelectedTileIds] = useState<number[]>([]);
  const handleTileFocus = React.useCallback((id: number, additive?: boolean) => {
    setFocusedTileId(id);
    setSelectedTileIds((current) => {
      if (additive) return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
      return current.length === 1 && current[0] === id ? current : [id];
    });
  }, []);
  const clearTileSelection = React.useCallback(() => {
    setSelectedTileIds([]);
    setFocusedTileId(null);
  }, []);
  // A selection belongs to the page it was made on.
  React.useEffect(() => { setSelectedTileIds([]); }, [activePageId]);
  const canvasRootRef = React.useRef<HTMLDivElement | null>(null);
  // A content edit typed in the Inspector reaches the draft a moment later.
  // Save, Publish and a page switch wait for it (and stop if it failed);
  // Discard drops what was not sent and waits for what was, so no edit lands
  // after it. Saves already sent by an element that has since closed are
  // tracked here too.
  const pendingContentSaveRef = React.useRef<PendingContentSave | null>(null);
  const inflightContentSavesRef = React.useRef(new Set<Promise<void>>());
  const settleContentEdits = React.useCallback(async (mode: 'flush' | 'cancel'): Promise<boolean> => {
    const handle = pendingContentSaveRef.current;
    let ok = true;
    if (handle) {
      if (mode === 'flush') ok = await handle.flush();
      else await handle.cancel();
    }
    await Promise.allSettled(Array.from(inflightContentSavesRef.current));
    if (!ok) toast.error(t('dashboards.inspector.saveBeforeLeaving'));
    return ok;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Leaving the page with an unsent edit asks first. Next's SPA links do not
  // emit beforeunload, so capture same-origin anchors as one shared boundary
  // (sidebar, header and Dashboard-to-Dashboard links). A duplicate history
  // entry lets browser Back ask *before* Next leaves this mounted editor; on
  // cancel we restore the guard entry, preserving the local edit itself.
  React.useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pendingContentSaveRef.current?.hasPending() || inflightContentSavesRef.current.size > 0
          || unsavedWorkRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    const onDocumentClick = (e: MouseEvent) => {
      const dirty = unsavedWorkRef.current;
      const contentPending = Boolean(pendingContentSaveRef.current?.hasPending())
        || inflightContentSavesRef.current.size > 0;
      if (!dirty && !contentPending && leaveGuardBypassPopRef.current && !e.defaultPrevented && e.button === 0) {
        const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
        if (a && a.target !== '_blank' && !a.hasAttribute('download')) {
          const u = new URL(a.href, window.location.href);
          if (u.origin === window.location.origin && u.href !== window.location.href) {
            e.preventDefault();
            e.stopPropagation();
            queuedNavRef.current = `${u.pathname}${u.search}${u.hash}`;
            return;
          }
        }
      }
      if ((!dirty && !contentPending) || e.defaultPrevented || e.button !== 0
          || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || url.href === window.location.href) return;

      e.preventDefault();
      e.stopPropagation();
      if (dirty && !confirmLeaveIfUnsaved()) return;

      const nextHref = `${url.pathname}${url.search}${url.hash}`;
      // An Inspector content edit auto-saves to the draft: send it BEFORE leaving
      // and stay (with the failure toast) if it did not land — never leave and
      // let it fail behind the user's back.
      if (contentPending) {
        void settleContentEdits('flush').then((ok) => {
          // Saved → leave. Failed → the failure toast is showing; leave only if
          // the author explicitly accepts losing it (never silently).
          if (ok || window.confirm(t('dashboards.detail.unsavedLeaveConfirm'))) go();
        });
        return;
      }
      go();
      function go() {
      if (leaveGuardEntryRef.current) {
        // Replace the duplicate same-URL guard entry with the accepted target.
        // Going back first and routing from popstate races Next's own history
        // listener; replacing is atomic and leaves exactly one editor entry.
        leaveGuardEntryRef.current = false;
        router.replace(nextHref);
      } else {
        router.push(nextHref);
      }
      }
    };
    const onPopState = () => {
      if (leaveGuardBypassPopRef.current) {
        leaveGuardBypassPopRef.current = false;
        leaveGuardEntryRef.current = false;
        const queued = queuedNavRef.current;
        queuedNavRef.current = null;
        if (queued) router.push(queued);
        return;
      }
      if (!unsavedWorkRef.current) return;

      // The first Back only removed our same-URL guard entry. Confirm now; a
      // second Back performs the user's requested navigation when accepted.
      if (confirmLeaveIfUnsaved()) {
        leaveGuardBypassPopRef.current = true;
        leaveGuardEntryRef.current = false;
        window.history.back();
      } else {
        window.history.pushState(
          { ...window.history.state, __appbiDashboardLeaveGuard: leaveGuardKeyRef.current },
          '',
          leaveGuardUrlRef.current || window.location.href,
        );
        leaveGuardEntryRef.current = true;
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('popstate', onPopState);
    document.addEventListener('click', onDocumentClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('popstate', onPopState);
      document.removeEventListener('click', onDocumentClick, true);
    };
  }, [confirmLeaveIfUnsaved, router, settleContentEdits]);

  // The builder header's real height. It wraps to a second row when a draft's
  // actions and the tools do not fit on one; the overlays (AI Design, the
  // Inspector) sit below it, never over its second row.
  const builderHeaderRef = React.useRef<HTMLDivElement | null>(null);
  const [builderHeaderH, setBuilderHeaderH] = useState(64);
  React.useEffect(() => {
    const el = builderHeaderRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const h = Math.round(el.getBoundingClientRect().bottom);
      setBuilderHeaderH((prev) => (Math.abs(prev - h) > 1 ? h : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
    // The header mounts once the report has loaded (and never in the preview).
  }, [Boolean(dashboard), studioPreview]);
  const getCanvasRoot = React.useCallback(() => canvasRootRef.current, []);
  // The render-quality probe (see lib/dashboard-presentation/render-audit):
  // the e2e gate calls it on the builder canvas and on the published report.
  React.useEffect(() => {
    (window as any).__APPBI_RENDER_AUDIT__ = () => auditRenderedTiles(canvasRootRef.current ?? document);
    return () => { delete (window as any).__APPBI_RENDER_AUDIT__; };
  }, []);
  // Design Context: labels, types and formats from the semantic models this page
  // has already loaded — no extra request, nothing the page does not show.
  const designFieldMeta = React.useMemo(
    () => buildFieldMetaIndex(Array.from(datasetModelsById.values()).map((model) => (model as any)?.views)),
    [datasetModelsById],
  );

  // The findings the tiles on screen currently support — what the report SAYS,
  // for the planner to decide what leads. Sentences are rendered with the same
  // templates the narrative blocks use.
  const reportFindings = useReportFindings();
  const aiFindings = React.useMemo(
    () => Array.from(reportFindings.findings.values()).map((f) => ({
      key: f.key, sentence: renderFindingSentence(f, t as any, locale),
    })),
    [reportFindings, t, locale],
  );
  const directionLabels = React.useMemo(() => ({
    whatMoved: t('report.direction.whatMoved'),
    latestStatus: t('report.direction.latestStatus'),
    detail: t('report.direction.detail'),
    worthKnowing: t('report.direction.worthKnowing'),
    againstTarget: t('report.direction.againstTarget'),
    keepInMind: t('report.direction.keepInMind'),
  }), [t]);

  // Rows each loaded tile returned (counts only): a redesign sizes a table to
  // them instead of giving six rows a 540px tile.
  const tileRowCounts = React.useMemo(() => {
    const out: Record<number, number> = {};
    for (const e of reportFindings.evidence) out[e.tileId] = Array.isArray(e.rows) ? e.rows.length : 0;
    return out;
  }, [reportFindings]);
  const aiDesign = useAiDesign({
    rowCountByTile: tileRowCounts,
    findings: aiFindings,
    directionLabels,
    dashboardId: Number(dashboardId),
    dashboard,
    activePageId,
    activePageName: currentPage?.name ?? activePageId,
    pageCount: dashboardPages.length,
    localLayoutOverrides,
    slicers: [...draftGlobalSlicers, ...draftPageSlicers],
    // Filters are grid elements now; a slicer's place is its control's tile.
    slicerDock: 'grid',
    currentTheme: dashboard?.theme_config,
    slicerClusterLayout: viewSlicerClusterLayout,
    gridGapPx: getDashboardGridMargin(dashboard?.theme_config)[1],
    // Only a selection made while the AI panel is open scopes a request.
    selectedIds: designMode === 'ai' ? selectedTileIds : [],
    fieldMeta: designFieldMeta,
    getCanvasRoot,
    onCommit: commitPresentation,
  });

  // ── Content proposals ─────────────────────────────────────────────────────
  // Changes to what a tile SAYS (its order, its title): listed with before →
  // after, applied only on the author's Accept as a draft edit (one undo,
  // published on Publish), and audited either way.
  const [decidedProposals, setDecidedProposals] = useState<Set<string>>(() => new Set());
  const proposalTiles = React.useMemo(() => {
    const map = new Map<number, TileContext>();
    for (const dc of (dashboard?.dashboard_charts ?? []) as any[]) {
      if (dc.widget_type && dc.widget_type !== 'chart') continue;
      const override = (dc.layout?.styleConfigOverride ?? {}) as Record<string, unknown>;
      const base = (dc.chart?.config?.styleConfig ?? {}) as Record<string, unknown>;
      map.set(dc.id, {
        tileId: dc.id,
        title: String(dc.layout?.custom_title || base.chartTitle || dc.chart?.name || ''),
        currentSortRules: (override.chartSortRules ?? base.chartSortRules) as unknown[] | undefined,
        currentStyleOverride: override,
      });
    }
    return map;
  }, [dashboard?.dashboard_charts]);
  const contentProposals = React.useMemo(() => {
    const all = [
      ...deriveProposals(reportFindings.evidence, proposalTiles),
      ...coerceModelProposals(aiDesign.modelProposals, proposalTiles),
    ];
    const seen = new Set<string>();
    return all.filter((p) => {
      if (decidedProposals.has(p.id) || seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  }, [reportFindings.evidence, proposalTiles, aiDesign.modelProposals, decidedProposals]);
  const decideProposal = React.useCallback((proposal: ContentProposal, accepted: boolean) => {
    setDecidedProposals((current) => new Set(current).add(proposal.id));
    if (accepted) {
      const prev = localLayoutOverrides;
      const next = { ...prev, [proposal.tileId]: { ...(prev[proposal.tileId] ?? {}), ...proposal.patch } };
      pushUndo({ kind: 'layout', prev, next });
      setLocalLayoutOverrides(next);
    }
    void dashboardApi.recordProposalDecision(dashboardId, {
      decision: accepted ? 'accepted' : 'rejected', kind: proposal.kind, tile_id: proposal.tileId,
      before: proposal.auditBefore, after: proposal.auditAfter, source: proposal.source,
    }).catch((err) => console.error('Failed to record proposal decision:', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localLayoutOverrides, dashboardId]);

  // The preview is a view layer, so it is pushed into the render overlay rather
  // than returned by the hook and threaded through every child.
  React.useEffect(() => {
    setPreviewLayoutOverrides(
      aiDesign.pending ? (aiDesign.pending.mutation.layoutOverrides as any) : null,
    );
    const blocks = aiDesign.pending?.mutation.createdBlocks ?? [];
    setPreviewBlocks(blocks.length
      ? blocks.map((b) => ({
          id: b.tempId, dashboard_id: Number(dashboardId), chart_id: null, chart: null,
          widget_type: b.widgetType, widget_config: b.widgetConfig,
          layout: { ...b.layout, pageId: b.layout.pageId ?? activePageId }, parameters: {},
        }))
      : null);
    setPreviewPresentation(
      aiDesign.pending
        ? {
            theme: (aiDesign.pending.mutation.themePatch ?? {}) as Record<string, any>,
            slicerCluster: (aiDesign.pending.mutation.slicerClusterPatch ?? {}) as Record<string, any>,
          }
        : null,
    );
  }, [aiDesign.pending]);

  // Studio preview (the author's tab): the whole report before and after the
  // pending design, as the same overlays the canvas renders — local unsaved
  // edits first, the AI design on top. Nothing here writes a layout.
  const [studioOpen, setStudioOpen] = useState(false);
  const studioBefore = React.useMemo<StudioPreviewState>(() => ({
    overrides: Object.keys(localLayoutOverrides).length ? (localLayoutOverrides as any) : null,
    blocks: null,
    presentation: pendingThemeConfig ? { theme: pendingThemeConfig, slicerCluster: {} } : null,
    pageId: activePageId ?? null,
    responsive: localResponsive[activePageId] ?? null,
  }), [localLayoutOverrides, pendingThemeConfig, activePageId, localResponsive]);
  const studioAfter = React.useMemo<StudioPreviewState>(() => {
    const merged: Record<number, Record<string, unknown>> = { ...(localLayoutOverrides as any) };
    for (const [id, o] of Object.entries(previewLayoutOverrides ?? {})) merged[Number(id)] = { ...(merged[Number(id)] ?? {}), ...(o as any) };
    const theme = { ...(pendingThemeConfig ?? {}), ...(previewPresentation?.theme ?? {}) };
    return {
      overrides: Object.keys(merged).length ? merged : null,
      blocks: previewBlocks ?? null,
      presentation: Object.keys(theme).length || Object.keys(previewPresentation?.slicerCluster ?? {}).length
        ? { theme, slicerCluster: previewPresentation?.slicerCluster ?? {} }
        : null,
      pageId: activePageId ?? null,
      // An AI design changes desktop only: the device layouts shown are the
      // author's (AUTO devices follow the new desktop; CUSTOM ones stay).
      responsive: localResponsive[activePageId] ?? null,
    };
  }, [localLayoutOverrides, previewLayoutOverrides, previewBlocks, previewPresentation, pendingThemeConfig, activePageId, localResponsive]);

  // Studio preview (inside the iframe): show exactly the state the author's tab
  // sends — before or after an AI design — through the same overlays the canvas
  // uses, and report the report's full height and whether it has settled, so the
  // frame can be sized to the whole report and a capture never shows spinners.
  React.useEffect(() => {
    if (!studioPreview) return;
    const frame = studioFrameId();
    const onMessage = (e: MessageEvent) => {
      if (!isStudioMessage(e)) return;
      const m = e.data as StudioMessage;
      if (m.type !== 'appbi-studio-state' || m.frame !== frame) return;
      setPreviewLayoutOverrides((m.state.overrides as any) ?? null);
      setPreviewBlocks(m.state.blocks && m.state.blocks.length ? (m.state.blocks as any[]) : null);
      setPreviewPresentation((m.state.presentation as any) ?? null);
      if (m.state.pageId) setCurrentPageId(m.state.pageId);
      // Read-only verification of the author's unsaved device layouts (nothing
      // here can be saved: the preview's API client refuses every write).
      if (m.state.pageId) {
        const page = m.state.pageId;
        const next = { [page]: (m.state.responsive as any) ?? {} };
        localResponsiveRef.current = next;
        setLocalResponsive(next);
      }
    };
    window.addEventListener('message', onMessage);
    window.parent?.postMessage({ type: 'appbi-studio-ready', frame } satisfies StudioMessage, window.location.origin);
    let last = '';
    let lastHeight = -1;
    let still = 0;
    const beat = window.setInterval(() => {
      const main = document.querySelector('main') as HTMLElement | null;
      if (!main) return;
      const height = Math.ceil(main.scrollHeight);
      // Settled = the report is there (tiles mounted), nothing is loading, and
      // its height has held for three beats. A frame that has not started
      // fetching yet has nothing pending either — that is not "finished".
      still = height === lastHeight ? still + 1 : 0;
      lastHeight = height;
      const hasTiles = main.querySelector('[data-grid-item-id]') !== null;
      const settled = hasTiles && pendingWork(main) === null && still >= 3;
      const key = `${height}:${settled}`;
      if (key === last) return;
      last = key;
      window.parent?.postMessage({ type: 'appbi-studio-height', frame, height, settled } satisfies StudioMessage, window.location.origin);
    }, 400);
    return () => { window.removeEventListener('message', onMessage); window.clearInterval(beat); };
  }, [studioPreview]);

  // Clicking a chart while the AI panel is minimised should bring the panel
  // back — otherwise the "Editing: X" chip the click just armed is invisible.
  React.useEffect(() => {
    if (designMode === 'ai' && selectedTileIds.length > 0 && aiPanelCollapsed) {
      setAiPanelCollapsed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTileIds, designMode]);

  // A report-scoped redesign changes the SURFACE — a dark ground, a violet
  // accent, softer cards — and that is the biggest thing "make this a dark
  // modern report" asks for. Previewing only the layout would hide it until
  // Apply, so the pending theme patch is overlaid on the live theme for as long
  // as the preview is on screen. It is derived from `pending`, never stored, so
  // Discard reverts it for free. Page-scoped previews carry no theme patch, so
  // this is exactly the live theme for them.
  // The theme the page RENDERS: the (draft) theme with an AI design under
  // preview laid over it — the WHOLE patch, dock and variant included. The dock
  // used to be held back until Apply ("charts jumping"); that made Apply show a
  // layout the preview never did. What the user approves is what they saw.
  const previewTheme = viewThemeConfig;

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

  // A value picked in a grid control: the same entry, the same staging.
  const handleControlSlicerChange = React.useCallback((next: BaseFilter) => {
    handleSlicerChildrenChange(replaceSlicerById(orderedSlicerChildren, next));
  }, [handleSlicerChildrenChange, orderedSlicerChildren]);
  const slicerIsVisibleHere = React.useCallback(
    (s: any) => (s?.scope === 'page' ? true : slicerVisibleOnPage(s, activePageId)),
    [slicerVisibleOnPage, activePageId],
  );
  const slicerFiltersHere = React.useCallback(
    (s: any) => (s?.scope === 'page' ? true : slicerFiltersPage(s, activePageId)),
    [slicerFiltersPage, activePageId],
  );

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

  // EVERY Builder-local edit that is not yet persisted and would vanish on leave:
  // unsaved layout/theme, un-applied filter/slicer edits (Apply persists them to
  // the draft), the Inspector's report name/description (behind "Save report"),
  // and an open header / page rename. Inspector content auto-saves and is
  // flushed before leaving instead (see the click handler). Viewers' filter
  // edits are preview-only, never persisted, so they do not count.
  const headerNameDirty = isEditingName && editedName.trim() !== '' && editedName.trim() !== (dashboard?.name ?? '').trim();
  const pageNameDirty = editingPageId != null && editedPageName.trim() !== ''
    && editedPageName.trim() !== (dashboardPages.find((p) => p.id === editingPageId)?.name ?? '').trim();
  const hasUnsavedWork = hasUnsavedPresentation
    || (canEditResource && hasPendingFilterChanges)
    || reportDetailsDirty || headerNameDirty || pageNameDirty;
  React.useEffect(() => { unsavedWorkRef.current = hasUnsavedWork; }, [hasUnsavedWork]);
  React.useEffect(() => {
    if (hasUnsavedWork && !leaveGuardEntryRef.current) {
      leaveGuardUrlRef.current = window.location.href;
      window.history.pushState(
        { ...window.history.state, __appbiDashboardLeaveGuard: leaveGuardKeyRef.current },
        '',
        leaveGuardUrlRef.current,
      );
      leaveGuardEntryRef.current = true;
      return;
    }
    if (!hasUnsavedWork && leaveGuardEntryRef.current) {
      // Save/Publish removed the dirty state. Remove the duplicate same-URL
      // guard entry so later clean navigation has normal history and no prompt.
      if (window.history.state?.__appbiDashboardLeaveGuard === leaveGuardKeyRef.current) {
        leaveGuardBypassPopRef.current = true;
        window.history.back();
      }
      leaveGuardEntryRef.current = false;
    }
  }, [hasUnsavedWork]);

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
  // The server's presence state decides who owns the co-edit session; the UI
  // does not compare ids itself (until it answers, nobody is treated as owner).
  const isOwner = editLock?.i_am_owner ?? false;
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
  const handleLayoutChange = (newLayout: Layout[], extra: Record<number, Record<string, any>> = {}) => {
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
    // Structure keys that ride with the same gesture (a moved tile's section,
    // a section materialized before its header moves): one undo step. A tile
    // that only gets a structure key keeps its cell.
    const extraOnly = Object.keys(extra).map(Number).filter((id) => !newLayout.some((l) => Number(l.i) === id));
    const items = [...newLayout, ...extraOnly.map((id) => {
      const l = resolveDashboardChartLayout(id, prevOverrides) as any;
      return { i: String(id), x: Number(l?.x) || 0, y: Number(l?.y) || 0, w: Number(l?.w) || 1, h: Number(l?.h) || 1 } as Layout;
    })];
    for (const item of items) {
      const id = Number(item.i);
      const existing = serverDashboard.dashboard_charts?.find((dc) => dc.id === id);
      if (!existing) continue;
      if (extra[id]) {
        nextOverrides[id] = { ...mergeGridLayout(resolveDashboardChartLayout(id, prevOverrides), item), ...extra[id] };
        changed = true;
        continue;
      }
      const baseline = resolveDashboardChartLayout(id, {});
      const atBaseline =
        baseline.x === item.x && baseline.y === item.y
        && baseline.w === item.w && baseline.h === item.h;
      // Back at its baseline cell: the override goes only if NOTHING else in it
      // differs — a lock or a slicer's display set before the drag must not be
      // thrown away because the tile returned to where it was.
      const candidate = mergeGridLayout(resolveDashboardChartLayout(id, prevOverrides), item) as Record<string, any>;
      const onlyGeometry = Object.keys(candidate).every(
        (k) => JSON.stringify(candidate[k]) === JSON.stringify((baseline as any)[k]),
      );
      if (atBaseline && onlyGeometry) {
        if (id in nextOverrides) { delete nextOverrides[id]; changed = true; }
      } else if (atBaseline) {
        nextOverrides[id] = candidate;
        changed = true;
      } else {
        nextOverrides[id] = mergeGridLayout(resolveDashboardChartLayout(id), item);
        changed = true;
      }
    }
    if (!changed) return; // net no-op → keep unrelated (e.g. canvas) local edits intact
    pushUndo({ kind: 'layout', prev: prevOverrides, next: nextOverrides });
    setLocalLayoutOverrides(nextOverrides);
  };

  // Lock is layout state, so it goes through the same local-override → draft →
  // publish path as a drag: undoable, visible immediately (the grid reads the
  // merged layout), and never lost when a draft saved BEFORE the lock is
  // published. It used to write the live row directly, which a stale draft
  // entry then overwrote on publish — the lock silently came undone.
  // Any tile-level edit — title, frame/appearance, highlight opt-out, date-grain
  // lock, HAVING filters, position lock — is a DRAFT edit: it goes through the
  // page's buffer (undoable, saved with the draft, published with it). These
  // used to PUT the live row, so a title typed in the editor was on /d before
  // Publish and Discard could not take it back.
  const handlePatchTileLayout = useCallback((dashboardChartId: number, patch: Record<string, any>) => {
    const prevOverrides = localLayoutOverridesRef.current;
    const merged = {
      ...prevOverrides,
      [dashboardChartId]: { ...resolveDashboardChartLayout(dashboardChartId, prevOverrides), ...patch },
    };
    pushUndo({ kind: 'layout', prev: prevOverrides, next: merged });
    setLocalLayoutOverrides(merged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveDashboardChartLayout]);
  const handleToggleTileLock = useCallback((dashboardChartId: number, next: boolean) => {
    handlePatchTileLayout(dashboardChartId, { locked: next });
  }, [handlePatchTileLayout]);

  // The persisted layout of each tile (server row ⊕ saved draft), WITHOUT the
  // unsaved local edits or an AI preview. A ChartTile used OUTSIDE this builder
  // (no draft buffer) still writes its row and spreads THIS, so an unsaved drag
  // or a design being previewed can never leak into the live report.
  const persistedLayoutById = React.useMemo(() => {
    const map: Record<number, Record<string, any>> = {};
    for (const dc of serverDashboard?.dashboard_charts ?? []) {
      map[dc.id] = resolveDashboardChartLayout(dc.id, {}) as Record<string, any>;
    }
    return map;
  }, [serverDashboard, resolveDashboardChartLayout]);
  const persistedLayoutRef = React.useRef(persistedLayoutById);
  persistedLayoutRef.current = persistedLayoutById;
  // Stable getter: tiles are memoised and must not re-render on every refetch
  // just to see a fresher persisted layout — they read it at write time.
  const getPersistedLayout = useCallback((id: number) => persistedLayoutRef.current[id], []);

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
    // Locked tiles are obstacles, not participants: they keep their rectangle
    // and the re-flow routes around them.
    const lockedIds = new Set(pageCharts.filter((dc) => (dc.layout as any)?.locked === true).map((dc) => dc.id));
    const tidied = tidyPageLayout(tiles, lockedIds);
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
    const lockedIds = new Set(pageCharts.filter((dc) => (dc.layout as any)?.locked === true).map((dc) => dc.id));
    const lifted = compactPageUp(tiles, lockedIds);
    if (!lifted) {
      toast.info(t('dashboards.detail.compactUpNoop'));
      return;
    }
    const next: Record<number, Record<string, any>> = {};
    for (const tl of lifted) {
      next[tl.id] = mergeGridLayout(resolveDashboardChartLayout(tl.id), { x: tl.x, y: tl.y, w: tl.w, h: tl.h });
    }
    const prevOverrides = localLayoutOverridesRef.current;
    const merged = { ...prevOverrides, ...next };
    pushUndo({ kind: 'layout', prev: prevOverrides, next: merged });
    setLocalLayoutOverrides(merged);
    toast.success(t('dashboards.detail.compactUpDone'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard, activePageId, resolveDashboardChartLayout, t]);

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

  /** Stage the unsaved device layouts: one request per page/breakpoint (never
   *  per tile, never per drag), each with the published revision it started from. */
  const flushLocalResponsiveToDraft = async (): Promise<boolean> => {
    const entries = Object.entries(localResponsiveRef.current)
      .flatMap(([pageId, perBp]) => Object.entries(perBp ?? {}).map(([bp, profile]) => ({ pageId, bp: bp as DeviceBreakpoint, profile: profile as ProfileDraft })));
    if (!entries.length) return true;
    try {
      let latest: any = null;
      for (const e of entries) {
        latest = await dashboardApi.updateDraftResponsive(dashboardId, {
          pageId: e.pageId, breakpoint: e.bp, profile: e.profile as any, baseRev: publishedDeviceRev(e.pageId, e.bp),
        });
      }
      if (latest) queryClient.setQueryData(['dashboards', dashboardId], latest);
      localResponsiveRef.current = {};
      setLocalResponsive({});
      return true;
    } catch (err: any) {
      console.error('Failed to save device layout draft:', err);
      const detail = err?.response?.data?.detail;
      if (typeof detail === 'string') toast.error(detail);
      return false;
    }
  };

  /** Stage everything unsaved into the server draft. All-or-report: each part
   *  is attempted, and the caller learns which failed — nothing is reported as
   *  saved that the server did not accept. */
  const stageAllToDraft = async (): Promise<{ ok: boolean; failed: string[] }> => {
    const failed: string[] = [];
    setIsStagingDraft(true);
    try {
      if (!(await flushLocalLayoutsToDraft())) failed.push('layout');
      if (!(await flushLocalResponsiveToDraft())) failed.push('device-layout');
      if (!(await stagePendingTheme())) failed.push('theme');
      if (!(await stageSlicerClusterLayout())) failed.push('filters');
    } finally {
      setIsStagingDraft(false);
    }
    return { ok: failed.length === 0, failed };
  };

  const handleSaveDraft = async () => {
    if (committingPresentationRef.current) return;
    if (!(await settleContentEdits('flush'))) return;
    const { ok } = await stageAllToDraft();
    if (ok) {
      // Save flushes local overrides → the pre-save snapshots in the undo stack
      // no longer map cleanly onto the now-empty override buffer, so clear the
      // history (hard boundary) rather than allow a half-broken restore.
      resetUndo();
      toast.success(t('dashboards.detail.draftSaved'));
    } else {
      // What failed stays unsaved and on screen; nothing was published.
      toast.error(t('dashboards.detail.draftSaveFailed'));
    }
  };

  // Phase-B18 — auto-save the current page's unsaved layout edits into the
  // draft BEFORE switching pages, so nothing is lost when moving around a
  // multi-page dashboard. Switch happens regardless (a failed save keeps the
  // edits in local state, not lost). The PDF-export loop sets currentPageId
  // directly (not via this), so it isn't affected.
  const handleSwitchPage = useCallback(async (pageId: string) => {
    await settleContentEdits('flush');
    if (pageId === activePageId) { setIsPagesMenuOpen(false); return; }
    setIsPagesMenuOpen(false);
    // Silent auto-save (like Google Docs) — the "DRAFT" badge reflects state;
    // no toast so frequent page switches don't spam the notification center.
    if (canEditResource && hasLocalLayoutChanges) {
      await flushLocalLayoutsToDraft();
    }
    // A page's unsaved device layout goes to the draft too (nothing is lost).
    if (canEditResource && hasLocalResponsiveChanges) {
      await flushLocalResponsiveToDraft();
    }
    // Page switch flushes overrides + changes which charts are on-screen — the
    // undo entries (keyed to the previous page's override map) no longer apply.
    resetUndo();
    setCurrentPageId(pageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePageId, canEditResource, hasLocalLayoutChanges, hasLocalResponsiveChanges]);

  // Phase-B18 — Ctrl/Cmd+S saves the draft quickly (and blocks the browser's
  // Save-page dialog). A ref holds the latest closure so the listener stays
  // mounted once but always sees current state.
  const ctrlSRef = React.useRef<() => void>(() => {});
  ctrlSRef.current = () => {
    // The Studio is a read-only review over the Builder: a shortcut pressed
    // while it is open must not save the work under it (the key still never
    // reaches the browser's own Save-page dialog).
    if (studioOpen) return;
    if (hasUnsavedPresentation) handleSaveDraft();
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
    if (committingPresentationRef.current) return;
    // The last content edit is in the draft before the snapshot is published.
    if (!(await settleContentEdits('flush'))) return;
    // Capture base versions BEFORE the flush clears local overrides.
    const tileBaseV = buildTileBaseV();
    // Everything is staged first; Publish runs only if ALL of it was accepted.
    // The server then applies layout + theme + filters in one transaction, so a
    // failed stage or a 409 leaves the published report exactly as it was.
    const staged = await stageAllToDraft();
    if (!staged.ok) {
      toast.error(t('dashboards.detail.publishAbortedDraftFailed'));
      return;
    }
    resetUndo();
    try {
      await publishDashboardMutation.mutateAsync({ dashboardId, tileBaseV });
      toast.success(t('dashboards.detail.publishedNewVersion'));
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      if (err?.response?.status === 409 && detail?.code === 'shared_draft_other_authors') {
        setSharedChoice({ action: 'publish', authors: detail.authors ?? [], rev: detail.rev, tileBaseV });
      } else if (err?.response?.status === 409 && detail?.code === 'responsive_conflict') {
        setPublishConflict({ editor: null, tiles: deviceConflictLabels(detail.responsive) });
      } else if (err?.response?.status === 409) {
        setPublishConflict({
          editor: err?.response?.data?.detail?.last_editor ?? null,
          tiles: err?.response?.data?.detail?.tiles ?? [],
        });
      } else {
        toast.error(t('dashboards.detail.publishFailed'));
      }
    }
  };

  /** "Page 1 · Tablet" for a responsive_conflict entry "page-1:md". */
  const deviceConflictLabels = (keys: unknown): string[] => (Array.isArray(keys) ? keys : []).map((k) => {
    const [pageId, bp] = String(k).split(':');
    const page = dashboardPages.find((pg) => pg.id === pageId);
    return `${page?.name ?? pageId} · ${t(bp === 'xs' ? 'dashboards.device.phone' : 'dashboards.device.tablet')}`;
  });

  // Phase-B17 — user chose "overwrite" in the conflict dialog: republish with force.
  const handleForcePublish = async () => {
    if (!(await settleContentEdits('flush'))) return;
    setPublishConflict(null);
    try {
      await publishDashboardMutation.mutateAsync({ dashboardId, force: true });
      toast.success(t('dashboards.detail.publishedOverwrote'));
    } catch {
      toast.error(t('dashboards.detail.publishFailed'));
    }
  };

  const handleDiscardAll = async () => {
    // Drop the Inspector's unsent edit and wait for one already sent, so the
    // discard is the last word (nothing is written back into the draft after it).
    await settleContentEdits('cancel');
    setLocalLayoutOverrides({});
    localResponsiveRef.current = {};
    setLocalResponsive({});
    // An unsaved theme lives only in page state — dropping it reverts colour.
    // A STAGED theme is in the server draft and goes with discard-draft below.
    setPendingThemeConfig(null);
    resetUndo();
    if (serverDashboard?.has_draft) {
      try {
        await discardDraftMutation.mutateAsync(dashboardId);
        toast.success(t('dashboards.detail.revertedToPublished'));
      } catch (err: any) {
        const detail = err?.response?.data?.detail;
        if (err?.response?.status === 409 && detail?.code === 'shared_draft_other_authors') {
          setSharedChoice({ action: 'discard', authors: detail.authors ?? [], rev: detail.rev });
        } else {
          toast.error(t('dashboards.detail.discardDraftFailed'));
        }
      }
    }
  };

  // The answer to "the shared draft also holds X's edits": include them, or
  // act on this author's own work only and leave the shared draft pending.
  const resolveSharedChoice = async (include: boolean) => {
    const choice = sharedChoice;
    setSharedChoice(null);
    if (!choice) return;
    const shared = include ? { sharedAckRev: choice.rev } : { keepShared: true };
    try {
      if (choice.action === 'publish') {
        await publishDashboardMutation.mutateAsync({ dashboardId, tileBaseV: choice.tileBaseV, ...shared });
        toast.success(t(include ? 'dashboards.detail.publishedNewVersion' : 'dashboards.detail.sharedChoice.publishedMine'));
      } else {
        await discardDraftMutation.mutateAsync({ dashboardId, ...shared });
        toast.success(t(include ? 'dashboards.detail.revertedToPublished' : 'dashboards.detail.sharedChoice.discardedMine'));
      }
    } catch (err: any) {
      if (err?.response?.status === 409 && err?.response?.data?.detail?.code === 'responsive_conflict') {
        setPublishConflict({ editor: null, tiles: deviceConflictLabels(err.response.data.detail.responsive) });
      } else if (err?.response?.status === 409) {
        setPublishConflict({ editor: err?.response?.data?.detail?.last_editor ?? null, tiles: err?.response?.data?.detail?.tiles ?? [] });
      } else {
        toast.error(t(choice.action === 'publish' ? 'dashboards.detail.publishFailed' : 'dashboards.detail.discardDraftFailed'));
      }
    }
  };

  const handleAddWidget = useCallback(
    async (widgetType: 'text' | 'countdown' | 'image' | 'shape' | 'parameter_switcher' | 'section_header' | 'callout' | 'hero_strip' | 'narrative') => {
      if (!dashboard) return;
      // What a new element says before the author writes anything — in the
      // report's language, never a fixed Vietnamese placeholder in an English
      // report. The report header states the report's own name/description
      // (empty = live), never a typed figure.
      const defaults: Record<string, any> = {
        text: { template: t('dashboards.addElement.defaultText'), align: 'left' },
        countdown: { target: new Date(Date.now() + 7 * 86400000).toISOString(), label: t('dashboards.addElement.defaultCountdown') },
        image: { url: '', fit: 'contain' },
        shape: { kind: 'divider', color: '#cbd5e1' },
        parameter_switcher: {
          paramName: 'period',
          label: t('dashboards.addElement.defaultParamLabel'),
          layout: 'tabs',
          options: [
            { label: 'YTD', value: 'YTD' },
            { label: 'Q1', value: 'Q1' },
            { label: 'Q2', value: 'Q2' },
          ],
        },
        section_header: { eyebrow: '', title: t('dashboards.addElement.defaultSection'), subtitle: '' },
        callout: { title: t('dashboards.addElement.defaultCalloutTitle'), text: t('dashboards.addElement.defaultCalloutText'), tone: 'accent' },
        hero_strip: { title: '', description: '', variant: 'banner', showPeriod: true, showContext: true },
        narrative: { variant: 'summary', origin: 'author', items: [] },
      };

      // Default footprint per widget type on the 36-col grid.
      const sizeByType: Record<string, { w: number; h: number }> = {
        text: { w: 12, h: 3 },
        countdown: { w: 12, h: 9 },
        image: { w: 12, h: 12 },
        shape: { w: 36, h: 1 },
        parameter_switcher: { w: 12, h: 6 },
        section_header: { w: 36, h: 3 },
        hero_strip: { w: 36, h: 6 },
        callout: { w: 12, h: 6 },
        narrative: { w: 18, h: 6 },
      };
      const size = sizeByType[widgetType];

      // Where it goes: directly under the ONE selected element, in its section
      // (the rows below move down to make room), else at the end of the page.
      // Built from the layout the author sees (unsaved moves included).
      const pageTiles = (dashboard.dashboard_charts ?? []).filter((dc) => {
        const l = resolveDashboardChartLayout(dc.id, localLayoutOverridesRef.current) as any;
        return activePageId ? (l?.pageId ?? null) === activePageId || (!l?.pageId && activePageId === dashboardPages[0]?.id) : true;
      });
      const structTiles = toStructTiles(pageTiles, (tid) => resolveDashboardChartLayout(tid, localLayoutOverridesRef.current));
      const anchorId = selectedTileIds.length === 1 ? selectedTileIds[0] : null;
      const spot = insertionFor(structTiles, widgetType === 'hero_strip' ? null : anchorId, size)
        ?? insertionFor(structTiles, null, size)!;
      // A report header opens the report: at the top, pushing the page down.
      const rect = widgetType === 'hero_strip'
        ? { x: 0, y: 0, w: size.w, h: size.h }
        : spot.rect;
      const pushed = widgetType === 'hero_strip'
        ? structTiles.map((st) => ({ id: st.id, x: st.x, y: st.y + size.h, w: st.w, h: st.h }))
        : spot.changed;
      const sectionId = widgetType === 'section_header' || widgetType === 'hero_strip' ? null : spot.sectionId;

      try {
        if (pushed.length > 0) {
          handleLayoutChange(pushed.map((bx) => ({ i: String(bx.id), x: bx.x, y: bx.y, w: bx.w, h: bx.h })) as Layout[]);
        }
        const updated = await dashboardApi.addWidget(
          dashboardId,
          widgetType,
          {
            ...rect,
            pageId: activePageId ?? undefined,
            gv: GRID_VERSION, // sizeByType is already finer (36-col) — mark so it's not re-scaled on read
            ...(sectionId != null ? { sectionId } : {}),
            // An addition is a draft change like any other: the public link
            // gets it on Publish, Discard deletes it.
            draftOnly: true,
          } as any,
          defaults[widgetType],
        );
        await queryClient.invalidateQueries({ queryKey: ['dashboards', dashboardId] });
        resetUndo(); // chart/widget set changed — prior layout undo entries are stale
        // The new element is selected and open in the inspector.
        const newest = (updated?.dashboard_charts ?? []).reduce<number | null>((acc, dc) => {
          if (dc.widget_type && dc.widget_type !== 'chart') {
            return acc === null || dc.id > acc ? dc.id : acc;
          }
          return acc;
        }, null);
        // A heading introduces what sits under it: the elements below it, down
        // to the next heading, that belong to no section join it.
        if (newest !== null && widgetType === 'section_header') {
          const pushedById = new Map(pushed.map((bx) => [bx.id, bx]));
          const after: StructTile[] = [
            ...structTiles.map((st) => ({ ...st, ...(pushedById.has(st.id) ? { y: pushedById.get(st.id)!.y } : {}) })),
            { id: newest, ...rect, kind: 'section' as const, sectionId: null },
          ];
          const adopt = adoptableUnder(after, newest);
          if (adopt.length > 0) handleLayoutChange([], Object.fromEntries(adopt.map((tid) => [tid, { sectionId: newest }])));
        }
        if (newest !== null) {
          setSelectedTileIds([newest]);
          setFocusedTileId(newest);
          setInspectorOpen(true);
        }
        toast.success(t('dashboards.addElement.added', { type: WIDGET_TYPE_LABEL(t, widgetType) }));
      } catch (err) {
        console.error('Failed to add widget:', err);
        const detail = (err as any)?.response?.data?.detail;
        toast.error(typeof detail === 'string' ? detail : t('dashboards.detail.widgetAddFailed'));
      } finally {
        setIsWidgetMenuOpen(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dashboard, dashboardId, activePageId, queryClient, selectedTileIds, dashboardPages],
  );

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
      const before = new Set((dashboard?.dashboard_charts ?? []).map((dc) => dc.id));
      const updated = await addChartMutation.mutateAsync({
        dashboardId,
        chartId,
        layout: {
          ...layout,
          pageId: activePageId,
          gv: GRID_VERSION, // AddChartModal packs on the finer 36-col grid — tag so read doesn't re-scale
          // A draft addition: public/embed get it on Publish; Discard deletes it.
          draftOnly: true,
        } as DashboardChartLayout,
        parameters,
      });
      // Opened from Add with one element selected: remember what this batch
      // added, so it is placed under that element once the report has it.
      const batch = insertBatchRef.current;
      if (batch) {
        const added = (updated?.dashboard_charts ?? []).find((dc) => dc.chart_id === chartId && !before.has(dc.id) && !batch.ids.includes(dc.id));
        if (added) batch.ids.push(added.id);
      }
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
      const next = { ...localLayoutOverridesRef.current };
      delete next[dashboardChart.id];
      await removeElementsInDraftRef.current([dashboardChart.id], next);
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

    // A page move is a draft change like any other layout edit: staged into the
    // caller's draft (with any pending local edits), published by Publish,
    // reverted by Discard. It used to write the LIVE layout (PUT /layout), so
    // the move — and whatever draft geometry the tile had — went public at once.
    // The tile lands below the target page's content, never on top of a tile.
    const targetBottom = (dashboard.dashboard_charts ?? [])
      .filter((dc) => dc.id !== dashboardChartId && getDashboardChartPageId(dc.layout) === pageId)
      .reduce((bottom, dc) => Math.max(bottom, (Number(dc.layout?.y) || 0) + (Number(dc.layout?.h) || 0)), 0);
    try {
      const mergedLayouts: Record<number, Record<string, any>> = {};
      for (const [id, layout] of Object.entries(localLayoutOverrides)) mergedLayouts[Number(id)] = layout;
      mergedLayouts[dashboardChartId] = {
        ...dashboardChart.layout,
        ...(localLayoutOverrides[dashboardChartId] ?? {}),
        pageId,
        x: 0,
        y: targetBottom,
      };
      await updateDraftLayoutMutation.mutateAsync({
        dashboardId,
        chartLayouts: Object.entries(mergedLayouts).map(([id, layout]) => ({ id: Number(id), layout })),
      });
      setLocalLayoutOverrides({});
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
    () => paramsToFilters(paramDefs, paramValues, resolvedAvailableColumns, dashboard?.parameter_fields),
    [paramDefs, paramValues, resolvedAvailableColumns, dashboard?.parameter_fields],
  );
  // What the report header says about the context: the filters the charts are
  // queried with right now, stated as a reader reads them.
  const reportMeta = React.useMemo(() => ({
    name: dashboard?.name,
    description: dashboard?.description ?? null,
    filterFacts: pageFilterFacts({ applied: effectivePageScopeFilters, pageHidden: [], locked: [] })
      .map((f) => `${f.label}: ${statePageFilterFact(f, t)}`),
    // Which section a tile's period belongs to (a report over independent
    // datasets states each dataset's own coverage).
    sectionTitleOf: sectionTitlesOf(visibleDashboardCharts, resolveStructure(toStructTiles(visibleDashboardCharts)).sectionOf),
  }), [dashboard?.name, dashboard?.description, effectivePageScopeFilters, t, visibleDashboardCharts]);
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

  // ── Slicer controls: add, restyle, remove, delete ──────────────────────
  // A report has no filter area of its own: every filter a viewer can change is
  // drawn by a control ON the grid. These are the filters that can have one.
  const [isAddSlicerOpen, setIsAddSlicerOpen] = useState(false);
  const [isPlacingSlicer, setIsPlacingSlicer] = useState(false);
  const handleRemoveChartRef = React.useRef(handleRemoveChart);
  handleRemoveChartRef.current = handleRemoveChart;

  // Filter-pane filters left visible to viewers are controls too: the public
  // link always let a viewer change them. Visibility is the stored config's;
  // the value is the draft's.
  const viewerPaneFilters = React.useMemo<BaseFilter[]>(() => {
    const visibleIds = new Set(((dashboard as any)?.filters_config ?? [])
      .filter((f: any) => f && typeof f === 'object' && (f.publicMode ?? 'visible') === 'visible')
      .map((f: any) => String(f.id)));
    return draftGlobalFilters
      .filter((f) => visibleIds.has(String(f.id)))
      .map((f) => toBaseFilter(f, { allowInactive: true }))
      .filter((b): b is BaseFilter => b !== null);
  }, [dashboard, draftGlobalFilters]);
  const paneFilterIds = React.useMemo(() => new Set(viewerPaneFilters.map((f) => String(f.id))), [viewerPaneFilters]);
  const controlFilters = React.useMemo<BaseFilter[]>(
    () => [...(orderedSlicerChildren.filter((s: any) => s?.type !== 'image') as BaseFilter[]), ...viewerPaneFilters],
    [orderedSlicerChildren, viewerPaneFilters],
  );
  // A value picked in a control is staged into the entry it shows.
  const handleControlChange = React.useCallback((next: BaseFilter) => {
    if (paneFilterIds.has(String(next.id))) {
      setDraftGlobalFilters((prev) => prev.map((f) => {
        if (String(f.id) !== String(next.id)) return f;
        const typed = fromBaseFilter(next);
        return typed ? ({ ...f, ...typed } as TypedFilter) : f;
      }));
      return;
    }
    handleControlSlicerChange(next);
  }, [paneFilterIds, handleControlSlicerChange]);
  const controlVisibleHere = React.useCallback(
    (s: any) => paneFilterIds.has(String(s?.id)) || slicerIsVisibleHere(s),
    [paneFilterIds, slicerIsVisibleHere],
  );
  const controlFiltersHere = React.useCallback(
    (s: any) => paneFilterIds.has(String(s?.id)) || slicerFiltersHere(s),
    [paneFilterIds, slicerFiltersHere],
  );
  // Filters this page shows that have no control here (a new page, a filter
  // made in the pane, a control the author removed): the Slicer button lists them.
  const unplacedControlFilters = React.useMemo(
    () => controlFilters.filter((s) => controlVisibleHere(s) && !placedSlicerIdsOnPage.has(String(s.id ?? ''))),
    [controlFilters, controlVisibleHere, placedSlicerIdsOnPage],
  );

  // Save the slicer lists to the draft now. Used when a control is created for
  // a NEW filter (a reload must never find a control pointing at nothing) and
  // when a filter is deleted with its controls. It stores what Apply stores:
  // any other staged slicer edit is saved with it.
  const persistSlicerLists = useCallback(async (
    nextGlobal: any[],
    nextPage: any[],
    extra: { filters_config?: BaseFilter[]; remove_tile_ids?: number[] } = {},
  ) => {
    setDraftGlobalSlicers(nextGlobal);
    setAppliedGlobalSlicers(nextGlobal);
    setDraftPageSlicers(nextPage);
    const body: { slicers_config: any[]; pages_config?: any[]; filters_config?: BaseFilter[]; remove_tile_ids?: number[] } = {
      slicers_config: nextGlobal,
      ...extra,
    };
    if (activePageId) {
      const nextPages = dashboardPages.map((p) => {
        if (p.id !== activePageId) return p;
        const next: any = { ...p };
        const pageSlicers = nextPage.filter((s) => !(s && typeof s === 'object' && (s as any).type === 'image'));
        if (pageSlicers.length > 0) next.slicers = pageSlicers;
        else delete next.slicers;
        return next;
      });
      body.pages_config = nextPages;
      setLocalPagesConfig(nextPages);
    }
    await dashboardApi.updateDraftFilters(dashboardId, body);
    await queryClient.invalidateQueries({ queryKey: ['dashboards', dashboardId] });
  }, [activePageId, dashboardPages, dashboardId, queryClient]);

  // Placing controls is ONE undoable step through the same commit path as an AI
  // design: draft-only rows until Publish, deleted by Undo or Discard. At the top
  // of the page the content moves down by the band the controls need (room is
  // made, nothing is shoved aside); below the content they take the free rows.
  const placeSlicerControls = useCallback(async (slicers: BaseFilter[], requested: 'top' | 'end' | 'beside') => {
    if (!slicers.length) return;
    const card = SLICER_CONTROL_SIZE.card;
    const rows = Math.ceil(slicers.length / 4) * card.h;
    const prev = localLayoutOverridesRef.current;
    const overrides: Record<number, Record<string, any>> = { ...prev };
    let y0 = nextFreeSlot(visibleDashboardCharts, card).y;
    let where = requested;
    // Next to the selected element: in free space in its rows (nothing moves),
    // else directly above it (the rows from there down make room). Each
    // control is placed against the page as the previous one left it.
    const targetId = selectedTileIds.length === 1 ? selectedTileIds[0] : null;
    const besideCells: { x: number; y: number; w: number; h: number }[] = [];
    if (where === 'beside' && targetId !== null) {
      let boxes: GridBox[] = settleStoredLayout(visibleDashboardCharts.map((dc) => {
        const l = resolveDashboardChartLayout(dc.id, prev) as Record<string, any>;
        return { i: String(dc.id), id: dc.id, x: Number(l.x) || 0, y: Number(l.y) || 0, w: Number(l.w) || 1, h: Number(l.h) || 1,
          static: Boolean(l.locked), locked: Boolean(l.locked) };
      }), DASHBOARD_GRID_COLS).map(({ i: _i, static: _s, ...box }) => box);
      let fits = true;
      for (let n = 0; n < slicers.length; n += 1) {
        const spot = placeBeside(boxes, targetId, card);
        if (!spot) { fits = false; break; }
        const moved = new Map(spot.changed.map((b) => [b.id, b]));
        boxes = [...boxes.map((b) => moved.get(b.id) ?? b), { id: -(n + 1), ...spot.rect }];
        besideCells.push(spot.rect);
      }
      if (fits) {
        for (const b of boxes) {
          if (b.id < 0) continue;
          const was = visibleDashboardCharts.find((dc) => dc.id === b.id);
          const full = resolveDashboardChartLayout(b.id, prev) as Record<string, any>;
          if (was && (Number(full.y) !== b.y || Number(full.x) !== b.x)) overrides[b.id] = { ...full, x: b.x, y: b.y };
        }
      } else {
        besideCells.length = 0;
        toast.info(t('dashboards.addSlicer.besideBlocked'));
        where = 'end';
      }
    } else if (where === 'beside') {
      where = 'end';
    }
    if (where === 'top') {
      if (visibleDashboardCharts.some((dc) => (dc.layout as any)?.locked)) {
        toast.info(t('dashboards.addSlicer.topBlocked'));
      } else {
        for (const dc of visibleDashboardCharts) {
          const full = resolveDashboardChartLayout(dc.id, prev) as Record<string, any>;
          overrides[dc.id] = { ...full, y: (Number(full.y) || 0) + rows };
        }
        y0 = 0;
      }
    }
    await commitPresentation({
      layoutOverrides: overrides,
      themePatch: null,
      slicerClusterPatch: null,
      createdBlocks: slicers.map((s, i) => ({
        tempId: -(i + 1),
        widgetType: SLICER_CONTROL_WIDGET as 'slicer',
        widgetConfig: { slicerId: String(s.id), treatment: 'auto', origin: 'author' },
        layout: besideCells[i]
          ? { ...besideCells[i], gv: GRID_VERSION, pageId: activePageId }
          : { x: (i % 4) * card.w, y: y0 + Math.floor(i / 4) * card.h, w: card.w, h: card.h, gv: GRID_VERSION, pageId: activePageId },
      })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleDashboardCharts, activePageId, resolveDashboardChartLayout, commitPresentation, selectedTileIds, t]);

  const usedSlicerFieldKeys = React.useMemo(
    () => new Set(controlFilters.map((s: any) => getFilterKey(s))),
    [controlFilters],
  );
  const addSlicerColumns = React.useMemo(
    () => resolvedAvailableColumns.filter((c) => (c.type === 'date' || (c.chartCoverage ?? 0) > 0)
      && !usedSlicerFieldKeys.has(getColumnKey(c))),
    [resolvedAvailableColumns, usedSlicerFieldKeys],
  );

  const handleAddSlicer = useCallback(async (input: { existing?: BaseFilter[]; column?: ColumnInfo; where?: 'top' | 'end' | 'beside' }) => {
    setIsPlacingSlicer(true);
    try {
      let slicers = input.existing ?? [];
      if (!slicers.length && input.column) {
        const created = createSlicerEntry({
          column: input.column,
          columns: resolvedAvailableColumns,
          usedFields: usedSlicerFieldKeys,
          interaction: defaultInteractionFor(input.column),
          // A new date control starts OPEN ("all dates"): defaulting it to
          // this month emptied the report the moment it was placed.
          preset: input.column.type === 'date' ? 'custom' : undefined,
          pageScope: true,
        });
        await persistSlicerLists(draftGlobalSlicers, [...draftPageSlicers, created]);
        slicers = [created];
      }
      if (!slicers.length) return;
      await placeSlicerControls(slicers, input.where ?? 'end');
      setIsAddSlicerOpen(false);
      toast.success(t('dashboards.slicerControl.added'));
    } catch (err) {
      console.error('Failed to place slicer:', err);
      toast.error(t('dashboards.slicerControl.addFailed'));
    } finally {
      setIsPlacingSlicer(false);
    }
  }, [resolvedAvailableColumns, usedSlicerFieldKeys, persistSlicerLists, draftGlobalSlicers, draftPageSlicers, placeSlicerControls, t]);

  // Remove elements in the draft — ONE undoable step for any kind of element.
  // A published one stays on the public link until Publish and comes back as
  // itself on Undo or Discard; one added in this draft is deleted (Undo creates
  // it again). `next` is the layout after the removal (e.g. a closed band).
  const removeElementsInDraft = useCallback(async (tileIds: number[], next: Record<number, Record<string, any>>) => {
    const prev = localLayoutOverridesRef.current;
    const rows = serverDashboard?.dashboard_charts ?? [];
    const published: number[] = [];
    const drafts: RemovedDraftSpec[] = [];
    for (const id of tileIds) {
      const dc = rows.find((d) => d.id === id);
      if (!dc) continue;
      if ((dc.layout as any)?.draftOnly) {
        const { draftOnly: _o, draftOwner: _w, ...layout } = resolveDashboardChartLayout(id, prev) as unknown as Record<string, unknown>;
        drafts.push({
          widgetType: String(dc.widget_type || 'chart'),
          chartId: (dc as any).chart_id ?? null,
          widgetConfig: { ...((dc.widget_config ?? {}) as Record<string, unknown>) },
          layout,
          parameters: ((dc as any).parameters ?? undefined) as Record<string, unknown> | undefined,
        });
      } else {
        published.push(id);
      }
    }
    for (const id of tileIds) await dashboardApi.removeChart(dashboardId, id);
    await queryClient.invalidateQueries({ queryKey: ['dashboards', dashboardId] });
    setLocalLayoutOverrides(next);
    pushUndo({ kind: 'removal', published, drafts, draftIds: [], prev, next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverDashboard, resolveDashboardChartLayout, dashboardId, queryClient]);
  const removeElementsInDraftRef = React.useRef(removeElementsInDraft);
  removeElementsInDraftRef.current = removeElementsInDraft;

  // Remove a CONTROL (the filter stays and keeps filtering). One undoable step:
  // Undo puts the control back where it was; a band made only for filters closes
  // when its last control leaves it.
  const removeSlicerControl = useCallback(async (tileId: number) => {
    const dc = visibleDashboardCharts.find((d) => d.id === tileId);
    if (!dc) return;
    const prev = localLayoutOverridesRef.current;
    const boxes: GridBox[] = visibleDashboardCharts.map((d) => ({
      id: d.id, x: Number(d.layout?.x) || 0, y: Number(d.layout?.y) || 0,
      w: Number(d.layout?.w) || 1, h: Number(d.layout?.h) || 1, locked: Boolean((d.layout as any)?.locked),
    }));
    const next: Record<number, Record<string, any>> = { ...prev };
    delete next[tileId];
    for (const b of closeVacatedBand(boxes, tileId)) {
      next[b.id] = mergeGridLayout(resolveDashboardChartLayout(b.id, prev), b);
    }
    setRemovingChartId(tileId);
    try {
      await removeElementsInDraft([tileId], next);
      toast.success(t('dashboards.slicerControl.removed'));
    } catch (error) {
      console.error('Failed to remove slicer control:', error);
      toast.error(t('dashboards.detail.chartRemoveFailed'));
    } finally {
      setRemovingChartId(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleDashboardCharts, resolveDashboardChartLayout, removeElementsInDraft, t]);
  const removeSlicerControlRef = React.useRef(removeSlicerControl);
  removeSlicerControlRef.current = removeSlicerControl;

  // Delete the FILTER: its entry — a slicer, a page slicer or a filter-pane
  // filter — and every control for it on every page, as ONE draft change (one
  // request, one transaction): all of it or nothing. The public link keeps the
  // filter and its controls until Publish; Discard brings both back.
  const handleDeleteSlicerFilter = useCallback(async (slicerId: string) => {
    try {
      const controls = (serverDashboard?.dashboard_charts ?? []).filter((dc) => slicerIdOfControl(dc) === slicerId);
      const extra: { filters_config?: BaseFilter[]; remove_tile_ids?: number[] } = { remove_tile_ids: controls.map((dc) => dc.id) };
      if (paneFilterIds.has(slicerId)) {
        extra.filters_config = draftGlobalFilters
          .filter((f) => String(f.id) !== slicerId)
          .map((f) => toBaseFilter(f, { allowInactive: true }))
          .filter((b): b is BaseFilter => b !== null);
      }
      await persistSlicerLists(
        draftGlobalSlicers.filter((s: any) => String(s?.id ?? '') !== slicerId),
        draftPageSlicers.filter((s: any) => String(s?.id ?? '') !== slicerId),
        extra,
      );
      if (extra.filters_config) {
        setDraftGlobalFilters((prev) => prev.filter((f) => String(f.id) !== slicerId));
        setAppliedGlobalFilters((prev) => prev.filter((f) => String(f.id) !== slicerId));
      }
      resetUndo();
    } catch (err) {
      console.error('Failed to delete slicer filter:', err);
      toast.error(t('dashboards.detail.filterSaveFailed'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistSlicerLists, draftGlobalSlicers, draftPageSlicers, draftGlobalFilters, paneFilterIds, serverDashboard, t]);

  // Display is layout: local edit → draft → publish, undoable like a drag.
  const handleSlicerTreatmentChange = useCallback((tileId: number, treatment: SlicerTreatment) => {
    const prevOverrides = localLayoutOverridesRef.current;
    const next = {
      ...prevOverrides,
      [tileId]: { ...resolveDashboardChartLayout(tileId, prevOverrides), slicerTreatment: treatment },
    };
    pushUndo({ kind: 'layout', prev: prevOverrides, next });
    setLocalLayoutOverrides(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveDashboardChartLayout]);

  const renderBuilderSlicerControl = useCallback((dc: any) => <GridSlicerTile tile={dc} />, []);

  // ── Arrange tools + keyboard (manual builder) ──────────────────────────
  // Grid operations on the selection (lib/grid-arrange), committed through the
  // same path as a drag. The keyboard handler reads the latest state through a
  // ref: it is bound once, and a stale closure would nudge an old layout.
  // The page as the grid draws it (a stored overlap settled, as for viewers):
  // arrange and drop rules work on what the author sees.
  const pageBoxes = (): GridBox[] => settleStoredLayout(visibleDashboardCharts.map((dc) => ({
    i: String(dc.id),
    id: dc.id,
    x: Number(dc.layout?.x) || 0,
    y: Number(dc.layout?.y) || 0,
    w: Number(dc.layout?.w) || 1,
    h: Number(dc.layout?.h) || 1,
    static: Boolean((dc.layout as any)?.locked),
    locked: Boolean((dc.layout as any)?.locked),
  })), DASHBOARD_GRID_COLS).map(({ i: _i, static: _s, ...box }) => box);
  const tileTitle = (id: number) => {
    const dc = visibleDashboardCharts.find((d) => d.id === id);
    // A filter control is named by its filter, never by its widget type.
    const control = isSlicerControl(dc) ? controlFilters.find((s) => String(s.id) === slicerIdOfControl(dc)) : undefined;
    const controlName = control ? (control.label || control.field) : undefined;
    // A widget by what it says (its title; the report header states the
    // report's name), else by what it is — never by its internal type name.
    const cfg = (dc?.widget_config ?? {}) as Record<string, any>;
    const widgetName = [cfg.title, cfg.headline, cfg.label, dc?.widget_type === 'hero_strip' ? dashboard?.name : undefined]
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .find(Boolean);
    const typeName = dc?.widget_type && dc.widget_type !== 'chart' ? WIDGET_TYPE_LABEL(t, dc.widget_type) : undefined;
    return String((dc?.layout as any)?.custom_title || dc?.chart?.name || controlName || widgetName || typeName || id);
  };
  const commitArrange = (result: ArrangeResult) => {
    if (result.status === 'blocked') {
      toast.info(t('dashboards.arrange.blocked', { title: tileTitle(result.blockedBy) }));
      return;
    }
    if (result.status === 'noop') {
      if (result.skippedLocked > 0) toast.info(t('dashboards.arrange.lockedSkipped'));
      return;
    }
    handleLayoutChange(result.moved.map((b) => ({ i: String(b.id), x: b.x, y: b.y, w: b.w, h: b.h })) as Layout[]);
    if (result.skippedLocked > 0) toast.info(t('dashboards.arrange.lockedSkipped'));
  };
  // Desktop arrange tools edit DESKTOP geometry: not offered on a device canvas.
  const handleArrange = (op: ArrangeOp) => { if (deviceMode === 'desktop') commitArrange(arrangeTiles(op, pageBoxes(), selectedTileIds)); };
  // Frame of the selected CHARTS (a widget frames itself). One undo step; it is
  // layout state, so it is a draft edit published with the rest.
  const selectedChartIds = selectedTileIds.filter((id) => {
    const dc = visibleDashboardCharts.find((d) => d.id === id);
    return !!dc && (!dc.widget_type || dc.widget_type === 'chart');
  });
  const selectedFrame = (() => {
    // The frame the tile actually renders with: the chart's own style (an
    // older "transparent background" reads as flush) under this report's override.
    const frames = new Set(selectedChartIds.map((id) => {
      const dc = visibleDashboardCharts.find((d) => d.id === id);
      return resolveTileFrame(getEffectiveDashboardChartStyleConfig(dc?.chart as any, resolveDashboardChartLayout(id) as any) as any);
    }));
    return frames.size === 1 ? [...frames][0] : null;
  })();
  const handleFrame = (frame: TileFrame) => {
    if (selectedChartIds.length === 0) return;
    const prevOverrides = localLayoutOverridesRef.current;
    const next = { ...prevOverrides };
    for (const id of selectedChartIds) {
      const layout = resolveDashboardChartLayout(id, prevOverrides) as any;
      next[id] = { ...layout, styleConfigOverride: { ...(layout?.styleConfigOverride ?? {}), tileFrame: frame } };
    }
    pushUndo({ kind: 'layout', prev: prevOverrides, next });
    setLocalLayoutOverrides(next);
  };
  // A drag or resize on the grid: where the tile lands, what makes room for it,
  // and — for a filter control — whether the band it left closes
  // (lib/grid-arrange resolveDrop). One undo step, whatever it moved.
  const [gridRevision, setGridRevision] = useState(0);
  const handleGridGesture = (items: Layout[]) => {
    const item = items[0];
    if (!item) return;
    const id = Number(item.i);
    const boxes = pageBoxes();
    const was = boxes.find((b) => b.id === id);
    if (!was) { handleLayoutChange(items); return; }
    const dc = visibleDashboardCharts.find((d) => d.id === id);
    // The page's structure as the author sees it (report-structure): geometry
    // from the settled grid, membership from each tile's layout.
    const geometry = new Map(boxes.map((b) => [b.id, b]));
    const structTiles = toStructTiles(visibleDashboardCharts, (tid) => ({
      ...(resolveDashboardChartLayout(tid, localLayoutOverridesRef.current) as any), ...geometry.get(tid),
    }));
    const structure = resolveStructure(structTiles);
    const moved = item.x !== was.x || item.y !== was.y;
    const resized = item.w !== was.w || item.h !== was.h;
    // Membership stated before anything moves, so a structural gesture never
    // re-reads another section from the new geometry (a legacy report's
    // inferred sections are written down the first time).
    const materialize = (): Record<number, Record<string, any>> => {
      const out: Record<number, Record<string, any>> = {};
      for (const t of structTiles) {
        if (t.kind === 'section' || t.kind === 'header' || t.sectionId !== undefined) continue;
        out[t.id] = { sectionId: structure.sectionOf.get(t.id) ?? null };
      }
      return out;
    };
    if (dc?.widget_type === 'section_header' && moved && !resized) {
      // A section moves as a whole: its members keep their place under it.
      const group = moveSection(structTiles, id, { x: item.x, y: item.y }, structure);
      if (!group) {
        // A section moves whole or not at all: a locked member is named, never
        // left behind while still counted as part of the section.
        const lockedMember = lockedMemberOf(structTiles, id, structure);
        toast.info(lockedMember != null
          ? t('dashboards.arrange.sectionLocked', { title: tileTitle(lockedMember) })
          : t('dashboards.arrange.lockedInWay', { title: tileTitle(id) }));
        setGridRevision((n) => n + 1);
        return;
      }
      handleLayoutChange(group.map((b) => ({ i: String(b.id), x: b.x, y: b.y, w: b.w, h: b.h })) as Layout[], materialize());
      return;
    }
    const result = resolveDrop(boxes, id, { x: item.x, y: item.y, w: item.w, h: item.h }, {
      from: { y: was.y, h: was.h },
      closeVacatedBand: isSlicerControl(dc),
    });
    if (result.status === 'refused') {
      toast.info(t(result.reason === 'locked' ? 'dashboards.arrange.lockedInWay' : 'dashboards.arrange.blocked',
        { title: tileTitle(result.blockedBy ?? id) }));
      setGridRevision((n) => n + 1);
      return;
    }
    // A moved element belongs to the section it now sits in (a resize never
    // changes membership). Headers and the report header belong to none.
    const extra: Record<number, Record<string, any>> = {};
    const self = structTiles.find((st) => st.id === id);
    if (moved && self && (self.kind === 'content' || self.kind === 'narrative')) {
      const landed = result.changed.find((b) => b.id === id) ?? { ...was, ...item };
      const after = structTiles.map((st) => {
        const c = result.changed.find((b) => b.id === st.id);
        return c ? { ...st, x: c.x, y: c.y } : st;
      });
      const target = sectionForPosition(after, landed.y, id);
      if (target !== (structure.sectionOf.get(id) ?? null) || self.sectionId === undefined) {
        Object.assign(extra, materialize(), { [id]: { sectionId: target } });
      }
    }
    handleLayoutChange(result.changed.map((b) => ({ i: String(b.id), x: b.x, y: b.y, w: b.w, h: b.h })) as Layout[], extra);
  };
  const openAddChartUnderSelection = () => {
    insertBatchRef.current = selectedTileIds.length === 1 ? { anchorId: selectedTileIds[0], ids: [], closed: false } : null;
    setIsAddChartModalOpen(true);
  };
  // Once the picker is closed and the report holds every chart it added: move
  // the batch, as one block, directly under the anchor and into its section
  // (the rows below make room — the grid's single placement rule). One undo step.
  React.useEffect(() => {
    const batch = insertBatchRef.current;
    if (!batch || !batch.closed) return;
    if (batch.ids.length === 0) { insertBatchRef.current = null; return; }
    const present = new Set(visibleDashboardCharts.map((dc) => dc.id));
    if (!batch.ids.every((id) => present.has(id)) || !present.has(batch.anchorId)) return;
    insertBatchRef.current = null;
    const boxes = pageBoxes();
    const geometry = new Map(boxes.map((b) => [b.id, b]));
    const all = toStructTiles(visibleDashboardCharts, (tid) => ({
      ...(resolveDashboardChartLayout(tid, localLayoutOverridesRef.current) as any), ...geometry.get(tid),
    }));
    const group = all.filter((s) => batch.ids.includes(s.id));
    const rest = all.filter((s) => !batch.ids.includes(s.id));
    const top = Math.min(...group.map((g) => g.y));
    const left = Math.min(...group.map((g) => g.x));
    const right = Math.max(...group.map((g) => g.x + g.w));
    const height = Math.max(...group.map((g) => g.y + g.h)) - top;
    const spot = insertionFor(rest, batch.anchorId, { w: right - left, h: height });
    if (!spot) return; // a locked tile in the way: the charts stay where the picker put them
    const dx = spot.rect.x - left;
    const dy = spot.rect.y - top;
    const structure = resolveStructure(all);
    const extra: Record<number, Record<string, any>> = {};
    for (const s of all) {
      if (s.kind === 'section' || s.kind === 'header' || s.sectionId !== undefined || batch.ids.includes(s.id)) continue;
      extra[s.id] = { sectionId: structure.sectionOf.get(s.id) ?? null };
    }
    for (const id of batch.ids) extra[id] = { sectionId: spot.sectionId };
    handleLayoutChange([
      ...spot.changed.map((b) => ({ i: String(b.id), x: b.x, y: b.y, w: b.w, h: b.h })),
      ...group.map((g) => ({ i: String(g.id), x: g.x + dx, y: g.y + dy, w: g.w, h: g.h })),
    ] as Layout[], extra);
    setSelectedTileIds(batch.ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insertBatchTick, visibleDashboardCharts]);
  // ── Inspector ───────────────────────────────────────────────────────────
  // The Inspector docks beside the grid in the manual builder only (AI Design
  // has its own drawer; a preview or an export shows the report alone).
  const inspectorShown = inspectorOpen && canEditThisPage && designMode === 'manual' && !studioPreview && !isExportingPdf;
  // Anything docked to the right makes the content row side by side (lg+).
  const rightDocked = isFilterPaneOpen || inspectorShown;
  // The page's structure as the author sees it, for the Inspector's outline and
  // section picker: geometry from the settled grid, membership from layouts.
  const inspectorStructure = (() => {
    if (!inspectorShown) return null;
    const geometry = new Map(pageBoxes().map((b) => [b.id, b]));
    const tiles = toStructTiles(visibleDashboardCharts, (tid) => ({
      ...(resolveDashboardChartLayout(tid, localLayoutOverridesRef.current) as any), ...geometry.get(tid),
    }));
    const resolved = resolveStructure(tiles);
    return { tiles, resolved, issues: structureIssues(tiles, resolved) };
  })();
  // Typed geometry is a gesture like a drag: the same placement rule, one undo step.
  const handleInspectorGeometry = (id: number, rect: { x: number; y: number; w: number; h: number }) => {
    handleGridGesture([{ i: String(id), ...rect } as Layout]);
  };
  // Into a section: the element goes to the end of that section (the rows
  // below make room) and is stated a member; "no section" = the end of the page.
  const handleMoveToSection = (id: number, sectionId: number | null) => {
    const geometry = new Map(pageBoxes().map((b) => [b.id, b]));
    const all = toStructTiles(visibleDashboardCharts, (tid) => ({
      ...(resolveDashboardChartLayout(tid, localLayoutOverridesRef.current) as any), ...geometry.get(tid),
    }));
    const self = all.find((s) => s.id === id);
    if (!self) return;
    if (self.locked) { toast.info(t('dashboards.arrange.lockedInWay', { title: tileTitle(id) })); return; }
    const structure = resolveStructure(all);
    const rest = all.filter((s) => s.id !== id);
    const section = sectionId != null ? structure.sections.find((s) => s.headerId === sectionId) : undefined;
    const members = (section?.members ?? []).filter((m) => m !== id).map((m) => rest.find((s) => s.id === m)!).filter(Boolean);
    const anchor = sectionId == null ? null
      : members.length ? members.reduce((a, b) => (b.y + b.h > a.y + a.h || (b.y + b.h === a.y + a.h && b.x > a.x) ? b : a)).id
        : sectionId;
    const spot = insertionFor(rest, anchor, { w: self.w, h: self.h });
    if (!spot) { toast.info(t('dashboards.arrange.blocked', { title: tileTitle(id) })); return; }
    const extra: Record<number, Record<string, any>> = {};
    for (const s of all) {
      if (s.kind === 'section' || s.kind === 'header' || s.sectionId !== undefined) continue;
      extra[s.id] = { sectionId: structure.sectionOf.get(s.id) ?? null };
    }
    extra[id] = { sectionId };
    handleLayoutChange([
      ...spot.changed.map((b) => ({ i: String(b.id), x: b.x, y: b.y, w: b.w, h: b.h })),
      { i: String(id), ...spot.rect },
    ] as Layout[], extra);
  };
  // Height to content: measured on the tile as rendered, in whole rows.
  const handleFitToContent = (id: number) => {
    const el = canvasRootRef.current?.querySelector<HTMLElement>(`[data-grid-item-id="${id}"] [data-tile-id="${id}"]`);
    const box = pageBoxes().find((b) => b.id === id);
    if (!el || !box) return;
    const gapY = getDashboardGridMargin(dashboard?.theme_config)[1];
    const h = rowsForHeight(measureNaturalHeight(el), dashboardRowHeight(gapY), gapY);
    if (h !== box.h) handleInspectorGeometry(id, { x: box.x, y: box.y, w: box.w, h });
  };
  const handleInspectorPattern = (pattern: LayoutPattern) => {
    const leadId = selectedTileIds.find((id) => (resolveDashboardChartLayout(id, localLayoutOverridesRef.current) as any)?.emphasis === 'lead') ?? null;
    commitArrange(applyLayoutPattern(pattern, pageBoxes(), selectedTileIds, { leadId }));
  };
  const handleSaveWidgetConfig = async (id: number, config: Record<string, any>) => {
    const run = (async () => {
      await dashboardApi.updateWidget(dashboardId, id, config);
      await queryClient.invalidateQueries({ queryKey: ['dashboards', dashboardId] });
    })();
    inflightContentSavesRef.current.add(run);
    try { await run; } finally { inflightContentSavesRef.current.delete(run); }
  };
  const handleSaveReportDetails = async (patch: { name: string; description: string | null }) => {
    try {
      await updateDashboardMutation.mutateAsync({ id: dashboardId, data: { name: patch.name, description: patch.description ?? '' } });
      toast.success(t('dashboards.inspector.reportSaved'));
    } catch (error) {
      console.error('Failed to update report details:', error);
      toast.error(t('dashboards.detail.nameUpdateFailed'));
    }
  };
  const openInspectorFor = useCallback((id: number) => {
    setSelectedTileIds([id]);
    setFocusedTileId(id);
    setInspectorOpen(true);
  }, []);
  const nudgeRef = React.useRef<(d: { dx: number; dy: number }) => void>(() => {});
  nudgeRef.current = (d) => commitArrange(nudgeTiles(pageBoxes(), selectedTileIds, d));
  const keyboardArrangeOn = designMode === 'manual' && canEditThisPage && selectedTileIds.length > 0 && deviceMode === 'desktop';
  React.useEffect(() => {
    if (!keyboardArrangeOn) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return;
      const step = e.shiftKey ? 4 : 1;
      const delta = e.key === 'ArrowLeft' ? { dx: -step, dy: 0 }
        : e.key === 'ArrowRight' ? { dx: step, dy: 0 }
          : e.key === 'ArrowUp' ? { dx: 0, dy: -step }
            : e.key === 'ArrowDown' ? { dx: 0, dy: step }
              : null;
      if (delta) { e.preventDefault(); nudgeRef.current(delta); return; }
      if (e.key === 'Escape') clearTileSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keyboardArrangeOn, clearTileSelection]);

  const hasPendingSlicerChanges = JSON.stringify(draftGlobalSlicers) !== JSON.stringify(appliedGlobalSlicers)
    || JSON.stringify(draftPageSlicers) !== JSON.stringify(activePageSlicers)
    || JSON.stringify(draftSlicerClusterLayout) !== JSON.stringify(appliedSlicerClusterLayout);
  // Which controls hold a choice the canvas does not show yet.
  const stagedControlIds = hasPendingSlicerChanges
    ? stagedSlicerIds(
      [...(draftGlobalSlicers as BaseFilter[]), ...(draftPageSlicers as BaseFilter[])],
      [...(appliedGlobalSlicers as BaseFilter[]), ...(activePageSlicers as BaseFilter[])],
    )
    : new Set<string>();

  // Phase-B22 — hybrid export: tables as real text+links (all rows), other
  // charts as images, paginated legibly, with an applied-filters header.
  // NOTE: must stay ABOVE the early returns below — hooks can't run
  // conditionally (React #310 if placed after `if (isLoadingDashboard) return`).
  // One page's header: the all-pages filters plus THAT page's own filters,
  // stated by the rule the public banner uses (an exclusion reads "not RJ", a
  // range "a – b", a preset by its name).
  const summarizeAppliedFilters = useCallback((page?: { filters?: unknown }): string => pageFilterFacts({
    applied: [
      ...(appliedGlobalFiltersLegacy || []),
      ...(Array.isArray(page?.filters) ? page!.filters as BaseFilter[] : []),
    ],
    pageHidden: [],
    locked: [],
  }).map((f) => `${f.label}: ${statePageFilterFact(f, t)}`).join('  ·  '), [appliedGlobalFiltersLegacy, t]);

  // The export arranger's candidates — the same shape the public view feeds it
  // (charts + printable report elements, with their authored geometry). The
  // builder passed none, so "Arrange it yourself" opened an empty sheet.
  const exportPlanCandidates = React.useMemo(() => {
    const pageNameById = new Map(dashboardPages.map((pg) => [pg.id, pg.name]));
    return (dashboard?.dashboard_charts ?? [])
      .filter((dc: any) => ((!dc.widget_type || dc.widget_type === 'chart') && dc.chart_id)
        || PRINTABLE_ELEMENT_TYPES.has(String(dc.widget_type)))
      .map((dc: any) => ({
        chartId: dc.widget_type && dc.widget_type !== 'chart' ? planKeyForElement(dc.id) : dc.chart_id,
        title: dc.widget_type && dc.widget_type !== 'chart'
          ? String(dc.widget_config?.title || dc.widget_config?.headline || (dc.widget_type === 'hero_strip' ? dashboard?.name : '') || WIDGET_TYPE_LABEL(t, dc.widget_type))
          : dc.layout?.custom_title || dc.chart?.name || `#${dc.chart_id}`,
        chartType: dc.widget_type && dc.widget_type !== 'chart' ? 'ELEMENT' : dc.chart?.chart_type,
        pageId: getDashboardChartPageId(dc.layout),
        pageName: pageNameById.get(getDashboardChartPageId(dc.layout)) || undefined,
        layout: {
          x: Number(dc.layout?.x ?? 0),
          y: Number(dc.layout?.y ?? 0),
          w: Number(dc.layout?.w ?? 12),
          h: Number(dc.layout?.h ?? 6),
        },
      }));
  }, [dashboard?.dashboard_charts, dashboard?.name, dashboardPages, t]);

  const doExportPdf = useCallback(async (choices: ExportPdfChoices) => {
    if (!dashboard) return;
    if (choices.fileType === 'pptx') {
      // Editable PowerPoint of the report as the author sees it.
      setIsExportingPdf(true);
      setExportRenderMode('snapshot');
      setExportProgress({ phase: 'prepare', ratio: 0, message: t('dashboards.export.exportPptx') });
      const originalPageId = activePageId;
      try {
        const { exportDashboardPptx } = await import('@/lib/export-pptx');
        const chosen = dashboardPages.filter((p) => choices.pageIds.includes(p.id));
        await exportDashboardPptx({
          title: dashboard.name || 'Dashboard',
          subtitle: dashboard.description ?? null,
          footer: dashboard.name || null,
          gridCols: DASHBOARD_GRID_COLS,
          filename: `${safePdfFilename(dashboard.name, 'dashboard')}.pptx`,
          send: async (payload) => {
            const res = await apiClient.post(`/dashboards/${dashboardId}/export-pptx`, payload, { responseType: 'blob' });
            return res.data as Blob;
          },
          onProgress: (ratio, message) => setExportProgress({ phase: 'capture', ratio, message: message || t('dashboards.export.exportPptx') }),
          pages: chosen.map((p) => ({
            name: p.name,
            tiles: (dashboard?.dashboard_charts ?? [])
              .filter((dc: any) => getDashboardChartPageId(dc.layout) === p.id)
              .map((dc: any) => {
                const l = resolveDashboardChartLayout(dc.id, localLayoutOverridesRef.current) as Record<string, any>;
                return {
                  id: dc.id,
                  layout: { x: Number(l?.x) || 0, y: Number(l?.y) || 0, w: Number(l?.w) || DASHBOARD_GRID_COLS, h: Number(l?.h) || 6 },
                  chartType: dc.chart?.chart_type ?? null,
                  widgetType: dc.widget_type ?? null,
                  title: l?.custom_title || dc.chart?.name || null,
                };
              }),
            getRoot: async () => {
              setCurrentPageId(p.id);
              await new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 250)));
              });
              return dashboardContentRef.current;
            },
          })),
        });
        setIsExportDialogOpen(false);
        toast.success(t('dashboards.export.pptxDone'), { id: 'report-export' });
      } catch (err) {
        console.error('PowerPoint export failed', err);
        toast.error(t('dashboards.export.pptxFailed'), { id: 'report-export' });
      } finally {
        setCurrentPageId(originalPageId);
        setIsExportingPdf(false);
        setExportRenderMode(false);
        setExportProgress(null);
      }
      return;
    }
    // Open the preview tab synchronously inside the click (see openPdfPreviewTab).
    const previewWindow = openPdfPreviewTab();
    setIsExportingPdf(true);
    setExportRenderMode(choices.layout === 'snapshot' ? 'snapshot' : 'full');
    setExportProgress({ phase: 'prepare', ratio: 0, message: t('dashboards.detail.exportPreparing') });
    const originalPageId = activePageId;
    try {
      const { exportDashboardPdf } = await import('@/lib/export-pdf');
      const safeName = safePdfFilename(dashboard.name, 'dashboard');
      const chosen = dashboardPages.filter((p) => choices.pageIds.includes(p.id));
      const result = await exportDashboardPdf({
        description: dashboard.description ?? null,
        locale,
        labels: {
          filters: t('dashboards.pdf.filters'),
          exportedAt: t('dashboards.pdf.exportedAt'),
          dataAsOf: t('dashboards.pdf.dataAsOf'),
          snapshotNote: t('dashboards.pdf.snapshotNote'),
        },
        previewWindow,
        filename: `${safeName}.pdf`,
        title: dashboard.name || 'Dashboard',
        orientation: choices.orientation,
        format: choices.format,
        layout: choices.layout,
        // "Arrange it yourself": the arranged plan IS the export. It used to be
        // dropped here, so the builder silently printed the normal layout.
        plan: choices.plan,
        onProgress: setExportProgress,
        pages: chosen.map((p) => ({
          name: p.name,
          filtersSummary: summarizeAppliedFilters(p),
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
          id: 'report-export',
          description: t('dashboards.detail.pdfPopupBlocked'),
        });
      }
    } catch (err) {
      console.error('PDF export failed', err);
      try { previewWindow?.close(); } catch { /* noop */ }
      toast.error(t('dashboards.detail.exportFailed'), { id: 'report-export' });
    } finally {
      setCurrentPageId(originalPageId);
      setIsExportingPdf(false);
      setExportRenderMode(false);
      setExportProgress(null);
    }
  }, [dashboard, dashboardPages, activePageId, summarizeAppliedFilters, t]);

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

  // Titles of the visuals selected for AI Design — the panel's scope strip.
  const selectionNames = designMode === 'ai'
    ? selectedTileIds
        .map((id) => visibleDashboardCharts.find((c) => c.id === id))
        .filter(Boolean)
        .map((dc) => String(dc!.layout?.custom_title || dc!.chart?.name || t('dashboards.detail.chartFallbackName', { id: dc!.id })))
    : [];
  const lockedTileCount = visibleDashboardCharts.filter((dc) => (dc.layout as any)?.locked === true).length;

  return (
    <DashboardThemeProvider theme={previewTheme} className="min-h-full bg-surface-2">
      {/* ── Sticky compact header (single row) ── */}
      {!studioPreview && (
      <div ref={builderHeaderRef} className="sticky top-0 z-20 bg-surface-2 px-4 pt-3 pb-2 sm:px-6 lg:px-8">
        <div className="rounded-xl border border-[rgba(255,255,255,0.08)] bg-surface-1 shadow-linear-sm overflow-visible">

          {/* One row when it fits; when the draft actions and the tools do not
              fit beside the name, the tools wrap to a second row instead of
              drawing over each other. */}
          <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-1.5">
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
            <div className="flex min-w-fit flex-1 items-center gap-2">
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
                  {/* The report's name keeps its room: the toolbar's status and
                      actions used to squeeze it to "I…" while a draft was open. */}
                  <h1 className="min-w-[5rem] max-w-[18rem] shrink-0 truncate text-[14px] font-[590] tracking-[-0.182px] text-text-primary" title={dashboard.name}>
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
                    <div className="relative shrink-0">
                      <button
                        type="button"
                        data-testid="builder-pages-menu"
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
                                      data-testid={`builder-page-${page.id}`}
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
                      <span className="hidden text-text-quaternary 2xl:inline">·</span>
                      {/* Wide screens only: the description is edited in the Inspector
                          and stated by the report header, not squeezed in here. */}
                      <span className="hidden min-w-0 max-w-[22rem] truncate text-[13px] font-[400] text-text-tertiary 2xl:inline" title={dashboard.description}>
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
                        disabled={!canUndo || isCommittingPresentation}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] disabled:opacity-40"
                        title={t('dashboards.detail.undo')}
                      >
                        <Undo2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={doRedo}
                        disabled={!canRedo || isCommittingPresentation}
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
                          hasUnsavedPresentation
                            ? 'bg-warning/20 text-warning'
                            : 'bg-warning/10 text-warning'
                        }`}
                        title={
                          hasUnsavedPresentation
                            ? t('dashboards.detail.unsavedTooltip')
                            : t('dashboards.detail.draftTooltip')
                        }
                      >
                        {hasUnsavedPresentation ? t('dashboards.detail.badgeUnsaved') : t('dashboards.detail.badgeDraft')}
                      </span>
                      <button
                        type="button"
                        onClick={handleSaveDraft}
                        data-testid="dashboard-save-draft"
                        data-state={isStagingDraft ? 'saving' : hasUnsavedPresentation ? 'unsaved' : 'saved'}
                        disabled={
                          !hasUnsavedPresentation
                          || isStagingDraft
                          || isCommittingPresentation
                          || updateDraftLayoutMutation.isPending
                        }
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-2.5 text-[12px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] disabled:opacity-50"
                        title={t('dashboards.detail.saveDraftTooltip')}
                      >
                        {isStagingDraft || updateDraftLayoutMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        {t('dashboards.detail.saveDraft')}
                        <kbd className="ml-1 hidden rounded bg-[rgba(255,255,255,0.08)] px-1 text-[9px] text-text-tertiary sm:inline">⌘S</kbd>
                      </button>
                      <button
                        type="button"
                        onClick={handlePublish}
                        data-testid="dashboard-publish"
                        disabled={
                          publishDashboardMutation.isPending
                          || isStagingDraft
                          || isCommittingPresentation
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
                        data-testid="dashboard-discard"
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
            <div className="ml-auto flex shrink-0 items-center gap-1">
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
                  data-testid="dashboard-more"
                  onClick={() => { setIsMoreMenuOpen((v) => !v); setIsFilterPopoverOpen(false); setIsPagesMenuOpen(false); }}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)]"
                  title={t('dashboards.detail.moreOptions')}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>

                {isMoreMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => { setIsMoreMenuOpen(false); }} />
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
                            data-testid="dashboard-open-public-links"
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

                          {(
                            <button
                              onClick={() => { handleTidyLayout(); setIsMoreMenuOpen(false); }}
                              className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                              title={t('dashboards.detail.tidyTooltip')}
                            >
                              <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                              {t('dashboards.detail.tidyLayout')}
                            </button>
                          )}

                          {(
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

                          {/* Adding content: the same palette as the toolbar's Add. */}
                          <div className="mx-3 my-1 border-t border-[rgba(255,255,255,0.06)]" />
                          <button
                            onClick={() => { setIsMoreMenuOpen(false); setIsAddElementOpen(true); }}
                            className="flex w-full items-center gap-2.5 px-3 py-2 text-[13px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.04)] hover:text-text-primary"
                          >
                            <Plus className="h-3.5 w-3.5 shrink-0 text-text-quaternary" />
                            <span className="flex-1 text-left">{t('dashboards.detail.addWidget')}</span>
                          </button>
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
              {(
                <button
                  type="button"
                  data-testid="studio-preview-open"
                  onClick={() => setStudioOpen(true)}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] px-2 text-[12px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.06)] hover:text-text-primary"
                  title={t('dashboards.studio.openFull')}
                >
                  <Eye className="h-3 w-3" />
                  {t('dashboards.studio.open')}
                </button>
              )}
              {canEditThisPage && (
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
                        data-testid={`design-mode-${mode}`}
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
                  type="button"
                  data-testid="add-slicer-open"
                  onClick={() => setIsAddSlicerOpen(true)}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] px-2.5 text-[12px] font-[510] text-text-secondary transition-colors hover:bg-[rgba(255,255,255,0.06)] hover:text-text-primary"
                  title={t('dashboards.addSlicer.title')}
                >
                  <Filter className="h-3 w-3" />
                  <span>{t('dashboards.addSlicer.menu')}</span>
                  {unplacedControlFilters.length > 0 && (
                    <span
                      data-testid="add-slicer-unplaced-count"
                      className="rounded-full bg-brand/15 px-1.5 text-[10px] font-semibold text-brand"
                      title={t('dashboards.addSlicer.unplacedBadge', { count: unplacedControlFilters.length })}
                    >
                      {unplacedControlFilters.length}
                    </span>
                  )}
                </button>
              )}
              {canEditThisPage && (
                <div className="relative">
                  <button
                    type="button"
                    data-testid="add-element-open"
                    aria-haspopup="dialog"
                    aria-expanded={isAddElementOpen}
                    onClick={() => setIsAddElementOpen((v) => !v)}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md bg-brand px-2.5 text-[12px] font-[510] text-white shadow-sm transition-colors hover:bg-brand-hover"
                  >
                    <Plus className="h-3 w-3" />
                    <span>{t('dashboards.addElement.open')}</span>
                  </button>
                  <AddElementMenu
                    open={isAddElementOpen}
                    onClose={() => setIsAddElementOpen(false)}
                    insertionLabel={selectedTileIds.length === 1
                      ? t('dashboards.addElement.insertAfter', { title: tileTitle(selectedTileIds[0]) })
                      : t('dashboards.addElement.insertEnd')}
                    onPick={(kind) => {
                      if (kind === 'chart') openAddChartUnderSelection();
                      else if (kind === 'slicer') setIsAddSlicerOpen(true);
                      else void handleAddWidget(kind);
                    }}
                  />
                </div>
              )}
              {canEditThisPage && designMode === 'manual' && (
                <button
                  type="button"
                  data-testid="inspector-toggle"
                  aria-pressed={inspectorOpen}
                  onClick={() => setInspectorOpen((v) => !v)}
                  title={t('dashboards.inspector.openHint')}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-[510] transition-colors ${inspectorOpen ? 'border-brand/50 bg-brand/10 text-brand' : 'border-[rgb(var(--border-line))] text-text-secondary hover:bg-surface-2 hover:text-text-primary'}`}
                >
                  <PanelRight className="h-3.5 w-3.5" />
                  <span className="hidden xl:inline">{t('dashboards.inspector.title')}</span>
                </button>
              )}
            </div>
          </div>

          {/* Row 2 (pages) merged into title dropdown; Row 3 (filter) merged into header Filter popover. */}
        </div>
      </div>
      )}

      {/* ── Content area ──
          Phase-15.81 — when the FilterPane is open we render a 2-column
          shell: [Canvas | FilterPane]. Picking a field happens inside
          each FilterPane section's "+ Add filter" picker — no separate
          FieldList sidebar (DA: long mouse travel was annoying). */}
      {/* The content row goes side-by-side only when something is docked to the
          right of the grid. Without this the dock renders as a full-width block
          BELOW the report — which is what the AI panel did on first wiring: it
          was in the DOM, 380px wide, and 2000px down the page. */}
      <div className={`px-4 pb-8 sm:px-6 lg:px-8 ${rightDocked ? 'flex gap-3 items-stretch min-h-[calc(100vh-12rem)]' : ''}`}>

        <div className={rightDocked ? 'min-w-0 flex-1' : 'w-full'}>
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

        {/* The report is ONE grid. Filter controls are elements of it; this
            scope only hands each control its filter state — it draws nothing,
            so there is no filter area outside the grid. */}
        <div className="relative">
          <SlicerControlScope
            // Editor resolves ALL slicers (incl. ones a 'custom' scope hides on
            // this page) so the author sees why a placed control is dimmed; the
            // per-page VISIBLE hiding is applied only on the public viewer.
            // The chart PREVIEW still respects scope via effectivePageScopeFilters
            // (only slicers that filter the active page are applied).
            slicers={controlFilters}
            siblingFilters={controlFilters}
            visibleHere={controlVisibleHere}
            filtersHere={controlFiltersHere}
            editing={canEditThisPage}
            onChange={handleControlChange}
            stagedIds={stagedControlIds}
            onApply={() => handleApplyFilters('all')}
            onTreatmentChange={canEditThisPage ? handleSlicerTreatmentChange : undefined}
            onRemoveControl={canEditThisPage ? (id: number) => { void removeSlicerControlRef.current(id); } : undefined}
            onDeleteFilter={canEditResource ? handleDeleteSlicerFilter : undefined}
            onToggleLock={canEditThisPage ? handleToggleTileLock : undefined}
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
          >

        <div
          ref={dashboardContentRef}
          className="min-w-0"
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
        {/* Device layouts: Desktop is the authored layout; Tablet and Phone are
            AUTO (derived from desktop) until customised. The canvas renders at
            the device's representative width; the resolver decides the layout. */}
        {!studioPreview && !isExportingPdf && (
          <div data-testid="device-bar" className="mb-2 flex flex-wrap items-center gap-2 text-[12.5px]">
            <div className="inline-flex rounded-md border border-[rgb(var(--border-line))] bg-surface-1 p-0.5" role="group" aria-label={t('dashboards.device.label')}>
              {(['desktop', 'tablet', 'phone'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  data-testid={`device-mode-${m}`}
                  aria-pressed={deviceMode === m}
                  onClick={() => setDeviceMode(m)}
                  className={`rounded px-2.5 py-1 font-medium transition-colors ${deviceMode === m ? 'bg-brand/15 text-brand' : 'text-text-tertiary hover:text-text-secondary'}`}
                >
                  {t(`dashboards.device.${m}`)}
                </button>
              ))}
            </div>
            {deviceBreakpoint && deviceSummary?.breakpoint === deviceBreakpoint && (
              deviceSummary.source === 'custom' ? (
                <>
                  <span data-testid="device-status-custom" className="rounded bg-brand/10 px-2 py-0.5 font-medium text-brand">{t('dashboards.device.custom')}</span>
                  {deviceSummary.stale && (
                    <span data-testid="device-status-stale" className="text-warning">{t('dashboards.device.stale')}</span>
                  )}
                  {deviceSummary.orphans.length > 0 && (
                    <span data-testid="device-status-needs-review" className="text-warning">
                      {t('dashboards.device.needsReview', { n: deviceSummary.orphans.length })}
                    </span>
                  )}
                  {canEditThisPage && (
                    <>
                      {deviceSummary.orphans.length > 0 && (
                        <button type="button" data-testid="device-add-below" onClick={handleAddOrphansBelow} className="rounded-md border border-[rgb(var(--border-line))] px-2 py-0.5 text-text-secondary hover:text-text-primary">
                          {t('dashboards.device.addBelow')}
                        </button>
                      )}
                      <button type="button" data-testid="device-fit-heights" onClick={handleFitDeviceHeights} className="rounded-md border border-[rgb(var(--border-line))] px-2 py-0.5 text-text-secondary hover:text-text-primary">
                        {t('dashboards.device.fitHeights')}
                      </button>
                      <button type="button" data-testid="device-regenerate" onClick={handleRegenerateDevice} className="rounded-md border border-[rgb(var(--border-line))] px-2 py-0.5 text-text-secondary hover:text-text-primary">
                        {t('dashboards.device.regenerate')}
                      </button>
                      <button type="button" data-testid="device-reset" onClick={handleResetDevice} className="rounded-md border border-[rgb(var(--border-line))] px-2 py-0.5 text-text-secondary hover:text-text-primary">
                        {t('dashboards.device.reset')}
                      </button>
                    </>
                  )}
                </>
              ) : (
                <>
                  <span data-testid="device-status-auto" className="rounded bg-surface-2 px-2 py-0.5 font-medium text-text-secondary">{t('dashboards.device.auto')}</span>
                  {canEditThisPage && (
                    <button type="button" data-testid="device-customize" onClick={handleCustomizeDevice} className="rounded-md bg-brand px-2.5 py-0.5 font-medium text-white hover:opacity-90">
                      {t('dashboards.device.customize')}
                    </button>
                  )}
                </>
              )
            )}
          </div>
        )}
        {designMode === 'manual' && canEditThisPage && !isExportingPdf && deviceMode === 'desktop' && (
          <ArrangeBar
            count={selectedTileIds.length}
            onArrange={handleArrange}
            onClear={clearTileSelection}
            onFrame={selectedChartIds.length > 0 ? handleFrame : undefined}
            frame={selectedFrame}
          />
        )}
        <div
          ref={canvasRootRef}
          data-dashboard-canvas-root="builder"
          // A click on empty canvas (not on an element, a control or a menu) clears the selection.
          onClick={(e) => {
            const target = e.target as HTMLElement;
            if (selectedTileIds.length === 0 || target.closest('[data-grid-item-id], button, input, select, textarea, a, [role="menu"], [role="dialog"]')) return;
            clearTileSelection();
          }}
        >
        {(
          <ReportMetaProvider value={reportMeta}>
          {/* A device canvas renders at that device's representative width (its
              report container IS that wide): the layout drawn is the one a
              viewer at that width gets. */}
          <div
            data-device-frame={deviceMode}
            style={deviceBreakpoint && !studioPreview ? { width: STUDIO_DEVICE_WIDTH[deviceMode], margin: '0 auto' } : undefined}
          >
          <DashboardGrid
            dashboardId={dashboardId}
            dashboardCharts={visibleDashboardCharts}
            editorDesktop={deviceMode === 'desktop' && !studioPreview}
            deviceProfiles={pageDeviceProfiles}
            onDeviceLayoutChange={canEditThisPage && deviceBreakpoint && !studioPreview ? handleDeviceLayoutChange : undefined}
            onResolved={setDeviceSummary}
            resolvedRef={resolvedLayoutRef}
            measureRef={deviceMeasureRef}
            // In the Studio preview iframe, an IntersectionObserver measures
            // against the TOP-level viewport, so tiles in the part of the frame
            // scrolled out of the overlay would never mount. The preview is a
            // whole-report view: every tile renders.
            disableLazy={studioPreview}
            publicProjection={studioPreview}
            canEdit={canEditThisPage}
            allowAppearanceEdit={canEditThisPage}
            themeConfig={dashboard?.theme_config}
            onLayoutChange={canEditThisPage ? handleGridGesture : undefined}
            layoutRevision={gridRevision}
            presenceByChart={presenceByChart}
            onRemoveChart={canEditThisPage ? handleRemoveChart : undefined}
            // Manual builder: the Inspector. In AI Design (no Inspector) the editor dialog.
            onEditWidget={canEditThisPage ? (designMode === 'manual' ? openInspectorFor : setEditingWidgetId) : undefined}
            onOpenInspector={canEditThisPage && designMode === 'manual' ? openInspectorFor : undefined}
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
            emptyMessage={canEditThisPage && designMode === 'manual' ? t('dashboards.start.message') : emptyPageMessage}
            emptyActions={canEditThisPage && designMode === 'manual' ? (
              // A blank report's guided start: the three moves a report is made of,
              // each the same action as the Add palette.
              <ol className="mt-2 grid w-full max-w-2xl gap-2 text-left sm:grid-cols-3" data-testid="report-start">
                {([
                  { n: 1, key: 'header', run: () => void handleAddWidget('hero_strip') },
                  { n: 2, key: 'charts', run: () => openAddChartUnderSelection() },
                  { n: 3, key: 'section', run: () => void handleAddWidget('section_header') },
                ] as const).map((s) => (
                  <li key={s.key}>
                    <button
                      type="button"
                      data-testid={`report-start-${s.key}`}
                      onClick={s.run}
                      className="flex h-full w-full flex-col gap-1 rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 px-3.5 py-3 text-left shadow-linear-sm transition-colors hover:border-brand/40 hover:bg-brand/5"
                    >
                      <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-brand">{t('dashboards.start.step', { n: s.n })}</span>
                      <span className="text-[13px] font-[590] text-text-primary">{t(`dashboards.start.${s.key}`)}</span>
                      <span className="text-[11.5px] leading-snug text-text-tertiary">{t(`dashboards.start.${s.key}Desc`)}</span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : undefined}
            focusedDashboardChartId={focusedTileId}
            // One selection model for both modes: AI Design scopes to it, the
            // manual Arrange tools and the keyboard act on it.
            selectedDashboardChartIds={selectedTileIds}
            onFocusChart={handleTileFocus}
            renderSlicerControl={renderBuilderSlicerControl}
            aiDesignMode={designMode === 'ai'}
            onToggleLock={canEditThisPage ? handleToggleTileLock : undefined}
            onPatchLayout={canEditThisPage ? handlePatchTileLayout : undefined}
            getPersistedLayout={getPersistedLayout}
            params={paramValues}
            onParamChange={handleParamChange}
            onBindParameter={canEditThisPage ? setBindingChartId : undefined}
          />
          </div>
          </ReportMetaProvider>
        )}
        </div>
        </ExportModeContext.Provider>
        {/* Controls placed on the grid stage their choice exactly like the bar;
            this is the one Apply for all of them. */}
        <FilterApplyBar
          visible={placedSlicerIdsOnPage.size > 0 && hasPendingSlicerChanges && !isExportingPdf && !studioPreview}
          isApplying={isApplyingFilters}
          onApply={() => handleApplyFilters('all')}
          count={stagedControlIds.size}
          onReset={() => {
            setDraftGlobalSlicers(appliedGlobalSlicers);
            setDraftPageSlicers(activePageSlicers);
            setDraftSlicerClusterLayout(appliedSlicerClusterLayout);
          }}
        />
        </div>
          </SlicerControlScope>
        </div>{/* /report grid + its filter controls */}
        <AddSlicerModal
          open={isAddSlicerOpen}
          onClose={() => setIsAddSlicerOpen(false)}
          existing={unplacedControlFilters}
          columns={addSlicerColumns}
          busy={isPlacingSlicer}
          onPlaceExisting={(slicer, where) => { void handleAddSlicer({ existing: [slicer], where }); }}
          onPlaceAll={(where) => { void handleAddSlicer({ existing: unplacedControlFilters, where }); }}
          onCreate={(column, where) => { void handleAddSlicer({ column, where }); }}
          besideName={selectedTileIds.length === 1 ? tileTitle(selectedTileIds[0]) : null}
        />

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
        {studioOpen && !studioPreview && (
          <StudioPreview
            dashboardId={Number(dashboardId)}
            before={studioBefore}
            after={studioAfter}
            hasPending={Boolean(aiDesign.pending)}
            onApply={() => { aiDesign.apply(); setStudioOpen(false); }}
            onDiscard={() => { aiDesign.discard(); setStudioOpen(false); }}
            onClose={() => setStudioOpen(false)}
          />
        )}
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
          <div className="fixed right-3 bottom-3 z-30 w-[380px] max-w-[calc(100vw-1.5rem)] shadow-xl rounded-xl" style={{ top: builderHeaderH }}>
            <AiDesignPanel
              turns={aiDesign.turns}
              busy={aiDesign.busy}
              onSubmit={aiDesign.submit}
              onDirection={aiDesign.applyDirection}
              proposals={contentProposals}
              onDecideProposal={decideProposal}
              pendingDiff={aiDesign.pending?.diff ?? null}
              onApply={aiDesign.apply}
              onDiscard={aiDesign.discard}
              onPreview={() => setStudioOpen(true)}
              onCollapse={() => setAiPanelCollapsed(true)}
              onClose={() => { aiDesign.discard(); setDesignMode('manual'); }}
              visualCount={aiDesign.visualCount}
              pageName={currentPage?.name ?? activePageId}
              selectionNames={selectionNames}
              onClearSelection={clearTileSelection}
              lockedCount={lockedTileCount}
            />
          </div>
        ))}

        {/* Right dock: Filter Pane (Phase-15.81). Sticky alongside the
            canvas; sections own visual / page / all-pages scope. */}
        {inspectorShown && inspectorStructure && dashboard && (
          <aside
            className="fixed bottom-0 right-0 z-40 w-[320px] max-w-[92vw] shadow-xl lg:sticky lg:z-auto lg:flex lg:flex-shrink-0 lg:self-start lg:overflow-hidden lg:rounded-lg lg:border lg:border-[rgb(var(--border-line))] lg:shadow-none"
            style={{ top: builderHeaderH + 8, height: `calc(100vh - ${builderHeaderH + 16}px)` }}
          >
            <ReportInspector
              onClose={() => setInspectorOpen(false)}
              dashboardId={dashboardId}
              report={{ name: dashboard.name, description: dashboard.description ?? null }}
              selected={selectedTileIds
                .map((id) => visibleDashboardCharts.find((d) => d.id === id))
                .filter((d): d is NonNullable<typeof d> => Boolean(d))
                .map((d) => ({ ...d, layout: resolveDashboardChartLayout(d.id, localLayoutOverridesRef.current) as Record<string, any> }))}
              structure={inspectorStructure}
              titleOf={tileTitle}
              onSelect={(id) => { setSelectedTileIds([id]); setFocusedTileId(id); }}
              onGeometry={handleInspectorGeometry}
              onPatchLayout={handlePatchTileLayout}
              onMoveToSection={handleMoveToSection}
              onSaveWidgetConfig={handleSaveWidgetConfig}
              onSaveReport={handleSaveReportDetails}
              onReportDirtyChange={setReportDetailsDirty}
              onPattern={handleInspectorPattern}
              onFitToContent={handleFitToContent}
              onFrame={handleFrame}
              frame={selectedFrame}
              pendingSave={pendingContentSaveRef}
            />
          </aside>
        )}
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
          onClose={() => {
            setIsAddChartModalOpen(false);
            if (insertBatchRef.current) { insertBatchRef.current.closed = true; setInsertBatchTick((n) => n + 1); }
          }}
          onAdd={handleAddChart}
          dashboardCharts={dashboard.dashboard_charts ?? []}
          dashboardDatasetIds={dashboardDatasetIds}
          pages={dashboardPages}
          activePageId={activePageId}
          isAdding={addChartMutation.isPending}
          currentPageName={currentPage?.name}
          placementNote={isAddChartModalOpen && insertBatchRef.current
            ? t('dashboards.addElement.insertAfter', { title: tileTitle(insertBatchRef.current.anchorId) })
            : undefined}
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

        {/* Co-authoring — the shared filters/pages/theme draft holds another
            author's edits: the author decides, with names, what happens to them. */}
        {sharedChoice && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" data-testid="shared-draft-choice">
            <div className="w-full max-w-sm rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4 shadow-linear-lg">
              <h2 className="text-sm font-semibold text-text-primary">{t('dashboards.detail.sharedChoice.title')}</h2>
              <p className="mt-1.5 text-[13px] leading-5 text-text-secondary">
                {t('dashboards.detail.sharedChoice.body', { authors: sharedChoice.authors.join(', ') })}
              </p>
              <div className="mt-3 flex flex-col gap-2">
                <button
                  type="button"
                  data-testid="shared-draft-mine"
                  onClick={() => { void resolveSharedChoice(false); }}
                  className="rounded-md bg-brand px-3 py-1.5 text-left text-[13px] font-medium text-white hover:opacity-90"
                >
                  {t(sharedChoice.action === 'publish' ? 'dashboards.detail.sharedChoice.publishMine' : 'dashboards.detail.sharedChoice.discardMine')}
                </button>
                <button
                  type="button"
                  data-testid="shared-draft-all"
                  onClick={() => { void resolveSharedChoice(true); }}
                  className="rounded-md border border-[rgb(var(--border-strong))] px-3 py-1.5 text-left text-[13px] font-medium text-text-primary hover:bg-surface-2"
                >
                  {t(sharedChoice.action === 'publish' ? 'dashboards.detail.sharedChoice.publishAll' : 'dashboards.detail.sharedChoice.discardAll', { authors: sharedChoice.authors.join(', ') })}
                </button>
                <button
                  type="button"
                  onClick={() => setSharedChoice(null)}
                  className="self-end rounded-md px-2.5 py-1.5 text-[13px] text-text-tertiary hover:text-text-primary"
                >
                  {t('dashboards.detail.conflictLater')}
                </button>
              </div>
            </div>
          </div>
        )}
        {sharedStale && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" data-testid="shared-draft-stale">
            <div className="w-full max-w-sm rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 p-4 shadow-linear-lg">
              <h2 className="text-sm font-semibold text-text-primary">{t('dashboards.detail.sharedStale.title')}</h2>
              <p className="mt-1.5 text-[13px] leading-5 text-text-secondary">
                {t('dashboards.detail.sharedStale.body', { editor: sharedStale.by || t('dashboards.detail.someoneElse') })}
              </p>
              <div className="mt-3 flex items-center justify-end gap-2">
                <button type="button" onClick={() => setSharedStale(null)} className="rounded-md px-2.5 py-1.5 text-[13px] text-text-tertiary hover:text-text-primary">
                  {t('dashboards.detail.conflictLater')}
                </button>
                <button type="button" onClick={() => window.location.reload()} className="rounded-md bg-brand px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90">
                  {t('dashboards.detail.conflictReload')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Phase-B17 — publish conflict: someone else published since load. */}
        {publishConflict && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" data-testid="publish-conflict">
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
          defaultPageId={activePageId}
          planCandidates={exportPlanCandidates}
          planPages={dashboardPages.map((p) => ({ id: p.id, name: p.name }))}
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
          // Removing a slicer CONTROL is not removing a filter: say what stays.
          {...(slicerIdOfControl(dashboard?.dashboard_charts?.find((dc) => dc.id === pendingRemoveDashboardChartId))
            ? { title: t('dashboards.slicerControl.removeTitle'), description: t('dashboards.slicerControl.removeBody') }
            : { title: 'Remove chart from dashboard?', description: 'This will remove the chart tile from the dashboard. The chart itself will not be deleted.' })}
          confirmLabel="Remove"
          variant="danger"
        />

        {/* Phase-15.66 — Confirm discard: clears BOTH local draft state
            AND any saved-but-not-published BE draft. */}
        <ConfirmDialog
          isOpen={isDiscardConfirmOpen}
          onClose={() => setIsDiscardConfirmOpen(false)}
          onConfirm={handleDiscardAll}
          title={t('dashboards.detail.discardConfirmTitle')}
          description={t('dashboards.detail.discardConfirmBody')}
          confirmLabel={t('dashboards.detail.discardConfirmOk')}
          cancelLabel={t('dashboards.detail.discardConfirmCancel')}
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
              // The theme is presentation only: filters are controls on the grid,
              // so there is no filter position for a template to change.
              await applyThemeConfig(theme);
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
                  // Filters are grid elements now; a slicer's place is its control's tile.
    slicerDock: 'grid',
                });
                // Layout only. Picking a template in the modal already applies
                // its colours through the theme path; re-applying them here
                // would repaint every page as a side effect of a layout button.
                const plan = planFromTemplate(templateId, snapshot);
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

/** The page provides the report's evidence store so the AI Design panel can
 *  read the findings the tiles below are showing. */
export default function DashboardDetailPage() {
  return (
    <ReportEvidenceProvider>
      <DashboardDetailPageInner />
    </ReportEvidenceProvider>
  );
}
