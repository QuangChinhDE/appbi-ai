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
import { formatBucketLabel, formatPct, type Finding, type TileEvidence } from '@/lib/report-findings';
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
 * The context is extra, the number is not: on a tile too short for both, the
 * line steps aside rather than squeezing the value out of the card body. It returns
 * when the tile grows to the height it needed.
 */
function useFitsParent<T extends HTMLElement>(): [React.RefObject<T>, boolean] {
  const ref = React.useRef<T>(null);
  const [fits, setFits] = React.useState(true);
  const needed = React.useRef(0);
  React.useLayoutEffect(() => {
    const el = ref.current;
    // The context sits under the tile body; what must not overflow is the
    // body (the number), which gives up height to the context.
    const parent = (el?.parentElement?.querySelector(':scope > [data-tile-body]') as HTMLElement | null) ?? el?.parentElement;
    if (!el || !parent || typeof ResizeObserver === 'undefined') return;
    const check = () => {
      if (el.style.display !== 'none') {
        const over = parent.scrollHeight - parent.clientHeight;
        // Shown again only when the body could hold its content AND give up
        // the context's height — otherwise showing it would overflow again.
        if (over > 1) { needed.current = parent.scrollHeight + el.offsetHeight; setFits(false); }
      } else if (parent.clientHeight >= needed.current) {
        setFits(true);
      }
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(parent);
    return () => ro.disconnect();
  });
  return [ref, fits];
}

export function KpiContext({ measureField, goalDirection }: { measureField: string; goalDirection?: 'up' | 'down' | null }) {
  const { t, locale } = useI18n() as { t: (k: string, p?: Record<string, string | number>) => string; locale?: string };
  const { findings, evidence } = useReportFindings();
  const [ref, fits] = useFitsParent<HTMLDivElement>();
  const hide = fits ? undefined : { display: 'none' as const };
  const series = evidence.find((e) => e.measureField === measureField && !!e.timeField && e.chartType !== 'KPI');
  if (!series) return null;
  const pc: Finding | undefined = findings.get(`period_comparison:${series.tileId}`);
  const latest: Finding | undefined = findings.get(`latest:${series.tileId}`);
  const f = pc ?? latest;
  if (!f || f.values.pct === undefined) return <div ref={ref} style={hide} className="dashboard-kpi-context"><Sparkline values={seriesOf(series)} /></div>;
  const pct = f.values.pct;
  const judged = goalDirection === 'up' || goalDirection === 'down';
  const tone = !judged || Math.abs(pct) < 2 ? 'neutral' : (pct > 0) === (goalDirection === 'up') ? 'good' : 'bad';
  const label = pc
    ? t('report.kpi.vsSameMonths', { year: pc.labels.previousYear })
    : t('report.kpi.vsPrevious', { period: formatBucketLabel(f.labels.previousBucket, f.grain, locale) });
  return (
    <div ref={ref} style={hide} className="dashboard-kpi-context" data-kpi-context-finding={f.key} data-tone={tone}>
      <span className={`dashboard-kpi-delta is-${tone}`}>{pct >= 0 ? '▲' : '▼'} {formatPct(pct, locale)}</span>
      <span className="dashboard-kpi-vs">{label}</span>
      <Sparkline values={seriesOf(series)} />
    </div>
  );
}
