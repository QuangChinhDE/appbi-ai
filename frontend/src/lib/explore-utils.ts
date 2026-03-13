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
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'notContains' | 'in' | 'notIn';
  value: any;
}

export function applyFilters(rows: Record<string, any>[], filters: Filter[]): Record<string, any>[] {
  if (filters.length === 0) return rows;
  
  return rows.filter(row => {
    return filters.every(filter => {
      const fieldValue = row[filter.field];
      
      switch (filter.operator) {
        case 'eq':
          return fieldValue === filter.value;
        case 'neq':
          return fieldValue !== filter.value;
        case 'gt':
          return fieldValue > filter.value;
        case 'lt':
          return fieldValue < filter.value;
        case 'gte':
          return fieldValue >= filter.value;
        case 'lte':
          return fieldValue <= filter.value;
        case 'contains':
          return String(fieldValue).toLowerCase().includes(String(filter.value).toLowerCase());
        case 'notContains':
          return !String(fieldValue).toLowerCase().includes(String(filter.value).toLowerCase());
        case 'in':
          return Array.isArray(filter.value) && filter.value.includes(fieldValue);
        case 'notIn':
          return Array.isArray(filter.value) && !filter.value.includes(fieldValue);
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
