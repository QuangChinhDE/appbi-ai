'use client';

import { useQuery } from '@tanstack/react-query';
import type { AxiosError } from 'axios';
import { apiClient as api } from '@/lib/api-client';
import { datasetKeys, type TablePreviewResponse } from '@/hooks/use-datasets';
import type {
  TemplateActiveFilterValue,
  TemplateColumn,
  TemplateDefinition,
  TemplateDocumentDefinition,
  TemplateDocumentRuntimePreviewResponse,
  TemplateFilter,
} from '@/types/template';

const PREVIEW_LIMIT = 1000;

export interface TemplatePreviewFormulaError {
  key: string;
  error: string;
}

interface TemplatePreviewErrorDetail {
  message?: string;
  column_errors?: TemplatePreviewFormulaError[];
}

interface TemplatePreviewErrorResponse {
  detail?: string | TemplatePreviewErrorDetail;
}

interface TemplateDocumentRuntimeErrorResponse {
  detail?: string | { message?: string };
}

function parseTemplatePreviewError(
  error: AxiosError<TemplatePreviewErrorResponse> | null,
): { previewErrorMessage: string | null; formulaErrors: TemplatePreviewFormulaError[] } {
  if (!error) {
    return { previewErrorMessage: null, formulaErrors: [] };
  }

  const detail = error.response?.data?.detail;
  if (typeof detail === 'string') {
    return {
      previewErrorMessage: detail,
      formulaErrors: [],
    };
  }

  if (detail && typeof detail === 'object') {
    return {
      previewErrorMessage: detail.message ?? 'Khong the xem truoc du lieu template.',
      formulaErrors: Array.isArray(detail.column_errors) ? detail.column_errors : [],
    };
  }

  return {
    previewErrorMessage: error.message || 'Khong the xem truoc du lieu template.',
    formulaErrors: [],
  };
}

function parseTemplateDocumentRuntimeError(
  error: AxiosError<TemplateDocumentRuntimeErrorResponse> | null,
): string | null {
  if (!error) {
    return null;
  }

  const detail = error.response?.data?.detail;
  if (typeof detail === 'string') {
    return detail;
  }
  if (detail && typeof detail === 'object' && typeof detail.message === 'string' && detail.message.trim()) {
    return detail.message;
  }
  return error.message || 'Khong the tai runtime preview cua document template.';
}

/**
 * Fetch rows from the bound dataset table for template preview.
 */
type TemplatePreviewDefinition = Pick<TemplateDefinition, 'dataSource' | 'columns'> & {
  templateId?: number;
  templateFilters?: TemplateFilter[];
  activeFilters?: TemplateActiveFilterValue[];
};

export function useTemplateData(
  definition?: TemplatePreviewDefinition | null,
  enabled = true,
) {
  const query = useQuery<TablePreviewResponse, AxiosError<TemplatePreviewErrorResponse>>({
    queryKey: [
      ...datasetKeys.tablePreview(definition?.dataSource?.datasetId ?? 0, definition?.dataSource?.tableId ?? 0),
      'template',
      definition?.templateId ?? null,
      (definition?.columns ?? []).map((col) => ({
        key: col.key,
        type: col.type,
        sourceColumn: col.sourceColumn ?? null,
        expression: col.expression ?? null,
      })),
      (definition?.templateFilters ?? []).map((filter) => ({
        id: filter.id,
        datasetId: filter.datasetId,
        tableId: filter.tableId,
        column: filter.column,
        operator: filter.operator,
        defaultValue: filter.defaultValue ?? null,
      })),
      (definition?.activeFilters ?? []).map((filter) => ({
        filterId: filter.filterId,
        value: filter.value ?? null,
      })),
    ],
    queryFn: async () => {
      const resp = await api.post<TablePreviewResponse>(
        '/report-templates/preview-data',
        {
          templateId: definition?.templateId,
          dataSource: definition!.dataSource,
          columns: definition!.columns,
          templateFilters: definition?.templateFilters ?? [],
          activeFilters: definition?.activeFilters ?? [],
          limit: PREVIEW_LIMIT,
        },
      );
      return resp.data;
    },
    enabled: enabled && !!definition?.dataSource?.datasetId && !!definition?.dataSource?.tableId,
  });

  const { previewErrorMessage, formulaErrors } = parseTemplatePreviewError(query.error);

  return {
    ...query,
    previewErrorMessage,
    formulaErrors,
  };
}

export function useTemplateDocumentRuntime(
  templateId?: number | null,
  definition?: TemplateDocumentDefinition | null,
  enabled = true,
  limit = 8,
) {
  const query = useQuery<TemplateDocumentRuntimePreviewResponse, AxiosError<TemplateDocumentRuntimeErrorResponse>>({
    queryKey: ['report-templates', 'document-runtime', templateId ?? null, definition ?? null, limit],
    queryFn: async () => {
      const resp = await api.post<TemplateDocumentRuntimePreviewResponse>(
        `/report-templates/${templateId}/document-runtime-preview`,
        {
          blocks: definition,
          limit,
        },
      );
      return resp.data;
    },
    enabled: enabled && !!templateId && !!definition,
  });

  return {
    ...query,
    runtimeErrorMessage: parseTemplateDocumentRuntimeError(query.error),
  };
}

/**
 * Evaluate a simple formula expression against a row of data.
 * Supports basic arithmetic: +, -, *, / and column key references.
 */
export function evaluateFormula(
  expression: string,
  row: Record<string, any>,
  columns: TemplateColumn[],
): number | null {
  if (!expression) return null;

  try {
    // Build a context of all known column values
    const ctx: Record<string, number> = {};
    for (const col of columns) {
      const val = col.sourceColumn ? row[col.sourceColumn] : row[col.key];
      ctx[col.key] = typeof val === 'number' ? val : parseFloat(val) || 0;
    }

    // Replace column key references with their numeric values
    let expr = expression;
    // Sort keys by length descending to replace longer keys first
    const keys = Object.keys(ctx).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      expr = expr.replace(new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), String(ctx[key]));
    }

    // Only allow safe chars: digits, decimal point, arithmetic ops, parens, spaces
    if (!/^[\d\s.+\-*/()]+$/.test(expr)) return null;

    // eslint-disable-next-line no-new-func
    const result = new Function(`"use strict"; return (${expr})`)();
    return typeof result === 'number' && isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

/**
 * Format a numeric value according to the column format spec.
 */
export function formatValue(
  value: any,
  format?: string,
  suffix?: string,
): string {
  if (value == null || value === '') return '—';

  const num = typeof value === 'number' ? value : parseFloat(value);
  if (isNaN(num)) return String(value);

  let formatted: string;
  switch (format) {
    case 'integer':
      formatted = Math.round(num).toLocaleString('en-US');
      break;
    case 'decimal':
      formatted = num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      break;
    case 'percentage':
      formatted = `${Math.round(num * 100)}%`;
      break;
    default:
      formatted = typeof value === 'number' ? num.toLocaleString('en-US') : String(value);
  }

  return suffix ? `${formatted} ${suffix}` : formatted;
}
