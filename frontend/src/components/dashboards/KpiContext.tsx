'use client';

/**
 * A KPI's context line: the comparable-period change of the SAME measure, and
 * its recent shape as a sparkline — taken from a time series of that measure
 * on the same report, under the same filters.
 *
 * A headline number alone ("R$13.6M") says nothing about whether it is good,
 * growing or recent. The context comes from findings the report already
 * computes, so it is live, it follows the filters, and it is absent (not
 * invented) when the report has no series for that measure.
 *
 * Colour judges direction only when the AUTHOR said which way is good
 * (`kpiGoalDirection`); otherwise the change is shown in a neutral tone —
 * a rise in cost or in late orders is not good news.
 */
import React from 'react';

import { useReportFindings } from '@/lib/report-evidence';
import { formatBucketLabel, formatPct, formatValue, inferGrain, type Finding, type TileEvidence } from '@/lib/report-findings';
import { parseBucket } from '@/lib/time-buckets';
import { useI18n } from '@/providers/LanguageProvider';

function seriesOf(e: TileEvidence): number[] {
  const partial = new Set(e.partialBuckets ?? []);
  return e.rows
    .filter((r) => !partial.has(String(r[e.timeField!])))
    .map((r) => ({ d: parseBucket(r[e.timeField!]), v: Number(r[e.measureField]) }))
    .filter((p): p is { d: Date; v: number } => !!p.d && Number.isFinite(p.v))
    .sort((a, b) => a.d.getTime() - b.d.getTime())
    .map((p) => p.v)
    .slice(-18);
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 3) return null;
  const w = 96;
  const h = 26;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - ((v - min) / span) * (h - 4)]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="dashboard-kpi-spark" aria-hidden>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r={2.4} fill="currentColor" />
    </svg>
  );
}

/**
 * The context is extra, the number is not — but the SCOPE is what keeps the
 * number honest, so it is the last thing to go. On a tile too short for all of
 * it, the context steps down: full → compact (no sparkline) → scope only (one
 * line: which span the number covers) → none. It steps back up only when the
 * tile has the height the richer level needed.
 */
export type KpiFit = 'full' | 'compact' | 'scope' | 'none';
const FIT_LEVELS: KpiFit[] = ['full', 'compact', 'scope', 'none'];

function useFitLevel<T extends HTMLElement>(): [React.RefObject<T>, KpiFit] {
  const ref = React.useRef<T>(null);
  const [level, setLevel] = React.useState(0);
  const levelRef = React.useRef(0);
  levelRef.current = level;
  const sizeKey = React.useRef('');
  // The context renders only once findings arrive, so the element can appear
  // after mount: attach to whichever element is rendered, once per element.
  const attached = React.useRef<{ el: HTMLElement; ro: ResizeObserver; check: () => void; timer?: ReturnType<typeof setTimeout> } | null>(null);
  React.useEffect(() => () => {
    if (attached.current) { attached.current.ro.disconnect(); if (attached.current.timer) clearTimeout(attached.current.timer); }
  }, []);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || attached.current?.el === el) return;
    if (attached.current) { attached.current.ro.disconnect(); if (attached.current.timer) clearTimeout(attached.current.timer); }
    const tile = el?.parentElement;
    // The context sits under the tile body; what must stay whole is the body's
    // number, which gives up height to the context.
    const body = tile?.querySelector(':scope > [data-tile-body]') as HTMLElement | null;
    if (!el || !tile || !body || typeof ResizeObserver === 'undefined') return;
    // One rule, decided per TILE size: start from the full context and step
    // down while the number is not whole — its box overflows the body, or it
    // is squeezed below a headline size. A new tile size restarts from full; the
    // same size never climbs back (a level change resizes the body, and reacting
    // to that made the context flicker in and out and once hid the number).
    const evaluate = () => {
      const key = `${Math.round(tile.clientWidth)}x${Math.round(tile.clientHeight)}`;
      const current = levelRef.current;
      if (key !== sizeKey.current) {
        sizeKey.current = key;
        if (current !== 0) { setLevel(0); return; }
      }
      const valueEl = body.querySelector('.dashboard-kpi-value') as HTMLElement | null;
      const bodyBox = body.getBoundingClientRect();
      const valueBox = valueEl?.getBoundingClientRect();
      const valueClipped = !!valueBox && (valueBox.bottom > bodyBox.bottom + 1 || valueBox.height < 8);
      const overflow = body.scrollHeight - body.clientHeight > 1;
      const valuePx = valueEl ? parseFloat(getComputedStyle(valueEl).fontSize) : Infinity;
      const cramped = valuePx < 26 && current < 2;
      if ((overflow || valueClipped || cramped) && current < FIT_LEVELS.length - 1) setLevel(current + 1);
    };
    // After the KPI's own auto-fit has re-measured (a frame or two).
    const check = () => {
      const a = attached.current;
      if (!a) return;
      if (a.timer) clearTimeout(a.timer);
      a.timer = setTimeout(evaluate, 160);
    };
    const ro = new ResizeObserver(check);
    attached.current = { el, ro, check };
    ro.observe(tile);
    ro.observe(body);
    // The number re-fits its font after the body changes; that resizes the
    // value's box, not the body — watch it too, or a squeeze goes unseen.
    const valueEl = body.querySelector('.dashboard-kpi-value');
    if (valueEl) ro.observe(valueEl);
    check();
  });
  // Every level change is judged again at the same size: when the context still
  // fills the tile (a 0px body stays 0px), no size changes, no observer fires,
  // and the step down stalled half way with the number squeezed out.
  React.useEffect(() => { attached.current?.check(); }, [level]);
  return [ref, FIT_LEVELS[level]];
}

/**
 * The span a series covers, as the reader would name it, and whether the KPI's
 * own number IS that span: only an additive series that adds up to the KPI
 * (same measure, same filters) proves "R$13.6M = all of Sep 2016 – Oct 2018".
 * Otherwise no scope is claimed.
 */
function scopeOf(e: TileEvidence, kpiValue: number | undefined, locale?: string): string | null {
  if (!e.timeField || kpiValue === undefined || !Number.isFinite(kpiValue)) return null;
  const pts = e.rows
    .map((r) => ({ d: parseBucket(r[e.timeField!]), raw: String(r[e.timeField!]), v: Number(r[e.measureField]) }))
    .filter((p): p is { d: Date; raw: string; v: number } => !!p.d && Number.isFinite(p.v))
    .sort((a, b) => a.d.getTime() - b.d.getTime());
  if (pts.length < 2) return null;
  const total = pts.reduce((s, p) => s + p.v, 0);
  if (Math.abs(total - kpiValue) > Math.max(1e-6, Math.abs(kpiValue) * 0.005)) return null;
  // A series that declares no grain is named by the grain its buckets have
  // (the same inference the findings use): "Jan 2024", not "Jan 1, 2024".
  const grain = e.grain ?? inferGrain(pts.map((p) => ({ date: p.d })));
  return `${formatBucketLabel(pts[0].raw, grain, locale)} – ${formatBucketLabel(pts[pts.length - 1].raw, grain, locale)}`;
}

/** The KPI's number: the first finite value in its single result row. */
export function kpiRowValue(rows: unknown): number | undefined {
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row || typeof row !== 'object') return undefined;
  for (const v of Object.values(row as Record<string, unknown>)) {
    const n = typeof v === 'number' ? v : Number(v);
    if (v !== null && v !== '' && Number.isFinite(n)) return n;
  }
  return undefined;
}

export function KpiContext({ measureField, goalDirection, kpiValue }: {
  measureField: string;
  goalDirection?: 'up' | 'down' | null;
  /** The KPI's own number — lets the context say which span it covers. */
  kpiValue?: number;
}) {
  const { t, locale } = useI18n() as { t: (k: string, p?: Record<string, string | number>) => string; locale?: string };
  const { findings, evidence } = useReportFindings();
  const [ref, fit] = useFitLevel<HTMLDivElement>();
  const hide = fit === 'none' ? { display: 'none' as const } : undefined;
  const series = evidence.find((e) => e.measureField === measureField && !!e.timeField && e.chartType !== 'KPI');
  if (!series) return null;
  const scope = scopeOf(series, kpiValue, locale);
  // The range is the part that must survive a narrow tile; the "All periods ·"
  // prefix yields first (container query in globals.css).
  const scopeLine = scope
    ? <span className="dashboard-kpi-scope"><span className="dashboard-kpi-scope-prefix">{t('report.kpi.scopePrefix')} · </span>{scope}</span>
    : null;
  const pc: Finding | undefined = findings.get(`period_comparison:${series.tileId}`);
  const latest: Finding | undefined = findings.get(`latest:${series.tileId}`);
  const f = pc ?? latest;
  if (!f || f.values.pct === undefined) {
    return <div ref={ref} style={hide} data-fit={fit} className="dashboard-kpi-context">{scopeLine}<Sparkline values={seriesOf(series)} /></div>;
  }
  const pct = f.values.pct;
  const judged = goalDirection === 'up' || goalDirection === 'down';
  const tone = !judged || Math.abs(pct) < 2 ? 'neutral' : (pct > 0) === (goalDirection === 'up') ? 'good' : 'bad';
  // The change is stated WITH the window and value it is about. Beside a total
  // ("R$13.6M"), a bare "+137% vs same months 2017" reads as the total's change;
  // it is the change of Jan–Aug 2018 (R$ 7.4M).
  const windowText = pc
    ? `${formatBucketLabel(pc.labels.fromBucket, 'month', locale)}–${formatBucketLabel(pc.labels.toBucket, 'month', locale)}`
    : formatBucketLabel(f.labels.bucket, f.grain, locale);
  const windowValue = formatValue(pc ? pc.values.current : f.values.value, f.format, locale);
  const label = pc
    ? t('report.kpi.vsSameMonths', { year: pc.labels.previousYear })
    : t('report.kpi.vsPrevious', { period: formatBucketLabel(f.labels.previousBucket, f.grain, locale) });
  return (
    <div ref={ref} style={hide} data-fit={fit} className="dashboard-kpi-context" data-kpi-context-finding={f.key} data-tone={tone}>
      {scopeLine}
      <span className="dashboard-kpi-window">
        <span className="dashboard-kpi-window-label">{windowText}</span>
        <span className="dashboard-kpi-window-value">{windowValue}</span>
        <span className={`dashboard-kpi-delta is-${tone}`}>{pct >= 0 ? '▲' : '▼'} {formatPct(pct, locale)}</span>
        <span className="dashboard-kpi-vs">{label}</span>
      </span>
      <Sparkline values={seriesOf(series)} />
    </div>
  );
}
