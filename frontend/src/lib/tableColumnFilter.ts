/**
 * Client-side per-column view filter for the Table visualization.
 *
 * This is a PRESENTATION filter over the rows ALREADY fetched into the table
 * (Excel / Power BI AutoFilter). It is intentionally NOT part of the semantic
 * layer / dashboard filter system — it never touches SQL generation, slicers,
 * the filter-pane, or the distinct-value cascade. It only decides which of the
 * in-memory rows are shown. Multiple column filters combine with AND.
 *
 * Each column supports two independent, AND-combined constraints:
 *   1. a CONDITION (operator + up to two values), typed to the column
 *      (text / number / date), and
 *   2. a multi-select CHECKLIST of the column's distinct values.
 * A column with neither is inactive and matches every row.
 */
import { parseNumericCellValue } from '@/lib/exploreAggregations';

export type TableFilterColumnType = 'text' | 'number' | 'date';

export type TableFilterOperator =
  // text
  | 'contains' | 'notContains' | 'equals' | 'notEquals' | 'startsWith' | 'endsWith'
  // number
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'between'
  // date
  | 'dateOn' | 'dateBefore' | 'dateAfter' | 'dateBetween'
  // shared
  | 'isEmpty' | 'isNotEmpty';

export interface TableColumnFilter {
  /** Condition operator; null = no condition constraint (checklist may still apply). */
  op: TableFilterOperator | null;
  /** First operand (the only one for most ops; lower bound for `between`). */
  value1: string;
  /** Second operand — upper bound for `between` / `dateBetween`. */
  value2: string;
  /** Multi-select checklist of distinct values; empty = no checklist constraint. */
  selected: string[];
}

export const EMPTY_TABLE_COLUMN_FILTER: TableColumnFilter = {
  op: null,
  value1: '',
  value2: '',
  selected: [],
};

/** A filter is active only when it would actually constrain rows. */
export function isTableColumnFilterActive(f: TableColumnFilter | undefined | null): boolean {
  if (!f) return false;
  if (f.selected && f.selected.length > 0) return true;
  if (!f.op) return false;
  if (f.op === 'isEmpty' || f.op === 'isNotEmpty') return true;
  if (f.op === 'between' || f.op === 'dateBetween') {
    return (f.value1?.trim() ?? '') !== '' || (f.value2?.trim() ?? '') !== '';
  }
  return (f.value1?.trim() ?? '') !== '';
}

// Only treat clearly date-shaped values as dates so we never mis-classify a
// numeric id or free text. ISO-ish `YYYY-MM-DD[ T…]` (what the engine emits for
// date/datetime dims) is the anchor.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?/;

function looksLikeDate(v: any): boolean {
  if (v == null) return false;
  if (v instanceof Date) return !Number.isNaN(v.getTime());
  const s = String(v).trim();
  return s !== '' && ISO_DATE_RE.test(s);
}

/**
 * Infer the filter type for a column. `numericHint` should be the table's own
 * numeric-column detection (a column with any numeric-parseable value). Dates
 * are only chosen when EVERY sampled non-empty value is date-shaped, so a mixed
 * or numeric column never becomes a date picker.
 */
export function detectTableColumnType(
  rows: Record<string, any>[],
  col: string,
  numericHint: boolean,
): TableFilterColumnType {
  if (numericHint) return 'number';
  let seen = 0;
  let dateHits = 0;
  for (const r of rows) {
    const v = r?.[col];
    if (v == null || v === '') continue;
    seen++;
    if (looksLikeDate(v)) dateHits++;
    if (seen >= 25) break;
  }
  if (seen > 0 && dateHits === seen) return 'date';
  return 'text';
}

function toDate(v: any): Date | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const d = new Date(String(v).trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

const dayKey = (d: Date): number => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());

function matchesOperator(
  cellValue: any,
  f: TableColumnFilter,
  type: TableFilterColumnType,
): boolean {
  const empty = cellValue == null || String(cellValue).trim() === '';
  if (f.op === 'isEmpty') return empty;
  if (f.op === 'isNotEmpty') return !empty;

  if (type === 'number') {
    const n = parseNumericCellValue(cellValue);
    if (n == null) return false;
    const a = parseNumericCellValue(f.value1);
    const b = parseNumericCellValue(f.value2);
    switch (f.op) {
      case 'eq': return a != null && n === a;
      case 'neq': return a == null || n !== a;
      case 'gt': return a != null && n > a;
      case 'gte': return a != null && n >= a;
      case 'lt': return a != null && n < a;
      case 'lte': return a != null && n <= a;
      case 'between':
        if (a != null && n < a) return false;
        if (b != null && n > b) return false;
        return true;
      default: return true;
    }
  }

  if (type === 'date') {
    const d = toDate(cellValue);
    if (d == null) return false;
    const a = toDate(f.value1);
    const b = toDate(f.value2);
    switch (f.op) {
      case 'dateOn': return a != null && dayKey(d) === dayKey(a);
      case 'dateBefore': return a != null && dayKey(d) < dayKey(a);
      case 'dateAfter': return a != null && dayKey(d) > dayKey(a);
      case 'dateBetween':
        if (a != null && dayKey(d) < dayKey(a)) return false;
        if (b != null && dayKey(d) > dayKey(b)) return false;
        return true;
      default: return true;
    }
  }

  // text
  const cell = (cellValue == null ? '' : String(cellValue)).toLowerCase();
  const q = (f.value1 ?? '').toLowerCase();
  switch (f.op) {
    case 'contains': return q === '' || cell.includes(q);
    case 'notContains': return q === '' || !cell.includes(q);
    case 'equals': return cell === q;
    case 'notEquals': return cell !== q;
    case 'startsWith': return cell.startsWith(q);
    case 'endsWith': return cell.endsWith(q);
    default: return true;
  }
}

/** Does a single cell value satisfy one column's filter (checklist AND condition)? */
export function matchesTableColumnFilter(
  cellValue: any,
  f: TableColumnFilter,
  type: TableFilterColumnType,
): boolean {
  if (f.selected && f.selected.length > 0) {
    const s = cellValue == null ? '' : String(cellValue);
    if (!f.selected.includes(s)) return false;
  }
  if (f.op) {
    if (!matchesOperator(cellValue, f, type)) return false;
  }
  return true;
}

/** AND across every active column filter. */
export function rowMatchesAllTableFilters(
  row: Record<string, any>,
  filters: Record<string, TableColumnFilter>,
  types: Record<string, TableFilterColumnType>,
): boolean {
  for (const col of Object.keys(filters)) {
    const f = filters[col];
    if (!isTableColumnFilterActive(f)) continue;
    if (!matchesTableColumnFilter(row?.[col], f, types[col] ?? 'text')) return false;
  }
  return true;
}

/** Distinct string values in a column, for the checklist. Capped for safety. */
export function distinctTableColumnValues(
  rows: Record<string, any>[],
  col: string,
  cap = 1000,
): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const v = r?.[col];
    set.add(v == null ? '' : String(v));
    if (set.size > cap) break;
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export interface TableFilterOperatorOption {
  value: TableFilterOperator;
  label: string;
}

const TEXT_OPERATORS: TableFilterOperatorOption[] = [
  { value: 'contains', label: 'Contains' },
  { value: 'notContains', label: 'Does not contain' },
  { value: 'equals', label: 'Equals' },
  { value: 'notEquals', label: 'Does not equal' },
  { value: 'startsWith', label: 'Starts with' },
  { value: 'endsWith', label: 'Ends with' },
  { value: 'isEmpty', label: 'Is empty' },
  { value: 'isNotEmpty', label: 'Is not empty' },
];

const NUMBER_OPERATORS: TableFilterOperatorOption[] = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'between', label: 'Between' },
  { value: 'isEmpty', label: 'Is empty' },
  { value: 'isNotEmpty', label: 'Is not empty' },
];

const DATE_OPERATORS: TableFilterOperatorOption[] = [
  { value: 'dateOn', label: 'On' },
  { value: 'dateBefore', label: 'Before' },
  { value: 'dateAfter', label: 'After' },
  { value: 'dateBetween', label: 'Between' },
  { value: 'isEmpty', label: 'Is empty' },
  { value: 'isNotEmpty', label: 'Is not empty' },
];

export function operatorsForType(type: TableFilterColumnType): TableFilterOperatorOption[] {
  if (type === 'number') return NUMBER_OPERATORS;
  if (type === 'date') return DATE_OPERATORS;
  return TEXT_OPERATORS;
}

/** How many value inputs an operator needs: 0 (empty checks), 1, or 2 (between). */
export function operatorValueCount(op: TableFilterOperator | null): 0 | 1 | 2 {
  if (!op || op === 'isEmpty' || op === 'isNotEmpty') return 0;
  if (op === 'between' || op === 'dateBetween') return 2;
  return 1;
}
