'use client';

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';

import { apiClient as api } from '@/lib/api-client';
import { datasetKeys, type TablePreviewResponse } from '@/hooks/use-datasets';
import type {
  SheetData,
  SpreadsheetCell,
  SpreadsheetBorders,
  MergeRange,
  CellValue,
  DataFieldBinding,
  TemplateFilter,
} from '@/types/template';
import { hasSpreadsheetBorders, isDataField } from '@/types/template';

const PREVIEW_LIMIT = 1000;

/* ── Types ─────────────────────────────────────────────────── */

type RuntimeSourceRef = {
  key: string;
  datasetId: number;
  tableId: number;
};

type RuntimeSource = RuntimeSourceRef & TablePreviewResponse;
type RuntimeSourceMap = Map<string, RuntimeSource>;

function sourceKey(datasetId: number, tableId: number) {
  return `${datasetId}:${tableId}`;
}

/* ── Source extraction ─────────────────────────────────────── */

function getSheetSources(sheet: SheetData): RuntimeSourceRef[] {
  const seen = new Set<string>();
  const sources: RuntimeSourceRef[] = [];

  for (const cell of Object.values(sheet.cells)) {
    if (!cell.value || typeof cell.value === 'string') continue;
    if (isDataField(cell.value)) {
      const key = sourceKey(cell.value.datasetId, cell.value.tableId);
      if (!seen.has(key)) {
        seen.add(key);
        sources.push({ key, datasetId: cell.value.datasetId, tableId: cell.value.tableId });
      }
    }
  }
  return sources;
}

/* ── Aggregation helpers ───────────────────────────────────── */

function aggregate(values: any[], agg: string): any {
  const nums = values.map(Number).filter((n) => !isNaN(n));
  switch (agg) {
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'avg': return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    case 'min': return nums.length ? Math.min(...nums) : 0;
    case 'max': return nums.length ? Math.max(...nums) : 0;
    case 'count': return values.length;
    case 'first': return values[0] ?? '';
    case 'last': return values[values.length - 1] ?? '';
    default: return values[0] ?? '';
  }
}

/* ── Resolve helpers ───────────────────────────────────────── */

function resolveBinding(
  binding: DataFieldBinding,
  sources: RuntimeSourceMap,
  rowData?: Record<string, any>,
): string {
  const key = sourceKey(binding.datasetId, binding.tableId);
  const source = sources.get(key);
  if (!source?.rows) return binding.label ?? `{{${binding.column}}}`;

  // Row-level resolution (repeating rows)
  if (rowData) {
    const val = rowData[binding.column];
    return val != null ? String(val) : '';
  }

  // Aggregated
  if (binding.agg) {
    const allVals = source.rows.map((row) => row[binding.column]);
    return String(aggregate(allVals, binding.agg));
  }

  // Single value (first row)
  if (source.rows.length > 0) {
    const val = source.rows[0][binding.column];
    return val != null ? String(val) : '';
  }

  return '';
}

/* ── Repeating row detection ───────────────────────────────── */

function getRepeatingRowSource(
  cells: Record<string, SpreadsheetCell>,
  row: number,
  colCount: number,
): string | null {
  const rowSources: string[] = [];
  for (let c = 0; c < colCount; c++) {
    const cell = cells[`${row},${c}`];
    if (!cell?.value || typeof cell.value === 'string') continue;
    if (isDataField(cell.value)) {
      if (cell.value.agg) return null;
      rowSources.push(sourceKey(cell.value.datasetId, cell.value.tableId));
    }
  }
  if (rowSources.length === 0) return null;
  return new Set(rowSources).size === 1 ? rowSources[0] : null;
}

/* ── Sheet resolution (expand repeating rows, resolve bindings) ── */

export interface ResolvedSheet {
  colCount: number;
  colWidths: number[];
  /** Resolved rows: each row has cells array of display strings + formatting */
  rows: ResolvedRow[];
  merges: MergeRange[];
}

export interface ResolvedRow {
  height: number;
  cells: ResolvedCell[];
}

export interface ResolvedCell {
  text: string;
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';
  bg?: string;
  fontSize?: number;
  borders?: SpreadsheetBorders;
  colSpan?: number;
  rowSpan?: number;
  hidden?: boolean;
}

function toResolvedCell(cell: SpreadsheetCell, text: string): ResolvedCell {
  return {
    text,
    bold: cell.bold,
    italic: cell.italic,
    align: cell.align,
    bg: cell.bg,
    fontSize: cell.fontSize,
    borders: cell.borders ? { ...cell.borders } : undefined,
  };
}

function isResolvedCellUsed(cell: ResolvedCell): boolean {
  return !!(
    cell.text ||
    cell.bold ||
    cell.italic ||
    cell.align ||
    cell.bg ||
    cell.fontSize ||
    hasSpreadsheetBorders(cell.borders) ||
    cell.colSpan ||
    cell.rowSpan
  );
}

function trimResolvedSheet(sheet: ResolvedSheet): ResolvedSheet {
  let lastUsedRow = -1;
  let lastUsedCol = -1;

  sheet.rows.forEach((row, rowIndex) => {
    row.cells.forEach((cell, colIndex) => {
      if (cell.hidden || !isResolvedCellUsed(cell)) return;
      lastUsedRow = Math.max(lastUsedRow, rowIndex);
      lastUsedCol = Math.max(lastUsedCol, colIndex + (cell.colSpan ?? 1) - 1);
    });
  });

  if (lastUsedRow < 0 || lastUsedCol < 0) {
    return {
      colCount: 0,
      colWidths: [],
      rows: [],
      merges: [],
    };
  }

  return {
    colCount: lastUsedCol + 1,
    colWidths: sheet.colWidths.slice(0, lastUsedCol + 1),
    rows: sheet.rows.slice(0, lastUsedRow + 1).map((row) => ({
      ...row,
      cells: row.cells.slice(0, lastUsedCol + 1),
    })),
    merges: sheet.merges.filter(
      (merge) =>
        merge.r1 <= lastUsedRow &&
        merge.r2 <= lastUsedRow &&
        merge.c1 <= lastUsedCol &&
        merge.c2 <= lastUsedCol,
    ),
  };
}

function resolveSheet(sheet: SheetData, sources: RuntimeSourceMap): ResolvedSheet {
  const { colCount, rowCount, colWidths, rowHeights, cells, merges } = sheet;
  const resolvedRows: ResolvedRow[] = [];

  // Track row index offset caused by expanded repeating rows (for merge adjustment)
  const rowOffsets: number[] = []; // original row → resolved row index
  let resolvedRowIdx = 0;

  for (let ri = 0; ri < rowCount; ri++) {
    rowOffsets.push(resolvedRowIdx);
    const repeatSourceKey = getRepeatingRowSource(cells, ri, colCount);

    if (repeatSourceKey) {
      // This is a repeating row — expand per data record
      const source = sources.get(repeatSourceKey);
      const dataRows = source?.rows ?? [];

      if (dataRows.length === 0) {
        // No data — show template row with placeholders
        const rowCells: ResolvedCell[] = [];
        for (let ci = 0; ci < colCount; ci++) {
          const cell = cells[`${ri},${ci}`] ?? { value: '' };
          const text = typeof cell.value === 'string'
            ? cell.value
            : resolveBinding(cell.value as DataFieldBinding, sources);
          rowCells.push(toResolvedCell(cell, text));
        }
        resolvedRows.push({ height: rowHeights[ri] ?? 28, cells: rowCells });
        resolvedRowIdx++;
      } else {
        // Expand: one resolved row per data record
        for (const dataRow of dataRows) {
          const rowCells: ResolvedCell[] = [];
          for (let ci = 0; ci < colCount; ci++) {
            const cell = cells[`${ri},${ci}`] ?? { value: '' };
            let text: string;
            if (typeof cell.value === 'string') {
              text = cell.value;
            } else if (isDataField(cell.value)) {
              text = resolveBinding(cell.value, sources, dataRow);
            } else {
              text = '';
            }
            rowCells.push(toResolvedCell(cell, text));
          }
          resolvedRows.push({ height: rowHeights[ri] ?? 28, cells: rowCells });
          resolvedRowIdx++;
        }
      }
    } else {
      // Static row — resolve bindings but don't expand
      const rowCells: ResolvedCell[] = [];
      for (let ci = 0; ci < colCount; ci++) {
        const cell = cells[`${ri},${ci}`] ?? { value: '' };
        let text: string;
        if (typeof cell.value === 'string') {
          text = cell.value;
        } else if (isDataField(cell.value)) {
          text = resolveBinding(cell.value, sources);
        } else {
          text = '';
        }
        rowCells.push(toResolvedCell(cell, text));
      }
      resolvedRows.push({ height: rowHeights[ri] ?? 28, cells: rowCells });
      resolvedRowIdx++;
    }
  }

  // Adjust merges for expanded rows
  const adjustedMerges: MergeRange[] = [];
  for (const m of merges) {
    // Skip merges that overlap with repeating rows (they don't make sense after expansion)
    let overlapsRepeating = false;
    for (let r = m.r1; r <= m.r2; r++) {
      if (getRepeatingRowSource(cells, r, colCount)) {
        overlapsRepeating = true;
        break;
      }
    }
    if (overlapsRepeating) continue;

    const newR1 = rowOffsets[m.r1] ?? m.r1;
    const newR2 = rowOffsets[m.r2] ?? m.r2;
    adjustedMerges.push({ r1: newR1, c1: m.c1, r2: newR2, c2: m.c2 });
  }

  // Apply merge info (hidden cells, colSpan, rowSpan) to resolved cells
  for (const m of adjustedMerges) {
    for (let r = m.r1; r <= m.r2 && r < resolvedRows.length; r++) {
      for (let c = m.c1; c <= m.c2 && c < colCount; c++) {
        if (r === m.r1 && c === m.c1) {
          resolvedRows[r].cells[c].colSpan = m.c2 - m.c1 + 1;
          resolvedRows[r].cells[c].rowSpan = m.r2 - m.r1 + 1;
        } else {
          resolvedRows[r].cells[c].hidden = true;
        }
      }
    }
  }

  return trimResolvedSheet({ colCount, colWidths, rows: resolvedRows, merges: adjustedMerges });
}

/* ── Error helper ──────────────────────────────────────────── */

function getQueryErrorMessage(error: unknown): string {
  const detail = (error as any)?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (detail && typeof detail === 'object' && typeof detail.message === 'string') return detail.message;
  if (typeof (error as any)?.message === 'string' && (error as any).message.trim()) return (error as any).message;
  return 'Failed to load data.';
}

/* ── Main hook ─────────────────────────────────────────────── */

export interface ActiveFilterValues {
  [filterId: string]: any;
}

export function useSpreadsheetPreviewData(
  sheet: SheetData,
  enabled: boolean,
  templateFilters?: TemplateFilter[],
  activeFilterValues?: ActiveFilterValues,
) {
  const sources = useMemo(() => getSheetSources(sheet), [sheet]);

  // Group active filters by source key
  const filtersBySource = useMemo(() => {
    const map = new Map<string, Array<{ field: string; operator: string; value: any }>>();
    if (!templateFilters?.length || !activeFilterValues) return map;
    for (const tf of templateFilters) {
      const raw = activeFilterValues[tf.id];
      if (raw == null || raw === '' || (Array.isArray(raw) && raw.every((v: any) => !v))) continue;
      const key = sourceKey(tf.datasetId, tf.tableId);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push({ field: tf.column, operator: tf.operator, value: raw });
    }
    return map;
  }, [templateFilters, activeFilterValues]);

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
              { runtime: 'sheet-preview', limit: PREVIEW_LIMIT, filters: filtersKey },
            ],
            queryFn: async (): Promise<TablePreviewResponse> => {
              const body: Record<string, any> = { limit: PREVIEW_LIMIT };
              if (sourceFilters.length > 0) body.filters = sourceFilters;
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
      if (data) next.set(source.key, { ...source, ...data });
    });
    return next;
  }, [sources, queries]);

  const resolved = useMemo(
    () => (enabled ? resolveSheet(sheet, sourceMap) : null),
    [enabled, sheet, sourceMap],
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
    resolved,
    sourceCount: sources.length,
    isLoading: enabled && queries.some((q) => q.isPending),
    isFetching: enabled && queries.some((q) => q.isFetching),
    hasError: errorMessages.length > 0,
    errorMessages,
    truncatedSources,
  };
}
