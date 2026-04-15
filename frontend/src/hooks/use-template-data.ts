'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient as api } from '@/lib/api-client';
import { datasetKeys, type TablePreviewResponse } from '@/hooks/use-datasets';
import type { TemplateDataSource, TemplateColumn } from '@/types/template';

const PREVIEW_LIMIT = 1000;

/**
 * Fetch rows from the bound dataset table for template preview.
 */
export function useTemplateData(
  dataSource?: TemplateDataSource | null,
  enabled = true,
) {
  return useQuery<TablePreviewResponse>({
    queryKey: [
      ...datasetKeys.tablePreview(dataSource?.datasetId ?? 0, dataSource?.tableId ?? 0),
      'template',
    ],
    queryFn: async () => {
      const resp = await api.post<TablePreviewResponse>(
        `/datasets/${dataSource!.datasetId}/tables/${dataSource!.tableId}/preview`,
        { limit: PREVIEW_LIMIT },
      );
      return resp.data;
    },
    enabled: enabled && !!dataSource?.datasetId && !!dataSource?.tableId,
  });
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
