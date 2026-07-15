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

export interface TableDescriptionPreview {
  description: string;
  column_descriptions: Record<string, string>;
  common_questions: string[];
}

export function usePreviewTableDescription(datasetId: number, tableId: number) {
  return useMutation<TableDescriptionPreview>({
    mutationFn: () =>
      apiClient
        .post(`/datasets/${datasetId}/tables/${tableId}/description/preview`, {})
        .then((r) => r.data),
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
