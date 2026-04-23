/**
 * React Query hooks for dashboards.
 */
'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { dashboardApi } from '@/lib/api/dashboards';
import { sortByUpdatedAtDesc } from '@/lib/sort';
import { Dashboard, DashboardCreate, DashboardUpdate, DashboardChartLayout } from '@/types/api';
import type {
  DashboardHtmlImportAnalyzeInput,
  DashboardHtmlImportBatchAnalyzeInput,
  DashboardHtmlImportBatchBuildInput,
  DashboardHtmlImportBuildInput,
  DashboardHtmlImportFixChartInput,
  DashboardHtmlImportPreviewCalculatedInput,
  DashboardHtmlImportPrepareDraftInput,
  DashboardHtmlImportValidateInput,
} from '@/types/dashboard-html-import';

export const useDashboards = () => {
  return useQuery({
    queryKey: ['dashboards'],
    queryFn: dashboardApi.getAll,
    select: (dashboards) => sortByUpdatedAtDesc(dashboards),
  });
};

export const useDashboard = (id: number) => {
  return useQuery({
    queryKey: ['dashboards', id],
    queryFn: () => dashboardApi.getById(id),
    enabled: !!id,
  });
};

export const useCreateDashboard = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: DashboardCreate) => dashboardApi.create(data),
    onSuccess: (newDashboard) => {
      queryClient.setQueryData<Dashboard[]>(['dashboards'], (old) =>
        old ? [...old, newDashboard] : [newDashboard],
      );
    },
  });
};

export const useUpdateDashboard = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: DashboardUpdate }) =>
      dashboardApi.update(id, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['dashboards'] });
      queryClient.invalidateQueries({ queryKey: ['dashboards', variables.id] });
    },
  });
};

export const useDeleteDashboard = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (id: number) => dashboardApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboards'] });
    },
  });
};

export const useAddChartToDashboard = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({
      dashboardId,
      chartId,
      layout,
      parameters,
    }: {
      dashboardId: number;
      chartId: number;
      layout: DashboardChartLayout;
      parameters?: Record<string, any>;
    }) => dashboardApi.addChart(dashboardId, chartId, layout, parameters),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['dashboards'] });
      queryClient.invalidateQueries({ queryKey: ['dashboards', variables.dashboardId] });
    },
  });
};

export const useRemoveChartFromDashboard = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ dashboardId, dashboardChartId }: { dashboardId: number; dashboardChartId: number }) =>
      dashboardApi.removeChart(dashboardId, dashboardChartId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['dashboards'] });
      queryClient.invalidateQueries({ queryKey: ['dashboards', variables.dashboardId] });
    },
  });
};

export const useUpdateDashboardLayout = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      dashboardId,
      chartLayouts,
    }: {
      dashboardId: number;
      chartLayouts: Array<{ id: number; layout: Record<string, any> }>;
    }) => dashboardApi.updateLayout(dashboardId, chartLayouts),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['dashboards', variables.dashboardId] });
    },
  });
};

export const useShareDashboard = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ dashboardId, publicFiltersConfig }: { dashboardId: number; publicFiltersConfig?: any[] }) =>
      dashboardApi.share(dashboardId, publicFiltersConfig),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['dashboards'] });
      queryClient.invalidateQueries({ queryKey: ['dashboards', variables.dashboardId] });
    },
  });
};

export const useAnalyzeDashboardHtmlImport = () => {
  return useMutation({
    mutationFn: (input: DashboardHtmlImportAnalyzeInput) => dashboardApi.analyzeHtmlImport(input),
  });
};

export const useAnalyzeDashboardHtmlImportBatch = () => {
  return useMutation({
    mutationFn: (input: DashboardHtmlImportBatchAnalyzeInput) => dashboardApi.analyzeHtmlImportBatch(input),
  });
};

export const useBuildDashboardHtmlImport = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: DashboardHtmlImportBuildInput) => dashboardApi.buildHtmlImport(input),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['dashboards'] });
      queryClient.invalidateQueries({ queryKey: ['dashboards', result.dashboard_id] });
    },
  });
};

export const useBuildDashboardHtmlImportBatch = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: DashboardHtmlImportBatchBuildInput) => dashboardApi.buildHtmlImportBatch(input),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['dashboards'] });
      queryClient.invalidateQueries({ queryKey: ['dashboards', result.dashboard_id] });
    },
  });
};

export const usePreviewDashboardHtmlImportSource = () => {
  return useMutation({
    mutationFn: (file: File) => dashboardApi.previewHtmlImportSource(file),
  });
};

export const useValidateDashboardHtmlImportPlans = () => {
  return useMutation({
    mutationFn: (input: DashboardHtmlImportValidateInput) => dashboardApi.validateHtmlImportPlans(input),
  });
};

export const useFixDashboardHtmlImportChartPlan = () => {
  return useMutation({
    mutationFn: (input: DashboardHtmlImportFixChartInput) => dashboardApi.fixHtmlImportChartPlan(input),
  });
};

export const usePreviewDashboardHtmlImportCalculatedFields = () => {
  return useMutation({
    mutationFn: (input: DashboardHtmlImportPreviewCalculatedInput) =>
      dashboardApi.previewHtmlImportCalculatedFields(input),
  });
};

export const usePrepareDashboardHtmlImportDraft = () => {
  return useMutation({
    mutationFn: (input: DashboardHtmlImportPrepareDraftInput) =>
      dashboardApi.prepareHtmlImportDraft(input),
  });
};

export const useCancelDashboardHtmlImportDraft = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (datasetId: number) => dashboardApi.cancelHtmlImportDraft(datasetId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['datasets'] });
    },
  });
};

export const useUnshareDashboard = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => dashboardApi.unshare(id),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['dashboards'] });
      queryClient.invalidateQueries({ queryKey: ['dashboards', id] });
    },
  });
};
