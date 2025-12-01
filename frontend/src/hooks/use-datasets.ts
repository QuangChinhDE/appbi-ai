/**
 * React Query hooks for datasets.
 */
'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { datasetApi } from '@/lib/api/datasets';
import { DatasetCreate, DatasetUpdate } from '@/types/api';

export const useDatasets = () => {
  return useQuery({
    queryKey: ['datasets'],
    queryFn: datasetApi.getAll,
  });
};

export const useDataset = (id: number) => {
  return useQuery({
    queryKey: ['datasets', id],
    queryFn: () => datasetApi.getById(id),
    enabled: !!id,
  });
};

export const useCreateDataset = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (data: DatasetCreate) => datasetApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['datasets'] });
    },
  });
};

export const useUpdateDataset = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: DatasetUpdate }) =>
      datasetApi.update(id, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['datasets'] });
      queryClient.invalidateQueries({ queryKey: ['datasets', variables.id] });
    },
  });
};

export const useDeleteDataset = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (id: number) => datasetApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['datasets'] });
    },
  });
};

export const useExecuteDataset = () => {
  return useMutation({
    mutationFn: ({ id, limit }: { id: number; limit?: number }) =>
      datasetApi.execute(id, limit),
  });
};
