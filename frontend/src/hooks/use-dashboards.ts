/**
 * React Query hooks for dashboards.
 */
'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { dashboardApi } from '@/lib/api/dashboards';
import { DashboardCreate, DashboardUpdate, DashboardChartLayout } from '@/types/api';

export const useDashboards = () => {
  return useQuery({
    queryKey: ['dashboards'],
    queryFn: dashboardApi.getAll,
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboards'] });
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
    mutationFn: ({ dashboardId, chartId }: { dashboardId: number; chartId: number }) =>
      dashboardApi.removeChart(dashboardId, chartId),
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
    mutationFn: (id: number) => dashboardApi.share(id),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['dashboards'] });
      queryClient.invalidateQueries({ queryKey: ['dashboards', id] });
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
