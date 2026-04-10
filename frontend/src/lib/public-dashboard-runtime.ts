import { getRoleConfigDimensionFields } from '@/components/explore/ExploreChartConfig';
import { getActiveChartRoleConfig } from '@/lib/chart-config';
import {
  getColumnKey,
  getFriendlyFieldLabel,
  inferColumnTypeFromData,
  resolveChartSemanticField,
  type ColumnInfo,
} from '@/lib/filters';
import type { ChartDataResponse, DashboardChart } from '@/types/api';

interface PublicDashboardFilterRuntime {
  columns: ColumnInfo[];
  columnChartCount: Map<string, number>;
  distinctValues: Record<string, string[]>;
}

export function buildPublicDashboardFilterRuntime(
  dashboardCharts: DashboardChart[],
  chartData: Record<number, ChartDataResponse>,
): PublicDashboardFilterRuntime {
  const columns = new Map<string, ColumnInfo>();
  const chartCoverage = new Map<string, Set<number>>();
  const distinctValues = new Map<string, Set<string>>();
  const pageChartCount = dashboardCharts.length;

  for (const dashboardChart of dashboardCharts) {
    const payload = chartData[dashboardChart.chart_id];
    const chart = dashboardChart.chart;
    const rows = Array.isArray(payload?.data) ? payload.data : [];

    if (!chart || rows.length === 0) {
      continue;
    }

    const roleConfig = getActiveChartRoleConfig(
      (chart.config as Record<string, unknown> | undefined) ?? null,
    ) ?? { metrics: [] };
    const dimensionFields = getRoleConfigDimensionFields(
      chart.chart_type ?? chart.config?.chartType ?? '',
      roleConfig,
    ).filter((field): field is string => Boolean(field) && field in rows[0]);
    const fields = dimensionFields.length > 0 ? dimensionFields : Object.keys(rows[0]);
    const binding = chart.config?.semanticBinding ?? null;

    for (const field of fields) {
      const semanticField = resolveChartSemanticField(binding, field);
      const key = semanticField ?? field;

      if (!columns.has(key)) {
        columns.set(key, {
          key,
          name: field,
          label: getFriendlyFieldLabel(semanticField ?? field),
          datasetId: binding?.datasetId,
          semanticField: semanticField ?? undefined,
          type: inferColumnTypeFromData(field, rows),
        });
      }

      if (!chartCoverage.has(key)) {
        chartCoverage.set(key, new Set());
      }
      chartCoverage.get(key)!.add(dashboardChart.chart_id);

      if (!distinctValues.has(key)) {
        distinctValues.set(key, new Set());
      }
      const valueSet = distinctValues.get(key)!;
      for (const row of rows) {
        const value = row[field];
        if (value === null || value === undefined || String(value) === '') {
          continue;
        }
        valueSet.add(String(value));
      }
    }
  }

  const sortedColumns = Array.from(columns.values())
    .map((column) => {
      const key = getColumnKey(column);
      const coverage = chartCoverage.get(key)?.size ?? 0;
      return {
        ...column,
        chartCoverage: coverage,
        datasetChartCount: pageChartCount,
        sharedAcrossDataset: pageChartCount > 0 && coverage === pageChartCount,
      };
    })
    .sort((left, right) => {
      const leftShared = left.sharedAcrossDataset ? 1 : 0;
      const rightShared = right.sharedAcrossDataset ? 1 : 0;
      if (leftShared !== rightShared) return rightShared - leftShared;
      if ((left.chartCoverage ?? 0) !== (right.chartCoverage ?? 0)) {
        return (right.chartCoverage ?? 0) - (left.chartCoverage ?? 0);
      }
      return (left.label ?? left.name).localeCompare(right.label ?? right.name);
    });

  const normalizedDistinctValues: Record<string, string[]> = {};
  distinctValues.forEach((valueSet, key) => {
    normalizedDistinctValues[key] = Array.from(valueSet).sort();
  });

  return {
    columns: sortedColumns,
    columnChartCount: new Map(
      Array.from(chartCoverage.entries()).map(([key, ids]) => [key, ids.size]),
    ),
    distinctValues: normalizedDistinctValues,
  };
}
