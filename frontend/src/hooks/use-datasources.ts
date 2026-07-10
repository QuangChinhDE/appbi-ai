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
    mutationFn: ({
      type,
      config,
      data_source_id,
    }: {
      type: string;
      config: Record<string, any>;
      data_source_id?: number;
    }) => dataSourceApi.test(type, config, data_source_id),
  });
};

export const useExecuteQuery = () => {
  return useMutation({
    mutationFn: (request: QueryExecuteRequest) => dataSourceApi.executeQuery(request),
  });
};

