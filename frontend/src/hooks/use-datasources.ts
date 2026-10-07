/**
 * React Query hooks for data sources.
 */
'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { dataSourceApi } from '@/lib/api/datasources';
import { sortByUpdatedAtDesc } from '@/lib/sort';
import {
  DataSourceCreate,
  DataSourceUpdate,
  QueryExecuteRequest,
} from '@/types/api';

export const useDataSources = () => {
  return useQuery({
    queryKey: ['datasources'],
    queryFn: dataSourceApi.getAll,
    select: (dataSources) => sortByUpdatedAtDesc(dataSources),
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
    onSuccess: (_data: unknown, variables: { id: number; data: DataSourceUpdate }) => {
      queryClient.invalidateQueries({ queryKey: ['datasources'] });
      queryClient.invalidateQueries({ queryKey: ['datasources', variables.id] });
    },
    onError: (error: any, variables: { id: number; data: DataSourceUpdate }) => {
      // 409 source_conflict: someone else saved this source since it was
      // loaded. Reload it so the next save starts from the current version.
      if (error?.response?.status === 409 && error?.response?.data?.detail?.code === 'source_conflict') {
        queryClient.invalidateQueries({ queryKey: ['datasources', variables.id] });
      }
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
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: number }) => dataSourceApi.test(id),
    // A saved-source test persists last health on the source.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['datasources'] });
    },
  });
};

export const useExecuteQuery = () => {
  return useMutation({
    mutationFn: (request: QueryExecuteRequest) => dataSourceApi.executeQuery(request),
  });
};

