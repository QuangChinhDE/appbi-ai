import { useMutation, useQueryClient } from '@tanstack/react-query';
import { reportTemplateApi } from '@/lib/api/report-templates';
import type { AnalysisResponse, ImportConfirmPayload, ImportConfirmResponse } from '@/types/import-analysis';

export function useImportAnalyze() {
  return useMutation<AnalysisResponse, Error, { file: File; sheetName?: string }>({
    mutationFn: ({ file, sheetName }) => reportTemplateApi.importAnalyze(file, sheetName),
  });
}

export function useImportConfirm() {
  const queryClient = useQueryClient();
  return useMutation<ImportConfirmResponse, Error, ImportConfirmPayload>({
    mutationFn: (data) => reportTemplateApi.importConfirm(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['report-templates'] });
    },
  });
}
