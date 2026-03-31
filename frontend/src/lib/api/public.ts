/**
 * Public (unauthenticated) API calls for shared dashboard links.
 * Uses a plain fetch so no auth cookies are sent.
 */
import axios from 'axios';
import type { Dashboard } from '@/types/api';

// NEXT_PUBLIC_API_URL already includes /api/v1 (e.g. http://localhost:8000/api/v1)
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api/v1';

// Axios instance without credentials so no auth cookie leaks
const publicClient = axios.create({
  baseURL: API_BASE,
  withCredentials: false,
});

export const publicDashboardApi = {
  get: async (token: string): Promise<Dashboard> => {
    const res = await publicClient.get(`/public/dashboards/${token}`);
    return res.data;
  },

  getChartData: async (token: string, chartId: number): Promise<any> => {
    const res = await publicClient.get(`/public/dashboards/${token}/charts/${chartId}/data`);
    return res.data;
  },
};
