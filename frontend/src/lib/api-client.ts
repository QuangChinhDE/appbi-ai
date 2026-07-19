/**
 * API client for making requests to the backend.
 */
import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';

// NEXT_PUBLIC_API_URL is baked at build time as '/api/v1' (relative).
// Next.js rewrites (localhost) or nginx (/api/ location) proxy it to the backend.
const API_URL = process.env.NEXT_PUBLIC_API_URL || '/api/v1';
const API_CLIENT_BUILD_STAMP = '2026-04-01-001';
const API_DEBUG_LOGGING = process.env.NEXT_PUBLIC_DEBUG_API === 'true';

type RetriableRequestConfig = InternalAxiosRequestConfig & { _retry?: boolean };

let refreshPromise: Promise<boolean> | null = null;

export const apiClient = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true,  // send httpOnly auth cookie on every request
});

function isInteractiveLoginRequest(url?: string): boolean {
  if (!url) return false;
  return url.includes('/auth/login') || url.includes('/auth/google');
}

function buildLoginUrl(): string {
  if (typeof window === 'undefined') return '/login';
  const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (!next || next === '/login') return '/login';
  return `/login?next=${encodeURIComponent(next)}`;
}

export function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  if (window.location.pathname === '/login') return;
  window.location.assign(buildLoginUrl());
}

export async function refreshAuthSession(options?: { redirectOnFailure?: boolean }): Promise<boolean> {
  if (typeof window === 'undefined') return false;

  if (!refreshPromise) {
    refreshPromise = fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    })
      .then((response) => response.ok)
      .catch(() => false)
      .finally(() => {
        refreshPromise = null;
      });
  }

  const refreshed = await refreshPromise;
  if (!refreshed && options?.redirectOnFailure !== false) {
    redirectToLogin();
  }
  return refreshed;
}

// Request interceptor for logging
apiClient.interceptors.request.use(
  (config) => {
    if (API_DEBUG_LOGGING) {
      console.log(`[API ${API_CLIENT_BUILD_STAMP}] ${config.method?.toUpperCase()} ${config.url}`);
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor: transparently refresh once before forcing login.
apiClient.interceptors.response.use(
  (response) => {
    return response;
  },
  async (error: AxiosError) => {
    if (API_DEBUG_LOGGING) {
      console.error(`[API Error ${API_CLIENT_BUILD_STAMP}]`, error.response?.data || error.message);
    }

    if (error.response?.status !== 401 || typeof window === 'undefined') {
      return Promise.reject(error);
    }

    const originalRequest = error.config as RetriableRequestConfig | undefined;
    if (!originalRequest || isInteractiveLoginRequest(originalRequest.url)) {
      return Promise.reject(error);
    }

    if (originalRequest._retry) {
      redirectToLogin();
      return Promise.reject(error);
    }

    const refreshed = await refreshAuthSession();
    if (!refreshed) {
      return Promise.reject(error);
    }

    originalRequest._retry = true;
    return apiClient(originalRequest);
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

  loginWithGoogle: async (credential: string) => {
    const response = await apiClient.post('/auth/google', { credential });
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

export interface PersonalAccessTokenRecord {
  id: string;
  name: string;
  token_hint: string;
  scopes: Record<string, string>;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersonalAccessTokenCreateResponse {
  token: string;
  item: PersonalAccessTokenRecord;
}

export interface AdminPersonalAccessTokenRecord extends PersonalAccessTokenRecord {
  owner_id: string;
  owner_email: string;
  owner_name: string;
}

export interface PersonalAccessTokenUpsertPayload {
  name: string;
  scopes: Record<string, string>;
  expires_in_days?: number | null;
}

export const personalAccessTokensApi = {
  list: async (): Promise<PersonalAccessTokenRecord[]> => {
    const response = await apiClient.get('/auth/personal-access-tokens/');
    return response.data;
  },

  create: async (payload: PersonalAccessTokenUpsertPayload): Promise<PersonalAccessTokenCreateResponse> => {
    const response = await apiClient.post('/auth/personal-access-tokens/', payload);
    return response.data;
  },

  update: async (tokenId: string, payload: PersonalAccessTokenUpsertPayload): Promise<PersonalAccessTokenRecord> => {
    const response = await apiClient.put(`/auth/personal-access-tokens/${tokenId}`, payload);
    return response.data;
  },

  revoke: async (tokenId: string) => {
    await apiClient.delete(`/auth/personal-access-tokens/${tokenId}`);
  },

  deletePermanently: async (tokenId: string) => {
    await apiClient.delete(`/auth/personal-access-tokens/${tokenId}/permanent`);
  },

  // Admin oversight (settings=full): every user's tokens + revoke any.
  adminList: async (): Promise<AdminPersonalAccessTokenRecord[]> => {
    const response = await apiClient.get('/auth/personal-access-tokens/admin');
    return response.data;
  },

  adminRevoke: async (tokenId: string) => {
    await apiClient.delete(`/auth/personal-access-tokens/admin/${tokenId}`);
  },
};

// Permissions API
export const permissionsApi = {
  getMatrix: async () => {
    const response = await apiClient.get('/permissions/matrix');
    return response.data;
  },

  getTeams: async () => {
    const response = await apiClient.get('/permissions/teams');
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

  createTeam: async (payload: { name: string; description?: string; member_ids: string[] }) => {
    const response = await apiClient.post('/permissions/teams', payload);
    return response.data;
  },

  updateTeam: async (teamId: string, payload: { name: string; description?: string; member_ids: string[] }) => {
    const response = await apiClient.put(`/permissions/teams/${teamId}`, payload);
    return response.data;
  },

  deleteTeam: async (teamId: string) => {
    await apiClient.delete(`/permissions/teams/${teamId}`);
  },
};

export const teamsApi = {
  getShareable: async (resourceType: string, resourceId: number | string) => {
    const response = await apiClient.get('/teams/shareable', {
      params: {
        resource_type: resourceType,
        resource_id: String(resourceId),
      },
    });
    return response.data;
  },
};

// Users API
export const usersApi = {
  getAll: async () => {
    const response = await apiClient.get('/users/');
    return response.data;
  },

  getShareable: async (resourceType: string, resourceId: number | string) => {
    const response = await apiClient.get('/users/shareable', {
      params: {
        resource_type: resourceType,
        resource_id: String(resourceId),
      },
    });
    return response.data;
  },

  getById: async (id: string) => {
    const response = await apiClient.get(`/users/${id}`);
    return response.data;
  },

  create: async (payload: {
    email: string;
    full_name: string;
    auth_provider: 'password' | 'google';
    password?: string;
    team_ids?: string[];
  }) => {
    const response = await apiClient.post('/users/', payload);
    return response.data;
  },

  update: async (id: string, payload: { status?: string; team_ids?: string[] }) => {
    const response = await apiClient.put(`/users/${id}`, payload);
    return response.data;
  },

  deactivate: async (id: string) => {
    await apiClient.delete(`/users/${id}`);
  },

  deletionImpact: async (id: string): Promise<UserDeletionImpact> => {
    const response = await apiClient.get(`/users/${id}/deletion-impact`);
    return response.data;
  },

  deletePermanently: async (id: string) => {
    await apiClient.delete(`/users/${id}/permanent`);
  },
};

export interface UserDeletionImpact {
  status: string;
  counts: Record<string, number>;
  total_owned: number;
  reassign_to_email: string;
}

// Shares API
export const sharesApi = {
  getShares: async (resourceType: string, resourceId: number | string) => {
    const response = await apiClient.get(`/shares/${resourceType}/${resourceId}`);
    return response.data;
  },

  share: async (
    resourceType: string,
    resourceId: number | string,
    payload: { user_id?: string; email?: string; team_id?: string; permission: string },
  ) => {
    const response = await apiClient.post(`/shares/${resourceType}/${resourceId}`, payload);
    return response.data;
  },

  updateShareEntry: async (resourceType: string, resourceId: number | string, shareId: number, payload: { permission: string }) => {
    const response = await apiClient.put(`/shares/${resourceType}/${resourceId}/entries/${shareId}`, payload);
    return response.data;
  },

  revokeShareEntry: async (resourceType: string, resourceId: number | string, shareId: number) => {
    await apiClient.delete(`/shares/${resourceType}/${resourceId}/entries/${shareId}`);
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
