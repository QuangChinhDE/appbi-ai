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
import { metricKey, metricLabel, normalizeChartStyleConfig } from './ExploreChartConfig';
import type { ChartSortRule, TimeGranularity } from '@/types/api';
import { KpiCard } from '@/components/visualizations/KpiCard';
import { TableVisualization } from '@/components/visualizations/TableVisualization';
import { applyFiltersToRows } from '@/lib/filters';
import type { BaseFilter } from '@/lib/filters';
import { getPalette, type ChartPaletteName } from '@/lib/chartColors';
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
 * Return XAxis props that adapt angle and height to the number of data
 * points. Phase-15.22 pins interval=0 so EVERY tick label renders.
 */
function buildXAxisProps(count: number, fontSize: number, xAxisLabel?: string) {
  let angle = 0;
  let height = 30;
  if (count > 60) {
    angle = -60;
    height = 100;
  } else if (count > 25) {
    angle = -45;
    height = 80;
  } else if (count > 12) {
    angle = -30;
    height = 60;
  }
  const textAnchor: 'end' | 'middle' = angle !== 0 ? 'end' : 'middle';
  return { angle, height, textAnchor, interval: 0 as const, labelOffset: angle !== 0 ? -10 : -5, xAxisLabel };
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
}

function CustomAxisTick({
  x = 0, y = 0, payload, angle, textAnchor, fontSize, formatter,
  orientation,
}: CustomAxisTickProps) {
  const raw = formatter
    ? formatter(payload?.value)
    : String(payload?.value ?? '');
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
        fill="currentColor"
        className="text-text-tertiary"
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
              <Popover.Root>
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
                      <input
                        type="color"
                        value={swatchColor.startsWith('#') ? swatchColor : '#000000'}
                        onChange={(e) => onColorChange?.(key, e.target.value)}
                        style={{ width: 30, height: 22, padding: 0, border: 'none' }}
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
 * Phase-15.84 — module-level collision registry. Recharts renders each
 * LabelList element separately, so collision detection has to coordinate
 * across all rendering passes for the same chart. We key by chart
 * instance (a fresh symbol each render) and store axis-aligned bounding
 * boxes of placed labels.
 *
 * Each chart re-render must call `resetLabelRegistry()` before its
 * passes — our renderer accepts the registry as an argument so each
 * <ExploreChartInner> render owns its own.
 */
type LabelBBox = { x: number; y: number; width: number; height: number };
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
  registry: LabelBBox[];
  orientation: 'vertical' | 'horizontal' | 'point';
}): (props: any) => React.ReactNode {
  const { resolved, seriesKey, seriesLabel, style, registry, orientation } = opts;
  if (!resolved) return () => null;
  const { position, rotation, fontSize, fontColor, background, backgroundColor, autoHideOverlap } = resolved;
  const formatLabel = (value: any, payload?: any) => {
    if (style.dataLabelTemplate) {
      return renderTemplatedLabel({
        template: style.dataLabelTemplate,
        value,
        seriesKey,
        seriesLabel,
        dimensionValue: payload ? payload[Object.keys(payload)[0]] : undefined,
        style: resolved.format ? { ...style, numberFormat: resolved.format } : style,
      });
    }
    return formatNumber(value, resolved.format ? { ...style, numberFormat: resolved.format } : style, seriesKey);
  };

  return (props: any) => {
    const { x, y, width = 0, height = 0, value, payload } = props;
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

    // Collision check (optional). Skip labels overlapping any already-
    // placed label this frame.
    const bbox: LabelBBox = {
      x: textAnchor === 'middle' ? cx - approxWidth / 2 : textAnchor === 'end' ? cx - approxWidth : cx,
      y: cy - approxHeight + 2,
      width: approxWidth,
      height: approxHeight,
    };
    if (autoHideOverlap) {
      for (const placed of registry) {
        if (rectsOverlap(placed, bbox)) return null;
      }
      registry.push(bbox);
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
}
function CustomTooltip({ active, payload, label, series, style, fontSize, xField }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload ?? {};
  const extras = style.tooltipExtraFields ?? [];
  return (
    <div
      className="bg-surface-1 border border-[rgb(var(--border-line))] rounded shadow-linear-sm"
      style={{ fontSize, padding: '8px 10px', minWidth: 140 }}
    >
      {label !== undefined && (
        <div className="font-semibold text-text-primary mb-1">{String(label)}</div>
      )}
      {payload.map((entry: any, i: number) => {
        const key = entry.dataKey ?? entry.name;
        const match = series.find((s) => s.key === key);
        const value = formatNumber(entry.value, style, key);
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

// Phase-15.83 — Top/Bottom N truncation retired. DA wants every row to
// render even on charts saved with an earlier dataLimit. The function
// signature stays so existing call sites don't need touching, but it
// now passes data through unchanged. If the "Top N best sellers" use
// case comes back as a real DA ask, we re-enable selectively rather
// than as a default cap.
function applyDataLimit(
  data: Record<string, any>[],
  _limit: number | '' | undefined,
  _direction: 'top' | 'bottom' | undefined,
): Record<string, any>[] {
  return data;
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
}: ExploreChartProps) {
  const style = useMemo(() => normalizeChartStyleConfig(_style), [_style]);
  const PALETTE = useMemo(
    () => getPalette((style.palette as ChartPaletteName) || 'default').colors,
    [style.palette],
  );
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
  const canDrill = isTimeChart && Boolean(onStyleConfigChange) && hasTimeField;
  const drillActive = Boolean(style.dateDrillLevel);
  const handleDrillChange = (level: TimeGranularity | 'raw') => {
    if (!onStyleConfigChange) return;
    onStyleConfigChange({
      ...style,
      dateDrillLevel: level === 'raw' ? undefined : level,
    });
  };
  const DrillBar = canDrill ? (
    drillActive ? (
      <div className="px-1 py-1 flex items-center gap-1 text-[10px] text-text-tertiary mb-1">
        <span className="font-semibold mr-1" title="Date drill — temporarily re-buckets the chart. Overrides the Granularity setting in the Style tab.">
          Drill (overrides Granularity):
        </span>
        {DRILL_LEVELS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => handleDrillChange(opt.value)}
            className={`px-1.5 py-0.5 rounded text-[10px] ${style.dateDrillLevel === opt.value ? 'bg-brand text-white' : 'bg-surface-2 hover:bg-surface-3'}`}
            title={opt.value}
          >
            {opt.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => handleDrillChange('raw')}
          className="ml-1 px-1.5 py-0.5 rounded bg-surface-2 hover:bg-surface-3 text-text-quaternary"
          title="Clear drill — fall back to the Style tab's Granularity"
        >
          × clear
        </button>
      </div>
    ) : (
      <div className="px-1 mb-0.5 text-[10px]">
        <button
          type="button"
          onClick={() => {
            // Seed the drill level from whatever the Style tab already has,
            // falling back to 'month' so the bar appears at a sensible
            // default rather than 'raw' (which would render identically to
            // disabled state — confusing).
            const seed = (style.timeGranularity && style.timeGranularity !== 'raw')
              ? (style.timeGranularity as TimeGranularity)
              : 'month';
            handleDrillChange(seed);
          }}
          className="text-text-quaternary hover:text-text-tertiary underline-offset-2 hover:underline"
          title="Start drilling: temporarily switch the chart's time bucket (Y/Q/M/W/D). The Style tab's Granularity is the fall-back."
        >
          Enable date drill…
        </button>
      </div>
    )
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
  // Phase-15.84 — collision registry recreated each render. Shared
  // across every <LabelList> on this chart so the "auto-hide overlap"
  // option can suppress later labels that intersect earlier ones.
  const labelRegistry: LabelBBox[] = [];
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
    });
  };
  const showDots = style.showDots ?? true;
  const lineWidth = style.lineWidth ?? 2;
  const areaOpacity = style.areaOpacity ?? 0.6;
  const lineDash = style.lineStyle === 'dashed' ? '8 4' : undefined;
  const chartTitle = style.chartTitle?.trim() || undefined;
  const pieInnerRadius = style.pieInnerRadius ?? 0;
  const stackMode = style.stackMode ?? 'normal';
  const dualYAxis = style.dualYAxis ?? false;
  const yAxisRightLabel = style.yAxisRightLabel?.trim() || undefined;
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

  const xAxisLabel = style.xAxisLabel || undefined;
  const yAxisLabel = style.yAxisLabel || undefined;

  const ChartTitleEl = chartTitle ? (
    <div className="text-center font-semibold text-text-secondary mb-1" style={{ fontSize: chartTitleFontSize }}>{chartTitle}</div>
  ) : null;

  const renderXAxis = (dataKey: string, count: number = categoricalData.length, dateLike = false) => {
    const { angle, height, textAnchor, interval, labelOffset } = buildXAxisProps(count, fontSize, xAxisLabel);
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
          />
        ) as any}
        height={height}
        interval={interval}
        label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: labelOffset, fontSize } : undefined}
      />
    );
  };
  const renderYAxis = () => (
    <YAxis tick={{ fontSize }} tickFormatter={yAxisTickFormatter(style)} domain={yDomain}
      label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft', fontSize, dx: -10 } : undefined} />
  );
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
      wrapperStyle={{ fontSize, cursor: 'pointer' }}
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
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 flex items-center justify-center">
          <div className="w-full max-w-xl">
            <KpiCard
              value={kpiValue}
              label={cardLabel}
              format={style.numberFormat ?? 'compact'}
              decimalPlaces={style.decimalPlaces}
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
            />
          </div>
        </div>
      </div>
    );
  }

  if (type === 'PODIUM') {
    const nameField = style.podiumNameField || dimension || (data[0] && Object.keys(data[0]).find((k) => typeof data[0][k] === 'string'));
    const valueField = style.podiumValueField
      || (metrics[0] ? metricKey(metrics[0]) : undefined)
      || (data[0] && Object.keys(data[0]).find((k) => typeof data[0][k] === 'number'));
    if (!nameField || !valueField) {
      return <EmptyState message="Select a name dimension and a value metric to render the podium." />;
    }
    const top = Math.min(Math.max(style.podiumTop ?? 3, 1), 5);
    const ranked = [...data]
      .sort((a, b) => Number(b?.[valueField] ?? 0) - Number(a?.[valueField] ?? 0))
      .slice(0, top);
    const colors = [
      style.podiumGoldColor || '#fbbf24',
      style.podiumSilverColor || '#cbd5e1',
      style.podiumBronzeColor || '#d97706',
      '#64748b',
      '#475569',
    ];
    const labels = ['Winner', 'Runner-up', 'Rank 3', 'Rank 4', 'Rank 5'];
    const display = ranked.length >= 3 ? [ranked[1], ranked[0], ranked[2], ...ranked.slice(3)] : ranked;
    const fmt = (v: any) => formatNumber(Number(v) || 0, style);
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 flex items-end justify-center gap-4 px-4">
          {display.map((e: any, i: number) => {
            const rank = ranked.indexOf(e);
            const color = colors[rank] || colors[colors.length - 1];
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
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={sortedPieData} dataKey="value" nameKey="name"
                cx="50%" cy="45%" outerRadius="60%"
                innerRadius={pieInnerRadius > 0 ? `${pieInnerRadius}%` : undefined}
                onClick={handlePieClick}
                label={showDataLabels
                  ? ({ name, value, percent }) => percent > 0.03
                    ? `${name}: ${formatNumber(value, style)} (${(percent * 100).toFixed(0)}%)`
                    : ''
                  : ({ name, percent }) => percent > 0.03 ? `${name} (${(percent * 100).toFixed(0)}%)` : ''}
              >
                {sortedPieData.map((row: any, i) => (
                  <Cell key={i} fill={getSeriesColor(String(row?.name ?? i), i)} />
                ))}
              </Pie>
              <Tooltip formatter={(v: any) => [formatNumber(v, style), metricLabel(m, labelMap)]} />
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
    const ScatterTooltip = ({ active, payload }: any) => {
      if (!active || !payload?.length) return null;
      const pt = payload[0]?.payload;
      return (
        <div className="bg-surface-1 border border-[rgb(var(--border-line))] rounded px-3 py-2 shadow-linear-sm" style={{ fontSize }}>
          {dimension && pt.label !== undefined && (
            <div className="font-semibold text-text-primary mb-1">{String(pt.label)}</div>
          )}
          <div className="text-text-secondary">{scatterX}: <span className="font-medium text-text-primary">{formatNumber(pt.x, style)}</span></div>
          <div className="text-text-secondary">{scatterY}: <span className="font-medium text-text-primary">{formatNumber(pt.y, style)}</span></div>
        </div>
      );
    };
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart onClick={handleScatterClick}>
              {showGrid && <CartesianGrid strokeDasharray="3 3" />}
              <XAxis dataKey="x" name={scatterX} type="number" tick={{ fontSize }}
                label={{ value: style.xAxisLabel || scatterX, position: 'insideBottom', offset: -5, fontSize }} />
              <YAxis dataKey="y" name={scatterY} type="number" tick={{ fontSize }}
                tickFormatter={yAxisTickFormatter(style)}
                label={{ value: style.yAxisLabel || scatterY, angle: -90, position: 'insideLeft', fontSize }} />
              <ZAxis range={[40, 40]} />
              <Tooltip content={<ScatterTooltip />} cursor={{ strokeDasharray: '3 3' }} />
              {renderLegend()}
              <Scatter name={`${scatterX} vs ${scatterY}`} data={sortedScatterPoints} fill={PALETTE[0]}>
                {scatterLabelField && (
                  <LabelList dataKey={scatterLabelField} position="top" fontSize={fontSize - 1} />
                )}
              </Scatter>
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
          />
        </div>
      </div>
    );
  }

  if (ADVANCED_EXPLORE_CHART_TYPES.has(type)) {
    return (
      <AdvancedExploreChart
        type={type}
        data={data}
        model={model}
        style={style}
        palette={PALETTE}
        havingFilters={havingFilters}
        preAggregated={preAggregated}
        onStyleConfigChange={onStyleConfigChange}
        onSelectDataPoint={onSelectDataPoint}
        labelMap={labelMap}
      />
    );
  }

  // For remaining types: need xField + at least 1 metric
  if (!xField) return <EmptyState message="Select an X Axis column to render this chart." />;
  if (metrics.length === 0) return <EmptyState message="Select at least one value column to render this chart." />;


  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ STACKED BAR ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  if (type === 'STACKED_BAR') {
    const displayData = sortedCategoricalData;
    const displaySeries = categoricalSeries;
    const isPercent = stackMode === 'percent';
    const stackTotalsByIndex = displayData.map((row: any) =>
      displaySeries.reduce((acc, s) => acc + (Number(row[s.key]) || 0), 0),
    );
    const percentYAxis = isPercent ? (
      <YAxis tick={{ fontSize }} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} domain={[0, 1]}
        label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft', fontSize, dx: -10 } : undefined} />
    ) : renderYAxis();
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          {DrillBar}
          {TruncationBanner}
          {wrapScrollable(
            <BarChart data={displayData} onClick={handleCategoricalChartClick}
              stackOffset={isPercent ? 'expand' : undefined}>
              {showGrid && <CartesianGrid strokeDasharray="3 3" />}
              {renderXAxis(xField, displayData.length)}
              {percentYAxis}
              <Tooltip formatter={isPercent
                ? (v: any, name: string) => [`${(Number(v) * 100).toFixed(1)}%`, name]
                : tooltipFormatter(displaySeries, style)} />
              {renderLegend()}
              {displaySeries.map((series, i) => {
                const isTopOfStack = i === displaySeries.length - 1;
                // Percent mode: each segment shows its own % inside the bar.
                // Normal mode: only the top segment shows total above the bar.
                const showLabel = showDataLabels && (isPercent || isTopOfStack);
                return (
                  <Bar key={series.key} dataKey={series.key} stackId="s" fill={getSeriesColor(series.key, i)}
                    name={series.label}
                    hide={hiddenSeries.has(series.key)}
                    barSize={barSize}
                    radius={isTopOfStack ? [barRadius, barRadius, 0, 0] : undefined}>
                    {showLabel && isPercent && (
                      <LabelList
                        dataKey={series.key}
                        position="center"
                        content={(props: any) => {
                          const { x, y, width, height, value, index } = props;
                          const total = stackTotalsByIndex[index] || 0;
                          if (!total) return null;
                          const pct = (Number(value) / total) * 100;
                          if (pct < 4) return null;
                          return (
                            <text
                              x={x + width / 2}
                              y={y + height / 2}
                              textAnchor="middle"
                              dominantBaseline="middle"
                              fill="#fff"
                              fontSize={fontSize - 1}
                            >
                              {`${pct.toFixed(0)}%`}
                            </text>
                          );
                        }}
                      />
                    )}
                    {showLabel && !isPercent && (
                      <LabelList
                        dataKey={series.key}
                        position="top"
                        content={(props: any) => {
                          const { x, y, width, index } = props;
                          const total = stackTotalsByIndex[index] || 0;
                          if (!total) return null;
                          return (
                            <text
                              x={x + width / 2}
                              y={Math.max(12, y - 6)}
                              textAnchor="middle"
                              fill="rgb(var(--text-secondary))"
                              fontSize={fontSize - 1}
                            >
                              {formatNumber(total, style)}
                            </text>
                          );
                        }}
                      />
                    )}
                  </Bar>
                );
              })}
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
    const dateLikeXAxis = isDateLikeAxis(sortedCategoricalData, xField, xAxisLabel || normalizedRoleConfig.timeField);
    const displayData = sortRowsByDateAxis(sortedCategoricalData, xField, dateLikeXAxis && sortRules.length === 0);
    const displaySeries = categoricalSeriesWithCalc;
    return (
      <div className="h-full flex flex-col">
        {ChartTitleEl}
        <div className="flex-1 min-h-0">
          {DrillBar}
          {TruncationBanner}
          {wrapScrollable(
            <AreaChart data={displayData} onClick={handleCategoricalChartClick}>
              {showGrid && <CartesianGrid strokeDasharray="3 3" />}
              {renderXAxis(xField, displayData.length, dateLikeXAxis)}
              {renderYAxis()}
              <Tooltip
                content={(p: any) => (
                  <CustomTooltip {...p} series={displaySeries} style={style} fontSize={fontSize} xField={xField} />
                )}
                labelFormatter={dateLikeXAxis ? formatDateAxisValue : undefined}
              />
              {renderLegend()}
              {displaySeries.map((series, i) => {
                return (
                  <Area key={series.key} type="monotone" dataKey={series.key}
                    name={series.label}
                    hide={hiddenSeries.has(series.key)}
                    stroke={getSeriesColor(series.key, i)}
                    fill={getSeriesColor(series.key, i)}
                    fillOpacity={areaOpacity} strokeWidth={lineWidth}
                    dot={showDots && displayData.length <= 60}
                    strokeDasharray={lineDash} />
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
    const dateLikeXAxis = type === 'TIME_SERIES' || isDateLikeAxis(timeSeriesData, xField, xAxisLabel || normalizedRoleConfig.timeField);
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
            <LineChart data={displayData} onClick={handleCategoricalChartClick}>
              {showGrid && <CartesianGrid strokeDasharray="3 3" />}
              {renderXAxis(xField, displayData.length, dateLikeXAxis)}
              {renderYAxis()}
              <Tooltip
                content={(p: any) => (
                  <CustomTooltip {...p} series={displaySeries} style={style} fontSize={fontSize} xField={xField} />
                )}
                labelFormatter={dateLikeXAxis ? formatDateAxisValue : undefined}
              />
              {renderLegend()}
              {displaySeries.map((series, i) => {
                return (
                  <Line key={series.key} type="monotone" dataKey={series.key}
                    name={series.label}
                    hide={hiddenSeries.has(series.key)}
                    stroke={getSeriesColor(series.key, i)}
                    strokeWidth={lineWidth}
                    dot={showDots && displayData.length <= 60}
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
    const displaySeries = categoricalSeries;
    const MIN_ROW_HEIGHT = 32; // px per row for horizontal bars
    const chartHeight = displayData.length > SCROLL_THRESHOLD
      ? Math.max(displayData.length * MIN_ROW_HEIGHT, 400)
      : undefined; // let ResponsiveContainer fill parent
    const innerChart = (
      <BarChart data={displayData} layout="vertical" onClick={handleCategoricalChartClick}>
        {showGrid && <CartesianGrid strokeDasharray="3 3" />}
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
            />
          ) as any}
          interval={0}
          width={160}
          label={yAxisLabel ? { value: yAxisLabel, angle: -90, position: 'insideLeft', fontSize, dx: -10 } : undefined} />
        <XAxis type="number" tick={{ fontSize }} tickFormatter={yAxisTickFormatter(style)}
          label={xAxisLabel ? { value: xAxisLabel, position: 'insideBottom', offset: -5, fontSize } : undefined} />
        <Tooltip
          content={(p: any) => (
            <CustomTooltip {...p} series={displaySeries} style={style} fontSize={fontSize} xField={xField} />
          )}
        />
        {renderLegend()}
        {displaySeries.map((series, i) => {
          return (
            <Bar key={series.key} dataKey={series.key}
              name={series.label}
              hide={hiddenSeries.has(series.key)}
              fill={getSeriesColor(series.key, i)}
              barSize={barSize}
              radius={[0, barRadius, barRadius, 0]}>
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
    const allComboSeries = [...comboBarSeries, ...comboLineSeries];
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
            <ComposedChart data={displayData} onClick={handleCategoricalChartClick}>
              {showGrid && <CartesianGrid strokeDasharray="3 3" />}
              {renderXAxis(xField!, displayData.length)}
              {renderYAxis()}
              {dualYAxis && (
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize }}
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
                        <Line
                          key={series.key}
                          dataKey={series.key}
                          name={series.label}
                          hide={hiddenSeries.has(series.key)}
                          type="monotone"
                          stroke={color}
                          strokeWidth={lineWidth}
                          dot={showDots && displayData.length <= 60}
                          strokeDasharray={lineDash}
                        />
                      );
                    }
                    if (mode === 'area') {
                      return (
                        <Area
                          key={series.key}
                          dataKey={series.key}
                          name={series.label}
                          hide={hiddenSeries.has(series.key)}
                          type="monotone"
                          stroke={color}
                          fill={color}
                          fillOpacity={areaOpacity}
                          strokeWidth={lineWidth}
                        />
                      );
                    }
                    return (
                      <Bar
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
                      <Bar key={series.key} dataKey={series.key} name={series.label}
                        hide={hiddenSeries.has(series.key)}
                        fill={getSeriesColor(series.key, index)} radius={[barRadius, barRadius, 0, 0]}
                        barSize={barSize}>
                        {showDataLabels && (
                          <LabelList dataKey={series.key} content={dataLabelContent(series.key, series.label, 'vertical')} />
                        )}
                      </Bar>
                    ))}
                    <Line dataKey={lineSeries.key} name={lineSeries.label}
                      hide={hiddenSeries.has(lineSeries.key)}
                      type="monotone" stroke={getSeriesColor(lineSeries.key, comboBarSeries.length)} strokeWidth={lineWidth}
                      dot={showDots && displayData.length <= 60}
                      strokeDasharray={lineDash}
                      yAxisId={dualYAxis ? 'right' : 0} />
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
  const displayBarSeries = categoricalSeries;
  return (
    <div className="h-full flex flex-col">
      {ChartTitleEl}
      <div className="flex-1 min-h-0">
        {DrillBar}
        {TruncationBanner}
        {wrapScrollable(
          <BarChart data={displayBarData} onClick={handleCategoricalChartClick}>
            {showGrid && <CartesianGrid strokeDasharray="3 3" />}
            {renderXAxis(xField, displayBarData.length)}
            {renderYAxis()}
            <Tooltip
              content={(p: any) => (
                <CustomTooltip {...p} series={displayBarSeries} style={style} fontSize={fontSize} xField={xField} />
              )}
            />
            {renderLegend()}
            {displayBarSeries.map((series, i) => {
              const baseColor = getSeriesColor(series.key, i);
              const hasConditional = conditionalSeriesRules.length > 0;
              return (
                <Bar key={series.key} dataKey={series.key}
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
