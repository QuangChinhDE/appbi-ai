'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, SlidersHorizontal, X } from 'lucide-react';
import { ChartPreview } from '@/components/charts/ChartPreview';
import { ExploreChart } from '@/components/explore/ExploreChart';
import { metricKey, metricLabel } from '@/components/explore/ExploreChartConfig';
import { getActiveChartRoleConfig } from '@/lib/chart-config';
import { getEffectiveDashboardChartStyleConfig } from '@/lib/dashboard-chart-style';
import {
  getFriendlyFieldLabel,
  inferColumnTypeFromData,
  resolveChartSemanticField,
  type BaseFilter,
  type FilterOperator,
} from '@/lib/filters';
import type { Chart, ChartDataResponse, ChartSemanticBinding, DashboardChartLayout } from '@/types/api';

interface ReadonlyChartTileProps {
  chart: Chart | null | undefined;
  chartData?: ChartDataResponse | null;
  error?: string | null;
  title?: string;
  layout?: DashboardChartLayout | Record<string, any> | null;
  compact?: boolean;
  showChartTypeLabel?: boolean;
  onSelectCrossFilter?: (filter: BaseFilter | null) => void;
  isCrossFilterSource?: boolean;
}

export function ReadonlyChartTile({
  chart,
  chartData,
  error = null,
  title,
  layout = null,
  compact = false,
  showChartTypeLabel = true,
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
  const effectiveStyleConfig = useMemo(
    () => getEffectiveDashboardChartStyleConfig(chart, layout),
    [chart, layout],
  );

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
      className={`group h-full overflow-hidden rounded-[24px] border bg-surface-1 p-4 shadow-[0_28px_60px_-42px_rgba(15,23,42,0.45)] backdrop-blur transition-[border-color,box-shadow] ${
        isCrossFilterSource
          ? 'border-sky-300 ring-4 ring-sky-100/80 shadow-[0_32px_72px_-42px_rgba(14,165,233,0.4)]'
          : 'border-[rgb(var(--border-line))]/80 hover:border-[rgb(var(--border-strong))]/90 hover:shadow-[0_32px_72px_-48px_rgba(15,23,42,0.42)]'
      }`}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className={`mb-3 flex min-h-[2.5rem] items-start gap-3 ${compact ? 'text-xs' : 'text-sm'}`}>
          <div className="min-w-0 flex-1">
            {title ? (
              <p className="truncate font-semibold text-text-primary">{title}</p>
            ) : (
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">
                Untitled chart
              </p>
            )}
            {showChartTypeLabel && chart?.chart_type && (
              <p className="mt-1 truncate text-[11px] text-text-quaternary">
                {String(chart.chart_type).replace(/_/g, ' ')}
              </p>
            )}
          </div>
          {havingOptions.length > 0 && (
            <button
              onClick={() => setIsHavingOpen((current) => !current)}
                className={`ml-auto flex-shrink-0 rounded-full border border-transparent bg-surface-1 p-1.5 transition ${
                isHavingOpen || havingFilters.length > 0
                  ? 'border-sky-200 bg-sky-50 text-sky-700 opacity-100'
                  : 'text-text-quaternary opacity-0 group-hover:opacity-100 hover:border-[rgb(var(--border-line))] hover:bg-surface-2 hover:text-text-primary'
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
                className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2 py-1 text-xs text-sky-700"
              >
                <span className="font-mono text-[0.6rem] uppercase opacity-60">having</span>
                {havingOptions.find((option) => option.key === filter.field)?.label ?? filter.field}
                {` ${filter.operator} ${filter.value}`}
                <button
                  onClick={() => setHavingFilters((current) => current.filter((item) => item.id !== filter.id))}
                  className="text-sky-400 hover:text-text-primary"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}

        {isHavingOpen && havingOptions.length > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5 rounded-[18px] border border-sky-100 bg-sky-50/70 p-2.5">
            <select
              value={draftHavingField}
              onChange={(event) => setDraftHavingField(event.target.value)}
              className="rounded-lg border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1 text-xs text-text-secondary focus:outline-none focus:ring-1 focus:ring-sky-400"
            >
              {havingOptions.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
            <select
              value={draftHavingOp}
              onChange={(event) => setDraftHavingOp(event.target.value as FilterOperator)}
              className="rounded-lg border border-[rgb(var(--border-strong))] bg-surface-1 px-2 py-1 text-xs text-text-secondary focus:outline-none focus:ring-1 focus:ring-sky-400"
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
              className="w-24 rounded-lg border border-[rgb(var(--border-strong))] px-2 py-1 text-xs text-text-secondary focus:outline-none focus:ring-1 focus:ring-sky-400"
            />
            <button
              onClick={confirmHaving}
              className="rounded-lg bg-surface-inverse px-2.5 py-1 text-xs text-white hover:bg-surface-3"
            >
              Apply
            </button>
            {havingFilters.length > 0 && (
              <button
                onClick={() => setHavingFilters([])}
                className="text-xs text-text-tertiary hover:text-text-secondary"
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
                <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-warning" />
                <p className={`${compact ? 'text-xs' : 'text-sm'} font-medium text-warning`}>
                  Chart metadata unavailable
                </p>
              </div>
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center text-center">
              <div>
                <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-warning" />
                <p className={`${compact ? 'text-xs' : 'text-sm'} font-medium text-warning`}>
                  Failed to load chart
                </p>
                <p className="mt-1 text-xs text-warning">{error}</p>
              </div>
            </div>
          ) : !chartData ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-sky-500" />
            </div>
          ) : roleConfig ? (
            <ExploreChart
              type={chart.chart_type}
              data={chartData.data}
              roleConfig={roleConfig}
              styleConfig={effectiveStyleConfig}
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
              styleConfig={effectiveStyleConfig}
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
