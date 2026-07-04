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

// Per-column stats for conditional formatting that needs the column's
// distribution: percentile thresholds (Feature #5), percentage-of-max, and
// data-bar min…max scaling (Feature #4). Keyed by the SOURCE column that drives
// the rule (sourceColumn ?? field).
export interface ConditionalColumnStats {
  min: number;
  max: number;
  sorted: number[]; // ascending — for percentile lookups
}
export type ConditionalStats = Record<string, ConditionalColumnStats>;

// Rich per-cell format output. `color`/`backgroundColor` = the legacy color
// styling; `dataBar` = an in-cell proportional bar; `icon` = an indicator glyph.
export interface CellFormat {
  color?: string;
  backgroundColor?: string;
  dataBar?: { ratio: number; color: string };
  icon?: { key: string; color?: string };
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

// A rule needs column distribution stats when it scales to the column:
// percentile / percentage benchmarks (Feature #5) or a data-bar (Feature #4).
function ruleNeedsStats(rule: ConditionalFormatRule): boolean {
  return (
    rule.mode === 'dataBar' ||
    rule.benchmarkType === 'percentile' ||
    rule.benchmarkType === 'percentage'
  );
}

/**
 * Build per-source-column stats (min/max/sorted) for the rules that scale to the
 * column (percentile, percentage, data bars). Keyed by the SOURCE column that
 * drives each such rule so cross-column rules (Feature #3) read the right values.
 */
export function buildConditionalStats(
  rows: Record<string, any>[],
  rules: ConditionalFormatRule[] | null,
): ConditionalStats {
  const stats: ConditionalStats = {};
  if (!rules || rules.length === 0 || rows.length === 0) return stats;
  const cols = new Set<string>();
  for (const rule of rules) {
    if (ruleNeedsStats(rule)) cols.add(rule.sourceColumn || rule.field);
  }
  for (const col of cols) {
    const nums = rows
      .map((r) => parseNumericCellValue(r?.[col]))
      .filter((v): v is number => v !== null);
    if (nums.length === 0) continue;
    const sorted = [...nums].sort((a, b) => a - b);
    stats[col] = { min: sorted[0], max: sorted[sorted.length - 1], sorted };
  }
  return stats;
}

// Value at the p-th percentile (0–100) of an ascending array (linear interp).
function percentileValue(sorted: number[], p: number): number | null {
  if (!sorted || sorted.length === 0) return null;
  const clampP = clamp(p, 0, 100);
  if (sorted.length === 1) return sorted[0];
  const idx = (clampP / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function compareOp(
  op: ConditionalFormatRule['operator'],
  a: number | null,
  b: number | null,
  aStr: string,
  bStr: string,
): boolean {
  switch (op) {
    case '>':  return a !== null && b !== null && a > b;
    case '<':  return a !== null && b !== null && a < b;
    case '>=': return a !== null && b !== null && a >= b;
    case '<=': return a !== null && b !== null && a <= b;
    case '=':  return (a !== null && b !== null) ? a === b : aStr === bStr;
    case '!=': return (a !== null && b !== null) ? a !== b : aStr !== bStr;
    default:   return false;
  }
}

/**
 * Compute the conditional-formatting output for one cell. Supports:
 *  - multiple rules with priority (first applicable wins) — Feature #1
 *  - cross-column: the condition reads `sourceColumn`, the style lands on
 *    `field` — Feature #3
 *  - benchmark types value | field | percentile | percentage — Feature #5
 *  - presentation modes color | dataBar | icon — Feature #4
 * Backward-compatible: a legacy rule {field, operator, value|benchmarkField,
 * color, backgroundColor} behaves exactly as before.
 *
 * @param value  the styled cell's value (rule.field's cell)
 * @param field  the column being rendered
 * @param rules  conditional rules
 * @param row    the full row (needed for cross-column + benchmarkField)
 * @param stats  column stats from buildConditionalStats (for percentile/%/dataBar)
 */
export function getCellStyle(
  value: any,
  field: string,
  rules: ConditionalFormatRule[] | null,
  row?: Record<string, any>,
  stats?: ConditionalStats | null,
): CellFormat {
  if (!rules || rules.length === 0) return {};
  const applicableRules = rules.filter((rule) => rule.field === field);

  for (const rule of applicableRules) {
    const mode = rule.mode || 'color';
    const srcCol = rule.sourceColumn || rule.field;
    // The value that DRIVES the condition (cross-column reads another column).
    const srcRaw = row && srcCol in row ? row[srcCol] : value;
    const srcNum = parseNumericCellValue(srcRaw);
    const colStats = stats?.[srcCol];

    // Data bars are column-wide (no condition) — draw a bar ∝ value in min…max.
    if (mode === 'dataBar') {
      if (srcNum === null || !colStats) continue;
      const span = colStats.max - colStats.min;
      const ratio = span <= 0 ? 1 : clamp((srcNum - colStats.min) / span, 0, 1);
      return { dataBar: { ratio, color: rule.barColor || '#3b82f6' } };
    }

    // color / icon: evaluate the condition.
    const benchmarkType =
      rule.benchmarkType || (rule.benchmarkField ? 'field' : 'value');
    let matches = false;

    if (benchmarkType === 'percentile') {
      const p = parseNumericCellValue(rule.value);
      const threshold = p !== null && colStats ? percentileValue(colStats.sorted, p) : null;
      matches = compareOp(rule.operator, srcNum, threshold, String(srcRaw ?? ''), String(threshold ?? ''));
    } else if (benchmarkType === 'percentage') {
      const target = parseNumericCellValue(rule.value);
      const pct = colStats && colStats.max !== 0 && srcNum !== null ? (srcNum / colStats.max) * 100 : null;
      matches = compareOp(rule.operator, pct, target, String(pct ?? ''), String(target ?? ''));
    } else {
      const benchmarkRaw = benchmarkType === 'field' ? row?.[rule.benchmarkField ?? ''] : rule.value;
      if (benchmarkRaw === undefined || benchmarkRaw === null || benchmarkRaw === '') continue;
      const ruleNum = parseNumericCellValue(benchmarkRaw);
      if (srcNum === null && ['>', '<', '>=', '<='].includes(rule.operator)) continue;
      matches = compareOp(rule.operator, srcNum, ruleNum, String(srcRaw ?? ''), String(benchmarkRaw ?? ''));
    }

    if (!matches) continue;

    if (mode === 'icon') {
      const out: CellFormat = { icon: { key: rule.icon || 'flag', color: rule.color } };
      if (rule.backgroundColor) out.backgroundColor = rule.backgroundColor;
      return out;
    }
    return { color: rule.color, backgroundColor: rule.backgroundColor };
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
