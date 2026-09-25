/**
 * What a visual MEANS, in the few words a designer needs.
 *
 * The planner used to see a title, a chart type and a width. From that it had
 * to guess which chart carried the page's argument, and the guess it could make
 * was "the wide one" — so a redesign kept promoting whatever the author had
 * happened to make wide, and the layout re-confirmed itself. This builds the
 * missing half from metadata the builder has ALREADY loaded: the chart's role
 * config (which measures, over which dimension, bucketed by time?), the
 * dataset's semantic model (labels, types, formats, descriptions) and the
 * chart's own description. Nothing is fetched and nothing new leaves the
 * browser that a person looking at the page could not read off it: labels and
 * short descriptions, never SQL, dataset ids or rows.
 *
 * Every field is best-effort. A chart with no semantic model still gets its
 * measure names humanised; a chart with no config at all gets an empty meaning,
 * and the planner is told to fall back on type and title.
 */
import { getActiveChartRoleConfig } from '@/lib/chart-config';
import type { VisualMeaning } from './types';

export interface FieldMeta {
  label?: string;
  description?: string;
  /** 'date' / 'datetime' for a dimension marks the visual as temporal. */
  type?: string;
  /** A measure's declared display format (percent, currency, …). */
  format?: string;
  /** A measure's aggregation (sum, count, avg, formula …). */
  measureType?: string;
}

/** {qualified-or-bare field → meta}, built once per render from the dataset
 *  models the builder already holds. */
export type FieldMetaIndex = Map<string, FieldMeta>;

interface ViewLike {
  name: string;
  dimensions?: Array<{ name: string; label?: string; description?: string; type?: string; hidden?: boolean }>;
  measures?: Array<{ name: string; label?: string; description?: string; type?: string; format?: { kind?: string } | null; hidden?: boolean }>;
}

export function buildFieldMetaIndex(viewsList: Array<ViewLike[] | undefined | null>): FieldMetaIndex {
  const index: FieldMetaIndex = new Map();
  const put = (key: string, meta: FieldMeta) => {
    if (!index.has(key)) index.set(key, meta);
  };
  for (const views of viewsList) {
    for (const view of views ?? []) {
      for (const dim of view.dimensions ?? []) {
        const meta: FieldMeta = {
          label: dim.label?.trim() || undefined,
          description: dim.description?.trim() || undefined,
          type: dim.type,
        };
        put(`${view.name}.${dim.name}`, meta);
        put(dim.name, meta);
      }
      for (const measure of view.measures ?? []) {
        const meta: FieldMeta = {
          label: measure.label?.trim() || undefined,
          description: measure.description?.trim() || undefined,
          format: measure.format?.kind || undefined,
          measureType: measure.type || undefined,
        };
        put(`${view.name}.${measure.name}`, meta);
        put(measure.name, meta);
      }
    }
  }
  return index;
}

const TEMPORAL_NAME = /(^|[_.\s])(date|day|week|month|quarter|year|time|period|ngay|tuan|thang|quy|nam)([_.\s]|$)/i;
const TEMPORAL_TYPES = new Set(['date', 'datetime', 'timestamp', 'time']);

/** `orders.order_purchase_date` → "Order purchase date". */
export function humanizeField(field: string): string {
  const bare = String(field ?? '').split('.').pop() ?? '';
  const words = bare.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

function clip(text: unknown, max: number): string | undefined {
  if (typeof text !== 'string') return undefined;
  const value = text.replace(/\s+/g, ' ').trim();
  if (!value) return undefined;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

const MAX_FIELDS = 4;

export interface MeaningInput {
  chart: Record<string, any> | null | undefined;
  /** The merged per-tile style (chart config ⊕ dashboard override). */
  styleConfig?: Record<string, any> | null;
  fieldMeta?: FieldMetaIndex;
}

/** The meaning of one chart tile. */
export function buildVisualMeaning(input: MeaningInput): VisualMeaning {
  const chart = input.chart ?? {};
  const config = (chart.config ?? {}) as Record<string, any>;
  const role = (getActiveChartRoleConfig(config) ?? {}) as Record<string, any>;
  const style = (input.styleConfig ?? config.styleConfig ?? {}) as Record<string, any>;
  const lookup = (field: string): FieldMeta | undefined => {
    if (!field || !input.fieldMeta) return undefined;
    return input.fieldMeta.get(field) ?? input.fieldMeta.get(field.split('.').pop() ?? field);
  };

  const measures: VisualMeaning['measures'] = [];
  const addMeasure = (metric: any) => {
    const field = typeof metric === 'string' ? metric : metric?.field;
    if (!field || measures.length >= MAX_FIELDS) return;
    const meta = lookup(field);
    measures.push({
      label: meta?.label || (typeof metric?.label === 'string' && metric.label.trim()) || humanizeField(field),
      ...(metric?.agg ? { agg: String(metric.agg) } : {}),
      ...(meta?.format ? { format: meta.format } : {}),
      additive: ['sum', 'count'].includes(
        String(metric?.agg && metric.agg !== 'auto' ? metric.agg : meta?.measureType ?? '').toLowerCase(),
      ),
      ...(clip(meta?.description, 120) ? { description: clip(meta?.description, 120) } : {}),
    });
  };
  for (const metric of Array.isArray(role.metrics) ? role.metrics : []) addMeasure(metric);
  if (role.lineMetric) addMeasure(role.lineMetric);
  if (role.tablePivotMetric) addMeasure(role.tablePivotMetric);
  // Legacy configs name measures in flat lists.
  for (const m of Array.isArray(config.measure_configs) ? config.measure_configs : []) addMeasure(m);
  for (const m of Array.isArray(config.measures) ? config.measures : []) addMeasure(m);

  const timeGrainFields = new Set(Object.keys((role.timeGrains ?? {}) as Record<string, unknown>));
  const dimensionFields: string[] = [];
  for (const field of [role.dimension, role.timeField, role.breakdown, role.tableRowDimension, role.tableColumnDimension]) {
    if (typeof field === 'string' && field && !dimensionFields.includes(field)) dimensionFields.push(field);
  }
  for (const d of Array.isArray(config.dimension_configs) ? config.dimension_configs : []) {
    if (d?.field && !dimensionFields.includes(d.field)) dimensionFields.push(d.field);
  }
  for (const d of Array.isArray(config.dimensions) ? config.dimensions : []) {
    if (typeof d === 'string' && !dimensionFields.includes(d)) dimensionFields.push(d);
  }

  const dimensions: VisualMeaning['dimensions'] = dimensionFields.slice(0, MAX_FIELDS).map((field) => {
    const meta = lookup(field);
    const temporal = timeGrainFields.has(field)
      || field === role.timeField
      || (meta?.type ? TEMPORAL_TYPES.has(String(meta.type).toLowerCase()) : TEMPORAL_NAME.test(field));
    return { label: meta?.label || humanizeField(field), ...(temporal ? { temporal: true } : {}) };
  });

  const chartType = String(chart.chart_type ?? '').toUpperCase();
  const temporal = dimensions.some((d) => d.temporal)
    || chartType === 'TIME_SERIES'
    || typeof style.timeGranularity === 'string';

  const metadata = (chart.metadata ?? {}) as Record<string, any>;
  const description = clip(chart.description, 200) ?? clip(metadata.auto_description, 200);
  const intent = typeof metadata.intent === 'string' && metadata.intent.trim() ? metadata.intent.trim().toLowerCase() : undefined;

  const hasBenchmark = Boolean(
    role.benchmarkMetric
    || style.showBenchmarkLine
    || (Array.isArray(style.benchmarkLines) && style.benchmarkLines.length > 0)
    || style.benchmarkValue != null
    || style.kpiBenchmarkValue != null,
  );
  const direction = style.kpiGoalDirection;
  const goodDirection = direction === 'up' || direction === 'higher' ? 'up'
    : direction === 'down' || direction === 'lower' ? 'down'
    : undefined;

  return {
    measures,
    dimensions,
    temporal,
    ...(description ? { description } : {}),
    ...(intent ? { intent } : {}),
    hasBenchmark,
    ...(goodDirection ? { goodDirection } : {}),
  };
}

export const EMPTY_MEANING: VisualMeaning = { measures: [], dimensions: [], temporal: false, hasBenchmark: false };
