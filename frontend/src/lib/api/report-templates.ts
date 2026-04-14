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

  importExcel: async (file: File, format: 'blocks' | 'sheet' = 'blocks'): Promise<any> => {
    const formData = new FormData();
    formData.append('file', file);
    const response = await apiClient.post(`/report-templates/import-excel?format=${format}`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  },

  exportExcel: async (
    id: number,
    activeFilters: Array<{ filterId: string; value: any }>,
    templateName?: string,
  ): Promise<void> => {
    const response = await apiClient.post(
      `/report-templates/${id}/export-excel`,
      { active_filters: activeFilters },
      { responseType: 'arraybuffer' },
    );
    const blob = new Blob([response.data], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = templateName
      ? `${templateName.replace(/[/\\?%*:|"<>]/g, '_')}.xlsx`
      : `template_${id}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },
};
