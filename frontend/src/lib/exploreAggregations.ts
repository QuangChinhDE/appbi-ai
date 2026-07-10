/**
 * Explore 2.0: Aggregation, grouping, sorting, and conditional formatting utilities
 */
import {
  ConditionalFormatRule,
  TableHeatmapRule,
  BenchmarkLineDef,
  BenchmarkAggregate,
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

/**
 * Per-column DATE display formats for the table. Kept SEPARATE from NumberFormat
 * so a date column never gets number-formatted (the old bug: a date column's
 * only format options were number ones, which no-op on an ISO string — so dates
 * were unformattable). These values never collide with NumberFormat
 * ('auto'|'number'|'compact'|'percent'|'currency').
 */
export type DateFormatKind =
  | 'date_iso'    // 2024-03-24
  | 'date_dmy'    // 24/03/2024
  | 'date_mdy'    // 03/24/2024
  | 'date_med'    // 24 Mar 2024
  | 'date_long'   // 24 March 2024
  | 'month_year'  // Mar 2024
  | 'year'        // 2024
  | 'datetime';   // 2024-03-24 14:30

export const DATE_FORMAT_OPTIONS: Array<{ value: DateFormatKind; label: string }> = [
  { value: 'date_iso', label: '2024-03-24' },
  { value: 'date_dmy', label: '24/03/2024' },
  { value: 'date_mdy', label: '03/24/2024' },
  { value: 'date_med', label: '24 Mar 2024' },
  { value: 'date_long', label: '24 March 2024' },
  { value: 'month_year', label: 'Mar 2024' },
  { value: 'year', label: '2024' },
  { value: 'datetime', label: '2024-03-24 14:30' },
];

const _DATE_FORMAT_KINDS = new Set<string>(DATE_FORMAT_OPTIONS.map((o) => o.value));

export function isDateFormatKind(value: unknown): value is DateFormatKind {
  return typeof value === 'string' && _DATE_FORMAT_KINDS.has(value);
}

const _MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const _MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const _p2 = (n: number) => String(n).padStart(2, '0');

/**
 * Format a date-ish cell value per a DateFormatKind.
 *
 * Timezone-safe: ISO-ish strings (`YYYY-MM-DD`, `YYYY-MM`, `YYYY`, `YYYY-MM-DDThh:mm`)
 * are parsed by REGEX and formatted from their literal Y/M/D parts — never routed
 * through `new Date(...)`, which would shift a date-only value across midnight in
 * non-UTC zones (the classic off-by-one). Only genuinely non-ISO values fall back
 * to Date (read via UTC getters). A value that isn't a date at all is returned
 * unchanged, so applying a date format to a stray column can't mangle it.
 */
export function formatDateCellValue(value: any, kind: DateFormatKind): string {
  if (value === null || value === undefined || value === '') return '';
  const raw = value instanceof Date ? value.toISOString() : String(value).trim();

  let y: number, mo: number, d: number;
  let hh: number | null = null;
  let mi: number | null = null;

  const m = raw.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ](\d{2}):(\d{2}))?/);
  if (m) {
    y = Number(m[1]);
    mo = Number(m[2]);
    d = m[3] ? Number(m[3]) : 1;
    if (m[4]) { hh = Number(m[4]); mi = Number(m[5] ?? '0'); }
  } else if (/^\d{8}$/.test(raw)) {
    // YYYYMMDD integer date
    y = Number(raw.slice(0, 4)); mo = Number(raw.slice(4, 6)); d = Number(raw.slice(6, 8));
  } else {
    const dt = new Date(raw);
    if (Number.isNaN(dt.getTime())) return String(value); // not a date → leave as-is
    y = dt.getUTCFullYear(); mo = dt.getUTCMonth() + 1; d = dt.getUTCDate();
    hh = dt.getUTCHours(); mi = dt.getUTCMinutes();
  }
  if (mo < 1 || mo > 12) return String(value); // guard against non-date "YYYY-NN"

  switch (kind) {
    case 'date_dmy': return `${_p2(d)}/${_p2(mo)}/${y}`;
    case 'date_mdy': return `${_p2(mo)}/${_p2(d)}/${y}`;
    case 'date_med': return `${d} ${_MON_SHORT[mo - 1]} ${y}`;
    case 'date_long': return `${d} ${_MON_LONG[mo - 1]} ${y}`;
    case 'month_year': return `${_MON_SHORT[mo - 1]} ${y}`;
    case 'year': return `${y}`;
    case 'datetime': return `${y}-${_p2(mo)}-${_p2(d)}${hh !== null ? ` ${_p2(hh)}:${_p2(mi ?? 0)}` : ''}`;
    case 'date_iso':
    default: return `${y}-${_p2(mo)}-${_p2(d)}`;
  }
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

// ── Benchmark / reference lines ──────────────────────────────────────────────
// Resolve the chart's benchmark lines (multiple, each fixed OR a dynamic
// aggregate of a metric over the CURRENT rows) into concrete y/x values +
// styling. Shared by both chart renderers (ExploreChart + ChartPreview).
export interface ResolvedBenchmarkLine {
  value: number;
  label?: string;
  color: string;
  dash?: string; // strokeDasharray; undefined = solid
}

interface BenchmarkStyleInput {
  showBenchmarkLine?: boolean;
  benchmarkValue?: number | '';
  benchmarkLabel?: string;
  benchmarkColor?: string;
  benchmarkLineStyle?: 'solid' | 'dashed';
  benchmarkLines?: BenchmarkLineDef[];
}

function aggregateBenchmark(nums: number[], agg: BenchmarkAggregate, pct?: number): number | null {
  if (nums.length === 0) return null;
  switch (agg) {
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min': return Math.min(...nums);
    case 'max': return Math.max(...nums);
    case 'median': {
      const s = [...nums].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }
    case 'percentile': return percentileValue([...nums].sort((a, b) => a - b), pct ?? 50);
    default: return null;
  }
}

export function resolveBenchmarkLines(
  style: BenchmarkStyleInput | null | undefined,
  rows: Record<string, any>[],
): ResolvedBenchmarkLine[] {
  if (!style || !style.showBenchmarkLine) return [];
  // New array model wins; else synthesize a single line from the legacy scalars.
  let defs: BenchmarkLineDef[] = [];
  if (Array.isArray(style.benchmarkLines) && style.benchmarkLines.length > 0) {
    defs = style.benchmarkLines;
  } else if (style.benchmarkValue !== '' && style.benchmarkValue != null) {
    defs = [{
      source: 'value',
      value: style.benchmarkValue,
      label: style.benchmarkLabel,
      color: style.benchmarkColor,
      lineStyle: style.benchmarkLineStyle,
    }];
  }
  const out: ResolvedBenchmarkLine[] = [];
  for (const d of defs) {
    let val: number | null = null;
    if ((d.source ?? 'value') === 'aggregate' && d.field) {
      const nums = (rows || [])
        .map((r) => parseNumericCellValue(r?.[d.field as string]))
        .filter((v): v is number => v !== null);
      val = aggregateBenchmark(nums, d.aggregate ?? 'avg', d.percentile);
    } else {
      const n = typeof d.value === 'number' ? d.value : Number(d.value);
      val = Number.isFinite(n) ? n : null;
    }
    if (val === null) continue;
    out.push({
      value: val,
      label: (d.label ?? '').trim() || undefined,
      color: d.color || '#dc2626',
      dash: d.lineStyle === 'solid' ? undefined : '6 4',
    });
  }
  return out;
}

// KPI manual benchmark calculation (Feature): apply `base × multiplier + offset`
// to the benchmark base (dynamic Target metric OR manual value) so a target can
// be expressed relative to a live value, e.g. Goal × 1.1 = beat goal by 10%.
export function applyKpiBenchmarkCalc(
  base: number | null | undefined,
  opts: { kpiBenchmarkMultiplier?: number | ''; kpiBenchmarkOffset?: number | '' } | null | undefined,
): number | null {
  if (base === null || base === undefined || !Number.isFinite(base)) return base ?? null;
  const m = opts?.kpiBenchmarkMultiplier;
  const o = opts?.kpiBenchmarkOffset;
  const mult = typeof m === 'number' && Number.isFinite(m) ? m : 1;
  const off = typeof o === 'number' && Number.isFinite(o) ? o : 0;
  return base * mult + off;
}
