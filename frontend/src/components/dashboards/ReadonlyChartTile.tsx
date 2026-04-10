'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, SlidersHorizontal, X } from 'lucide-react';
import { ChartPreview } from '@/components/charts/ChartPreview';
import { ExploreChart } from '@/components/explore/ExploreChart';
import { metricKey, metricLabel, normalizeChartStyleConfig } from '@/components/explore/ExploreChartConfig';
import { getActiveChartRoleConfig } from '@/lib/chart-config';
import {
  getFriendlyFieldLabel,
  inferColumnTypeFromData,
  resolveChartSemanticField,
  type BaseFilter,
  type FilterOperator,
} from '@/lib/filters';
import type { Chart, ChartDataResponse, ChartSemanticBinding } from '@/types/api';

interface ReadonlyChartTileProps {
  chart: Chart | null | undefined;
  chartData?: ChartDataResponse | null;
  error?: string | null;
  title?: string;
  compact?: boolean;
  onSelectCrossFilter?: (filter: BaseFilter | null) => void;
  isCrossFilterSource?: boolean;
}

export function ReadonlyChartTile({
  chart,
  chartData,
  error = null,
  title,
  compact = false,
  onSelectCrossFilter,
  isCrossFilterSource = false,
}: ReadonlyChartTileProps) {
  const roleConfig = getActiveChartRoleConfig(
    (chart?.config as Record<string, unknown> | undefined) ?? null,
  );
  const [havingFilters, setHavingFilters] = useState<BaseFilter[]>([]);
  const [isHavingOpen, setIsHavingOpen] = useState(false);
  const [draftHavingField, setDraftHavingField] = useState('');
  const [draftHavingOp, setDraftHavingOp] = useState<FilterOperator>('gt');
  const [draftHavingValue, setDraftHavingValue] = useState('');
  const chartSemanticBinding = (
    chart?.config
    && typeof chart.config === 'object'
    && typeof (chart.config as Record<string, unknown>).semanticBinding === 'object'
  )
    ? ((chart.config as Record<string, unknown>).semanticBinding as ChartSemanticBinding)
    : null;

  const handleCrossFilterSelection = (selection: { field: string; value: unknown } | null) => {
    if (!onSelectCrossFilter) return;
    if (!selection || selection.value === undefined || selection.value === null || selection.value === '') {
      onSelectCrossFilter(null);
      return;
    }

    const semanticField = resolveChartSemanticField(chartSemanticBinding, selection.field);
    if (!semanticField || chartSemanticBinding?.datasetId == null) {
      onSelectCrossFilter(null);
      return;
    }

    const rows = chartData?.data ?? [];
    const inferredType = inferColumnTypeFromData(selection.field, rows);
    const filterType = inferredType === 'date'
      ? 'date'
      : inferredType === 'number'
        ? 'number'
        : 'text';
    const value = filterType === 'number'
      ? Number(selection.value)
      : String(selection.value);

    if ((filterType === 'number' && Number.isNaN(value)) || value === '') {
      onSelectCrossFilter(null);
      return;
    }

    onSelectCrossFilter({
      id: `public-cross-${chart?.id ?? 'chart'}-${selection.field}-${String(value)}`,
      field: selection.field,
      fieldKey: semanticField,
      semanticField,
      datasetId: chartSemanticBinding.datasetId,
      type: filterType,
      operator: 'eq',
      value,
      label: getFriendlyFieldLabel(selection.field),
    });
  };

  const havingOptions = useMemo<Array<{ key: string; label: string }>>(
    () => (
      Array.isArray((roleConfig as any)?.metrics)
        ? (roleConfig as any).metrics.map((metric: any) => ({
            key: metricKey(metric),
            label: metricLabel(metric),
          }))
        : []
    ),
    [roleConfig],
  );

  useEffect(() => {
    if (havingOptions.length > 0 && !draftHavingField) {
      setDraftHavingField(havingOptions[0].key);
    }
  }, [draftHavingField, havingOptions]);

  const confirmHaving = () => {
    const field = draftHavingField || havingOptions[0]?.key;
    if (!field || draftHavingValue === '') return;

    setHavingFilters((current) => [
      ...current,
      {
        id: `public-hv-${Date.now()}`,
        field,
        type: 'number',
        operator: draftHavingOp,
        value: Number(draftHavingValue),
      },
    ]);
    setDraftHavingValue('');
    setIsHavingOpen(false);
  };

  return (
    <div
      className={`group h-full overflow-hidden rounded-lg border bg-white p-3 shadow-sm ${
        isCrossFilterSource
          ? 'border-amber-300 ring-1 ring-amber-200'
          : 'border-gray-200'
      }`}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className={`mb-2 flex min-h-[1.5rem] items-center ${compact ? 'text-xs' : 'text-sm'}`}>
          {title ? (
            <p className="truncate font-semibold text-gray-800">{title}</p>
          ) : (
            <span />
          )}
          {havingOptions.length > 0 && (
            <button
              onClick={() => setIsHavingOpen((current) => !current)}
              className={`ml-auto flex-shrink-0 transition-opacity ${
                isHavingOpen || havingFilters.length > 0
                  ? 'opacity-100 text-indigo-600'
                  : 'opacity-0 group-hover:opacity-100 text-gray-400 hover:text-indigo-600'
              }`}
              title="Per-chart filters"
            >
              <SlidersHorizontal className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
            </button>
          )}
        </div>

        {havingFilters.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {havingFilters.map((filter) => (
              <span
                key={filter.id}
                className="inline-flex items-center gap-1 rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-700"
              >
                <span className="font-mono text-[0.6rem] uppercase opacity-60">having</span>
                {havingOptions.find((option) => option.key === filter.field)?.label ?? filter.field}
                {` ${filter.operator} ${filter.value}`}
                <button
                  onClick={() => setHavingFilters((current) => current.filter((item) => item.id !== filter.id))}
                  className="text-indigo-400 hover:text-indigo-700"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}

        {isHavingOpen && havingOptions.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded border border-indigo-100 bg-indigo-50/60 p-2">
            <select
              value={draftHavingField}
              onChange={(event) => setDraftHavingField(event.target.value)}
              className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"
            >
              {havingOptions.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
            <select
              value={draftHavingOp}
              onChange={(event) => setDraftHavingOp(event.target.value as FilterOperator)}
              className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"
            >
              <option value="gt">&gt; greater than</option>
              <option value="gte">≥ greater or equal</option>
              <option value="lt">&lt; less than</option>
              <option value="lte">≤ less or equal</option>
              <option value="eq">= equals</option>
              <option value="neq">≠ not equals</option>
            </select>
            <input
              type="number"
              value={draftHavingValue}
              onChange={(event) => setDraftHavingValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') confirmHaving();
                if (event.key === 'Escape') setIsHavingOpen(false);
              }}
              placeholder="value"
              className="w-20 rounded border border-gray-300 px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
            <button
              onClick={confirmHaving}
              className="rounded bg-indigo-500 px-2 py-0.5 text-xs text-white hover:bg-indigo-600"
            >
              Apply
            </button>
            {havingFilters.length > 0 && (
              <button
                onClick={() => setHavingFilters([])}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                Clear all
              </button>
            )}
          </div>
        )}

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
              havingFilters={havingFilters}
              preAggregated={chartData.pre_aggregated ?? false}
              onSelectDataPoint={onSelectCrossFilter && chartSemanticBinding?.datasetId != null
                ? handleCrossFilterSelection
                : undefined}
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
              onSelectDataPoint={onSelectCrossFilter && chartSemanticBinding?.datasetId != null
                ? handleCrossFilterSelection
                : undefined}
            />
          )}
        </div>
      </div>
    </div>
  );
}
