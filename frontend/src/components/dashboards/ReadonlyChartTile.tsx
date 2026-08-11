'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AlertTriangle, Loader2, SlidersHorizontal, X } from 'lucide-react';
import { ChartPreview } from '@/components/charts/ChartPreview';
import { ExploreChart } from '@/components/explore/ExploreChart';
import { useDashboardChartTheme } from '@/components/dashboards/DashboardThemeProvider';
import { useDatasetModel } from '@/hooks/use-dataset-model';
import { useI18n } from '@/providers/LanguageProvider';
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
  /** Cross-highlight (PBI-parity). The active selection's P filter (resolved at
   *  the page level). Source tile dims its own non-selected marks locally;
   *  target tiles receive `highlightData` (the P-filtered subset, same row
   *  shape as chartData.data) which the parent page fetches. */
  highlightFilter?: BaseFilter | null;
  isHighlightSource?: boolean;
  highlightData?: Record<string, any>[] | null;
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
  /** Per-tile lock: hide the group-by grain switcher for this public/embed
   *  viewer (the chart stays on its configured default grain). */
  lockDateGrain?: boolean;
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
  highlightFilter = null,
  isHighlightSource = false,
  highlightData = null,
  onVisible,
  forceVisible = false,
  publicDatasetModels = null,
  viewerGrain,
  onViewerDrill,
  lockDateGrain = false,
}: ReadonlyChartTileProps) {
  const { t } = useI18n();
  // Track first viewport entry. Sticky once seen so scrolling away doesn't
  // re-trigger fetch. forceVisible bypasses gating during PDF export.
  const visibilityRef = useRef<HTMLDivElement | null>(null);
  const [hasBeenVisible, setHasBeenVisible] = useState<boolean>(forceVisible);
  useEffect(() => {
    if (forceVisible) {
      setHasBeenVisible(true);
      // Report visibility too: the parent gates its chart-data fetch on the set
      // of tiles that have reported in, so a force-visible tile that stayed
      // silent rendered forever-empty on the print/export surface.
      onVisible?.();
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
  // Per-tile "transparent background": drop the card bg/border/shadow so the
  // dashboard's own background shows through (frameless). Cross-filter/highlight
  // rings still render (Tailwind ring = box-shadow, independent of the border).
  const transparentTile = effectiveStyleConfig.transparentBackground === true;
  const themeTitleStyle: CSSProperties | undefined =
    dashTheme.titleFontSize || dashTheme.titleColor
      ? { fontSize: dashTheme.titleFontSize, color: dashTheme.titleColor }
      : undefined;
  // Phase-B10 — KPI/Card visuals render their OWN metric label inside the card
  // (e.g. "TOTAL REVENUE"), so the tile-level title is a redundant second
  // heading ("DA1 KPI" stacked above "TOTAL REVENUE"). Suppress the tile title
  // for KPI — the card's label is the title (matches PBI Card visuals).
  const isKpiCard = String(chart?.chart_type || '').toUpperCase() === 'KPI';
  // KPI-header — the metric label IS the KPI's title; show it in the header row
  // (level with the actions) and hide it inside the card so the body focuses on
  // the value. Explicit custom/config titles still win.
  const kpiMetricLabel = isKpiCard
    ? ((effectiveStyleConfig as any)?.kpiLabel?.trim()
       || ((roleConfig as any)?.metrics?.[0]
            ? metricLabel((roleConfig as any).metrics[0], roLabelMap)
            : ''))
    : '';
  const kpiHeaderTitle = customTileTitle || configuredChartTitle || kpiMetricLabel || chartNameTrim;
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

  const handleCrossFilterSelection = (selection: { field: string; value: unknown; dateRange?: [string, string]; dateGrain?: string } | null) => {
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

    // Time-bucketed click: bound the whole bucket with a `between` date range
    // instead of an equality that would match no raw row. (See ChartTile.)
    if (selection.dateRange) {
      onSelectCrossFilter({
        id: `public-cross-${chart?.id ?? 'chart'}-${selection.field}-${selection.dateRange[0]}-${selection.dateRange[1]}`,
        field: selection.field,
        fieldKey: semanticField,
        semanticField,
        datasetId: chartSemanticBinding.datasetId,
        type: 'date',
        operator: 'between',
        value: selection.dateRange,
        label: getFriendlyFieldLabel(selection.field),
      });
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

  // Cross-highlight data for the renderer:
  //   • source tile → the selected category's own rows, filtered locally from
  //     this chart's baseline data (no extra fetch).
  //   • target tile → the parent-fetched P-filtered subset (`highlightData`).
  //   • null when no highlight active / this chart can't bind the selection.
  const effectiveHighlightData = useMemo<Record<string, any>[] | null>(() => {
    if (!highlightFilter) return null;
    const rows = chartData?.data ?? [];
    if (isHighlightSource) {
      const field = highlightFilter.field;
      if (highlightFilter.operator === 'between' && Array.isArray(highlightFilter.value)) {
        const [start, end] = (highlightFilter.value as any[]).map((v) => String(v).slice(0, 10));
        return rows.filter((r) => {
          const day = String(r?.[field] ?? '').slice(0, 10);
          return day && (!start || day >= start) && (!end || day <= end);
        });
      }
      const target = String(highlightFilter.value);
      return rows.filter((r) => String(r?.[field]) === target);
    }
    return highlightData ?? null;
  }, [highlightFilter, isHighlightSource, highlightData, chartData]);

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
      className={`dashboard-tile group relative h-full overflow-hidden rounded-lg p-3 transition-colors ${
        transparentTile ? '' : 'border bg-surface-1'
      } ${
        isCrossFilterSource || isHighlightSource
          ? 'border-sky-300 ring-2 ring-sky-100'
          : transparentTile
            ? ''
            : 'border-[rgb(var(--border-line))] hover:border-[rgb(var(--border-strong))]'
      }`}
      style={{
        borderRadius: 'var(--dashboard-card-radius, 0.5rem)',
        // Frameless when transparent: no border/bg/shadow → dashboard bg shows
        // through. (A cross-filter/highlight ring still renders via Tailwind.)
        ...(transparentTile
          ? { borderWidth: 0, background: 'transparent' }
          : {
              borderWidth: 'var(--dashboard-card-border-width, 1px)',
              ...(isCrossFilterSource || isHighlightSource
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
            }),
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
                  t('dashboards.readonlyChartTile.droppedFiltersTitle', { count: droppedByBackend.length }),
                ];
                for (const d of droppedByBackend) {
                  const ref = d.semantic_field || d.field || t('dashboards.readonlyChartTile.unknownField');
                  lines.push(`• ${ref} — ${d.detail || d.reason}`);
                }
                return lines.join('\n');
              })()}
            >
              <AlertTriangle className="h-3 w-3" />
              {t('dashboards.readonlyChartTile.droppedBadge', { count: droppedByBackend.length })}
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
              title={t('dashboards.readonlyChartTile.perChartFilters')}
            >
              <SlidersHorizontal className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
            </button>
          ) : null;
          const hasActions = Boolean(droppedBadge || havingToggle);

          // KPI: header row carries the metric label (the de-facto title) on
          // the left, level with the actions on the right; the card body then
          // hides its own label and keeps the value as the focus.
          if (isKpiCard) {
            if (!kpiHeaderTitle && !hasActions) return null;
            return (
              <div className={`mb-2 flex min-h-[1.5rem] items-start gap-3 ${compact ? 'text-xs' : 'text-[13px]'}`}>
                {kpiHeaderTitle && (
                  <p data-pdf-tile-title className="dashboard-kpi-label min-w-0 flex-1 truncate font-medium text-text-secondary" style={themeTitleStyle} title={kpiHeaderTitle}>{kpiHeaderTitle}</p>
                )}
                {hasActions && (
                  <div className="ml-auto flex flex-shrink-0 items-center gap-1">
                    {droppedBadge}
                    {havingToggle}
                  </div>
                )}
              </div>
            );
          }

          // Non-KPI: render the header row only when it has real content.
          const showHeader = Boolean(displayTitle || (showChartTypeLabel && chart?.chart_type) || hasActions);
          if (!showHeader) return null;
          return (
            <div className={`mb-2 flex min-h-[1.5rem] items-start gap-3 ${compact ? 'text-xs' : 'text-[13px]'}`}>
              <div className="min-w-0 flex-1">
                {displayTitle && (
                  <p data-pdf-tile-title className="truncate font-medium text-text-secondary" style={themeTitleStyle} title={displayTitle}>{displayTitle}</p>
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
                <span className="font-mono text-[0.6rem] uppercase opacity-60">{t('dashboards.tile.havingLabel')}</span>
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
              <option value="gt">&gt; {t('dashboards.readonlyChartTile.opGreaterThan')}</option>
              <option value="gte">≥ {t('dashboards.readonlyChartTile.opGreaterOrEqual')}</option>
              <option value="lt">&lt; {t('dashboards.readonlyChartTile.opLessThan')}</option>
              <option value="lte">≤ {t('dashboards.readonlyChartTile.opLessOrEqual')}</option>
              <option value="eq">= {t('dashboards.readonlyChartTile.opEquals')}</option>
              <option value="neq">≠ {t('dashboards.readonlyChartTile.opNotEquals')}</option>
            </select>
            <input
              type="number"
              value={draftHavingValue}
              onChange={(event) => setDraftHavingValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') confirmHaving();
                if (event.key === 'Escape') setIsHavingOpen(false);
              }}
              placeholder={t('dashboards.readonlyChartTile.valuePlaceholder')}
              className="w-24 rounded-lg border border-[rgb(var(--border-strong))] px-2 py-1 text-xs text-text-secondary focus:outline-none focus:ring-1 focus:ring-sky-400"
            />
            <button
              onClick={confirmHaving}
              className="rounded-lg bg-surface-inverse px-2.5 py-1 text-xs text-white hover:bg-surface-3"
            >
              {t('dashboards.readonlyChartTile.apply')}
            </button>
            {havingFilters.length > 0 && (
              <button
                onClick={() => setHavingFilters([])}
                className="text-xs text-text-tertiary hover:text-text-secondary"
              >
                {t('dashboards.readonlyChartTile.clearAll')}
              </button>
            )}
          </div>
        )}

        <div
          className="flex-1 min-h-0 overflow-hidden"
          onClick={(e) => {
            // Click on EMPTY chart space clears the cross-filter selection
            // (reverts to the viewer's baseline; page/locked/slicer filters
            // untouched). A click on a data mark selects instead.
            if (!onSelectCrossFilter || chartSemanticBinding?.datasetId == null) return;
            const target = e.target as Element | null;
            if (!target?.closest?.('.recharts-wrapper')) return;
            if (target.closest('.recharts-bar-rectangle, .recharts-rectangle, .recharts-sector, .recharts-dot, .recharts-active-dot, .recharts-symbols, .recharts-pie-sector')) return;
            onSelectCrossFilter(null);
          }}
        >
          {!chart ? (
            <div className="flex h-full items-center justify-center text-center">
              <div>
                <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-warning" />
                <p className={`${compact ? 'text-xs' : 'text-sm'} font-medium text-warning`}>
                  {t('dashboards.readonlyChartTile.metadataUnavailable')}
                </p>
              </div>
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center text-center">
              <div>
                <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-warning" />
                <p className={`${compact ? 'text-xs' : 'text-sm'} font-medium text-warning`}>
                  {t('dashboards.readonlyChartTile.failedToLoad')}
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
              kpiLabelInHeader={isKpiCard}
              viewerGrain={viewerGrain}
              onViewerDrill={onViewerDrill}
              lockDateGrain={lockDateGrain}
              highlightData={effectiveHighlightData}
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
              embedded
              kpiLabelInHeader={isKpiCard}
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
