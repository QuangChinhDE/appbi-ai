'use client';

/**
 * Renders a chart embedded inside a chat message.
 * Reuses ExploreChart (Recharts) — no new rendering logic.
 * roleConfig is the explore_config.roleConfig from the AI tool result.
 */
import React from 'react';
import Link from 'next/link';
import { ExternalLink, BarChart3 } from 'lucide-react';
import { ExploreChart } from '@/components/explore/ExploreChart';
import type { ChartRoleConfig } from '@/components/explore/ExploreChartConfig';

export interface EmbeddedChartProps {
  chartId: number;
  chartName: string;
  chartType: string;
  data: Array<Record<string, any>>;
  roleConfig?: ChartRoleConfig | null;
}

export function EmbeddedChart({ chartId, chartName, chartType, data, roleConfig }: EmbeddedChartProps) {
  // Derive a safe roleConfig if none provided
  const safeRoleConfig: ChartRoleConfig = roleConfig ?? deriveRoleConfig(data, chartType);

  return (
    <div className="mb-2 mt-3 overflow-hidden rounded-xl border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[rgb(var(--border-line))] bg-surface-2">
        <div className="flex items-center gap-2 min-w-0">
          <BarChart3 className="h-4 w-4 text-brand flex-shrink-0" />
          <span className="text-sm font-medium text-text-secondary truncate">{chartName}</span>
          <span className="text-xs text-text-quaternary flex-shrink-0">
            {chartType.toLowerCase().replace('_', ' ')} · {data.length} rows
          </span>
        </div>
        <Link
          href={`/explore/${chartId}`}
          target="_blank"
          className="flex items-center gap-1 text-xs text-brand hover:text-brand transition-colors flex-shrink-0 ml-2"
        >
          Explore <ExternalLink className="h-3 w-3" />
        </Link>
      </div>

      {/* Chart body */}
      <div className="p-3">
        {data.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-text-quaternary text-sm">No data</div>
        ) : (
          <div className="h-64">
            <ExploreChart
              type={chartType}
              data={data}
              roleConfig={safeRoleConfig}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Derive a minimal roleConfig from raw data when no config is provided.
 * Picks the first string column as dimension and all numeric columns as metrics.
 */
function deriveRoleConfig(data: Array<Record<string, any>>, chartType: string): ChartRoleConfig {
  if (!data || data.length === 0) return { metrics: [] };

  const sample = data[0];
  const keys = Object.keys(sample);

  const stringKeys = keys.filter(k => typeof sample[k] === 'string' || isNaN(Number(sample[k])));
  const numericKeys = keys.filter(k => typeof sample[k] === 'number' || (!isNaN(Number(sample[k])) && sample[k] !== ''));

  const dimension = stringKeys[0] ?? keys[0];
  const metrics = numericKeys.slice(0, 3).map(field => ({ field, agg: 'sum' as const }));

  return {
    dimension,
    metrics: metrics.length > 0 ? metrics : [{ field: keys[1] ?? keys[0], agg: 'sum' }],
  };
}
