'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { agentReportSpecsApi } from '@/lib/api/agent-report-specs';
import { AgentReportRunCreate, AgentReportSpecCreate, AgentReportSpecUpdate } from '@/types/agent';

export const agentReportSpecKeys = {
  all: ['agent-report-specs'] as const,
  lists: () => [...agentReportSpecKeys.all, 'list'] as const,
  detail: (id: number) => [...agentReportSpecKeys.all, 'detail', id] as const,
  runs: (id: number) => [...agentReportSpecKeys.all, 'runs', id] as const,
};

export function useAgentReportSpecs(enabled = true) {
  return useQuery({
    queryKey: agentReportSpecKeys.lists(),
    queryFn: agentReportSpecsApi.getAll,
    enabled,
  });
}

export function useAgentReportSpec(id: number | null) {
  return useQuery({
    queryKey: agentReportSpecKeys.detail(id!),
    queryFn: () => agentReportSpecsApi.getById(id!),
    enabled: id !== null,
  });
}

export function useCreateAgentReportSpec() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: AgentReportSpecCreate) => agentReportSpecsApi.create(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: agentReportSpecKeys.lists() });
    },
  });
}

export function useUpdateAgentReportSpec() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: AgentReportSpecUpdate }) =>
      agentReportSpecsApi.update(id, payload),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: agentReportSpecKeys.lists() });
      queryClient.invalidateQueries({ queryKey: agentReportSpecKeys.detail(variables.id) });
    },
  });
}

export function useCreateAgentReportRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: AgentReportRunCreate }) =>
      agentReportSpecsApi.createRun(id, payload),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: agentReportSpecKeys.runs(variables.id) });
      queryClient.invalidateQueries({ queryKey: agentReportSpecKeys.detail(variables.id) });
    },
  });
}
