'use client';

import React, { useEffect, useRef, useState } from 'react';
import * as LucideIcons from 'lucide-react';
import { Minus, Target, TrendingDown, TrendingUp } from 'lucide-react';
import type { NumberFormat } from '@/components/explore/ExploreChartConfig';
import type { KpiBackgroundMode, KpiGoalDirection, KpiValueColorRule } from '@/types/api';
import { useDashboardChartTheme } from '@/components/dashboards/DashboardThemeProvider';

type KpiCardProps = {
  value: number | string | null;
  label?: string;
  comparison?: number | null;
  format?: NumberFormat;
  /** Dashboard-wide "Display units" (PBI parity). Scales + suffixes numeric
   *  values (number/currency/compact) to a consistent unit across the report;
   *  never applies to percent. Undefined/'none' = full value. */
  displayUnits?: 'auto' | 'none' | 'thousands' | 'millions' | 'billions';
  decimalPlaces?: number;
  currencySymbol?: string;
  contextTemplate?: string;
  benchmarkValue?: number | string | null;
  benchmarkLabel?: string;
  showBenchmarkValue?: boolean;
  showDelta?: boolean;
  goalDirection?: KpiGoalDirection;
  backgroundMode?: KpiBackgroundMode;
  accentColor?: string;
  enableColorRules?: boolean;
  colorRules?: KpiValueColorRule[];
  rowCount?: number;
  iconName?: string;
  iconColor?: string;
  accentBorder?: boolean;
  gradientBg?: boolean;
  valueFontSize?: number;
  /** #KPI-header — when the host (dashboard tile) renders the metric label in
   *  its OWN header row (level with the toolbar), hide the in-card label so it
   *  isn't shown twice and the card body can focus on the value (no top gap). */
  hideLabel?: boolean;
  /** When rendered inside a dashboard tile, the tile already provides the card
   *  frame (border + shadow + padding). `embedded` drops KpiCard's own outer
   *  chrome (border, shadow, gradient top-bar) and tightens padding so the KPI
   *  doesn't read as a second nested card floating in empty space. Standalone
   *  Explore usage leaves this false and keeps the full standalone card. */
  embedded?: boolean;
};

const DEFAULT_ACCENT_COLOR = '#2563eb';
const FALLBACK_VALUE_COLOR = '#0f172a';
const FALLBACK_TONE_COLORS = {
  good: '#16a34a',
  bad: '#dc2626',
  neutral: '#64748b',
} as const;

function toNumber(value: number | string | null | undefined): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/,/g, '');
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function colorWithAlpha(color: string | undefined, alpha: number): string {
  const c = color?.trim();
  const a = Math.min(1, Math.max(0, alpha));
  if (!c) return `rgba(37, 99, 235, ${a})`;

  const shortHex = c.match(/^#([0-9a-f]{3})$/i);
  if (shortHex) {
    const [r, g, b] = shortHex[1].split('').map((part) => parseInt(`${part}${part}`, 16));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  const fullHex = c.match(/^#([0-9a-f]{6})$/i);
  if (fullHex) {
    const raw = fullHex[1];
    const r = parseInt(raw.slice(0, 2), 16);
    const g = parseInt(raw.slice(2, 4), 16);
    const b = parseInt(raw.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  const percent = Math.round(a * 100);
  return `color-mix(in srgb, ${c} ${percent}%, transparent)`;
}

function buildTintedBackground(color: string | undefined, stronger = false): string {
  const top = colorWithAlpha(color, stronger ? 0.22 : 0.16);
  const mid = colorWithAlpha(color, stronger ? 0.12 : 0.08);
  const low = colorWithAlpha(color, stronger ? 0.06 : 0.03);
  return `linear-gradient(135deg, ${top} 0%, ${mid} 48%, ${low} 100%)`;
}

type DisplayUnits = 'auto' | 'none' | 'thousands' | 'millions' | 'billions';

/** Scale + suffix a number to a display unit. 'auto' = per-value K/M/B; a fixed
 *  unit forces the magnitude so a whole report reads in one unit (e.g. tỷ). */
function scaleToUnit(n: number, units: DisplayUnits, dp: number): string {
  if (units === 'auto') {
    const a = Math.abs(n);
    if (a >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(dp)}B`;
    if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(dp)}M`;
    if (a >= 1_000) return `${(n / 1_000).toFixed(dp)}K`;
    return n.toLocaleString(undefined, { maximumFractionDigits: dp });
  }
  const map: Record<string, [number, string]> = {
    thousands: [1_000, 'K'],
    millions: [1_000_000, 'M'],
    billions: [1_000_000_000, 'B'],
  };
  const [div, suf] = map[units] ?? [1, ''];
  return `${(n / div).toFixed(dp)}${suf}`;
}

function formatNumericValue(
  value: number | string | null | undefined,
  options: {
    format?: NumberFormat;
    decimalPlaces?: number;
    currencySymbol?: string;
    displayUnits?: DisplayUnits;
  },
): string {
  if (value === null || value === undefined || value === '') return '--';

  const numericValue = toNumber(value);
  if (numericValue === null) return String(value);

  const format = options.format ?? 'compact';
  const decimalPlaces = options.decimalPlaces ?? 1;
  const currencySymbol = options.currencySymbol || '$';
  const displayUnits = options.displayUnits;
  const abs = Math.abs(numericValue);

  // Percent is a ratio — dashboard display units never apply to it.
  if (format === 'percent') {
    return `${(numericValue * 100).toFixed(decimalPlaces)}%`;
  }

  // Dashboard-wide "Display units": scale EVERY numeric format (percent already
  // returned above) to one consistent unit so KPIs across a report read the same
  // (fixes the "raw 10-digit next to a %" inconsistency). Currency keeps its
  // prefix; 'number' full digits yield to the report unit; 'auto' + any declared
  // measure format-kind (e.g. 'decimal'/'integer') are covered too. 'none' = off.
  if (displayUnits && displayUnits !== 'none') {
    const prefix = format === 'currency' ? currencySymbol : '';
    return `${prefix}${scaleToUnit(numericValue, displayUnits, decimalPlaces)}`;
  }

  if (format === 'compact') {
    if (abs >= 1_000_000_000) return `${(numericValue / 1_000_000_000).toFixed(decimalPlaces)}B`;
    if (abs >= 1_000_000) return `${(numericValue / 1_000_000).toFixed(decimalPlaces)}M`;
    if (abs >= 1_000) return `${(numericValue / 1_000).toFixed(decimalPlaces)}K`;
    return numericValue.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimalPlaces,
    });
  }

  if (format === 'currency') {
    return `${currencySymbol}${numericValue.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimalPlaces,
    })}`;
  }

  if (format === 'number') {
    return numericValue.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimalPlaces,
    });
  }

  if (abs >= 1_000) {
    return formatNumericValue(numericValue, {
      format: 'compact',
      decimalPlaces,
      currencySymbol,
    });
  }

  return numericValue.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimalPlaces,
  });
}

// Resolve a rule's comparison threshold. Static (`value`) or dynamic — the KPI's
// benchmark/Target — with an optional formula (× multiplier + offset), e.g.
// Target × 1.2. Returns null when a benchmark-source rule has no benchmark
// (rule can't apply).
function resolveRuleThreshold(rule: KpiValueColorRule, benchmark: number | null): number | null {
  const mult = typeof rule.multiplier === 'number' && Number.isFinite(rule.multiplier) ? rule.multiplier : 1;
  const off = typeof rule.offset === 'number' && Number.isFinite(rule.offset) ? rule.offset : 0;
  const base = rule.source === 'benchmark' ? benchmark : rule.value;
  if (base === null || base === undefined || !Number.isFinite(base)) return null;
  return base * mult + off;
}

function evaluateRule(value: number, rule: KpiValueColorRule, benchmark: number | null): boolean {
  const threshold = resolveRuleThreshold(rule, benchmark);
  if (threshold === null) return false;
  switch (rule.operator) {
    case '>':
      return value > threshold;
    case '<':
      return value < threshold;
    case '=':
      return value === threshold;
    case '>=':
      return value >= threshold;
    case '<=':
      return value <= threshold;
    case '!=':
      return value !== threshold;
    default:
      return false;
  }
}

function interpolateTemplate(template: string, tokens: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, token: string) => tokens[token] ?? '');
}

function getLegacyComparisonTone(comparison: number) {
  if (comparison > 0) {
    return {
      icon: TrendingUp,
      surfaceClass: 'bg-success/10',
      textClass: 'text-success',
    };
  }
  if (comparison < 0) {
    return {
      icon: TrendingDown,
      surfaceClass: 'bg-danger/10',
      textClass: 'text-danger',
    };
  }
  return {
    icon: Minus,
    surfaceClass: 'bg-surface-2',
    textClass: 'text-text-secondary',
  };
}

function getDeltaAppearance(delta: number, goalDirection: KpiGoalDirection) {
  if (delta === 0) {
    return {
      icon: Minus,
      surfaceClass: 'bg-surface-2',
      textClass: 'text-text-secondary',
      directionLabel: 'On target',
      tone: 'neutral' as const,
    };
  }

  const positiveMovement = delta > 0;
  const isGood = goalDirection === 'down' ? !positiveMovement : positiveMovement;

  return {
    icon: positiveMovement ? TrendingUp : TrendingDown,
    surfaceClass: isGood ? 'bg-success/10' : 'bg-danger/10',
    textClass: isGood ? 'text-success' : 'text-danger',
    directionLabel: isGood ? 'Performing well' : 'Needs attention',
    tone: (isGood ? 'good' : 'bad') as 'good' | 'bad',
  };
}

export function KpiCard({
  value,
  label,
  comparison,
  format = 'compact',
  displayUnits,
  decimalPlaces = 1,
  currencySymbol = '$',
  contextTemplate,
  benchmarkValue,
  benchmarkLabel = 'Benchmark',
  showBenchmarkValue = true,
  showDelta = true,
  goalDirection = 'up',
  backgroundMode = 'auto',
  accentColor = DEFAULT_ACCENT_COLOR,
  enableColorRules = false,
  colorRules = [],
  rowCount,
  iconName,
  iconColor,
  accentBorder = false,
  gradientBg = false,
  valueFontSize,
  hideLabel = false,
  embedded = false,
}: KpiCardProps) {
  // Phase-B15 — dashboard theme: KPI value size + status colors. Empty {} when
  // rendered standalone (no DashboardThemeProvider), so behaviour is unchanged.
  const dashTheme = useDashboardChartTheme();
  // #4 — dashboard-wide display units. An explicit prop (from ExploreChart) wins;
  // otherwise inherit the report theme so the legacy ChartPreview KPI path (no
  // prop) is covered too. Undefined in standalone Explore → behaviour unchanged.
  const effectiveDisplayUnits = displayUnits ?? dashTheme.displayUnits;
  const toneColor = (tone: 'good' | 'bad' | 'neutral'): string | undefined => {
    if (tone === 'good') return dashTheme.goodColor;
    if (tone === 'bad') return dashTheme.badColor;
    return dashTheme.neutralColor;
  };
  // Phase-B16 — let the KPI value/accent follow the dashboard theme accent, but
  // ONLY when this card still uses the default accent (so an explicit per-chart
  // accent the DA set is preserved — PBI "theme default, visual override wins").
  const effectiveAccent =
    accentColor === DEFAULT_ACCENT_COLOR && dashTheme.accent ? dashTheme.accent : accentColor;
  const IconComponent: React.ComponentType<{ className?: string; style?: React.CSSProperties }> | null =
    iconName && (LucideIcons as any)[iconName] ? (LucideIcons as any)[iconName] : null;
  const numericValue = toNumber(value);
  const numericBenchmark = toNumber(benchmarkValue);
  const matchedRule = enableColorRules && numericValue !== null
    ? colorRules.find((rule) => evaluateRule(numericValue, rule, numericBenchmark))
    : undefined;
  const formattedValue = formatNumericValue(value, { format, displayUnits: effectiveDisplayUnits, decimalPlaces, currencySymbol });
  const formattedBenchmark = formatNumericValue(numericBenchmark, { format, displayUnits: effectiveDisplayUnits, decimalPlaces, currencySymbol });
  const valueColor = matchedRule?.color || effectiveAccent || FALLBACK_VALUE_COLOR;
  const delta = numericValue !== null && numericBenchmark !== null ? numericValue - numericBenchmark : null;
  const deltaPercent = delta !== null && numericBenchmark !== null && numericBenchmark !== 0
    ? delta / Math.abs(numericBenchmark)
    : null;
  const hasBenchmark = numericBenchmark !== null;
  const showBenchmarkPanel = Boolean(showBenchmarkValue && hasBenchmark);
  const hasDelta = Boolean(showDelta && delta !== null);
  const statusLabel = matchedRule?.label?.trim();
  const template = contextTemplate?.trim();
  const tokenMap = {
    value: formattedValue,
    rawValue: value == null ? '' : String(value),
    benchmark: formattedBenchmark,
    benchmarkLabel: benchmarkLabel?.trim() || 'Benchmark',
    delta: formatNumericValue(delta, { format, displayUnits: effectiveDisplayUnits, decimalPlaces, currencySymbol }),
    deltaPercent: deltaPercent === null ? '--' : `${deltaPercent > 0 ? '+' : ''}${(deltaPercent * 100).toFixed(decimalPlaces)}%`,
    rows: typeof rowCount === 'number' ? rowCount.toLocaleString() : '0',
    label: label?.trim() || 'KPI',
  };
  const contextText = template ? interpolateTemplate(template, tokenMap) : '';
  const benchmarkAppearance = delta !== null ? getDeltaAppearance(delta, goalDirection) : null;
  const deltaAppearance = hasDelta && delta !== null ? benchmarkAppearance : null;
  const legacyComparison = typeof comparison === 'number' ? comparison : null;
  const legacyComparisonTone = legacyComparison !== null ? getLegacyComparisonTone(legacyComparison) : null;
  const DeltaIcon = deltaAppearance?.icon;
  const ComparisonIcon = legacyComparisonTone?.icon;
  const benchmarkToneColor = benchmarkAppearance
    ? (toneColor(benchmarkAppearance.tone) ?? FALLBACK_TONE_COLORS[benchmarkAppearance.tone])
    : undefined;
  const statusBackgroundColor = matchedRule?.backgroundColor
    || matchedRule?.color
    || benchmarkToneColor
    || valueColor
    || effectiveAccent
    || DEFAULT_ACCENT_COLOR;
  const backgroundSetting = backgroundMode || 'auto';
  const hasStatusSignal = Boolean(matchedRule || hasBenchmark);
  const useStatusBackground = backgroundSetting === 'status'
    || (backgroundSetting === 'auto' && hasStatusSignal);
  const useAccentBackground = backgroundSetting === 'accent'
    || (backgroundSetting === 'auto' && !useStatusBackground && gradientBg);
  const cardBackground = useStatusBackground
    ? buildTintedBackground(statusBackgroundColor, Boolean(matchedRule))
    : useAccentBackground
      ? buildTintedBackground(effectiveAccent || DEFAULT_ACCENT_COLOR)
      : undefined;
  const panelBackgroundStyle = (useStatusBackground || useAccentBackground)
    ? {
        backgroundColor: colorWithAlpha(statusBackgroundColor, 0.09),
        boxShadow: `inset 0 0 0 1px ${colorWithAlpha(statusBackgroundColor, 0.12)}`,
      }
    : undefined;
  const statusPillStyle = matchedRule
    ? {
        color: matchedRule.color,
        backgroundColor: colorWithAlpha(statusBackgroundColor, 0.13),
        borderColor: colorWithAlpha(statusBackgroundColor, 0.24),
      }
    : undefined;
  const showHeaderIcon = hideLabel && Boolean(IconComponent);
  const resolvedValueFontSize = typeof valueFontSize === 'number' && Number.isFinite(valueFontSize)
    ? Math.min(Math.max(Math.round(valueFontSize), 16), 80)
    : undefined;

  // Auto-fit (embedded only): in a dashboard tile the KPI fills a fixed-height
  // cell. The old fixed text-4xl/5xl value + benchmark/delta panels overflowed
  // a SHORT tile and the root's `overflow-hidden` then clipped the number /
  // panels (the "card bị che số" bug). Measure the tile height and scale the
  // value font + tighten panels so content always fits; on a very short tile,
  // drop the secondary panels rather than crop the headline number. Tall tiles
  // keep the original large look. Standalone Explore (embedded=false) is
  // untouched — boxH stays 0 and all original classes/styles apply.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [boxH, setBoxH] = useState(0);
  const [boxW, setBoxW] = useState(0);
  useEffect(() => {
    if (!embedded) return;
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setBoxH(Math.round(entry.contentRect.height));
        setBoxW(Math.round(entry.contentRect.width));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [embedded]);
  const autoFit = embedded && boxH > 0;
  const panelsPresent = showBenchmarkPanel || hasDelta || legacyComparison !== null;
  // The benchmark/delta panels are 2-line bordered blocks (~64px) that can't
  // shrink below their text — so when the tile isn't tall enough to show them
  // WITHOUT cropping, drop them entirely and keep just label+value (which the
  // font auto-scale always fits). Headline number is never cropped. Panels
  // return on a comfortably tall tile. Threshold ≈ label+value+gap (~80) +
  // panel block (~96) with headroom.
  const dropPanels = autoFit && boxH < 210;
  const compact = autoFit && boxH < 280;
  // Value font derived from available height. Ceiling = author/theme override
  // or 56; floor = 18 so it stays legible. Reserve more height for the value
  // when panels share the card.
  const fontCeil = resolvedValueFontSize ?? (dashTheme.kpiFontSize as number | undefined) ?? 56;
  // Height budget — the original behaviour.
  const heightFont = boxH * ((panelsPresent && !dropPanels) ? 0.22 : 0.36);
  // Width budget — the fix. A long full-format number (e.g. "3,907,698,730",
  // 13 chars) at a height-derived 56px is far WIDER than a narrow tile, so the
  // old height-only auto-fit let it wrap mid-number ("3,907,698,73" / "0").
  // Clamp the font so the whole headline fits on ONE line: with tabular-nums
  // semibold, a glyph is ≈0.62em wide, so maxFont ≈ usableWidth / (chars·0.62).
  // Subtract the tile padding and, when a status pill shares the row, its width.
  const valueCharCount = Math.max((formattedValue ?? '').length, 1);
  const sideRailReserve = (statusLabel ? 84 : 0) + (showHeaderIcon ? 40 : 0);
  const usableW = Math.max(0, boxW - 16 - sideRailReserve);
  const widthFont = usableW > 0 ? usableW / (valueCharCount * 0.62) : Infinity;
  const autoValueFont = autoFit
    ? Math.round(Math.min(fontCeil, Math.max(16, Math.min(heightFont, widthFont))))
    : undefined;

  // Inside a dashboard tile the surrounding tile already draws the card frame.
  // Drop our own border/shadow/gradient-bar (unless the author opted into an
  // accent border) and tighten padding so the KPI fills the tile instead of
  // floating as a smaller nested card. See `embedded` prop doc.
  // Phase-B11 — inside a dashboard tile the tile already draws the card border;
  // a second border from the KPI (incl. the accentBorder frame) = two nested
  // borders that look cluttered. So embedded KPI is ALWAYS chromeless (no own
  // frame, no gradient bar) — the accent still tints the value. A DA who wants
  // a bordered/coloured card sets it via the dashboard theme later.
  const showOwnFrame = !embedded;
  const showGradientBar = !embedded;

  return (
    <div
      ref={rootRef}
      className={`overflow-hidden ${showOwnFrame ? 'rounded-2xl border shadow-linear-sm' : ''} ${embedded ? `flex h-full flex-col justify-center ${cardBackground ? 'rounded-md' : ''}` : 'bg-surface-1'}`}
      style={{
        borderColor: showOwnFrame
          ? (accentBorder ? (accentColor || DEFAULT_ACCENT_COLOR) : 'rgb(var(--border-line))')
          : undefined,
        borderWidth: showOwnFrame ? (accentBorder ? 2 : 1) : undefined,
        background: cardBackground,
      }}
    >
      {showGradientBar && (
        <div
          className="h-1.5 w-full"
          style={{
            background: `linear-gradient(90deg, ${effectiveAccent || DEFAULT_ACCENT_COLOR}, ${valueColor})`,
          }}
        />
      )}

      {/* Phase-B7 — when a frame IS drawn (standalone, or embedded with an
          accent border), the value must NOT sit ~4px from the border. Only the
          truly chromeless embedded case (no frame) uses the tight fill padding. */}
      <div className={!embedded ? 'p-6 sm:p-7' : (showOwnFrame ? 'p-4' : 'px-1 py-1')}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {!hideLabel && (label || IconComponent) && (
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-text-tertiary">
                {IconComponent && (
                  <IconComponent
                    className="h-4 w-4"
                    style={{ color: iconColor || effectiveAccent || DEFAULT_ACCENT_COLOR }}
                  />
                )}
                {label && <span>{label}</span>}
              </div>
            )}

            <div
              className={`font-semibold tracking-tight text-text-primary tabular-nums ${autoFit ? 'overflow-hidden whitespace-nowrap' : 'break-words text-4xl sm:text-5xl'} ${compact ? 'mt-1' : 'mt-3'}`}
              style={{
                color: valueColor || FALLBACK_VALUE_COLOR,
                ...(autoValueFont
                  ? { fontSize: autoValueFont, lineHeight: 1.05 }
                  : resolvedValueFontSize
                    ? { fontSize: resolvedValueFontSize, lineHeight: 1.08 }
                    : dashTheme.kpiFontSize
                      ? { fontSize: dashTheme.kpiFontSize, lineHeight: 1.08 }
                      : {}),
              }}
            >
              {formattedValue}
            </div>

            {contextText && (
              <div className="mt-3 whitespace-pre-line text-sm leading-6 text-text-secondary">
                {contextText}
              </div>
            )}
          </div>

          {(showHeaderIcon || statusLabel) && (
            <div className="shrink-0 flex items-center gap-2">
              {showHeaderIcon && IconComponent && (
                <span
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-[rgb(var(--border-line))] bg-surface-2"
                  style={{
                    color: iconColor || effectiveAccent || DEFAULT_ACCENT_COLOR,
                    backgroundColor: colorWithAlpha(iconColor || effectiveAccent || DEFAULT_ACCENT_COLOR, 0.10),
                    borderColor: colorWithAlpha(iconColor || effectiveAccent || DEFAULT_ACCENT_COLOR, 0.18),
                  }}
                >
                  <IconComponent className="h-4 w-4" />
                </span>
              )}
              {statusLabel && (
                <span
                  className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary"
                  style={statusPillStyle}
                >
                  {statusLabel}
                </span>
              )}
            </div>
          )}
        </div>

        {(showBenchmarkPanel || hasDelta || legacyComparison !== null) && !dropPanels && (
          <div className={`grid gap-3 border-t border-[rgb(var(--border-line))] sm:grid-cols-2 ${compact ? 'mt-2 pt-2' : 'mt-5 pt-4'}`}>
            {showBenchmarkPanel && (
              <div className="rounded-xl bg-surface-2 px-4 py-3" style={panelBackgroundStyle}>
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
                  <Target className="h-3.5 w-3.5" />
                  <span>{benchmarkLabel?.trim() || 'Benchmark'}</span>
                </div>
                <div className="mt-1 text-sm font-semibold text-text-primary tabular-nums">
                  {formattedBenchmark}
                </div>
              </div>
            )}

            {hasDelta && delta !== null && deltaAppearance && DeltaIcon && (
              <div
                className={`rounded-xl px-4 py-3 ${toneColor(deltaAppearance.tone) ? '' : deltaAppearance.surfaceClass}`}
                style={toneColor(deltaAppearance.tone) ? { backgroundColor: colorWithAlpha(toneColor(deltaAppearance.tone), 0.10) } : panelBackgroundStyle}
              >
                <div
                  className={`text-[11px] font-semibold uppercase tracking-wide ${toneColor(deltaAppearance.tone) ? '' : deltaAppearance.textClass}`}
                  style={toneColor(deltaAppearance.tone) ? { color: toneColor(deltaAppearance.tone) } : undefined}
                >
                  {deltaAppearance.directionLabel}
                </div>
                <div
                  className={`mt-1 flex items-center gap-2 text-sm font-semibold tabular-nums ${toneColor(deltaAppearance.tone) ? '' : deltaAppearance.textClass}`}
                  style={toneColor(deltaAppearance.tone) ? { color: toneColor(deltaAppearance.tone) } : undefined}
                >
                  <DeltaIcon className="h-4 w-4" />
                  <span>
                    {formatNumericValue(delta, { format, displayUnits: effectiveDisplayUnits, decimalPlaces, currencySymbol })}
                    {deltaPercent !== null && ` (${deltaPercent > 0 ? '+' : ''}${(deltaPercent * 100).toFixed(decimalPlaces)}%)`}
                  </span>
                </div>
              </div>
            )}

            {!hasDelta && legacyComparison !== null && legacyComparisonTone && ComparisonIcon && (
              <div className={`rounded-xl px-4 py-3 ${legacyComparisonTone.surfaceClass}`} style={panelBackgroundStyle}>
                <div className={`text-[11px] font-semibold uppercase tracking-wide ${legacyComparisonTone.textClass}`}>
                  Trend
                </div>
                <div className={`mt-1 flex items-center gap-2 text-sm font-semibold tabular-nums ${legacyComparisonTone.textClass}`}>
                  <ComparisonIcon className="h-4 w-4" />
                  <span>{legacyComparison > 0 ? '+' : ''}{legacyComparison.toFixed(1)}% vs prev</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
