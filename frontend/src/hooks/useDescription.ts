/**
 * React Query hooks for AI-generated description endpoints.
 */
'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from '@/lib/api-client';

export type DescriptionGenerationStatus =
  | 'idle'
  | 'queued'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'stale';

export interface TableDescription {
  auto_description: string | null;
  column_descriptions: Record<string, string> | null;
  common_questions: string[] | null;
  query_aliases: string[] | null;
  description_source: 'auto' | 'user' | 'feedback' | null;
  description_updated_at: string | null;
  schema_change_pending: boolean | null;
  generation_status: DescriptionGenerationStatus | null;
  generation_error: string | null;
  generation_requested_at: string | null;
  generation_finished_at: string | null;
  stale_reason: string | null;
}

export interface ChartDescription {
  auto_description: string | null;
  insight_keywords: string[] | null;
  common_questions: string[] | null;
  query_aliases: string[] | null;
  description_source: 'auto' | 'user' | 'feedback' | null;
  description_updated_at: string | null;
  generation_status: DescriptionGenerationStatus | null;
  generation_error: string | null;
  generation_requested_at: string | null;
  generation_finished_at: string | null;
  stale_reason: string | null;
}

export function useTableDescription(datasetId: number | null, tableId: number | null) {
  return useQuery<TableDescription>({
    queryKey: ['table-description', datasetId, tableId],
    queryFn: async () => {
      const res = await apiClient.get(
        `/datasets/${datasetId}/tables/${tableId}/description`
      );
      return res.data;
    },
    enabled: !!datasetId && !!tableId,
    staleTime: 5_000,
    refetchOnMount: 'always',
  });
}

export function useUpdateTableDescription(datasetId: number, tableId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<TableDescription>) =>
      apiClient
        .put(`/datasets/${datasetId}/tables/${tableId}/description`, body)
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['table-description', datasetId, tableId] });
    },
  });
}

export function useRegenerateTableDescription(datasetId: number, tableId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiClient
        .post(`/datasets/${datasetId}/tables/${tableId}/description/regenerate`, {})
        .then((r) => r.data),
    onSuccess: () => {
      // Invalidate after a short delay to give background task time to start
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['table-description', datasetId, tableId] });
      }, 3000);
    },
  });
}

export function useChartDescription(chartId: number | null) {
  return useQuery<ChartDescription>({
    queryKey: ['chart-description', chartId],
    queryFn: async () => {
      const res = await apiClient.get(`/charts/${chartId}/description`);
      return res.data;
    },
    enabled: !!chartId,
    staleTime: 5_000,
    refetchOnMount: 'always',
  });
}

export function useUpdateChartDescription(chartId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<ChartDescription>) =>
      apiClient.put(`/charts/${chartId}/description`, body).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chart-description', chartId] });
    },
  });
}

export function useRegenerateChartDescription(chartId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiClient.post(`/charts/${chartId}/description/regenerate`, {}).then((r) => r.data),
    onSuccess: () => {
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['chart-description', chartId] });
      }, 3000);
    },
  });
}
