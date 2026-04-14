/**
 * API functions for report templates.
 */
import apiClient from '@/lib/api-client';
import type {
  ReportTemplate,
  ReportTemplateCreate,
  ReportTemplateUpdate,
} from '@/types/template';

export const reportTemplateApi = {
  getAll: async (): Promise<ReportTemplate[]> => {
    const response = await apiClient.get('/report-templates/');
    return response.data;
  },

  getById: async (id: number): Promise<ReportTemplate> => {
    const response = await apiClient.get(`/report-templates/${id}`);
    return response.data;
  },

  create: async (data: ReportTemplateCreate): Promise<ReportTemplate> => {
    const response = await apiClient.post('/report-templates/', data);
    return response.data;
  },

  update: async (id: number, data: ReportTemplateUpdate): Promise<ReportTemplate> => {
    const response = await apiClient.put(`/report-templates/${id}`, data);
    return response.data;
  },

  delete: async (id: number): Promise<void> => {
    await apiClient.delete(`/report-templates/${id}`);
  },

  importExcel: async (file: File): Promise<any[]> => {
    const formData = new FormData();
    formData.append('file', file);
    const response = await apiClient.post('/report-templates/import-excel', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },
};
