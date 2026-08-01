'use client';

import React from 'react';

/**
 * A small, fast preview of a chart drawn from its REAL data.
 *
 * Why a sketch instead of the real chart component or a screenshot:
 *
 *  • A screenshot needs the tile to be mounted, which means switching the report
 *    to that page first — the thing that made the arranger take minutes.
 *  • Mounting the real chart stack (ExploreChart + Recharts) dozens of times over
 *    is far more work than this needs; the arranger only has to answer "which
 *    chart is this and roughly what shape is it".
 *
 * So: same numbers, drawn in a few SVG elements. It renders in well under a
 * millisecond, needs nothing mounted, and follows the viewer's current filters
 * because it reads the same `chartData` the report is showing.
 */

type Row = Record<string, unknown>;

const PALETTE = ['#5b5bd6', '#22b8cf', '#12b886', '#fab005', '#fa5252', '#be4bdb', '#4dabf7', '#748ffc'];

function pickFields(rows: Row[]): { label?: string; value?: string } {
  const first = rows[0] || {};
  const keys = Object.keys(first);
  const value = keys.find((k) => typeof first[k] === 'number');
  const label = keys.find((k) => k !== value);
  return { label, value };
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n * 10) / 10);
}

export function ChartSketchPreview({
  rows,
  chartType,
  accent = '#5b5bd6',
  className,
}: {
  rows?: Row[] | null;
  chartType?: string;
  accent?: string;
  className?: string;
}) {
  const type = String(chartType || '').toUpperCase();
  const data = Array.isArray(rows) ? rows.slice(0, 14) : [];

  if (!data.length) {
    return (
      <div className={`flex items-center justify-center text-[9px] text-text-quaternary ${className || ''}`}>
        {type || '—'}
      </div>
    );
  }

  const { label, value } = pickFields(data);
  const values = data.map((r) => toNumber(value ? r[value] : Object.values(r)[1]));
  const max = Math.max(1, ...values);

  // KPI — one big number, exactly like the tile it stands for.
  if (type === 'KPI' || type === 'CARD' || data.length === 1) {
    // A KPI row often carries several numbers (the metric, a count, an id); the
    // first key is frequently not the one on the card, which made previews read
    // "0". The largest magnitude is the metric in practice.
    const nums = Object.values(data[0] || {}).map(toNumber).filter((n) => Number.isFinite(n));
    const headline = nums.length ? nums.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0) : (values[0] ?? 0);
    return (
      <div className={`flex flex-col items-center justify-center ${className || ''}`}>
        <div className="truncate text-[15px] font-bold" style={{ color: accent }}>{compact(headline)}</div>
      </div>
    );
  }

  // Pie-like
  if (/PIE|DONUT|RING/.test(type)) {
    const total = values.reduce((a, b) => a + b, 0) || 1;
    let acc = -Math.PI / 2;
    return (
      <svg viewBox="0 0 40 40" className={className} preserveAspectRatio="xMidYMid meet">
        {values.slice(0, 6).map((v, i) => {
          const ang = (v / total) * Math.PI * 2;
          const x1 = 20 + 15 * Math.cos(acc);
          const y1 = 20 + 15 * Math.sin(acc);
          acc += ang;
          const x2 = 20 + 15 * Math.cos(acc);
          const y2 = 20 + 15 * Math.sin(acc);
          return (
            <path key={i} d={`M 20 20 L ${x1} ${y1} A 15 15 0 ${ang > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z`}
              fill={PALETTE[i % PALETTE.length]} />
          );
        })}
        {/DONUT|RING/.test(type) && <circle cx="20" cy="20" r="7" fill="white" />}
      </svg>
    );
  }

  // Line / area
  if (/LINE|AREA|TREND|SPARK/.test(type)) {
    const step = 100 / Math.max(1, values.length - 1);
    const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${i * step} ${34 - (v / max) * 30}`).join(' ');
    return (
      <svg viewBox="0 0 100 38" className={className} preserveAspectRatio="none">
        <path d={`${d} L 100 38 L 0 38 Z`} fill={accent} opacity={0.16} />
        <path d={d} fill="none" stroke={accent} strokeWidth="1.6" />
      </svg>
    );
  }

  // Table / matrix — show it as rows, which is how you recognise one.
  if (/TABLE|MATRIX|LIST/.test(type)) {
    return (
      <div className={`flex w-full flex-col justify-center gap-[2px] px-1 ${className || ''}`}>
        {data.slice(0, 5).map((r, i) => (
          <div key={i} className="flex items-center gap-1">
            <div className="h-[3px] flex-1 rounded-sm" style={{ background: i === 0 ? accent : 'rgba(120,130,150,.35)' }} />
            <div className="h-[3px] w-3 rounded-sm" style={{ background: 'rgba(120,130,150,.22)' }} />
          </div>
        ))}
      </div>
    );
  }

  // Default: bars (covers BAR/COLUMN/HBAR/WATERFALL/most others)
  const horizontal = /HBAR|HORIZONTAL/.test(type);
  if (horizontal) {
    return (
      <div className={`flex w-full flex-col justify-center gap-[2px] px-1 ${className || ''}`}>
        {values.slice(0, 6).map((v, i) => (
          <div key={i} className="h-[4px] rounded-sm" style={{ width: `${Math.max(6, (v / max) * 100)}%`, background: PALETTE[i % PALETTE.length] }} />
        ))}
      </div>
    );
  }
  const bw = 100 / (values.length * 1.5);
  return (
    <svg viewBox="0 0 100 38" className={className} preserveAspectRatio="none">
      {values.map((v, i) => (
        <rect
          key={i}
          x={i * bw * 1.5 + bw * 0.25}
          y={36 - (v / max) * 32}
          width={bw}
          height={(v / max) * 32}
          rx={1}
          fill={PALETTE[i % PALETTE.length]}
        />
      ))}
    </svg>
  );
}
