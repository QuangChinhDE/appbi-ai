'use client';

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';

import { apiClient as api } from '@/lib/api-client';
import { datasetKeys, type TablePreviewResponse } from '@/hooks/use-datasets';
import type {
  CellValue,
  DataFieldBinding,
  TableConfig,
  TemplateBlock,
  TemplateFilter,
} from '@/types/template';
import { isDataField, isFormula } from '@/types/template';
import { getRepeatingRowSource } from '@/lib/templateUtils';

const PREVIEW_LIMIT = 1000;

type RuntimeSourceRef = {
  key: string;
  datasetId: number;
  tableId: number;
};

type RuntimeSource = RuntimeSourceRef & TablePreviewResponse;
type RuntimeSourceMap = Map<string, RuntimeSource>;
type RowContextMap = Record<string, Record<string, any> | undefined>;

function runtimeSourceKey(binding: { datasetId: number; tableId: number }) {
  return `${binding.datasetId}:${binding.tableId}`;
}

function collectValueBindings(value: unknown, bindings: DataFieldBinding[]) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectValueBindings(entry, bindings));
    return;
  }

  if (isDataField(value as CellValue)) {
    bindings.push(value as DataFieldBinding);
  }
}

function collectBlockBindings(block: TemplateBlock, bindings: DataFieldBinding[]) {
  if (block.type === 'text') {
    collectValueBindings((block.config as { content?: unknown }).content, bindings);
    return;
  }

  if (block.type === 'table') {
    const tableConfig = block.config as Partial<TableConfig>;
    tableConfig.rows?.forEach((row) => {
      row.cells.forEach((cell) => collectValueBindings(cell.value, bindings));
    });
  }
}

function getRuntimeSources(blocks: TemplateBlock[]): RuntimeSourceRef[] {
  const bindings: DataFieldBinding[] = [];
  blocks.forEach((block) => collectBlockBindings(block, bindings));

  const unique = new Map<string, RuntimeSourceRef>();
  bindings.forEach((binding) => {
    const key = runtimeSourceKey(binding);
    if (!unique.has(key)) {
      unique.set(key, {
        key,
        datasetId: binding.datasetId,
        tableId: binding.tableId,
      });
    }
  });

  return Array.from(unique.values());
}

function toDisplayValue(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map((entry) => toDisplayValue(entry)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function getNumericColumnValues(rows: Record<string, any>[], column: string): number[] {
  return rows
    .map((row) => Number(row?.[column]))
    .filter((value) => Number.isFinite(value));
}

function aggregateBindingValue(rows: Record<string, any>[], binding: DataFieldBinding): unknown {
  const column = binding.column;

  switch (binding.agg) {
    case 'count':
      return rows.length;
    case 'sum': {
      const values = getNumericColumnValues(rows, column);
      return values.reduce((sum, value) => sum + value, 0);
    }
    case 'avg': {
      const values = getNumericColumnValues(rows, column);
      if (!values.length) return null;
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    }
    case 'min': {
      const values = getNumericColumnValues(rows, column);
      return values.length ? Math.min(...values) : null;
    }
    case 'max': {
      const values = getNumericColumnValues(rows, column);
      return values.length ? Math.max(...values) : null;
    }
    case 'last':
      return rows.length ? rows[rows.length - 1]?.[column] : null;
    case 'first':
    default:
      return rows.length ? rows[0]?.[column] : null;
  }
}

function resolveBindingValue(
  binding: DataFieldBinding,
  sources: RuntimeSourceMap,
  rowContext: RowContextMap,
): string {
  const key = runtimeSourceKey(binding);
  const source = sources.get(key);

  if (!source) {
    return binding.label ?? `{{${binding.column}}}`;
  }

  if (binding.agg) {
    return toDisplayValue(aggregateBindingValue(source.rows, binding));
  }

  const scopedRow = rowContext[key];
  const row = scopedRow ?? source.rows[0];
  return toDisplayValue(row?.[binding.column]);
}

function resolveValue(value: CellValue, sources: RuntimeSourceMap, rowContext: RowContextMap): string {
  if (typeof value === 'string') return value;
  if (isDataField(value)) return resolveBindingValue(value, sources, rowContext);
  if (isFormula(value)) return value.expression;
  return '';
}

function resolveTextContent(content: unknown, sources: RuntimeSourceMap): string | unknown {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((segment) => {
        if (typeof segment === 'string') return segment;
        return resolveValue(segment as CellValue, sources, {});
      })
      .join('');
  }

  return content;
}


function resolveTableBlock(block: TemplateBlock, sources: RuntimeSourceMap): TemplateBlock {
  const tableConfig = block.config as Partial<TableConfig>;
  if (!tableConfig.rows?.length) return block;

  const nextRows: TableConfig['rows'] = [];
  const nextRowHeights: number[] = [];

  tableConfig.rows.forEach((row, rowIndex) => {
    const repeatSourceKey = row.isHeader ? null : getRepeatingRowSource(row);
    const repeatRows = repeatSourceKey ? sources.get(repeatSourceKey)?.rows ?? [] : [];
    const materializedRows = repeatSourceKey ? (repeatRows.length ? repeatRows : [undefined]) : [undefined];

    materializedRows.forEach((runtimeRow) => {
      const rowContext: RowContextMap = repeatSourceKey ? { [repeatSourceKey]: runtimeRow } : {};

      nextRows.push({
        ...row,
        cells: row.cells.map((cell) => ({
          ...cell,
          value: resolveValue(cell.value, sources, rowContext),
        })),
      });

      const rowHeight = tableConfig.rowHeights?.[rowIndex];
      if (rowHeight != null) {
        nextRowHeights.push(rowHeight);
      }
    });
  });

  return {
    ...block,
    config: {
      ...tableConfig,
      rows: nextRows,
      ...(tableConfig.rowHeights?.length ? { rowHeights: nextRowHeights } : {}),
    },
  };
}

function resolveBlock(block: TemplateBlock, sources: RuntimeSourceMap): TemplateBlock {
  if (block.type === 'text') {
    return {
      ...block,
      config: {
        ...block.config,
        content: resolveTextContent((block.config as { content?: unknown }).content, sources),
      },
    };
  }

  if (block.type === 'table') {
    return resolveTableBlock(block, sources);
  }

  return block;
}

function getQueryErrorMessage(error: unknown): string {
  const detail = (error as any)?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (detail && typeof detail === 'object' && typeof detail.message === 'string') return detail.message;
  if (typeof (error as any)?.message === 'string' && (error as any).message.trim()) {
    return (error as any).message;
  }
  return 'Failed to load template data.';
}

export interface ActiveFilterValues {
  [filterId: string]: any;
}

export function useTemplatePreviewData(
  blocks: TemplateBlock[],
  enabled: boolean,
  templateFilters?: TemplateFilter[],
  activeFilterValues?: ActiveFilterValues,
) {
  const sources = useMemo(() => getRuntimeSources(blocks), [blocks]);

  // Group active filters by source key so each API call gets the right WHERE clauses
  const filtersBySource = useMemo(() => {
    const map = new Map<string, Array<{ field: string; operator: string; value: any }>>();
    if (!templateFilters?.length || !activeFilterValues) return map;

    for (const tf of templateFilters) {
      const raw = activeFilterValues[tf.id];
      if (raw == null || raw === '' || (Array.isArray(raw) && raw.every((v: any) => !v))) continue;

      const key = runtimeSourceKey(tf);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push({
        field: tf.column,
        operator: tf.operator,
        value: raw,
      });
    }
    return map;
  }, [templateFilters, activeFilterValues]);

  // Stable serialised string for query key so React Query refetches when filters change
  const filtersKey = useMemo(
    () => JSON.stringify(Array.from(filtersBySource.entries())),
    [filtersBySource],
  );

  const queries = useQueries({
    queries: enabled
      ? sources.map((source) => {
          const sourceFilters = filtersBySource.get(source.key) ?? [];
          return {
            queryKey: [
              ...datasetKeys.tablePreview(source.datasetId, source.tableId),
              { runtime: 'template-preview', limit: PREVIEW_LIMIT, filters: filtersKey },
            ],
            queryFn: async (): Promise<TablePreviewResponse> => {
              const body: Record<string, any> = { limit: PREVIEW_LIMIT };
              if (sourceFilters.length > 0) {
                body.filters = sourceFilters;
              }
              const response = await api.post<TablePreviewResponse>(
                `/datasets/${source.datasetId}/tables/${source.tableId}/preview`,
                body,
              );
              return response.data;
            },
            staleTime: 30_000,
            retry: 1,
          };
        })
      : [],
  });

  const sourceMap = useMemo(() => {
    const next = new Map<string, RuntimeSource>();

    sources.forEach((source, index) => {
      const data = queries[index]?.data;
      if (data) {
        next.set(source.key, {
          ...source,
          ...data,
        });
      }
    });

    return next;
  }, [sources, queries]);

  const resolvedBlocks = useMemo(
    () => (enabled ? blocks.map((block) => resolveBlock(block, sourceMap)) : blocks),
    [enabled, blocks, sourceMap],
  );

  const errorMessages = useMemo(
    () =>
      sources.flatMap((source, index) => {
        const error = queries[index]?.error;
        if (!error) return [];
        return [`Dataset ${source.datasetId} / table ${source.tableId}: ${getQueryErrorMessage(error)}`];
      }),
    [sources, queries],
  );

  const truncatedSources = useMemo(
    () => sources.filter((_, index) => Boolean(queries[index]?.data?.has_more)).length,
    [sources, queries],
  );

  return {
    blocks: resolvedBlocks,
    sourceCount: sources.length,
    isLoading: enabled && queries.some((query) => query.isPending),
    isFetching: enabled && queries.some((query) => query.isFetching),
    hasError: errorMessages.length > 0,
    errorMessages,
    truncatedSources,
  };
}