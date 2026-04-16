import { useMutation, useQueryClient } from '@tanstack/react-query';
import { reportTemplateApi } from '@/lib/api/report-templates';
import type { AnalysisResponse, ImportConfirmPayload, ImportConfirmResponse } from '@/types/import-analysis';

export function useImportAnalyze() {
  return useMutation<AnalysisResponse, Error, { file: File; sheetName?: string; aiEnhance?: boolean }>({
    mutationFn: ({ file, sheetName, aiEnhance }) => reportTemplateApi.importAnalyze(file, sheetName, aiEnhance),
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
