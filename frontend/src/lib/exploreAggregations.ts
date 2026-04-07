/**
 * Explore 2.0: Aggregation, grouping, sorting, and conditional formatting utilities
 */
import { 
  AggregationFn, 
  MeasureConfig, 
  SortConfig, 
  ConditionalFormatRule, 
  TableHeatmapRule,
  GroupingConfig 
} from '@/types/api';

export interface TableHeatmapStats {
  [field: string]: {
    min: number;
    max: number;
  };
}

/**
 * Apply an aggregation function to an array of values
 */
export function applyAggregation(values: any[], agg: AggregationFn): number {
  const numericValues = values
    .map(v => typeof v === 'number' ? v : parseFloat(v))
    .filter(v => !isNaN(v));
  
  if (numericValues.length === 0) return 0;
  
  switch (agg) {
    case 'sum':
      return numericValues.reduce((a, b) => a + b, 0);
    
    case 'avg':
      return numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
    
    case 'count':
      return values.length; // Count all values, not just numeric
    
    case 'min':
      return Math.min(...numericValues);
    
    case 'max':
      return Math.max(...numericValues);
    
    default:
      return 0;
  }
}

/**
 * Aggregate data based on grouping and measure configurations
 * 
 * @param rawRows - Original data rows from dataset
 * @param grouping - Grouping configuration (rowDimensions, columnDimension)
 * @param measureConfigs - Measure configurations with aggregation functions
 * @returns Aggregated rows and optional pivot columns
 */
export function aggregateData(
  rawRows: any[],
  grouping: GroupingConfig | null,
  measureConfigs: MeasureConfig[]
): {
  rows: any[];
  pivotColumns: string[] | null;
} {
  if (!rawRows || rawRows.length === 0) {
    return { rows: [], pivotColumns: null };
  }
  
  // No grouping - return raw data with measure columns
  if (!grouping || grouping.rowDimensions.length === 0) {
    return { rows: rawRows, pivotColumns: null };
  }
  
  const { rowDimensions, columnDimension } = grouping;
  
  // Case 1: Only row dimensions (no pivot)
  if (!columnDimension) {
    const grouped = new Map<string, any[]>();
    
    // Group rows by rowDimensions
    rawRows.forEach(row => {
      const key = rowDimensions.map(dim => row[dim]).join('|||');
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(row);
    });
    
    // Aggregate each group
    const aggregatedRows = Array.from(grouped.entries()).map(([key, groupRows]) => {
      const row: any = {};
      
      // Add dimension values
      rowDimensions.forEach((dim, i) => {
        row[dim] = key.split('|||')[i];
      });
      
      // Add aggregated measures
      measureConfigs.forEach(mc => {
        const values = groupRows.map(r => r[mc.field]);
        row[mc.field] = applyAggregation(values, mc.agg);
      });
      
      return row;
    });
    
    return { rows: aggregatedRows, pivotColumns: null };
  }
  
  // Case 2: Pivot table (rowDimensions + columnDimension)
  const grouped = new Map<string, Map<string, any[]>>();
  const columnValues = new Set<string>();
  
  // Group by rowDimensions and columnDimension
  rawRows.forEach(row => {
    const rowKey = rowDimensions.map(dim => row[dim]).join('|||');
    const colValue = String(row[columnDimension] ?? '');
    
    columnValues.add(colValue);
    
    if (!grouped.has(rowKey)) {
      grouped.set(rowKey, new Map());
    }
    if (!grouped.get(rowKey)!.has(colValue)) {
      grouped.get(rowKey)!.set(colValue, []);
    }
    grouped.get(rowKey)!.get(colValue)!.push(row);
  });
  
  const pivotColumns = Array.from(columnValues).sort();
  
  // Create pivot rows
  const pivotRows = Array.from(grouped.entries()).map(([rowKey, colMap]) => {
    const row: any = {};
    
    // Add row dimension values
    rowDimensions.forEach((dim, i) => {
      row[dim] = rowKey.split('|||')[i];
    });
    
    // Add aggregated values for each column x measure combination
    pivotColumns.forEach(colValue => {
      const cellRows = colMap.get(colValue) || [];
      
      measureConfigs.forEach(mc => {
        const values = cellRows.map(r => r[mc.field]);
        const aggValue = applyAggregation(values, mc.agg);
        const columnKey = `${colValue}_${mc.field}`;
        row[columnKey] = aggValue;
      });
    });
    
    return row;
  });
  
  return { rows: pivotRows, pivotColumns };
}

/**
 * Sort rows based on sort configurations
 * 
 * @param rows - Rows to sort
 * @param sorts - Sort configurations (ordered by index)
 * @returns Sorted rows
 */
export function sortRows(rows: any[], sorts: SortConfig[] | null): any[] {
  if (!sorts || sorts.length === 0 || rows.length === 0) {
    return rows;
  }
  
  // Sort by index to get priority order
  const orderedSorts = [...sorts].sort((a, b) => a.index - b.index);
  
  return [...rows].sort((a, b) => {
    for (const sort of orderedSorts) {
      const aVal = a[sort.field];
      const bVal = b[sort.field];
      
      // Handle null/undefined
      if (aVal == null && bVal == null) continue;
      if (aVal == null) return sort.direction === 'asc' ? 1 : -1;
      if (bVal == null) return sort.direction === 'asc' ? -1 : 1;
      
      // Compare values
      let comparison = 0;
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        comparison = aVal - bVal;
      } else {
        comparison = String(aVal).localeCompare(String(bVal));
      }
      
      if (comparison !== 0) {
        return sort.direction === 'asc' ? comparison : -comparison;
      }
    }
    
    return 0;
  });
}

export function parseNumericCellValue(value: any): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/,/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function buildTableHeatmapStats(
  rows: Record<string, any>[],
  rules: TableHeatmapRule[] | null,
): TableHeatmapStats {
  if (!rules || rules.length === 0 || rows.length === 0) {
    return {};
  }

  const stats: TableHeatmapStats = {};

  rules.forEach((rule) => {
    const numericValues = rows
      .map((row) => parseNumericCellValue(row?.[rule.field]))
      .filter((value): value is number => value !== null);

    if (numericValues.length === 0) {
      return;
    }

    stats[rule.field] = {
      min: Math.min(...numericValues),
      max: Math.max(...numericValues),
    };
  });

  return stats;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeHexColor(color: string): string {
  const trimmed = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    const chars = trimmed.slice(1).split('');
    return `#${chars.map((char) => `${char}${char}`).join('')}`;
  }
  return '#dbeafe';
}

function hexToRgb(color: string): { r: number; g: number; b: number } {
  const normalized = normalizeHexColor(color);
  return {
    r: parseInt(normalized.slice(1, 3), 16),
    g: parseInt(normalized.slice(3, 5), 16),
    b: parseInt(normalized.slice(5, 7), 16),
  };
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const toHex = (value: number) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function interpolateColor(from: string, to: string, ratio: number): string {
  const start = hexToRgb(from);
  const end = hexToRgb(to);
  const safeRatio = clamp(ratio, 0, 1);
  return rgbToHex({
    r: start.r + (end.r - start.r) * safeRatio,
    g: start.g + (end.g - start.g) * safeRatio,
    b: start.b + (end.b - start.b) * safeRatio,
  });
}

function getContrastingTextColor(backgroundColor: string): string {
  const { r, g, b } = hexToRgb(backgroundColor);
  const luminance = (0.299 * r) + (0.587 * g) + (0.114 * b);
  return luminance > 170 ? '#0f172a' : '#f8fafc';
}

export function getHeatmapCellStyle(
  value: any,
  field: string,
  rules: TableHeatmapRule[] | null,
  stats: TableHeatmapStats,
): { color?: string; backgroundColor?: string } {
  if (!rules || rules.length === 0) {
    return {};
  }

  const rule = rules.find((item) => item.field === field);
  if (!rule) {
    return {};
  }

  const numericValue = parseNumericCellValue(value);
  const columnStats = stats[field];
  if (numericValue === null || !columnStats) {
    return {};
  }

  const steps = clamp(Math.round(rule.steps ?? 5), 2, 9);
  const { min, max } = columnStats;
  const rawRatio = max === min ? 0.5 : (numericValue - min) / (max - min);
  const normalizedRatio = clamp(rawRatio, 0, 1);
  const bucketIndex = Math.min(steps - 1, Math.floor(normalizedRatio * steps));
  const bucketRatio = steps === 1 ? 1 : bucketIndex / (steps - 1);
  const backgroundColor = interpolateColor(
    rule.minColor ?? '#eff6ff',
    rule.maxColor ?? '#1d4ed8',
    bucketRatio,
  );

  return {
    backgroundColor,
    color: getContrastingTextColor(backgroundColor),
  };
}

/**
 * Get cell style based on conditional formatting rules
 * 
 * @param value - Cell value
 * @param field - Field name
 * @param rules - Conditional formatting rules
 * @returns Style object with color and backgroundColor
 */
export function getCellStyle(
  value: any,
  field: string,
  rules: ConditionalFormatRule[] | null,
  row?: Record<string, any>,
): { color?: string; backgroundColor?: string } {
  if (!rules || rules.length === 0) {
    return {};
  }
  
  const applicableRules = rules.filter(rule => rule.field === field);
  
  for (const rule of applicableRules) {
    const benchmarkValue = rule.benchmarkField ? row?.[rule.benchmarkField] : rule.value;
    if (benchmarkValue === undefined || benchmarkValue === null || benchmarkValue === '') {
      continue;
    }

    const numValue = parseNumericCellValue(value);
    const ruleValue = parseNumericCellValue(benchmarkValue);
    
    // Skip if values can't be compared numerically and operator is numeric
    if (numValue === null && ['>', '<', '>=', '<='].includes(rule.operator)) {
      continue;
    }
    
    let matches = false;
    
    switch (rule.operator) {
      case '>':
        matches = numValue !== null && ruleValue !== null && numValue > ruleValue;
        break;
      case '<':
        matches = numValue !== null && ruleValue !== null && numValue < ruleValue;
        break;
      case '>=':
        matches = numValue !== null && ruleValue !== null && numValue >= ruleValue;
        break;
      case '<=':
        matches = numValue !== null && ruleValue !== null && numValue <= ruleValue;
        break;
      case '=':
        matches = numValue !== null && ruleValue !== null
          ? numValue === ruleValue
          : String(value ?? '') === String(benchmarkValue ?? '');
        break;
      case '!=':
        matches = numValue !== null && ruleValue !== null
          ? numValue !== ruleValue
          : String(value ?? '') !== String(benchmarkValue ?? '');
        break;
    }
    
    if (matches) {
      return {
        color: rule.color,
        backgroundColor: rule.backgroundColor
      };
    }
  }
  
  return {};
}

/**
 * Format aggregation function name for display
 */
export function formatAggregationLabel(agg: AggregationFn): string {
  const labels: Record<AggregationFn, string> = {
    sum: 'SUM',
    avg: 'AVG',
    count: 'COUNT',
    min: 'MIN',
    max: 'MAX'
  };
  return labels[agg] || agg.toUpperCase();
}

/**
 * Get default aggregation for a measure
 */
export function getDefaultAggregation(measureName: string): AggregationFn {
  // You could analyze field name or type to determine default
  // For now, default to sum for all measures
  return 'sum';
}
