'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AlertTriangle, Loader2, SlidersHorizontal, X } from 'lucide-react';
import { ChartPreview } from '@/components/charts/ChartPreview';
import { ExploreChart } from '@/components/explore/ExploreChart';
import { useDashboardChartTheme } from '@/components/dashboards/DashboardThemeProvider';
import { useDatasetModel } from '@/hooks/use-dataset-model';
import { buildSemanticLabelMap, buildSemanticFormatMap } from '@/lib/chart-semantic-maps';
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
import type { Chart, ChartDataResponse, ChartSemanticBinding, DashboardChartLayout, TimeGranularity } from '@/types/api';

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
  /** Fires once when the tile first scrolls into view (or its 300px buffer). */
  onVisible?: () => void;
  /** When true, suppresses lazy gating (used during PDF export to render every tile). */
  forceVisible?: boolean;
  /** Phase-B19 — public viewer dataset models {datasetId: model}, served by the
   *  public dashboard response so the tile builds label/format maps without an
   *  authed /datasets/{id}/model call (which would 401 → redirect to /login). */
  publicDatasetModels?: Record<string, any> | null;
  /** #2 — public viewer date-hierarchy: current drill grain + handler. The
   *  parent page owns the grain state and re-fetches this chart's data at the
   *  chosen grain (BE re-query). */
  viewerGrain?: string;
  onViewerDrill?: (grain: TimeGranularity | undefined) => void;
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
  onVisible,
  forceVisible = false,
  publicDatasetModels = null,
  viewerGrain,
  onViewerDrill,
}: ReadonlyChartTileProps) {
  // Track first viewport entry. Sticky once seen so scrolling away doesn't
  // re-trigger fetch. forceVisible bypasses gating during PDF export.
  const visibilityRef = useRef<HTMLDivElement | null>(null);
  const [hasBeenVisible, setHasBeenVisible] = useState<boolean>(forceVisible);
  useEffect(() => {
    if (forceVisible) {
      setHasBeenVisible(true);
      return;
    }
    if (hasBeenVisible) return;
    const node = visibilityRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setHasBeenVisible(true);
      onVisible?.();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setHasBeenVisible(true);
          onVisible?.();
          observer.disconnect();
        }
      },
      { rootMargin: '300px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [forceVisible, hasBeenVisible, onVisible]);
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
  // Semantic label/format maps so the published (readonly) tile renders the
  // chart identically to Explore — preserves measure percent/currency format.
  const roDatasetId = chartSemanticBinding?.datasetId
    ?? ((chart?.config as any)?.dataset_id ?? null);
  // Phase-B19 — on the PUBLIC link the viewer has no AppBI account, so we must
  // NOT hit the authed /datasets/{id}/model endpoint (it 401s → redirect to
  // /login). When the public response supplies dataset models, use them and
  // disable the authed fetch (passing null → useQuery disabled).
  const { data: hookDatasetModel } = useDatasetModel(
    publicDatasetModels ? null : (typeof roDatasetId === 'number' ? roDatasetId : null),
  );
  const roDatasetModel = publicDatasetModels
    ? (typeof roDatasetId === 'number' ? publicDatasetModels[String(roDatasetId)] : undefined)
    : hookDatasetModel;
  const roLabelMap = useMemo(() => buildSemanticLabelMap(roDatasetModel?.views), [roDatasetModel]);
  const roFormatMap = useMemo(() => buildSemanticFormatMap(roDatasetModel?.views), [roDatasetModel]);
  const effectiveStyleConfig = useMemo(
    () => getEffectiveDashboardChartStyleConfig(chart, layout),
    [chart, layout],
  );
  // Phase-B11 (revised) — PRIORITY: per-tile custom title (passed as `title` =
  // layout.custom_title) wins; otherwise fall back to the chart's Explore
  // title/name. (Earlier draft dropped the name fallback — wrong.)
  const configuredChartTitle =
    effectiveStyleConfig.chartTitle?.trim()
    || (typeof (chart?.config as any)?.title === 'string' ? (chart?.config as any).title.trim() : '');
  const customTileTitle = typeof title === 'string' ? title.trim() : '';
  const chartNameTrim = typeof chart?.name === 'string' ? chart.name.trim() : '';
  const displayTitle = customTileTitle || configuredChartTitle || chartNameTrim;
  // Phase-B15 — dashboard theme title font/color (empty {} when unthemed).
  const dashTheme = useDashboardChartTheme();
  const themeTitleStyle: CSSProperties | undefined =
    dashTheme.titleFontSize || dashTheme.titleColor
      ? { fontSize: dashTheme.titleFontSize, color: dashTheme.titleColor }
      : undefined;
  // Phase-B10 — KPI/Card visuals render their OWN metric label inside the card
  // (e.g. "TOTAL REVENUE"), so the tile-level title is a redundant second
  // heading ("DA1 KPI" stacked above "TOTAL REVENUE"). Suppress the tile title
  // for KPI — the card's label is the title (matches PBI Card visuals).
  const isKpiCard = String(chart?.chart_type || '').toUpperCase() === 'KPI';
  // PBI parity (2026-06) — surface filters the BE could not apply to THIS
  // chart (field unrelated to the visual's table, or a malformed join). The
  // engine reports these in `debug.dropped_filters`; previously only the
  // editor-facing ChartTile rendered a badge AND it was gated behind canEdit,
  // so a viewer/public reader saw a number silently computed WITHOUT the
  // filter they applied (the DA's "mông lung"). PowerBI shows every consumer
  // when a slicer doesn't reach a visual; we do the same here.
  const droppedByBackend = chartData?.debug?.dropped_filters ?? [];
  const chartRenderStyleConfig = useMemo(() => {
    if (!effectiveStyleConfig.chartTitle) return effectiveStyleConfig;
    return { ...effectiveStyleConfig, chartTitle: '' };
  }, [effectiveStyleConfig]);
  const legacyRenderChartConfig = useMemo(
    () => ({ ...((chart?.config as any) ?? {}), title: undefined }),
    [chart?.config],
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

  if (!hasBeenVisible) {
    return (
      <div
        ref={visibilityRef}
        className="dashboard-tile h-full rounded-lg border border-[rgb(var(--border-line))] bg-surface-1"
        aria-hidden="true"
      />
    );
  }

  return (
    <div
      /* Phase-B4 — flat "BI card": 8px radius, 1px hairline border, NO heavy
         drop-shadow/backdrop-blur (read as a web card before), tighter padding.
         Phase-B14 — honor the dashboard theme's card radius/border. */
      className={`dashboard-tile group relative h-full overflow-hidden rounded-lg border bg-surface-1 p-3 transition-colors ${
        isCrossFilterSource
          ? 'border-sky-300 ring-2 ring-sky-100'
          : 'border-[rgb(var(--border-line))] hover:border-[rgb(var(--border-strong))]'
      }`}
      style={{
        borderRadius: 'var(--dashboard-card-radius, 0.5rem)',
        borderWidth: 'var(--dashboard-card-border-width, 1px)',
        ...(isCrossFilterSource
          ? {}
          : { borderColor: 'var(--dashboard-card-border-color, rgb(var(--border-line)))' }),
        // Phase-B16 — translucent "glass" tile that floats over a bg image.
        ...(dashTheme.cardBg
          ? {
              background: dashTheme.cardBg,
              backdropFilter: dashTheme.cardBackdrop,
              WebkitBackdropFilter: dashTheme.cardBackdrop,
              boxShadow: '0 10px 30px -14px rgba(2, 6, 23, 0.45)',
            }
          : {}),
      }}
    >
      <div className="flex h-full min-h-0 flex-col">
        {/* Phase-B11 — render the header row ONLY when it has real content
            (a set title, a dropped-filter badge, or the HAVING control); an
            empty header band above an untitled chart was pure wasted space. */}
        {/* Action cluster = dropped-filter badge + per-chart-filter toggle.
            Non-KPI charts render it in the header row beside the title. KPI
            cards have NO header title (the label lives inside the card), so the
            cluster floats top-right of the tile — parallel to the in-card
            label — instead of leaving an empty title band above the value.
            (Phase-B10/B11 + 2026-06 card-header consistency.) */}
        {(() => {
          const droppedBadge = droppedByBackend.length > 0 ? (
            <span
              className="flex-shrink-0 inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
              title={(() => {
                const lines: string[] = [
                  `Biểu đồ này không áp được ${droppedByBackend.length} filter:`,
                ];
                for (const d of droppedByBackend) {
                  const ref = d.semantic_field || d.field || '(không rõ field)';
                  lines.push(`• ${ref} — ${d.detail || d.reason}`);
                }
                return lines.join('\n');
              })()}
            >
              <AlertTriangle className="h-3 w-3" />
              {droppedByBackend.length} bỏ qua
            </span>
          ) : null;
          const havingToggle = havingOptions.length > 0 ? (
            <button
              onClick={() => setIsHavingOpen((current) => !current)}
              className={`flex-shrink-0 rounded-full border border-transparent bg-surface-1 p-1.5 transition ${
                isHavingOpen || havingFilters.length > 0
                  ? 'border-sky-200 bg-sky-50 text-sky-700 opacity-100'
                  : 'text-text-quaternary opacity-0 group-hover:opacity-100 hover:border-[rgb(var(--border-line))] hover:bg-surface-2 hover:text-text-primary'
              }`}
              title="Per-chart filters"
            >
              <SlidersHorizontal className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
            </button>
          ) : null;
          const hasActions = Boolean(droppedBadge || havingToggle);

          // KPI: float actions top-right, no header band — the card label is
          // the title and the value stays the focus.
          if (isKpiCard) {
            return hasActions ? (
              <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
                {droppedBadge}
                {havingToggle}
              </div>
            ) : null;
          }

          // Non-KPI: render the header row only when it has real content.
          const showHeader = Boolean(displayTitle || (showChartTypeLabel && chart?.chart_type) || hasActions);
          if (!showHeader) return null;
          return (
            <div className={`mb-2 flex min-h-[1.5rem] items-start gap-3 ${compact ? 'text-xs' : 'text-[13px]'}`}>
              <div className="min-w-0 flex-1">
                {displayTitle && (
                  <p data-pdf-tile-title className="truncate font-medium text-text-secondary" style={themeTitleStyle}>{displayTitle}</p>
                )}
                {showChartTypeLabel && chart?.chart_type && (
                  <p className="mt-1 truncate text-[11px] text-text-quaternary">
                    {String(chart.chart_type).replace(/_/g, ' ')}
                  </p>
                )}
              </div>
              {hasActions && (
                <div className="ml-auto flex flex-shrink-0 items-center gap-1">
                  {droppedBadge}
                  {havingToggle}
                </div>
              )}
            </div>
          );
        })()}

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
              styleConfig={chartRenderStyleConfig}
              labelMap={roLabelMap}
              formatMap={roFormatMap}
              havingFilters={havingFilters}
              preAggregated={chartData.pre_aggregated ?? false}
              embedded
              viewerGrain={viewerGrain}
              onViewerDrill={onViewerDrill}
              onSelectDataPoint={onSelectCrossFilter && chartSemanticBinding?.datasetId != null
                ? handleCrossFilterSelection
                : undefined}
            />
          ) : (
            <ChartPreview
              chartType={chart.chart_type}
              data={chartData.data}
              config={legacyRenderChartConfig}
              styleConfig={chartRenderStyleConfig}
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
