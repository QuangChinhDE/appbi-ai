'use client';

import React, { useState, useCallback } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Plus, Loader2, Edit2, Check, X, Share2, Globe, Bot, Sparkles, Trash2, LayoutGrid } from 'lucide-react';
import { Layout } from 'react-grid-layout';
import { useQueries } from '@tanstack/react-query';
import {
  useDashboard,
  useUpdateDashboard,
  useAddChartToDashboard,
  useRemoveChartFromDashboard,
  useUpdateDashboardLayout,
} from '@/hooks/use-dashboards';
import { dashboardApi } from '@/lib/api/dashboards';
import { DashboardGrid } from '@/components/dashboards/DashboardGrid';
import { AddChartModal } from '@/components/dashboards/AddChartModal';
import { DashboardChartManagerModal } from '@/components/dashboards/DashboardChartManagerModal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ShareDialog } from '@/components/common/ShareDialog';
import { PublicLinksManager } from '@/components/common/PublicLinksManager';
import { DashboardFilterBar } from '@/components/dashboards/DashboardFilterBar';
import { DashboardChartLayout, DashboardPageConfig } from '@/types/api';
import type { BaseFilter, ColumnInfo, FilterType } from '@/lib/filters';
import {
  collectJoinKeySemanticFields,
  computeDatePresetRange,
  getColumnDisplayLabel,
  getFilterDisplayLabel,
  getFriendlyFieldLabel,
  getColumnKey,
  getFilterKey,
  inferColumnTypeFromData,
  isSemanticDimensionFilterableForDashboard,
} from '@/lib/filters';
import { fetchDatasetModel, fetchDatasetModelDistinctValues, modelKeys, type DatasetModelResponse } from '@/hooks/use-dataset-model';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { useAgentReportSpecs } from '@/hooks/use-agent-report-specs';
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
  const [currentPageId, setCurrentPageId] = useState<string | null>(null);
  const [localPagesConfig, setLocalPagesConfig] = useState<DashboardPageConfig[] | null>(null);
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [editedPageName, setEditedPageName] = useState('');
  const [pendingDeletePageId, setPendingDeletePageId] = useState<string | null>(null);
  // columnChartCount: how many distinct chartIds have each column
  const columnChartCountRef = React.useRef<Map<string, Set<number>>>(new Map());
  const [columnChartCount, setColumnChartCount] = useState<Map<string, number>>(new Map());
  // Refs for filter seeding
  const filtersSeededRef = React.useRef(false);
  const filtersSnapshotRef = React.useRef<string>('[]');
  const distinctValuesRef = React.useRef<Map<string, Set<string>>>(new Map());
  const [distinctValues, setDistinctValues] = useState<Record<string, string[]>>({});

  const { data: dashboard, isLoading: isLoadingDashboard } = useDashboard(dashboardId);
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
  const { data: permData } = usePermissions();
  const canViewAgentReports = hasPermission(permData?.permissions, 'ai_agent', 'view');
  const { data: agentReportSpecs = [] } = useAgentReportSpecs(canViewAgentReports);
  const resPerms = getResourcePermissions(dashboard?.user_permission);
  const canShare = resPerms.canShare;
  const canEditResource = resPerms.canEdit;
  const updateDashboardMutation = useUpdateDashboard();
  const addChartMutation = useAddChartToDashboard();
  const removeChartMutation = useRemoveChartFromDashboard();
  const updateLayoutMutation = useUpdateDashboardLayout();
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

  const dateFilterAutoSeededRef = React.useRef(false);

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

  // Auto-save layout with debounce
  const debouncedSaveLayout = useDebounce(
    async (layouts: Layout[]) => {
      if (!dashboard) return;

      const chartLayouts = layouts.map((item) => ({
        id: Number(item.i), // dashboard_chart_id
        layout: {
          ...(dashboard.dashboard_charts?.find((dashboardChart) => dashboardChart.id === Number(item.i))?.layout ?? {}),
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
        },
      }));

      try {
        await updateLayoutMutation.mutateAsync({
          dashboardId,
          chartLayouts,
        });
        setHasUnsavedChanges(false);
      } catch (error) {
        console.error('Failed to save layout:', error);
      }
    },
    1000 // 1 second debounce
  );

  const handleLayoutChange = (newLayout: Layout[]) => {
    setHasUnsavedChanges(true);
    debouncedSaveLayout(newLayout);
  };

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
          }
        | undefined;

      if (!binding?.datasetId) continue;

      const model = datasetModelsById.get(binding.datasetId);
      if (!model) continue;

      const viewsByName = new Map(model.views.map((view) => [view.name, view]));
      const joinKeyFields = datasetJoinKeyFields.get(binding.datasetId) ?? new Set<string>();
      const candidateFields = binding.dimensionFields?.length
        ? binding.dimensionFields
        : Object.values(binding.fieldMap ?? {});

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
        if (!dimension) continue;
        const key = semanticField;
        if (!columns.has(key)) {
          columns.set(key, {
            key,
            name: fieldName,
            label: getFriendlyFieldLabel(dimension.label ?? fieldName),
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
    const semanticFields = new Set<string>();
    const chartsWithCalendar = new Set<number>();
    const datasetIds = new Set<number>();

    for (const dashboardChart of dashboard?.dashboard_charts ?? []) {
      const binding = (dashboardChart.chart?.config as any)?.semanticBinding as
        | {
            datasetId?: number;
            calendarFieldMappings?: Array<{
              semanticField?: string;
              calendarField?: string;
            }>;
          }
        | undefined;

      if (binding?.datasetId != null) {
        datasetIds.add(binding.datasetId);
      }

      const dateMappings = (binding?.calendarFieldMappings ?? []).filter(
        (mapping) => (
          mapping?.calendarField === 'date'
          && typeof mapping?.semanticField === 'string'
          && mapping.semanticField.includes('.')
        ),
      );
      if (dateMappings.length === 0) continue;

      chartsWithCalendar.add(dashboardChart.chart_id);
      dateMappings.forEach((mapping) => semanticFields.add(String(mapping.semanticField)));
    }

    const orderedSemanticFields = Array.from(semanticFields).sort();
    if (orderedSemanticFields.length === 0) return [];

    return [{
      key: orderedSemanticFields[0],
      name: 'date',
      label: 'Date',
      type: 'date',
      semanticField: orderedSemanticFields[0],
      datasetId: datasetIds.size === 1 ? Array.from(datasetIds)[0] : undefined,
      defaultLinkedFields: orderedSemanticFields.slice(1),
      chartCoverage: chartsWithCalendar.size,
      datasetChartCount: totalDashboardChartCount,
      sharedAcrossDataset: totalDashboardChartCount > 0 && chartsWithCalendar.size === totalDashboardChartCount,
    }];
  }, [dashboard?.dashboard_charts]);

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

  // Auto-seed a default date filter from the dataset calendar/date table when available.
  React.useEffect(() => {
    if (dateFilterAutoSeededRef.current) return;
    if (!filtersSeededRef.current) return;
    if (draftGlobalFilters.length > 0) {
      dateFilterAutoSeededRef.current = true;
      return;
    }

    const dateCol = calendarDateColumns[0];
    if (!dateCol) return;

    dateFilterAutoSeededRef.current = true;
    const dateColKey = getColumnKey(dateCol);
    const preset = 'this_month' as const;

    const defaultDateFilter: BaseFilter = {
      id: `gf-default-date-${Date.now()}`,
      field: dateCol.name,
      fieldKey: dateColKey,
      semanticField: dateCol.semanticField,
      datasetId: dateCol.datasetId,
      type: 'date',
      operator: 'between',
      value: computeDatePresetRange(preset),
      label: getColumnDisplayLabel(dateCol),
      datePreset: preset,
      linkedFields: dateCol.defaultLinkedFields?.length ? [...dateCol.defaultLinkedFields] : undefined,
    };

    setDraftGlobalFilters([defaultDateFilter]);
    setAppliedGlobalFilters([defaultDateFilter]);
  }, [draftGlobalFilters, calendarDateColumns]);

  const activeSemanticDistinctColumns = React.useMemo(() => {
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

    return Array.from(activeColumns.values());
  }, [draftGlobalFilters, semanticColumnsResult.columns]);

  const semanticDistinctQueries = useQueries({
    queries: activeSemanticDistinctColumns.map((column) => ({
      queryKey: modelKeys.distinct(column.datasetId!, column.semanticField!),
      queryFn: () => fetchDatasetModelDistinctValues(column.datasetId!, column.semanticField!),
      enabled: Boolean(column.datasetId && column.semanticField),
      staleTime: 5 * 60 * 1000,
    })),
  });

  const semanticDistinctValues = React.useMemo(() => {
    const values: Record<string, string[]> = {};
    activeSemanticDistinctColumns.forEach((column, index) => {
      values[getColumnKey(column)] = semanticDistinctQueries[index]?.data?.values ?? [];
    });
    return values;
  }, [activeSemanticDistinctColumns, semanticDistinctQueries]);

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
      <div className="min-h-screen bg-gray-50">
        <div className="w-full px-8 py-6">
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
            <span className="ml-2">Loading dashboard...</span>
          </div>
        </div>
      </div>
    );
  }

  if (!dashboard) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="w-full px-8 py-6">
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <p className="text-gray-500">Dashboard not found</p>
            <Link
              href="/dashboards"
              className="inline-flex items-center text-blue-600 hover:text-blue-700 mt-4"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Dashboards
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const linkedAgentReport = agentReportSpecs.find((spec) => spec.latest_dashboard_id === dashboardId);
  const activeCrossFilter = crossFilterState?.filter ?? null;
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
    <div className="min-h-screen bg-gray-50">
      <div className="w-full px-4 py-4 sm:px-6 lg:px-8">
        <div className="mb-4 rounded-xl border border-gray-200 bg-white px-4 py-4 shadow-sm">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <Link href="/dashboards" className="inline-flex items-center text-blue-600 hover:text-blue-700">
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back to Dashboards
                </Link>
                {hasUnsavedChanges && (
                  <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs text-gray-500">
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    Saving layout
                  </span>
                )}
              </div>

              <div className="mt-3 min-w-0">
                {isEditingName ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={editedName}
                      onChange={(e) => setEditedName(e.target.value)}
                      className="min-w-[260px] flex-1 rounded-lg border border-gray-300 px-3 py-2 text-xl font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500"
                      autoFocus
                    />
                    <button
                      onClick={handleSaveName}
                      disabled={updateDashboardMutation.isPending}
                      className="rounded-md p-2 text-green-600 hover:bg-green-50"
                      title="Save"
                    >
                      <Check className="h-5 w-5" />
                    </button>
                    <button
                      onClick={handleCancelEditName}
                      className="rounded-md p-2 text-gray-600 hover:bg-gray-50"
                      title="Cancel"
                    >
                      <X className="h-5 w-5" />
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-3">
                    <h1 className="truncate text-2xl font-bold text-gray-900">{dashboard.name}</h1>
                    {canEditResource && (
                      <button
                        onClick={handleStartEditName}
                        className="rounded-md p-1 text-gray-400 hover:text-gray-600"
                        title="Edit name"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                )}

                {dashboard.description && (
                  <p className="mt-1 text-sm text-gray-500">{dashboard.description}</p>
                )}

                {linkedAgentReport && (
                  <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-900">
                    <div className="flex items-center gap-2">
                      <Bot className="h-4 w-4" />
                      <span>
                        Generated from <span className="font-semibold">{linkedAgentReport.name}</span>
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => router.push(`/ai-reports/${linkedAgentReport.id}`)}
                      className="inline-flex items-center gap-2 rounded-md border border-blue-200 bg-white px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100/40"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      Open AI report
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 xl:justify-end">
              {canEditResource && (
                <button
                  onClick={() => setIsPublicShareOpen(true)}
                  className="inline-flex items-center rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <Globe className="mr-2 h-4 w-4" />
                  Public links
                </button>
              )}
              {canShare && (
                <button
                  onClick={() => setIsShareDialogOpen(true)}
                  className="inline-flex items-center rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <Share2 className="mr-2 h-4 w-4" />
                  Share
                </button>
              )}
              {canEditResource && (
                <button
                  onClick={() => setIsChartManagerOpen(true)}
                  className="inline-flex items-center rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  <LayoutGrid className="mr-2 h-4 w-4" />
                  Manage charts
                </button>
              )}
              {canEditResource && (
                <button
                  onClick={() => setIsAddChartModalOpen(true)}
                  className="inline-flex items-center rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Add Chart
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="mb-4 rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex gap-2 overflow-x-auto pb-1">
              {dashboardPages.map((page) => {
                const isActive = page.id === activePageId;
                return (
                  <button
                    key={page.id}
                    type="button"
                    onClick={() => setCurrentPageId(page.id)}
                    className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {page.name}
                  </button>
                );
              })}
            </div>

            {canEditResource && (
              <div className="flex flex-wrap items-center gap-2">
                {isRenamingCurrentPage ? (
                  <>
                    <input
                      type="text"
                      value={editedPageName}
                      onChange={(e) => setEditedPageName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSavePageName();
                        if (e.key === 'Escape') handleCancelRenamePage();
                      }}
                      className="min-w-[180px] rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={handleSavePageName}
                      className="rounded-md p-2 text-green-600 hover:bg-green-50"
                      title="Save page name"
                    >
                      <Check className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelRenamePage}
                      className="rounded-md p-2 text-gray-500 hover:bg-gray-100"
                      title="Cancel"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={handleStartRenamePage}
                    className="inline-flex items-center rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    <Edit2 className="mr-2 h-4 w-4" />
                    Rename page
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setPendingDeletePageId(activePageId)}
                  disabled={dashboardPages.length <= 1}
                  className="inline-flex items-center rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete page
                </button>

                <button
                  type="button"
                  onClick={handleAddPage}
                  className="inline-flex items-center rounded-md border border-blue-200 px-3 py-1.5 text-sm text-blue-700 hover:bg-blue-50"
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Add page
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Dashboard Filter Bar */}
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
        />

        {activeCrossFilter && (
          <div className="mb-4 flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <span className="font-medium">
              Cross-filter from {activeCrossFilterSourceTitle}:
            </span>
            <span className="truncate">
              {getFilterDisplayLabel(activeCrossFilter)} = {formatFilterValue(activeCrossFilter.value)}
            </span>
            <button
              type="button"
              onClick={() => setCrossFilterState(null)}
              className="ml-auto rounded-md border border-amber-300 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
            >
              Clear
            </button>
          </div>
        )}

        {/* Dashboard Grid */}
        <DashboardGrid
          dashboardId={dashboardId}
          dashboardCharts={visibleDashboardCharts}
          canEdit={canEditResource}
          allowAppearanceEdit={canEditResource}
          onLayoutChange={canEditResource ? handleLayoutChange : undefined}
          onRemoveChart={canEditResource ? handleRemoveChart : undefined}
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

        {/* Add Chart Modal */}
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
      </div>
    </div>
  );
}
