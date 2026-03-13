/**
 * API functions for dashboards.
 */
import apiClient from '@/lib/api-client';
import {
  Dashboard,
  DashboardCreate,
  DashboardUpdate,
  DashboardChartLayout,
} from '@/types/api';

export const dashboardApi = {
  getAll: async (): Promise<Dashboard[]> => {
    const response = await apiClient.get('/dashboards/');
    return response.data;
  },

  getById: async (id: number): Promise<Dashboard> => {
    const response = await apiClient.get(`/dashboards/${id}`);
    return response.data;
  },

  create: async (data: DashboardCreate): Promise<Dashboard> => {
    const response = await apiClient.post('/dashboards/', data);
    return response.data;
  },

  update: async (id: number, data: DashboardUpdate): Promise<Dashboard> => {
    const response = await apiClient.put(`/dashboards/${id}`, data);
    return response.data;
  },

  delete: async (id: number): Promise<void> => {
    await apiClient.delete(`/dashboards/${id}`);
  },

  addChart: async (
    dashboardId: number,
    chartId: number,
    layout: DashboardChartLayout
  ): Promise<Dashboard> => {
    const response = await apiClient.post(`/dashboards/${dashboardId}/charts`, {
      chart_id: chartId,
      layout,
    });
    return response.data;
  },

  removeChart: async (dashboardId: number, chartId: number): Promise<Dashboard> => {
    const response = await apiClient.delete(`/dashboards/${dashboardId}/charts/${chartId}`);
    return response.data;
  },

  updateLayout: async (
    dashboardId: number,
    chartLayouts: Array<{ id: number; layout: Record<string, any> }>
  ): Promise<Dashboard> => {
    const response = await apiClient.put(`/dashboards/${dashboardId}/layout`, {
      chart_layouts: chartLayouts,
    });
    return response.data;
  },
};
