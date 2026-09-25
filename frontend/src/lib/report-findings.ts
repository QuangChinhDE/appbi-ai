/**
 * Report findings — the business facts a report can state, computed from the
 * rows the report's own tiles are showing.
 *
 * Why here and not in a model: a finding is arithmetic over data the page has
 * already fetched, under the page's current filters. Computing it from those
 * exact responses means the sentence and the chart beside it can never disagree,
 * a filter change updates both, and the public/embed surfaces need no new data
 * path (they already fetch the tiles through the public client).
 *
 * What a finding is NOT: a cause, a forecast or an opinion. Kinds are closed and
 * each one says what it measured, over which buckets, and what it left out.
 *
 * Identity vs value: `key` (`kind:tileId`) is what a narrative block stores. The
 * values behind it are recomputed on every render, so a stored narrative never
 * carries a number of its own.
 */

export type FindingKind =
  | 'kpi_value'
  | 'trend'
  | 'peak'
  | 'latest'
  | 'period_comparison'
  | 'top_item'
  | 'concentration'
  | 'attainment'
  | 'partial_periods';

export const FINDING_KINDS: readonly FindingKind[] = [
  'kpi_value', 'trend', 'peak', 'latest', 'period_comparison', 'top_item',
  'concentration', 'attainment', 'partial_periods',
];

export interface MeasureFormatSpec {
  kind?: 'number' | 'currency' | 'percent';
  currencySymbol?: string;
  decimals?: number;
}

/** Everything a finding needs about one tile. Built by the host from the tile's
 *  config and the response it rendered. */
export interface TileEvidence {
  tileId: number;
  chartType: string;
  title: string;
  measureField: string;
  measureLabel: string;
  /** sum/count: shares of a total are meaningful. avg/ratio/distinct: they are not. */
  additive: boolean;
  format: MeasureFormatSpec;
  dimensionField?: string;
  timeField?: string;
  grain?: string;
  rows: Record<string, unknown>[];
  partialBuckets?: string[];
  /** A target the AUTHOR configured on the tile (never inferred). */
  target?: { value: number; label?: string; direction?: 'up' | 'down' };
  higherIsBetter?: boolean;
}

export interface Finding {
  key: string;
  kind: FindingKind;
  tileId: number;
  measureLabel: string;
  format: MeasureFormatSpec;
  /** Numeric facts; rendered through `format`, never typed into prose. */
  values: Record<string, number>;
  /** Labels the sentence needs (bucket names, the top category). */
  labels: Record<string, string>;
  /** What the finding was computed over and what it left out. */
  evidence: { buckets?: number; excluded?: string[]; rows?: number };
  direction?: 'up' | 'down' | 'flat';
  /** Time grain of the bucket labels, when the finding is about a time axis. */
  grain?: string;
}

const FLAT_PCT = 2;

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function bucketKey(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v ?? '');
}

import { parseBucket } from './time-buckets';
export { parseBucket };
const toDate = parseBucket;

function directionOf(pct: number): 'up' | 'down' | 'flat' {
  if (Math.abs(pct) < FLAT_PCT) return 'flat';
  return pct > 0 ? 'up' : 'down';
}

function pct(from: number, to: number): number | null {
  if (!from) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

interface TimePoint { key: string; date: Date; value: number }

function timeSeries(t: TileEvidence): { complete: TimePoint[]; excluded: string[] } {
  const partial = new Set((t.partialBuckets ?? []).map(bucketKey));
  const points: TimePoint[] = [];
  const excluded: string[] = [];
  for (const row of t.rows) {
    const raw = row[t.timeField!];
    const date = toDate(raw);
    const value = num(row[t.measureField]);
    if (!date || value === null) continue;
    const key = bucketKey(raw);
    if (partial.has(key)) { excluded.push(key); continue; }
    points.push({ key, date, value });
  }
  points.sort((a, b) => a.date.getTime() - b.date.getTime());
  return { complete: points, excluded: excluded.sort() };
}

function timeFindings(t: TileEvidence): Finding[] {
  const out: Finding[] = [];
  const { complete, excluded } = timeSeries(t);
  const base = { tileId: t.tileId, measureLabel: t.measureLabel, format: t.format, grain: t.grain };
  if (excluded.length) {
    out.push({ ...base, key: `partial_periods:${t.tileId}`, kind: 'partial_periods', values: { count: excluded.length },
      labels: { buckets: excluded.join('|') }, evidence: { excluded } });
  }
  if (complete.length < 2) return out;
  const first = complete[0];
  const last = complete[complete.length - 1];
  const change = pct(first.value, last.value);
  if (change !== null) {
    out.push({ ...base, key: `trend:${t.tileId}`, kind: 'trend',
      values: { from: first.value, to: last.value, pct: change },
      labels: { fromBucket: first.key, toBucket: last.key },
      evidence: { buckets: complete.length, excluded }, direction: directionOf(change) });
  }
  const peak = complete.reduce((a, b) => (b.value > a.value ? b : a));
  out.push({ ...base, key: `peak:${t.tileId}`, kind: 'peak', values: { value: peak.value },
    labels: { bucket: peak.key }, evidence: { buckets: complete.length, excluded } });
  const prev = complete[complete.length - 2];
  const latestChange = pct(prev.value, last.value);
  out.push({ ...base, key: `latest:${t.tileId}`, kind: 'latest',
    values: { value: last.value, previous: prev.value, ...(latestChange !== null ? { pct: latestChange } : {}) },
    labels: { bucket: last.key, previousBucket: prev.key }, evidence: { buckets: complete.length, excluded },
    direction: latestChange !== null ? directionOf(latestChange) : undefined });

  // Same months, year over year — only for monthly series, only over months
  // present in BOTH years (so a missing month never inflates a side), and only
  // for an additive measure (summing an average across months means nothing).
  if (t.grain === 'month' && t.additive) {
    const lastYear = last.date.getUTCFullYear();
    const thisYear = complete.filter((p) => p.date.getUTCFullYear() === lastYear);
    const prevByMonth = new Map(complete
      .filter((p) => p.date.getUTCFullYear() === lastYear - 1)
      .map((p) => [p.date.getUTCMonth(), p]));
    const paired = thisYear.filter((p) => prevByMonth.has(p.date.getUTCMonth()));
    if (paired.length >= 2) {
      const cur = paired.reduce((s, p) => s + p.value, 0);
      const was = paired.reduce((s, p) => s + prevByMonth.get(p.date.getUTCMonth())!.value, 0);
      const change2 = pct(was, cur);
      if (change2 !== null) {
        out.push({ ...base, key: `period_comparison:${t.tileId}`, kind: 'period_comparison',
          values: { current: cur, previous: was, pct: change2, months: paired.length },
          labels: {
            fromBucket: paired[0].key, toBucket: paired[paired.length - 1].key,
            year: String(lastYear), previousYear: String(lastYear - 1),
          },
          evidence: { buckets: paired.length * 2, excluded }, direction: directionOf(change2) });
      }
    }
  }
  return out;
}

function categoryFindings(t: TileEvidence): Finding[] {
  const out: Finding[] = [];
  const items = t.rows
    .map((r) => ({ label: String(r[t.dimensionField!] ?? ''), value: num(r[t.measureField]) }))
    .filter((x): x is { label: string; value: number } => x.value !== null && x.label !== '');
  if (items.length < 2) return out;
  items.sort((a, b) => b.value - a.value);
  const base = { tileId: t.tileId, measureLabel: t.measureLabel, format: t.format };
  const total = items.reduce((s, x) => s + x.value, 0);
  const top = items[0];
  const share = t.additive && total > 0 ? (top.value / total) * 100 : undefined;
  out.push({ ...base, key: `top_item:${t.tileId}`, kind: 'top_item',
    values: { value: top.value, ...(share !== undefined ? { share } : {}), runnerUp: items[1].value },
    labels: { item: top.label, runnerUpItem: items[1].label }, evidence: { rows: items.length } });
  if (t.additive && total > 0 && items.length >= 4) {
    const top3 = items.slice(0, 3).reduce((s, x) => s + x.value, 0);
    out.push({ ...base, key: `concentration:${t.tileId}`, kind: 'concentration',
      values: { share: (top3 / total) * 100, count: 3, of: items.length },
      labels: { items: items.slice(0, 3).map((x) => x.label).join('|') }, evidence: { rows: items.length } });
  }
  return out;
}

function kpiFindings(t: TileEvidence): Finding[] {
  const v = num(t.rows[0]?.[t.measureField]);
  if (v === null) return [];
  const base = { tileId: t.tileId, measureLabel: t.measureLabel, format: t.format };
  const out: Finding[] = [{ ...base, key: `kpi_value:${t.tileId}`, kind: 'kpi_value', values: { value: v }, labels: {}, evidence: { rows: 1 } }];
  if (t.target && Number.isFinite(t.target.value) && t.target.value !== 0) {
    const att = (v / t.target.value) * 100;
    const better = (t.target.direction ?? 'up') === 'up' ? v >= t.target.value : v <= t.target.value;
    out.push({ ...base, key: `attainment:${t.tileId}`, kind: 'attainment',
      values: { value: v, target: t.target.value, attainment: att },
      labels: { targetLabel: t.target.label ?? '', status: better ? 'met' : 'missed' }, evidence: { rows: 1 } });
  }
  return out;
}

const TIME_TYPES = new Set(['TIME_SERIES', 'LINE', 'AREA']);
const CATEGORY_TYPES = new Set(['BAR', 'HORIZONTAL_BAR', 'PIE', 'DONUT', 'TREEMAP', 'TABLE', 'FUNNEL', 'COLUMN']);

/** All findings one tile supports. Deterministic; no randomness, no clock. */
export function findingsForTile(t: TileEvidence): Finding[] {
  if (!t.measureField || !Array.isArray(t.rows) || t.rows.length === 0) return [];
  if (t.chartType === 'KPI' || t.chartType === 'GAUGE') return kpiFindings(t);
  if (t.timeField && (TIME_TYPES.has(t.chartType) || t.grain)) return timeFindings(t);
  if (t.dimensionField && CATEGORY_TYPES.has(t.chartType)) return categoryFindings(t);
  return [];
}

/**
 * All findings on a report.
 *
 * A partial period is a property of the TIME AXIS, not of one measure: the
 * launch month has three orders whether you sum revenue or average delivery
 * days. Only a volume measure can SEE it (an average over three orders looks
 * like any other month), so the partial buckets any tile found on a time field
 * are applied to every tile on that same field and grain.
 */
export function findingsForReport(tiles: TileEvidence[]): Map<string, Finding> {
  const partialByAxis = new Map<string, Set<string>>();
  const axisOf = (t: TileEvidence) => (t.timeField ? `${t.timeField}|${t.grain ?? ''}` : null);
  for (const t of tiles) {
    const axis = axisOf(t);
    if (!axis || !t.partialBuckets?.length) continue;
    const set = partialByAxis.get(axis) ?? new Set<string>();
    for (const b of t.partialBuckets) set.add(b);
    partialByAxis.set(axis, set);
  }
  const map = new Map<string, Finding>();
  for (const t of tiles) {
    const axis = axisOf(t);
    const shared = axis ? partialByAxis.get(axis) : undefined;
    const evidence = shared ? { ...t, partialBuckets: [...new Set([...(t.partialBuckets ?? []), ...shared])] } : t;
    for (const f of findingsForTile(evidence)) map.set(f.key, f);
  }
  return map;
}

/** The kinds a tile of this shape CAN produce — what the planner may reference
 *  before any data is loaded. */
export function possibleFindingKinds(chartType: string, hasTime: boolean, hasDimension: boolean, additive: boolean, hasTarget: boolean): FindingKind[] {
  if (chartType === 'KPI' || chartType === 'GAUGE') return hasTarget ? ['kpi_value', 'attainment'] : ['kpi_value'];
  if (hasTime) {
    const k: FindingKind[] = ['trend', 'peak', 'latest', 'partial_periods'];
    if (additive) k.push('period_comparison');
    return k;
  }
  if (hasDimension && CATEGORY_TYPES.has(chartType)) return additive ? ['top_item', 'concentration'] : ['top_item'];
  return [];
}

// ── Rendering values ─────────────────────────────────────────────────────────

export function formatValue(v: number, f: MeasureFormatSpec, locale?: string): string {
  if (f.kind === 'percent') {
    // The platform's percent convention (ExploreChart formatNumber): a percent
    // measure holds a RATIO and is shown ×100. One convention, so the sentence
    // and the tile print the same figure.
    return `${(v * 100).toLocaleString(locale, { maximumFractionDigits: f.decimals ?? 1, minimumFractionDigits: 0 })}%`;
  }
  const abs = Math.abs(v);
  const compact = abs >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : abs >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : abs >= 1e4 ? `${(v / 1e3).toFixed(1)}K`
    : v.toLocaleString(locale, { maximumFractionDigits: f.decimals ?? (abs < 10 ? 2 : abs < 1000 ? 1 : 0) });
  if (f.kind === 'currency') return `${f.currencySymbol ? `${f.currencySymbol} ` : ''}${compact}`;
  return compact;
}

export function formatPct(p: number, locale?: string): string {
  const s = Math.abs(p) >= 100 ? Math.abs(p).toFixed(0) : Math.abs(p).toFixed(1);
  return `${p >= 0 ? '+' : '−'}${Number(s).toLocaleString(locale)}%`;
}

export function formatPctMagnitude(p: number, locale?: string): string {
  const s = Math.abs(p) >= 100 ? Math.abs(p).toFixed(0) : Math.abs(p).toFixed(1);
  return `${Number(s).toLocaleString(locale)}%`;
}

export function formatBucketLabel(raw: string, grain: string | undefined, locale?: string): string {
  const d = toDate(raw);
  if (!d) return raw;
  const opts: Intl.DateTimeFormatOptions =
    grain === 'year' ? { year: 'numeric' }
      : grain === 'month' || grain === 'quarter' ? { year: 'numeric', month: 'short' }
        : { year: 'numeric', month: 'short', day: 'numeric' };
  return d.toLocaleDateString(locale, { ...opts, timeZone: 'UTC' });
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** One finding as a sentence. Every number comes from the finding's values
 *  through its measure format; the template only supplies words. */
export function renderFindingSentence(f: Finding, t: Translate, locale?: string): string {
  const v = (k: string) => formatValue(f.values[k], f.format, locale);
  const b = (k: string) => formatBucketLabel(f.labels[k], f.grain, locale);
  const measure = f.measureLabel;
  switch (f.kind) {
    case 'kpi_value':
      return t('report.finding.kpi_value', { measure, value: v('value') });
    case 'trend':
      // The verb carries the sign ("rose 610%"), so the figure does not repeat it.
      return t(`report.finding.trend.${f.direction ?? 'flat'}`, {
        measure, pct: formatPctMagnitude(f.values.pct, locale), from: v('from'), to: v('to'),
        fromBucket: b('fromBucket'), toBucket: b('toBucket'),
      });
    case 'peak':
      return t('report.finding.peak', { measure, bucket: b('bucket'), value: v('value') });
    case 'latest':
      return t(`report.finding.latest.${f.values.pct === undefined ? 'none' : f.direction ?? 'flat'}`, {
        measure, bucket: b('bucket'), value: v('value'), previousBucket: b('previousBucket'),
        pct: f.values.pct === undefined ? '' : formatPct(f.values.pct, locale),
      });
    case 'period_comparison':
      return t(`report.finding.period_comparison.${f.direction ?? 'flat'}`, {
        measure, fromBucket: b('fromBucket'), toBucket: b('toBucket'), current: v('current'),
        previous: v('previous'), pct: formatPct(f.values.pct, locale), previousYear: f.labels.previousYear,
      });
    case 'top_item':
      return f.values.share !== undefined
        ? t('report.finding.top_item.share', { item: f.labels.item, measure, value: v('value'),
          share: `${f.values.share.toFixed(0)}%` })
        : t('report.finding.top_item', { item: f.labels.item, measure, value: v('value'),
          runnerUpItem: f.labels.runnerUpItem, runnerUp: v('runnerUp') });
    case 'concentration':
      return t('report.finding.concentration', { count: f.values.count, of: f.values.of,
        items: f.labels.items.split('|').join(', '), share: `${f.values.share.toFixed(0)}%`, measure });
    case 'attainment':
      return t(`report.finding.attainment.${f.labels.status === 'met' ? 'met' : 'missed'}`, {
        measure, value: v('value'), target: v('target'), attainment: `${f.values.attainment.toFixed(0)}%` });
    case 'partial_periods':
      return t('report.finding.partial_periods', {
        buckets: f.labels.buckets.split('|').map((x) => formatBucketLabel(x, f.grain, locale)).join(', ') });
    default:
      return '';
  }
}

/** A short headline figure for a takeaway chip or a KPI comparison line. */
export function findingHeadlineFigure(f: Finding, locale?: string): { figure: string; direction?: 'up' | 'down' | 'flat' } | null {
  switch (f.kind) {
    case 'trend':
    case 'latest':
    case 'period_comparison':
      return f.values.pct === undefined ? null : { figure: formatPct(f.values.pct, locale), direction: f.direction };
    case 'top_item':
    case 'concentration':
      return f.values.share === undefined ? null : { figure: `${f.values.share.toFixed(0)}%` };
    case 'attainment':
      return { figure: `${f.values.attainment.toFixed(0)}%`, direction: f.labels.status === 'met' ? 'up' : 'down' };
    default:
      return null;
  }
}
