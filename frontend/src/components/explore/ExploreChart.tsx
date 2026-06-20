'use client';

import React, { useCallback, useMemo, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import {
  BarChart, Bar, LabelList,
  LineChart, Line,
  AreaChart, Area,
  ScatterChart, Scatter, ZAxis,
  PieChart, Pie, Cell,
  ComposedChart,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import type {
  ChartRoleConfig,
  ChartStyleConfig,
  DataLabelPosition,
  DataLabelRotation,
  DataLabelStyle,
  MetricConfig,
  NumberFormat,
} from './ExploreChartConfig';
import { fieldLabel, metricKey, metricLabel, normalizeChartStyleConfig, normalizeRoleConfig } from './ExploreChartConfig';
import type { ChartSortRule, TimeGranularity } from '@/types/api';
import { KpiCard } from '@/components/visualizations/KpiCard';
import { TableVisualization } from '@/components/visualizations/TableVisualization';
import { applyFiltersToRows } from '@/lib/filters';
import type { BaseFilter } from '@/lib/filters';
import { getPalette, type ChartPaletteName } from '@/lib/chartColors';
import { useDashboardChartTheme } from '@/components/dashboards/DashboardThemeProvider';
import { useExportMode } from '@/lib/export-mode';
import { applyCalculatedFields, buildExploreChartModel, type ChartSeriesDef } from './chartDataAdapter';
import { AdvancedExploreChart, ADVANCED_EXPLORE_CHART_TYPES } from './AdvancedExploreCharts';

// Phase-15.83 — DA dropped the FE row cap; the chart renders every row
// the BE returns. Constants removed (no longer referenced); if Recharts
// starts choking on very large datasets we revisit with server-side
// sampling rather than a client-side hard cap.

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ X-axis smart helpers ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
/**
 * Phase-15.22 — never hide an axis label.
 *
 * DA report: the X-axis was auto-hiding labels when the chart preview area
 * shrank ("preserveStartEnd" tick interval). Recharts' default behaviour is
 * to skip overlapping ticks; that's fine on a big screen but in a small
 * dashboard tile every other category vanishes and DA can't read the chart.
 *
 * PowerBI / Looker / Metabase pattern: ALWAYS show every label. When they
 * collide, rotate aggressively before falling back to horizontal scroll.
 * Long individual values get truncated with an ellipsis + native browser
 * tooltip on hover for the full text.
 *
 * SCROLL_THRESHOLD dropped from 40 → 25 because rotated labels eat
 * horizontal room earlier than upright ones. MIN_ITEM_WIDTH bumped from
 * 38 → 48 for the same reason — gives rotated text room to breathe.
 */
const SCROLL_THRESHOLD = 25;
const MIN_ITEM_WIDTH = 48;

/**
 * Phase-16.x — base margin for every Recharts cartesian chart.
 *
 * DA report (prod): the bottom of the x-axis tick labels was clipped by the
 * chart's SVG edge (a few px cut off the date labels). Root cause is the
 * default Recharts bottom margin (5px) being too tight once the axis band
 * sits flush at the surface bottom — and it gets worse with the prod
 * fallback font (CSP blocks the web-font CDN), whose taller glyphs push the
 * labels a few px further down. A slightly larger bottom margin moves the
 * axis band up so labels always sit fully inside the SVG. Top/right get a
 * little room too (top data labels + last x-label overflow); left stays at
 * the Recharts default so the Y-axis title isn't squeezed.
 */
const CHART_BASE_MARGIN = { top: 8, right: 12, left: 5, bottom: 14 } as const;

/**
 * Return XAxis props that adapt angle and height to the number of data
 * points. Phase-15.22 pins interval=0 so EVERY tick label renders.
 */
function buildXAxisProps(count: number, fontSize: number, xAxisLabel?: string, maxLabelChars = 0) {
  // #1 fix — rotation reacts to LABEL LENGTH, not just category count. Long
  // string labels (names, "Return/Adjustment") overlapped even at a low count
  // because the old logic only looked at `count`. Long labels rotate sooner
  // and, when very long, go fully vertical (-90) so the horizontal footprint
  // collapses to the text height — eliminating overlap on narrow tiles.
  let angle = 0;
  let height = 30;
  // `long` ≈ names / phrases ("Return/Adjustment"); short date labels
  // ("3/1/2024" = 8) deliberately stay below this so a month axis is NOT
  // force-rotated (no regression for the common case).
  const long = maxLabelChars >= 11;
  const veryLong = maxLabelChars >= 16;
  if (count > 60 || (long && count > 8)) {
    angle = -90;                                   // vertical → zero horizontal overlap
    height = Math.min(150, 70 + Math.min(maxLabelChars, 22) * 4);
  } else if (count > 25 || (long && count > 2) || veryLong) {
    angle = -45;
    height = 90;
  } else if (count > 12 || long) {
    angle = -30;
    height = 64;
  }
  const textAnchor: 'end' | 'middle' = angle !== 0 ? 'end' : 'middle';
  // BUG-010 — adaptive tick thinning. Phase-15.22 pinned interval:0 (render
  // EVERY label), which collides badly once the category count exceeds what
  // fits even when rotated — worst on narrow dashboard tiles. Below MAX_TICKS
  // we still render every label (keeps the Phase-15.22 behaviour for normal
  // charts); above it we evenly skip labels so rotated text stops overlapping.
  // Skipped categories stay reachable via the chart's hover tooltip, and any
  // rendered long label keeps its truncate + <title> hover (CustomAxisTick).
  const MAX_TICKS = 40;
  const interval: number = count > MAX_TICKS ? Math.ceil(count / MAX_TICKS) - 1 : 0;
  return { angle, height, textAnchor, interval, labelOffset: angle !== 0 ? -10 : -5, xAxisLabel };
}

/**
 * Phase-15.22 — custom axis tick component that truncates long labels and
 * exposes the full text via an SVG `<title>` (native browser tooltip on
 * hover). The previous default tick truncated at the SVG clipping
 * boundary, leaving "Custome…" mid-character; this controls truncation
 * cleanly with an ellipsis at a sensible character budget.
 *
 * Recharts passes `x`, `y`, `payload` automatically when this is wired
 * into an XAxis/YAxis `tick={<CustomAxisTick ... />}` prop. Static props
 * (angle / textAnchor / orientation / formatter) are passed in by the
 * caller and merged with Recharts' injected positioning.
 */
interface CustomAxisTickProps {
  x?: number;
  y?: number;
  payload?: { value: any };
  angle: number;
  textAnchor: 'end' | 'middle' | 'start';
  fontSize: number;
  formatter?: (v: any) => string;
  orientation: 'x' | 'y';
  /** Phase-B15 — theme axis-label color override. */
  fill?: string;
}

function CustomAxisTick({
  x = 0, y = 0, payload, angle, textAnchor, fontSize, formatter,
  orientation, fill,
}: CustomAxisTickProps) {
  // A null/empty category member shows as "(blank)" (consistent with the
  // table cells + breakdown legend) instead of an invisible empty tick.
  const _v = payload?.value;
  const raw = (_v === null || _v === undefined || _v === '')
    ? '(blank)'
    : (formatter ? formatter(_v) : String(_v));
  // Character budget per orientation/angle. Horizontal X axis has the
  // tightest room (bar-width wide). Rotated labels can be longer because
  // they extend downward into the reserved height. Y axis labels live
  // in the side margin — also generous.
  const maxChars = orientation === 'y'
    ? 22
    : angle === 0
      ? 12
      : 20;
  const display = raw.length > maxChars ? raw.slice(0, maxChars - 1) + '…' : raw;
  const truncated = display !== raw;
  const dy = orientation === 'x' ? fontSize : fontSize * 0.35;
  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0}
        y={0}
        dy={dy}
        textAnchor={textAnchor}
        transform={angle !== 0 ? `rotate(${angle})` : undefined}
        fontSize={fontSize}
        fill={fill || 'currentColor'}
        className={fill ? undefined : 'text-text-tertiary'}
      >
        {display}
        {truncated && <title>{raw}</title>}
      </text>
    </g>
  );
}

/**
 * Phase-15.82 — CustomLegend renders the Recharts legend with an inline
 * popover color picker per item. Clicking the swatch opens the picker;
 * clicking the label toggles series visibility. Strikethrough indicates
 * a hidden series (consistent with the old default-Legend behaviour).
 *
 * Props mirror what Recharts forwards to a custom `content=` legend.
 */
const COLOR_SWATCHES = [
  '#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed',
  '#0891b2', '#db2777', '#65a30d', '#ea580c', '#475569',
];

/**
 * Phase-15.88 — debounced color input. Drives a native `<input type=color>`
 * but only commits the value to the parent on blur (not on every drag
 * tick). Eliminates the popover-closing chatter DA reported.
 */
function ColorInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [local, setLocal] = React.useState(value);
  React.useEffect(() => { setLocal(value); }, [value]);
  return (
    <input
      type="color"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => { if (local !== value) onCommit(local); }}
      style={{ width: 30, height: 22, padding: 0, border: 'none' }}
    />
  );
}
interface CustomLegendProps {
  payload?: Array<{ value: string; dataKey?: string; color?: string }>;
  hiddenSeries: Set<string>;
  seriesColors?: Record<string, string>;
  fontSize: number;
  layout: 'horizontal' | 'vertical';
  onToggle: (key: string) => void;
  onColorChange?: (key: string, color: string) => void;
  onColorReset?: (key: string) => void;
}
function CustomLegend({
  payload = [],
  hiddenSeries,
  seriesColors,
  fontSize,
  layout,
  onToggle,
  onColorChange,
  onColorReset,
}: CustomLegendProps) {
  // Phase-15.88 — controlled Popover state. Earlier each <Popover.Root>
  // was uncontrolled, defaulting to closed. Picking a swatch fired
  // onColorChange → parent state update → ExploreChart re-render →
  // Recharts re-instantiates Legend → CustomLegend re-mounts with all
  // new Popover instances closed. User had to re-open after every
  // colour click (DA-reported "death by 1000 clicks").
  //
  // Lifting open-key into local state keeps the popover open across the
  // chart re-renders triggered by colour changes; only an explicit
  // outside-click or ESC closes it.
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  return (
    <ul
      style={{
        listStyle: 'none',
        padding: 0,
        margin: 0,
        display: 'flex',
        flexDirection: layout === 'vertical' ? 'column' : 'row',
        flexWrap: 'wrap',
        gap: layout === 'vertical' ? 4 : 12,
        justifyContent: 'center',
        fontSize,
      }}
    >
      {payload.map((entry) => {
        // Recharts types dataKey as `string | number | ((row) => any)`. We
        // only ever pass strings (`metricKey()` results) so the cast is
        // safe in practice, but force-stringify defensively in case a
        // future series ever uses a function dataKey — otherwise the
        // hiddenSeries Set lookup would silently miss every entry.
        const key = String(entry.dataKey ?? entry.value ?? '');
        const isHidden = hiddenSeries.has(key);
        const swatchColor = seriesColors?.[key] ?? entry.color ?? '#888';
        const canEditColor = Boolean(onColorChange);
        return (
          <li key={key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {canEditColor ? (
              <Popover.Root
                open={openKey === key}
                onOpenChange={(v) => setOpenKey(v ? key : null)}
              >
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    aria-label={`Change color for ${entry.value}`}
                    style={{
                      width: 12, height: 12, borderRadius: 3,
                      background: swatchColor,
                      border: '1px solid rgba(0,0,0,0.15)',
                      cursor: 'pointer',
                      padding: 0,
                      opacity: isHidden ? 0.4 : 1,
                    }}
                  />
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    side="top"
                    align="center"
                    sideOffset={6}
                    style={{
                      background: 'var(--surface-1, white)',
                      border: '1px solid rgba(0,0,0,0.15)',
                      borderRadius: 6,
                      padding: 8,
                      boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
                      zIndex: 50,
                    }}
                  >
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxWidth: 132 }}>
                      {COLOR_SWATCHES.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => onColorChange?.(key, c)}
                          style={{
                            width: 20, height: 20, borderRadius: 4,
                            background: c, cursor: 'pointer',
                            border: swatchColor === c ? '2px solid black' : '1px solid rgba(0,0,0,0.15)',
                            padding: 0,
                          }}
                        />
                      ))}
                    </div>
                    <div style={{ marginTop: 6, display: 'flex', gap: 4, alignItems: 'center' }}>
                      {/* Phase-15.88 — native color picker fires onChange on
                          every intermediate hue while the user drags. Each
                          tick triggered a chart re-render AND closed the
                          popover. Commit only on blur / explicit "Apply"
                          so the drag UX stays smooth. */}
                      <ColorInput
                        value={swatchColor.startsWith('#') ? swatchColor : '#000000'}
                        onCommit={(v) => onColorChange?.(key, v)}
                      />
                      {onColorReset && seriesColors?.[key] && (
                        <button
                          type="button"
                          onClick={() => onColorReset(key)}
                          style={{
                            fontSize: 10,
                            padding: '2px 6px',
                            background: 'transparent',
                            border: '1px solid rgba(0,0,0,0.2)',
                            borderRadius: 4,
                            cursor: 'pointer',
                          }}
                        >
                          Reset
                        </button>
                      )}
                    </div>
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            ) : (
              <span
                style={{
                  width: 12, height: 12, borderRadius: 3, background: swatchColor,
                  border: '1px solid rgba(0,0,0,0.15)', opacity: isHidden ? 0.4 : 1,
                }}
              />
            )}
            <span
              onClick={() => onToggle(key)}
              style={{
                cursor: 'pointer',
                color: isHidden ? 'var(--text-quaternary, #999)' : 'inherit',
                textDecoration: isHidden ? 'line-through' : 'none',
                userSelect: 'none',
              }}
            >
              {entry.value}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Wrap a Recharts chart element in a horizontally-scrollable container when
 * the number of categories exceeds SCROLL_THRESHOLD. The chart is given
 * sufficient horizontal space so every bar/point has breathing room.
 */
function wrapScrollable(el: React.ReactNode, count: number): React.ReactNode {
  if (count <= SCROLL_THRESHOLD) {
    return (
      <ResponsiveContainer width="100%" height="100%">
        {el as React.ReactElement}
      </ResponsiveContainer>
    );
  }
  const chartWidth = Math.max(count * MIN_ITEM_WIDTH, 700);
  return (
    <div style={{ width: '100%', height: '100%', overflowX: 'auto', overflowY: 'hidden' }}>
      <div style={{ width: chartWidth, height: '100%' }}>
        <ResponsiveContainer width="100%" height="100%">
          {el as React.ReactElement}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Number formatting ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
function formatNumber(value: any, style?: ChartStyleConfig, seriesKey?: string): string {
  const n = Number(value);
  if (isNaN(n)) return String(value);
  // Phase-15.82 — per-series format override. seriesFormats[key] beats
  // the global numberFormat so DA can mix % and VND in one chart.
  const perSeriesFmt = seriesKey ? style?.seriesFormats?.[seriesKey] : undefined;
  const perSeriesDec = seriesKey ? style?.seriesDecimalPlaces?.[seriesKey] : undefined;
  const fmt = perSeriesFmt ?? style?.numberFormat ?? 'compact';
  const dec = perSeriesDec ?? style?.decimalPlaces ?? 1;
  switch (fmt) {
    case 'compact':
      if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(dec)}B`;
      if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(dec)}M`;
      if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(dec)}K`;
      return n % 1 !== 0 ? n.toFixed(dec) : n.toLocaleString();
    case 'percent':
      return `${(n * 100).toFixed(dec)}%`;
    case 'currency':
      return `${style?.currencySymbol || '$'}${n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
    case 'number':
      return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: dec });
    default: // 'auto'
      return typeof value === 'number' ? value.toLocaleString() : String(value);
  }
}

function yAxisTickFormatter(style?: ChartStyleConfig) {
  return (value: any) => formatNumber(value, style);
}

function tooltipFormatter(series: ChartSeriesDef[], style?: ChartStyleConfig) {
  return (value: any, name: string) => {
    const match = series.find(item => item.key === name);
    return [formatNumber(value, style, name), match?.label ?? name];
  };
}

// Phase-15.84 — Recharts LabelList formatter helper.
//
// Phase-15.82 added this. Phase-15.84 routes single-series labels
// through `buildDataLabelContent` instead so DA gets position / font /
// background / collision controls. The function is kept for the
// stacked-bar percent inline labels and any future callers that just
// want a string formatter.
function dataLabelFormatter(style?: ChartStyleConfig, seriesKey?: string, seriesLabel?: string) {
  if (style?.dataLabelTemplate) {
    return (value: any, props?: any) => renderTemplatedLabel({
      template: style.dataLabelTemplate,
      value,
      seriesKey,
      seriesLabel,
      dimensionValue: props?.payload ? props.payload[Object.keys(props.payload)[0]] : undefined,
      style,
    });
  }
  return (value: any) => formatNumber(value, style, seriesKey);
}

/**
 * Phase-15.84 — resolve the effective DataLabelStyle for a given series,
 * walking three layers: per-series override → chart-wide
 * dataLabelConfig → legacy fallbacks (showDataLabels +
 * dataLabelPosition). Returns null when labels are disabled for the
 * series so callers can skip rendering entirely.
 */
function resolveDataLabelStyle(
  style: ChartStyleConfig | undefined,
  seriesKey: string,
): (Required<Pick<DataLabelStyle, 'position' | 'rotation' | 'fontSize' | 'fontColor' | 'background' | 'backgroundColor'>> & {
  format?: NumberFormat;
  autoHideOverlap: boolean;
}) | null {
  const dlc = style?.dataLabelConfig;
  // Backward compat — legacy showDataLabels enables when no new config exists.
  const enabled = dlc?.enabled ?? style?.showDataLabels ?? false;
  if (!enabled) return null;

  const override = dlc?.overrides?.[seriesKey];
  const legacyPosition = (style?.dataLabelPosition as DataLabelPosition | undefined);
  return {
    position: (override?.position ?? dlc?.position ?? legacyPosition ?? 'top') as DataLabelPosition,
    rotation: (override?.rotation ?? dlc?.rotation ?? 0) as DataLabelRotation,
    fontSize: override?.fontSize ?? dlc?.fontSize ?? (style?.fontSize ?? 11),
    fontColor: override?.fontColor ?? dlc?.fontColor ?? 'currentColor',
    background: override?.background ?? dlc?.background ?? false,
    backgroundColor: override?.backgroundColor ?? dlc?.backgroundColor ?? 'rgba(255,255,255,0.85)',
    format: override?.format ?? dlc?.format,
    autoHideOverlap: dlc?.autoHideOverlap ?? false,
  };
}

/**
 * Phase-15.90 — STACKED_BAR segment label resolver.
 *
 * Precedence (first match wins):
 *   1. Per-series override (`overrides[seriesKey].fontColor` etc.)
 *   2. STACKED-specific segment style (`segmentStyle.fontColor`)
 *   3. Chart-level DataLabelConfig (`dlc.fontColor`)
 *   4. Built-in segment default ('#fff' for fontColor — segments sit
 *      on a coloured bar, white is the safe default)
 *
 * Note the IMPORTANT distinction vs the chart-level resolver: when no
 * explicit colour is set anywhere, segment fontColor defaults to '#fff'
 * directly — not the 'currentColor' sentinel. This lets the renderer
 * skip the "if currentColor then white" remapping that previously
 * tripped up users who explicitly chose a dark colour (the colour
 * stuck) vs users who left it default (the colour also stuck on a
 * different code path). One source of truth = no surprise.
 */
// Pick black or white text based on perceived background luminance.
// Returns '#000' for light backgrounds, '#fff' for dark. Defensive
// against missing / non-hex inputs.
function pickContrastingTextColor(bgHex?: string): string {
  if (!bgHex || typeof bgHex !== 'string') return '#fff';
  const hex = bgHex.trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex) && !/^[0-9a-fA-F]{3}$/.test(hex)) return '#fff';
  const expand = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  const r = parseInt(expand.slice(0, 2), 16);
  const g = parseInt(expand.slice(2, 4), 16);
  const b = parseInt(expand.slice(4, 6), 16);
  // Relative luminance (per WCAG)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#000' : '#fff';
}

function resolveSegmentLabelStyle(
  style: ChartStyleConfig | undefined,
  seriesKey: string,
  barFill?: string,
): (Required<Pick<DataLabelStyle, 'position' | 'rotation' | 'fontSize' | 'fontColor' | 'background' | 'backgroundColor'>> & {
  format?: NumberFormat;
}) | null {
  const dlc = style?.dataLabelConfig;
  const enabled = dlc?.enabled ?? style?.showDataLabels ?? false;
  if (!enabled) return null;

  const override = dlc?.overrides?.[seriesKey];
  const seg = dlc?.segmentStyle;
  // Default fontColor: only fall to auto-contrast when neither override,
  // segment style, nor chart-level fontColor was set. Otherwise the
  // user's explicit pick must win.
  const explicit = override?.fontColor ?? seg?.fontColor ?? dlc?.fontColor;
  return {
    position: (override?.position ?? seg?.position ?? dlc?.position ?? 'center') as DataLabelPosition,
    rotation: (override?.rotation ?? seg?.rotation ?? dlc?.rotation ?? 0) as DataLabelRotation,
    fontSize: override?.fontSize ?? seg?.fontSize ?? dlc?.fontSize ?? (style?.fontSize ?? 11),
    fontColor: explicit ?? pickContrastingTextColor(barFill),
    background: override?.background ?? seg?.background ?? dlc?.background ?? false,
    backgroundColor: override?.backgroundColor ?? seg?.backgroundColor ?? dlc?.backgroundColor ?? 'rgba(0,0,0,0.45)',
    format: override?.format ?? seg?.format ?? dlc?.format,
  };
}

/**
 * Phase-15.90 — STACKED_BAR total label resolver.
 *
 * Precedence:
 *   1. STACKED-specific total style (`totalStyle.fontColor`)
 *   2. Chart-level DataLabelConfig (`dlc.fontColor`)
 *   3. Built-in total default ('rgb(var(--text-secondary))' — dark
 *      text on the chart background)
 *
 * No per-series overrides apply to the total — it's a chart-wide
 * label, not a series label. This is the bug fix DA reported: tweaking
 * "Apply to: Sales hunt" used to bleed into the stack total because
 * the old code passed series.key to resolveDataLabelStyle.
 */
function resolveTotalLabelStyle(
  style: ChartStyleConfig | undefined,
): (Required<Pick<DataLabelStyle, 'position' | 'rotation' | 'fontSize' | 'fontColor' | 'background' | 'backgroundColor'>> & {
  format?: NumberFormat;
}) | null {
  const dlc = style?.dataLabelConfig;
  const enabled = dlc?.enabled ?? style?.showDataLabels ?? false;
  if (!enabled) return null;

  const tot = dlc?.totalStyle;
  return {
    position: 'top',  // total is always above the stack — position fixed
    rotation: (tot?.rotation ?? dlc?.rotation ?? 0) as DataLabelRotation,
    fontSize: tot?.fontSize ?? dlc?.fontSize ?? (style?.fontSize ?? 11),
    fontColor: tot?.fontColor ?? dlc?.fontColor ?? 'rgb(var(--text-secondary))',
    background: tot?.background ?? dlc?.background ?? false,
    backgroundColor: tot?.backgroundColor ?? dlc?.backgroundColor ?? 'rgba(255,255,255,0.85)',
    format: tot?.format ?? dlc?.format,
  };
}

/**
 * Phase-15.84 — collision registry for the "auto-hide overlap" feature.
 *
 * Earlier draft used an Array<LabelBBox> and pushed on every label
 * render. Recharts re-invokes `content` on every animation tick, so the
 * array accumulated stale bboxes from the initial-position frame and
 * suppressed every label once the final-position frame ran.
 *
 * Fixed version uses a Map keyed by `${seriesKey}:${pointIndex}`. Each
 * label point owns exactly one slot; subsequent ticks for the same
 * label overwrite (idempotent). Collision check walks all OTHER slots
 * — never the entry being placed — so a label can update its own bbox
 * during animation without being mistaken for a collider.
 */
type LabelBBox = { x: number; y: number; width: number; height: number };
type LabelRegistry = Map<string, LabelBBox>;
function rectsOverlap(a: LabelBBox, b: LabelBBox, pad = 2): boolean {
  return !(a.x + a.width + pad < b.x || b.x + b.width + pad < a.x
        || a.y + a.height + pad < b.y || b.y + b.height + pad < a.y);
}

/**
 * Phase-15.84 — build a `content=` renderer for Recharts LabelList that
 * honours position / rotation / fontColor / background, and (optionally)
 * suppresses labels colliding with earlier ones in the same chart frame.
 *
 * `orientation` is 'vertical' (BAR/STACKED — labels on top of upright
 * bars) or 'horizontal' (HORIZONTAL_BAR — labels to the right of bars).
 * The position semantics differ between the two; this helper hides that
 * from the call sites.
 */
function buildDataLabelContent(opts: {
  resolved: ReturnType<typeof resolveDataLabelStyle>;
  seriesKey: string;
  seriesLabel: string;
  style: ChartStyleConfig;
  registry: LabelRegistry;
  orientation: 'vertical' | 'horizontal' | 'point';
  /** Phase-15.88 — chart's X-axis dimension field name. Used to look up
   *  {dimension} token explicitly instead of grabbing `Object.keys()[0]`
   *  which broke when BE returned rows with measure-first ordering. */
  xField?: string;
}): (props: any) => React.ReactNode {
  const { resolved, seriesKey, seriesLabel, style, registry, orientation, xField } = opts;
  if (!resolved) return () => null;
  const { position, rotation, fontSize, fontColor, background, backgroundColor, autoHideOverlap } = resolved;
  // Phase-15.84 bugfix — format precedence:
  //   1. DataLabel override.format (explicit per-series override)
  //   2. seriesFormats[seriesKey] (chart-wide per-series number format)
  //   3. dataLabelConfig.format (chart-wide data-label format)
  //   4. style.numberFormat (global)
  // Previously this builder bypassed seriesFormats whenever ANY format
  // was set on the resolved DL config — even when the user only set
  // fontColor / position. The label silently diverged from the tooltip.
  const effectiveFormat = resolved.format ?? style.seriesFormats?.[seriesKey] ?? style.numberFormat;
  const styleForLabel = effectiveFormat
    ? { ...style, numberFormat: effectiveFormat }
    : style;
  const formatLabel = (value: any, payload?: any) => {
    if (style.dataLabelTemplate) {
      // Phase-15.88 — resolve {dimension} via the explicit xField when
      // available. Fall back to first-key only when no xField is known
      // (eg. SCATTER where dim isn't on the row payload). The old
      // first-key heuristic silently picked a measure column when BE
      // emitted measures-first ordering.
      const dimensionValue = payload
        ? (xField && Object.prototype.hasOwnProperty.call(payload, xField)
            ? payload[xField]
            : payload[Object.keys(payload)[0]])
        : undefined;
      return renderTemplatedLabel({
        template: style.dataLabelTemplate,
        value,
        seriesKey,
        seriesLabel,
        dimensionValue,
        style: styleForLabel,
      });
    }
    return formatNumber(value, styleForLabel, seriesKey);
  };

  return (props: any) => {
    // Phase-15.84 bugfix — Recharts puts geometry on EITHER `props.viewBox`
    // (Line / Area / Pie) OR on top-level `props.x/y/width/height` (Bar).
    // The earlier draft only read top-level → Line/Area labels were
    // computing NaN coordinates and never rendered (the DA-reported
    // "line series has no labels in BAR_LINE" bug). Resolve geometry
    // from whichever source provides it.
    const vb = props.viewBox ?? {};
    // Phase-B3 — `??` does NOT catch NaN (only null/undefined), so a NaN
    // props.x on a degenerate/sparse series produced `<text x="NaN">` and
    // spammed ~100+ console errors. Coerce to a finite number (props → viewBox → 0).
    const num = (a: any, b: any) => (Number.isFinite(a) ? a : (Number.isFinite(b) ? b : 0));
    const x = num(props.x, vb.x);
    const y = num(props.y, vb.y);
    const width = num(props.width, vb.width);
    const height = num(props.height, vb.height);
    const { value, payload } = props;
    if (value === null || value === undefined || value === '') return null;
    const text = formatLabel(value, payload);
    if (!text) return null;

    // Approximate text bbox — Recharts doesn't expose measured metrics
    // before paint, so we estimate width from char count × 0.6 × font
    // size (matches the SVG default font roughly enough for collision
    // checks). Height is the font size + 4px padding.
    const approxWidth = text.length * fontSize * 0.6;
    const approxHeight = fontSize + 4;

    // Resolve anchor (cx, cy) from position + orientation.
    let cx = x;
    let cy = y;
    let textAnchor: 'start' | 'middle' | 'end' = 'middle';
    if (orientation === 'vertical') {
      cx = x + width / 2;
      switch (position) {
        case 'top':       cy = y - 4; break;
        case 'bottom':    cy = y + height + approxHeight; break;
        case 'inside':
        case 'center':
        case 'insideTop': cy = y + approxHeight; break;
        case 'insideBottom': cy = y + height - 4; break;
        default:          cy = y - 4;
      }
    } else if (orientation === 'horizontal') {
      cy = y + height / 2 + approxHeight / 3;
      switch (position) {
        case 'left':       cx = x - 4; textAnchor = 'end'; break;
        case 'inside':
        case 'center':     cx = x + width / 2; textAnchor = 'middle'; break;
        case 'insideEnd':  cx = x + width - 4; textAnchor = 'end'; break;
        case 'insideStart':cx = x + 4; textAnchor = 'start'; break;
        case 'right':
        default:           cx = x + width + 4; textAnchor = 'start';
      }
    } else {
      // 'point' — for LINE/AREA, Recharts gives the data point (x, y) directly.
      cx = x;
      switch (position) {
        case 'bottom': cy = y + approxHeight + 4; break;
        case 'center': cy = y; break;
        case 'top':
        default:       cy = y - 6;
      }
    }

    // Phase-B3 — never emit a label whose anchor is non-finite (degenerate
    // series). Prevents `<text x="NaN">` SVG errors.
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;

    // Collision check (optional). Skip labels overlapping any already-
    // placed label this frame.
    const bbox: LabelBBox = {
      x: textAnchor === 'middle' ? cx - approxWidth / 2 : textAnchor === 'end' ? cx - approxWidth : cx,
      y: cy - approxHeight + 2,
      width: approxWidth,
      height: approxHeight,
    };
    if (autoHideOverlap) {
      // Phase-15.84 bugfix — registry is a Map keyed by series+index so
      // the same label updating across animation ticks overwrites its
      // own slot. Collision check skips the entry being placed; checks
      // every other entry currently in the map.
      const slotKey = `${seriesKey}:${(props as any).index ?? 0}`;
      for (const [otherKey, placed] of registry) {
        if (otherKey === slotKey) continue;
        if (rectsOverlap(placed, bbox)) return null;
      }
      registry.set(slotKey, bbox);
    }

    const rotate = rotation === 0 ? undefined : `rotate(${rotation} ${cx} ${cy})`;
    return (
      <g transform={rotate}>
        {background && (
          <rect
            x={bbox.x - 3}
            y={bbox.y - 1}
            width={approxWidth + 6}
            height={approxHeight}
            rx={2}
            ry={2}
            fill={backgroundColor}
          />
        )}
        <text
          x={cx}
          y={cy}
          textAnchor={textAnchor}
          fontSize={fontSize}
          fill={fontColor}
          style={{ pointerEvents: 'none' }}
        >
          {text}
        </text>
      </g>
    );
  };
}

/**
 * Phase-15.82 — render a data-label using `style.dataLabelTemplate` when
 * provided. Supported tokens:
 *   {value}   – raw value formatted per-series
 *   {label}   – series display label
 *   {series}  – series key (machine-readable)
 *   {dimension} – row's dimension value
 *   {percent} – (PIE only) share as percent
 */
function renderTemplatedLabel(opts: {
  template?: string;
  value: any;
  seriesKey?: string;
  seriesLabel?: string;
  dimensionValue?: any;
  percent?: number;
  style?: ChartStyleConfig;
}): string {
  const { template, value, seriesKey, seriesLabel, dimensionValue, percent, style } = opts;
  const formatted = formatNumber(value, style, seriesKey);
  if (!template) return formatted;
  return template
    .replace(/\{value\}/g, formatted)
    .replace(/\{label\}/g, seriesLabel ?? seriesKey ?? '')
    .replace(/\{series\}/g, seriesKey ?? '')
    .replace(/\{dimension\}/g, dimensionValue == null ? '' : String(dimensionValue))
    .replace(/\{percent\}/g, percent == null ? '' : (percent * 100).toFixed(1));
}

/**
 * Phase-15.82 — Custom Recharts tooltip that respects per-series format
 * AND surfaces extra row fields the user opted into via
 * `style.tooltipExtraFields`. Falls back to a sensible default layout
 * when no extra fields are configured.
 */
interface CustomTooltipProps {
  active?: boolean;
  payload?: any[];
  label?: any;
  series: ChartSeriesDef[];
  style: ChartStyleConfig;
  fontSize: number;
  xField?: string;
  /** #3 fix — format the tooltip title (e.g. a date axis) instead of raw String(label). */
  labelFormatter?: (value: any) => string;
  /** #3 fix — 100%-stacked: show each segment's share of the stack ("99.9%")
   *  instead of the absolute value mis-formatted as percent. */
  percentOfTotal?: boolean;
}
function CustomTooltip({ active, payload, label, series, style, fontSize, xField, labelFormatter, percentOfTotal }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload ?? {};
  const extras = style.tooltipExtraFields ?? [];
  // #3 fix — date axes showed the raw ISO label ("2026-01-01T00:00:00") in the
  // tooltip title because this used String(label) and ignored labelFormatter.
  const titleText = (label === undefined || label === null)
    ? undefined
    : (labelFormatter ? labelFormatter(label) : String(label));
  // #3 fix — for 100%-stacked the segment value is absolute; formatting it as
  // percent produced garbage like "1032702900.0%". Show its share of the stack.
  const stackTotal = percentOfTotal
    ? payload.reduce((acc: number, e: any) => acc + (Number(e.value) || 0), 0)
    : 0;
  return (
    <div
      className="bg-surface-1 border border-[rgb(var(--border-line))] rounded shadow-linear-sm"
      style={{ fontSize, padding: '8px 10px', minWidth: 140 }}
    >
      {titleText !== undefined && (
        <div className="font-semibold text-text-primary mb-1">{titleText}</div>
      )}
      {payload.map((entry: any, i: number) => {
        const key = entry.dataKey ?? entry.name;
        const match = series.find((s) => s.key === key);
        const value = percentOfTotal
          ? (stackTotal ? `${((Number(entry.value) || 0) / stackTotal * 100).toFixed(1)}%` : '0%')
          : formatNumber(entry.value, style, key);
        const color = entry.color ?? entry.payload?.fill;
        return (
          <div key={i} className="flex items-center gap-2 text-text-secondary">
            {color && (
              <span style={{ width: 8, height: 8, background: color, borderRadius: 2, display: 'inline-block' }} />
            )}
            <span>{match?.label ?? key}:</span>
            <span className="font-medium text-text-primary">{value}</span>
          </div>
        );
      })}
      {extras.length > 0 && (
        <div className="mt-1 pt-1 border-t border-[rgb(var(--border-line))]/40">
          {extras.map((field) => {
            if (field === xField) return null;
            const v = row[field];
            if (v === undefined || v === null) return null;
            return (
              <div key={field} className="text-text-tertiary text-[11px]">
                <span className="opacity-70">{field}:</span> <span>{String(v)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function getBenchmarkValue(style?: ChartStyleConfig): number | null {
  if (style?.benchmarkValue === '' || style?.benchmarkValue == null) return null;
  const value = Number(style.benchmarkValue);
  return Number.isFinite(value) ? value : null;
}

function parseDateAxisValue(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }

  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !/(\d{4}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|T\d{2}:|\d{4})/.test(trimmed)) {
    return null;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function isDateLikeAxis(data: Record<string, any>[], field?: string, label?: string): boolean {
  if (!field) return false;
  const axisText = `${field} ${label ?? ''}`.toLowerCase();
  const fieldLooksDateLike = /(date|time|timestamp|_at|created|updated|day|month|year|start|end|deadline)/.test(axisText);
  const samples = data
    .map((row) => row?.[field])
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== '')
    .slice(0, 25);

  if (samples.length === 0) return false;
  const parseable = samples.filter((value) => parseDateAxisValue(value) !== null).length;
  return parseable / samples.length >= 0.6 && (fieldLooksDateLike || parseable === samples.length);
}

function formatDateAxisValue(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}$/.test(trimmed) || /^\d{4}[-/]\d{1,2}$/.test(trimmed)) return trimmed;
  }

  const parsed = parseDateAxisValue(value);
  if (parsed === null) return String(value ?? '');
  return new Date(parsed).toLocaleDateString();
}

function sortRowsByDateAxis(data: Record<string, any>[], field: string | undefined, enabled: boolean): Record<string, any>[] {
  if (!enabled || !field) return data;
  return [...data].sort((a, b) => (parseDateAxisValue(a?.[field]) ?? 0) - (parseDateAxisValue(b?.[field]) ?? 0));
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Client-side group-by + aggregation (like PowerBI) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
function applyGroupByAgg(
  data: Record<string, any>[],
  dimField: string,
  metrics: MetricConfig[],
): Record<string, any>[] {
  if (!dimField || metrics.length === 0 || data.length === 0) return data;

  const groups = new Map<string, Record<string, any>[]>();
  for (const row of data) {
    const key = String(row[dimField] ?? '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  return Array.from(groups.entries()).map(([dimVal, rows]) => {
    const result: Record<string, any> = { [dimField]: dimVal };
    for (const m of metrics) {
      const key = metricKey(m);
      const vals = rows.map(r => Number(r[m.field]) || 0);
      switch (m.agg) {
        case 'sum':            result[key] = vals.reduce((a, b) => a + b, 0); break;
        case 'avg':            result[key] = vals.reduce((a, b) => a + b, 0) / vals.length; break;
        case 'count':          result[key] = rows.length; break;
        case 'min':            result[key] = Math.min(...vals); break;
        case 'max':            result[key] = Math.max(...vals); break;
        case 'count_distinct': result[key] = new Set(rows.map(r => r[m.field])).size; break;
        default:               result[key] = vals.reduce((a, b) => a + b, 0);
      }
    }
    return result;
  });
}

// ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Pivot rows by breakdown field ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
function pivotByBreakdown(
  data: Record<string, any>[],
  dimField: string,
  metric: MetricConfig,
  breakdownField: string,
  preAggregated = false,
  havingFilters: BaseFilter[] = [],
): { pivoted: Record<string, any>[]; seriesKeys: string[] } {
  const seriesKeys = [...new Set(data.map(r => String(r[breakdownField] ?? '')))].slice(0, 12);
  // When backend pre-aggregated, the metric value is in the aliased column (e.g. "sum__field")
  const valueKey = preAggregated ? metricKey(metric) : metric.field;

  // Two-pass: collect raw rows per (dim, breakdown) group, then aggregate properly
  const groupMap = new Map<string, Map<string, Record<string, any>[]>>();
  for (const row of data) {
    const dk = String(row[dimField] ?? '');
    const bk = String(row[breakdownField] ?? '');
    if (!groupMap.has(dk)) groupMap.set(dk, new Map());
    const bkMap = groupMap.get(dk)!;
    if (!bkMap.has(bk)) bkMap.set(bk, []);
    bkMap.get(bk)!.push(row);
  }

  const pivoted: Record<string, any>[] = [];
  for (const [dk, bkMap] of groupMap) {
    const out: Record<string, any> = { [dimField]: dk };
    seriesKeys.forEach(k => { out[k] = 0; });
    for (const [bk, rows] of bkMap) {
      if (!seriesKeys.includes(bk)) continue;
      const vals = rows.map(r => Number(r[valueKey]) || 0);
      switch (metric.agg) {
        case 'sum':            out[bk] = vals.reduce((a, b) => a + b, 0); break;
        case 'avg':            out[bk] = vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 1); break;
        case 'count':          out[bk] = rows.length; break;
        case 'min':            out[bk] = Math.min(...vals); break;
        case 'max':            out[bk] = Math.max(...vals); break;
        case 'count_distinct': out[bk] = new Set(rows.map(r => r[valueKey])).size; break;
        default:               out[bk] = vals.reduce((a, b) => a + b, 0);
      }
    }
    pivoted.push(out);
  }

  // Apply having filters to pivoted result (Bug 6 fix)
  const filtered = havingFilters.length > 0 ? applyFiltersToRows(pivoted, havingFilters) : pivoted;
  return { pivoted: filtered, seriesKeys };
}

// ── Client-side sort helper ───────────────────────────────────────────────────
function applySortRules(data: Record<string, any>[], rules: ChartSortRule[]): Record<string, any>[] {
  if (!rules || rules.length === 0) return data;
  return [...data].sort((a, b) => {
    for (const rule of rules) {
      const av = a[rule.field];
      const bv = b[rule.field];
      const aNum = Number(av);
      const bNum = Number(bv);
      const numeric = !isNaN(aNum) && !isNaN(bNum);
      let cmp = 0;
      if (numeric) {
        cmp = aNum - bNum;
      } else {
        cmp = String(av ?? '').localeCompare(String(bv ?? ''));
      }
      if (cmp !== 0) return rule.direction === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
}

// BUG-012 — Top/Bottom N limit, re-enabled as an EXPLICIT opt-in (it was
// retired to a pass-through in Phase-15.83). It only caps when DA sets
// style.dataLimit to a positive number; an unset / 0 / '' limit returns
// every row, so charts that never configured a limit render unchanged.
// Called AFTER applySortRules, so "top N" == the first N rows of the chosen
// ordering and "bottom N" == the last N. Mirrors ChartPreview.applyDataLimit
// (the legacy render path) so both surfaces behave identically.
function applyDataLimit(
  data: Record<string, any>[],
  limit: number | '' | undefined,
  direction: 'top' | 'bottom' | undefined,
): Record<string, any>[] {
  if (!limit || typeof limit !== 'number' || limit <= 0) return data;
  return direction === 'bottom' ? data.slice(-limit) : data.slice(0, limit);
}

// ── Time granularity bucketing ────────────────────────────────────────────────
function bucketTimestamp(ts: any, granularity: TimeGranularity): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  switch (granularity) {
    case 'day':   return d.toISOString().slice(0, 10); // YYYY-MM-DD
    case 'week': {
      // Monday of the week
      const day = d.getDay();
      const diff = (day === 0 ? -6 : 1 - day);
      const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
      return `W${mon.toISOString().slice(0, 10)}`;
    }
    case 'month':   return d.toISOString().slice(0, 7); // YYYY-MM
    case 'quarter': return `${d.getFullYear()}-Q${Math.ceil((d.getMonth() + 1) / 3)}`;
    case 'year':    return String(d.getFullYear());
    default:        return String(ts);
  }
}

function applyTimeGranularity(
  data: Record<string, any>[],
  timeField: string,
  metrics: MetricConfig[],
  granularity: TimeGranularity,
): Record<string, any>[] {
  if (!granularity || granularity === 'raw' || !timeField || metrics.length === 0) return data;
  const buckets = new Map<string, Record<string, any>[]>();
  for (const row of data) {
    const key = bucketTimestamp(row[timeField], granularity);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(row);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, rows]) => {
      const out: Record<string, any> = { [timeField]: bucket };
      for (const m of metrics) {
        const key = metricKey(m);
        const vals = rows.map(r => Number(r[key] ?? r[m.field]) || 0);
        switch (m.agg) {
          case 'sum':            out[key] = vals.reduce((a, b) => a + b, 0); break;
          case 'avg':            out[key] = vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 1); break;
          case 'count':          out[key] = rows.length; break;
          case 'min':            out[key] = Math.min(...vals); break;
          case 'max':            out[key] = Math.max(...vals); break;
          case 'count_distinct': out[key] = new Set(rows.map(r => r[m.field])).size; break;
          default:               out[key] = vals.reduce((a, b) => a + b, 0);
        }
      }
      return out;
    });
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="h-full flex items-center justify-center text-text-quaternary">
      <p className="text-sm text-center max-w-xs px-4">{message}</p>
    </div>
  );
}

export interface ExploreChartProps {
  type: string;
  data: Record<string, any>[];
  roleConfig: ChartRoleConfig;
  styleConfig?: ChartStyleConfig;
  onStyleConfigChange?: (nextStyleConfig: ChartStyleConfig) => void;
  /** Post-aggregation (HAVING) filters ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â applied after group-by+agg */
  havingFilters?: BaseFilter[];
  /** When true, backend already ran GROUP BY aggregation ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â skip client-side applyGroupByAgg */
  preAggregated?: boolean;
  onSelectDataPoint?: (selection: { field: string; value: unknown } | null) => void;
  /** Phase-4: map qualified-or-bare field → display label, so legends and
   *  tooltips show measure.label instead of SQL identifiers. */
  labelMap?: import('./ExploreChartConfig').SemanticLabelMap;
  /** Phase-15.93: map qualified-or-bare field → NumberFormat declared on
   *  the semantic measure. Used as the DEFAULT for KPI / chart number
   *  formatting when the user hasn't set styleConfig.numberFormat (or a
   *  per-series override). Lets a CR1 measure with format.kind='percent'
   *  render as "30%" instead of "0.3" out of the box. */
  formatMap?: Map<string, import('./ExploreChartConfig').NumberFormat>;
  /** Rendered inside a dashboard tile (which supplies its own card frame).
   *  Currently only affects KPI: drops KpiCard's nested card chrome and lets
   *  it fill the tile width instead of capping at max-w-xl. Default false
   *  keeps standalone Explore rendering unchanged. */
  embedded?: boolean;
  /** #2 — viewer date-hierarchy: when provided (Dashboard/Public tile), the
   *  drill chips re-bucket via a BE re-query at the chosen grain (works even
   *  on pre-aggregated charts, all measure types). The tile owns the grain
   *  state and passes it as `viewerGrain`. */
  onViewerDrill?: (grain: import('@/types/api').TimeGranularity | undefined) => void;
  /** #2 — the grain currently requested by the viewer drill (for active-state
   *  highlight). undefined ⇒ chart's saved grain. */
  viewerGrain?: string;
  /** #KPI-header — the host tile renders the KPI metric label in its header
   *  row (level with the toolbar), so KpiCard hides its own label. */
  kpiLabelInHeader?: boolean;
}

function ExploreChartInner({
  type,
  data,
  roleConfig,
  styleConfig: _style,
  onStyleConfigChange,
  havingFilters = [],
  preAggregated = false,
  onSelectDataPoint,
  labelMap,
  formatMap,
  embedded = false,
  onViewerDrill,
  viewerGrain,
  kpiLabelInHeader = false,
}: ExploreChartProps) {
  const baseStyle = useMemo(() => normalizeChartStyleConfig(_style), [_style]);
  // During PDF export, turn OFF recharts enter-animations: html2canvas snapshots
  // the SVG ~immediately, so an animating chart (bars/lines growing from 0) gets
  // captured blank/partial. animate=false → final state is painted at once.
  const animate = !useExportMode();
  // UX (Date Hierarchy in viewer) — read-only surfaces (dashboard tile, public
  // link) render WITHOUT onStyleConfigChange, so the editor's persisted drill
  // can't be changed there. Hold an EPHEMERAL drill level locally and inject it
  // into the effective style so an end-user can re-bucket the time axis (Y/Q/M/
  // W/D) without mutating the saved chart. Only active in embedded viewers; the
  // standalone editor keeps persisting through onStyleConfigChange untouched.
  const [ephemeralDrill, setEphemeralDrill] = useState<TimeGranularity | undefined>(undefined);
  const style = useMemo(
    () => {
      let s = (!onStyleConfigChange && ephemeralDrill !== undefined
        ? { ...baseStyle, dateDrillLevel: ephemeralDrill }
        : baseStyle);
      // Phase-16.x — "format follows the field": overlay each measure's declared
      // format (formatMap, from measure.format.kind) UNDER any explicit
      // per-series override, keyed by the series' metricKey. This makes a
      // percent / currency measure auto-render as 30% / $1,234 in data labels,
      // tooltips and (via renderYAxis) the value axis — across every chart type
      // — without the user setting Per-series format by hand. Explicit
      // seriesFormats still win; this is only the default.
      if (formatMap && formatMap.size) {
        const nrc = normalizeRoleConfig(type, roleConfig);
        const seriesMetrics = [...nrc.metrics, nrc.lineMetric, nrc.benchmarkMetric].filter(Boolean) as { field: string; agg: string }[];
        const merged = { ...(s.seriesFormats ?? {}) };
        let changed = false;
        for (const m of seriesMetrics) {
          const key = metricKey(m as any);
          if (merged[key]) continue;
          const fmt = formatMap.get(m.field) ?? (m.field.includes('.') ? formatMap.get(m.field.split('.').slice(-1)[0]) : undefined);
          if (fmt) { merged[key] = fmt; changed = true; }
        }
        if (changed) s = { ...s, seriesFormats: merged };
      }
      return s;
    },
    [baseStyle, onStyleConfigChange, ephemeralDrill, formatMap, type, roleConfig],
  );
  // Phase-B15 — dashboard theme palette + structural colors. In standalone
  // Explore there is no DashboardThemeProvider, so this is {} and behaviour is
  // unchanged. Inside a dashboard/public view it supplies the report palette.
  const dashboardTheme = useDashboardChartTheme();
  const PALETTE = useMemo(
    () => {
      const chosen = (style.palette as ChartPaletteName) || 'default';
      // A theme data palette acts as the report default; an explicit non-default
      // chart palette still wins, and per-series overrides win over both.
      if ((chosen === 'default' || !chosen) && dashboardTheme.dataColors?.length) {
        return dashboardTheme.dataColors;
      }
      return getPalette(chosen).colors;
    },
    [style.palette, dashboardTheme.dataColors],
  );
  const gridStroke = dashboardTheme.gridlineColor || undefined;
  const axisTickFill = dashboardTheme.axisLabelColor || undefined;
  // Resolve per-series color: explicit override beats palette index.
  const getSeriesColor = useCallback(
    (key: string, index: number): string => {
      const override = style.seriesColors?.[key];
      if (override) return override;
      return PALETTE[index % PALETTE.length];
    },
    [style.seriesColors, PALETTE],
  );
  const fontSize = style.fontSize || 12;
  const chartTitleFontSize = Math.max(style.chartTitleFontSize ?? fontSize, 14);
  const hasExplicitFontSize = Boolean(
    _style && Object.prototype.hasOwnProperty.call(_style, 'fontSize') && style.fontSize !== 12,
  );
  const kpiValueFontSize = style.kpiValueFontSize ?? (hasExplicitFontSize ? style.fontSize : undefined);
  const tableNumberFormat = style.numberFormat && style.numberFormat !== 'compact' ? style.numberFormat : 'auto';
  // Phase-15.83 — showAllPoints flag retired; adapter renders every row.
  const model = useMemo(
    () => buildExploreChartModel({ type, data, roleConfig, havingFilters, preAggregated, labelMap }),
    [type, data, roleConfig, havingFilters, preAggregated, labelMap],
  );
  const {
    roleConfig: normalizedRoleConfig,
    invalidMessage,
    xField,
    tableData,
    tableColumns,
    categoricalData,
    categoricalSeries,
    comboData,
    comboBarSeries,
    comboLineSeries,
    pieData,
    kpiMetric,
    kpiValue,
    kpiBenchmarkValue,
    scatterPoints,
  } = model;
  const { dimension, metrics, scatterX, scatterY } = normalizedRoleConfig;

  // Phase-15.78 — click a legend entry to hide that series. Recharts'
  // `<Bar/Line/Area hide={true}>` props are respected without re-laying
  // out the chart (slot stays, line vanishes), and the legend onClick
  // handler gets the clicked entry's dataKey via payload. Stored in a
  // Set keyed by series.key so toggling is O(1).
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set());
  const toggleSeriesHidden = useCallback((seriesKey: string) => {
    setHiddenSeries(prev => {
      const next = new Set(prev);
      if (next.has(seriesKey)) next.delete(seriesKey);
      else next.add(seriesKey);
      return next;
    });
  }, []);
  const handleLegendClick = useCallback((payload: any) => {
    const key = payload?.dataKey ?? payload?.value;
    if (typeof key === 'string' && key) toggleSeriesHidden(key);
  }, [toggleSeriesHidden]);

  // Apply sort + limit to chart-output rows before rendering.
  const sortRules = style.chartSortRules ?? [];
  const dataLimit = style.dataLimit;
  const dataLimitDir = style.dataLimitDirection ?? 'top';

  const categoricalOutputData = useMemo(() => {
    if (type !== 'LINE' && type !== 'TIME_SERIES') {
      return categoricalData;
    }

    // Phase-15.82 — dateDrillLevel from click-drill takes priority over the
    // user-chosen timeGranularity. Allows DA to drill into year → quarter →
    // month → day with no config round-trip to the BE.
    const gran = style.dateDrillLevel ?? style.timeGranularity ?? 'raw';
    const tf = normalizedRoleConfig.timeField || xField;

    if (!tf || gran === 'raw') {
      return categoricalData;
    }

    // Phase-15.78 — when BE already ran SELECT … GROUP BY date_trunc(…)
    // (pre_aggregated=true), running applyTimeGranularity here would
    // re-bucket already-bucketed rows and silently produce wrong output.
    // The Phase-12.5 contract was that FE skips client-side aggregation
    // when preAggregated; that was enforced for applyGroupByAgg but
    // missed here. Defer to the BE's chosen bucket and skip.
    if (preAggregated) {
      return categoricalData;
    }

    return applyTimeGranularity(categoricalData, tf, metrics, gran);
  }, [type, categoricalData, style.timeGranularity, style.dateDrillLevel, normalizedRoleConfig.timeField, xField, metrics, preAggregated]);

  const sortedCategoricalData = useMemo(() => {
    // Phase-15.82 — apply inline calculated fields BEFORE sort+limit so
    // calc fields are sortable too (e.g. "top 5 by margin").
    let d = applyCalculatedFields(categoricalOutputData, style.calculatedFields ?? []);
    d = applySortRules(d, sortRules);
    d = applyDataLimit(d, dataLimit, dataLimitDir);
    return d;
  }, [categoricalOutputData, style.calculatedFields, sortRules, dataLimit, dataLimitDir]);

  // Phase-15.82 — series list extended with calculated fields so they
  // render as additional lines/bars in cartesian charts.
  const calculatedSeries: ChartSeriesDef[] = useMemo(
    () => (style.calculatedFields ?? []).map((f) => ({ key: f.id, label: f.label || f.id })),
    [style.calculatedFields],
  );
  const categoricalSeriesWithCalc = useMemo(
    () => [...categoricalSeries, ...calculatedSeries],
    [categoricalSeries, calculatedSeries],
  );

  const sortedComboData = useMemo(() => {
    let d = applySortRules(comboData, sortRules);
    d = applyDataLimit(d, dataLimit, dataLimitDir);
    return d;
  }, [comboData, sortRules, dataLimit, dataLimitDir]);

  const sortedScatterPoints = useMemo(() => {
    let d = applySortRules(scatterPoints, sortRules);
    d = applyDataLimit(d, dataLimit, dataLimitDir);
    return d;
  }, [scatterPoints, sortRules, dataLimit, dataLimitDir]);
  const handleTableColumnWidthsChange = (nextWidths: Record<string, number>) => {
    onStyleConfigChange?.({
      ...style,
      tableColumnWidths: Object.keys(nextWidths).length > 0 ? nextWidths : undefined,
    });
  };

  const timeSeriesData = useMemo(() => {
    if (type !== 'LINE' && type !== 'TIME_SERIES') return sortedCategoricalData;
    return sortedCategoricalData;
  }, [type, sortedCategoricalData]);

  if (!data || data.length === 0) {
    return <EmptyState message="No data. Run the query first." />;
  }

  if (invalidMessage) {
    return <EmptyState message={invalidMessage} />;
  }

  // Truncation banner ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â shown above the chart when data points exceed MAX_CHART_POINTS
  // Phase-15.83 — DA dropped the FE row cap entirely. No banner, no toggle.
  // `truncated` from the model is now always false, so TruncationBanner
  // below collapses to null.
  // Phase-15.82 — date hierarchy drill controls.
  //
  // UX rules (refined):
  //   - Hidden by default to avoid cluttering every LINE chart with chips
  //     the user never asked for.
  //   - Once any drill level is set (`style.dateDrillLevel != null`), the
  //     full bar appears with a "× clear drill" affordance.
  //   - The label says "Drill (overrides Granularity)" so DA who already
  //     picked timeGranularity in the Style tab understands why the chart
  //     suddenly buckets differently.
  //   - When no drill is active, surface a tiny ghost button so the
  //     feature is discoverable (DA could otherwise never find it).
  const DRILL_LEVELS: Array<{ value: TimeGranularity; label: string }> = [
    { value: 'year', label: 'Y' },
    { value: 'quarter', label: 'Q' },
    { value: 'month', label: 'M' },
    { value: 'week', label: 'W' },
    { value: 'day', label: 'D' },
  ];
  const isTimeChart = type === 'LINE' || type === 'TIME_SERIES';
  const hasTimeField = Boolean(normalizedRoleConfig.timeField || xField);
  // #2 — date hierarchy works on ANY chart with a date X axis (line, bar,
  // stacked bar, combo…), not only LINE/TIME_SERIES. Detect a date axis from
  // the data so a stacked bar over `order_date` also offers the drill.
  const hasDateAxis = isTimeChart || isDateLikeAxis(data, xField, normalizedRoleConfig.timeField);
  // Drill is available when we can: persist (editor: onStyleConfigChange),
  // re-query the BE at a new grain (viewer: onViewerDrill — works even on
  // pre-aggregated dashboard/public charts, all measure types), or re-bucket
  // client-side (embedded raw-row charts: ephemeral, no round-trip).
  const canDrill = hasDateAxis && hasTimeField && (
    Boolean(onStyleConfigChange) || Boolean(onViewerDrill) || (embedded && !preAggregated)
  );
  // Active grain to highlight: a viewer drill (BE re-query) tracks `viewerGrain`;
  // otherwise the saved / ephemeral dateDrillLevel.
  const effectiveDrillLevel = onViewerDrill ? viewerGrain : style.dateDrillLevel;
  const drillActive = Boolean(effectiveDrillLevel);
  const handleDrillChange = (level: TimeGranularity | 'raw') => {
    const next = level === 'raw' ? undefined : level;
    if (onStyleConfigChange) {
      onStyleConfigChange({ ...style, dateDrillLevel: next });
      return;
    }
    if (onViewerDrill) {
      onViewerDrill(next);   // viewer: BE re-query at the new grain
      return;
    }
    setEphemeralDrill(next);
  };
  // Phase-16.x — date-drill control moved to the chart's TOP-RIGHT as a proper
  // chip (was a faint underlined "Enable date drill…" text line at top-left
  // that read like stray chart content and crowded the y-axis / legend). Right
  // alignment is the conventional spot for a per-visual drill toggle and keeps
  // it clear of the plot.
  const DrillBar = canDrill ? (
    <div className="flex items-center justify-end gap-1 px-1 mb-1">
      {drillActive ? (
        <>
          <span className="mr-0.5 text-[10px] font-medium text-text-tertiary" title="Drill thời gian — tạm gom biểu đồ theo cấp ngày, đè lên Granularity ở tab Style.">
            Gom theo:
          </span>
          {DRILL_LEVELS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => handleDrillChange(opt.value)}
              className={`rounded px-1.5 py-0.5 text-[10px] ${effectiveDrillLevel === opt.value ? 'bg-brand text-white' : 'border border-[rgb(var(--border-line))] bg-surface-2 hover:bg-surface-3'}`}
              title={opt.value}
            >
              {opt.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => handleDrillChange('raw')}
            className="ml-0.5 rounded border border-[rgb(var(--border-line))] bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-quaternary hover:bg-surface-3"
            title="Tắt drill — quay về Granularity ở tab Style"
          >
            × Tắt
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => {
            // Seed from the Style tab's granularity, else 'month' (a sensible
            // default — 'raw' would look identical to disabled).
            const seed = (style.timeGranularity && style.timeGranularity !== 'raw')
              ? (style.timeGranularity as TimeGranularity)
              : 'month';
            handleDrillChange(seed);
          }}
          className="inline-flex items-center gap-1 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-text-tertiary hover:border-[rgb(var(--border-strong))] hover:text-text-secondary"
          title="Drill thời gian: tạm đổi cấp gom thời gian (Năm/Quý/Tháng/Tuần/Ngày) cho biểu đồ. Granularity ở tab Style là mặc định."
        >
          <span aria-hidden>▾</span> Gom theo thời gian
        </button>
      )}
    </div>
  ) : null;

  // Phase-15.83 — banner removed; FE no longer truncates. Keep variable
  // name so JSX further down doesn't need editing.
  const TruncationBanner: React.ReactNode = null;

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ Shared rendering helpers ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  const showGrid = style.showGrid ?? true;
  const legendPos = style.legendPosition || 'bottom';
  const showLegend = legendPos !== 'none';
  const barRadius = style.barRadius ?? 4;
  const barSize = typeof style.barSize === 'number' && style.barSize > 0 ? style.barSize : undefined;
  // Phase-15.84 — `showDataLabels` is now a derived signal: enabled when
  // EITHER the legacy flag or the new DataLabelConfig.enabled is true.
  // Renderers gate on this; per-series visibility comes from
  // resolveDataLabelStyle below.
  const showDataLabels = style.dataLabelConfig?.enabled ?? style.showDataLabels ?? false;
  // Phase-15.84 — collision registry as a Map keyed by series+pointIndex.
  // Recreated each React render. Recharts replays `content` on every
  // animation tick within the same render closure; the Map shape is
  // idempotent across those replays so labels don't get permanently
  // suppressed once initial → final frame transitions complete.
  const labelRegistry: LabelRegistry = new Map();
  /**
   * Helper used by every LabelList call site to produce a custom
   * `content=` renderer respecting position / rotation / font / bg.
   * Falls back to plain text if labels are disabled for this series.
   */
  const dataLabelContent = (seriesKey: string, seriesLabel: string, orientation: 'vertical' | 'horizontal' | 'point') => {
    const resolved = resolveDataLabelStyle(style, seriesKey);
    return buildDataLabelContent({
      resolved,
      seriesKey,
      seriesLabel,
      style,
      registry: labelRegistry,
      orientation,
      // Phase-15.88 — pass chart's x-axis dimension field so template
      // {dimension} token resolves reliably (vs the old first-key trick).
      xField,
    });
  };
  // Marker (dot) visibility — Power BI / Tableau parity.
  // • Explicit ON  → honour the user's choice up to a perf safety-cap so a
  //   deliberate toggle is never silently ignored on a dense line (the
  //   "dead control" trap: at >60 points the old `showDots && len<=60` guard
  //   made the toggle inert with no feedback).
  // • Explicit OFF → never draw dots.
  // • Unset        → auto-hide on dense series (clutter-avoidance default).
  const DOT_DENSITY_CAP = 500; // hard ceiling — never render thousands of <circle>
  const DOT_AUTO_LIMIT = 60; // default heuristic for the unset case
  const showDotsPref = style.showDots; // true | false | undefined
  const dotsForCount = (n: number): boolean => {
    if (showDotsPref === false) return false;
    if (showDotsPref === true) return n <= DOT_DENSITY_CAP;
    return n <= DOT_AUTO_LIMIT;
  };
  const lineWidth = style.lineWidth ?? 2;
  const areaOpacity = style.areaOpacity ?? 0.6;
  const lineDash = style.lineStyle === 'dashed' ? '8 4' : undefined;
  const chartTitle = style.chartTitle?.trim() || undefined;
  // Donut hole %, interpreted relative to the pie's OUTER radius (see the
  // <Pie> below). A fresh DONUT defaults to a real hole so it doesn't render
  // identically to a PIE; PIE defaults to solid (0).
  const pieInnerRadius = style.pieInnerRadius ?? (type === 'DONUT' ? 55 : 0);
  const stackMode = style.stackMode ?? 'normal';
  // BI-standard (Power BI "Line and clustered column"): the line metric of a
  // combo chart belongs on a SECONDARY (right) axis when its scale differs
  // greatly from the bars — a bar metric (revenue 10M) and a line metric
  // (units 3K) on ONE axis crush the line flat at zero. `style.dualYAxis`
  // defaults to `false`, so we can't rely on it; instead auto-promote at
  // runtime when the bar-max and line-max differ ≥5× (and the user hasn't
  // already turned it on). Similar-scale metrics keep the shared axis.
  const autoDualYForBarLine = useMemo(() => {
    if (type !== 'BAR_LINE') return false;
    const barKeys = comboBarSeries.map((s) => s.key);
    const lineKey = comboLineSeries?.[0]?.key;
    if (!lineKey || barKeys.length === 0) return false;
    const maxAbs = (key: string) => comboData.reduce((m, r) => {
      const v = Math.abs(Number(r?.[key])); return Number.isFinite(v) && v > m ? v : m;
    }, 0);
    const barMax = Math.max(...barKeys.map(maxAbs), 0);
    const lineMax = maxAbs(lineKey);
    if (barMax <= 0 || lineMax <= 0) return false;
    const ratio = barMax > lineMax ? barMax / lineMax : lineMax / barMax;
    return ratio >= 5;
  }, [type, comboBarSeries, comboLineSeries, comboData]);
  const dualYAxis = (style.dualYAxis ?? false) || autoDualYForBarLine;
  const yAxisRightLabel = style.yAxisRightLabel?.trim()
    || (type === 'BAR_LINE' ? comboLineSeries?.[0]?.label : undefined)
    || undefined;
  const scatterLabelField = style.scatterLabelField?.trim() || undefined;
  const benchmarkValue = getBenchmarkValue(style);
  const showBenchmarkLine = Boolean(style.showBenchmarkLine && benchmarkValue !== null);
  const benchmarkColor = style.benchmarkColor || '#dc2626';
  const benchmarkDash = style.benchmarkLineStyle === 'solid' ? undefined : '6 4';
  const benchmarkLabel = style.benchmarkLabel?.trim() || undefined;

  const yDomain: [any, any] = [
    style.yAxisMin !== '' && style.yAxisMin != null ? Number(style.yAxisMin) : 'auto',
    style.yAxisMax !== '' && style.yAxisMax != null ? Number(style.yAxisMax) : 'auto',
  ];
  // When the DA sets an explicit Y min/max, Recharts needs allowDataOverflow
  // to HARD-clamp the band (otherwise a Y Max below the data is silently
  // ignored and bars/lines overflow — "Y Max does nothing"). Only clamp when a
  // bound is actually set so auto-scaling is unaffected.
  const yAxisClamp = (style.yAxisMin !== '' && style.yAxisMin != null)
    || (style.yAxisMax !== '' && style.yAxisMax != null);

  // BI-standard (Power BI / Tableau): a cartesian chart labels its axes by
  // default so you can see WHICH dimension it's grouped by — not blank axes.
  // Derive the dimension label (X for vertical, category-axis for HBAR) and
  // the metric label (Y for vertical, value-axis for HBAR). User-entered
  // xAxisLabel/yAxisLabel always win. Only auto-name the metric axis when a
  // single metric is plotted (multi-metric → legend disambiguates, so a
  // single Y title would be misleading).
  const derivedDimLabel = fieldLabel(xField, labelMap);
  const derivedMetricLabel = metrics.length === 1 ? metricLabel(metrics[0], labelMap) : undefined;
  const xAxisLabel = style.xAxisLabel || derivedDimLabel || undefined;
  const yAxisLabel = style.yAxisLabel || derivedMetricLabel || undefined;
  // HBAR swaps orientation: category on Y, value on X.
  const hbarXAxisLabel = style.xAxisLabel || derivedMetricLabel || undefined;
  const hbarYAxisLabel = style.yAxisLabel || derivedDimLabel || undefined;

  // Phase-16.x — effective per-column formats for tables: the semantic
  // formatMap (measure.format.kind) overlaid with the user's per-column choice
  // from the Table config (style.tableColumnFormats wins). Lets DA format a %
  // or currency column at chart-build time without editing the dataset.
  const effectiveColumnFormats = useMemo(() => {
    const overrides = style.tableColumnFormats;
    if (!formatMap && !overrides) return undefined;
    const merged = new Map<string, NumberFormat>(formatMap ?? []);
    if (overrides) {
      for (const [key, fmt] of Object.entries(overrides)) {
        if (fmt) merged.set(key, fmt);
      }
    }
    return merged.size > 0 ? merged : undefined;
  }, [formatMap, style.tableColumnFormats]);

  const ChartTitleEl = chartTitle ? (
    <div className="text-center font-semibold text-text-secondary mb-1" style={{ fontSize: chartTitleFontSize }}>{chartTitle}</div>
  ) : null;

  // BUG-009 fix — single source of truth for "is the X axis a date axis".
  // Previously only LINE/AREA computed this locally, so BAR / STACKED_BAR /
  // COMBO rendered a Date axis as raw ISO ("2026-01-01T00:00:00") while LINE
  // showed "1/1/2026". Computing it once here (from sortedCategoricalData,
  // which is what LINE/AREA already sampled) and feeding it to every branch's
  // renderXAxis keeps the time axis format identical across all chart types
  // and stops new branches from silently drifting again.
  const xAxisIsDateLike = isDateLikeAxis(sortedCategoricalData, xField, xAxisLabel || normalizedRoleConfig.timeField);

  const renderXAxis = (dataKey: string, count: number = categoricalData.length, dateLike = false) => {
    // #1 fix — measure the longest rendered label so the axis rotates for long
    // string labels, not only for high category counts.
    const labelSample = (categoricalData.length ? categoricalData : data).slice(0, 80);
    const maxLabelChars = labelSample.reduce((m, r) => {
      const v = r?.[dataKey];
      const s = dateLike ? formatDateAxisValue(v) : (v == null || v === '' ? '(blank)' : String(v));
      return Math.max(m, s.length);
    }, 0);
    const { angle, height, textAnchor, interval, labelOffset } = buildXAxisProps(count, fontSize, xAxisLabel, maxLabelChars);
    return (
      <XAxis
        dataKey={dataKey}
        tick={(
          <CustomAxisTick
            angle={angle}
            textAnchor={textAnchor}
            fontSize={fontSize}
            formatter={dateLike ? formatDateAxisValue : undefined}
            orientation="x"
            fill={axisTickFill}
          />
        ) as any}
        height={height}
        interval={interval}
        label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: labelOffset, fontSize } : undefined}
      />
    );
  };
  const renderYAxis = () => {
    // Phase-16.x — when the chart plots a SINGLE metric, format the value axis
    // with THAT metric's resolved format (incl. the measure's % / currency via
    // the merged seriesFormats above) so the axis matches the data labels. With
    // multiple metrics the axis can't pick one format, so it keeps the global.
    const axisSeriesKey = metrics.length === 1 ? metricKey(metrics[0]) : undefined;
    const axisTickFormatter = (value: any) => formatNumber(value, style, axisSeriesKey);
    return (
    <YAxis tick={{ fontSize, fill: axisTickFill }} tickFormatter={axisTickFormatter} domain={yDomain} allowDataOverflow={yAxisClamp}
      label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft', fontSize, dx: -10 } : undefined} />
    );
  };
  // Phase-15.82 — per-series color override handlers. Writes to
  // style.seriesColors so the chart re-renders with the new palette.
  const handleSeriesColorChange = useCallback((key: string, color: string) => {
    if (!onStyleConfigChange) return;
    onStyleConfigChange({
      ...style,
      seriesColors: { ...(style.seriesColors ?? {}), [key]: color },
    });
  }, [onStyleConfigChange, style]);
  const handleSeriesColorReset = useCallback((key: string) => {
    if (!onStyleConfigChange) return;
    const next = { ...(style.seriesColors ?? {}) };
    delete next[key];
    onStyleConfigChange({ ...style, seriesColors: next });
  }, [onStyleConfigChange, style]);
  const legendLayout: 'horizontal' | 'vertical' = legendPos === 'left' || legendPos === 'right' ? 'vertical' : 'horizontal';
  const renderLegend = () => showLegend ? (
    <Legend
      // Phase-16.x — separate the legend's area from the plot so they never
      // collide. A BOTTOM legend sits flush at the container edge (below the
      // plot margin); on prod the CSP-blocked web font falls back to taller
      // glyphs whose descenders (g/p/y in "MQL", "Won/Lead"…) got clipped by
      // the card edge. A TOP legend sat flush against the plot top, so the
      // top axis tick label ("600" / "1.6K" on a dual-axis combo) overlapped
      // it (measured ~8px). Vertical padding makes Recharts reserve a taller
      // legend band, giving a clear gap between the legend text and the plot /
      // card edge. Side legends are unaffected.
      wrapperStyle={{
        fontSize,
        cursor: 'pointer',
        ...(legendPos === 'bottom' ? { paddingTop: 4, paddingBottom: 8, lineHeight: 1.4 } : {}),
        ...(legendPos === 'top' ? { paddingBottom: 18, lineHeight: 1.4 } : {}),
      }}
      verticalAlign={legendPos === 'left' || legendPos === 'right' ? 'middle' : legendPos as any}
      align={legendPos === 'left' || legendPos === 'right' ? legendPos as any : 'center'}
      layout={legendLayout}
      // Phase-15.82 — custom legend exposes per-series color picker
      // (Radix popover) + click-to-toggle visibility. handleLegendClick
      // is now unused for the popover path but kept for series visibility
      // when the popover is dismissed via the label click.
      content={(props: any) => (
        <CustomLegend
          payload={props?.payload ?? []}
          hiddenSeries={hiddenSeries}
          seriesColors={style.seriesColors}
          fontSize={fontSize}
          layout={legendLayout}
          onToggle={toggleSeriesHidden}
          onColorChange={onStyleConfigChange ? handleSeriesColorChange : undefined}
          onColorReset={onStyleConfigChange ? handleSeriesColorReset : undefined}
        />
      )}
    />
  ) : null;
  // Phase-15.82 — evaluate conditional color rules per cell. Mirrors the
  // table heatmap operator semantics so DA gets consistent behaviour.
  const conditionalSeriesRules = style.seriesConditionalRules ?? [];
  const resolveConditionalColor = useCallback((value: any, fallback: string): string => {
    if (conditionalSeriesRules.length === 0) return fallback;
    const num = Number(value);
    for (const rule of conditionalSeriesRules) {
      if (!rule || rule.color == null) continue;
      const ruleValueRaw = (rule as any).value;
      const ruleValue = Number(ruleValueRaw);
      let matched = false;
      const op = rule.operator as string;
      switch (op) {
        case '>': matched = num > ruleValue; break;
        case '>=': matched = num >= ruleValue; break;
        case '<': matched = num < ruleValue; break;
        case '<=': matched = num <= ruleValue; break;
        case '=':
        case '==': matched = num === ruleValue; break;
        case '!=': matched = num !== ruleValue; break;
        case 'between': {
          const lo = Number((rule as any).valueLow ?? ruleValueRaw);
          const hi = Number((rule as any).valueHigh ?? (rule as any).valueTo);
          matched = num >= lo && num <= hi;
          break;
        }
        default: matched = false;
      }
      if (matched) return rule.color;
    }
    return fallback;
  }, [conditionalSeriesRules]);

  // Phase-15.82 — render manual annotations as ReferenceLine elements.
  // Each annotation pins a label/value pair to either the X or Y axis.
  const renderAnnotations = () => {
    const annotations = style.annotations ?? [];
    if (annotations.length === 0) return null;
    return annotations.map((a) => {
      if (a.value === null || a.value === undefined || a.value === '') return null;
      const axis = a.axis ?? 'y';
      const isNumericValue = typeof a.value === 'number' || (!isNaN(Number(a.value)) && a.value !== '');
      const value = axis === 'y' && isNumericValue ? Number(a.value) : a.value;
      return (
        <ReferenceLine
          key={a.id}
          ifOverflow="extendDomain"
          stroke={a.color || '#7c3aed'}
          strokeWidth={1.5}
          strokeDasharray={(a.lineStyle ?? 'dashed') === 'dashed' ? '5 4' : undefined}
          label={a.label ? {
            value: a.label,
            position: axis === 'y' ? 'insideTopRight' : 'top',
            fill: a.color || '#7c3aed',
            fontSize: Math.max(fontSize - 1, 10),
          } : undefined}
          {...(axis === 'x' ? { x: value } : { y: value as number })}
        />
      );
    });
  };

  const renderBenchmarkLine = (axis: 'x' | 'y') => {
    if (!showBenchmarkLine || benchmarkValue === null) return null;

    return (
      <ReferenceLine
        ifOverflow="extendDomain"
        stroke={benchmarkColor}
        strokeWidth={2}
        strokeDasharray={benchmarkDash}
        label={benchmarkLabel
          ? {
              value: benchmarkLabel,
              position: 'insideTopRight',
              fill: benchmarkColor,
              fontSize: Math.max(fontSize - 1, 10),
            }
          : undefined}
        {...(axis === 'x' ? { x: benchmarkValue } : { y: benchmarkValue })}
      />
    );
  };

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ KPI ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  const emitSelection = (field: string | undefined, value: unknown) => {
    if (!onSelectDataPoint || !field || value === undefined || value === null || value === '') return;
    onSelectDataPoint({ field, value });
  };
  const handleCategoricalChartClick = (event: any) => {
    const payload = event?.activePayload?.[0]?.payload;
    const value = xField ? payload?.[xField] ?? event?.activeLabel : undefined;
    emitSelection(xField, value);
  };
  const handlePieClick = (entry: any) => {
    emitSelection(dimension, entry?.name);
  };
  const handleScatterClick = (event: any) => {
    const payload = event?.payload ?? event?.activePayload?.[0]?.payload;
    emitSelection(dimension, payload?.label);
  };

  if (type === 'KPI') {
    if (!kpiMetric || kpiValue === undefined) return <EmptyState message="Select a value column to render this card." />;
    const cardLabel = style.kpiLabel?.trim() || metricLabel(kpiMetric, labelMap);
    const benchmarkValue = kpiBenchmarkValue ?? (
      style.kpiBenchmarkValue === '' || style.kpiBenchmarkValue == null
        ? null
        : Number(style.kpiBenchmarkValue)
    );
    // Phase-15.86 — KPI per-metric format precedence. If the user set a
    // per-series format on the KPI's metric, pass that into KpiCard
    // instead of the global numberFormat. Lets a $-format KPI sit next
    // to a %-format KPI on the same dashboard without forcing them to
    // share the global setting.
    //
    // Phase-15.93 v4 — semantic measure format takes priority OVER the
    // default 'compact' Number Format, but yields to any non-default
    // chart-wide choice and to per-series overrides.
    //
    // Precedence (first match wins):
    //   1. seriesFormats[metricKey]      per-series UI override
    //   2. style.numberFormat (if NOT 'compact')   user picked non-default chart-wide
    //   3. formatMap[field]              declared on the semantic Measure
    //   4. style.numberFormat            (= 'compact' default, terminal fallback)
    //
    // Why this detection model: DEFAULT_STYLE_CONFIG.numberFormat seeds
    // every chart with 'compact', and the editor's setState pipeline
    // re-normalizes on every load — so even a chart whose user NEVER
    // touched Number Format reports `style.numberFormat = 'compact'`.
    // There's no clean "is this user-set?" signal in the FE state. The
    // pragmatic heuristic: treat 'compact' as "default / no opinion"
    // and let the semantic Measure format outvote it. If a DA explicitly
    // wants 'compact' they can flip via per-series Format (per-metric
    // override always wins).
    //
    // Verified locally on chart 343 (count_distinct measure with
    // format.kind='percent', value=59) — renders "5900.0%" out of
    // the box, no styleConfig changes required.
    const kpiMetricKey = metricKey(kpiMetric);
    const chartWideFormatIfSet = style.numberFormat && style.numberFormat !== 'compact'
      ? style.numberFormat
      : undefined;
    // DataLabel-level format (set via the simplified "Value format" disclosure
    // for KPI/GAUGE/BULLET/PODIUM) wins over every other layer — it's the
    // explicit display-units pick for THIS card. Falls through the existing
    // precedence (per-series → chart-wide → semantic measure → default) when
    // unset.
    const dlc = style.dataLabelConfig;
    const dataLabelFormat = dlc?.overrides?.[kpiMetricKey]?.format ?? dlc?.format;
    const kpiFormat = dataLabelFormat
      ?? style.seriesFormats?.[kpiMetricKey]
      ?? chartWideFormatIfSet
      ?? formatMap?.get(kpiMetric.field)
      ?? style.numberFormat
      ?? 'compact';
    const kpiDecimals = style.seriesDecimalPlaces?.[kpiMetricKey] ?? style.decimalPlaces;
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className={`flex-1 flex ${embedded ? 'items-stretch' : 'items-center justify-center'}`}>
          <div className={embedded ? 'w-full h-full' : 'w-full max-w-xl'}>
            <KpiCard
              value={kpiValue}
              label={cardLabel}
              format={kpiFormat}
              decimalPlaces={kpiDecimals}
              currencySymbol={style.currencySymbol}
              contextTemplate={style.kpiContextTemplate}
              benchmarkValue={benchmarkValue}
              benchmarkLabel={style.kpiBenchmarkLabel}
              showBenchmarkValue={style.kpiShowBenchmarkValue}
              showDelta={style.kpiShowDelta}
              goalDirection={style.kpiGoalDirection}
              accentColor={style.kpiAccentColor}
              enableColorRules={style.kpiEnableColorRules}
              colorRules={style.kpiColorRules}
              rowCount={data.length}
              iconName={style.kpiIconName}
              iconColor={style.kpiIconColor}
              accentBorder={style.kpiAccentBorder}
              gradientBg={style.kpiGradientBg}
              valueFontSize={kpiValueFontSize}
              hideLabel={kpiLabelInHeader}
              embedded={embedded}
            />
          </div>
        </div>
      </div>
    );
  }

  if (type === 'PODIUM') {
    // Read the adapter's rewritten rows (values remapped to metricKey) — NOT
    // the raw `data` whose value sits under the BE's qualified ref. Falls
    // back to raw data only if the adapter produced no categorical rows.
    const podiumRows = categoricalData.length ? categoricalData : data;
    const nameField = style.podiumNameField || dimension || (podiumRows[0] && Object.keys(podiumRows[0]).find((k) => typeof podiumRows[0][k] === 'string'));
    // Prefer the adapter-resolved series key (already matches the rewritten
    // rows). metricKey(metrics[0]) is the same key post-rewrite; the
    // first-numeric-key scan is the last-ditch fallback for ad-hoc rows.
    const valueField = style.podiumValueField
      || categoricalSeries[0]?.key
      || (metrics[0] ? metricKey(metrics[0]) : undefined)
      || (podiumRows[0] && Object.keys(podiumRows[0]).find((k) => typeof podiumRows[0][k] === 'number'));
    if (!nameField || !valueField) {
      return <EmptyState message="Select a name dimension and a value metric to render the podium." />;
    }
    const top = Math.min(Math.max(style.podiumTop ?? 3, 1), 5);
    // Phase-15.86 — chartSortRules used to be ignored (hardcoded desc by
    // valueField). Now: if the user set a sort rule, use the already-
    // sorted sortedCategoricalData order (which applySortRules + dataLimit
    // both ran on). Otherwise fall back to the legacy "highest value
    // first" so unconfigured podiums still rank correctly.
    const sortedSource = sortRules.length > 0 ? sortedCategoricalData : [...podiumRows].sort((a, b) =>
      Number(b?.[valueField] ?? 0) - Number(a?.[valueField] ?? 0),
    );
    const ranked = sortedSource.slice(0, top);
    const colors = [
      style.podiumGoldColor || '#fbbf24',
      style.podiumSilverColor || '#cbd5e1',
      style.podiumBronzeColor || '#d97706',
      '#64748b',
      '#475569',
    ];
    const labels = ['Winner', 'Runner-up', 'Rank 3', 'Rank 4', 'Rank 5'];
    const display = ranked.length >= 3 ? [ranked[1], ranked[0], ranked[2], ...ranked.slice(3)] : ranked;
    // Phase-15.86 — per-metric format precedence (override > seriesFormats >
    // global). Lets DA show podium values as currency on one chart and
    // percent on another within the same dashboard.
    // DataLabel "Value format" pick wins when set — Podium reuses the same
    // simplified disclosure as KPI/GAUGE/BULLET.
    const podiumDlc = style.dataLabelConfig;
    const podiumDataLabelFormat = podiumDlc?.overrides?.[valueField]?.format ?? podiumDlc?.format;
    const podiumFmt = podiumDataLabelFormat
      ?? style.seriesFormats?.[valueField]
      ?? style.numberFormat;
    const podiumStyle = podiumFmt ? { ...style, numberFormat: podiumFmt } : style;
    const fmt = (v: any) => formatNumber(Number(v) || 0, podiumStyle, valueField);
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 flex items-end justify-center gap-4 px-4">
          {display.map((e: any, i: number) => {
            const rank = ranked.indexOf(e);
            // Phase-15.86 — allow per-name seriesColors override to beat
            // the gold/silver/bronze default. Lets DA brand a specific
            // entrant (eg. a partner name) with their own colour.
            const name = String(e?.[nameField] ?? '');
            const color = style.seriesColors?.[name] ?? colors[rank] ?? colors[colors.length - 1];
            const isFirst = rank === 0;
            return (
              <div
                key={i}
                className="flex flex-col items-center rounded-2xl border p-4"
                style={{
                  borderColor: color,
                  borderWidth: isFirst ? 2 : 1,
                  minWidth: 140,
                  transform: isFirst ? 'scale(1.05)' : undefined,
                  background: `linear-gradient(180deg, ${color}10, transparent 70%)`,
                }}
              >
                <div className="text-[10px] font-bold uppercase tracking-[0.2em]" style={{ color }}>
                  {labels[rank] || `Rank ${rank + 1}`}
                </div>
                <div className="mt-2 text-sm font-semibold text-text-primary text-center break-words">
                  {String(e?.[nameField] ?? '--')}
                </div>
                <div className="mt-1 text-2xl font-semibold tabular-nums" style={{ color }}>
                  {fmt(e?.[valueField])}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ PIE ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  if (type === 'PIE') {
    const m = metrics[0];
    if (!dimension || !m) return <EmptyState message="Select legend and value columns to render this chart." />;
    const sortedPieData = applyDataLimit(applySortRules(pieData, sortRules), dataLimit, dataLimitDir);
    // Phase-15.86 — PIE label fully honours DataLabelConfig (fontSize,
    // fontColor, background, template) via a custom <text>+<rect>
    // renderer. Previously Recharts `label` prop took a string only, so
    // colour/size from the editor went nowhere. Position/rotation
    // stay N/A for radial layout (Pie picks the angle).
    const renderPieLabel = (entry: any) => {
      const { name, value, percent, x, y, cx, cy, midAngle } = entry;
      // Skip slices below 3% — match Recharts default to keep small
      // slice labels from overlapping near the centre.
      if (percent === undefined || percent <= 0.03) return null;
      // Phase-B3 — guard non-finite anchors (degenerate slice geometry).
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const sliceKey = String(name);
      const resolved = resolveDataLabelStyle(style, sliceKey);
      // When master switch is off we still surface a compact "Name (X%)"
      // string so the legend retention behaviour matches the rest of the
      // app. Hidden entirely only when both `enabled` and percent are off.
      if (!resolved) {
        // Render a soft "Name (X%)" so the chart still has a visual
        // identifier — matches the old behaviour pre-15.84.
        return (
          <text x={x} y={y}
            fill="rgb(var(--text-secondary))"
            fontSize={11}
            textAnchor={x > cx ? 'start' : 'end'}
            dominantBaseline="central"
          >
            {`${name} (${(percent * 100).toFixed(0)}%)`}
          </text>
        );
      }
      // Resolved → build text (template-aware) then render with full
      // DataLabel styling. seriesFormats is included in the precedence
      // via the formatter call below (mirrors buildDataLabelContent
      // precedence: override.format > seriesFormats > dlc.format > global).
      const effectiveFormat = resolved.format ?? style.seriesFormats?.[sliceKey] ?? style.numberFormat;
      const styleForLabel = effectiveFormat ? { ...style, numberFormat: effectiveFormat } : style;
      const text = style.dataLabelTemplate
        ? renderTemplatedLabel({
            template: style.dataLabelTemplate,
            value,
            seriesKey: sliceKey,
            seriesLabel: sliceKey,
            dimensionValue: sliceKey,
            percent,
            style: styleForLabel,
          })
        : `${name}: ${formatNumber(value, styleForLabel, sliceKey)} (${(percent * 100).toFixed(0)}%)`;
      const approxWidth = text.length * resolved.fontSize * 0.6;
      const approxHeight = resolved.fontSize + 4;
      const anchor: 'start' | 'end' = x > cx ? 'start' : 'end';
      const bgX = anchor === 'start' ? x - 3 : x - approxWidth - 3;
      return (
        <g>
          {resolved.background && (
            <rect
              x={bgX}
              y={y - approxHeight / 2}
              width={approxWidth + 6}
              height={approxHeight}
              rx={2}
              fill={resolved.backgroundColor}
            />
          )}
          <text
            x={x}
            y={y}
            fill={resolved.fontColor}
            fontSize={resolved.fontSize}
            textAnchor={anchor}
            dominantBaseline="central"
          >
            {text}
          </text>
        </g>
      );
    };
    // Synthesize a series list so CustomTooltip can show the dimension
    // value + metric label correctly even though PIE only has one metric.
    const pieSeriesForTooltip: ChartSeriesDef[] = [{
      key: 'value',
      label: metricLabel(m, labelMap),
      metric: m,
    }];
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie isAnimationActive={animate} data={sortedPieData} dataKey="value" nameKey="name"
                cx="50%" cy="45%" outerRadius="60%"
                // Hole % is relative to the 60% outer radius — NOT the
                // container — so it can never exceed the outer radius and blank
                // the donut (the old `${pieInnerRadius}%` was container-relative,
                // so an 80% hole = 80% container > 60% outer → empty ring).
                innerRadius={pieInnerRadius > 0 ? `${(pieInnerRadius / 100) * 60}%` : undefined}
                onClick={handlePieClick}
                label={renderPieLabel}
                labelLine={showDataLabels}
              >
                {sortedPieData.map((row: any, i) => (
                  <Cell key={i} fill={getSeriesColor(String(row?.name ?? i), i)} />
                ))}
              </Pie>
              {/* Phase-15.86 — CustomTooltip on PIE so `tooltipExtraFields`
                  surfaces the row's other columns (eg. region, segment)
                  next to the slice value. Previously bare Recharts
                  Tooltip ignored that style field. */}
              <Tooltip
                content={(p: any) => (
                  <CustomTooltip
                    {...p}
                    series={pieSeriesForTooltip}
                    style={style}
                    fontSize={fontSize}
                  />
                )}
              />
              {renderLegend()}
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ SCATTER ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  if (type === 'SCATTER') {
    if (!scatterX || !scatterY) return <EmptyState message="Select X Axis and Y Axis columns to render this chart." />;
    // Phase-15.86 — SCATTER bring-up to feature parity. Previously the
    // renderer ignored almost every Phase-15.82+ style field. Now:
    //   - per-point seriesColors[pointLabel] override via <Cell>
    //   - tooltip surfaces tooltipExtraFields (from the original row)
    //   - benchmark line + annotations now render
    //   - data label respects dataLabelConfig.{fontSize,fontColor,bg}
    //     when scatterLabelField is set
    //   - per-axis format reads seriesFormats[scatterX/Y] for tooltip
    const xFormatStyle = style.seriesFormats?.[scatterX]
      ? { ...style, numberFormat: style.seriesFormats[scatterX] }
      : style;
    const yFormatStyle = style.seriesFormats?.[scatterY]
      ? { ...style, numberFormat: style.seriesFormats[scatterY] }
      : style;
    const ScatterTooltip = ({ active, payload }: any) => {
      if (!active || !payload?.length) return null;
      const pt = payload[0]?.payload;
      // Look up the original row by label so tooltipExtraFields can show
      // dimensions that weren't pivoted into the scatter point shape.
      // (sortedScatterPoints is {x,y,label}; tooltipExtras live on `data`.)
      const sourceRow = dimension && pt?.label !== undefined
        ? data.find((r) => r[dimension] === pt.label)
        : undefined;
      const extras = style.tooltipExtraFields ?? [];
      return (
        <div className="bg-surface-1 border border-[rgb(var(--border-line))] rounded px-3 py-2 shadow-linear-sm" style={{ fontSize }}>
          {dimension && pt.label !== undefined && (
            <div className="font-semibold text-text-primary mb-1">{String(pt.label)}</div>
          )}
          <div className="text-text-secondary">{fieldLabel(scatterX, labelMap)}: <span className="font-medium text-text-primary">{formatNumber(pt.x, xFormatStyle, scatterX)}</span></div>
          <div className="text-text-secondary">{fieldLabel(scatterY, labelMap)}: <span className="font-medium text-text-primary">{formatNumber(pt.y, yFormatStyle, scatterY)}</span></div>
          {sourceRow && extras.length > 0 && (
            <div className="mt-1 pt-1 border-t border-[rgb(var(--border-line))]/40">
              {extras.map((field) => {
                if (field === scatterX || field === scatterY || field === dimension) return null;
                const v = sourceRow[field];
                if (v === undefined || v === null) return null;
                return (
                  <div key={field} className="text-text-tertiary text-[11px]">
                    <span className="opacity-70">{field}:</span> <span>{String(v)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    };
    // Per-point fill: scatter has one Scatter element with many points;
    // override colour per-point by mapping <Cell> children. Key is the
    // point's label (dimension value) so the Series colors editor entries
    // matching that label paint the correct dot.
    const hasPerPointColors = Boolean(style.seriesColors && Object.keys(style.seriesColors).length > 0);
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart onClick={handleScatterClick}>
              {showGrid && <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />}
              <XAxis dataKey="x" name={fieldLabel(scatterX, labelMap)} type="number" tick={{ fontSize, fill: axisTickFill }}
                label={{ value: style.xAxisLabel || fieldLabel(scatterX, labelMap), position: 'insideBottom', offset: -5, fontSize }} />
              <YAxis dataKey="y" name={fieldLabel(scatterY, labelMap)} type="number" tick={{ fontSize, fill: axisTickFill }}
                tickFormatter={yAxisTickFormatter(style)} domain={yDomain} allowDataOverflow={yAxisClamp}
                label={{ value: style.yAxisLabel || fieldLabel(scatterY, labelMap), angle: -90, position: 'insideLeft', fontSize }} />
              <ZAxis range={[40, 40]} />
              <Tooltip content={<ScatterTooltip />} cursor={{ strokeDasharray: '3 3' }} />
              {renderLegend()}
              <Scatter isAnimationActive={animate} name={`${fieldLabel(scatterX, labelMap)} vs ${fieldLabel(scatterY, labelMap)}`} data={sortedScatterPoints} fill={PALETTE[0]}>
                {hasPerPointColors && sortedScatterPoints.map((point: any, idx: number) => (
                  <Cell key={`scatter-${idx}`} fill={getSeriesColor(String(point?.label ?? idx), idx)} />
                ))}
                {scatterLabelField && (() => {
                  // Phase-15.86 — when DataLabels enabled, route through
                  // the shared dataLabelContent renderer so font/colour/bg
                  // / position / rotation work the same as BAR/LINE.
                  // Otherwise keep the legacy plain-text label.
                  const resolved = resolveDataLabelStyle(style, scatterLabelField);
                  if (resolved) {
                    return (
                      <LabelList dataKey={scatterLabelField} content={dataLabelContent(scatterLabelField, scatterLabelField, 'point')} />
                    );
                  }
                  return (
                    <LabelList dataKey={scatterLabelField} position="top" fontSize={fontSize - 1} />
                  );
                })()}
              </Scatter>
              {renderBenchmarkLine('y')}
              {renderAnnotations()}
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ TABLE ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  if (type === 'TABLE') {
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          <TableVisualization
            data={tableData}
            columns={tableColumns}
            conditionalFormatting={style.tableEnableConditionalFormatting ? style.tableConditionalFormatting : undefined}
            heatmapRules={style.tableEnableHeatmap ? style.tableHeatmapRules : undefined}
            summaryRows={style.tableSummaryRows}
            showSummaryRow={style.tableShowSummaryRow}
            summaryLabel={style.tableSummaryLabel}
            summaryLabelColumn={style.tableSummaryLabelColumn}
            columnWidths={style.tableColumnWidths}
            onColumnWidthsChange={onStyleConfigChange ? handleTableColumnWidthsChange : undefined}
            columnAlignments={style.tableColumnAlignments}
            hyperlinkRules={style.tableHyperlinkRules}
            numberFormat={tableNumberFormat}
            decimalPlaces={style.decimalPlaces}
            currencySymbol={style.currencySymbol}
            columnLabels={labelMap}
            columnFormats={effectiveColumnFormats}
          />
        </div>
      </div>
    );
  }

  if (ADVANCED_EXPLORE_CHART_TYPES.has(type)) {
    // Phase-16.x — single-value SVG charts (bubble/heatmap/gauge/funnel/…) read
    // only the chart-wide numberFormat. When the user hasn't picked one and the
    // primary measure declares a format (%/currency), use it so those charts
    // auto-format too. MATRIX is excluded — it has many columns and formats them
    // individually via columnFormats (a chart-wide % would wrongly hit all).
    const advancedStyle = (() => {
      const primary = metrics[0];
      const chartWideSet = style.numberFormat && style.numberFormat !== 'compact';
      if (type === 'MATRIX' || !primary || !effectiveColumnFormats || chartWideSet) return style;
      const fmt = effectiveColumnFormats.get(primary.field)
        ?? (primary.field.includes('.') ? effectiveColumnFormats.get(primary.field.split('.').slice(-1)[0]) : undefined);
      return fmt ? { ...style, numberFormat: fmt } : style;
    })();
    return (
      <AdvancedExploreChart
        type={type}
        data={data}
        model={model}
        style={advancedStyle}
        palette={PALETTE}
        havingFilters={havingFilters}
        preAggregated={preAggregated}
        onStyleConfigChange={onStyleConfigChange}
        onSelectDataPoint={onSelectDataPoint}
        labelMap={labelMap}
        formatMap={effectiveColumnFormats}
      />
    );
  }

  // For remaining types: need xField + at least 1 metric
  if (!xField) return <EmptyState message="Select an X Axis column to render this chart." />;
  if (metrics.length === 0) return <EmptyState message="Select at least one value column to render this chart." />;


  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ STACKED BAR ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  if (type === 'STACKED_BAR') {
    const displayData = sortedCategoricalData;
    // Phase-15.86 — include calculated fields in STACKED_BAR series list so
    // a user's "Margin %" calc shows up as an extra stack segment, matching
    // LINE/AREA behaviour. Was previously dropped here.
    const displaySeries = categoricalSeriesWithCalc;
    const isPercent = stackMode === 'percent';
    const stackTotalsByIndex = displayData.map((row: any) =>
      displaySeries.reduce((acc, s) => acc + (Number(row[s.key]) || 0), 0),
    );
    const percentYAxis = isPercent ? (
      <YAxis tick={{ fontSize, fill: axisTickFill }} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} domain={[0, 1]}
        label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft', fontSize, dx: -10 } : undefined} />
    ) : renderYAxis();
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          {DrillBar}
          {TruncationBanner}
          {wrapScrollable(
            <BarChart data={displayData} margin={CHART_BASE_MARGIN} onClick={handleCategoricalChartClick}
              stackOffset={isPercent ? 'expand' : undefined}>
              {showGrid && <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />}
              {renderXAxis(xField, displayData.length, xAxisIsDateLike)}
              {percentYAxis}
              {/* Phase-15.86 — STACKED_BAR was using a bare Tooltip
                  formatter so `tooltipExtraFields` (Phase-15.82) silently
                  no-op'd. Switched to CustomTooltip. Percent mode keeps
                  its bespoke "%" formatter by passing a transformed style. */}
              <Tooltip
                content={(p: any) => (
                  <CustomTooltip
                    {...p}
                    series={displaySeries}
                    style={style}
                    fontSize={fontSize}
                    xField={xField}
                    labelFormatter={xAxisIsDateLike ? formatDateAxisValue : undefined}
                    percentOfTotal={isPercent}
                  />
                )}
              />
              {renderLegend()}
              {(() => {
                // Phase-15.89 — STACKED_BAR has TWO label concepts:
                //
                //   - Per-segment: value text inside each bar segment
                //     (one per series per row). Position/rotation/font
                //     resolved from per-series override. User-facing
                //     setting: stackedBarLabelMode ∈ {segment,both} or
                //     isPercent==true.
                //   - Stack total: value text above the top of the stack.
                //     Single label per row, uses CHART-LEVEL DataLabelConfig
                //     (not the top-of-stack series' override — semantically
                //     it's the chart total, not "the top series").
                //     Setting: stackedBarLabelMode ∈ {total,both} when
                //     !isPercent.
                //
                // Default mode is 'total' for backward compat (legacy
                // STACKED rendered only the top-of-stack total).
                // BUG-008 — default flipped from 'total' to 'both': turning
                // Data Labels on for a stacked bar now shows the per-segment
                // values (DA's expectation) AND keeps the stack total, instead
                // of total-only. DA can still pick 'segment'/'total' in the
                // "Stack label mode" toggle (Data Labels editor).
                const stackMode = style.stackedBarLabelMode ?? 'both';
                const showSegmentLabels = showDataLabels && (
                  isPercent || stackMode === 'segment' || stackMode === 'both'
                );
                const showTotalLabels = showDataLabels && !isPercent && (
                  stackMode === 'total' || stackMode === 'both'
                );
                // Phase-15.90 — total label uses its own resolver with
                // dedicated `totalStyle` fields. Independent of segment
                // colour so the two never need to share a single
                // fontColor setting (DA-reported conflict: black text
                // looks right on the chart bg for total but disappears
                // on a dark bar segment).
                const totalDL = showTotalLabels
                  ? resolveTotalLabelStyle(style)
                  : null;
                return displaySeries.map((series, i) => {
                  const isTopOfStack = i === displaySeries.length - 1;
                  const barFill = getSeriesColor(series.key, i);
                  // Phase-15.91 — pass barFill so the resolver can pick a
                  // contrasting default label colour (black on light bars,
                  // white on dark) when the user hasn't set fontColor
                  // explicitly. Fixes DA "label text invisible on red".
                  const segDL = showSegmentLabels
                    ? resolveSegmentLabelStyle(style, series.key, barFill)
                    : null;
                  return (
                    <Bar isAnimationActive={animate} key={series.key} dataKey={series.key} stackId="s" fill={barFill}
                      name={series.label}
                      hide={hiddenSeries.has(series.key)}
                      barSize={barSize}
                      radius={isTopOfStack ? [barRadius, barRadius, 0, 0] : undefined}>
                      {/* Per-segment % label (percent mode) */}
                      {segDL && isPercent && (
                        <LabelList
                          dataKey={series.key}
                          content={(props: any) => {
                            const { x, y, width, height, value, index } = props;
                            const total = stackTotalsByIndex[index] || 0;
                            if (!total) return null;
                            const pct = (Number(value) / total) * 100;
                            if (pct < 4) return null;
                            // Position relative to segment (top/center/bottom).
                            const pos = segDL.position;
                            const cx = x + width / 2;
                            const cy = pos === 'top' || pos === 'insideTop'
                              ? y + segDL.fontSize - 1
                              : pos === 'bottom' || pos === 'insideBottom'
                                ? y + height - 4
                                : y + height / 2; // inside/center default
                            const text = `${pct.toFixed(0)}%`;
                            const approxW = text.length * segDL.fontSize * 0.6;
                            const rotate = segDL.rotation !== 0
                              ? `rotate(${segDL.rotation} ${cx} ${cy})`
                              : undefined;
                            return (
                              <g transform={rotate}>
                                {segDL.background && (
                                  <rect x={cx - approxW / 2 - 3} y={cy - segDL.fontSize / 2 - 1}
                                        width={approxW + 6} height={segDL.fontSize + 2}
                                        rx={2} ry={2} fill={segDL.backgroundColor} />
                                )}
                                <text x={cx} y={cy}
                                  textAnchor="middle" dominantBaseline="middle"
                                  fill={segDL.fontColor}
                                  fontSize={segDL.fontSize}
                                  style={{ pointerEvents: 'none' }}>
                                  {text}
                                </text>
                              </g>
                            );
                          }}
                        />
                      )}
                      {/* Per-segment value label (normal mode segment/both) */}
                      {segDL && !isPercent && (stackMode === 'segment' || stackMode === 'both') && (
                        <LabelList
                          dataKey={series.key}
                          content={(props: any) => {
                            const { x, y, width, height, value, payload } = props;
                            if (value == null || value === 0) return null;
                            // Skip when segment too narrow to fit text.
                            if (height < segDL.fontSize + 2) return null;
                            const pos = segDL.position;
                            const cx = x + width / 2;
                            const cy = pos === 'top' || pos === 'insideTop'
                              ? y + segDL.fontSize
                              : pos === 'bottom' || pos === 'insideBottom'
                                ? y + height - 4
                                : y + height / 2; // inside/center default
                            const fmt = segDL.format
                              ?? style.seriesFormats?.[series.key]
                              ?? style.numberFormat;
                            const sf = fmt ? { ...style, numberFormat: fmt } : style;
                            const text = style.dataLabelTemplate
                              ? renderTemplatedLabel({
                                  template: style.dataLabelTemplate,
                                  value,
                                  seriesKey: series.key,
                                  seriesLabel: series.label,
                                  dimensionValue: payload?.[xField ?? ''],
                                  style: sf,
                                })
                              : formatNumber(value, sf, series.key);
                            const approxW = text.length * segDL.fontSize * 0.6;
                            const rotate = segDL.rotation !== 0
                              ? `rotate(${segDL.rotation} ${cx} ${cy})`
                              : undefined;
                            return (
                              <g transform={rotate}>
                                {segDL.background && (
                                  <rect x={cx - approxW / 2 - 3} y={cy - segDL.fontSize / 2 - 1}
                                        width={approxW + 6} height={segDL.fontSize + 2}
                                        rx={2} ry={2} fill={segDL.backgroundColor} />
                                )}
                                <text x={cx} y={cy}
                                  textAnchor="middle" dominantBaseline="middle"
                                  fill={segDL.fontColor}
                                  fontSize={segDL.fontSize}
                                  style={{ pointerEvents: 'none' }}>
                                  {text}
                                </text>
                              </g>
                            );
                          }}
                        />
                      )}
                      {/* Stack total label — only emit on the top-of-stack
                          series so it renders ONCE per row. Uses chart-
                          level DL config (totalDL), not series override. */}
                      {totalDL && isTopOfStack && (
                        <LabelList
                          dataKey={series.key}
                          content={(props: any) => {
                            const { x, y, width, index, payload } = props;
                            const total = stackTotalsByIndex[index] || 0;
                            if (!total) return null;
                            const cx = x + width / 2;
                            const cy = Math.max(12, y - 6);
                            const fmt = totalDL.format ?? style.numberFormat;
                            const sf = fmt ? { ...style, numberFormat: fmt } : style;
                            const text = style.dataLabelTemplate
                              ? renderTemplatedLabel({
                                  template: style.dataLabelTemplate,
                                  value: total,
                                  seriesKey: 'stack-total',
                                  seriesLabel: 'Total',
                                  dimensionValue: payload?.[xField ?? ''],
                                  style: sf,
                                })
                              : formatNumber(total, sf);
                            const approxW = text.length * totalDL.fontSize * 0.6;
                            // Phase-15.90 — total resolver now defaults
                            // directly to text-secondary; no sentinel
                            // remapping needed.
                            const totalColor = totalDL.fontColor;
                            const rotate = totalDL.rotation !== 0
                              ? `rotate(${totalDL.rotation} ${cx} ${cy})`
                              : undefined;
                            return (
                              <g transform={rotate}>
                                {totalDL.background && (
                                  <rect x={cx - approxW / 2 - 3} y={cy - totalDL.fontSize}
                                        width={approxW + 6} height={totalDL.fontSize + 4}
                                        rx={2} ry={2} fill={totalDL.backgroundColor} />
                                )}
                                <text x={cx} y={cy}
                                  textAnchor="middle"
                                  fill={totalColor} fontSize={totalDL.fontSize}
                                  style={{ pointerEvents: 'none' }}>
                                  {text}
                                </text>
                              </g>
                            );
                          }}
                        />
                      )}
                    </Bar>
                  );
                });
              })()}
              {renderBenchmarkLine('y')}
              {renderAnnotations()}
            </BarChart>,
            displayData.length,
          )}
        </div>
      </div>
    );
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ AREA ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  if (type === 'AREA') {
    const dateLikeXAxis = xAxisIsDateLike;
    const displayData = sortRowsByDateAxis(sortedCategoricalData, xField, dateLikeXAxis && sortRules.length === 0);
    const displaySeries = categoricalSeriesWithCalc;
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          {DrillBar}
          {TruncationBanner}
          {wrapScrollable(
            <AreaChart data={displayData} margin={CHART_BASE_MARGIN} onClick={handleCategoricalChartClick}>
              {showGrid && <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />}
              {renderXAxis(xField, displayData.length, dateLikeXAxis)}
              {renderYAxis()}
              <Tooltip
                content={(p: any) => (
                  <CustomTooltip {...p} series={displaySeries} style={style} fontSize={fontSize} xField={xField} labelFormatter={dateLikeXAxis ? formatDateAxisValue : undefined} />
                )}
              />
              {renderLegend()}
              {displaySeries.map((series, i) => {
                return (
                  <Area isAnimationActive={animate} key={series.key} type="monotone" dataKey={series.key}
                    name={series.label}
                    hide={hiddenSeries.has(series.key)}
                    stroke={getSeriesColor(series.key, i)}
                    fill={getSeriesColor(series.key, i)}
                    fillOpacity={areaOpacity} strokeWidth={lineWidth}
                    dot={dotsForCount(displayData.length)}
                    strokeDasharray={lineDash}>
                    {showDataLabels && (
                      // Phase-15.84 bugfix — AREA chart was missing its
                      // LabelList entirely; toggling DataLabels did
                      // nothing for area-renders. 'point' orientation
                      // because Recharts passes data-point coordinates
                      // (cx,cy) rather than rectangle bounds for Area.
                      <LabelList dataKey={series.key} content={dataLabelContent(series.key, series.label, 'point')} />
                    )}
                  </Area>
                );
              })}
              {renderBenchmarkLine('y')}
              {renderAnnotations()}
            </AreaChart>,
            displayData.length,
          )}
        </div>
      </div>
    );
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ LINE / TIME_SERIES ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  if (type === 'LINE' || type === 'TIME_SERIES') {
    const dateLikeXAxis = type === 'TIME_SERIES' || xAxisIsDateLike;
    const displayData = sortRowsByDateAxis(timeSeriesData, xField, dateLikeXAxis && sortRules.length === 0);
    // Phase-15.82 — include calculated fields so they render as extra lines.
    const displaySeries = categoricalSeriesWithCalc;
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          {DrillBar}
          {TruncationBanner}
          {wrapScrollable(
            <LineChart data={displayData} margin={CHART_BASE_MARGIN} onClick={handleCategoricalChartClick}>
              {showGrid && <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />}
              {renderXAxis(xField, displayData.length, dateLikeXAxis)}
              {renderYAxis()}
              <Tooltip
                content={(p: any) => (
                  <CustomTooltip {...p} series={displaySeries} style={style} fontSize={fontSize} xField={xField} labelFormatter={dateLikeXAxis ? formatDateAxisValue : undefined} />
                )}
              />
              {renderLegend()}
              {displaySeries.map((series, i) => {
                return (
                  <Line isAnimationActive={animate} key={series.key} type="monotone" dataKey={series.key}
                    name={series.label}
                    hide={hiddenSeries.has(series.key)}
                    stroke={getSeriesColor(series.key, i)}
                    strokeWidth={lineWidth}
                    dot={dotsForCount(displayData.length)}
                    strokeDasharray={lineDash}>
                    {showDataLabels && (
                      <LabelList dataKey={series.key} content={dataLabelContent(series.key, series.label, 'point')} />
                    )}
                  </Line>
                );
              })}
              {renderBenchmarkLine('y')}
              {renderAnnotations()}
            </LineChart>,
            displayData.length,
          )}
        </div>
      </div>
    );
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ HORIZONTAL BAR ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  if (type === 'HORIZONTAL_BAR') {
    const displayData = sortedCategoricalData;
    // Phase-15.86 — include calc fields so they render as extra bars.
    const displaySeries = categoricalSeriesWithCalc;
    const hasConditional = conditionalSeriesRules.length > 0;
    const MIN_ROW_HEIGHT = 32; // px per row for horizontal bars
    const chartHeight = displayData.length > SCROLL_THRESHOLD
      ? Math.max(displayData.length * MIN_ROW_HEIGHT, 400)
      : undefined; // let ResponsiveContainer fill parent
    const innerChart = (
      <BarChart data={displayData} layout="vertical" margin={CHART_BASE_MARGIN} onClick={handleCategoricalChartClick}>
        {showGrid && <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />}
        {/* Phase-15.22: category labels on horizontal bar live on YAxis.
            Same interval=0 + truncate-with-tooltip treatment as XAxis on
            other types. width=160 (up from 120) gives room for typical
            customer/region names. */}
        <YAxis
          dataKey={xField}
          type="category"
          tick={(
            <CustomAxisTick
              angle={0}
              textAnchor="end"
              fontSize={fontSize}
              orientation="y"
              fill={axisTickFill}
            />
          ) as any}
          interval={0}
          width={160}
          label={hbarYAxisLabel ? { value: hbarYAxisLabel, angle: -90, position: 'insideLeft', fontSize, dx: -10 } : undefined} />
        <XAxis type="number" tick={{ fontSize, fill: axisTickFill }} tickFormatter={yAxisTickFormatter(style)} domain={yDomain} allowDataOverflow={yAxisClamp}
          label={hbarXAxisLabel ? { value: hbarXAxisLabel, position: 'insideBottom', offset: -5, fontSize } : undefined} />
        <Tooltip
          content={(p: any) => (
            <CustomTooltip {...p} series={displaySeries} style={style} fontSize={fontSize} xField={xField} labelFormatter={xAxisIsDateLike ? formatDateAxisValue : undefined} />
          )}
        />
        {renderLegend()}
        {displaySeries.map((series, i) => {
          const baseColor = getSeriesColor(series.key, i);
          return (
            <Bar isAnimationActive={animate} key={series.key} dataKey={series.key}
              name={series.label}
              hide={hiddenSeries.has(series.key)}
              fill={baseColor}
              barSize={barSize}
              radius={[0, barRadius, barRadius, 0]}>
              {/* Phase-15.86 — conditional cell colors now apply to
                  HORIZONTAL_BAR too (was vertical-only in Phase-15.82).
                  Same operator semantics as vertical BAR. */}
              {hasConditional && displayData.map((row, idx) => (
                <Cell key={`${series.key}-${idx}`} fill={resolveConditionalColor(row[series.key], baseColor)} />
              ))}
              {showDataLabels && (
                <LabelList dataKey={series.key} content={dataLabelContent(series.key, series.label, 'horizontal')} />
              )}
            </Bar>
          );
        })}
        {renderBenchmarkLine('x')}
        {renderAnnotations()}
      </BarChart>
    );
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          {DrillBar}
          {TruncationBanner}
          {displayData.length > SCROLL_THRESHOLD ? (
            <div style={{ width: '100%', height: '100%', overflowY: 'auto', overflowX: 'hidden' }}>
              <div style={{ width: '100%', height: chartHeight }}>
                <ResponsiveContainer width="100%" height="100%">
                  {innerChart}
                </ResponsiveContainer>
              </div>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              {innerChart}
            </ResponsiveContainer>
          )}
        </div>
      </div>
    );
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ BAR + LINE (Combo) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  if (type === 'BAR_LINE') {
    // Phase-15.82 — free-form mix: when style.seriesRenderAs is set, each
    // series picks its own render mode (bar/line/area). Otherwise we keep
    // the legacy "bars + 1 line metric" contract.
    const renderAsMap = style.seriesRenderAs ?? {};
    const hasFreeFormMix = Object.keys(renderAsMap).length > 0;
    // Phase-15.86 — calc fields participate in BAR_LINE too. We append
    // them to `allComboSeries` so free-form mix can target them via
    // `seriesRenderAs[calcId]`. Default to 'line' render mode if user
    // hasn't picked one (matches the LINE/AREA default for calc fields).
    const allComboSeries = [...comboBarSeries, ...comboLineSeries, ...calculatedSeries];
    if (!hasFreeFormMix && (comboBarSeries.length === 0 || comboLineSeries.length === 0)) {
      return <EmptyState message="Select bar value columns and a line value column to render this chart, or assign render types via Series mix." />;
    }
    const lineSeries = comboLineSeries[0];
    const displayData = sortedComboData;
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          {DrillBar}
          {TruncationBanner}
          {wrapScrollable(
            <ComposedChart data={displayData} margin={CHART_BASE_MARGIN} onClick={handleCategoricalChartClick}>
              {showGrid && <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />}
              {renderXAxis(xField!, displayData.length, xAxisIsDateLike)}
              {renderYAxis()}
              {dualYAxis && (
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize, fill: axisTickFill }}
                  tickFormatter={yAxisTickFormatter(style)}
                  label={yAxisRightLabel ? { value: yAxisRightLabel, angle: 90, position: 'insideRight', fontSize, dx: 15 } : undefined} />
              )}
              <Tooltip
                content={(p: any) => (
                  <CustomTooltip
                    {...p}
                    series={[...comboBarSeries, ...comboLineSeries]}
                    style={style}
                    fontSize={fontSize}
                    xField={xField}
                    labelFormatter={xAxisIsDateLike ? formatDateAxisValue : undefined}
                  />
                )}
              />
              {renderLegend()}
              {hasFreeFormMix
                ? allComboSeries.map((series, index) => {
                    const mode = renderAsMap[series.key] ?? 'bar';
                    const color = getSeriesColor(series.key, index);
                    if (mode === 'line') {
                      return (
                        <Line isAnimationActive={animate}
                          key={series.key}
                          dataKey={series.key}
                          name={series.label}
                          hide={hiddenSeries.has(series.key)}
                          type="monotone"
                          stroke={color}
                          strokeWidth={lineWidth}
                          dot={dotsForCount(displayData.length)}
                          strokeDasharray={lineDash}
                        >
                          {showDataLabels && (
                            // Phase-15.84 bugfix — free-form mix Line
                            // branch was missing LabelList → DataLabels
                            // silently no-op for line-as-series in
                            // BAR_LINE composed charts.
                            <LabelList dataKey={series.key} content={dataLabelContent(series.key, series.label, 'point')} />
                          )}
                        </Line>
                      );
                    }
                    if (mode === 'area') {
                      return (
                        <Area isAnimationActive={animate}
                          key={series.key}
                          dataKey={series.key}
                          name={series.label}
                          hide={hiddenSeries.has(series.key)}
                          type="monotone"
                          stroke={color}
                          fill={color}
                          fillOpacity={areaOpacity}
                          strokeWidth={lineWidth}
                        >
                          {showDataLabels && (
                            <LabelList dataKey={series.key} content={dataLabelContent(series.key, series.label, 'point')} />
                          )}
                        </Area>
                      );
                    }
                    return (
                      <Bar isAnimationActive={animate}
                        key={series.key}
                        dataKey={series.key}
                        name={series.label}
                        hide={hiddenSeries.has(series.key)}
                        fill={color}
                        radius={[barRadius, barRadius, 0, 0]}
                        barSize={barSize}
                      >
                        {showDataLabels && (
                          <LabelList dataKey={series.key} content={dataLabelContent(series.key, series.label, 'vertical')} />
                        )}
                      </Bar>
                    );
                  })
                : (
                  <>
                    {comboBarSeries.map((series, index) => (
                      <Bar isAnimationActive={animate} key={series.key} dataKey={series.key} name={series.label}
                        hide={hiddenSeries.has(series.key)}
                        fill={getSeriesColor(series.key, index)} radius={[barRadius, barRadius, 0, 0]}
                        barSize={barSize}>
                        {showDataLabels && (
                          <LabelList dataKey={series.key} content={dataLabelContent(series.key, series.label, 'vertical')} />
                        )}
                      </Bar>
                    ))}
                    <Line isAnimationActive={animate} dataKey={lineSeries.key} name={lineSeries.label}
                      hide={hiddenSeries.has(lineSeries.key)}
                      type="monotone" stroke={getSeriesColor(lineSeries.key, comboBarSeries.length)} strokeWidth={lineWidth}
                      dot={dotsForCount(displayData.length)}
                      strokeDasharray={lineDash}
                      yAxisId={dualYAxis ? 'right' : 0}>
                      {showDataLabels && (
                        // Phase-15.84 bugfix — legacy BAR_LINE Line element
                        // was missing LabelList: DataLabels rendered on bars
                        // but not on the lineMetric. Now both follow the
                        // same `dataLabelContent` resolver.
                        <LabelList dataKey={lineSeries.key} content={dataLabelContent(lineSeries.key, lineSeries.label, 'point')} />
                      )}
                    </Line>
                  </>
                )
              }
              {renderBenchmarkLine('y')}
              {renderAnnotations()}
            </ComposedChart>,
            displayData.length,
          )}
        </div>
      </div>
    );
  }

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ BAR / GROUPED_BAR (default) ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  const displayBarData = sortedCategoricalData;
  // Phase-15.86 — include calc fields so a user's "Margin %" calc shows
  // up as a bar alongside other metrics in BAR / GROUPED_BAR. Was
  // limited to LINE/AREA in the original Phase-15.82 rollout.
  const displayBarSeries = categoricalSeriesWithCalc;
  return (
    <div className="h-full flex flex-col">
      {ChartTitleEl}
      <div className="flex-1 min-h-0">
        {DrillBar}
        {TruncationBanner}
        {wrapScrollable(
          <BarChart data={displayBarData} margin={CHART_BASE_MARGIN} onClick={handleCategoricalChartClick}>
            {showGrid && <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />}
            {renderXAxis(xField, displayBarData.length, xAxisIsDateLike)}
            {renderYAxis()}
            <Tooltip
              content={(p: any) => (
                <CustomTooltip {...p} series={displayBarSeries} style={style} fontSize={fontSize} xField={xField} labelFormatter={xAxisIsDateLike ? formatDateAxisValue : undefined} />
              )}
            />
            {renderLegend()}
            {displayBarSeries.map((series, i) => {
              const baseColor = getSeriesColor(series.key, i);
              const hasConditional = conditionalSeriesRules.length > 0;
              return (
                <Bar isAnimationActive={animate} key={series.key} dataKey={series.key}
                  name={series.label}
                  hide={hiddenSeries.has(series.key)}
                  fill={baseColor}
                  barSize={barSize}
                  radius={[barRadius, barRadius, 0, 0]}>
                  {/* Phase-15.82 — conditional cell coloring. Each <Cell>
                      overrides the parent Bar's fill when a rule matches. */}
                  {hasConditional && displayBarData.map((row, idx) => (
                    <Cell key={`${series.key}-${idx}`} fill={resolveConditionalColor(row[series.key], baseColor)} />
                  ))}
                  {showDataLabels && (
                    <LabelList dataKey={series.key} content={dataLabelContent(series.key, series.label, 'vertical')} />
                  )}
                </Bar>
              );
            })}
            {renderBenchmarkLine('y')}
            {renderAnnotations()}
          </BarChart>,
          displayBarData.length,
        )}
      </div>
    </div>
  );
}

const ExploreChartMemo = React.memo(ExploreChartInner);

/**
 * Phase-15.82 — wrap the memoised chart in a key-bumping fade so changing
 * chart type fades out → in instead of snapping. Recharts mounts a fresh
 * component tree (BarChart vs LineChart) on type change anyway, so the
 * `key` cost is already paid; we just add a 220 ms opacity transition on
 * top. Falls back to instant render when `prefers-reduced-motion`.
 */
export function ExploreChart(props: ExploreChartProps) {
  // Bump a render token whenever `props.type` changes so the wrapper
  // remounts (CSS `animation` re-runs). Recharts is going to mount a
  // different chart component on type swap anyway — the wrapper just
  // adds a 220ms fade-up so the swap doesn't feel abrupt.
  const reduceMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return (
    <div
      key={props.type}
      style={{
        height: '100%',
        width: '100%',
        animation: reduceMotion ? undefined : 'appbiChartFadeIn 220ms ease forwards',
        opacity: reduceMotion ? 1 : undefined,
      }}
    >
      <style>{`
        @keyframes appbiChartFadeIn {
          0% { opacity: 0; transform: translateY(4px); }
          100% { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <ExploreChartMemo {...props} />
    </div>
  );
}
