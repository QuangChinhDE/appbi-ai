/**
 * React Query hooks for data sources.
 */
'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { dataSourceApi } from '@/lib/api/datasources';
import {
  DataSourceCreate,
  DataSourceUpdate,
  QueryExecuteRequest,
} from '@/types/api';

export const useDataSources = () => {
  return useQuery({
    queryKey: ['datasources'],
    queryFn: dataSourceApi.getAll,
  });
};

export const useDataSource = (id: number) => {
  return useQuery({
    queryKey: ['datasources', id],
    queryFn: () => dataSourceApi.getById(id),
    enabled: !!id,
  });
};

export const useCreateDataSource = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (data: DataSourceCreate) => dataSourceApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['datasources'] });
    },
  });
};

export const useUpdateDataSource = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: DataSourceUpdate }) =>
      dataSourceApi.update(id, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['datasources'] });
      queryClient.invalidateQueries({ queryKey: ['datasources', variables.id] });
    },
  });
};

export const useDeleteDataSource = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (id: number) => dataSourceApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['datasources'] });
    },
  });
};

export const useTestDataSource = () => {
  return useMutation({
    mutationFn: ({ type, config }: { type: string; config: Record<string, any> }) =>
      dataSourceApi.test(type, config),
  });
};

export const useExecuteQuery = () => {
  return useMutation({
    mutationFn: (request: QueryExecuteRequest) => dataSourceApi.executeQuery(request),
  });
};
