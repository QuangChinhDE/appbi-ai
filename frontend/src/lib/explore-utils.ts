/**
 * Utilities for classifying fields as dimensions or measures
 */

export interface FieldMetadata {
  name: string;
  type: string;
  category: 'dimension' | 'measure';
}

/**
 * Classify a column as dimension or measure based on its type
 */
export function classifyField(columnName: string, columnType: string): FieldMetadata {
  const normalizedType = columnType.toLowerCase();
  
  // Numeric types are measures
  const numericTypes = [
    'number', 'int', 'integer', 'bigint', 'smallint', 'tinyint',
    'float', 'double', 'decimal', 'numeric', 'real',
    'int64', 'float64', 'int32', 'float32'
  ];
  
  const isMeasure = numericTypes.some(type => normalizedType.includes(type));
  
  return {
    name: columnName,
    type: columnType,
    category: isMeasure ? 'measure' : 'dimension',
  };
}

/**
 * Classify all columns from preview data
 */
export function classifyFields(columns: { name: string; type: string }[]): {
  dimensions: FieldMetadata[];
  measures: FieldMetadata[];
} {
  const dimensions: FieldMetadata[] = [];
  const measures: FieldMetadata[] = [];
  
  columns.forEach(col => {
    const field = classifyField(col.name, col.type);
    if (field.category === 'measure') {
      measures.push(field);
    } else {
      dimensions.push(field);
    }
  });
  
  return { dimensions, measures };
}

/**
 * Apply client-side filters to rows
 */
export interface Filter {
  field: string;
  operator: string; // see FilterBuilder OPERATORS_BY_TYPE
  value: any;
}

export function applyFilters(rows: Record<string, any>[], filters: Filter[]): Record<string, any>[] {
  if (filters.length === 0) return rows;

  return rows.filter(row => {
    return filters.every(filter => {
      const fieldValue = row[filter.field];
      const op = filter.operator;

      // ── Multi-value operators (type-agnostic) ─────────────────────────────
      if (op === 'in' || op === 'notIn' || op === 'not_in') {
        // Value can be array (new) or comma-separated string (legacy)
        let list: any[];
        if (Array.isArray(filter.value)) {
          list = filter.value;
        } else if (typeof filter.value === 'string' && filter.value.includes(',')) {
          list = filter.value.split(',').map(v => v.trim());
        } else {
          list = filter.value ? [filter.value] : [];
        }
        if (list.length === 0) return true; // empty selection = no filter
        const inList = list.map(String).includes(String(fieldValue));
        return op === 'in' ? inList : !inList;
      }

      // ── Between ───────────────────────────────────────────────────────────
      if (op === 'between') {
        const [lo, hi] = Array.isArray(filter.value) ? filter.value : [null, null];
        const strVal = String(fieldValue ?? '').slice(0, 10);
        // Try numeric first
        const numVal = Number(fieldValue);
        const isNumeric = !isNaN(numVal) && fieldValue !== '' && fieldValue !== null;
        if (isNumeric) {
          if (lo !== '' && lo !== null && lo !== undefined && numVal < Number(lo)) return false;
          if (hi !== '' && hi !== null && hi !== undefined && numVal > Number(hi)) return false;
        } else {
          // Date comparison (YYYY-MM-DD prefix)
          if (lo && strVal < String(lo).slice(0, 10)) return false;
          if (hi && strVal > String(hi).slice(0, 10)) return false;
        }
        return true;
      }

      // ── Null checks ───────────────────────────────────────────────────────
      if (op === 'is_null')     return fieldValue === null || fieldValue === undefined;
      if (op === 'is_not_null') return fieldValue !== null && fieldValue !== undefined;

      // ── Date comparisons ──────────────────────────────────────────────────
      // Normalise both sides to YYYY-MM-DD for robust date comparison
      const strFieldVal = String(fieldValue ?? '').slice(0, 10);
      const strFilterVal = String(filter.value ?? '').slice(0, 10);
      const isDateLike = /^\d{4}-\d{2}-\d{2}/.test(strFieldVal);

      if (isDateLike && ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(op)) {
        switch (op) {
          case 'eq':  return strFieldVal === strFilterVal;
          case 'neq': return strFieldVal !== strFilterVal;
          case 'gt':  return strFieldVal >  strFilterVal;
          case 'gte': return strFieldVal >= strFilterVal;
          case 'lt':  return strFieldVal <  strFilterVal;
          case 'lte': return strFieldVal <= strFilterVal;
        }
      }

      // ── Generic comparisons ───────────────────────────────────────────────
      switch (op) {
        case 'eq':
          // eslint-disable-next-line eqeqeq
          return fieldValue == filter.value;
        case 'neq':
          // eslint-disable-next-line eqeqeq
          return fieldValue != filter.value;
        case 'gt':
          return fieldValue > filter.value;
        case 'lt':
          return fieldValue < filter.value;
        case 'gte':
          return fieldValue >= filter.value;
        case 'lte':
          return fieldValue <= filter.value;
        case 'contains':
        case 'notContains': // legacy alias
          if (fieldValue === null || fieldValue === undefined) return false;
          const has = String(fieldValue).toLowerCase().includes(String(filter.value ?? '').toLowerCase());
          return op === 'contains' ? has : !has;
        case 'not_contains':
          if (fieldValue === null || fieldValue === undefined) return op === 'not_contains';
          return !String(fieldValue).toLowerCase().includes(String(filter.value ?? '').toLowerCase());
        case 'starts_with':
          if (fieldValue === null || fieldValue === undefined) return false;
          return String(fieldValue).toLowerCase().startsWith(String(filter.value ?? '').toLowerCase());
        default:
          return true;
      }
    });
  });
}

/**
 * Group and aggregate data client-side
 */
export interface Aggregation {
  field: string;
  function: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'countDistinct';
  alias?: string;
}

export function groupAndAggregate(
  rows: Record<string, any>[],
  groupByFields: string[],
  aggregations: Aggregation[]
): Record<string, any>[] {
  if (groupByFields.length === 0 && aggregations.length === 0) {
    return rows;
  }
  
  // Group rows
  const groups = new Map<string, Record<string, any>[]>();
  
  rows.forEach(row => {
    const groupKey = groupByFields.map(field => row[field]).join('|||');
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey)!.push(row);
  });
  
  // Aggregate each group
  const result: Record<string, any>[] = [];
  
  groups.forEach((groupRows, groupKey) => {
    const aggregatedRow: Record<string, any> = {};
    
    // Add group by fields
    groupByFields.forEach((field, index) => {
      const groupValues = groupKey.split('|||');
      aggregatedRow[field] = groupValues[index];
    });
    
    // Add aggregations
    aggregations.forEach(agg => {
      const alias = agg.alias || `${agg.function}_${agg.field}`;
      
      switch (agg.function) {
        case 'count':
          aggregatedRow[alias] = groupRows.length;
          break;
        case 'sum':
          aggregatedRow[alias] = groupRows.reduce((sum, row) => sum + (Number(row[agg.field]) || 0), 0);
          break;
        case 'avg':
          const sum = groupRows.reduce((s, row) => s + (Number(row[agg.field]) || 0), 0);
          aggregatedRow[alias] = sum / groupRows.length;
          break;
        case 'min':
          aggregatedRow[alias] = Math.min(...groupRows.map(row => Number(row[agg.field]) || 0));
          break;
        case 'max':
          aggregatedRow[alias] = Math.max(...groupRows.map(row => Number(row[agg.field]) || 0));
          break;
        case 'countDistinct':
          const uniqueValues = new Set(groupRows.map(row => row[agg.field]));
          aggregatedRow[alias] = uniqueValues.size;
          break;
      }
    });
    
    result.push(aggregatedRow);
  });
  
  return result;
}
