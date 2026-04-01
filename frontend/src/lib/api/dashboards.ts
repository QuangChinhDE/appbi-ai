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
    layout: DashboardChartLayout,
    parameters?: Record<string, any>,
  ): Promise<Dashboard> => {
    const response = await apiClient.post(`/dashboards/${dashboardId}/charts`, {
      chart_id: chartId,
      layout,
      parameters: parameters ?? {},
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

  share: async (
    id: number,
    public_filters_config?: any[],
  ): Promise<{ share_token: string; public_filters_config?: any[] }> => {
    const response = await apiClient.post(`/dashboards/${id}/share`, { public_filters_config });
    return response.data;
  },

  unshare: async (id: number): Promise<void> => {
    await apiClient.delete(`/dashboards/${id}/share`);
  },

  // ── Multi public links ────────────────────────────────────────
  listPublicLinks: async (dashboardId: number): Promise<PublicLink[]> => {
    const response = await apiClient.get(`/dashboards/${dashboardId}/public-links`);
    return response.data;
  },

  createPublicLink: async (
    dashboardId: number,
    data: { name: string; filters_config?: any[]; password?: string },
  ): Promise<PublicLink> => {
    const response = await apiClient.post(`/dashboards/${dashboardId}/public-links`, data);
    return response.data;
  },

  updatePublicLink: async (
    dashboardId: number,
    linkId: number,
    // password: undefined = no change, '' = clear password, non-empty = set new
    data: { name?: string; filters_config?: any[]; is_active?: boolean; password?: string },
  ): Promise<PublicLink> => {
    const response = await apiClient.patch(`/dashboards/${dashboardId}/public-links/${linkId}`, data);
    return response.data;
  },

  deletePublicLink: async (dashboardId: number, linkId: number): Promise<void> => {
    await apiClient.delete(`/dashboards/${dashboardId}/public-links/${linkId}`);
  },
};

export interface PublicLink {
  id: number;
  dashboard_id: number;
  name: string;
  token: string;
  filters_config: any[] | null;
  is_active: boolean;
  has_password: boolean;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
  updated_at: string;
}
