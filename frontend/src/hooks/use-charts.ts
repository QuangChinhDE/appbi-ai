/**
 * React Query hooks for charts.
 */
'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { chartApi } from '@/lib/api/charts';
import { ChartCreate, ChartUpdate, ChartMetadataUpsert, ChartParameterCreate } from '@/types/api';

export const useCharts = () => {
  return useQuery({
    queryKey: ['charts'],
    queryFn: chartApi.getAll,
  });
};

export const useChart = (id: number) => {
  return useQuery({
    queryKey: ['charts', id],
    queryFn: () => chartApi.getById(id),
    enabled: !!id,
  });
};

export const useChartData = (id: number) => {
  return useQuery({
    queryKey: ['charts', id, 'data'],
    queryFn: () => chartApi.getData(id),
    enabled: !!id,
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
