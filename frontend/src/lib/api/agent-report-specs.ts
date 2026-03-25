import apiClient from '@/lib/api-client';
import {
  AgentReportRun,
  AgentReportRunCreate,
  AgentReportSpec,
  AgentReportSpecCreate,
  AgentReportSpecDetail,
  AgentReportSpecUpdate,
} from '@/types/agent';

export const agentReportSpecsApi = {
  getAll: async (): Promise<AgentReportSpec[]> => {
    const response = await apiClient.get('/agent-report-specs/');
    return response.data;
  },

  getById: async (id: number): Promise<AgentReportSpecDetail> => {
    const response = await apiClient.get(`/agent-report-specs/${id}`);
    return response.data;
  },

  create: async (payload: AgentReportSpecCreate): Promise<AgentReportSpec> => {
    const response = await apiClient.post('/agent-report-specs/', payload);
    return response.data;
  },

  update: async (id: number, payload: AgentReportSpecUpdate): Promise<AgentReportSpec> => {
    const response = await apiClient.put(`/agent-report-specs/${id}`, payload);
    return response.data;
  },

  remove: async (id: number): Promise<void> => {
    await apiClient.delete(`/agent-report-specs/${id}`);
  },

  listRuns: async (id: number): Promise<AgentReportRun[]> => {
    const response = await apiClient.get(`/agent-report-specs/${id}/runs`);
    return response.data;
  },

  createRun: async (id: number, payload: AgentReportRunCreate): Promise<AgentReportRun> => {
    const response = await apiClient.post(`/agent-report-specs/${id}/runs`, payload);
    return response.data;
  },
};
