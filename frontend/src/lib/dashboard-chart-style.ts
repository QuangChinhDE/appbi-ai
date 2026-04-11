import { normalizeChartStyleConfig, type ChartStyleConfig } from '@/components/explore/ExploreChartConfig';
import type { Chart, DashboardChartLayout } from '@/types/api';

type LayoutLike = DashboardChartLayout | Record<string, any> | null | undefined;

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => deepEqual(left[key], right[key]));
  }

  return false;
}

function getChartConfig(chart: Pick<Chart, 'config'> | null | undefined): Record<string, any> {
  return (chart?.config as Record<string, any> | undefined) ?? {};
}

export function getDashboardChartStyleOverride(layout: LayoutLike): Partial<ChartStyleConfig> | undefined {
  const override = layout?.styleConfigOverride;
  return isPlainObject(override) ? override as Partial<ChartStyleConfig> : undefined;
}

export function getBaseChartStyleConfig(chart: Pick<Chart, 'config'> | null | undefined): ChartStyleConfig {
  const config = getChartConfig(chart);
  return normalizeChartStyleConfig(config.styleConfig, config.conditional_formatting);
}

export function getEffectiveDashboardChartStyleConfig(
  chart: Pick<Chart, 'config'> | null | undefined,
  layout: LayoutLike,
): ChartStyleConfig {
  const config = getChartConfig(chart);
  const baseStyleConfig = getBaseChartStyleConfig(chart);
  const styleOverride = getDashboardChartStyleOverride(layout);

  return normalizeChartStyleConfig(
    styleOverride ? { ...baseStyleConfig, ...styleOverride } : baseStyleConfig,
    config.conditional_formatting,
  );
}

export function buildDashboardChartStyleOverride(
  baseStyleConfig: ChartStyleConfig,
  nextStyleConfig: ChartStyleConfig,
): Partial<ChartStyleConfig> | undefined {
  const normalizedBase = normalizeChartStyleConfig(baseStyleConfig);
  const normalizedNext = normalizeChartStyleConfig(nextStyleConfig);
  const override: Partial<ChartStyleConfig> = {};

  for (const key of Object.keys(normalizedNext) as Array<keyof ChartStyleConfig>) {
    if (!deepEqual(normalizedBase[key], normalizedNext[key])) {
      (override as Record<string, unknown>)[key] = normalizedNext[key];
    }
  }

  return Object.keys(override).length > 0 ? override : undefined;
}

export function buildDashboardChartLayoutWithStyleOverride(
  layout: LayoutLike,
  styleOverride: Partial<ChartStyleConfig> | undefined,
): Record<string, any> {
  const nextLayout = isPlainObject(layout) ? { ...layout } : {};
  delete nextLayout.styleConfigOverride;

  if (styleOverride && Object.keys(styleOverride).length > 0) {
    nextLayout.styleConfigOverride = styleOverride;
  }

  return nextLayout;
}
