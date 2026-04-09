'use client';

import React, { useState, useCallback } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Plus, Loader2, Edit2, Check, X, Share2, Globe, Bot, Sparkles } from 'lucide-react';
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
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ShareDialog } from '@/components/common/ShareDialog';
import { PublicLinksManager } from '@/components/common/PublicLinksManager';
import { DashboardFilterBar } from '@/components/dashboards/DashboardFilterBar';
import { DashboardChartLayout } from '@/types/api';
import type { BaseFilter, ColumnInfo, FilterType } from '@/lib/filters';
import { getColumnKey, getFilterKey, inferColumnTypeFromData } from '@/lib/filters';
import { fetchDatasetModel, fetchDatasetModelDistinctValues, modelKeys, type DatasetModelResponse } from '@/hooks/use-dataset-model';
import { usePermissions, hasPermission } from '@/hooks/use-permissions';
import { useAgentReportSpecs } from '@/hooks/use-agent-report-specs';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { toast } from 'sonner';

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

export default function DashboardDetailPage() {
  const params = useParams();
  const router = useRouter();
  const dashboardId = Number(params.id);

  const [isAddChartModalOpen, setIsAddChartModalOpen] = useState(false);
  const [removingChartId, setRemovingChartId] = useState<number | undefined>();
  const [pendingRemoveDashboardChartId, setPendingRemoveDashboardChartId] = useState<number | undefined>();
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState('');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [globalFilters, setGlobalFilters] = useState<BaseFilter[]>([]);
  const [crossFilterState, setCrossFilterState] = useState<{
    sourceChartId: number;
    filter: BaseFilter;
  } | null>(null);
  const [availableColumns, setAvailableColumns] = useState<ColumnInfo[]>([]);
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [isPublicShareOpen, setIsPublicShareOpen] = useState(false);
  // columnChartCount: how many distinct chartIds have each column
  const columnChartCountRef = React.useRef<Map<string, Set<number>>>(new Map());
  const [columnChartCount, setColumnChartCount] = useState<Map<string, number>>(new Map());
  // Refs for filter seeding and auto-save
  const filtersSeededRef = React.useRef(false);
  const filtersSaveTimerRef = React.useRef<NodeJS.Timeout | null>(null);
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

  // Seed globalFilters from dashboard.filters_config once when dashboard first loads
  React.useEffect(() => {
    if (!dashboard || filtersSeededRef.current) return;
    filtersSeededRef.current = true;
    const initial: BaseFilter[] = Array.isArray(dashboard.filters_config) ? dashboard.filters_config as BaseFilter[] : [];
    filtersSnapshotRef.current = JSON.stringify(initial);
    setGlobalFilters(initial);
  }, [dashboard]);

  React.useEffect(() => {
    if (!crossFilterState) return;
    const sourceExists = (dashboard?.dashboard_charts ?? []).some(
      (dashboardChart) => dashboardChart.chart_id === crossFilterState.sourceChartId,
    );
    if (!sourceExists) {
      setCrossFilterState(null);
    }
  }, [dashboard?.dashboard_charts, crossFilterState]);

  // Auto-save globalFilters to backend for editors (1.5s debounce, skips the initial seed)
  React.useEffect(() => {
    if (!filtersSeededRef.current) return;
    const current = JSON.stringify(globalFilters);
    if (current === filtersSnapshotRef.current) return; // no change from saved value
    if (!canEditResource) return;
    if (filtersSaveTimerRef.current) clearTimeout(filtersSaveTimerRef.current);
    filtersSaveTimerRef.current = setTimeout(async () => {
      try {
        await dashboardApi.update(dashboardId, { filters_config: globalFilters });
        filtersSnapshotRef.current = JSON.stringify(globalFilters);
      } catch {
        // silent — filters remain active in session even if save fails
      }
    }, 1500);
    return () => {
      if (filtersSaveTimerRef.current) clearTimeout(filtersSaveTimerRef.current);
    };
  }, [globalFilters, canEditResource, dashboardId]);

  // Auto-save layout with debounce
  const debouncedSaveLayout = useDebounce(
    async (layouts: Layout[]) => {
      if (!dashboard) return;

      const chartLayouts = layouts.map((item) => ({
        id: Number(item.i), // dashboard_chart_id
        layout: {
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
        layout,
        parameters,
      });
      setIsAddChartModalOpen(false);
    } catch (error) {
      console.error('Failed to add chart:', error);
      toast.error('Failed to add chart. Please try again.');
    }
  };

  const handleRemoveChart = (dashboardChartId: number) => {
    if (!dashboard) return;
    const dashboardChart = dashboard.dashboard_charts?.find((dc) => dc.id === dashboardChartId);
    if (!dashboardChart) return;
    setPendingRemoveDashboardChartId(dashboardChartId);
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
        chartId: dashboardChart.chart_id,
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
      const candidateFields = binding.dimensionFields?.length
        ? binding.dimensionFields
        : Object.values(binding.fieldMap ?? {});

      for (const semanticField of candidateFields) {
        const parts = splitSemanticField(semanticField);
        if (!parts) continue;
        const [viewName, fieldName] = parts;
        const view = viewsByName.get(viewName);
        const dimension = view?.dimensions.find((item) => item.name === fieldName);
        if (!dimension) continue;
        const viewLabel = view?.table_display_name || viewName;

        const key = semanticField;
        if (!columns.has(key)) {
          columns.set(key, {
            key,
            name: fieldName,
            label: `${viewLabel}.${dimension.label ?? fieldName}`,
            type: semanticDimensionToFilterType(dimension.type),
            datasetId: binding.datasetId,
            semanticField,
          });
        }
        if (!counts.has(key)) counts.set(key, new Set());
        counts.get(key)!.add(dashboardChart.chart_id);
      }
    }

    return {
      columns: Array.from(columns.values()).sort((a, b) =>
        (a.label ?? a.name).localeCompare(b.label ?? b.name),
      ),
      chartCount: new Map(Array.from(counts.entries()).map(([key, ids]) => [key, ids.size])),
    };
  }, [dashboard?.dashboard_charts, datasetModelsById]);

  const semanticDistinctColumns = React.useMemo(
    () => semanticColumnsResult.columns.filter(
      (column) => Boolean(column.datasetId && column.semanticField)
        && (column.type === 'dropdown' || column.type === 'text'),
    ),
    [semanticColumnsResult.columns],
  );

  const semanticDistinctQueries = useQueries({
    queries: semanticDistinctColumns.map((column) => ({
      queryKey: modelKeys.distinct(column.datasetId!, column.semanticField!),
      queryFn: () => fetchDatasetModelDistinctValues(column.datasetId!, column.semanticField!),
      enabled: Boolean(column.datasetId && column.semanticField),
      staleTime: 5 * 60 * 1000,
    })),
  });

  const semanticDistinctValues = React.useMemo(() => {
    const values: Record<string, string[]> = {};
    semanticDistinctColumns.forEach((column, index) => {
      values[getColumnKey(column)] = semanticDistinctQueries[index]?.data?.values ?? [];
    });
    return values;
  }, [semanticDistinctColumns, semanticDistinctQueries]);

  const resolvedAvailableColumns = semanticColumnsResult.columns.length > 0
    ? semanticColumnsResult.columns
    : availableColumns;
  const resolvedColumnChartCount = semanticColumnsResult.columns.length > 0
    ? semanticColumnsResult.chartCount
    : columnChartCount;
  const resolvedDistinctValues = semanticColumnsResult.columns.length > 0
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

  const existingChartIds = dashboard.dashboard_charts?.map((dc) => dc.chart_id) || [];
  const linkedAgentReport = agentReportSpecs.find((spec) => spec.latest_dashboard_id === dashboardId);
  const activeCrossFilter = crossFilterState?.filter ?? null;
  const activeCrossFilterSourceTitle = crossFilterState
    ? (dashboard.dashboard_charts?.find((dc) => dc.chart_id === crossFilterState.sourceChartId)?.layout?.custom_title
      ?? dashboard.dashboard_charts?.find((dc) => dc.chart_id === crossFilterState.sourceChartId)?.chart?.name
      ?? `Chart ${crossFilterState.sourceChartId}`)
    : null;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="w-full px-8 py-6">
        {/* Navigation */}
        <div className="mb-6">
          <Link href="/dashboards" className="inline-flex items-center text-blue-600 hover:text-blue-700">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Dashboards
          </Link>
        </div>

        {/* Header */}
        <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
          {linkedAgentReport && (
            <div className="mb-5 rounded-xl border border-blue-200 bg-blue-50 p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white text-blue-600">
                    <Bot className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-blue-900">Generated from AI Report</p>
                    <p className="mt-1 text-sm text-blue-800">
                      This dashboard is the editable output of <span className="font-medium">{linkedAgentReport.name}</span>.
                      Keep refining layout and charts here, then return to AI Reports when you want to review the narrative or rerun the brief.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => router.push(`/ai-reports/${linkedAgentReport.id}`)}
                  className="inline-flex items-center gap-2 rounded-md border border-blue-200 bg-white px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100/40"
                >
                  <Sparkles className="h-4 w-4" />
                  Open AI report
                </button>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between">
            <div className="flex-1">
              {isEditingName ? (
                <div className="flex items-center space-x-2">
                  <input
                    type="text"
                    value={editedName}
                    onChange={(e) => setEditedName(e.target.value)}
                    className="text-2xl font-bold border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    autoFocus
                  />
                  <button
                    onClick={handleSaveName}
                    disabled={updateDashboardMutation.isPending}
                    className="p-2 text-green-600 hover:bg-green-50 rounded"
                    title="Save"
                  >
                    <Check className="h-5 w-5" />
                  </button>
                  <button
                    onClick={handleCancelEditName}
                    className="p-2 text-gray-600 hover:bg-gray-50 rounded"
                    title="Cancel"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center space-x-3">
                  <h1 className="text-2xl font-bold">{dashboard.name}</h1>
                  {canEditResource && (
                  <button
                    onClick={handleStartEditName}
                    className="p-1 text-gray-400 hover:text-gray-600"
                    title="Edit name"
                  >
                    <Edit2 className="h-4 w-4" />
                  </button>
                  )}
                </div>
              )}
              {dashboard.description && (
                <p className="text-gray-600 mt-1">{dashboard.description}</p>
              )}
            </div>

            <div className="flex items-center space-x-3">
              {hasUnsavedChanges && (
                <span className="text-sm text-gray-500 flex items-center">
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                  Saving...
                </span>
              )}
              {canEditResource && (
                <button
                  onClick={() => setIsPublicShareOpen(true)}
                  className="flex items-center px-4 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50"
                >
                  <Globe className="h-4 w-4 mr-2" />
                  Public links
                </button>
              )}
              {canShare && (
                <button
                  onClick={() => setIsShareDialogOpen(true)}
                  className="flex items-center px-4 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50"
                >
                  <Share2 className="h-4 w-4 mr-2" />
                  Share
                </button>
              )}
              {canEditResource && (
              <button
                onClick={() => setIsAddChartModalOpen(true)}
                className="flex items-center px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600"
              >
                <Plus className="h-5 w-5 mr-2" />
                Add Chart
              </button>
              )}
            </div>
          </div>
        </div>

        {/* Dashboard Filter Bar */}
        <DashboardFilterBar
          columns={resolvedAvailableColumns}
          columnChartCount={resolvedColumnChartCount}
          distinctValues={resolvedDistinctValues}
          filters={globalFilters}
          onFiltersChange={setGlobalFilters}
        />

        {activeCrossFilter && (
          <div className="mb-4 flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <span className="font-medium">
              Cross-filter from {activeCrossFilterSourceTitle}:
            </span>
            <span className="truncate">
              {(activeCrossFilter.label ?? activeCrossFilter.semanticField ?? activeCrossFilter.field)} = {formatFilterValue(activeCrossFilter.value)}
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
          dashboardCharts={dashboard.dashboard_charts || []}
          onLayoutChange={canEditResource ? handleLayoutChange : undefined}
          onRemoveChart={canEditResource ? handleRemoveChart : undefined}
          removingChartId={removingChartId}
          globalFilters={globalFilters}
          crossFilters={activeCrossFilter ? [activeCrossFilter] : []}
          crossFilterSourceChartId={crossFilterState?.sourceChartId ?? null}
          onChartDataLoaded={semanticColumnsResult.columns.length > 0 ? undefined : handleChartDataLoaded}
          onSelectCrossFilter={handleCrossFilterChange}
        />

        {/* Add Chart Modal */}
        <AddChartModal
          isOpen={isAddChartModalOpen}
          onClose={() => setIsAddChartModalOpen(false)}
          onAdd={handleAddChart}
          existingChartIds={existingChartIds}
          isAdding={addChartMutation.isPending}
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
