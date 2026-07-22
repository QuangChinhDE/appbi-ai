/**
 * React Query hooks for the Workboard module.
 */
'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  Workboard,
  WorkboardCreateInput,
  WorkboardImportInput,
  WorkboardImportResponse,
  WorkboardUpdateInput,
  workboardApi,
} from '@/lib/api/workboards';
import { sortByUpdatedAtDesc } from '@/lib/sort';

const KEYS = {
  all: ['workboards'] as const,
  detail: (id: number) => ['workboards', id] as const,
};

export function useWorkboards() {
  return useQuery({
    queryKey: KEYS.all,
    queryFn: workboardApi.list,
    select: (items) => sortByUpdatedAtDesc(items),
  });
}

export function useWorkboard(id: number | null | undefined) {
  return useQuery({
    queryKey: KEYS.detail(id ?? 0),
    queryFn: () => workboardApi.getById(id as number),
    enabled: !!id,
  });
}

/** Readiness audit for the App-health panel — the same gate Publish runs.
 * Kept fresh (no long stale window) so a fix in the builder reflects quickly. */
export function useWorkboardReadinessAudit(id: number | null | undefined) {
  return useQuery({
    queryKey: [...KEYS.detail(id ?? 0), 'audit'] as const,
    queryFn: () => workboardApi.getReadinessAudit(id as number),
    enabled: !!id,
    staleTime: 0,
  });
}

export function useCreateWorkboard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WorkboardCreateInput) => workboardApi.create(input),
    onSuccess: (created) => {
      qc.setQueryData<Workboard[]>(KEYS.all, (old) =>
        old ? [created, ...old] : [created],
      );
    },
  });
}

export function useImportWorkboard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: WorkboardImportInput) => workboardApi.importTemplate(input),
    onSuccess: (created: WorkboardImportResponse) => {
      qc.setQueryData<Workboard[]>(KEYS.all, (old) => {
        const current = old ?? [];
        const withoutDuplicate = current.filter((item) => item.id !== created.id);
        return [created, ...withoutDuplicate];
      });
      qc.invalidateQueries({ queryKey: KEYS.all });
    },
  });
}

export function useUpdateWorkboard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: WorkboardUpdateInput }) =>
      workboardApi.update(id, data),
    onSuccess: (_, variables) => {
      qc.invalidateQueries({ queryKey: KEYS.all });
      qc.invalidateQueries({ queryKey: KEYS.detail(variables.id) });
    },
  });
}

export function useDeleteWorkboard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => workboardApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.all });
    },
  });
}

export function usePublishWorkboard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => workboardApi.publish(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: KEYS.detail(id) });
      qc.invalidateQueries({ queryKey: KEYS.all });
    },
  });
}

export function useUnpublishWorkboard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => workboardApi.unpublish(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: KEYS.detail(id) });
      qc.invalidateQueries({ queryKey: KEYS.all });
    },
  });
}
