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
  WorkboardRenderViewRequest,
  WorkboardRowsRequest,
  WorkboardUpdateInput,
  workboardApi,
} from '@/lib/api/workboards';
import { sortByUpdatedAtDesc } from '@/lib/sort';

const KEYS = {
  all: ['workboards'] as const,
  detail: (id: number) => ['workboards', id] as const,
  form: (id: number) => ['workboards', id, 'form'] as const,
  rows: (id: number, req: WorkboardRowsRequest) =>
    ['workboards', id, 'rows', req] as const,
  doc: (id: number, viewId: string) =>
    ['workboards', id, 'doc', viewId] as const,
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

export function useWorkboardForm(id: number | null | undefined) {
  return useQuery({
    queryKey: KEYS.form(id ?? 0),
    queryFn: () => workboardApi.getFormSpec(id as number),
    enabled: !!id,
  });
}

export function useWorkboardRows(
  id: number | null | undefined,
  req: WorkboardRowsRequest = {},
) {
  return useQuery({
    queryKey: KEYS.rows(id ?? 0, req),
    queryFn: () => workboardApi.listRows(id as number, req),
    enabled: !!id,
  });
}

export function useInsertWorkboardRow(workboardId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      workboardApi.insertRow(workboardId, values),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workboards', workboardId, 'rows'] });
    },
  });
}

export function useUpdateWorkboardRow(workboardId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      pk: Record<string, unknown>;
      values: Record<string, unknown>;
      lock_token?: unknown;
    }) => workboardApi.updateRow(workboardId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workboards', workboardId, 'rows'] });
    },
  });
}

export function useDeleteWorkboardRow(workboardId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { pk: Record<string, unknown>; lock_token?: unknown }) =>
      workboardApi.deleteRow(workboardId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workboards', workboardId, 'rows'] });
    },
  });
}

export function useWorkboardDoc(
  id: number | null | undefined,
  viewId: string | null | undefined,
) {
  return useQuery({
    queryKey: KEYS.doc(id ?? 0, viewId ?? ''),
    queryFn: () => workboardApi.renderDoc(id as number, viewId as string),
    enabled: !!id && !!viewId,
  });
}

// ---------------------------------------------------------------------------
// v2 — multi-view runtime
// ---------------------------------------------------------------------------

export function useWorkboardV2Views(id: number | null | undefined) {
  return useQuery({
    queryKey: ['workboards', id ?? 0, 'v2', 'views'],
    queryFn: () => workboardApi.listV2Views(id as number),
    enabled: !!id,
  });
}

export function useRenderV2View(
  id: number | null | undefined,
  viewId: string | null | undefined,
  body: WorkboardRenderViewRequest = {},
) {
  return useQuery({
    queryKey: ['workboards', id ?? 0, 'v2', 'render', viewId ?? '', body],
    queryFn: () =>
      workboardApi.renderV2View(id as number, viewId as string, body),
    enabled: !!id && !!viewId,
  });
}

export function useExecuteV2Action(workboardId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      actionId,
      pk,
    }: {
      actionId: string;
      pk?: Record<string, unknown>;
    }) => workboardApi.executeV2Action(workboardId, actionId, { pk }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workboards', workboardId, 'v2'] });
      qc.invalidateQueries({ queryKey: ['workboards', workboardId, 'rows'] });
    },
  });
}
