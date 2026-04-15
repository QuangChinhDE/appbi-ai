/**
 * TypeScript types for the Report Template module.
 */

/* ── Layout ────────────────────────────────────────────────── */

export interface TemplateBlockLayout {
  x: number;      // px from page left edge
  y: number;      // px from page top edge
  width: number;  // px
  height: number; // px
}

/* ── Data binding ──────────────────────────────────────────── */

/**
 * A value in any text/cell can be one of:
 *   - plain string  → "Hello"
 *   - data binding  → { type: 'field', datasetId, tableId, column, agg? }
 *   - formula       → { type: 'formula', expression }
 *
 * Use `resolveCellValue()` at render-time to get the display string.
 */
export interface DataFieldBinding {
  type: 'field';
  datasetId: number;
  tableId: number;
  column: string;
  agg?: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'first' | 'last';
  format?: string;          // e.g. "#,##0", "dd/MM/yyyy"
  label?: string;           // friendly display name
}

export interface FormulaBinding {
  type: 'formula';
  expression: string;       // e.g. "=SUM(field1) * 1.1"
  format?: string;
}

export type CellValue = string | DataFieldBinding | FormulaBinding;

/* ── Table structures ──────────────────────────────────────── */

export interface TableCellDef {
  value: CellValue;
  colSpan?: number;
  rowSpan?: number;
  hidden?: boolean;
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';
  bg?: string;              // background color
}

export interface TableRowDef {
  cells: TableCellDef[];
  isHeader?: boolean;
}

/* ── Dataset-level data source binding ─────────────────────── */

export interface TableDataSourceColumn {
  column: string;           // actual DB column name
  label: string;            // display header label
  width?: number;           // optional column width (px)
  align?: 'left' | 'center' | 'right';
}

export interface TableDataSource {
  datasetId: number;
  tableId: number;
  datasetName?: string;     // for display
  tableName?: string;       // for display
  columns: TableDataSourceColumn[];
}

export interface TableConfig {
  heading?: string;
  showBorder?: boolean;
  columns: number;          // total column count
  columnWidths?: number[];  // px per column (auto if omitted)
  rowHeights?: number[];    // px per row (auto if omitted)
  rows: TableRowDef[];
  dataSource?: TableDataSource;  // block-level dataset binding
}

/* ── Block ─────────────────────────────────────────────────── */

export interface TemplateBlock {
  id: string;
  type: 'title' | 'table' | 'signature' | 'text' | 'spacer' | 'image';
  layout: TemplateBlockLayout;
  config: Record<string, any>;
}

/* ── Filter ────────────────────────────────────────────────── */

export interface TemplateFilter {
  id: string;
  label: string;
  datasetId: number;
  tableId: number;
  column: string;
  operator: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'in' | 'not_in' | 'contains' | 'like';
  defaultValue?: string;
}

/* ── Template ──────────────────────────────────────────────── */

export interface ReportTemplate {
  id: number;
  name: string;
  description?: string;
  page_size: string;
  orientation: string;
  blocks: TemplateBlock[] | SheetData;
  filters?: TemplateFilter[];
  owner_id?: string;
  owner_email?: string;
  user_permission?: string;
  created_at: string;
  updated_at: string;
}

export interface ReportTemplateCreate {
  name: string;
  description?: string;
  page_size?: string;
  orientation?: string;
  blocks?: TemplateBlock[] | SheetData;
  filters?: TemplateFilter[];
}

export interface ReportTemplateUpdate {
  name?: string;
  description?: string;
  page_size?: string;
  orientation?: string;
  blocks?: TemplateBlock[] | SheetData;
  filters?: TemplateFilter[];
}

/* ── Page constants ───────────────────────────────────────── */

export const PAGE_SIZES: Record<string, { width: number; height: number }> = {
  A4: { width: 794, height: 1123 },
  A3: { width: 1123, height: 1587 },
  Letter: { width: 816, height: 1056 },
};

export const PAGE_MARGIN = 24;

/* ── Spreadsheet types (v2 format) ─────────────────────────── */

export type SpreadsheetBorderSide = 'top' | 'right' | 'bottom' | 'left';

export type SpreadsheetBorders = Partial<Record<SpreadsheetBorderSide, boolean>>;

export function hasSpreadsheetBorders(borders?: SpreadsheetBorders | null): boolean {
  return !!(borders?.top || borders?.right || borders?.bottom || borders?.left);
}

export interface SpreadsheetCell {
  value: CellValue;
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';
  bg?: string;
  fontSize?: number;
  borders?: SpreadsheetBorders;
}

export interface MergeRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface SheetData {
  version: 2;
  colCount: number;
  rowCount: number;
  colWidths: number[];
  rowHeights: number[];
  cells: Record<string, SpreadsheetCell>;
  merges: MergeRange[];
}

export function isSheetData(data: unknown): data is SheetData {
  return !!data && typeof data === 'object' && !Array.isArray(data) && (data as any).version === 2;
}

export function createDefaultSheet(_pageSize = 'A4', _orientation = 'portrait'): SheetData {
  const colCount = 26;
  const rowCount = 100;
  return {
    version: 2,
    colCount,
    rowCount,
    colWidths: Array(colCount).fill(100),
    rowHeights: Array(rowCount).fill(28),
    cells: {},
    merges: [],
  };
}

/* ── Helpers ───────────────────────────────────────────────── */

export function isDataField(v: CellValue): v is DataFieldBinding {
  return typeof v === 'object' && v !== null && v.type === 'field';
}

export function isFormula(v: CellValue): v is FormulaBinding {
  return typeof v === 'object' && v !== null && v.type === 'formula';
}

export function cellDisplayText(v: CellValue): string {
  if (typeof v === 'string') return v;
  if (isDataField(v)) return v.label ?? `{{${v.column}}}`;
  if (isFormula(v)) return v.expression;
  return '';
}
