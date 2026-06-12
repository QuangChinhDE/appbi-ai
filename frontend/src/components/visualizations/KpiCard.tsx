'use client';

import React from 'react';
import * as LucideIcons from 'lucide-react';
import { Minus, Target, TrendingDown, TrendingUp } from 'lucide-react';
import type { NumberFormat } from '@/components/explore/ExploreChartConfig';
import type { KpiGoalDirection, KpiValueColorRule } from '@/types/api';

type KpiCardProps = {
  value: number | string | null;
  label?: string;
  comparison?: number | null;
  format?: NumberFormat;
  decimalPlaces?: number;
  currencySymbol?: string;
  contextTemplate?: string;
  benchmarkValue?: number | string | null;
  benchmarkLabel?: string;
  showBenchmarkValue?: boolean;
  showDelta?: boolean;
  goalDirection?: KpiGoalDirection;
  accentColor?: string;
  enableColorRules?: boolean;
  colorRules?: KpiValueColorRule[];
  rowCount?: number;
  iconName?: string;
  iconColor?: string;
  accentBorder?: boolean;
  gradientBg?: boolean;
  valueFontSize?: number;
  /** When rendered inside a dashboard tile, the tile already provides the card
   *  frame (border + shadow + padding). `embedded` drops KpiCard's own outer
   *  chrome (border, shadow, gradient top-bar) and tightens padding so the KPI
   *  doesn't read as a second nested card floating in empty space. Standalone
   *  Explore usage leaves this false and keeps the full standalone card. */
  embedded?: boolean;
};

const DEFAULT_ACCENT_COLOR = '#2563eb';
const FALLBACK_VALUE_COLOR = '#0f172a';

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

function formatNumericValue(
  value: number | string | null | undefined,
  options: {
    format?: NumberFormat;
    decimalPlaces?: number;
    currencySymbol?: string;
  },
): string {
  if (value === null || value === undefined || value === '') return '--';

  const numericValue = toNumber(value);
  if (numericValue === null) return String(value);

  const format = options.format ?? 'compact';
  const decimalPlaces = options.decimalPlaces ?? 1;
  const currencySymbol = options.currencySymbol || '$';
  const abs = Math.abs(numericValue);

  if (format === 'compact') {
    if (abs >= 1_000_000_000) return `${(numericValue / 1_000_000_000).toFixed(decimalPlaces)}B`;
    if (abs >= 1_000_000) return `${(numericValue / 1_000_000).toFixed(decimalPlaces)}M`;
    if (abs >= 1_000) return `${(numericValue / 1_000).toFixed(decimalPlaces)}K`;
    return numericValue.toLocaleString(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimalPlaces,
    });
  }

  if (format === 'percent') {
    return `${(numericValue * 100).toFixed(decimalPlaces)}%`;
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

function evaluateRule(value: number, rule: KpiValueColorRule): boolean {
  switch (rule.operator) {
    case '>':
      return value > rule.value;
    case '<':
      return value < rule.value;
    case '=':
      return value === rule.value;
    case '>=':
      return value >= rule.value;
    case '<=':
      return value <= rule.value;
    case '!=':
      return value !== rule.value;
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
    };
  }

  const positiveMovement = delta > 0;
  const isGood = goalDirection === 'down' ? !positiveMovement : positiveMovement;

  return {
    icon: positiveMovement ? TrendingUp : TrendingDown,
    surfaceClass: isGood ? 'bg-success/10' : 'bg-danger/10',
    textClass: isGood ? 'text-success' : 'text-danger',
    directionLabel: isGood ? 'Performing well' : 'Needs attention',
  };
}

export function KpiCard({
  value,
  label,
  comparison,
  format = 'compact',
  decimalPlaces = 1,
  currencySymbol = '$',
  contextTemplate,
  benchmarkValue,
  benchmarkLabel = 'Benchmark',
  showBenchmarkValue = true,
  showDelta = true,
  goalDirection = 'up',
  accentColor = DEFAULT_ACCENT_COLOR,
  enableColorRules = false,
  colorRules = [],
  rowCount,
  iconName,
  iconColor,
  accentBorder = false,
  gradientBg = false,
  valueFontSize,
  embedded = false,
}: KpiCardProps) {
  const IconComponent: React.ComponentType<{ className?: string; style?: React.CSSProperties }> | null =
    iconName && (LucideIcons as any)[iconName] ? (LucideIcons as any)[iconName] : null;
  const numericValue = toNumber(value);
  const numericBenchmark = toNumber(benchmarkValue);
  const matchedRule = enableColorRules && numericValue !== null
    ? colorRules.find((rule) => evaluateRule(numericValue, rule))
    : undefined;
  const formattedValue = formatNumericValue(value, { format, decimalPlaces, currencySymbol });
  const formattedBenchmark = formatNumericValue(numericBenchmark, { format, decimalPlaces, currencySymbol });
  const valueColor = matchedRule?.color || accentColor || FALLBACK_VALUE_COLOR;
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
    delta: formatNumericValue(delta, { format, decimalPlaces, currencySymbol }),
    deltaPercent: deltaPercent === null ? '--' : `${deltaPercent > 0 ? '+' : ''}${(deltaPercent * 100).toFixed(decimalPlaces)}%`,
    rows: typeof rowCount === 'number' ? rowCount.toLocaleString() : '0',
    label: label?.trim() || 'KPI',
  };
  const contextText = template ? interpolateTemplate(template, tokenMap) : '';
  const deltaAppearance = hasDelta && delta !== null ? getDeltaAppearance(delta, goalDirection) : null;
  const legacyComparison = typeof comparison === 'number' ? comparison : null;
  const legacyComparisonTone = legacyComparison !== null ? getLegacyComparisonTone(legacyComparison) : null;
  const DeltaIcon = deltaAppearance?.icon;
  const ComparisonIcon = legacyComparisonTone?.icon;
  const resolvedValueFontSize = typeof valueFontSize === 'number' && Number.isFinite(valueFontSize)
    ? Math.min(Math.max(Math.round(valueFontSize), 16), 80)
    : undefined;

  // Inside a dashboard tile the surrounding tile already draws the card frame.
  // Drop our own border/shadow/gradient-bar (unless the author opted into an
  // accent border) and tighten padding so the KPI fills the tile instead of
  // floating as a smaller nested card. See `embedded` prop doc.
  const showOwnFrame = !embedded || accentBorder;
  const showGradientBar = !embedded;

  return (
    <div
      className={`overflow-hidden ${showOwnFrame ? 'rounded-2xl border shadow-linear-sm' : ''} ${embedded ? '' : 'bg-surface-1'}`}
      style={{
        borderColor: showOwnFrame
          ? (accentBorder ? (accentColor || DEFAULT_ACCENT_COLOR) : 'rgb(var(--border-line))')
          : undefined,
        borderWidth: showOwnFrame ? (accentBorder ? 2 : 1) : undefined,
        background: gradientBg
          ? `linear-gradient(135deg, ${accentColor || DEFAULT_ACCENT_COLOR}10, transparent 60%)`
          : undefined,
      }}
    >
      {showGradientBar && (
        <div
          className="h-1.5 w-full"
          style={{
            background: `linear-gradient(90deg, ${accentColor || DEFAULT_ACCENT_COLOR}, ${valueColor})`,
          }}
        />
      )}

      <div className={embedded ? 'px-1 py-1' : 'p-6 sm:p-7'}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {(label || IconComponent) && (
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-text-tertiary">
                {IconComponent && (
                  <IconComponent
                    className="h-4 w-4"
                    style={{ color: iconColor || accentColor || DEFAULT_ACCENT_COLOR }}
                  />
                )}
                {label && <span>{label}</span>}
              </div>
            )}

            <div
              className="mt-3 break-words text-4xl font-semibold tracking-tight text-text-primary tabular-nums sm:text-5xl"
              style={{
                color: valueColor || FALLBACK_VALUE_COLOR,
                ...(resolvedValueFontSize ? { fontSize: resolvedValueFontSize, lineHeight: 1.08 } : {}),
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

          {statusLabel && (
            <span className="shrink-0 rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
              {statusLabel}
            </span>
          )}
        </div>

        {(showBenchmarkPanel || hasDelta || legacyComparison !== null) && (
          <div className="mt-5 grid gap-3 border-t border-[rgb(var(--border-line))] pt-4 sm:grid-cols-2">
            {showBenchmarkPanel && (
              <div className="rounded-xl bg-surface-2 px-4 py-3">
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
              <div className={`rounded-xl px-4 py-3 ${deltaAppearance.surfaceClass}`}>
                <div className={`text-[11px] font-semibold uppercase tracking-wide ${deltaAppearance.textClass}`}>
                  {deltaAppearance.directionLabel}
                </div>
                <div className={`mt-1 flex items-center gap-2 text-sm font-semibold tabular-nums ${deltaAppearance.textClass}`}>
                  <DeltaIcon className="h-4 w-4" />
                  <span>
                    {formatNumericValue(delta, { format, decimalPlaces, currencySymbol })}
                    {deltaPercent !== null && ` (${deltaPercent > 0 ? '+' : ''}${(deltaPercent * 100).toFixed(decimalPlaces)}%)`}
                  </span>
                </div>
              </div>
            )}

            {!hasDelta && legacyComparison !== null && legacyComparisonTone && ComparisonIcon && (
              <div className={`rounded-xl px-4 py-3 ${legacyComparisonTone.surfaceClass}`}>
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
