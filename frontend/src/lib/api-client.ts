/**
 * API client for making requests to the backend.
 */
import axios from 'axios';

// NEXT_PUBLIC_API_URL is baked at build time as '/api/v1' (relative).
// Next.js rewrites (localhost) or nginx (/api/ location) proxy it to the backend.
const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api/v1';
const API_CLIENT_BUILD_STAMP = '2026-04-01-001';

export const apiClient = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true,  // send httpOnly auth cookie on every request
});

// Request interceptor for logging
apiClient.interceptors.request.use(
  (config) => {
    console.log(`[API ${API_CLIENT_BUILD_STAMP}] ${config.method?.toUpperCase()} ${config.url}`);
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor: redirect to login on 401
apiClient.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    console.error(`[API Error ${API_CLIENT_BUILD_STAMP}]`, error.response?.data || error.message);
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default apiClient;

// Data Sources API
export const dataSourcesApi = {
  getAll: async () => {
    const response = await apiClient.get('/datasources/');
    return response.data;
  },

  getById: async (id: number) => {
    const response = await apiClient.get(`/datasources/${id}`);
    return response.data;
  },

  create: async (payload: any) => {
    const response = await apiClient.post('/datasources/', payload);
    return response.data;
  },
  
  update: async (id: number, payload: any) => {
    const response = await apiClient.put(`/datasources/${id}`, payload);
    return response.data;
  },
  
  delete: async (id: number) => {
    await apiClient.delete(`/datasources/${id}`);
  },
  
  test: async (payload: { type: string; config: Record<string, any> }) => {
    const response = await apiClient.post('/datasources/test', payload);
    return response.data;
  },
  
  executeQuery: async (payload: { data_source_id: number; sql_query: string; limit?: number; timeout_seconds?: number }) => {
    const response = await apiClient.post('/datasources/query', payload);
    return response.data;
  },
};
// Auth API
export const authApi = {
  login: async (email: string, password: string) => {
    const response = await apiClient.post('/auth/login', { email, password });
    return response.data;
  },

  me: async () => {
    const response = await apiClient.get('/auth/me');
    return response.data;
  },

  changePassword: async (old_password: string, new_password: string) => {
    await apiClient.post('/auth/change-password', { old_password, new_password });
  },

  updatePreferences: async (payload: { preferred_language: 'en' | 'vi' }) => {
    const response = await apiClient.patch('/auth/preferences', payload);
    return response.data;
  },

  logout: async () => {
    // Call the Next.js proxy so the cookie is cleared on the same origin
    await fetch('/api/auth/logout', { method: 'POST' });
  },
};

// Permissions API
export const permissionsApi = {
  getMatrix: async () => {
    const response = await apiClient.get('/permissions/matrix');
    return response.data;
  },

  getMyPermissions: async () => {
    const response = await apiClient.get('/permissions/me');
    return response.data;
  },

  getPresets: async () => {
    const response = await apiClient.get('/permissions/presets');
    return response.data;
  },

  updateUserPermissions: async (userId: string, permissions: Record<string, string>) => {
    const response = await apiClient.put(`/permissions/${userId}`, { permissions });
    return response.data;
  },

  applyPreset: async (userId: string, preset: string) => {
    const response = await apiClient.put(`/permissions/${userId}/preset`, { preset });
    return response.data;
  },
};

// Users API
export const usersApi = {
  getAll: async () => {
    const response = await apiClient.get('/users/');
    return response.data;
  },

  getShareable: async () => {
    const response = await apiClient.get('/users/shareable');
    return response.data;
  },

  getById: async (id: string) => {
    const response = await apiClient.get(`/users/${id}`);
    return response.data;
  },

  create: async (payload: { email: string; full_name: string; password: string }) => {
    const response = await apiClient.post('/users/', payload);
    return response.data;
  },

  update: async (id: string, payload: { status?: string }) => {
    const response = await apiClient.put(`/users/${id}`, payload);
    return response.data;
  },

  deactivate: async (id: string) => {
    await apiClient.delete(`/users/${id}`);
  },
};

// Shares API
export const sharesApi = {
  getShares: async (resourceType: string, resourceId: number | string) => {
    const response = await apiClient.get(`/shares/${resourceType}/${resourceId}`);
    return response.data;
  },

  share: async (resourceType: string, resourceId: number | string, payload: { user_id: string; permission: string }) => {
    const response = await apiClient.post(`/shares/${resourceType}/${resourceId}`, payload);
    return response.data;
  },

  updateShare: async (resourceType: string, resourceId: number | string, userId: string, payload: { permission: string }) => {
    const response = await apiClient.put(`/shares/${resourceType}/${resourceId}/${userId}`, payload);
    return response.data;
  },

  revokeShare: async (resourceType: string, resourceId: number | string, userId: string) => {
    await apiClient.delete(`/shares/${resourceType}/${resourceId}/${userId}`);
  },

  shareAllTeam: async (resourceType: string, resourceId: number | string, payload: { permission: string }) => {
    const response = await apiClient.post(`/shares/${resourceType}/${resourceId}/all-team`, payload);
    return response.data;
  },
};
