/**
 * React Query hooks for report templates.
 */
'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { reportTemplateApi } from '@/lib/api/report-templates';
import { sortByUpdatedAtDesc } from '@/lib/sort';
import type { ReportTemplateCreate, ReportTemplateUpdate } from '@/types/template';

export const templateKeys = {
  all: ['report-templates'] as const,
  detail: (id: number) => ['report-templates', id] as const,
};

export const useReportTemplates = () => {
  return useQuery({
    queryKey: templateKeys.all,
    queryFn: reportTemplateApi.getAll,
    select: (templates) => sortByUpdatedAtDesc(templates),
  });
};

export const useReportTemplate = (id: number) => {
  return useQuery({
    queryKey: templateKeys.detail(id),
    queryFn: () => reportTemplateApi.getById(id),
    enabled: !!id,
  });
};

export const useCreateReportTemplate = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ReportTemplateCreate) => reportTemplateApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: templateKeys.all });
    },
  });
};

export const useUpdateReportTemplate = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: ReportTemplateUpdate }) =>
      reportTemplateApi.update(id, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: templateKeys.all });
      queryClient.invalidateQueries({ queryKey: templateKeys.detail(variables.id) });
    },
  });
};

export const useDeleteReportTemplate = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => reportTemplateApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: templateKeys.all });
    },
  });
};
