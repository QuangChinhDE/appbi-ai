'use client';

import React, { useState, useCallback } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Plus, Loader2, Edit2, Check, X, Share2, Bot, Sparkles } from 'lucide-react';
import { Layout } from 'react-grid-layout';
import {
  useDashboard,
  useUpdateDashboard,
  useAddChartToDashboard,
  useRemoveChartFromDashboard,
  useUpdateDashboardLayout,
} from '@/hooks/use-dashboards';
import { DashboardGrid } from '@/components/dashboards/DashboardGrid';
import { AddChartModal } from '@/components/dashboards/AddChartModal';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ShareDialog } from '@/components/common/ShareDialog';
import { DashboardFilterBar } from '@/components/dashboards/DashboardFilterBar';
import { DashboardChartLayout } from '@/types/api';
import type { BaseFilter, ColumnInfo } from '@/lib/filters';
import { inferColumnTypeFromData } from '@/lib/filters';
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
  const [availableColumns, setAvailableColumns] = useState<ColumnInfo[]>([]);
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  // columnChartCount: how many distinct chartIds have each column
  const columnChartCountRef = React.useRef<Map<string, Set<number>>>(new Map());
  const [columnChartCount, setColumnChartCount] = useState<Map<string, number>>(new Map());

  const { data: dashboard, isLoading: isLoadingDashboard } = useDashboard(dashboardId);
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
  }, []);

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
          columns={availableColumns}
          columnChartCount={columnChartCount}
          filters={globalFilters}
          onFiltersChange={setGlobalFilters}
        />

        {/* Dashboard Grid */}
        <DashboardGrid
          dashboardId={dashboardId}
          dashboardCharts={dashboard.dashboard_charts || []}
          onLayoutChange={canEditResource ? handleLayoutChange : undefined}
          onRemoveChart={canEditResource ? handleRemoveChart : undefined}
          removingChartId={removingChartId}
          globalFilters={globalFilters}
          onChartDataLoaded={handleChartDataLoaded}
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

        {/* Share Dialog */}
        {isShareDialogOpen && dashboard && (
          <ShareDialog
            resourceType="dashboard"
            resourceId={dashboardId}
            resourceName={dashboard.name}
            onClose={() => setIsShareDialogOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
