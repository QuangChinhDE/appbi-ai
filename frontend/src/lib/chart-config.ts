import type { ChartRoleConfig } from '@/components/explore/ExploreChartConfig';

export type SavedChartQueryMode = 'generated' | 'custom';

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getSavedChartQueryMode(
  config: Record<string, any> | null | undefined,
): SavedChartQueryMode {
  const mode = config?.queryMode === 'custom' ? 'custom' : 'generated';
  const customSql = typeof config?.customSql === 'string' ? config.customSql.trim() : '';
  return mode === 'custom' && customSql ? 'custom' : 'generated';
}

export function getActiveChartRoleConfig(
  config: Record<string, any> | null | undefined,
): ChartRoleConfig | null {
  if (!isRecord(config)) {
    return null;
  }

  const queryMode = getSavedChartQueryMode(config);
  if (queryMode === 'custom' && isRecord(config.customRoleConfig)) {
    return config.customRoleConfig as ChartRoleConfig;
  }
  if (queryMode === 'generated' && isRecord(config.generatedRoleConfig)) {
    return config.generatedRoleConfig as ChartRoleConfig;
  }
  if (isRecord(config.roleConfig)) {
    return config.roleConfig as ChartRoleConfig;
  }

  return null;
}
