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

export interface TableConfig {
  heading?: string;
  showBorder?: boolean;
  columns: number;          // total column count
  columnWidths?: number[];  // px per column (auto if omitted)
  rowHeights?: number[];    // px per row (auto if omitted)
  rows: TableRowDef[];
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
  blocks: TemplateBlock[];
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
  blocks?: TemplateBlock[];
  filters?: TemplateFilter[];
}

export interface ReportTemplateUpdate {
  name?: string;
  description?: string;
  page_size?: string;
  orientation?: string;
  blocks?: TemplateBlock[];
  filters?: TemplateFilter[];
}

/* ── Page constants ───────────────────────────────────────── */

export const PAGE_SIZES: Record<string, { width: number; height: number }> = {
  A4: { width: 794, height: 1123 },
  A3: { width: 1123, height: 1587 },
  Letter: { width: 816, height: 1056 },
};

export const PAGE_MARGIN = 24;

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
