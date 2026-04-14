/**
 * Pure utility functions for template data resolution.
 * No hooks, no side effects — safe to import from both hook files and components.
 */
import type { TableRowDef, DataFieldBinding, CellValue } from '@/types/template';
import { isDataField } from '@/types/template';

/**
 * Returns a source key ("datasetId:tableId") if this row should repeat
 * once per data row from that source. Returns null for header rows,
 * static-value rows, or rows with mixed/aggregated bindings.
 */
export function getRepeatingRowSource(row: TableRowDef): string | null {
  const rowSources = row.cells
    .map((cell) => cell.value)
    .filter(
      (value): value is DataFieldBinding =>
        isDataField(value as CellValue) && !(value as DataFieldBinding).agg,
    )
    .map((binding) => `${binding.datasetId}:${binding.tableId}`);

  const uniqueSources = Array.from(new Set(rowSources));
  return uniqueSources.length === 1 ? uniqueSources[0] : null;
}
