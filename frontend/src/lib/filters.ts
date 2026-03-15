/**
 * Shared filter types and utilities for both Explore and Dashboard
 */

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

/**
 * Base filter structure used by both Explore and Dashboard
 */
export interface BaseFilter {
  id: string;                // unique per filter (e.g. uuid)
  field: string;             // column name
  type: FilterType;          // 'date' | 'dropdown' | 'text' | 'number'
  operator: FilterOperator;  // default depends on type
  value: any;                // string | number | [min,max] | array
  label?: string;            // optional user-friendly label
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
  for (const row of rows) {
    const val = row[field];
    if (val === null || val === undefined) continue;

    // JS Date object
    if (val instanceof Date) return 'date';

    // Number
    if (typeof val === 'number') return 'number';

    // String heuristics
    if (typeof val === 'string') {
      // ISO date patterns: YYYY-MM-DD or YYYY-MM-DDTHH:mm
      if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(val)) return 'date';
      // Looks like a number string
      if (val.trim() !== '' && !isNaN(Number(val))) return 'number';
      return 'text';
    }
    break;
  }
  return 'text';
}

/**
 * Column name + inferred type, used by DashboardFilterBar
 */
export interface ColumnInfo {
  name: string;
  type: FilterType;
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
          const selected: string[] = f.value ?? [];
          if (!selected.length) return true;
          return selected.includes(String(val));
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
