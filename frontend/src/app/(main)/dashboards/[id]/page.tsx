'use client';

import React, { useState, useCallback } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
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
import { DashboardFilterBar } from '@/components/dashboards/DashboardFilterBar';
import { DashboardChartLayout, DashboardPageConfig } from '@/types/api';
import type { BaseFilter, ColumnInfo, FilterType } from '@/lib/filters';
import {
  collectJoinKeySemanticFields,
  getColumnDisplayLabel,
  getDistinctValueFilterContext,
  getFilterDisplayLabel,
  getFriendlyFieldLabel,
  getColumnKey,
  getFilterKey,
  inferColumnTypeFromData,
  isSemanticDimensionFilterableForDashboard,
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

// Debounce utility
function useDebounce<T extends (...args: any[]) => any>(
  callback: T,
  delay: number
): (...args: Parameters<T>) => void {
  const [timeoutId, setTimeoutId] = useState<NodeJS.Timeout | null>(null);

  return useCallback(
    (...args: Parameters<T>) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      const id = setTimeout(() => callback(...args), delay);
      setTimeoutId(id);
    },
    [callback, delay, timeoutId]
  );
}

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

function normalizeLegacyDateFilter(filter: BaseFilter, dateColumn: ColumnInfo | null): BaseFilter {
  const dateColumnKey = dateColumn ? getColumnKey(dateColumn) : null;
  const semanticField = String(filter.semanticField ?? '').trim();
  const fieldKey = String(filter.fieldKey ?? '').trim();
  const fieldName = String(filter.field ?? '').trim().toLowerCase();
  const isLegacyDateFilter = (
    filter.type === 'date'
    && fieldName === 'date'
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

export default function DashboardDetailPage() {
  const params = useParams();
  const router = useRouter();
  const dashboardId = Number(params.id);

  const [isAddChartModalOpen, setIsAddChartModalOpen] = useState(false);
  const [isHtmlImportOpen, setIsHtmlImportOpen] = useState(false);
  const [isChartManagerOpen, setIsChartManagerOpen] = useState(false);
  const [removingChartId, setRemovingChartId] = useState<number | undefined>();
  const [pendingRemoveDashboardChartId, setPendingRemoveDashboardChartId] = useState<number | undefined>();
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState('');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [draftGlobalFilters, setDraftGlobalFilters] = useState<BaseFilter[]>([]);
  const [appliedGlobalFilters, setAppliedGlobalFilters] = useState<BaseFilter[]>([]);
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
  const [isFilterPopoverOpen, setIsFilterPopoverOpen] = useState(false);
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
  // Phase-15.56 — apply draft_layouts overlay on top of the live
  // dashboard_charts so the editor renders the pending layout. Public
  // viewers go through a different endpoint and never see this overlay.
  const dashboard = React.useMemo(() => {
    if (!serverDashboard) return serverDashboard;
    const drafts = serverDashboard.draft_layouts;
    if (!drafts || Object.keys(drafts).length === 0) return serverDashboard;
    return {
      ...serverDashboard,
      dashboard_charts: serverDashboard.dashboard_charts.map((dc) => {
        // BE sends draft_layouts keyed by dashboard_chart.id as a
        // string-number (JSON dict keys are always strings). Try both
        // forms so the override matches regardless of how the client
        // ended up coercing.
        const override = drafts[dc.id] ?? drafts[String(dc.id) as any];
        return override ? { ...dc, layout: { ...dc.layout, ...override } } : dc;
      }),
    };
  }, [serverDashboard]);

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

  const hasPendingFilterChanges = React.useMemo(
    () => JSON.stringify(draftGlobalFilters) !== JSON.stringify(appliedGlobalFilters),
    [draftGlobalFilters, appliedGlobalFilters],
  );

  React.useEffect(() => {
    if (currentPageId !== activePageId) {
      setCurrentPageId(activePageId);
    }
  }, [currentPageId, activePageId]);

  React.useEffect(() => {
    setLocalPagesConfig(null);
  }, [dashboard?.pages_config]);

  // Seed globalFilters from dashboard.filters_config once when dashboard first loads
  React.useEffect(() => {
    if (!dashboard || filtersSeededRef.current) return;
    filtersSeededRef.current = true;
    const initial: BaseFilter[] = Array.isArray(dashboard.filters_config) ? dashboard.filters_config as BaseFilter[] : [];
    filtersSnapshotRef.current = JSON.stringify(initial);
    setDraftGlobalFilters(initial);
    setAppliedGlobalFilters(initial);
  }, [dashboard]);

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
  // Filter changes are applied explicitly via the Apply action.
  //
  //
  //
  //
  //
        // silent — filters remain active in session even if save fails
  //
  //
  //
  //
  //
  //

  // Layout drafts (Phase-15.56). User can drag/resize freely; edits go
  // into draft_snapshot on the server (debounced 1s) instead of live
  // rows. Public viewers stay on the last-published layout. The "Lưu"
  // button in the toolbar calls /publish to copy draft -> live.
  const debouncedSaveLayout = useDebounce(
    async (layouts: Layout[]) => {
      if (!dashboard) return;

      const chartLayouts = layouts.map((item) => ({
        id: Number(item.i),
        layout: {
          ...(dashboard.dashboard_charts?.find((dashboardChart) => dashboardChart.id === Number(item.i))?.layout ?? {}),
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
        },
      }));

      try {
        await updateDraftLayoutMutation.mutateAsync({
          dashboardId,
          chartLayouts,
        });
      } catch (error) {
        console.error('Failed to save draft layout:', error);
      }
    },
    1000 // 1 second debounce
  );

  const handleLayoutChange = (newLayout: Layout[]) => {
    setHasUnsavedChanges(true);
    debouncedSaveLayout(newLayout);
  };

  // Canvas-mode layout updates: each entry carries pixel coords + z; we merge
  // them into the existing layout JSON (preserving grid coords for round-trip).
  const handleCanvasLayoutChange = useCallback(
    async (
      updates: Array<{ id: number; xPx: number; yPx: number; wPx: number; hPx: number; z: number }>,
    ) => {
      if (!dashboard) return;
      const chartLayouts = updates.map((u) => {
        const existing = dashboard.dashboard_charts?.find((dc) => dc.id === u.id)?.layout ?? {
          x: 0,
          y: 0,
          w: 4,
          h: 4,
        };
        return {
          id: u.id,
          layout: {
            ...existing,
            xPx: u.xPx,
            yPx: u.yPx,
            wPx: u.wPx,
            hPx: u.hPx,
            z: u.z,
          },
        };
      });
      setHasUnsavedChanges(true);
      try {
        // Phase-15.56 — Canvas drag goes into draft too.
        await updateDraftLayoutMutation.mutateAsync({ dashboardId, chartLayouts });
      } catch (err) {
        console.error('Failed to save canvas draft layout:', err);
      }
    },
    [dashboard, dashboardId, updateDraftLayoutMutation],
  );

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

  const handleApplyFilters = async () => {
    setAppliedGlobalFilters(draftGlobalFilters);
    if (!canEditResource) return;

    setIsApplyingFilters(true);
    try {
      await dashboardApi.update(dashboardId, { filters_config: draftGlobalFilters });
      filtersSnapshotRef.current = JSON.stringify(draftGlobalFilters);
    } catch (error) {
      console.error('Failed to save dashboard filters:', error);
      toast.error('Applied in this session, but failed to save dashboard filters.');
    } finally {
      setIsApplyingFilters(false);
    }
  };

  const handleResetFilters = () => {
    setDraftGlobalFilters(appliedGlobalFilters);
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
            type: semanticDimensionToFilterType(dimension.type),
            datasetId: binding.datasetId,
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
    const semanticFields = new Set<string>();
    const chartsWithDate = new Set<number>();
    const datasetIds = new Set<number>();

    // First pass: collect date/datetime dimension names from every dataset model.
    const dateDimensionFieldsByDataset = new Map<number, Set<string>>();
    for (const [datasetId, model] of datasetModelsById.entries()) {
      const dateFields = new Set<string>();
      for (const view of model.views ?? []) {
        for (const dim of view.dimensions ?? []) {
          const dimType = String(dim.type ?? '').toLowerCase();
          if (dimType === 'date' || dimType === 'datetime') {
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

      // Path A (legacy): explicit calendar mappings — keep so saved charts
      // that rely on a calendar table continue to be filterable.
      for (const mapping of binding?.calendarFieldMappings ?? []) {
        if (mapping?.calendarField !== 'date') continue;
        const sf = mapping.semanticField;
        if (typeof sf === 'string' && sf.includes('.')) {
          semanticFields.add(sf);
          chartHasDate = true;
        }
      }

      // Path B (new): any date/datetime semantic dimension that the chart
      // can already see — directly bound (dimensionFields/measureFields/
      // fieldMap values) or reachable via the explore join graph
      // (reachableFields). This lets a Date filter target charts that
      // don't go through a calendar table.
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
          if (dateFieldsForDataset.has(candidate)) {
            semanticFields.add(candidate);
            chartHasDate = true;
          }
        }
      }

      if (chartHasDate) {
        chartsWithDate.add(dashboardChart.chart_id);
      }
    }

    const orderedSemanticFields = Array.from(semanticFields).sort();
    if (orderedSemanticFields.length === 0) return [];

    const firstSemanticField = orderedSemanticFields[0];
    const [firstViewName] = firstSemanticField.split('.', 1);
    const firstDatasetId = datasetIds.size === 1 ? Array.from(datasetIds)[0] : undefined;
    const firstModel = firstDatasetId ? datasetModelsById.get(firstDatasetId) : undefined;
    const firstView = firstModel?.views.find((view) => view.name === firstViewName);

    return [{
      key: orderedSemanticFields[0],
      name: 'date',
      label: 'Date',
      tableLabel: firstView?.table_display_name ?? firstView?.name,
      type: 'date',
      semanticField: orderedSemanticFields[0],
      datasetId: firstDatasetId,
      defaultLinkedFields: orderedSemanticFields.slice(1),
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
    if (semanticColumnsResult.columns.length === 0 || draftGlobalFilters.length === 0) {
      return [];
    }

    const columnsByKey = new Map(
      semanticColumnsResult.columns.map((column) => [getColumnKey(column), column]),
    );
    const activeColumns = new Map<string, ColumnInfo>();

    for (const filter of draftGlobalFilters) {
      const key = getFilterKey(filter);
      const column = columnsByKey.get(key);
      if (!column?.datasetId || !column.semanticField) continue;
      if (column.type !== 'dropdown' && column.type !== 'text') continue;
      activeColumns.set(key, column);
    }

    return Array.from(activeColumns.values()).map((column) => {
      const filterContext = getDistinctValueFilterContext(draftGlobalFilters, column);
      return {
        column,
        filterContext,
        filterContextKey: JSON.stringify(filterContext),
      };
    });
  }, [draftGlobalFilters, semanticColumnsResult.columns]);

  const semanticDistinctQueries = useQueries({
    queries: activeSemanticDistinctTargets.map(({ column, filterContext, filterContextKey }) => ({
      queryKey: [...modelKeys.distinct(column.datasetId!, column.semanticField!), 'filters', filterContextKey],
      queryFn: () => fetchDatasetModelDistinctValues(column.datasetId!, column.semanticField!, 200, filterContext),
      enabled: Boolean(column.datasetId && column.semanticField),
      staleTime: 5 * 60 * 1000,
    })),
  });

  const semanticDistinctValues = React.useMemo(() => {
    const values: Record<string, string[]> = {};
    activeSemanticDistinctTargets.forEach(({ column }, index) => {
      values[getColumnKey(column)] = semanticDistinctQueries[index]?.data?.values ?? [];
    });
    return values;
  }, [activeSemanticDistinctTargets, semanticDistinctQueries]);

  const semanticFieldColumns = React.useMemo(
    () => semanticColumnsResult.columns.filter((column) => column.type !== 'date'),
    [semanticColumnsResult.columns],
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
                  {hasUnsavedChanges && (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-[510] text-text-quaternary">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span className="hidden sm:inline">Đang lưu nháp</span>
                    </span>
                  )}
                  {/* Phase-15.56 — draft / publish controls. Visible only
                      when the server reports a pending draft layout. */}
                  {canEditResource && dashboard?.has_draft && (
                    <div className="ml-2 flex shrink-0 items-center gap-1.5">
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-[600] uppercase tracking-wide text-warning"
                        title="Có thay đổi bố cục chưa xuất bản. Người xem qua share link vẫn thấy phiên bản cũ."
                      >
                        Bản nháp
                      </span>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await publishDashboardMutation.mutateAsync(dashboardId);
                            setHasUnsavedChanges(false);
                            toast.success('Đã xuất bản — share link cập nhật phiên bản mới.');
                          } catch (e) {
                            toast.error('Không xuất bản được — thử lại.');
                          }
                        }}
                        disabled={publishDashboardMutation.isPending}
                        className="inline-flex h-7 items-center gap-1 rounded-md bg-brand px-2.5 text-[12px] font-[510] text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
                        title="Áp dụng bản nháp lên public share link"
                      >
                        {publishDashboardMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        Lưu
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
              {/* Filter popover trigger */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => { setIsFilterPopoverOpen((v) => !v); setIsMoreMenuOpen(false); setIsPagesMenuOpen(false); }}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-md border border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-2 text-[12px] font-[510] transition-colors hover:bg-[rgba(255,255,255,0.04)] ${
                    appliedGlobalFilters.length > 0 ? 'text-brand' : 'text-text-secondary'
                  }`}
                  title="Filters"
                >
                  <Filter className="h-3 w-3" />
                  {appliedGlobalFilters.length > 0 && (
                    <span className="rounded-full bg-brand/20 px-1.5 text-[10px] font-[600] leading-[1.4] text-brand">
                      {appliedGlobalFilters.length}
                    </span>
                  )}
                  {hasPendingFilterChanges && (
                    <span className="h-1.5 w-1.5 rounded-full bg-warning" title="Unapplied changes" />
                  )}
                </button>
                {isFilterPopoverOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setIsFilterPopoverOpen(false)} />
                    <div className="absolute right-0 z-50 mt-1.5 w-[min(640px,92vw)] overflow-hidden rounded-lg border border-[rgba(255,255,255,0.12)] bg-surface-1 shadow-[0_4px_24px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,255,255,0.06)]">
                      {/*
                        Force the inner FilterCard grid to a single column inside this
                        popover. The component's default responsive grid (sm:2 / lg:3 /
                        xl:4) collapses cards to ~120px when the popover sits inside
                        a wide viewport, which makes long labels (e.g. "ngày") and
                        coverage badges ("16/30 charts") overlap.
                       */}
                      <div className="max-h-[70vh] overflow-y-auto p-2 [&_.grid]:!grid-cols-1">
                        <DashboardFilterBar
                          columns={resolvedAvailableColumns}
                          columnChartCount={resolvedColumnChartCount}
                          distinctValues={resolvedDistinctValues}
                          filters={draftGlobalFilters}
                          onFiltersChange={setDraftGlobalFilters}
                          hasPendingChanges={hasPendingFilterChanges}
                          onApply={handleApplyFilters}
                          onReset={handleResetFilters}
                          isApplying={isApplyingFilters}
                          initialExpanded={true}
                          embedded
                        />
                      </div>
                    </div>
                  </>
                )}
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

      {/* ── Content area ── */}
      <div className="px-4 pb-8 sm:px-6 lg:px-8">

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

        {/* Dashboard Grid or Canvas */}
        <div ref={dashboardContentRef}>
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
            globalFilters={appliedGlobalFilters}
            crossFilters={activeCrossFilter ? [activeCrossFilter] : []}
            crossFilterSourceChartId={crossFilterState?.sourceChartId ?? null}
            onChartDataLoaded={semanticColumnsResult.columns.length > 0 ? undefined : handleChartDataLoaded}
            onSelectCrossFilter={handleCrossFilterChange}
            availablePages={dashboardPages}
            onMoveChartToPage={canEditResource ? handleMoveChartToPage : undefined}
            emptyMessage={emptyPageMessage}
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
            globalFilters={appliedGlobalFilters}
            crossFilters={activeCrossFilter ? [activeCrossFilter] : []}
            crossFilterSourceChartId={crossFilterState?.sourceChartId ?? null}
            onChartDataLoaded={semanticColumnsResult.columns.length > 0 ? undefined : handleChartDataLoaded}
            onSelectCrossFilter={handleCrossFilterChange}
            availablePages={dashboardPages}
            onMoveChartToPage={canEditResource ? handleMoveChartToPage : undefined}
            emptyMessage={emptyPageMessage}
          />
        )}
        </div>

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
                globalFilters={appliedGlobalFilters}
                instanceParameters={dc.parameters ?? {}}
              />
            ))}
        </div>

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

        {/* Phase-15.56 — Confirm discard draft layout */}
        <ConfirmDialog
          isOpen={isDiscardConfirmOpen}
          onClose={() => setIsDiscardConfirmOpen(false)}
          onConfirm={async () => {
            try {
              await discardDraftMutation.mutateAsync(dashboardId);
              setHasUnsavedChanges(false);
              toast.success('Đã quay lại phiên bản gần nhất.');
            } catch (e) {
              toast.error('Không huỷ được — thử lại.');
            }
          }}
          title="Huỷ thay đổi bố cục?"
          description="Bản nháp hiện tại sẽ bị xoá. Dashboard quay về bố cục đã xuất bản gần nhất. Hành động này không hoàn tác được."
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
