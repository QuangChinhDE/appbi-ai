/**
 * Shared filter types and utilities for both Explore and Dashboard
 */

import type { ChartSemanticBinding } from '@/types/api';

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'in'
  | 'not_in'
  | 'contains'
  | 'starts_with'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'between';

export type FilterType = 'text' | 'number' | 'date' | 'dropdown';

export type DatePreset =
  | 'custom'
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'last_quarter'
  | 'this_year'
  | 'last_year'
  | 'last_7_days'
  | 'last_30_days'
  | 'last_90_days';

export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  custom: 'Tùy chọn',
  today: 'Hôm nay',
  yesterday: 'Hôm qua',
  this_week: 'Tuần này',
  last_week: 'Tuần trước',
  this_month: 'Tháng này',
  last_month: 'Tháng trước',
  this_quarter: 'Quý này',
  last_quarter: 'Quý trước',
  this_year: 'Năm nay',
  last_year: 'Năm trước',
  last_7_days: '7 ngày qua',
  last_30_days: '30 ngày qua',
  last_90_days: '90 ngày qua',
};

/**
 * Base filter structure used by both Explore and Dashboard
 */
export interface BaseFilter {
  id: string;                // unique per filter (e.g. uuid)
  field: string;             // primary column name
  fieldKey?: string;         // stable key for semantic/qualified fields
  semanticField?: string;    // qualified field name (e.g. orders.country)
  datasetId?: number;        // semantic dataset scope when available
  linkedFields?: string[];   // additional column names this filter also applies to (cross-chart linking)
  type: FilterType;          // 'date' | 'dropdown' | 'text' | 'number'
  operator: FilterOperator;  // default depends on type
  value: any;                // string | number | [min,max] | array
  label?: string;            // optional user-friendly label
  datePreset?: DatePreset;   // for date filters: selected preset or 'custom'
}

/**
 * Dashboard filter extends BaseFilter with dataset context
 * Since dashboard can contain charts from different datasets,
 * we need to know which dataset each filter applies to
 */
export interface DashboardFilter extends BaseFilter {
  datasetId: number; // dataset this filter targets
}

/**
 * Infer FilterType by sampling actual values in the data rows.
 * Returns 'date' | 'number' | 'text'.
 */
export function inferColumnTypeFromData(
  field: string,
  rows: Record<string, any>[]
): FilterType {
  // Sample up to 20 rows for more reliable type detection
  let seenNumber = false;
  let seenText = false;
  let seenDate = false;
  const limit = Math.min(rows.length, 20);

  for (let i = 0; i < limit; i++) {
    const val = rows[i][field];
    if (val === null || val === undefined) continue;

    if (val instanceof Date) { seenDate = true; continue; }
    if (typeof val === 'number') { seenNumber = true; continue; }
    if (typeof val === 'string') {
      // Match ISO dates (YYYY-MM-DD), ISO datetimes with T (YYYY-MM-DDTHH:MM:SS),
      // and common datetime strings with space separator (YYYY-MM-DD HH:MM:SS)
      if (/^\d{4}-\d{2}-\d{2}([ T]|$)/.test(val)) { seenDate = true; continue; }
      if (val.trim() !== '' && !isNaN(Number(val))) { seenNumber = true; }
      else { seenText = true; }
    }
  }

  // If any text (non-numeric, non-date) values seen, treat as text
  if (seenDate && !seenText && !seenNumber) return 'date';
  if (seenText) return 'text';
  if (seenNumber) return 'number';
  return 'text';
}

/**
 * Column name + inferred type, used by DashboardFilterBar
 */
export interface ColumnInfo {
  name: string;
  type: FilterType;
  key?: string;
  label?: string;
  datasetId?: number;
  semanticField?: string;
  defaultLinkedFields?: string[];
  chartCoverage?: number;
  datasetChartCount?: number;
  sharedAcrossDataset?: boolean;
}

export interface DashboardFilterableDimensionLike {
  name?: string;
  hidden?: boolean;
}

export interface DashboardFilterableViewLike {
  hidden_in_canvas?: boolean;
}

export interface DashboardFilterableJoinLike {
  origin?: string;
  from_view?: string;
  from_column?: string;
  view?: string;
  to_column?: string;
}

export interface DashboardFilterableExploreLike {
  base_view_name?: string;
  joins?: DashboardFilterableJoinLike[];
}

export interface DashboardFilterableModelLike {
  explores?: DashboardFilterableExploreLike[];
}

const UPPERCASE_FIELD_WORDS = new Set([
  'id',
  'ip',
  'sku',
  'api',
  'sql',
  'url',
  'ui',
  'ux',
  'utc',
]);

function titleCaseTechnicalWord(word: string): string {
  const trimmed = word.trim();
  if (!trimmed) return '';

  const lower = trimmed.toLowerCase();
  if (UPPERCASE_FIELD_WORDS.has(lower)) {
    return lower.toUpperCase();
  }

  if (/^[A-Z0-9]{2,}$/.test(trimmed)) {
    return trimmed;
  }

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

function humanizeTechnicalFieldName(value: string): string {
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!spaced) return '';

  return spaced
    .split(' ')
    .map(titleCaseTechnicalWord)
    .join(' ');
}

export function getFriendlyFieldLabel(value: string | null | undefined): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';

  const lastSegment = trimmed.split('.').pop()?.trim() ?? trimmed;
  if (!lastSegment) return '';

  if (
    /[_-]/.test(lastSegment)
    || /^[a-z0-9 ]+$/.test(lastSegment)
    || /[a-z0-9][A-Z]/.test(lastSegment)
    || !/\s/.test(lastSegment)
  ) {
    return humanizeTechnicalFieldName(lastSegment);
  }

  return lastSegment;
}

export function getColumnDisplayLabel(
  column: Pick<ColumnInfo, 'label' | 'name' | 'semanticField'>,
): string {
  return (
    getFriendlyFieldLabel(column.label)
    || getFriendlyFieldLabel(column.name)
    || getFriendlyFieldLabel(column.semanticField)
    || column.name
  );
}

export function getFilterDisplayLabel(
  filter: Pick<BaseFilter, 'label' | 'field' | 'semanticField'>,
): string {
  return (
    getFriendlyFieldLabel(filter.label)
    || getFriendlyFieldLabel(filter.field)
    || getFriendlyFieldLabel(filter.semanticField)
    || filter.field
  );
}

export function collectJoinKeySemanticFields(model: DashboardFilterableModelLike | null | undefined): Set<string> {
  const fields = new Set<string>();

  for (const explore of model?.explores ?? []) {
    for (const join of explore.joins ?? []) {
      if (join?.origin === 'auto_calendar') continue;

      const fromView = String(join?.from_view || explore?.base_view_name || '').trim();
      const fromColumn = String(join?.from_column || '').trim();
      const toView = String(join?.view || '').trim();
      const toColumn = String(join?.to_column || '').trim();

      if (fromView && fromColumn) {
        fields.add(`${fromView}.${fromColumn}`);
      }
      if (toView && toColumn) {
        fields.add(`${toView}.${toColumn}`);
      }
    }
  }

  return fields;
}

export function isSemanticDimensionFilterableForDashboard(options: {
  semanticField: string;
  view?: DashboardFilterableViewLike | null;
  dimension?: DashboardFilterableDimensionLike | null;
  joinKeyFields?: Set<string> | null;
}): boolean {
  const { semanticField, view, dimension, joinKeyFields } = options;
  if (!semanticField || !dimension || view?.hidden_in_canvas) {
    return false;
  }

  if (!dimension.hidden) {
    return true;
  }

  return Boolean(joinKeyFields?.has(semanticField));
}

export function getColumnKey(column: Pick<ColumnInfo, 'key' | 'semanticField' | 'name'>): string {
  return column.key ?? column.semanticField ?? column.name;
}

export function getFilterKey(filter: Pick<BaseFilter, 'fieldKey' | 'semanticField' | 'field'>): string {
  return filter.fieldKey ?? filter.semanticField ?? filter.field;
}

type ChartSemanticBindingLike = Pick<
  ChartSemanticBinding,
  'datasetId' | 'baseViewName' | 'fieldMap' | 'dimensionFields' | 'measureFields' | 'calendarFieldMappings'
>;

function semanticCandidates(filter: Pick<BaseFilter, 'fieldKey' | 'semanticField' | 'field'>): string[] {
  const candidates = [filter.semanticField, filter.fieldKey]
    .filter((value): value is string => Boolean(value && value.includes('.')));
  return Array.from(new Set(candidates));
}

export function resolveChartSemanticField(
  binding: ChartSemanticBindingLike | null | undefined,
  chartField: string,
): string | null {
  if (!binding) return null;

  const mapped = binding.fieldMap?.[chartField];
  if (mapped) return mapped;

  if (!binding.baseViewName || !chartField) return null;

  const semanticField = `${binding.baseViewName}.${chartField}`;
  const availableSemanticFields = new Set([
    ...(binding.dimensionFields ?? []),
    ...(binding.measureFields ?? []),
  ]);
  return availableSemanticFields.has(semanticField) ? semanticField : null;
}

export function resolveCalendarFieldMapping(
  binding: ChartSemanticBindingLike | null | undefined,
  semanticField: string | null | undefined,
) {
  if (!binding || !semanticField) return null;
  return (binding.calendarFieldMappings ?? []).find(
    (mapping) => mapping.semanticField === semanticField,
  ) ?? null;
}

export function resolveChartFieldForFilter(
  filter: Pick<BaseFilter, 'field' | 'fieldKey' | 'semanticField' | 'datasetId'>,
  binding: ChartSemanticBindingLike | null | undefined,
): string | null {
  if (
    filter.datasetId != null &&
    binding?.datasetId != null &&
    filter.datasetId !== binding.datasetId
  ) {
    return null;
  }

  if (!binding) {
    return filter.field;
  }

  const availableSemanticFields = new Set([
    ...(binding.dimensionFields ?? []),
    ...(binding.measureFields ?? []),
  ]);

  for (const semanticField of semanticCandidates(filter)) {
    const calendarMapping = resolveCalendarFieldMapping(binding, semanticField);
    if (calendarMapping?.sourceField) {
      return calendarMapping.sourceField;
    }

    const mappedField = Object.entries(binding.fieldMap ?? {}).find(
      ([, value]) => value === semanticField,
    )?.[0];
    if (mappedField) return mappedField;

    if (availableSemanticFields.has(semanticField) && binding.baseViewName) {
      const prefix = `${binding.baseViewName}.`;
      if (semanticField.startsWith(prefix)) {
        return semanticField.slice(prefix.length);
      }
    }
  }

  if (binding.fieldMap && filter.field in binding.fieldMap) {
    return filter.field;
  }

  return null;
}

export function resolveFilterForChartData(
  filter: BaseFilter,
  options: {
    binding?: ChartSemanticBindingLike | null;
    availableFields?: Iterable<string> | null;
  } = {},
): BaseFilter | null {
  const { binding = null, availableFields = null } = options;
  const availableFieldSet = availableFields ? new Set(availableFields) : null;
  const resolvedField = resolveChartFieldForFilter(filter, binding);

  if (resolvedField && (!availableFieldSet || availableFieldSet.has(resolvedField))) {
    return resolvedField === filter.field ? filter : { ...filter, field: resolvedField };
  }

  if (semanticCandidates(filter).length > 0) {
    return null;
  }

  const candidates = [filter.field, ...(filter.linkedFields ?? [])];
  const fallback = availableFieldSet
    ? candidates.find((candidate) => availableFieldSet.has(candidate))
    : candidates[0];

  if (!fallback) return null;
  return fallback === filter.field ? filter : { ...filter, field: fallback };
}

/**
 * Helper to detect filter type from column type
 */
export function getFilterTypeForColumn(columnType: string): FilterType {
  const dateTypes = ['date', 'datetime', 'timestamp', 'DATE', 'DATETIME', 'TIMESTAMP'];
  const numberTypes = [
    'number', 'integer', 'float', 'double', 'numeric', 
    'FLOAT', 'INTEGER', 'NUMERIC', 'DOUBLE', 'BIGINT', 
    'int', 'INT', 'DECIMAL', 'decimal'
  ];

  const type = columnType.toLowerCase();
  
  if (dateTypes.some(t => type.includes(t.toLowerCase()))) return 'date';
  if (numberTypes.some(t => type.includes(t.toLowerCase()))) return 'number';
  
  return 'dropdown'; // default to dropdown for strings and others
}

/**
 * Get distinct values from data for a field
 */
export function getDistinctValues(field: string, rows: Record<string, any>[]): string[] {
  const set = new Set<string>();
  rows.forEach(row => {
    const val = row[field];
    if (val !== null && val !== undefined) {
      set.add(String(val));
    }
  });
  return Array.from(set).sort();
}

/**
 * Apply filters to rows (client-side v1)
 * Works with both BaseFilter and DashboardFilter (ignores datasetId)
 */
export function applyFiltersToRows(
  rows: Record<string, any>[],
  filters: BaseFilter[]
): Record<string, any>[] {
  if (!filters.length) return rows;

  return rows.filter(row =>
    filters.every(f => {
      const val = row[f.field];

      // handle null/undefined
      if (val === null || val === undefined) return false;

      // Handle multi-value operators first (type-agnostic)
      // Normalize both sides to strings so numeric/string mismatches don't cause false negatives
      if (f.operator === 'in') {
        const selected = Array.isArray(f.value) ? f.value : [];
        if (!selected.length) return true; // empty selection = no filter
        const strVal = String(val);
        return selected.some(s => String(s) === strVal);
      }
      if (f.operator === 'not_in') {
        const excluded = Array.isArray(f.value) ? f.value : [];
        if (!excluded.length) return true;
        const strVal = String(val);
        return !excluded.some(s => String(s) === strVal);
      }

      switch (f.type) {
        case 'date': {
          // Normalise both sides to comparable YYYY-MM-DD strings
          const strVal = String(val).slice(0, 10);
          const filterVal = String(f.value ?? '').slice(0, 10);
          switch (f.operator) {
            case 'eq':  return strVal === filterVal;
            case 'neq': return strVal !== filterVal;
            case 'gt':  return strVal > filterVal;
            case 'gte': return strVal >= filterVal;
            case 'lt':  return strVal < filterVal;
            case 'lte': return strVal <= filterVal;
            case 'between': {
              const [start, end] = Array.isArray(f.value) ? f.value : [];
              if (start && strVal < String(start).slice(0, 10)) return false;
              if (end   && strVal > String(end).slice(0, 10))   return false;
              return true;
            }
            default: return true;
          }
        }
        
        case 'dropdown': {
          const selected: unknown[] = f.value ?? [];
          if (!selected.length) return true;
          const strVal = String(val);
          return selected.some(s => String(s) === strVal);
        }
        
        case 'number': {
          const numVal = Number(val);
          if (isNaN(numVal)) return false;
          
          if (f.operator === 'between') {
            const [min, max] = f.value ?? [];
            if (min !== null && min !== undefined && numVal < Number(min)) return false;
            if (max !== null && max !== undefined && numVal > Number(max)) return false;
            return true;
          }
          
          const filterVal = Number(f.value);
          if (isNaN(filterVal)) return true;
          
          switch (f.operator) {
            case 'eq': return numVal === filterVal;
            case 'neq': return numVal !== filterVal;
            case 'gt': return numVal > filterVal;
            case 'gte': return numVal >= filterVal;
            case 'lt': return numVal < filterVal;
            case 'lte': return numVal <= filterVal;
            default: return true;
          }
        }
        
        case 'text': {
          const strVal = String(val);
          const filterVal = String(f.value ?? '');
          
          switch (f.operator) {
            case 'eq': return strVal === filterVal;
            case 'neq': return strVal !== filterVal;
            case 'contains': return strVal.toLowerCase().includes(filterVal.toLowerCase());
            case 'starts_with': return strVal.toLowerCase().startsWith(filterVal.toLowerCase());
            default: return true;
          }
        }
        
        default:
          return true;
      }
    })
  );
}

/**
 * Get default operator for a filter type
 */
export function getDefaultOperator(type: FilterType): FilterOperator {
  switch (type) {
    case 'date': return 'between';
    case 'dropdown': return 'in';
    case 'number': return 'eq';
    case 'text': return 'contains';
    default: return 'eq';
  }
}

/**
 * Compute [startDate, endDate] range for a date preset (YYYY-MM-DD strings).
 * Returns ['', ''] for 'custom'.
 */
export function computeDatePresetRange(preset: DatePreset): [string, string] {
  const now = new Date();
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const today = fmt(now);

  switch (preset) {
    case 'today':
      return [today, today];
    case 'yesterday': {
      const d = new Date(now); d.setDate(d.getDate() - 1);
      const s = fmt(d);
      return [s, s];
    }
    case 'this_week': {
      const d = new Date(now);
      const day = d.getDay();
      const diffToMonday = day === 0 ? 6 : day - 1;
      d.setDate(d.getDate() - diffToMonday);
      const end = new Date(d); end.setDate(end.getDate() + 6);
      return [fmt(d), fmt(end)];
    }
    case 'last_week': {
      const d = new Date(now);
      const day = d.getDay();
      const diffToMonday = day === 0 ? 6 : day - 1;
      d.setDate(d.getDate() - diffToMonday - 7);
      const end = new Date(d); end.setDate(end.getDate() + 6);
      return [fmt(d), fmt(end)];
    }
    case 'this_month': {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return [fmt(start), fmt(end)];
    }
    case 'last_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0);
      return [fmt(start), fmt(end)];
    }
    case 'this_quarter': {
      const q = Math.floor(now.getMonth() / 3);
      const start = new Date(now.getFullYear(), q * 3, 1);
      const end = new Date(now.getFullYear(), q * 3 + 3, 0);
      return [fmt(start), fmt(end)];
    }
    case 'last_quarter': {
      const q = Math.floor(now.getMonth() / 3) - 1;
      const y = q < 0 ? now.getFullYear() - 1 : now.getFullYear();
      const qn = ((q % 4) + 4) % 4;
      const start = new Date(y, qn * 3, 1);
      const end = new Date(y, qn * 3 + 3, 0);
      return [fmt(start), fmt(end)];
    }
    case 'this_year': {
      const start = new Date(now.getFullYear(), 0, 1);
      const end = new Date(now.getFullYear(), 11, 31);
      return [fmt(start), fmt(end)];
    }
    case 'last_year': {
      const start = new Date(now.getFullYear() - 1, 0, 1);
      const end = new Date(now.getFullYear() - 1, 11, 31);
      return [fmt(start), fmt(end)];
    }
    case 'last_7_days': {
      const d = new Date(now); d.setDate(d.getDate() - 6);
      return [fmt(d), today];
    }
    case 'last_30_days': {
      const d = new Date(now); d.setDate(d.getDate() - 29);
      return [fmt(d), today];
    }
    case 'last_90_days': {
      const d = new Date(now); d.setDate(d.getDate() - 89);
      return [fmt(d), today];
    }
    case 'custom':
    default:
      return ['', ''];
  }
}
