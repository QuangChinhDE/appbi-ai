import { applyFiltersToRows } from '@/lib/filters';
import type { BaseFilter } from '@/lib/filters';
import {
  getChartRoleConfigValidationMessage,
  metricKey,
  metricLabel,
  normalizeRoleConfig,
  TABLE_PIVOT_COLUMN_LIMIT,
  type CalculatedFieldDef,
  type ChartRoleConfig,
  type MetricConfig,
  type SemanticLabelMap,
} from './ExploreChartConfig';

/**
 * Phase-15.82 — inline calculated-field evaluator.
 *
 * SECURITY: this is run for every saved chart, including on public /
 * embed dashboards seen by anonymous viewers. A previous draft used
 * `new Function(expression)` with a whitelist regex; that was leaky —
 * strings like `${a}.constructor.constructor("alert(1)")()` slipped past
 * the regex and ran arbitrary JS in the viewer's browser.
 *
 * This implementation is a hand-written tokeniser + shunting-yard parser
 * with NO `eval` / `new Function` / `Function` references anywhere.
 * Grammar:
 *
 *   expr   := term (('+' | '-') term)*
 *   term   := factor (('*' | '/' | '%') factor)*
 *   factor := number | '${' ident '}' | '(' expr ')' | '-' factor
 *   number := /\d+(\.\d+)?/
 *   ident  := /[A-Za-z0-9_.]+/
 *
 * Anything outside that grammar fails the parser → NaN. Division by
 * zero → NaN (not Infinity, so the chart skips the point instead of
 * blowing the Y-axis).
 */
type Token =
  | { type: 'num'; value: number }
  | { type: 'op'; value: '+' | '-' | '*' | '/' | '%' }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'ref'; key: string };

function tokenizeCalcExpr(expr: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === ' ' || ch === '\t' || ch === '\n') { i++; continue; }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%') {
      tokens.push({ type: 'op', value: ch });
      i++; continue;
    }
    if (ch === '(') { tokens.push({ type: 'lparen' }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'rparen' }); i++; continue; }
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < expr.length && ((expr[j] >= '0' && expr[j] <= '9') || expr[j] === '.')) j++;
      const num = Number(expr.slice(i, j));
      if (!Number.isFinite(num)) return null;
      tokens.push({ type: 'num', value: num });
      i = j; continue;
    }
    if (ch === '$' && expr[i + 1] === '{') {
      const close = expr.indexOf('}', i + 2);
      if (close === -1) return null;
      const key = expr.slice(i + 2, close);
      // Only [A-Za-z0-9_.] allowed inside ${...}. No brackets, quotes, parens.
      if (!/^[A-Za-z0-9_.]+$/.test(key)) return null;
      tokens.push({ type: 'ref', key });
      i = close + 1; continue;
    }
    // Anything else is illegal.
    return null;
  }
  return tokens;
}

// Shunting-yard: tokens → reverse-Polish.
const PRECEDENCE: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2 };
function toRpn(tokens: Token[]): Token[] | null {
  const output: Token[] = [];
  const stack: Token[] = [];
  let prevType: string | null = null;
  for (const tok of tokens) {
    if (tok.type === 'num' || tok.type === 'ref') {
      output.push(tok);
    } else if (tok.type === 'op') {
      // Handle unary minus: `-x` or `(-x)` or `*-x` → push 0 first.
      if (tok.value === '-' && (prevType === null || prevType === 'op' || prevType === 'lparen')) {
        output.push({ type: 'num', value: 0 });
      } else if (tok.value === '+' && (prevType === null || prevType === 'op' || prevType === 'lparen')) {
        prevType = tok.type;
        continue; // unary plus = no-op
      }
      while (
        stack.length > 0 &&
        stack[stack.length - 1].type === 'op' &&
        PRECEDENCE[(stack[stack.length - 1] as any).value] >= PRECEDENCE[tok.value]
      ) {
        output.push(stack.pop()!);
      }
      stack.push(tok);
    } else if (tok.type === 'lparen') {
      stack.push(tok);
    } else if (tok.type === 'rparen') {
      while (stack.length > 0 && stack[stack.length - 1].type !== 'lparen') {
        output.push(stack.pop()!);
      }
      if (stack.length === 0) return null; // unbalanced
      stack.pop(); // pop lparen
    }
    prevType = tok.type;
  }
  while (stack.length > 0) {
    const top = stack.pop()!;
    if (top.type === 'lparen' || top.type === 'rparen') return null; // unbalanced
    output.push(top);
  }
  return output;
}

function evalRpn(rpn: Token[], row: Record<string, any>): number {
  const stack: number[] = [];
  for (const tok of rpn) {
    if (tok.type === 'num') {
      stack.push(tok.value);
    } else if (tok.type === 'ref') {
      // Avoid prototype chain — only read own enumerable properties.
      const raw = Object.prototype.hasOwnProperty.call(row, tok.key) ? (row as any)[tok.key] : 0;
      const num = Number(raw);
      stack.push(Number.isFinite(num) ? num : 0);
    } else if (tok.type === 'op') {
      if (stack.length < 2) return NaN;
      const b = stack.pop()!;
      const a = stack.pop()!;
      let res: number;
      switch (tok.value) {
        case '+': res = a + b; break;
        case '-': res = a - b; break;
        case '*': res = a * b; break;
        case '/': res = b === 0 ? NaN : a / b; break;
        case '%': res = b === 0 ? NaN : a % b; break;
        default: return NaN;
      }
      stack.push(res);
    } else {
      return NaN;
    }
  }
  if (stack.length !== 1) return NaN;
  return Number.isFinite(stack[0]) ? stack[0] : NaN;
}

export function evaluateCalculatedField(
  expression: string,
  row: Record<string, any>,
): number {
  if (!expression) return NaN;
  // Cheap upper bound to defend against pathological inputs.
  if (expression.length > 500) return NaN;
  const tokens = tokenizeCalcExpr(expression);
  if (!tokens || tokens.length === 0) return NaN;
  const rpn = toRpn(tokens);
  if (!rpn) return NaN;
  return evalRpn(rpn, row);
}

export function applyCalculatedFields(
  rows: Record<string, any>[],
  fields: CalculatedFieldDef[] = [],
): Record<string, any>[] {
  if (fields.length === 0) return rows;
  return rows.map((row) => {
    const next: Record<string, any> = { ...row };
    for (const f of fields) {
      next[f.id] = evaluateCalculatedField(f.expression, row);
    }
    return next;
  });
}

/**
 * Phase-15.83 — DA decision: render every row, no FE-side truncation.
 *
 * Previously the FE capped at 2000 (with a Phase-15.82 opt-in to 50k via
 * `showAllPoints`). DA judged the trade-off — "render lag if dataset is
 * huge" beats "chart shows the wrong total because rows got cut" — and
 * asked us to drop both caps. The constants stay exported (with very
 * large fallback values) for callers that still reference them, but
 * `limitRows()` is now a no-op: it returns `truncated: false` always
 * and lets the banner code below disappear.
 *
 * If browsers start choking on very large datasets we re-introduce a
 * smarter sampler later (server-side row_limit per chart, à la
 * Superset), not another client-side hard cap.
 */
export const MAX_CHART_POINTS = Number.POSITIVE_INFINITY;
export const ABSOLUTE_MAX_CHART_POINTS = Number.POSITIVE_INFINITY;

export interface ChartSeriesDef {
  key: string;
  label: string;
  metric?: MetricConfig;
}

export interface ExploreChartModel {
  roleConfig: ChartRoleConfig;
  invalidMessage?: string;
  xField?: string;
  tableData: Record<string, any>[];
  tableColumns: string[];
  truncated: boolean;
  totalPoints: number;
  categoricalData: Record<string, any>[];
  categoricalSeries: ChartSeriesDef[];
  comboData: Record<string, any>[];
  comboBarSeries: ChartSeriesDef[];
  comboLineSeries: ChartSeriesDef[];
  pieData: Array<{ name: string; value: number }>;
  kpiValue?: number;
  kpiMetric?: MetricConfig;
  kpiBenchmarkValue?: number;
  kpiBenchmarkMetric?: MetricConfig;
  scatterPoints: Array<{ x: number; y: number; label?: any }>;
}

function dedupeMetrics(metrics: MetricConfig[]): MetricConfig[] {
  const seen = new Set<string>();
  const deduped: MetricConfig[] = [];
  for (const metric of metrics) {
    const key = metricKey(metric);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(metric);
  }
  return deduped;
}

function metricOutputCandidates(metric: MetricConfig): string[] {
  const candidates = [
    metricKey(metric),
    metric.outputField,
    `${metric.agg}__${metric.field}`,
    `${metric.field}_${metric.agg}`,
    `${metric.agg}_${metric.field}`,
    `${metric.field}__${metric.agg}`,
    metric.field,
  ].filter((value): value is string => Boolean(value));
  return Array.from(new Set(candidates));
}

function resolveMetricValueField(
  rows: Record<string, any>[],
  metric: MetricConfig,
  preAggregated = false,
): string {
  // For BOTH pre-aggregated AND raw paths we look up `metric.field` first
  // because the semantic engine remaps row keys back to canonical
  // qualified refs (chart_service.remap_semantic_engine_rows) — that's
  // the form the FE caller asked for, so it's the most likely hit.
  //
  // Phase-15.8: previously the pre-aggregated path skipped metric.field
  // entirely and only tried the metricKey() candidates, which made
  // post-remap rows look "unrecognised" — chart adapter then fell back
  // to metric.field anyway via the `?? metric.field` tail, but the
  // downstream `categoricalData: data` assignment kept the raw row
  // shape so Recharts (which expects keys = metricKey()) couldn't find
  // any values and rendered an empty chart.
  const candidates = [metric.field, ...metricOutputCandidates(metric)];

  return candidates.find((candidate) => rows.some((row) => candidate in row)) ?? metric.field;
}

/**
 * Phase-15.8 — Bridge BE row keys to the recharts `dataKey` contract.
 *
 * DA bug: table OK but chart blank.
 *
 * Root cause: the semantic engine emits row keys in canonical qualified
 * form (`"view.field"`), but every recharts series in
 * `buildExploreChartModel` is keyed by `metricKey(metric)` (i.e.
 * `"${agg}__${field}"`). When the adapter's `applyGroupByAgg` runs (raw
 * data path) it rewrites rows to use `metricKey` as the value key — but
 * when `preAggregated=true` (the semantic engine / saved-chart path)
 * the adapter previously just forwarded the raw rows. Recharts then
 * read `row["sum__view.amount"]` → undefined → blank chart.
 *
 * Fix: when we know the data is pre-aggregated, walk every row once and
 * remap every metric's value field to its canonical metricKey alias.
 * `resolveMetricValueField` handles whichever shape the BE actually
 * emitted (qualified ref, bare, `agg__field`, …) so the rewrite is
 * defensive against future changes to the engine's alias scheme.
 */
function rewriteRowsForRecharts(
  rows: Record<string, any>[],
  metrics: MetricConfig[],
  preAggregated: boolean,
): Record<string, any>[] {
  if (!preAggregated || rows.length === 0 || metrics.length === 0) return rows;
  // Pre-compute the value source field per metric — this is the column
  // recharts actually needs to read from. Map<canonicalMetricKey, sourceField>.
  const sourceByMetricKey = new Map<string, string>();
  for (const metric of metrics) {
    const sourceField = resolveMetricValueField(rows, metric, true);
    const targetKey = metricKey(metric);
    if (sourceField !== targetKey) {
      sourceByMetricKey.set(targetKey, sourceField);
    }
  }
  // No remap needed — every metric already keyed correctly. Return rows
  // unchanged so we don't allocate a new array (hot path on dashboards
  // with many tiles).
  if (sourceByMetricKey.size === 0) return rows;

  return rows.map((row) => {
    const next: Record<string, any> = { ...row };
    for (const [targetKey, sourceField] of sourceByMetricKey) {
      // Only write the target key when the source actually has a value
      // on this row; preserves null/undefined semantics so recharts
      // skips missing points instead of plotting 0.
      if (sourceField in row) {
        next[targetKey] = row[sourceField];
      }
    }
    return next;
  });
}

function aggregateMetricValue(
  rows: Record<string, any>[],
  metric: MetricConfig,
  valueField: string = metric.field,
  aggregatedInput = false,
): number {
  const values = rows.map(row => Number(row[valueField]) || 0);
  switch (metric.agg) {
    case 'avg':
      return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
    case 'count':
      return aggregatedInput
        ? values.reduce((sum, value) => sum + value, 0)
        : rows.length;
    case 'min':
      return values.length > 0 ? Math.min(...values) : 0;
    case 'max':
      return values.length > 0 ? Math.max(...values) : 0;
    case 'count_distinct':
      return aggregatedInput
        ? values.reduce((sum, value) => sum + value, 0)
        : new Set(rows.map(row => row[valueField])).size;
    case 'sum':
    default:
      return values.reduce((sum, value) => sum + value, 0);
  }
}

/**
 * Group rows by an exact-equality match on `dimField` and aggregate every
 * metric per group.
 *
 * GRANULARITY CONTRACT (DA review 2026-05-16):
 *
 * This function does NOT bucket time — it groups by string-equality of
 * `row[dimField]`. That works in two scenarios only:
 *
 *   A. `preAggregated=true` is passed by the caller because the BE has
 *      already emitted SELECT … GROUP BY date_trunc(…) on the time
 *      dimension. The rows arriving here are at the chart's intended
 *      granularity (one row per bucket). This is the standard path —
 *      see `SemanticQueryEngine._build_group_by_clause`.
 *
 *   B. `dimField` is a categorical (not a raw timestamp). Each distinct
 *      string value is its own group — correct by definition.
 *
 * Scenarios that BREAK if we get here with raw timestamps:
 *   - live_query path on a non-bucketed datetime column. Every distinct
 *     timestamp becomes its own group; the resulting line chart has one
 *     point per row instead of one per day. To prevent silent wrong
 *     output we now warn in the console so it shows up during DA QA;
 *     the fix is to either route through the semantic engine (qualify
 *     the field) or expose time_grains on the role config.
 *
 * If you need true client-side time bucketing, extend this with a
 * `timeGrain?: 'day' | 'week' | 'month'` parameter and quantize the key.
 * Don't silently re-aggregate — that re-introduces the BE/FE divergence
 * Phase-10 Issue A originally fixed.
 */
function looksLikeRawTimestamp(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  // ISO timestamps with hour/minute/second, e.g. "2026-05-16T14:23:11..."
  // or "2026-05-16 14:23:11". Plain "2026-05-16" (date-only) is OK and
  // a valid bucket.
  return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value);
}

/**
 * @deprecated Phase-15.82 — DA goal is "single GROUP BY layer on the BE".
 * This function still runs for the live-query path (raw rows) but every
 * call is now a regression candidate. Prefer routing through the semantic
 * engine so `preAggregated=true` triggers the FE-skip branch in
 * `buildExploreChartModel`.
 */
export function applyGroupByAgg(
  data: Record<string, any>[],
  dimField: string,
  metrics: MetricConfig[],
): Record<string, any>[] {
  if (!dimField || metrics.length === 0 || data.length === 0) return data;

  // Phase-15.82 — consolidation telemetry. Enable via the dev console:
  //   window.__APPBI_DEBUG_AGG__ = true
  // and every FE fallback aggregation will log so eng can spot live-path
  // regressions where the BE could have aggregated instead.
  if (typeof window !== 'undefined' && (window as any).__APPBI_DEBUG_AGG__) {
    // eslint-disable-next-line no-console
    console.debug('[chartDataAdapter] FE fallback aggregation', {
      dimField,
      metrics: metrics.map((m) => `${m.agg}__${m.field}`),
      rows: data.length,
    });
  }

  // Phase-12.5 granularity warning. Only fires on raw timestamps; categorical
  // dimensions never trigger it. Keeps DA QA honest without changing output.
  const firstValue = data[0]?.[dimField];
  if (looksLikeRawTimestamp(firstValue)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[chartDataAdapter] applyGroupByAgg called with raw-timestamp values on "${dimField}". ` +
      `Each row becomes its own group, which is almost certainly wrong for a time series. ` +
      `Use the semantic engine (qualify the field as view.field) or pre-bucket on the BE.`,
    );
  }

  const groups = new Map<string, Record<string, any>[]>();
  for (const row of data) {
    const key = String(row[dimField] ?? '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  return Array.from(groups.entries()).map(([dimValue, rows]) => {
    const result: Record<string, any> = { [dimField]: dimValue };
    for (const metric of dedupeMetrics(metrics)) {
      result[metricKey(metric)] = aggregateMetricValue(rows, metric);
    }
    return result;
  });
}

export function pivotByBreakdown(
  data: Record<string, any>[],
  dimField: string,
  metric: MetricConfig,
  breakdownField: string,
  preAggregated = false,
  havingFilters: BaseFilter[] = [],
): { data: Record<string, any>[]; series: ChartSeriesDef[] } {
  const valueField = resolveMetricValueField(data, metric, preAggregated);
  const mKey = metricKey(metric);

  // 1. Aggregate to long form: one row per (dim, breakdown) pair with the
  //    metric stored under its canonical metricKey. This is the row that
  //    measure-level filters like "Rev > 0" should be evaluated against.
  const groupMap = new Map<string, Map<string, Record<string, any>[]>>();
  for (const row of data) {
    const dimValue = String(row[dimField] ?? '');
    const breakdownValue = String(row[breakdownField] ?? '');
    if (!groupMap.has(dimValue)) groupMap.set(dimValue, new Map());
    const inner = groupMap.get(dimValue)!;
    if (!inner.has(breakdownValue)) inner.set(breakdownValue, []);
    inner.get(breakdownValue)!.push(row);
  }
  const longForm: Array<Record<string, any>> = [];
  for (const [dimValue, inner] of groupMap.entries()) {
    for (const [breakdownValue, rows] of inner.entries()) {
      longForm.push({
        [dimField]: dimValue,
        [breakdownField]: breakdownValue,
        [mKey]: aggregateMetricValue(rows, metric, valueField, preAggregated),
      });
    }
  }

  // 2. Apply HAVING / measure filters on aggregated long-form rows.
  const surviving = havingFilters.length > 0
    ? applyFiltersToRows(longForm, havingFilters)
    : longForm;

  // 3. Decide which breakdown values remain. Phase-15.83 raised the cap
  //    from 12 → 100; DA dropped per-chart limits, but 100 distinct stack
  //    segments in a single Bar is already unreadable so we keep a
  //    softer ceiling rather than rendering everything. Ordering follows
  //    first-appearance to keep stable output.
  const breakdownKeys: string[] = [];
  for (const r of surviving) {
    const k = String(r[breakdownField] ?? '');
    if (!breakdownKeys.includes(k)) breakdownKeys.push(k);
    if (breakdownKeys.length >= 100) break;
  }

  // 4. Pivot only what survived for rendering.
  const dimOrder: string[] = [];
  const pivotMap = new Map<string, Record<string, any>>();
  for (const r of surviving) {
    const dimValue = String(r[dimField] ?? '');
    const breakdownValue = String(r[breakdownField] ?? '');
    if (!breakdownKeys.includes(breakdownValue)) continue;
    if (!pivotMap.has(dimValue)) {
      const seed: Record<string, any> = { [dimField]: dimValue };
      breakdownKeys.forEach((k) => { seed[k] = 0; });
      pivotMap.set(dimValue, seed);
      dimOrder.push(dimValue);
    }
    pivotMap.get(dimValue)![breakdownValue] = r[mKey];
  }

  return {
    data: dimOrder.map((d) => pivotMap.get(d)!),
    series: breakdownKeys.map((key) => ({ key, label: key })),
  };
}

function buildPivotTableModel(args: {
  data: Record<string, any>[];
  roleConfig: ChartRoleConfig;
  preAggregated: boolean;
}) {
  const { data, roleConfig, preAggregated } = args;
  const rowField = roleConfig.tableRowDimension;
  const columnField = roleConfig.tableColumnDimension;
  const metric = roleConfig.tablePivotMetric;

  if (!rowField || !columnField || !metric || data.length === 0) {
    // Phase-15.24: guards against (a) `selectedColumns: []` (empty array
    // passes through `??` since it isn't nullish — collapses to undefined
    // so the row-keys fallback fires) and (b) `data[0]` being null (BE
    // can legitimately return a row of all-nulls which serialises to
    // `null`; `Object.keys(null)` throws TypeError and surfaces as the
    // "Application error: a client-side exception has occurred" toast
    // DA reported for the TABLE chart preview).
    const explicit = roleConfig.selectedColumns && roleConfig.selectedColumns.length > 0
      ? roleConfig.selectedColumns
      : undefined;
    const columns = explicit ?? (data.length > 0 ? Object.keys(data[0] ?? {}) : []);
    return {
      rows: data,
      columns,
    };
  }

  const valueField = resolveMetricValueField(data, metric, preAggregated);
  const rowGroups = new Map<string, { rowValue: any; cells: Map<string, Record<string, any>[]> }>();
  const pivotColumnValues = new Set<string>();

  for (const row of data) {
    const rowValue = row?.[rowField];
    const rowKey = String(rowValue ?? '');
    const columnValue = String(row?.[columnField] ?? '');

    pivotColumnValues.add(columnValue);

    if (!rowGroups.has(rowKey)) {
      rowGroups.set(rowKey, {
        rowValue,
        cells: new Map(),
      });
    }

    const group = rowGroups.get(rowKey)!;
    if (!group.cells.has(columnValue)) {
      group.cells.set(columnValue, []);
    }
    group.cells.get(columnValue)!.push(row);
  }

  const dynamicColumns = Array.from(pivotColumnValues).sort().slice(0, TABLE_PIVOT_COLUMN_LIMIT);
  const rows = Array.from(rowGroups.entries()).map(([, { rowValue, cells }]) => {
    const result: Record<string, any> = { [rowField]: rowValue };
    dynamicColumns.forEach((columnValue) => {
      const cellRows = cells.get(columnValue) ?? [];
      result[columnValue] = cellRows.length > 0
        ? aggregateMetricValue(cellRows, metric, valueField, preAggregated)
        : null;
    });
    return result;
  });

  return {
    rows,
    columns: [rowField, ...dynamicColumns],
  };
}

/**
 * Phase-15.83 — no-op. Used to truncate at 2000; DA opted to render every
 * row. Kept as a function (rather than inlining) so existing call sites
 * stay readable and we can re-add sampling here later if needed.
 */
function limitRows(rows: Record<string, any>[], _showAll = false) {
  return {
    rows,
    truncated: false,
    totalPoints: rows.length,
  };
}

export function buildExploreChartModel(args: {
  type: string;
  data: Record<string, any>[];
  roleConfig: ChartRoleConfig;
  havingFilters?: BaseFilter[];
  preAggregated?: boolean;
  /** Optional map of qualified-or-bare field → display label from the
   *  semantic model. Used so legend / tooltips show measure.label instead
   *  of raw SQL identifiers. */
  labelMap?: SemanticLabelMap;
  /** @deprecated Phase-15.83 — FE no longer truncates; flag is ignored. */
  showAllPoints?: boolean;
}): ExploreChartModel {
  const { type, data, roleConfig, havingFilters = [], preAggregated = false, labelMap } = args;
  const normalizedRoleConfig = normalizeRoleConfig(type, roleConfig);
  const { dimension, metrics, breakdown, lineMetric, timeField, scatterX, scatterY, selectedColumns } = normalizedRoleConfig;
  const xField = (type === 'TIME_SERIES' || type === 'RIBBON') ? (timeField || dimension) : dimension;
  const pivotTableModel = (type === 'TABLE' || type === 'MATRIX')
    ? buildPivotTableModel({ data, roleConfig: normalizedRoleConfig, preAggregated })
    : null;
  const tableData = pivotTableModel?.rows ?? data;
  // Phase-15.24: same guards as buildPivotTableModel — empty selectedColumns
  // collapses to undefined so the row-keys fallback fires, and `data[0] ?? {}`
  // protects against null rows that would otherwise throw in Object.keys.
  const tableColumnsExplicit = selectedColumns && selectedColumns.length > 0
    ? selectedColumns
    : undefined;
  const tableColumns = pivotTableModel?.columns
    ?? tableColumnsExplicit
    ?? (data.length > 0 ? Object.keys(data[0] ?? {}) : []);

  const emptyModel: ExploreChartModel = {
    roleConfig: normalizedRoleConfig,
    invalidMessage: undefined,
    xField,
    tableData,
    tableColumns,
    truncated: false,
    totalPoints: data.length,
    categoricalData: data,
    categoricalSeries: metrics.map(metric => ({
      key: metricKey(metric),
      label: metricLabel(metric, labelMap),
      metric,
    })),
    comboData: data,
    comboBarSeries: metrics.map(metric => ({
      key: metricKey(metric),
      label: metricLabel(metric, labelMap),
      metric,
    })),
    comboLineSeries: lineMetric
      ? [{ key: metricKey(lineMetric), label: metricLabel(lineMetric, labelMap), metric: lineMetric }]
      : [],
    pieData: [],
    scatterPoints: [],
  };

  if (!data.length) {
    return emptyModel;
  }

  const invalidMessage = getChartRoleConfigValidationMessage(type, normalizedRoleConfig);
  if (invalidMessage) {
    return {
      ...emptyModel,
      invalidMessage,
    };
  }

  if (type === 'TABLE' || type === 'MATRIX') {
    return {
      ...emptyModel,
      totalPoints: tableData.length,
    };
  }

  if (type === 'SCATTER' || type === 'BUBBLE' || type === 'MAP_POINT') {
    return {
      ...emptyModel,
      scatterPoints: scatterX && scatterY
        ? data.map(row => ({
            x: Number(row[scatterX]) || 0,
            y: Number(row[scatterY]) || 0,
            ...(dimension ? { label: row[dimension] } : {}),
          }))
        : [],
    };
  }

  if (type === 'PODIUM') {
    // Podium just needs the raw rows; ChartPreview sorts + slices client-side.
    return { ...emptyModel };
  }

  if (type === 'KPI') {
    const metric = metrics[0];
    const benchmarkMetric = normalizedRoleConfig.benchmarkMetric;
    const metricValueField = metric
      ? resolveMetricValueField(data, metric, preAggregated)
      : undefined;
    const benchmarkValueField = benchmarkMetric
      ? resolveMetricValueField(data, benchmarkMetric, preAggregated)
      : undefined;
    return {
      ...emptyModel,
      kpiMetric: metric,
      kpiBenchmarkMetric: benchmarkMetric,
      kpiValue: metric
        ? (preAggregated
            ? Number(data[0]?.[metricValueField ?? metricKey(metric)]) || 0
            : aggregateMetricValue(data, metric, metricValueField ?? metric.field))
        : undefined,
      kpiBenchmarkValue: benchmarkMetric
        ? (preAggregated
            ? Number(data[0]?.[benchmarkValueField ?? metricKey(benchmarkMetric)]) || 0
            : aggregateMetricValue(data, benchmarkMetric, benchmarkValueField))
        : undefined,
    };
  }

  if (type === 'PIE' || type === 'DONUT' || type === 'POLAR_AREA') {
    const metric = metrics[0];
    const aggregated = xField && metric
      ? (preAggregated ? data : applyGroupByAgg(data, xField, [metric]))
      : data;
    const filteredAggregated = havingFilters.length > 0
      ? applyFiltersToRows(aggregated, havingFilters)
      : aggregated;
    const valueField = metric
      ? resolveMetricValueField(filteredAggregated, metric, preAggregated)
      : undefined;
    // Phase-15.82 bugfix — dedupe slice names. The BE pre_aggregated path
    // trusts the SQL GROUP BY to produce distinct dimension values, but in
    // practice fan-out from JOINs or a non-unique dimension column can
    // emit several rows with the same `dimension` value (e.g. the
    // "Sales hunt × 3" report DA filed). Without this dedupe each
    // duplicate row becomes its own pie slice with its own legend swatch,
    // and the Series-colors editor lists the same name three times with
    // different colors — wrong both visually and as a config affordance.
    // We collapse same-name rows by SUMming their values; this matches
    // PowerBI / Superset behaviour for PIE.
    const pieDataRaw = dimension && metric
      ? filteredAggregated.map(row => ({
          name: String(row[dimension] ?? 'Unknown'),
          value: Number(row[valueField ?? metricKey(metric)]) || 0,
        }))
      : [];
    const dedupedByName = new Map<string, number>();
    for (const slice of pieDataRaw) {
      dedupedByName.set(slice.name, (dedupedByName.get(slice.name) ?? 0) + slice.value);
    }
    // Phase-15.83 — was .slice(0, 20). DA dropped per-chart caps; PIE can
    // now render every slice. Recharts renders fine up to a few hundred
    // slices; beyond that the chart is unreadable but we surface the data
    // (the legend / Series-colors editor already has its own scroll +
    // "Show more" pagination from the earlier Series-colors UX fix).
    const pieData = Array.from(dedupedByName.entries())
      .map(([name, value]) => ({ name, value }));
    return {
      ...emptyModel,
      pieData,
    };
  }

  if (!xField || metrics.length === 0) {
    return emptyModel;
  }

  // Phase-15.8: when BE pre-aggregated the rows, their value keys are the
  // canonical refs (`view.field`). Recharts series datakeys are
  // `metricKey()` (i.e. `${agg}__${field}`). Rewrite once here so every
  // chart-type path below gets recharts-compatible rows. Raw data path
  // (applyGroupByAgg) already does this rewrite via the metricKey assign
  // at line ~176, so it's a no-op there.
  const aggregated = preAggregated
    ? rewriteRowsForRecharts(data, metrics, true)
    : applyGroupByAgg(data, xField, metrics);
  const filteredAgg = havingFilters.length > 0 ? applyFiltersToRows(aggregated, havingFilters) : aggregated;
  const limitedAgg = limitRows(filteredAgg);

  if (type === 'BAR_LINE') {
    const comboMetrics = dedupeMetrics(lineMetric ? [...metrics, lineMetric] : [...metrics]);
    const comboAgg = preAggregated
      ? rewriteRowsForRecharts(data, comboMetrics, true)
      : applyGroupByAgg(data, xField, comboMetrics);
    const filteredCombo = havingFilters.length > 0 ? applyFiltersToRows(comboAgg, havingFilters) : comboAgg;
    const limitedCombo = limitRows(filteredCombo);

    return {
      ...emptyModel,
      truncated: limitedCombo.truncated,
      totalPoints: limitedCombo.totalPoints,
      comboData: limitedCombo.rows,
      comboBarSeries: metrics.map(metric => ({
        key: metricKey(metric),
        label: metricLabel(metric, labelMap),
        metric,
      })),
      comboLineSeries: lineMetric
        ? [{ key: metricKey(lineMetric), label: metricLabel(lineMetric, labelMap), metric: lineMetric }]
        : [],
    };
  }

  if (breakdown && ['STACKED_BAR', 'GROUPED_BAR', 'LINE', 'AREA', 'TIME_SERIES'].includes(type)) {
    const pivoted = pivotByBreakdown(data, xField, metrics[0], breakdown, preAggregated, havingFilters);
    const limitedPivot = limitRows(pivoted.data);
    return {
      ...emptyModel,
      truncated: limitedPivot.truncated,
      totalPoints: limitedPivot.totalPoints,
      categoricalData: limitedPivot.rows,
      categoricalSeries: pivoted.series,
    };
  }

  return {
    ...emptyModel,
    truncated: limitedAgg.truncated,
    totalPoints: limitedAgg.totalPoints,
    categoricalData: limitedAgg.rows,
    categoricalSeries: metrics.map(metric => ({
      key: metricKey(metric),
      label: metricLabel(metric, labelMap),
      metric,
    })),
  };
}
