/**
 * API client for making requests to the backend.
 */
import axios from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000/api/v1';

export const apiClient = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor for logging
apiClient.interceptors.request.use(
  (config) => {
    console.log(`[API] ${config.method?.toUpperCase()} ${config.url}`);
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor for error handling
apiClient.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    console.error('[API Error]', error.response?.data || error.message);
    return Promise.reject(error);
  }
);

export default apiClient;

// Data Sources API
export const dataSourcesApi = {
  getAll: async () => {
    const response = await apiClient.get('/datasources');
    return response.data;
  },
  
  getById: async (id: number) => {
    const response = await apiClient.get(`/datasources/${id}`);
    return response.data;
  },
  
  create: async (payload: any) => {
    const response = await apiClient.post('/datasources', payload);
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
