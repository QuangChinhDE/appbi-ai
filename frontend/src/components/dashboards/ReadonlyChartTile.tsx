'use client';

import { AlertTriangle, Loader2 } from 'lucide-react';
import { ChartPreview } from '@/components/charts/ChartPreview';
import { ExploreChart } from '@/components/explore/ExploreChart';
import { normalizeChartStyleConfig } from '@/components/explore/ExploreChartConfig';
import { getActiveChartRoleConfig } from '@/lib/chart-config';
import type { Chart, ChartDataResponse } from '@/types/api';

interface ReadonlyChartTileProps {
  chart: Chart | null | undefined;
  chartData?: ChartDataResponse | null;
  error?: string | null;
  title?: string;
  compact?: boolean;
}

export function ReadonlyChartTile({
  chart,
  chartData,
  error = null,
  title,
  compact = false,
}: ReadonlyChartTileProps) {
  const roleConfig = getActiveChartRoleConfig(
    (chart?.config as Record<string, unknown> | undefined) ?? null,
  );

  return (
    <div className="h-full overflow-hidden rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      <div className="flex h-full min-h-0 flex-col">
        <div className={`mb-2 flex min-h-[1.5rem] items-center ${compact ? 'text-xs' : 'text-sm'}`}>
          {title ? (
            <p className="truncate font-semibold text-gray-800">{title}</p>
          ) : (
            <span />
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          {!chart ? (
            <div className="flex h-full items-center justify-center text-center">
              <div>
                <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-amber-500" />
                <p className={`${compact ? 'text-xs' : 'text-sm'} font-medium text-amber-700`}>
                  Chart metadata unavailable
                </p>
              </div>
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center text-center">
              <div>
                <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-amber-500" />
                <p className={`${compact ? 'text-xs' : 'text-sm'} font-medium text-amber-700`}>
                  Failed to load chart
                </p>
                <p className="mt-1 text-xs text-amber-600">{error}</p>
              </div>
            </div>
          ) : !chartData ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
            </div>
          ) : roleConfig ? (
            <ExploreChart
              type={chart.chart_type}
              data={chartData.data}
              roleConfig={roleConfig}
              styleConfig={normalizeChartStyleConfig(
                (chart.config as any)?.styleConfig,
                (chart.config as any)?.conditional_formatting,
              )}
              preAggregated={chartData.pre_aggregated ?? false}
            />
          ) : (
            <ChartPreview
              chartType={chart.chart_type}
              data={chartData.data}
              config={(chart.config as any) ?? {}}
              styleConfig={normalizeChartStyleConfig(
                (chart.config as any)?.styleConfig,
                (chart.config as any)?.conditional_formatting,
              )}
            />
          )}
        </div>
      </div>
    </div>
  );
}
