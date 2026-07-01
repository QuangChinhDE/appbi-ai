/**
 * React Query hooks for charts.
 */
'use client';

import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { chartApi } from '@/lib/api/charts';
import {
  ChartCreate,
  ChartDataContext,
  ChartDryRunCreateRequest,
  ChartListParams,
  ChartMetadataUpsert,
  ChartParameterCreate,
  ChartPreviewDataRequest,
  ChartUpdate,
} from '@/types/api';

export const useCharts = (options?: ChartListParams & { enabled?: boolean }) => {
  const { enabled = true, ...params } = options ?? {};
  return useQuery({
    queryKey: ['charts', params],
    queryFn: () => chartApi.getAll(params),
    enabled,
  });
};

export const useChart = (id: number, options?: { enabled?: boolean }) => {
  const enabled = options?.enabled ?? true;
  return useQuery({
    queryKey: ['charts', id],
    queryFn: () => chartApi.getById(id),
    enabled: !!id && enabled,
  });
};

export const useChartData = (
  id: number,
  filters?: Record<string, unknown>[],
  context: ChartDataContext = 'default',
  options?: { enabled?: boolean; keepPrevious?: boolean },
  granularity?: string,
) => {
  // Serialize filters to a stable string so identical filter payloads share
  // the same cache entry regardless of object-reference identity.
  const filterKey = filters && filters.length > 0 ? JSON.stringify(filters) : null;

  const enabled = options?.enabled ?? true;

  return useQuery({
    // #2 — granularity is part of the key so a viewer date-hierarchy drill
    // (re-bucket at a new grain) fetches fresh data instead of re-serving the
    // prior grain's cached result.
    queryKey: ['charts', id, 'data', context, filterKey, granularity ?? null],
    queryFn: () => chartApi.getData(id, filters, context, granularity),
    enabled: !!id && enabled,
    // keepPrevious — on a filter/grain change the queryKey changes; instead of
    // dropping to a blank skeleton (which made a filtered dashboard "flash
    // empty" for every slow BQ round-trip), serve the PREVIOUS result as a
    // placeholder while the new one loads. The tile dims it + shows a spinner
    // overlay (isFetching), so the user keeps reading real numbers until the
    // fresh data lands. Opt-in so modal/preview flows are unaffected.
    placeholderData: options?.keepPrevious ? keepPreviousData : undefined,
    staleTime: 5 * 60 * 1000,   // 5 min — avoid refetching unchanged chart data
    gcTime: 30 * 60 * 1000,     // 30 min — keep inactive entries longer
    // Retry policy — the tile stays in its LOADING spinner (isLoading) until the
    // query stops retrying, so react-query's default 3× retry meant a failing
    // chart spun "forever": a heavy BQ query that 400s on the 60s timeout was
    // re-attempted 3 more times (~3 min) before the tile's error-state + Retry
    // button could appear. A 4xx (bad/expensive filter, timeout surfaced as
    // 400, missing column) is DETERMINISTIC — retrying can't fix it, only delays
    // the actionable error. So: never retry 4xx; give 5xx/network ONE quick
    // retry then surface the error immediately.
    retry: (failureCount, error) => {
      const status = (error as { response?: { status?: number } } | null)?.response?.status;
      if (typeof status === 'number' && status >= 400 && status < 500) return false;
      return failureCount < 1;
    },
  });
};

export const usePreviewChartData = () => {
  return useMutation({
    mutationFn: (payload: ChartPreviewDataRequest) => chartApi.previewData(payload),
  });
};

export const useCreateChart = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (data: ChartCreate) => chartApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['charts'] });
    },
  });
};

export const useDryRunCreateChart = () => {
  return useMutation({
    mutationFn: (data: ChartDryRunCreateRequest) => chartApi.dryRunCreate(data),
  });
};

export const useUpdateChart = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: ChartUpdate }) =>
      chartApi.update(id, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['charts'] });
      queryClient.invalidateQueries({ queryKey: ['charts', variables.id] });
    },
  });
};

export const useDeleteChart = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (id: number) => chartApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['charts'] });
    },
  });
};

export const useUpsertChartMetadata = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: ChartMetadataUpsert }) =>
      chartApi.upsertMetadata(id, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['charts'] });
      queryClient.invalidateQueries({ queryKey: ['charts', variables.id] });
    },
  });
};

export const useReplaceChartParameters = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, params }: { id: number; params: ChartParameterCreate[] }) =>
      chartApi.replaceParameters(id, params),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['charts'] });
      queryClient.invalidateQueries({ queryKey: ['charts', variables.id] });
    },
  });
};
