'use client';

import React from 'react';
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
      surfaceClass: 'bg-emerald-50',
      textClass: 'text-emerald-700',
    };
  }
  if (comparison < 0) {
    return {
      icon: TrendingDown,
      surfaceClass: 'bg-rose-50',
      textClass: 'text-rose-700',
    };
  }
  return {
    icon: Minus,
    surfaceClass: 'bg-slate-100',
    textClass: 'text-slate-600',
  };
}

function getDeltaAppearance(delta: number, goalDirection: KpiGoalDirection) {
  if (delta === 0) {
    return {
      icon: Minus,
      surfaceClass: 'bg-slate-100',
      textClass: 'text-slate-600',
      directionLabel: 'On target',
    };
  }

  const positiveMovement = delta > 0;
  const isGood = goalDirection === 'down' ? !positiveMovement : positiveMovement;

  return {
    icon: positiveMovement ? TrendingUp : TrendingDown,
    surfaceClass: isGood ? 'bg-emerald-50' : 'bg-rose-50',
    textClass: isGood ? 'text-emerald-700' : 'text-rose-700',
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
}: KpiCardProps) {
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

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div
        className="h-1.5 w-full"
        style={{
          background: `linear-gradient(90deg, ${accentColor || DEFAULT_ACCENT_COLOR}, ${valueColor})`,
        }}
      />

      <div className="p-6 sm:p-7">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            {label && (
              <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">
                {label}
              </div>
            )}

            <div
              className="mt-3 break-words text-4xl font-semibold tracking-tight text-slate-900 tabular-nums sm:text-5xl"
              style={{ color: valueColor || FALLBACK_VALUE_COLOR }}
            >
              {formattedValue}
            </div>

            {contextText && (
              <div className="mt-3 whitespace-pre-line text-sm leading-6 text-slate-600">
                {contextText}
              </div>
            )}
          </div>

          {statusLabel && (
            <span className="shrink-0 rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
              {statusLabel}
            </span>
          )}
        </div>

        {(showBenchmarkPanel || hasDelta || legacyComparison !== null) && (
          <div className="mt-5 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2">
            {showBenchmarkPanel && (
              <div className="rounded-xl bg-slate-50 px-4 py-3">
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  <Target className="h-3.5 w-3.5" />
                  <span>{benchmarkLabel?.trim() || 'Benchmark'}</span>
                </div>
                <div className="mt-1 text-sm font-semibold text-slate-800 tabular-nums">
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
