import * as XLSX from 'xlsx';
import type { TemplateDefinition, TemplateColumn } from '@/types/template';
import { evaluateFormula, formatValue } from '@/hooks/use-template-data';

/**
 * Export template data to an Excel file (.xlsx).
 */
export function exportToExcel(
  definition: TemplateDefinition,
  rows: Record<string, any>[],
  fileName: string,
) {
  const { columns, header, footer, groupBy } = definition;
  const visibleCols = columns.filter((c) => c.visible !== false);

  const sheetRows: any[][] = [];

  /* ── Header lines ── */
  if (header?.lines) {
    for (const line of header.lines) {
      sheetRows.push([line.text]);
    }
  }
  if (header?.title) {
    sheetRows.push([header.title + (header.meta ? `  —  ${header.meta}` : '')]);
  }
  sheetRows.push([]); // blank row

  /* ── Column headers ── */
  sheetRows.push(visibleCols.map((c) => c.label));

  /* ── Group + data rows ── */
  const resolveCell = (col: TemplateColumn, row: Record<string, any>): string | number => {
    if (col.expression) {
      const val = row[col.key] != null ? row[col.key] : evaluateFormula(col.expression, row, columns);
      return val ?? '';
    }
    const raw = row[col.sourceColumn ?? col.key];
    if (raw == null) return '';
    const num = typeof raw === 'number' ? raw : parseFloat(raw);
    return isNaN(num) ? String(raw) : num;
  };

  if (groupBy) {
    const groups = new Map<string, Record<string, any>[]>();
    const srcCol = columns.find((c) => c.key === groupBy)?.sourceColumn ?? groupBy;
    for (const row of rows) {
      const key = String(row[srcCol] ?? 'Other');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }

    for (const [label, gRows] of groups) {
      // Group header
      sheetRows.push([label]);
      for (const row of gRows) {
        sheetRows.push(visibleCols.map((c) => resolveCell(c, row)));
      }
      // Group subtotal
      if (definition.showSubtotals !== false) {
        const subtotalRow = visibleCols.map((col, ci) => {
          if (ci === 0) return `${label} — ${gRows.length} rows`;
          if (col.format === 'integer' || col.format === 'decimal' || col.type === 'formula' || col.type === 'subtotal') {
            let total = 0;
            for (const row of gRows) {
              const val = resolveCell(col, row);
              total += typeof val === 'number' ? val : 0;
            }
            return total;
          }
          return '';
        });
        sheetRows.push(subtotalRow);
      }
    }
  } else {
    for (const row of rows) {
      sheetRows.push(visibleCols.map((c) => resolveCell(c, row)));
    }
  }

  /* ── Footer lines ── */
  if (footer?.lines && footer.lines.length > 0) {
    sheetRows.push([]);
    for (const line of footer.lines) {
      sheetRows.push([line.text]);
    }
  }

  /* ── Create workbook ── */
  const ws = XLSX.utils.aoa_to_sheet(sheetRows);

  // Set column widths
  ws['!cols'] = visibleCols.map((c) => ({ wch: Math.max((c.width ?? 100) / 7, 12) }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Report');
  XLSX.writeFile(wb, `${fileName.replace(/[^a-zA-Z0-9_\- ]/g, '')}.xlsx`);
}
