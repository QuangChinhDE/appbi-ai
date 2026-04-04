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
  SyncConfig,
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
    mutationFn: ({ type, config }: { type: string; config: Record<string, any> }) =>
      dataSourceApi.test(type, config),
  });
};

export const useExecuteQuery = () => {
  return useMutation({
    mutationFn: (request: QueryExecuteRequest) => dataSourceApi.executeQuery(request),
  });
};

// ── Schema Browser hooks ──────────────────────────────────────────────────────

export const useDataSourceSchema = (id: number, enabled = true) => {
  return useQuery({
    queryKey: ['datasources', id, 'schema'],
    queryFn: () => dataSourceApi.getSchema(id),
    enabled: !!id && enabled,
    staleTime: 30_000,
  });
};

export const useTableDetail = (
  id: number,
  schemaName: string,
  tableName: string,
  previewRows = 5,
) => {
  return useQuery({
    queryKey: ['datasources', id, 'table', schemaName, tableName],
    queryFn: () => dataSourceApi.getTableDetail(id, schemaName, tableName, previewRows),
    enabled: !!id && !!schemaName && !!tableName,
    staleTime: 15_000,
  });
};

export const useWatermarkCandidates = (
  id: number,
  schemaName: string,
  tableName: string,
) => {
  return useQuery({
    queryKey: ['datasources', id, 'watermarks', schemaName, tableName],
    queryFn: () => dataSourceApi.getWatermarkCandidates(id, schemaName, tableName),
    enabled: !!id && !!schemaName && !!tableName,
    staleTime: 30_000,
  });
};

// ── Sync Config hooks ─────────────────────────────────────────────────────────

export const useSyncConfig = (id: number) => {
  return useQuery({
    queryKey: ['datasources', id, 'sync-config'],
    queryFn: () => dataSourceApi.getSyncConfig(id),
    enabled: !!id,
  });
};

export const useSaveSyncConfig = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, config }: { id: number; config: SyncConfig }) =>
      dataSourceApi.saveSyncConfig(id, config),
    onSuccess: (_data: unknown, variables: { id: number; config: SyncConfig }) => {
      queryClient.invalidateQueries({ queryKey: ['datasources', variables.id, 'sync-config'] });
    },
  });
};

// ── Sync Jobs hooks ───────────────────────────────────────────────────────────

export const useSyncJobs = (id: number, limit = 10) => {
  return useQuery({
    queryKey: ['datasources', id, 'sync-jobs', limit],
    queryFn: () => dataSourceApi.getSyncJobs(id, limit),
    enabled: !!id,
    refetchInterval: 10_000, // poll while running jobs may update
  });
};

export const useTriggerSync = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => dataSourceApi.triggerSync(id),
    onSuccess: (_data: unknown, id: number) => {
      queryClient.invalidateQueries({ queryKey: ['datasources', id, 'sync-jobs'] });
      // Clear cached preview errors so the dataset page retries automatically
      // once the background sync thread finishes writing the DuckDB views.
      queryClient.invalidateQueries({ queryKey: ['datasets'] });
      queryClient.invalidateQueries({ queryKey: ['table-preview'] });
    },
  });
};

export const useCancelSync = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ dsId, jobId }: { dsId: number; jobId: number }) =>
      dataSourceApi.cancelSync(dsId, jobId),
    onSuccess: (_data: unknown, { dsId }: { dsId: number; jobId: number }) => {
      queryClient.invalidateQueries({ queryKey: ['datasources', dsId, 'sync-jobs'] });
    },
  });
};
