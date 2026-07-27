/**
 * Explore editor - reusable chart builder used by Explore and dashboard flows.
 */
'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Save, ArrowLeft, ChevronDown, ChevronRight, ChevronUp, Pencil, Check, Search, Settings2, Play, RotateCcw, Database, Code2, Eye } from 'lucide-react';
import { HelpTooltip } from '@/components/ui/HelpTooltip';
import { useI18n } from '@/providers/LanguageProvider';
import { useDataset, useTablePreview, type ColumnMetadata } from '@/hooks/use-datasets';
import { ExploreSourceSelector } from '@/components/explore/ExploreSourceSelector';
import { BaseTablePicker } from '@/components/explore/BaseTablePicker';
import { pickRecommendedBaseTableId } from '@/lib/semantic-base';
import { DatasetTableGrid } from '@/components/datasets/DatasetTableGrid';
import { ExploreChart } from '@/components/explore/ExploreChart';
import { ChartErrorBoundary } from '@/components/dashboards/ChartErrorBoundary';
import { buildExploreChartModel } from '@/components/explore/chartDataAdapter';
import { FilterBuilder, type Filter } from '@/components/explore/FilterBuilder';
import {
  useChart,
  useCreateChart,
  useDryRunCreateChart,
  usePreviewChartData,
  useReplaceChartParameters,
  useUpdateChart,
  useUpsertChartMetadata,
} from '@/hooks/use-charts';
import {
  ExploreChartConfig,
  type ExploreChartType,
  type ChartRoleConfig,
  type ChartStyleConfig,
  type MetricConfig,
  DEFAULT_STYLE_CONFIG,
  getChartRoleConfigRequirementMessage,
  getChartRoleConfigValidationMessage,
  migrateRoleConfig,
  normalizeChartStyleConfig,
  normalizeRoleConfig,
} from '@/components/explore/ExploreChartConfig';
import { toast } from '@/lib/toast';
import { extractApiError } from '@/lib/api-errors';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { ChartDescriptionDrawer, ChartDescriptionTrigger } from '@/components/explore/ChartDescriptionDrawer';
import {
  buildExploreExecuteRequest,
  buildExploreSqlPreview,
  buildQuerySignature,
  inferRoleConfigFromCustomSql,
  inferQueryColumns,
  stripTrailingSqlLimit,
} from '@/lib/explore-query';
import type { ChartDebugInfo, ChartMetadataUpsert, ChartParameterCreate } from '@/types/api';
import { useDatasetModel, type DatasetModelView } from '@/hooks/use-dataset-model';
import { buildSemanticLabelMap, buildSemanticFormatMap } from '@/lib/chart-semantic-maps';
import { getReachableViews, computeStrictReachableViews } from '@/lib/dataset-model-graph';

type ChartType = ExploreChartType;

/**
 * Phase-15.9 — Query inspector tab.
 *
 * Renders the pipeline that produced the current preview, in 4 stacked
 * sections, so DA can debug "chart blank but table OK", "wrong dialect
 * emitted", "engine took the wrong join path", etc. without server logs.
 *
 * Sections (top to bottom):
 *   1. Status strip — routing path (semantic engine vs live_query),
 *      dialect, exec time, row count
 *   2. Engine warnings (if any)
 *   3. SQL block (BE-emitted preferred, FE-built fallback) with copy-
 *      to-clipboard
 *   4. Hints — quick tips for the current chart type
 *
 * The component is self-contained: no hooks beyond local state, no
 * network calls. Receives a frozen snapshot via `state`.
 */
function QueryInspector({
  state,
  chartType,
}: {
  state: ExploreQueryState;
  chartType: ChartType;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  // Prefer BE-emitted SQL — it's the authoritative output (after time-
  // macro resolution, JOIN rendering, dialect-correct quoting). Fall
  // back to FE-built preview when the BE didn't surface it (cache hit
  // on a legacy response, or live_query path predating Phase-15.9).
  const debug = state.debug;
  const sql = debug?.sql_emitted || state.sql || '';
  const sqlSource = debug?.sql_emitted ? 'backend' : 'frontend-preview';

  const routing = debug?.routing || (sqlSource === 'backend' ? 'unknown' : 'preview');
  const dialect = debug?.dialect || '—';
  const execMs = debug?.execution_time_ms ?? state.executionTimeMs;
  const rowCount = debug?.row_count ?? state.rows.length;
  const warnings = debug?.warnings?.length ? debug.warnings : (state.warnings || []);

  const onCopy = () => {
    if (!sql) return;
    navigator.clipboard.writeText(sql).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  const routingLabel = routing === 'semantic_engine'
    ? t('explore.queryInspector.routingSemantic')
    : routing === 'live_query'
      ? t('explore.queryInspector.routingLive')
      : routing === 'preview'
        ? t('explore.queryInspector.routingPreview')
        : routing;
  const routingBadgeClass = routing === 'semantic_engine'
    ? 'border-brand/40 bg-brand/10 text-brand'
    : routing === 'live_query'
      ? 'border-purple-500/40 bg-purple-500/10 text-purple-600 dark:text-purple-400'
      : 'border-[rgb(var(--border-line))] bg-surface-2 text-text-tertiary';

  return (
    <div className="h-full overflow-auto rounded-2xl border border-[rgb(var(--border-line))] bg-surface-2 p-3">
      <div className="flex h-full flex-col gap-3 overflow-auto rounded-[20px] bg-surface-1 p-4">
        {/* ── Status strip ──────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-emphasis ${routingBadgeClass}`}
            title={
              routing === 'semantic_engine'
                ? t('explore.queryInspector.routingSemanticTip')
                : routing === 'live_query'
                  ? t('explore.queryInspector.routingLiveTip')
                  : t('explore.queryInspector.routingUnknownTip')
            }
          >
            {routingLabel}
          </span>
          <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-text-tertiary">
            {t('explore.queryInspector.dialect')}: <code className="font-mono">{dialect}</code>
          </span>
          {execMs != null && (
            <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-text-tertiary">
              {t('explore.queryInspector.exec')}: <code className="font-mono">{execMs.toFixed(1)} ms</code>
            </span>
          )}
          <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-text-tertiary">
            {t('explore.queryInspector.rows')}: <code className="font-mono">{rowCount}</code>
          </span>
          <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-text-tertiary">
            {t('explore.queryInspector.chart')}: <code className="font-mono">{chartType}</code>
          </span>
          <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-text-tertiary">
            {t('explore.queryInspector.preAgg')}: <code className="font-mono">{String(state.chartPreAggregated)}</code>
          </span>
        </div>

        {/* ── Warnings ──────────────────────────────────────────── */}
        {warnings.length > 0 && (
          <div className="rounded-md border border-warning/40 bg-warning/5 p-2 text-[11px] leading-snug text-warning">
            <div className="mb-1 font-emphasis">{t('explore.queryInspector.engineWarnings', { count: warnings.length })}</div>
            {warnings.map((w, i) => (
              <div key={i}>⚠ {w}</div>
            ))}
          </div>
        )}

        {/* ── SQL block ─────────────────────────────────────────── */}
        {/* Phase-3 per-measure isolation: when the BE split execution into
            N parallel queries, render one labeled <pre> per group instead
            of only the first SQL. Single-SQL path unchanged. */}
        {debug?.sql_emitted_per_group && debug.sql_emitted_per_group.length > 1 ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-emphasis uppercase tracking-wide text-text-tertiary">
                {t('explore.queryInspector.sqlPerMeasure', { count: debug.sql_emitted_per_group.length })}
                {debug.merge_dimension ? t('explore.queryInspector.sqlMergedOn', { dimension: debug.merge_dimension }) : ''})
              </div>
            </div>
            {debug.sql_emitted_per_group.map((g, idx) => (
              <div key={`${g.fact_view}-${idx}`} className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-[10px] text-text-tertiary">
                  <span>
                    {t('explore.queryInspector.group')} <code className="font-mono">{g.fact_view}</code>
                  </span>
                  {g.sql && (
                    <button
                      onClick={() => navigator.clipboard.writeText(g.sql).catch(() => {})}
                      className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-text-secondary hover:bg-surface-1"
                    >
                      {t('explore.queryInspector.copy')}
                    </button>
                  )}
                </div>
                <pre className="overflow-auto rounded-md border border-[rgb(var(--border-line))] bg-surface-2 p-3 text-[11px] font-mono leading-relaxed text-text-secondary">
                  {g.sql || t('explore.queryInspector.emptySqlPlaceholder')}
                </pre>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-emphasis uppercase tracking-wide text-text-tertiary">
                {sqlSource === 'backend' ? t('explore.queryInspector.sqlBackendEmitted') : t('explore.queryInspector.sqlFrontendPreview')}
              </div>
              {sql && (
                <button
                  onClick={onCopy}
                  className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-[10px] text-text-secondary hover:bg-surface-1"
                >
                  {copied ? t('explore.queryInspector.copied') : t('explore.queryInspector.copySql')}
                </button>
              )}
            </div>
            {sql ? (
              <pre className="overflow-auto rounded-md border border-[rgb(var(--border-line))] bg-surface-2 p-3 text-[11px] font-mono leading-relaxed text-text-secondary">
                {sql}
              </pre>
            ) : (
              <div className="rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-2 p-3 text-[11px] italic text-text-quaternary">
                {t('explore.queryInspector.noSqlYet')}
              </div>
            )}
          </div>
        )}

        {/* ── Hints ─────────────────────────────────────────────── */}
        <div className="mt-1 rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-2 p-2 text-[10px] leading-snug text-text-quaternary">
          <div className="mb-1 font-emphasis uppercase tracking-wide text-text-tertiary">{t('explore.queryInspector.debugTips')}</div>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>
              <strong>{t('explore.queryInspector.tipEmptyTitle')}</strong>: {t('explore.queryInspector.tipEmptyBody')}
            </li>
            <li>
              <strong>{t('explore.queryInspector.tipTotalsTitle')}</strong>: {t('explore.queryInspector.tipTotalsBody')}
            </li>
            <li>
              <strong>{t('explore.queryInspector.tipWarningTitle')}</strong>: {t('explore.queryInspector.tipWarningBody')}
            </li>
            <li>
              <strong>{t('explore.queryInspector.tipDialectTitle')}</strong>: {t('explore.queryInspector.tipDialectBody')}
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}


type QueryMode = 'generated' | 'custom';

// Phase-15.83 — kept as fallback constants for any caller that still
// references them, but the Limit dropdown was removed from the editor
// header (DA dropped per-chart caps). New runs default to the 10M
// sentinel so the BE LIMIT clause stops cutting data.
const GENERATED_QUERY_LIMIT_OPTIONS = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
const CUSTOM_QUERY_LIMIT_OPTIONS = [50, 100, 250, 500, 1000, 2500, 5000];
const NO_LIMIT_SENTINEL = 10_000_000;
const TABLE_LIKE_CHART_TYPES = new Set<ChartType>(['TABLE', 'MATRIX']);
const SCATTER_LIKE_CHART_TYPES = new Set<ChartType>(['SCATTER', 'BUBBLE', 'MAP_POINT', 'NINE_BOX']);
const NO_DIMENSION_METRIC_CHART_TYPES = new Set<ChartType>(['KPI', 'GAUGE', 'BULLET']);
// Raw-distribution charts plot the per-ROW spread of a numeric column across a
// category (the BE reclassifies the value into a raw dimension). They need a
// RAW physical numeric — a declared aggregate measure isn't a physical column,
// so the engine fails ("Dimension 'total_revenue' not found in view"). DA7-B3.
const RAW_DISTRIBUTION_CHART_TYPES = new Set<ChartType>(['BOXPLOT']);
const PIE_LIKE_CHART_TYPES = new Set<ChartType>(['PIE', 'DONUT', 'POLAR_AREA']);
const SINGLE_METRIC_CHART_TYPES = new Set<ChartType>([
  'GROUPED_BAR',
  'STACKED_BAR',
  'PIE',
  'DONUT',
  'POLAR_AREA',
  'FUNNEL',
  'TREEMAP',
  'WATERFALL',
  'MAP_REGION',
  'BOXPLOT',
  'HEATMAP',
  'SANKEY',
  'SUNBURST',
  'RIBBON',
  'TIMELINE',
  'WORD_CLOUD',
  'KPI',
  'GAUGE',
  'BULLET',
  'PODIUM',
]);
const BREAKDOWN_REQUIRED_CHART_TYPES = new Set<ChartType>([
  'GROUPED_BAR',
  'STACKED_BAR',
  'HEATMAP',
  'SANKEY',
  'SUNBURST',
  'RIBBON',
]);
function getMaxQueryLimit(_mode: QueryMode): number {
  // Phase-15.83 — DA dropped per-chart row caps. The function stays so
  // callers still compile; it returns the 10M sentinel that disables
  // truncation in practice (BE short-circuits on the actual row count).
  return NO_LIMIT_SENTINEL;
}

interface ExploreQueryState {
  source: QueryMode;
  sql: string;
  columns: ColumnMetadata[];
  rows: Record<string, any>[];
  chartRows: Record<string, any>[];
  chartColumns: ColumnMetadata[];
  chartPreAggregated: boolean;
  executionTimeMs?: number;
  /** Phase-3b: semantic engine warnings (ambiguous join paths, etc.) */
  warnings?: string[];
  /**
   * Phase-15.9: BE-side pipeline metadata for the "Query" inspector tab.
   * Populated from `ChartDataResponse.debug` (saved-chart path) or the
   * preview endpoint's `debug` field. Undefined for legacy / cached
   * responses — the inspector falls back to FE-built SQL + warnings.
   */
  debug?: ChartDebugInfo & {
    /**
     * Phase-3 per-measure isolation — when the engine split a multi-fact
     * chart into N parallel queries, the per-group SQL list is surfaced
     * here so the Query tab can show every emitted statement instead of
     * only the first one. ``sql_emitted`` keeps the first group's SQL
     * for back-compat.
     */
    sql_emitted_per_group?: Array<{ fact_view: string; sql: string }>;
    queries_count?: number;
    merge_dimension?: string | null;
  };
}

function normalizeSavedQueryMode(config: Record<string, any> | null | undefined): QueryMode {
  const mode = config?.queryMode === 'custom' ? 'custom' : 'generated';
  const customSql = typeof config?.customSql === 'string' ? config.customSql.trim() : '';
  return mode === 'custom' && customSql ? 'custom' : 'generated';
}

function metricMatchesColumns(metric: MetricConfig | null | undefined, columnNames: Set<string>): boolean {
  if (!metric) return false;

  const candidates = [
    metric.field,
    metric.outputField,
    `${metric.agg}__${metric.field}`,
    `${metric.field}_${metric.agg}`,
    `${metric.agg}_${metric.field}`,
    `${metric.field}__${metric.agg}`,
  ].filter((value): value is string => Boolean(value));

  return candidates.some((candidate) => columnNames.has(candidate));
}

function bareFieldName(fieldRef: string): string {
  return fieldRef.includes('.') ? fieldRef.split('.').slice(-1)[0] : fieldRef;
}

function humanizeFieldName(fieldRef: string): string {
  const bare = bareFieldName(fieldRef).replace(/[_-]+/g, ' ').trim();
  if (!bare) return fieldRef;
  return bare
    .split(/\s+/)
    .map((token) => {
      if (/^[A-Z0-9]{2,}$/.test(token)) return token;
      if (/^id$/i.test(token)) return 'ID';
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join(' ');
}

function isIdentifierLikeField(fieldRef: string): boolean {
  const bare = bareFieldName(fieldRef).toLowerCase();
  return (
    bare === 'id' ||
    bare.endsWith('_id') ||
    bare.endsWith(' id') ||
    bare.includes('uuid') ||
    bare.endsWith('_key') ||
    bare.endsWith(' key')
  );
}

/**
 * Canonical numeric-type test for column metadata.
 *
 * Column `type` is NOT always the literal `'number'` — BigQuery INT64/FLOAT64
 * surface as `'integer'`/`'float'`, Postgres as `'numeric'`/`'bigint'`, etc.
 * The auto-seed used to test `type === 'number'` only, so on a BigQuery galaxy
 * EVERY numeric column (quantity, revenue, and the integer join keys) fell into
 * the `type !== 'number'` "categorical" bucket and got auto-seeded as a
 * dimension/breakdown — a numeric measure on a chart axis, and (for the keys)
 * the DA7-B1 ambiguous-id loud failure. Mirror `isNumeric` in
 * ExploreChartConfig so metric vs dimension classification matches the rest of
 * the editor.
 */
function isNumericColumnType(type: string | undefined): boolean {
  return ['number', 'integer', 'float', 'double', 'decimal', 'bigint'].includes(
    (type ?? '').toLowerCase(),
  );
}

/**
 * Phase-12.5 — Qualified-field guarantee.
 *
 * Background: BE routes a chart query to the semantic engine (with JOIN
 * resolver) when ANY metric/dimension carries a dotted `view.field` ref —
 * see `_contains_semantic_field_refs` in backend/app/api/datasets.py:704
 * and `_role_config_needs_semantic_runtime` in chart_service.py:129.
 *
 * Before Phase-12.5, this routing was at risk because:
 *   1. `availableColumns` is built from `[previewColumns, semanticColumns]`
 *      where preview columns are bare names ("amount") and semantic columns
 *      are qualified ("deals.amount").
 *   2. When semanticColumns finishes loading AFTER previewColumns, the user
 *      may have already picked "amount" — bare — and the engine routes to
 *      live_query instead of semantic. Cross-table JOINs silently fail.
 *
 * `upgradeFieldToQualified` walks every potential field in a role config
 * and replaces bare names with their qualified counterpart whenever both
 * exist in the column registry. Idempotent — safe to call on already-
 * qualified configs.
 */
function upgradeFieldToQualified(
  field: string | undefined,
  qualifiedByBare: Map<string, string>,
): string | undefined {
  if (!field) return field;
  if (field.includes('.')) return field; // already qualified
  return qualifiedByBare.get(field) ?? field;
}

function upgradeMetricToQualified(
  metric: MetricConfig | undefined,
  qualifiedByBare: Map<string, string>,
): MetricConfig | undefined {
  if (!metric) return metric;
  const next = upgradeFieldToQualified(metric.field, qualifiedByBare);
  if (next === metric.field) return metric;
  // Phase-13: an upgrade means the field maps to a declared semantic
  // measure — no longer implicit. Strip the flag to keep state honest.
  const { _implicit, ...rest } = metric;
  return { ...rest, field: next ?? metric.field };
}

function upgradeTimeGrainsToQualified(
  timeGrains: ChartRoleConfig['timeGrains'],
  qualifiedByBare: Map<string, string>,
): ChartRoleConfig['timeGrains'] {
  if (!timeGrains) return timeGrains;
  let changed = false;
  const next: NonNullable<ChartRoleConfig['timeGrains']> = {};
  for (const [field, grain] of Object.entries(timeGrains)) {
    const upgraded = upgradeFieldToQualified(field, qualifiedByBare) ?? field;
    changed = changed || upgraded !== field;
    if (next[upgraded] === undefined || upgraded === field) {
      next[upgraded] = grain;
    }
  }
  return changed ? next : timeGrains;
}

function upgradeRoleConfigToQualified(
  roleConfig: ChartRoleConfig,
  qualifiedByBare: Map<string, string>,
): ChartRoleConfig {
  if (qualifiedByBare.size === 0) return roleConfig;
  return {
    ...roleConfig,
    dimension: upgradeFieldToQualified(roleConfig.dimension, qualifiedByBare),
    breakdown: upgradeFieldToQualified(roleConfig.breakdown, qualifiedByBare),
    timeField: upgradeFieldToQualified(roleConfig.timeField, qualifiedByBare),
    scatterX: upgradeFieldToQualified(roleConfig.scatterX, qualifiedByBare),
    scatterY: upgradeFieldToQualified(roleConfig.scatterY, qualifiedByBare),
    tableRowDimension: upgradeFieldToQualified(roleConfig.tableRowDimension, qualifiedByBare),
    tableColumnDimension: upgradeFieldToQualified(roleConfig.tableColumnDimension, qualifiedByBare),
    metrics: roleConfig.metrics.map((m) => upgradeMetricToQualified(m, qualifiedByBare) ?? m),
    lineMetric: upgradeMetricToQualified(roleConfig.lineMetric, qualifiedByBare),
    benchmarkMetric: upgradeMetricToQualified(roleConfig.benchmarkMetric, qualifiedByBare),
    tablePivotMetric: upgradeMetricToQualified(roleConfig.tablePivotMetric, qualifiedByBare),
    selectedColumns: roleConfig.selectedColumns?.map(
      (col) => upgradeFieldToQualified(col, qualifiedByBare) ?? col,
    ),
    timeGrains: upgradeTimeGrainsToQualified(roleConfig.timeGrains, qualifiedByBare),
  };
}

function retainTimeGrainsForColumns(
  timeGrains: ChartRoleConfig['timeGrains'],
  columnNames: Set<string>,
): ChartRoleConfig['timeGrains'] {
  if (!timeGrains) return undefined;
  const next = Object.fromEntries(
    Object.entries(timeGrains).filter(([field]) => columnNames.has(field)),
  ) as NonNullable<ChartRoleConfig['timeGrains']>;
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeTableDisplayColumns(
  columns: ColumnMetadata[],
  roleConfig: ChartRoleConfig,
): ColumnMetadata[] {
  if (roleConfig.tableMode !== 'pivot' || !roleConfig.tableRowDimension) {
    return columns;
  }

  return columns.map((column, index) => (
    index === 0
      ? column
      : { ...column, type: 'number' }
  ));
}

function inferSortLimitColumns(
  chartType: ChartType,
  rows: Record<string, any>[],
  roleConfig: ChartRoleConfig,
  preAggregated: boolean,
): ColumnMetadata[] {
  if (
    !rows.length ||
    // MATRIX (pivot) has no flat row list to sort/limit; single-number metrics
    // and PODIUM likewise. A flat TABLE DOES support sort + Top/Bottom N, so it
    // is intentionally NOT excluded here (its columns come from model.tableData).
    chartType === 'MATRIX' ||
    NO_DIMENSION_METRIC_CHART_TYPES.has(chartType) ||
    chartType === 'PODIUM'
  ) {
    return [];
  }

  const model = buildExploreChartModel({
    type: chartType,
    data: rows,
    roleConfig,
    preAggregated,
  });

  const sortRows = (() => {
    if (chartType === 'TABLE') {
      return model.tableData;
    }
    if (SCATTER_LIKE_CHART_TYPES.has(chartType)) {
      return model.scatterPoints;
    }
    if (PIE_LIKE_CHART_TYPES.has(chartType)) {
      return model.pieData;
    }
    if (chartType === 'BAR_LINE') {
      return model.comboData;
    }
    return model.categoricalData;
  })();

  if (!sortRows.length) {
    return [];
  }

  return inferQueryColumns(Object.keys(sortRows[0] ?? {}), sortRows);
}

function createDefaultTableRoleConfig(
  roleConfig: ChartRoleConfig,
  tableMode: ChartRoleConfig['tableMode'] = 'standard',
): ChartRoleConfig {
  // Preserve fields the user already bound: dimensions and metric fields all
  // become candidate table columns. This avoids silently dropping cross-table
  // fields when switching from chart \u2192 table view. `syncRoleConfigWithColumns`
  // will still drop any field that isn't in `availableGeneratedColumns`.
  const preservedColumns: string[] = [];
  const pushUnique = (value?: string | null) => {
    if (!value) return;
    if (preservedColumns.includes(value)) return;
    preservedColumns.push(value);
  };
  pushUnique(roleConfig.dimension);
  pushUnique(roleConfig.breakdown);
  pushUnique(roleConfig.timeField);
  pushUnique(roleConfig.scatterX);
  pushUnique(roleConfig.scatterY);
  for (const metric of roleConfig.metrics ?? []) {
    pushUnique(metric.field);
  }
  for (const existing of roleConfig.selectedColumns ?? []) {
    pushUnique(existing);
  }

  return {
    ...roleConfig,
    dimension: undefined,
    breakdown: undefined,
    timeField: undefined,
    scatterX: undefined,
    scatterY: undefined,
    lineMetric: undefined,
    metrics: [],
    tableMode,
    tableRowDimension: undefined,
    tableColumnDimension: undefined,
    tablePivotMetric: undefined,
    selectedColumns: preservedColumns.length > 0 ? preservedColumns : undefined,
  };
}

function createDefaultTableStyleConfig(styleConfig: ChartStyleConfig): ChartStyleConfig {
  return {
    ...styleConfig,
    tableEnableConditionalFormatting: false,
    tableEnableHeatmap: false,
    tableConditionalFormatting: undefined,
    tableHeatmapRules: undefined,
    tableShowSummaryRow: false,
    tableSummaryLabel: DEFAULT_STYLE_CONFIG.tableSummaryLabel,
    tableSummaryLabelColumn: undefined,
    tableSummaryRows: undefined,
    tableColumnWidths: undefined,
    tableColumnAlignments: undefined,
    tableHyperlinkRules: undefined,
  };
}

function getApiErrorMessage(error: any, fallback: string): string {
  const detail = error?.response?.data?.detail ?? error?.response?.data;
  if (typeof detail === 'string' && detail.trim()) {
    const trimmed = detail.trim();
    if (!trimmed.startsWith('<')) {
      return trimmed;
    }
  }
  if (detail?.message) {
    return detail.message;
  }
  if (typeof error?.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

function syncRoleConfigWithColumns(
  chartType: ChartType,
  roleConfig: ChartRoleConfig,
  columns: ColumnMetadata[],
  /** Bare names that resolve to >1 view (see `ambiguousBareNames` memo).
   *  Auto-seed never defaults a dimension/breakdown to one — it would emit a
   *  bare ref the engine can't qualify and fail loudly. Empty for the
   *  custom-SQL path (single flat result set, no JOIN ambiguity). */
  ambiguousBareNames: Set<string> = new Set(),
): ChartRoleConfig {
  const normalized = normalizeRoleConfig(chartType, roleConfig);
  if (!columns.length) return normalized;

  const columnNames = new Set(columns.map((column) => column.name));
  const numericColumns = columns.filter((column) => isNumericColumnType(column.type));
  // A date-hierarchy part (Year/Quarter/Month from a `*__date_dim` calendar
  // view) is typed 'number' but is a DIMENSION, never a business measure. Keep
  // it out of metric auto-seeding so a fresh KPI/BAR doesn't silently render
  // "SUM of Year" off the auto-generated calendar (DA reported this on KPI).
  const isCalendarPartColumn = (column: ColumnMetadata) =>
    typeof column.viewName === 'string' && column.viewName.endsWith('__date_dim');
  const metricCandidateColumns = numericColumns.filter(
    (column) => !isIdentifierLikeField(column.name) && !isCalendarPartColumn(column),
  );
  const declaredMeasureColumns = columns.filter(
    (column) => column.fieldKind === 'measure' && !isCalendarPartColumn(column),
  );
  const categoricalColumns = columns.filter((column) => !isNumericColumnType(column.type));
  // A DIMENSION/BREAKDOWN auto-seed must NEVER default to an identifier /
  // join-key column (product_id, transaction_id, *_key, uuid). In a galaxy
  // its BARE name is ambiguous across joined facts, so the engine fails loudly
  // ("Field 'product_id' xuất hiện ở nhiều bảng đã JOIN" — DA7-B1/B3 on
  // Matrix/Grouped Bar/Stacked Bar/Heatmap/Boxplot/Sunburst). Even when a key
  // is unambiguous it is a useless auto-axis (250 unique → 250 rows). This
  // mirrors the metric side (`metricCandidateColumns`, DA6-F2/#17). If no safe
  // categorical exists, the fallbacks return undefined so the UI prompts the
  // DA to pick a field (PowerBI-style) instead of emitting an ambiguous/junk
  // default. NOTE: calendar date-parts (Year/Month) are type 'number' so they
  // are already excluded from categoricalColumns — date GROUPING still works
  // because the DA/semantic layer picks the grain explicitly (#18 intact).
  const dimensionCandidateColumns = categoricalColumns.filter(
    (column) =>
      !isIdentifierLikeField(column.name)
      // Skip a BARE name that resolves to multiple views — auto-seeding it
      // emits an unqualifiable ref and the engine fails loudly (e.g.
      // `year_month` on fct_sales + fct_target + date-dims). Qualified
      // `view.field` names are unambiguous and stay eligible.
      && !(!column.name.includes('.') && ambiguousBareNames.has(column.name)),
  );
  const timeColumns = columns.filter((column) => column.type === 'date' || column.type === 'datetime');
  const fallbackDimension = dimensionCandidateColumns[0]?.name;
  // Prefer a DECLARED measure, then a real (non-calendar) numeric. NO fallback
  // to "any numeric" — if the only numerics are calendar date-parts, leave the
  // metric EMPTY so the DA picks a real value (PowerBI-style) instead of the
  // app inventing SUM(Year).
  const fallbackMetric = declaredMeasureColumns.find((column) => column.name !== fallbackDimension)?.name
    ?? declaredMeasureColumns[0]?.name
    ?? metricCandidateColumns.find((column) => column.name !== fallbackDimension)?.name
    ?? metricCandidateColumns[0]?.name;
  const pickDimensionOtherThan = (...excluded: Array<string | undefined>) => (
    // Identifier/ambiguous columns excluded (see dimensionCandidateColumns).
    // No `?? columns.find(...)` numeric/id fallback — return undefined so a
    // required Breakdown stays empty and the UI prompts (DA7-B1).
    dimensionCandidateColumns.find((column) => !excluded.includes(column.name))?.name
  );
  const pickMetricOtherThan = (...excluded: Array<string | undefined>) => (
    // NO fallback to raw numericColumns — that re-admits the identifier/calendar
    // columns metricCandidateColumns deliberately excludes (DA6-F2 sibling).
    // Drop to fallbackMetric (declared-measure → real-numeric) instead of
    // auto-seeding SUM(transaction_id) / SUM(Year) as a size/value metric.
    metricCandidateColumns.find((column) => !excluded.includes(column.name))?.name
      ?? fallbackMetric
  );
  // Auto-seed aggregation by COLUMN (not a hardcoded 'sum'). A DECLARED
  // semantic measure must seed `agg: 'auto'` so the backend applies the
  // measure's STORED type (percent_of_total / count_distinct / filtered /
  // formula); hardcoding 'sum' here silently overrode that before the request
  // reached the engine. Mirrors `defaultMetricAggForCol` (the manual picker).
  const metricAggFor = (fieldName: string | undefined): MetricConfig['agg'] => {
    const col = columns.find((column) => column.name === fieldName);
    if (!col) return 'sum';
    if (col.fieldKind === 'measure') return 'auto';
    if (isNumericColumnType(col.type)) return 'sum';
    return 'count_distinct';
  };

  const next: ChartRoleConfig = {
    ...normalized,
    dimension: normalized.dimension && columnNames.has(normalized.dimension) ? normalized.dimension : undefined,
    breakdown: normalized.breakdown && columnNames.has(normalized.breakdown) ? normalized.breakdown : undefined,
    timeField: normalized.timeField && columnNames.has(normalized.timeField) ? normalized.timeField : undefined,
    scatterX: normalized.scatterX && columnNames.has(normalized.scatterX) ? normalized.scatterX : undefined,
    scatterY: normalized.scatterY && columnNames.has(normalized.scatterY) ? normalized.scatterY : undefined,
    lineMetric:
      normalized.lineMetric && metricMatchesColumns(normalized.lineMetric, columnNames)
        ? normalized.lineMetric
        : undefined,
    benchmarkMetric:
      normalized.benchmarkMetric && metricMatchesColumns(normalized.benchmarkMetric, columnNames)
        ? normalized.benchmarkMetric
        : undefined,
    metrics: normalized.metrics.filter((metric) => metricMatchesColumns(metric, columnNames)),
    tableRowDimension: normalized.tableRowDimension && columnNames.has(normalized.tableRowDimension)
      ? normalized.tableRowDimension
      : undefined,
    tableColumnDimension: normalized.tableColumnDimension && columnNames.has(normalized.tableColumnDimension)
      ? normalized.tableColumnDimension
      : undefined,
    tablePivotMetric:
      normalized.tablePivotMetric && metricMatchesColumns(normalized.tablePivotMetric, columnNames)
        ? normalized.tablePivotMetric
        : undefined,
    selectedColumns: normalized.selectedColumns?.filter((column) => columnNames.has(column)),
    timeGrains: retainTimeGrainsForColumns(normalized.timeGrains, columnNames),
  };

  if (next.selectedColumns && next.selectedColumns.length === 0) {
    next.selectedColumns = undefined;
  }

  // A non-table chart must never carry pivot/table grouping fields. Leftover
  // tableRowDimension/tableColumnDimension from a previous Matrix leak into the
  // query as GROUP BY columns — turning e.g. a KPI scalar into a grouped,
  // silently-WRONG number on a Matrix→KPI/Bar/etc. switch (observed: KPI showed
  // 1.1K over 161 rows instead of the 10,748,221.50 total). `normalizeRoleConfig`
  // forces tableMode='standard' for these types but keeps the dim fields; strip
  // them so the emitted SQL groups by BOUND roles only (fail-loud-not-wrong).
  if (!TABLE_LIKE_CHART_TYPES.has(chartType)) {
    next.tableRowDimension = undefined;
    next.tableColumnDimension = undefined;
    next.tablePivotMetric = undefined;
  }

  if (TABLE_LIKE_CHART_TYPES.has(chartType)) {
    if (chartType === 'MATRIX') {
      next.tableMode = 'pivot';
    }
    if (next.tableMode === 'pivot') {
      const rowDimensionFallback = dimensionCandidateColumns[0]?.name ?? fallbackDimension;
      // No `?? columns.find(...)` — never seed an identifier/ambiguous column as
      // the pivot column dimension (DA7-B1: Matrix auto-seeded bare product_id).
      // Empty → "Choose a column dimension for the pivot table" prompt.
      const columnDimensionFallback = dimensionCandidateColumns.find(
        (column) => column.name !== rowDimensionFallback)?.name;
      // Prefer a DECLARED measure, then a real (non-identifier, non-calendar)
      // numeric — mirroring the KPI/Bar `fallbackMetric` precedence. The old
      // `numericColumns.find(...)` included identifier-like columns, so a fresh
      // Matrix auto-seeded `SUM(transaction_id)` — a plausible-but-WRONG value
      // (DA6-F2). `metricCandidateColumns` already excludes identifier-like +
      // calendar date-part columns.
      const pivotMetricFallback =
        declaredMeasureColumns.find((column) =>
          column.name !== rowDimensionFallback && column.name !== columnDimensionFallback)?.name
        ?? metricCandidateColumns.find((column) =>
          column.name !== rowDimensionFallback && column.name !== columnDimensionFallback)?.name
        ?? fallbackMetric;

      if (!next.tableRowDimension) {
        next.tableRowDimension = rowDimensionFallback;
      }
      if (!next.tableColumnDimension || next.tableColumnDimension === next.tableRowDimension) {
        next.tableColumnDimension = columnDimensionFallback;
      }
      if (!next.tablePivotMetric && pivotMetricFallback) {
        next.tablePivotMetric = { field: pivotMetricFallback, agg: metricAggFor(pivotMetricFallback) };
      }
    }
    return next;
  }

  if (SCATTER_LIKE_CHART_TYPES.has(chartType)) {
    // Seed axes from metric-candidate numerics (excl. identifier-like + calendar
    // date-parts) so a fresh SCATTER/BUBBLE doesn't plot transaction_id or a
    // calendar Year on an axis (DA6-F2 sibling — mirrors the size-metric pick
    // below and the Matrix value fix).
    if (!next.scatterX) next.scatterX = metricCandidateColumns[0]?.name;
    if (!next.scatterY) next.scatterY = metricCandidateColumns[1]?.name ?? metricCandidateColumns[0]?.name;
    if (!next.dimension && dimensionCandidateColumns.length > 0) {
      next.dimension = dimensionCandidateColumns[0]?.name;
    }
    if ((chartType === 'BUBBLE' || chartType === 'MAP_POINT') && next.metrics.length === 0) {
      const sizeMetric = pickMetricOtherThan(next.scatterX, next.scatterY);
      if (sizeMetric) {
        next.metrics = [{ field: sizeMetric, agg: metricAggFor(sizeMetric) }];
      }
    }
    return next;
  }

  if (NO_DIMENSION_METRIC_CHART_TYPES.has(chartType)) {
    next.dimension = undefined;
    next.breakdown = undefined;
    next.timeField = undefined;
    if (next.metrics.length === 0 && fallbackMetric) {
      next.metrics = [{ field: fallbackMetric, agg: metricAggFor(fallbackMetric) }];
    }
    if (next.metrics.length > 1) {
      next.metrics = [next.metrics[0]];
    }
    return next;
  }

  if (RAW_DISTRIBUTION_CHART_TYPES.has(chartType)) {
    // Category × RAW numeric. The value MUST be a physical numeric column (the
    // BE reclassifies it into a raw dimension to keep the per-row spread). A
    // declared aggregate measure is NOT a physical column → engine fails
    // ("Dimension 'total_revenue' not found in view" — DA7-B3 Boxplot). Seed /
    // replace with a raw numeric (fieldKind !== 'measure'); if none exists,
    // leave the value EMPTY so the UI prompts ("Choose a numeric value column")
    // rather than emitting a measure ref that fails loudly.
    if (!next.dimension) next.dimension = fallbackDimension;
    const isDeclaredMeasureField = (field: string | undefined) =>
      Boolean(field) && columns.find((column) => column.name === field)?.fieldKind === 'measure';
    if (next.metrics.length === 0 || isDeclaredMeasureField(next.metrics[0]?.field)) {
      const rawNumeric = metricCandidateColumns.find((column) => column.fieldKind !== 'measure')?.name;
      next.metrics = rawNumeric ? [{ field: rawNumeric, agg: metricAggFor(rawNumeric) }] : [];
    }
    return next;
  }

  if (chartType === 'TIME_SERIES') {
    if (!next.timeField) next.timeField = timeColumns[0]?.name ?? fallbackDimension;
    if (!next.dimension) next.dimension = next.timeField ?? fallbackDimension;
  } else if (chartType === 'TIMELINE') {
    if (!next.timeField) next.timeField = timeColumns[0]?.name ?? fallbackDimension;
    if (!next.dimension) next.dimension = pickDimensionOtherThan(next.timeField) ?? fallbackDimension;
  } else if (chartType === 'RIBBON') {
    if (!next.timeField) next.timeField = timeColumns[0]?.name ?? fallbackDimension;
    if (!next.dimension) next.dimension = next.timeField ?? fallbackDimension;
  } else if (!next.dimension) {
    next.dimension = fallbackDimension;
  }

  if (next.metrics.length === 0 && fallbackMetric) {
    next.metrics = [{ field: fallbackMetric, agg: metricAggFor(fallbackMetric) }];
  }

  if (BREAKDOWN_REQUIRED_CHART_TYPES.has(chartType) && !next.breakdown) {
    next.breakdown = pickDimensionOtherThan(next.dimension, next.timeField);
  }

  if (SINGLE_METRIC_CHART_TYPES.has(chartType) && next.metrics.length > 1) {
    next.metrics = [next.metrics[0]];
  }

  if (chartType === 'BAR_LINE' && !next.lineMetric) {
    const excluded = new Set<string>([
      next.dimension,
      ...next.metrics.map((metric) => metric.field),
    ].filter((value): value is string => Boolean(value)));
    const lineMetricCandidate = metricCandidateColumns.find((column) => !excluded.has(column.name));
    if (lineMetricCandidate) {
      next.lineMetric = { field: lineMetricCandidate.name, agg: metricAggFor(lineMetricCandidate.name) };
    }
  }

  return next;
}

function pruneRoleConfigToColumns(
  chartType: ChartType,
  roleConfig: ChartRoleConfig,
  columns: ColumnMetadata[],
): ChartRoleConfig {
  const normalized = normalizeRoleConfig(chartType, roleConfig);
  if (!columns.length) return normalized;

  const columnNames = new Set(columns.map((column) => column.name));

  const next: ChartRoleConfig = {
    ...normalized,
    dimension: normalized.dimension && columnNames.has(normalized.dimension) ? normalized.dimension : undefined,
    breakdown: normalized.breakdown && columnNames.has(normalized.breakdown) ? normalized.breakdown : undefined,
    timeField: normalized.timeField && columnNames.has(normalized.timeField) ? normalized.timeField : undefined,
    scatterX: normalized.scatterX && columnNames.has(normalized.scatterX) ? normalized.scatterX : undefined,
    scatterY: normalized.scatterY && columnNames.has(normalized.scatterY) ? normalized.scatterY : undefined,
    lineMetric:
      normalized.lineMetric && metricMatchesColumns(normalized.lineMetric, columnNames)
        ? normalized.lineMetric
        : undefined,
    benchmarkMetric:
      normalized.benchmarkMetric && metricMatchesColumns(normalized.benchmarkMetric, columnNames)
        ? normalized.benchmarkMetric
        : undefined,
    metrics: normalized.metrics.filter((metric) => metricMatchesColumns(metric, columnNames)),
    tableRowDimension: normalized.tableRowDimension && columnNames.has(normalized.tableRowDimension)
      ? normalized.tableRowDimension
      : undefined,
    tableColumnDimension: normalized.tableColumnDimension && columnNames.has(normalized.tableColumnDimension)
      ? normalized.tableColumnDimension
      : undefined,
    tablePivotMetric:
      normalized.tablePivotMetric && metricMatchesColumns(normalized.tablePivotMetric, columnNames)
        ? normalized.tablePivotMetric
        : undefined,
    selectedColumns: normalized.selectedColumns?.filter((column) => columnNames.has(column)),
    timeGrains: retainTimeGrainsForColumns(normalized.timeGrains, columnNames),
  };

  if (next.selectedColumns && next.selectedColumns.length === 0) {
    next.selectedColumns = undefined;
  }

  return next;
}

function isSourceTimeColumn(column: ColumnMetadata): boolean {
  // TYPE-based ONLY. A date-LIKE NAME on a string/number column does NOT make
  // it a time field. This function gates time-grain / date-hierarchy
  // auto-assignment + auto-default; treating a non-date column as time emits
  // `TIMESTAMP_TRUNC(<that column>, MONTH)`, which BigQuery rejects with
  // "No matching signature for TIMESTAMP_TRUNC; Argument types: STRING".
  // DA-Test repro: a `year_month` STRING (a month LABEL produced by
  // FORMAT_DATE) matched the old name regex /month|year/ → got auto-bucketed →
  // chart 400. To bucket a string-typed date, type-override the column to a
  // date type first (that injects SAFE.PARSE_DATE); only then does it qualify
  // as a time column here.
  const loweredType = String(column.type ?? '').toLowerCase();
  return ['date', 'datetime', 'timestamp', 'time'].includes(loweredType);
}

/**
 * Phase-15.20: PowerBI-style drill controls that live in the chart preview
 * header (NOT in the Configure panel). DA toggles "Date hierarchy" on in
 * the config slot; once on, they drill ↑/↓ through the levels here at
 * view time — same place PowerBI puts the drill buttons.
 *
 * Levels go DAY → WEEK → MONTH → QUARTER → YEAR (low to high resolution).
 * ↓ drills DOWN (coarser → finer, year→day direction); ↑ drills UP. The
 * arrows are disabled at the extremes so DA never lands on an invalid
 * grain. The current level chip in the middle shows where they are.
 */
type TimeGrainLevel = 'day' | 'week' | 'month' | 'quarter' | 'year';
const DRILL_LEVEL_ORDER: TimeGrainLevel[] = ['day', 'week', 'month', 'quarter', 'year'];
const DRILL_LEVEL_LABEL: Record<TimeGrainLevel, string> = {
  day: 'explore.dateDrill.day',
  week: 'explore.dateDrill.week',
  month: 'explore.dateDrill.month',
  quarter: 'explore.dateDrill.quarter',
  year: 'explore.dateDrill.year',
};

function ChartDrillControls({
  fieldDisplayLabel,
  grain,
  disabled,
  onChange,
}: {
  fieldDisplayLabel: string;
  grain: TimeGrainLevel;
  disabled?: boolean;
  onChange: (next: TimeGrainLevel) => void;
}) {
  const { t } = useI18n();
  const idx = DRILL_LEVEL_ORDER.indexOf(grain);
  const canFiner = idx > 0;
  const canCoarser = idx < DRILL_LEVEL_ORDER.length - 1;
  const drillLevelLabel = (level: TimeGrainLevel) => t(DRILL_LEVEL_LABEL[level]);
  const baseBtn = 'inline-flex h-6 w-6 items-center justify-center rounded border border-[rgb(var(--border-line))] bg-surface-1 text-text-secondary transition-colors disabled:cursor-not-allowed disabled:opacity-40';
  const liveBtn = disabled ? '' : 'hover:border-brand/40 hover:bg-brand/10 hover:text-brand';
  return (
    <div
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-1 py-0.5"
      title={t('explore.dateDrill.previewTitle', { field: fieldDisplayLabel })}
    >
      <button
        type="button"
        disabled={disabled || !canFiner}
        onClick={() => canFiner && onChange(DRILL_LEVEL_ORDER[idx - 1])}
        className={`${baseBtn} ${liveBtn}`}
        title={canFiner ? t('explore.dateDrill.drillDownTo', { level: drillLevelLabel(DRILL_LEVEL_ORDER[idx - 1]) }) : t('explore.dateDrill.finestLevel')}
        aria-label={t('explore.dateDrill.drillDown')}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <span className="px-1.5 text-[11px] font-emphasis tracking-wide text-brand">
        {drillLevelLabel(grain)}
      </span>
      <button
        type="button"
        disabled={disabled || !canCoarser}
        onClick={() => canCoarser && onChange(DRILL_LEVEL_ORDER[idx + 1])}
        className={`${baseBtn} ${liveBtn}`}
        title={canCoarser ? t('explore.dateDrill.drillUpTo', { level: drillLevelLabel(DRILL_LEVEL_ORDER[idx + 1]) }) : t('explore.dateDrill.coarsestLevel')}
        aria-label={t('explore.dateDrill.drillUp')}
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export interface ExploreEditorEphemeralSeed {
  chartType?: ChartType;
  chartName?: string | null;
  chartDescription?: string | null;
  queryMode?: 'generated' | 'custom';
  generatedRoleConfig?: ChartRoleConfig | null;
  customRoleConfig?: ChartRoleConfig | null;
  customSql?: string | null;
  styleConfig?: ChartStyleConfig | null;
  baseFilters?: Filter[] | null;
}

export interface ExploreEditorEphemeralResult {
  chartType: ChartType;
  chartName: string;
  chartDescription: string | null;
  queryMode: 'generated' | 'custom';
  customSql: string | null;
  generatedRoleConfig: ChartRoleConfig;
  customRoleConfig: ChartRoleConfig;
  activeRoleConfig: ChartRoleConfig;
  styleConfig: ChartStyleConfig;
  baseFilters: Filter[];
  datasetId: number | null;
  datasetTableId: number | null;
}

export interface ExploreEditorProps {
  chartId?: number | null;
  embedded?: boolean;
  embeddedVariant?: 'default' | 'dashboard-modal';
  initialDatasetId?: number | null;
  initialTableId?: number | null;
  onBack?: () => void;
  onChartSaved?: (chartId: number) => void | Promise<void>;
  /**
   * Fired whenever the currently-selected dataset changes. Lets parents (e.g.
   * a Calculated-Tables side tab) know which dataset the user is working on.
   */
  onDatasetChange?: (datasetId: number | null) => void;
  backLabel?: string;
  saveButtonLabel?: string;
  // ── Ephemeral (unsaved draft) mode ──────────────────────────────────────
  // When mode='ephemeral', no chart row is created/updated in the DB. Save
  // invokes onEphemeralSave with the full config snapshot so the caller
  // (e.g. the HTML-import wizard) can fold it back into its own state.
  mode?: 'full' | 'ephemeral';
  initialSeed?: ExploreEditorEphemeralSeed;
  onEphemeralSave?: (result: ExploreEditorEphemeralResult) => void | Promise<void>;
  // Lock the dataset dropdown — useful when the wizard has already committed
  // to a specific dataset and the user should only change tables within it.
  lockDatasetSelection?: boolean;
}

export function ExploreEditor({
  chartId = null,
  embedded = false,
  embeddedVariant = 'default',
  initialDatasetId = null,
  initialTableId = null,
  onBack,
  onChartSaved,
  onDatasetChange,
  backLabel,
  saveButtonLabel,
  mode = 'full',
  initialSeed,
  onEphemeralSave,
  lockDatasetSelection = false,
}: ExploreEditorProps) {
  const router = useRouter();
  const { t } = useI18n();
  const isEphemeral = mode === 'ephemeral';
  // Ephemeral editors are never bound to an existing chart row.
  const effectiveChartId = isEphemeral ? null : chartId;
  const isNew = effectiveChartId == null;
  const isDashboardModal = embeddedVariant === 'dashboard-modal';

  const [selectedDatasetId, setSelectedDatasetId] = useState<number | null>(initialDatasetId);
  const [selectedTableId, setSelectedTableId] = useState<number | null>(initialTableId);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [chartType, setChartType] = useState<ChartType>('TABLE');
  const [generatedRoleConfig, setGeneratedRoleConfig] = useState<ChartRoleConfig>({ metrics: [] });
  const [customRoleConfig, setCustomRoleConfig] = useState<ChartRoleConfig>({ metrics: [] });
  const [chartStyleConfig, setChartStyleConfig] = useState<ChartStyleConfig>({ ...DEFAULT_STYLE_CONFIG });
  // isSourceOpen removed - source selector is always visible in left panel
  const [chartNameInput, setChartNameInput] = useState('');
  const [isEditingName, setIsEditingName] = useState(isNew);
  const [chartDescInput, setChartDescInput] = useState('');
  const [isEditingDesc, setIsEditingDesc] = useState(false);
  const [isChartLoaded, setIsChartLoaded] = useState(isNew); // skip load for new charts

  // isConfigOpen removed - chart config panel is always visible in right panel
  const [isFiltersOpen, setIsFiltersOpen] = useState(!isDashboardModal);
  const [isDescDrawerOpen, setIsDescDrawerOpen] = useState(false);
  /**
   * Phase-15.9: 'query' tab shows DA the BE-side pipeline that produced
   * the current preview — SQL emitted, dialect detected (Phase-12.6),
   * routing path (semantic engine vs live_query), exec time, row count,
   * engine warnings. Helps DA debug "table shows X but chart shows Y"
   * by checking whether the SQL ran on the path they expected.
   */
  const [previewPanelTab, setPreviewPanelTab] = useState<'chart' | 'table' | 'query'>('chart');
  // Phase-15.83 — queryLimit state retained for backward-compat with the
  // run-query payload (BE param is still `limit`), but defaulted to the
  // no-limit sentinel and never displayed in the UI.
  const [queryLimit] = useState(NO_LIMIT_SENTINEL);
  const [sqlMode, setSqlMode] = useState<QueryMode>('generated');
  const [customSqlDraft, setCustomSqlDraft] = useState('');
  const [generatedQueryState, setGeneratedQueryState] = useState<ExploreQueryState | null>(null);
  const [customQueryState, setCustomQueryState] = useState<ExploreQueryState | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [generatedLastRunSignature, setGeneratedLastRunSignature] = useState('');
  const [customLastRunSignature, setCustomLastRunSignature] = useState('');

  // Metadata state (persisted on save, not shown in sidebar UI)
  const [metaDomain, setMetaDomain] = useState('');
  const [metaIntent, setMetaIntent] = useState('');
  const [metaMetrics, setMetaMetrics] = useState<string[]>([]);
  const [metaDimensions, setMetaDimensions] = useState<string[]>([]);
  const [metaTags, setMetaTags] = useState<string[]>([]);

  // Parameters state
  type ParamRow = ChartParameterCreate & { _key: string };
  const [paramRows, setParamRows] = useState<ParamRow[]>([]);

  const createChart = useCreateChart();
  const updateChart = useUpdateChart();
  const dryRunCreateChart = useDryRunCreateChart();
  const upsertMetadata = useUpsertChartMetadata();
  const replaceParams = useReplaceChartParameters();
  const previewChartData = usePreviewChartData();

  const { data: chart, isLoading: isChartLoading } = useChart(isEphemeral ? 0 : (chartId ?? 0));
  const { data: dataset } = useDataset(selectedDatasetId);
  const { data: datasetModel, isLoading: isDatasetModelLoading } = useDatasetModel(selectedDatasetId);
  // Model-aware base recommendation: the central fact (measure table reaching
  // the most others via N:1). Drives the "recommended" marker in the base
  // picker; the auto-derive-from-first-field default is unchanged so the common
  // "measure by dim" chart still anchors on the dim (member-preserving).
  const recommendedBaseTableId = useMemo(
    () => pickRecommendedBaseTableId(datasetModel ?? null),
    [datasetModel],
  );
  const resPerms = getResourcePermissions(isNew ? 'full' : chart?.user_permission);

  /**
   * Phase-4: build a {qualified-or-bare field → display label} map from the
   * dataset's semantic model. Passed into ExploreChart so chart legends /
   * tooltips render the user-friendly label declared on the measure or
   * dimension (e.g. "Số người dùng" instead of "task_user_distinct").
   *
   * Same map covers both dimensions and measures. Falls back to undefined
   * when the model hasn't loaded, in which case metricLabel uses the bare
   * field name (already a big improvement over "AUTO of view.field").
   */
  // Shared builder (lib/chart-semantic-maps) so Dashboard surfaces format +
  // label charts IDENTICALLY to this editor — see the file's header for the
  // chart-vs-dashboard divergence this single-sources away.
  const semanticLabelMap = useMemo(
    () => buildSemanticLabelMap(datasetModel?.views),
    [datasetModel],
  );

  /**
   * Phase-15.93 — build {qualified-or-bare field → NumberFormat} map from
   * the dataset's semantic measures. Lets KPI / chart number-format default
   * to the format declared on the measure (eg. percent for CR1, currency
   * for revenue) instead of falling back to 'compact' when the user hasn't
   * set a chart-level Number Format.
   *
   * Maps MeasureFormat.kind → NumberFormat (the ChartStyleConfig type):
   *   - 'percent'  → 'percent'
   *   - 'currency' → 'currency'
   *   - 'number'   → 'number'
   *   - 'duration' / 'custom' → skipped (no NumberFormat equivalent;
   *     chart picks its own default rather than mis-format)
   *
   * Style-level overrides (seriesFormats, numberFormat) still win — this
   * is only the default when nothing else is set.
   */
  const semanticFormatMap = useMemo(
    () => buildSemanticFormatMap(datasetModel?.views),
    [datasetModel],
  );

  const skipNextSourceResetRef = useRef(false);
  const seedAppliedRef = useRef(false);
  const resolvedBackLabel = backLabel ?? (embedded ? 'Back to dashboard' : 'All Charts');

  // One-shot seed of editor state from the ephemeral initialSeed. Must run
  // before the generic "sync role config with columns" effects so it wins.
  useEffect(() => {
    if (!isEphemeral || seedAppliedRef.current) return;
    if (!initialSeed) {
      seedAppliedRef.current = true;
      return;
    }
    seedAppliedRef.current = true;
    if (initialSeed.chartType) setChartType(initialSeed.chartType);
    if (initialSeed.chartName != null) setChartNameInput(initialSeed.chartName);
    if (initialSeed.chartDescription != null) setChartDescInput(initialSeed.chartDescription);
    if (initialSeed.styleConfig) {
      setChartStyleConfig(normalizeChartStyleConfig(initialSeed.styleConfig, undefined));
    }
    if (initialSeed.baseFilters) setFilters(initialSeed.baseFilters);
    const seedChartType = initialSeed.chartType ?? 'TABLE';
    if (initialSeed.generatedRoleConfig) {
      setGeneratedRoleConfig(normalizeRoleConfig(seedChartType, initialSeed.generatedRoleConfig));
    }
    if (initialSeed.customRoleConfig) {
      setCustomRoleConfig(normalizeRoleConfig(seedChartType, initialSeed.customRoleConfig));
    }
    if (initialSeed.customSql != null) setCustomSqlDraft(initialSeed.customSql);
    if (initialSeed.queryMode === 'custom' && initialSeed.customSql) {
      setSqlMode('custom');
    } else {
      setSqlMode('generated');
    }
    // Name editing starts closed once we have a real seeded name.
    if (initialSeed.chartName) setIsEditingName(false);
  }, [isEphemeral, initialSeed]);

  useEffect(() => {
    if (isDashboardModal && sqlMode !== 'generated') {
      setSqlMode('generated');
    }
  }, [isDashboardModal, sqlMode]);

  useEffect(() => {
    if (initialDatasetId != null && selectedDatasetId == null) {
      setSelectedDatasetId(initialDatasetId);
    }
  }, [initialDatasetId, selectedDatasetId]);

  useEffect(() => {
    onDatasetChange?.(selectedDatasetId);
  }, [selectedDatasetId, onDatasetChange]);

  useEffect(() => {
    if (initialTableId != null && selectedTableId == null) {
      setSelectedTableId(initialTableId);
    }
  }, [initialTableId, selectedTableId]);

  const handleExit = useCallback(() => {
    if (onBack) {
      onBack();
      return;
    }
    router.push('/explore');
  }, [onBack, router]);

  // Load existing chart config into editor state on first data arrival
  useEffect(() => {
    if (isChartLoaded || isNew) return;
    if (!chart) return;

    const config = chart.config as any;
    const savedQueryMode = normalizeSavedQueryMode(config);
    const savedChartType = config?.chartType ?? chart.chart_type;
    if (chart.dataset_table_id) {
      skipNextSourceResetRef.current = true;
      setSelectedTableId(chart.dataset_table_id);
      const datasetId = config?.dataset_id ?? chart.dataset_id;
      if (datasetId) setSelectedDatasetId(datasetId);
    } else if (config?.source?.kind === 'dataset_table') {
      skipNextSourceResetRef.current = true;
      setSelectedDatasetId(config.source.datasetId);
      setSelectedTableId(config.source.tableId);
    }
    const persistedFilters = Array.isArray(config?.baseFilters) && config.baseFilters.length > 0
      ? config.baseFilters
      : (config?.filters ?? []);
    setFilters(persistedFilters);
    setChartType(savedChartType);
    setChartStyleConfig(normalizeChartStyleConfig(config?.styleConfig, config?.conditional_formatting));
    const initialGeneratedRoleConfig = normalizeRoleConfig(
      savedChartType,
      (config?.generatedRoleConfig ?? (savedQueryMode === 'generated' ? config?.roleConfig : null)) as ChartRoleConfig,
    );
    const initialCustomRoleConfig = normalizeRoleConfig(
      savedChartType,
      (config?.customRoleConfig
        ?? (savedQueryMode === 'custom' ? config?.roleConfig : null)) as ChartRoleConfig,
    );
    setGeneratedRoleConfig(initialGeneratedRoleConfig);
    setCustomRoleConfig(initialCustomRoleConfig);
    setSqlMode(savedQueryMode);
    setCustomSqlDraft(typeof config?.customSql === 'string' ? config.customSql.trim() : '');
    setChartNameInput(chart.name);
    setChartDescInput(chart.description ?? '');
    // Load metadata
    if (chart.metadata) {
      setMetaDomain(chart.metadata.domain ?? '');
      setMetaIntent(chart.metadata.intent ?? '');
      setMetaMetrics(chart.metadata.metrics ?? []);
      setMetaDimensions(chart.metadata.dimensions ?? []);
      setMetaTags(chart.metadata.tags ?? []);
    }
    // Load parameters
    if (chart.parameters?.length) {
      setParamRows(chart.parameters.map((p) => ({
        ...p,
        column_mapping: p.column_mapping ?? null,
        default_value: p.default_value ?? null,
        description: p.description ?? null,
        _key: String(p.id),
      })));
    }
    setIsChartLoaded(true);
  }, [chart, isChartLoaded, isNew]);

  const {
    data: previewData,
    isLoading: isPreviewLoading,
    error: previewError,
  } = useTablePreview(selectedDatasetId, selectedTableId, {});
  const previewErrorMessage = useMemo(
    () => getApiErrorMessage(
      previewError,
      'Could not load table preview. The backend request did not complete.'
    ),
    [previewError],
  );
  const selectedTable = dataset?.tables?.find((table) => table.id === selectedTableId) ?? null;
  const selectedTableDisplayName = selectedTable?.display_name || selectedTable?.source_table_name || 'Selected table';
  const tableDisplayById = useMemo(() => {
    const map = new Map<number, string>();
    for (const table of dataset?.tables ?? []) {
      map.set(table.id, table.display_name || table.source_table_name || `Table ${table.id}`);
    }
    return map;
  }, [dataset?.tables]);
  const getSemanticViewDisplayName = useCallback((view: DatasetModelView): string => (
    view.table_display_name
    || (view.dataset_table_id ? tableDisplayById.get(view.dataset_table_id) : undefined)
    || (/^dataset_table_\d+$/i.test(view.name) ? 'Dataset table' : humanizeFieldName(view.name))
  ), [tableDisplayById]);
  const calculatedColumnNames = useMemo(() => {
    const out = new Set<string>();
    for (const step of selectedTable?.transformations ?? []) {
      if (!step.enabled) continue;
      if (step.type !== 'js_formula' && step.type !== 'add_column') continue;
      const newField = String(step.params?.newField || '').trim();
      if (newField) out.add(newField);
    }
    return out;
  }, [selectedTable?.transformations]);
  const hasActiveTransforms = Boolean(selectedTable?.transformations?.some((step) => step.enabled));
  const selectedSemanticView = useMemo(
    () => datasetModel?.views?.find((view) => view.dataset_table_id === selectedTableId) ?? null,
    [datasetModel?.views, selectedTableId],
  );
  /**
   * Cross-table support: from the selected table's semantic view, walk the
   * explore's join graph to find every reachable view. The chart builder uses
   * dimensions/measures from ALL reachable views (not just the selected one)
   * so cross-table fields can flow through to the backend semantic engine,
   * which already knows how to JOIN them via SemanticExplore.joins.
   *
   * Phase-15.10 — empty-base fallback: when no base view is selected yet
   * (NEW chart, user has not picked any field), expose EVERY view in the
   * dataset model so the field picker is usable upfront. The base view gets
   * auto-derived from the first picked field's view (see effect below),
   * after which reachability narrows to the JOIN graph rooted at that view.
   */
  const reachableSemanticViews = useMemo<DatasetModelView[]>(() => {
    if (!datasetModel) return [];
    if (!selectedSemanticView) {
      // Show all non-hidden views — base hasn't been set, so DA can pick
      // freely. Filter out views explicitly hidden from canvas (matches
      // ExploreColumnPanel's visibility rule).
      return (datasetModel.views ?? []).filter((view) => !view.hidden_in_canvas);
    }
    return getReachableViews(datasetModel, selectedSemanticView.name);
  }, [datasetModel, selectedSemanticView]);
  const reachableViewNames = useMemo<Set<string>>(
    () => new Set(reachableSemanticViews.map((view) => view.name)),
    [reachableSemanticViews],
  );
  // PBI parity (2026-06) — views the picker offers (bidirectionally reachable)
  // but which the backend's single-direction resolver will NOT let a filter
  // propagate to. A filter on such a field looks valid but is silently ignored
  // at query time, so the filter UI flags it up-front (model-time warning).
  const bridgeOnlyViewNames = useMemo<Set<string>>(() => {
    if (!datasetModel || !selectedSemanticView) return new Set();
    const strict = computeStrictReachableViews(datasetModel, selectedSemanticView.name);
    const out = new Set<string>();
    for (const name of reachableViewNames) {
      if (!strict.has(name)) out.add(name);
    }
    return out;
  }, [datasetModel, selectedSemanticView, reachableViewNames]);
  const semanticColumns = useMemo<ColumnMetadata[]>(() => {
    if (reachableSemanticViews.length === 0) return [];
    const out: ColumnMetadata[] = [];
    for (const view of reachableSemanticViews) {
      const viewLabel = getSemanticViewDisplayName(view);
      for (const dim of view.dimensions ?? []) {
        if (dim.hidden) continue;
        out.push({
          name: `${view.name}.${dim.name}`,
          type: dim.type === 'number' ? 'number' : dim.type,
          label: (dim.label && dim.label.trim()) ? dim.label : dim.name,
          nullable: true,
          sourceKind: 'semantic',
          fieldKind: dim.type === 'date' || dim.type === 'datetime' ? 'date' : 'dimension',
          viewName: view.name,
          viewLabel,
          tableId: view.dataset_table_id,
          tableLabel: viewLabel,
        });
      }
      // System-managed calendar views (the generated Date table + per-column
      // `__date_dim` layers) carry only an auto "Count" measure — not a business
      // metric, and the BE rejects user measures on them. Keep them OUT of the
      // Explore metric picker (DA6 residual-B sibling). Their DIMENSIONS
      // (Year/Quarter/Month) are still emitted above — date grouping needs them.
      for (const measure of (view.system_managed ? [] : view.measures) ?? []) {
        if (measure.hidden) continue;
        const isCalculatedMeasure = Boolean(
          measure.expression
          || measure.depends_on?.length
          || measure.type === 'percent_of_total'
        );
        out.push({
          name: `${view.name}.${measure.name}`,
          type: 'number',
          label: (measure.label && measure.label.trim()) ? measure.label : measure.name,
          nullable: true,
          sourceKind: isCalculatedMeasure ? 'calculated' : 'semantic',
          fieldKind: 'measure',
          viewName: view.name,
          viewLabel,
          tableId: view.dataset_table_id,
          tableLabel: viewLabel,
        });
      }
    }
    return out;
  }, [getSemanticViewDisplayName, reachableSemanticViews]);

  /**
   * Phase-15.7 — Set of qualified field refs that ARE declared measures
   * on reachable semantic views. Anything qualified that's NOT in this
   * set must be an "implicit measure" — a numeric dim the BE auto-promotes
   * to SUM(field) at query time (see semantic_query_engine.py implicit
   * fallback). FE uses this to surface the "auto" badge consistently for
   * both bare AND qualified implicit picks.
   */
  const declaredMeasureRefs = useMemo<Set<string>>(() => {
    const out = new Set<string>();
    for (const view of reachableSemanticViews) {
      for (const measure of view.measures ?? []) {
        if (measure.hidden) continue;
        out.add(`${view.name}.${measure.name}`);
      }
    }
    return out;
  }, [reachableSemanticViews]);

  /**
   * Phase-15.11 — JOIN-key column refs.
   *
   * Columns that appear on either side of a JoinDefinition are PK/FK in
   * practice — they exist so the engine can wire JOINs, not so DA can
   * group/aggregate by them. Surfacing them in the chart picker pollutes
   * Suggested with values like `id`, `customer_id`, `order_id` that are
   * almost never the chart's intent. We collect them up-front and pass
   * down so FieldPicker can hide them by default (with a "Show JOIN keys"
   * escape hatch for power users).
   *
   * Each ref is `view_name.bare_column_name`. We pull from BOTH
   * from_column/to_column singletons AND from_columns/to_columns arrays
   * (composite keys). Empty / unresolved sides are skipped.
   */
  const joinKeyRefs = useMemo<Set<string>>(() => {
    const out = new Set<string>();
    if (!datasetModel) return out;
    const explores = datasetModel.explores ?? [];
    const baseByExplore = new Map<number, string>();
    for (const explore of explores) {
      if (explore.base_view_name) baseByExplore.set(explore.id, explore.base_view_name);
    }
    for (const explore of explores) {
      const baseView = baseByExplore.get(explore.id);
      for (const join of explore.joins ?? []) {
        if (join.is_active === false) continue;
        const fromView = join.from_view || baseView;
        const toView = join.view; // join.view = the joined-in view
        const pushPair = (view: string | undefined, col: string | undefined) => {
          if (!view || !col) return;
          out.add(`${view}.${col}`);
        };
        pushPair(fromView, join.from_column);
        pushPair(toView, join.to_column);
        for (const col of join.from_columns ?? []) pushPair(fromView, col);
        for (const col of join.to_columns ?? []) pushPair(toView, col);
      }
    }
    return out;
  }, [datasetModel]);

  /**
   * Phase-15.1 — Hierarchy map for drill-down UX.
   *
   * Maps qualified child field name → qualified parent field name, derived
   * from `DimensionDefinition.parent` (Phase-13.1 metadata). Used by
   * `ExploreChartConfig` to surface a "↓ Drill into <child>" action when
   * the chart's dimension has children declared on its view.
   *
   * Pure metadata. The engine doesn't see this — drill-down just swaps the
   * chart's `dimension` field for the child and re-runs the query. Keeps
   * Phase-1 "2 cơ chế" invariant: no new calculation mechanism, only a
   * navigation shortcut.
   */
  const dimHierarchy = useMemo<{
    parentOf: Map<string, string>;
    childrenOf: Map<string, string[]>;
  }>(() => {
    const parentOf = new Map<string, string>();
    const childrenOf = new Map<string, string[]>();
    for (const view of reachableSemanticViews) {
      for (const dim of view.dimensions ?? []) {
        if (!dim.parent) continue;
        const child = `${view.name}.${dim.name}`;
        const parent = `${view.name}.${dim.parent}`;
        parentOf.set(child, parent);
        const list = childrenOf.get(parent) ?? [];
        list.push(child);
        childrenOf.set(parent, list);
      }
    }
    return { parentOf, childrenOf };
  }, [reachableSemanticViews]);

  /**
   * Phase-12.5 — Bare-to-qualified field name registry.
   *
   * Maps `"amount"` → `"deals.amount"` whenever the bare name appears on
   * exactly ONE reachable semantic view. Used by `upgradeRoleConfigToQualified`
   * (defined above) to silently rewrite chart configs so the BE always sees
   * dotted refs when a semantic column exists. Eliminates the FE→BE contract
   * gap that DA identified: bare ref → live_query path, qualified ref →
   * semantic engine with JOIN resolver.
   *
   * Ambiguous cases (same bare name on multiple views) are SKIPPED — leaving
   * the value bare. The configure picker keeps qualified refs available so the
   * user can pick the exact view.field explicitly.
   */
  const qualifiedByBare = useMemo<Map<string, string>>(() => {
    const occurrences = new Map<string, string[]>();
    for (const col of semanticColumns) {
      if (!col.name.includes('.')) continue;
      const bare = col.name.split('.', 2)[1];
      const list = occurrences.get(bare) ?? [];
      list.push(col.name);
      occurrences.set(bare, list);
    }
    const map = new Map<string, string>();
    for (const [bare, qualifiedList] of occurrences.entries()) {
      if (qualifiedList.length === 1) {
        map.set(bare, qualifiedList[0]);
      }
    }
    return map;
  }, [semanticColumns]);

  /**
   * Bare names that exist on MORE THAN ONE semantic view (e.g. `year_month`
   * on fct_sales + fct_target + the per-link date-dim views; `product_id`
   * across joined facts). A bare reference to one of these can't be uniquely
   * qualified, so the engine fails loudly ("Field 'X' xuất hiện ở nhiều bảng
   * đã JOIN"). The auto-seed must never DEFAULT to such a name — DA7-B1 root
   * is broader than identifier keys (year_month is a non-id ambiguous dim).
   */
  const ambiguousBareNames = useMemo<Set<string>>(() => {
    const occurrences = new Map<string, number>();
    for (const col of semanticColumns) {
      if (!col.name.includes('.')) continue;
      const bare = col.name.split('.', 2)[1];
      occurrences.set(bare, (occurrences.get(bare) ?? 0) + 1);
    }
    const ambiguous = new Set<string>();
    for (const [bare, count] of occurrences.entries()) {
      if (count > 1) ambiguous.add(bare);
    }
    return ambiguous;
  }, [semanticColumns]);

  /**
   * Phase-12.5 — Semantic-ready gate.
   *
   * Returns true when the dataset model has finished loading AND we know
   * whether semantic columns exist. Used to avoid the race condition DA
   * identified: previewColumns may arrive before semanticColumns, causing
   * `syncRoleConfigWithColumns` to pick a bare column first; when semantic
   * columns later load, the choice is "stuck" because the bare name also
   * exists in `[previewColumns, semanticColumns]`. Gating the seeding pass
   * on this flag delays the role-config seed until both sources are
   * available — eliminating the partial-config requests DA observed.
   */
  const semanticReady = useMemo(
    () => Boolean(datasetModel) && (selectedSemanticView === null || reachableSemanticViews.length > 0),
    [datasetModel, selectedSemanticView, reachableSemanticViews.length],
  );

  /**
   * Phase-12.5 — Active-relationship summary for the topbar chip.
   *
   * DA feedback said the FE state had "no explicit relationship awareness."
   * Cross-table state IS tracked (via `reachableViewNames`), it just wasn't
   * surfaced. This memo computes a compact summary the user can SEE so the
   * mental model lines up with what the engine will do at query time:
   *
   *   - `activeViewCount` — how many semantic views the chart can pull
   *     fields from (base view + every view reachable via active joins).
   *   - `crossTableInUse` — true when the current roleConfig actually
   *     references a view OTHER than the chart's base view (i.e. JOINs
   *     will fire at BE).
   */
  const activeRelationshipSummary = useMemo(() => {
    if (!datasetModel || !selectedSemanticView) {
      return { activeViewCount: 0, crossTableInUse: false };
    }
    const baseView = selectedSemanticView.name;
    const reachable = reachableViewNames;
    const refsViews = new Set<string>();
    const collectField = (field?: string) => {
      if (!field || !field.includes('.')) return;
      const view = field.split('.', 1)[0];
      if (view && view !== baseView) refsViews.add(view);
    };
    const rc = generatedRoleConfig;
    collectField(rc.dimension);
    collectField(rc.breakdown);
    collectField(rc.timeField);
    collectField(rc.scatterX);
    collectField(rc.scatterY);
    collectField(rc.tableRowDimension);
    collectField(rc.tableColumnDimension);
    rc.metrics.forEach((m) => collectField(m.field));
    collectField(rc.lineMetric?.field);
    collectField(rc.benchmarkMetric?.field);
    collectField(rc.tablePivotMetric?.field);
    rc.selectedColumns?.forEach(collectField);
    return {
      activeViewCount: reachable.size,
      crossTableInUse: refsViews.size > 0,
      crossTableViews: Array.from(refsViews),
    };
  }, [datasetModel, selectedSemanticView, reachableViewNames, generatedRoleConfig]);

  /** Map of bare column-name → friendly label, sourced from the selected
   *  view's dimensions/measures so raw preview columns can also display
   *  the user-facing label rather than the SQL identifier. Only the selected
   *  (anchor) view contributes here because preview rows belong to that table. */
  const semanticLabelByColumnName = useMemo<Map<string, string>>(() => {
    const map = new Map<string, string>();
    if (!selectedSemanticView) return map;
    for (const dim of selectedSemanticView.dimensions ?? []) {
      if (dim.label && dim.label.trim()) map.set(dim.name, dim.label.trim());
    }
    for (const measure of selectedSemanticView.measures ?? []) {
      if (measure.label && measure.label.trim()) map.set(measure.name, measure.label.trim());
    }
    return map;
  }, [selectedSemanticView]);
  const normalizedGeneratedRoleConfig = useMemo(
    () => normalizeRoleConfig(chartType, generatedRoleConfig),
    [generatedRoleConfig, chartType],
  );
  const normalizedCustomRoleConfig = useMemo(
    () => normalizeRoleConfig(chartType, customRoleConfig),
    [customRoleConfig, chartType],
  );
  const activeRoleConfig = sqlMode === 'custom' ? customRoleConfig : generatedRoleConfig;
  const normalizedRoleConfig = sqlMode === 'custom'
    ? normalizedCustomRoleConfig
    : normalizedGeneratedRoleConfig;
  const effectiveQueryLimit = useMemo(
    () => Math.min(queryLimit, getMaxQueryLimit(sqlMode)),
    [queryLimit, sqlMode],
  );
  const queryLimitOptions = sqlMode === 'custom'
    ? CUSTOM_QUERY_LIMIT_OPTIONS
    : GENERATED_QUERY_LIMIT_OPTIONS;
  const activeValidationMessage = useMemo(
    () => getChartRoleConfigValidationMessage(chartType, normalizedRoleConfig),
    [chartType, normalizedRoleConfig],
  );
  const generatedRoleRequirementMessage = useMemo(
    () => getChartRoleConfigRequirementMessage(chartType, normalizedGeneratedRoleConfig),
    [chartType, normalizedGeneratedRoleConfig],
  );
  const customRoleRequirementMessage = useMemo(
    () => customQueryState
      ? getChartRoleConfigRequirementMessage(chartType, normalizedCustomRoleConfig)
      : null,
    [chartType, customQueryState, normalizedCustomRoleConfig],
  );
  const previewColumns = useMemo<ColumnMetadata[]>(() => {
    const raw = previewData?.columns ?? [];
    return raw.map((col) => {
      const sourceKind = calculatedColumnNames.has(col.name) ? 'calculated' : 'source';
      const fieldKind = isSourceTimeColumn(col)
        ? 'date'
        : sourceKind === 'calculated'
          ? 'calculated'
          : 'source';
      const commonMeta = {
        sourceKind,
        fieldKind,
        tableId: selectedTableId ?? undefined,
        tableLabel: selectedTableDisplayName,
        viewName: selectedSemanticView?.name,
        viewLabel: selectedSemanticView ? getSemanticViewDisplayName(selectedSemanticView) : selectedTableDisplayName,
      } satisfies Partial<ColumnMetadata>;
      if (col.label && col.label.trim()) {
        return { ...col, ...commonMeta };
      }
      const friendly = semanticLabelByColumnName.get(col.name);
      return friendly ? { ...col, ...commonMeta, label: friendly } : { ...col, ...commonMeta };
    });
  }, [
    calculatedColumnNames,
    getSemanticViewDisplayName,
    previewData?.columns,
    selectedSemanticView,
    selectedTableDisplayName,
    selectedTableId,
    semanticLabelByColumnName,
  ]);
  const previewRows = previewData?.rows ?? [];
  const customConfigColumns = useMemo<ColumnMetadata[] | null>(() => {
    if (!customQueryState?.columns) return null;
    return customQueryState.columns.map((column) => ({
      ...column,
      sourceKind: 'custom',
      fieldKind: isSourceTimeColumn(column) ? 'date' : 'source',
      tableLabel: 'SQL output',
      viewLabel: 'SQL output',
    }));
  }, [customQueryState?.columns]);
  /**
   * Phase-15.11: dedup preview ↔ semantic columns from the same base view.
   *
   * Without this, the picker shows e.g. `role_pic_bc` twice: once as a
   * physical-preview column (sourceKind='source', tag "Raw"), once as a
   * semantic dim (`Meetings.role_pic_bc`, sourceKind='semantic', tag "Dim").
   * They are the same column displayed under different identities — DA
   * sees a fake duplicate. Preferring the semantic version keeps the
   * qualified-ref contract (BE routes via SemanticQueryEngine) and hides
   * the redundant raw row.
   */
  const dedupedPreviewColumns = useMemo<ColumnMetadata[]>(() => {
    if (!previewColumns.length) return previewColumns;
    if (!semanticColumns.length) return previewColumns;
    const baseViewName = selectedSemanticView?.name;
    if (!baseViewName) return previewColumns; // pre-derive state — leave alone
    const semanticBareInBaseView = new Set<string>();
    for (const c of semanticColumns) {
      if (c.viewName !== baseViewName) continue;
      const bare = c.name.includes('.') ? c.name.split('.').slice(1).join('.') : c.name;
      semanticBareInBaseView.add(bare);
    }
    return previewColumns.filter((c) => !semanticBareInBaseView.has(c.name));
  }, [previewColumns, semanticColumns, selectedSemanticView]);
  const configColumns = sqlMode === 'custom'
    ? (customConfigColumns ?? [])
    : [...dedupedPreviewColumns, ...semanticColumns];
  const executeRequest = useMemo(
    () => buildExploreExecuteRequest({
      chartType,
      roleConfig: normalizedGeneratedRoleConfig,
      styleConfig: chartStyleConfig,
      filters,
      limit: effectiveQueryLimit,
      availableColumns: configColumns,
    }),
    [chartType, normalizedGeneratedRoleConfig, chartStyleConfig, filters, effectiveQueryLimit, configColumns],
  );
  const generatedSql = useMemo(
    () => buildExploreSqlPreview({
      table: selectedTable,
      chartType,
      roleConfig: normalizedGeneratedRoleConfig,
      styleConfig: chartStyleConfig,
      filters,
      limit: effectiveQueryLimit,
      availableColumns: configColumns,
    }),
    [selectedTable, chartType, normalizedGeneratedRoleConfig, chartStyleConfig, filters, effectiveQueryLimit, configColumns],
  );
  const currentQuerySignature = useMemo(
    () => buildQuerySignature({
      datasetId: selectedDatasetId,
      tableId: selectedTableId,
      limit: effectiveQueryLimit,
      sqlMode,
      chartType,
      roleConfig: normalizedRoleConfig,
      styleConfig: chartStyleConfig,
      filters,
      request: executeRequest,
      customSql: customSqlDraft,
    }),
    [
      selectedDatasetId,
      selectedTableId,
      effectiveQueryLimit,
      sqlMode,
      chartType,
      normalizedRoleConfig,
      chartStyleConfig,
      filters,
      executeRequest,
      customSqlDraft,
    ],
  );
  const activeQueryState = sqlMode === 'custom' ? customQueryState : generatedQueryState;
  const activeLastRunSignature = sqlMode === 'custom'
    ? customLastRunSignature
    : generatedLastRunSignature;
  const isQueryDirty = activeQueryState !== null && currentQuerySignature !== activeLastRunSignature;
  const isRunningQuery = previewChartData.isPending;
  const filterColumns = sqlMode === 'custom'
    ? (customConfigColumns ?? [])
    // Chart filters run as a pre-aggregation WHERE, so offer every DIMENSION —
    // including numeric dimension columns (e.g. count_login) which the viewer
    // filters with >/</between/=. Only exclude declared aggregation MEASURES
    // (a measure belongs in HAVING, not WHERE). The old `type !== 'number'`
    // guard wrongly hid ALL numeric columns, so a numeric dimension could never
    // be found in the field picker ("No fields match" on count_login).
    : [...dedupedPreviewColumns, ...semanticColumns.filter((column) => column.fieldKind !== 'measure')];
  const filterRows = sqlMode === 'custom'
    ? (customQueryState?.rows ?? [])
    : previewRows;
  const parameterColumns = sqlMode === 'custom'
    ? (customConfigColumns ?? [])
    : previewColumns;
  const displayedQueryState = activeQueryState;
  const fieldDisplayByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const column of configColumns) {
      const label = column.label?.trim() || humanizeFieldName(column.name);
      map.set(column.name, label);
    }
    return map;
  }, [configColumns]);
  const getFieldDisplayName = useCallback(
    (field: string) => fieldDisplayByName.get(field) ?? humanizeFieldName(field),
    [fieldDisplayByName],
  );
  const formatFieldListDisplay = useCallback(
    (fields: string[]) => fields.map(getFieldDisplayName).join(', '),
    [getFieldDisplayName],
  );

  const tableDisplayColumns = useMemo(() => {
    if (!TABLE_LIKE_CHART_TYPES.has(chartType)) {
      return [];
    }

    if (displayedQueryState?.chartRows?.length) {
      const tableModel = buildExploreChartModel({
        type: chartType,
        data: displayedQueryState.chartRows,
        roleConfig: normalizedRoleConfig,
        preAggregated: displayedQueryState.chartPreAggregated,
      });

      return normalizeTableDisplayColumns(
        inferQueryColumns(tableModel.tableColumns, tableModel.tableData),
        normalizedRoleConfig,
      );
    }

    const previewModel = buildExploreChartModel({
      type: chartType,
      data: previewRows,
      roleConfig: normalizedRoleConfig,
      preAggregated: false,
    });

    return normalizeTableDisplayColumns(
      inferQueryColumns(previewModel.tableColumns, previewModel.tableData),
      normalizedRoleConfig,
    );
  }, [chartType, displayedQueryState?.chartPreAggregated, displayedQueryState?.chartRows, normalizedRoleConfig, previewRows]);

  const previewSeriesKeys = useMemo(() => {
    const rows = displayedQueryState?.chartRows ?? [];
    if (
      !rows.length ||
      TABLE_LIKE_CHART_TYPES.has(chartType) ||
      NO_DIMENSION_METRIC_CHART_TYPES.has(chartType) ||
      chartType === 'PODIUM' ||
      SCATTER_LIKE_CHART_TYPES.has(chartType)
    ) {
      return [];
    }
    const model = buildExploreChartModel({
      type: chartType,
      data: rows,
      roleConfig: normalizedRoleConfig,
      preAggregated: displayedQueryState?.chartPreAggregated ?? false,
    });
    // Phase-15.84 — append calculated fields so DA can target them in
    // editors that key on series (Series colors, Data Labels override,
    // per-series format). LINE/AREA renderers iterate over
    // `categoricalSeriesWithCalc` so the calc-field key reaches the
    // chart; without this append the dropdown silently omits them.
    const calcFieldSeries: { key: string; label: string }[] =
      (chartStyleConfig.calculatedFields ?? []).map((f) => ({
        key: f.id,
        label: f.label || f.id,
      }));
    if (chartType === 'BAR_LINE') {
      return [
        ...(model.comboBarSeries ?? []),
        ...(model.comboLineSeries ?? []),
      ].map((s) => ({ key: s.key, label: s.label }));
    }
    if (PIE_LIKE_CHART_TYPES.has(chartType)) {
      // Phase-15.82 bugfix — defensive dedupe by slice name. The model's
      // pieData is now deduped upstream (chartDataAdapter), but legacy
      // callers / older charts may still emit duplicates if the model
      // builder is bypassed. Keep this filter so Series-colors never
      // shows the same label twice with different swatches.
      const seen = new Set<string>();
      const unique: { key: string; label: string }[] = [];
      for (const p of (model.pieData ?? [])) {
        const name = String((p as any)?.name ?? '');
        if (seen.has(name)) continue;
        seen.add(name);
        unique.push({ key: name, label: name });
        if (unique.length >= 12) break;
      }
      return unique;
    }
    // Phase-15.87 — Advanced name-value charts (FUNNEL, TREEMAP,
    // MAP_REGION, BOXPLOT, WORD_CLOUD, WATERFALL) render one slice/stage
    // per distinct dimension value, not per metric. DA-reported bug:
    // editing FUNNEL Series colors only listed the metric key
    // (`tong_lead_nhan`) instead of the 5 stages (Lead/MQL/SAL/etc.).
    // Mirror PIE: compute slices client-side from rows + dimension.
    const NAME_VALUE_ADVANCED = new Set<string>(['FUNNEL', 'TREEMAP', 'MAP_REGION', 'BOXPLOT', 'WORD_CLOUD', 'WATERFALL']);
    if (NAME_VALUE_ADVANCED.has(chartType) && normalizedRoleConfig.dimension) {
      const seen = new Set<string>();
      const unique: { key: string; label: string }[] = [];
      for (const row of rows) {
        const name = String((row as any)[normalizedRoleConfig.dimension] ?? '(blank)');
        if (seen.has(name)) continue;
        seen.add(name);
        unique.push({ key: name, label: name });
        if (unique.length >= 24) break;
      }
      return [...unique, ...calcFieldSeries];
    }
    // Phase-15.87 — RADAR keys series by metricKey (one polygon per
    // metric). Model.categoricalSeries already has the right shape;
    // calc fields don't render in radar.
    if (chartType === 'RADAR') {
      return (model.categoricalSeries ?? []).map((s) => ({ key: s.key, label: s.label }));
    }
    return [
      ...(model.categoricalSeries ?? []).map((s) => ({ key: s.key, label: s.label })),
      ...calcFieldSeries,
    ];
  }, [chartType, displayedQueryState?.chartRows, displayedQueryState?.chartPreAggregated, normalizedRoleConfig, chartStyleConfig.calculatedFields]);

  const sortLimitColumns = useMemo(() => {
    const inferenceRows = displayedQueryState?.chartRows?.length
      ? displayedQueryState.chartRows
      : displayedQueryState?.rows?.length
        ? displayedQueryState.rows
        : (sqlMode === 'generated' ? previewRows : []);
    const inferredColumns = inferSortLimitColumns(
      chartType,
      inferenceRows,
      normalizedRoleConfig,
      displayedQueryState?.chartRows?.length ? displayedQueryState.chartPreAggregated : false,
    );

    return inferredColumns;
  }, [
    chartType,
    displayedQueryState?.chartPreAggregated,
    displayedQueryState?.chartRows,
    displayedQueryState?.rows,
    normalizedRoleConfig,
    previewRows,
    sqlMode,
  ]);

  const mappingSummary = useMemo(() => {
    if (TABLE_LIKE_CHART_TYPES.has(chartType)) {
      if (normalizedRoleConfig.tableMode === 'pivot') {
        return [
          normalizedRoleConfig.tableRowDimension ? { label: 'Rows', value: normalizedRoleConfig.tableRowDimension, displayValue: getFieldDisplayName(normalizedRoleConfig.tableRowDimension) } : null,
          normalizedRoleConfig.tableColumnDimension ? { label: 'Columns', value: normalizedRoleConfig.tableColumnDimension, displayValue: getFieldDisplayName(normalizedRoleConfig.tableColumnDimension) } : null,
          normalizedRoleConfig.tablePivotMetric ? { label: 'Value', value: normalizedRoleConfig.tablePivotMetric.field, displayValue: getFieldDisplayName(normalizedRoleConfig.tablePivotMetric.field) } : null,
        ].filter((item): item is { label: string; value: string; displayValue: string } => item !== null);
      }

      const selectedCount = normalizedRoleConfig.selectedColumns?.length ?? configColumns.length;
      return selectedCount > 0 ? [{ label: 'Columns', value: `${selectedCount} selected`, displayValue: `${selectedCount} selected` }] : [];
    }

    if (SCATTER_LIKE_CHART_TYPES.has(chartType)) {
      return [
        normalizedRoleConfig.scatterX ? { label: 'X', value: normalizedRoleConfig.scatterX, displayValue: getFieldDisplayName(normalizedRoleConfig.scatterX) } : null,
        normalizedRoleConfig.scatterY ? { label: 'Y', value: normalizedRoleConfig.scatterY, displayValue: getFieldDisplayName(normalizedRoleConfig.scatterY) } : null,
        normalizedRoleConfig.dimension ? { label: 'Label', value: normalizedRoleConfig.dimension, displayValue: getFieldDisplayName(normalizedRoleConfig.dimension) } : null,
        chartType !== 'SCATTER' && normalizedRoleConfig.metrics[0]
          ? { label: 'Size', value: normalizedRoleConfig.metrics[0].field, displayValue: getFieldDisplayName(normalizedRoleConfig.metrics[0].field) }
          : null,
      ].filter((item): item is { label: string; value: string; displayValue: string } => item !== null);
    }

    return [
      normalizedRoleConfig.timeField ? { label: 'Time', value: normalizedRoleConfig.timeField, displayValue: getFieldDisplayName(normalizedRoleConfig.timeField) } : null,
      normalizedRoleConfig.dimension && chartType !== 'TIME_SERIES' && chartType !== 'RIBBON' ? { label: 'X', value: normalizedRoleConfig.dimension, displayValue: getFieldDisplayName(normalizedRoleConfig.dimension) } : null,
      normalizedRoleConfig.metrics.length > 0
        ? {
            label: 'Y',
            value: normalizedRoleConfig.metrics.map((metric) => metric.field).join(', '),
            displayValue: formatFieldListDisplay(normalizedRoleConfig.metrics.map((metric) => metric.field)),
          }
        : null,
      normalizedRoleConfig.lineMetric ? { label: 'Line', value: normalizedRoleConfig.lineMetric.field, displayValue: getFieldDisplayName(normalizedRoleConfig.lineMetric.field) } : null,
      normalizedRoleConfig.breakdown ? { label: 'Breakdown', value: normalizedRoleConfig.breakdown, displayValue: getFieldDisplayName(normalizedRoleConfig.breakdown) } : null,
    ].filter((item): item is { label: string; value: string; displayValue: string } => item !== null);
  }, [chartType, configColumns.length, formatFieldListDisplay, getFieldDisplayName, normalizedRoleConfig]);

  const configBuilderSourceStats = useMemo(() => {
    if (!previewColumns.length) {
      return {
        timeColumns: [] as ColumnMetadata[],
        measureColumns: [] as ColumnMetadata[],
        dimensionColumns: [] as ColumnMetadata[],
      };
    }

    const timeColumns = previewColumns.filter(isSourceTimeColumn);
    const measureColumns = previewColumns.filter((column) => column.type === 'number' && !isSourceTimeColumn(column));
    const dimensionColumns = previewColumns.filter((column) => column.type !== 'number' && !isSourceTimeColumn(column));

    return {
      timeColumns,
      measureColumns,
      dimensionColumns,
    };
  }, [previewColumns]);

  const handleChartTypeChange = useCallback((nextType: ChartType) => {
    if (nextType === chartType) {
      return;
    }

    const fromType = chartType;
    setChartType(nextType);

    const transitionIntoTable = TABLE_LIKE_CHART_TYPES.has(nextType) && !TABLE_LIKE_CHART_TYPES.has(fromType);

    if (transitionIntoTable) {
      const nextTableMode = nextType === 'MATRIX' ? 'pivot' : 'standard';
      setGeneratedRoleConfig((prev) => createDefaultTableRoleConfig(prev, nextTableMode));
      setCustomRoleConfig((prev) => createDefaultTableRoleConfig(prev, nextTableMode));
      setChartStyleConfig((prev) => createDefaultTableStyleConfig(prev));
      setGeneratedQueryState(null);
      setCustomQueryState(null);
      setGeneratedLastRunSignature('');
      setCustomLastRunSignature('');
      setQueryError(null);
      return;
    }

    // Phase-15.78 — for every non-TABLE transition, run the role config
    // through migrateRoleConfig so fields the new chart kind cares about
    // (scatterX/Y, timeField, lineMetric, …) get hydrated from the
    // carryover instead of staying undefined. normalizeRoleConfig then
    // prunes whatever the new type doesn't accept. Result: switching
    // BAR → SCATTER no longer renders blank just because the field names
    // differ between the two role schemas.
    setGeneratedRoleConfig((prev) =>
      normalizeRoleConfig(nextType, migrateRoleConfig(fromType, nextType, prev)),
    );
    setCustomRoleConfig((prev) =>
      normalizeRoleConfig(nextType, migrateRoleConfig(fromType, nextType, prev)),
    );
  }, [chartType]);

  // Phase-15.10: auto-derive base table from the first picked field's view.
  // PowerBI-style flow — DA picks Dataset only, then picks fields; the first
  // field's owning view becomes the chart's base (which gives the BE engine
  // a JOIN root and the chart save its `dataset_table_id`). Once derived,
  // base stays sticky even if the user later swaps that field, so the JOIN
  // tree doesn't silently re-root.
  //
  // Why use generatedRoleConfig (and not customRoleConfig): Hướng A is
  // only meaningful in Builder/Generated mode. Custom SQL mode has its own
  // flow where columns come from SQL output — no semantic views involved.
  useEffect(() => {
    if (selectedTableId != null) return; // sticky once set
    if (!datasetModel) return;
    const collectFirstView = (): string | null => {
      const rc = generatedRoleConfig;
      const pickFromField = (f?: string | null): string | null => {
        if (!f || !f.includes('.')) return null;
        return f.split('.', 1)[0] || null;
      };
      const order = [
        rc.dimension,
        rc.timeField,
        rc.scatterX,
        rc.scatterY,
        rc.tableRowDimension,
        rc.tableColumnDimension,
        rc.breakdown,
        ...(rc.metrics ?? []).map((m) => m.field),
        rc.lineMetric?.field ?? null,
        rc.benchmarkMetric?.field ?? null,
        rc.tablePivotMetric?.field ?? null,
        ...((rc.selectedColumns ?? []) as (string | undefined)[]),
      ];
      for (const candidate of order) {
        const v = pickFromField(candidate ?? null);
        if (v) return v;
      }
      return null;
    };
    const firstView = collectFirstView();
    if (!firstView) return;
    const views = datasetModel.views ?? [];
    // Resolve the first field's view to a base TABLE. A date-hierarchy view
    // (`{parentView}__{col}__date_dim`, view_role 'calendar_role') carries NO
    // dataset_table_id of its own — it is a virtual expansion of a date column
    // on a real table view. Anchor the chart to that PARENT table view. Without
    // this, any chart whose FIRST picked field is a date-hierarchy field never
    // derives a base table, so Run/Save stay disabled forever — which is the
    // DEFAULT state, because a fresh Table auto-selects the date-hierarchy
    // columns. (Repro: /explore/new → RC02_SDR → Run disabled.)
    let resolvedTableId: number | null = null;
    const direct = views.find((v) => v.name === firstView);
    if (direct?.dataset_table_id != null) {
      resolvedTableId = direct.dataset_table_id;
    } else if (direct?.view_role === 'calendar_role' || firstView.endsWith('__date_dim')) {
      // Longest-prefix match so `a__b__date_dim` anchors to `a__b`, not `a`.
      const parent = views
        .filter((v) => v.dataset_table_id != null && firstView.startsWith(`${v.name}__`))
        .sort((a, b) => b.name.length - a.name.length)[0];
      if (parent?.dataset_table_id != null) resolvedTableId = parent.dataset_table_id;
    }
    if (resolvedTableId == null) return;
    // Suppress the reset-on-table-change effect below — this is the FIRST
    // base set, not a user-initiated table swap, so filters / role-config
    // should NOT be wiped.
    skipNextSourceResetRef.current = true;
    setSelectedTableId(resolvedTableId);
  }, [generatedRoleConfig, selectedTableId, datasetModel]);

  /**
   * Phase-15.18 — Auto-default time grain to 'month' when a date field is
   * picked as dimension / timeField.
   *
   * DA feedback: "time grain vẫn chưa work, tôi tưởng giống như date
   * hierarchy trên PBI nhỉ?" — they expected PowerBI's date-hierarchy
   * auto-bucket behaviour (drop date → see monthly aggregation
   * immediately, drill up to year / down to day later). Without this
   * effect the dropdown defaulted to "Raw" (no bucket), DA never noticed
   * the picker, and charts rendered one bar per raw timestamp.
   *
   * Sentinel design: we remember which fields we've already auto-defaulted
   * in `grainAutoDefaultedRef`. If DA later explicitly clears the grain
   * back to "Raw" (TimeGrainSlot calls onChange(undefined) → setGrain
   * deletes the entry), the ref still says "we touched this field" so we
   * do NOT re-apply on the next render. New fields get the default; old
   * fields keep DA's choice.
   *
   * Existing charts opt out via `isNew`: a saved chart that ran fine
   * before without a grain keeps showing raw timestamps after deploy.
   * Otherwise we'd silently change the visual output of every legacy
   * date chart on next load.
   */
  const grainAutoDefaultedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isNew) return;
    const candidateFields = [
      generatedRoleConfig.dimension,
      generatedRoleConfig.timeField,
    ].filter((f): f is string => Boolean(f));
    if (candidateFields.length === 0) return;
    const isTimeField = (name: string) => {
      const col = [...previewColumns, ...semanticColumns].find((c) => c.name === name);
      return col ? isSourceTimeColumn(col) : false;
    };
    const fieldsNeedingDefault = candidateFields.filter(
      (name) =>
        !grainAutoDefaultedRef.current.has(name)
        && isTimeField(name),
    );
    if (fieldsNeedingDefault.length === 0) return;
    for (const name of fieldsNeedingDefault) {
      grainAutoDefaultedRef.current.add(name);
    }
    setGeneratedRoleConfig((prev) => {
      const nextGrains = { ...(prev.timeGrains || {}) };
      let changed = false;
      for (const name of fieldsNeedingDefault) {
        if (nextGrains[name] === undefined) {
          nextGrains[name] = 'month';
          changed = true;
        }
      }
      if (!changed) return prev;
      return { ...prev, timeGrains: nextGrains };
    });
  }, [
    isNew,
    generatedRoleConfig.dimension,
    generatedRoleConfig.timeField,
    previewColumns,
    semanticColumns,
  ]);

  // Reset config when user manually changes the table (skip during initial chart load)
  const isInitialTableSet = useRef(false);
  useEffect(() => {
    if (!selectedTableId) return;
    if (!isInitialTableSet.current) {
      isInitialTableSet.current = true;
      return;
    }
    setFilters([]);
    setGeneratedRoleConfig({ metrics: [] });
    setCustomRoleConfig({ metrics: [] });
  }, [selectedTableId]);

  /**
   * Phase-12.5 — Seeding pass for generatedRoleConfig.
   *
   * Two important contracts (DA feedback 2026-05-16):
   *
   * 1) GATE BY semanticReady. We do NOT seed until the dataset model has
   *    finished loading. Previously this effect fired with previewColumns
   *    alone (semanticColumns still []), which let `syncRoleConfigWithColumns`
   *    pick a BARE column. When semantic loaded a moment later, the bare
   *    pick stayed (still valid in availableGeneratedColumns) and BE routed
   *    to live_query instead of the semantic engine — silently dropping
   *    JOINs for cross-table charts.
   *
   * 2) UPGRADE bare→qualified after sync. `qualifiedByBare` lets us rewrite
   *    any bare ref that has exactly one qualified match in the reachable
   *    join graph. This guarantees BE.`_contains_semantic_field_refs`
   *    (datasets.py:704) sees a dotted ref whenever one is available,
   *    routing to SemanticQueryEngine which handles JOINs correctly.
   */
  useEffect(() => {
    if (!semanticReady) return;
    const availableGeneratedColumns = [...previewColumns, ...semanticColumns];
    if (!availableGeneratedColumns.length) return;
    setGeneratedRoleConfig((prev) => {
      const synced = syncRoleConfigWithColumns(chartType, prev, availableGeneratedColumns, ambiguousBareNames);
      return upgradeRoleConfigToQualified(synced, qualifiedByBare);
    });
  }, [chartType, previewColumns, semanticColumns, semanticReady, qualifiedByBare, ambiguousBareNames]);

  // UX-2: For NEW TABLE charts, default to the first 10 non-identifier columns
  // instead of showing all available columns. This prevents overwhelming the
  // user when a dataset has many columns (e.g. 129). Fires once when columns
  // become available; does not override if the user has already made a selection.
  const didInitNewTableRef = useRef(false);
  useEffect(() => {
    if (!isNew || chartType !== 'TABLE' || didInitNewTableRef.current) return;
    if (configColumns.length === 0) return;
    // normalizeRoleConfig collapses [] to undefined, so undefined means "all cols" here.
    // Only apply the default when no explicit selection has been made yet.
    if (normalizedRoleConfig.selectedColumns !== undefined) {
      didInitNewTableRef.current = true;
      return;
    }
    didInitNewTableRef.current = true;
    const defaultCols = configColumns
      // Exclude identifier-like cols AND per-column date-hierarchy expansions
      // (`…__<col>__date_dim` calendar_role views: year/quarter/month/day_name/
      // …). Auto-selecting the whole date hierarchy made a fresh "grand total"
      // Table GROUP BY 10+ date columns (DA6 standard-table trap). A DA can
      // still add a date grain deliberately.
      .filter((c) => !isIdentifierLikeField(c.name)
        && !(typeof c.viewName === 'string' && c.viewName.endsWith('__date_dim')))
      .slice(0, 10)
      .map((c) => c.name);
    if (defaultCols.length > 0) {
      setGeneratedRoleConfig((prev) => ({ ...prev, selectedColumns: defaultCols }));
    }
  }, [isNew, chartType, configColumns, normalizedRoleConfig.selectedColumns]);

  // Phase-15.83 — useEffect previously clamped queryLimit to the per-mode
  // cap. Caps removed (NO_LIMIT_SENTINEL); effect deleted.

  /**
   * Phase-12.7 — apply the qualified-upgrade pass to customRoleConfig too.
   *
   * Phase-12.5 only covered `generatedRoleConfig` (line ~1368 effect). DAs
   * who switched to custom SQL mode and picked semantic fields kept losing
   * JOINs because their roleConfig fields stayed bare. Same `qualifiedByBare`
   * map applies — if a bare ref has exactly one qualified match in the
   * reachable graph, upgrade it.
   *
   * `semanticReady` gate also applies here for the same race-condition
   * reason: do not seed on previewColumns alone.
   */
  useEffect(() => {
    if (!semanticReady) return;
    if (!customConfigColumns?.length) return;
    setCustomRoleConfig((prev) => {
      const pruned = pruneRoleConfigToColumns(chartType, prev, customConfigColumns);
      return upgradeRoleConfigToQualified(pruned, qualifiedByBare);
    });
  }, [chartType, customConfigColumns, semanticReady, qualifiedByBare]);

  useEffect(() => {
    if (skipNextSourceResetRef.current) {
      skipNextSourceResetRef.current = false;
      return;
    }
    setGeneratedQueryState(null);
    setCustomQueryState(null);
    setQueryError(null);
    setGeneratedLastRunSignature('');
    setCustomLastRunSignature('');
    setSqlMode('generated');
    setCustomSqlDraft('');
  }, [selectedDatasetId, selectedTableId]);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleEditSql = () => {
    setSqlMode('custom');
    setCustomSqlDraft((current) => (current.trim() ? current : stripTrailingSqlLimit(generatedSql)));
  };

  const handleUseGeneratedQuery = () => {
    setSqlMode('generated');
  };

  const handleResetCustomSqlDraft = () => {
    setCustomSqlDraft(stripTrailingSqlLimit(generatedSql));
    setCustomQueryState(null);
    setCustomLastRunSignature('');
  };

  const handleRunQuery = async () => {
    if (!selectedDatasetId || !selectedTableId || !selectedTable) {
      toast.error(t('explore.editor.selectDatasetTableFirst'));
      return;
    }

    setQueryError(null);

    try {
      if (sqlMode === 'custom') {
        const sql = customSqlDraft.trim();
        if (!sql) {
          toast.error(t('explore.editor.customSqlEmpty'));
          return;
        }
        const buildCustomPreviewConfig = (roleConfig: ChartRoleConfig) => ({
          chartType,
          queryMode: 'custom' as const,
          customSql: sql,
          limit: effectiveQueryLimit,
          roleConfig,
          customRoleConfig: roleConfig,
          styleConfig: chartStyleConfig,
          filters,
          baseFilters: filters,
        });

        const sourceSampleResponse = await previewChartData.mutateAsync({
          dataset_table_id: selectedTableId,
          chart_type: chartType,
          config: buildCustomPreviewConfig({ metrics: [] }),
          include_source_sample: true,
          source_sample_limit: effectiveQueryLimit,
        });

        const sourceRows = sourceSampleResponse.source_rows ?? [];
        const sourceColumnNames = sourceSampleResponse.source_columns?.length
          ? sourceSampleResponse.source_columns
          : Object.keys(sourceRows[0] ?? {});
        const sourceColumns = inferQueryColumns(sourceColumnNames, sourceRows);
        const inferredConfigs = inferRoleConfigFromCustomSql({
          sql,
          chartType,
          columns: sourceColumns,
          currentRoleConfig: normalizedCustomRoleConfig,
        });
        const fallbackCustomRoleConfig = sourceColumns.length > 0
          ? (
            TABLE_LIKE_CHART_TYPES.has(chartType)
              ? {
                  ...syncRoleConfigWithColumns(chartType, normalizedCustomRoleConfig, sourceColumns),
                  selectedColumns: sourceColumns.map((column) => column.name),
                }
              : syncRoleConfigWithColumns(chartType, normalizedCustomRoleConfig, sourceColumns)
          )
          : normalizedCustomRoleConfig;
        const nextCustomRoleConfig = sourceColumns.length > 0
          ? pruneRoleConfigToColumns(
              chartType,
              inferredConfigs.customRoleConfig ?? fallbackCustomRoleConfig,
              sourceColumns,
            )
          : normalizedCustomRoleConfig;
        const nextCustomSignature = buildQuerySignature({
          datasetId: selectedDatasetId,
          tableId: selectedTableId,
          limit: effectiveQueryLimit,
          sqlMode: 'custom',
          chartType,
          roleConfig: nextCustomRoleConfig,
          styleConfig: chartStyleConfig,
          filters,
          request: executeRequest,
          customSql: sql,
        });
        const roleConfigChanged = JSON.stringify(nextCustomRoleConfig) !== JSON.stringify(normalizedCustomRoleConfig);

        if (roleConfigChanged) {
          setCustomRoleConfig(nextCustomRoleConfig);
        }

        if (inferredConfigs.generatedRoleConfig) {
          const nextGeneratedRoleConfig = previewColumns.length > 0
            ? syncRoleConfigWithColumns(chartType, inferredConfigs.generatedRoleConfig, previewColumns, ambiguousBareNames)
            : normalizeRoleConfig(chartType, inferredConfigs.generatedRoleConfig);
          if (JSON.stringify(nextGeneratedRoleConfig) !== JSON.stringify(normalizedGeneratedRoleConfig)) {
            setGeneratedRoleConfig(nextGeneratedRoleConfig);
          }
        }

        const nextCustomMessage = getChartRoleConfigRequirementMessage(chartType, nextCustomRoleConfig);
        if (nextCustomMessage) {
          setCustomQueryState({
            source: 'custom',
            sql,
            columns: sourceColumns,
            rows: sourceRows,
            chartRows: [],
            chartColumns: [],
            chartPreAggregated: false,
            executionTimeMs: sourceSampleResponse.execution_time_ms,
          });
          setCustomLastRunSignature('');
          setQueryError(nextCustomMessage);
          toast.info(nextCustomMessage);
          return;
        }

        const previewResponse = await previewChartData.mutateAsync({
          dataset_table_id: selectedTableId,
          chart_type: chartType,
          config: buildCustomPreviewConfig(nextCustomRoleConfig),
          include_source_sample: false,
        });

        const chartRows = previewResponse.data ?? [];
        const chartColumns = inferQueryColumns(Object.keys(chartRows[0] ?? {}), chartRows);
        setCustomQueryState({
          source: 'custom',
          sql,
          columns: sourceColumns,
          rows: sourceRows,
          chartRows,
          chartColumns,
          chartPreAggregated: Boolean(previewResponse.pre_aggregated),
          executionTimeMs: previewResponse.execution_time_ms,
          warnings: previewResponse.warnings,
          debug: previewResponse.debug,
        });
        setCustomLastRunSignature(nextCustomSignature);
      } else {
        if (generatedRoleRequirementMessage) {
          setQueryError(generatedRoleRequirementMessage);
          toast.error(generatedRoleRequirementMessage);
          return;
        }

        const generatedPreviewConfig = {
          dataset_id: selectedDatasetId,
          queryMode: 'generated' as const,
          chartType,
          limit: effectiveQueryLimit,
          roleConfig: normalizedGeneratedRoleConfig,
          generatedRoleConfig: normalizedGeneratedRoleConfig,
          customRoleConfig: normalizedCustomRoleConfig,
          styleConfig: chartStyleConfig,
          filters,
          baseFilters: filters,
        };
        const previewResponse = await previewChartData.mutateAsync({
          dataset_table_id: selectedTableId,
          chart_type: chartType,
          config: generatedPreviewConfig,
          include_source_sample: false,
        });
        const chartRows = previewResponse.data ?? [];
        const chartColumns = inferQueryColumns(Object.keys(chartRows[0] ?? {}), chartRows);

        setGeneratedQueryState({
          source: 'generated',
          sql: generatedSql,
          columns: chartColumns,
          rows: chartRows,
          chartRows,
          chartColumns,
          chartPreAggregated: Boolean(previewResponse.pre_aggregated),
          executionTimeMs: previewResponse.execution_time_ms,
          warnings: previewResponse.warnings,
          debug: previewResponse.debug,
        });
        setGeneratedLastRunSignature(currentQuerySignature);
      }
    } catch (runError: any) {
      const detail = runError?.response?.data?.detail;
      const message = typeof detail === 'string'
        ? detail
        : detail?.message || runError?.message || 'Failed to run query';
      setQueryError(String(message));
      toast.error(String(message));
    }
  };

  const didAutoRunRef = useRef(false);
  useEffect(() => {
    if (isNew || didAutoRunRef.current || !isChartLoaded || !selectedDatasetId || !selectedTableId || !selectedTable) {
      return;
    }
    // Wait for preview data and dataset model to finish loading before auto-running.
    // Without this guard the query signature can change once semantic columns arrive,
    // causing "Run to refresh" to appear immediately after the initial auto-run.
    if (isPreviewLoading || isDatasetModelLoading) return;
    didAutoRunRef.current = true;
    void handleRunQuery();
  }, [isNew, isChartLoaded, selectedDatasetId, selectedTableId, selectedTable, isPreviewLoading, isDatasetModelLoading, currentQuerySignature]);

  /**
   * Phase-15.20 — date-hierarchy drill state for the chart preview header.
   *
   * The Configure panel only has a yes/no toggle ("Date hierarchy"). The
   * actual level (Day / Week / Month / Quarter / Year) is changed at view
   * time via ↑/↓ chips next to the Chart/Table/Query tabs — matches the
   * PowerBI drill button placement.
   *
   * `drillDateField` is whichever of {dimension, timeField} resolves to a
   * date column. Most chart types use `dimension`; TIME_SERIES / RIBBON /
   * TIMELINE use `timeField`. Both check the configColumns metadata for
   * the source-time signal (Phase-15.18 helper).
   */
  const drillDateField = useMemo<string | null>(() => {
    const rc = normalizedGeneratedRoleConfig;
    const candidates = [rc.dimension, rc.timeField].filter(
      (v): v is string => Boolean(v),
    );
    for (const fieldName of candidates) {
      const col = configColumns.find((c) => c.name === fieldName);
      if (col && isSourceTimeColumn(col)) return fieldName;
    }
    return null;
  }, [normalizedGeneratedRoleConfig, configColumns]);

  const drillGrain = useMemo<TimeGrainLevel | null>(() => {
    if (!drillDateField) return null;
    const value = normalizedGeneratedRoleConfig.timeGrains?.[drillDateField];
    if (!value) return null;
    return (DRILL_LEVEL_ORDER as readonly string[]).includes(value)
      ? (value as TimeGrainLevel)
      : null;
  }, [drillDateField, normalizedGeneratedRoleConfig]);

  const drillFieldDisplayLabel = useMemo(() => {
    if (!drillDateField) return '';
    return getFieldDisplayName(drillDateField);
  }, [drillDateField, getFieldDisplayName]);

  /**
   * Stash the latest handleRunQuery in a ref so the drill effect below
   * can call it without taking handleRunQuery as an effect dep — that
   * would re-fire the effect on every render and double-run queries.
   */
  const handleRunQueryRef = useRef<typeof handleRunQuery>(handleRunQuery);
  handleRunQueryRef.current = handleRunQuery;

  /**
   * Phase-15.20 — auto-run when DA drills. PowerBI re-renders on click;
   * forcing DA to also click "Run to refresh" after every drill is bad
   * UX. We track the drill signature; first observation is recorded
   * silently (the standard `didAutoRunRef` path handles the initial
   * load), subsequent changes trigger a fresh query.
   */
  const drillAutoRunSigRef = useRef<string | null>(null);
  useEffect(() => {
    if (!drillDateField || !drillGrain) return;
    if (!selectedTableId) return;
    const sig = `${drillDateField}|${drillGrain}`;
    if (drillAutoRunSigRef.current === null) {
      drillAutoRunSigRef.current = sig;
      return;
    }
    if (drillAutoRunSigRef.current === sig) return;
    drillAutoRunSigRef.current = sig;
    if (!didAutoRunRef.current) return; // initial mount auto-run handles this
    void handleRunQueryRef.current();
  }, [drillDateField, drillGrain, selectedTableId]);

  const handleDrillChange = useCallback(
    (next: TimeGrainLevel) => {
      if (!drillDateField) return;
      setGeneratedRoleConfig((prev) => ({
        ...prev,
        timeGrains: {
          ...(prev.timeGrains || {}),
          [drillDateField]: next,
        },
      }));
    },
    [drillDateField],
  );

  const handleSaveLook = async () => {
    if (!selectedTableId) {
      toast.error(t('explore.editor.selectDatasetTableFirst'));
      return;
    }
    const trimmedCustomSql = customSqlDraft.trim();
    if (sqlMode === 'custom') {
      if (!trimmedCustomSql) {
        toast.error(t('explore.editor.customSqlEmpty'));
        return;
      }
      if (customRoleRequirementMessage) {
        toast.error(customRoleRequirementMessage);
        return;
      }
      if (!customQueryState || currentQuerySignature !== customLastRunSignature) {
        toast.error(t('explore.editor.runCustomSqlBeforeSaving'));
        return;
      }
    } else if (generatedRoleRequirementMessage) {
      toast.error(generatedRoleRequirementMessage);
      return;
    }

    // Phase-15.98 (S2B) — run the bare→qualified upgrade once more at save
    // time so the persisted config is deterministic regardless of when the
    // user clicked Save relative to semantic-binding hydration. Prior code
    // only ran `upgradeRoleConfigToQualified` inside the runtime sync /
    // prune effects, leaving an edge case where a user picks a measure
    // mid-hydration and saves before the next effect tick — the chart
    // persists with a bare metric.field that downstream routing has to
    // re-resolve every render. Idempotent: qualified refs pass through
    // untouched.
    const savedGenerated = upgradeRoleConfigToQualified(generatedRoleConfig, qualifiedByBare);
    const savedCustom = upgradeRoleConfigToQualified(customRoleConfig, qualifiedByBare);
    const activeSavedRoleConfig = sqlMode === 'custom' ? savedCustom : savedGenerated;
    const tableConditionalFormatting = chartStyleConfig.tableConditionalFormatting;
    const exploreConfig = {
      dataset_id: selectedDatasetId,
      filters,
      baseFilters: filters,
      chartType,
      queryMode: sqlMode,
      roleConfig: activeSavedRoleConfig,
      generatedRoleConfig: savedGenerated,
      customRoleConfig: savedCustom,
      ...(trimmedCustomSql ? { customSql: trimmedCustomSql } : {}),
      styleConfig: chartStyleConfig,
      ...(TABLE_LIKE_CHART_TYPES.has(chartType) && tableConditionalFormatting?.length
        ? { conditional_formatting: tableConditionalFormatting }
        : {}),
    };

    // Ephemeral mode: don't persist anything — hand the snapshot back to the
    // caller (e.g. the HTML-import wizard) and let it fold into its own state.
    if (isEphemeral) {
      if (!onEphemeralSave) {
        toast.error('No save handler was provided for this editor.');
        return;
      }
      const name = chartNameInput.trim();
      if (!name) {
        setIsEditingName(true);
        toast.error('Please enter a chart name');
        return;
      }
      try {
        await onEphemeralSave({
          chartType: chartType as ChartType,
          chartName: name,
          chartDescription: chartDescInput.trim() || null,
          queryMode: sqlMode,
          customSql: trimmedCustomSql || null,
          generatedRoleConfig,
          customRoleConfig,
          activeRoleConfig: activeSavedRoleConfig,
          styleConfig: chartStyleConfig,
          baseFilters: filters,
          datasetId: selectedDatasetId,
          datasetTableId: selectedTableId,
        });
      } catch (error: any) {
        toast.error(getApiErrorMessage(error, 'Could not save chart changes.'));
      }
      return;
    }

    const metaPayload: ChartMetadataUpsert = {
      domain: metaDomain || null,
      intent: metaIntent || null,
      metrics: metaMetrics,
      dimensions: metaDimensions,
      tags: metaTags,
    };
    const hasMetadata = metaDomain || metaIntent || metaMetrics.length || metaDimensions.length || metaTags.length;

    try {
      const dryRunName = chartNameInput.trim() || chart?.name || 'Untitled chart';
      const dryRun = await dryRunCreateChart.mutateAsync({
        name: dryRunName,
        description: chartDescInput.trim() || null,
        chart_type: chartType as ChartType,
        dataset_table_id: selectedTableId,
        config: exploreConfig as unknown as import('@/types/api').ChartConfig,
      });
      if (!dryRun.ok) {
        const failures = [
          ...(dryRun.validation_errors ?? []),
          ...(dryRun.runtime_errors ?? []),
        ];
        const message = failures[0] || 'Chart config did not pass dataset/runtime validation.';
        setQueryError(message);
        toast.error(message);
        return;
      }
      if (dryRun.fe_unrecognised_keys?.length) {
        toast.warning(`Some chart config keys are not used by Explore: ${dryRun.fe_unrecognised_keys.join(', ')}`);
      }
      const normalizedExploreConfig = dryRun.normalized_config as import('@/types/api').ChartConfig;

      if (chartId !== null) {
        await updateChart.mutateAsync({
          id: chartId,
          data: {
            name: chartNameInput.trim() || undefined,
            description: chartDescInput.trim() || null,
            chart_type: chartType as any,
            dataset_table_id: selectedTableId,
            config: normalizedExploreConfig,
          },
        });
        await Promise.all([
          hasMetadata ? upsertMetadata.mutateAsync({ id: chartId, data: metaPayload }) : Promise.resolve(),
          replaceParams.mutateAsync({ id: chartId, params: paramRows }),
        ]);
        toast.success('Chart updated successfully!');
      } else {
        const name = chartNameInput.trim();
        if (!name) {
          setIsEditingName(true);
          toast.error('Please enter a chart name');
          return;
        }
        const newChart = await createChart.mutateAsync({
          name,
          description: chartDescInput.trim() || undefined,
          chart_type: chartType as any,
          dataset_table_id: selectedTableId,
          config: normalizedExploreConfig,
        });
        await Promise.all([
          hasMetadata ? upsertMetadata.mutateAsync({ id: newChart.id, data: metaPayload }) : Promise.resolve(),
          paramRows.length ? replaceParams.mutateAsync({ id: newChart.id, params: paramRows }) : Promise.resolve(),
        ]);
        toast.success(`Chart "${name}" saved!`);
        if (onChartSaved) {
          try {
            await onChartSaved(newChart.id);
          } catch (postSaveError: any) {
            const message = getApiErrorMessage(
              postSaveError,
              'Chart saved, but it could not be added to the dashboard.',
            );
            toast.error(message);
          }
        } else {
          router.replace('/explore/' + newChart.id);
        }
      }
    } catch (error: unknown) {
      console.error('Error saving chart:', error);
      toast.error(`Failed to save chart: ${extractApiError(error, 'unknown error')}`);
    }
  };


  useEffect(() => {
    if (!parameterColumns.length) return;
    setParamRows((rows) => rows.map((row) => {
      const column = row.column_mapping?.column;
      if (!column) return row;
      const columnMeta = parameterColumns.find((item) => item.name === column);
      if (!columnMeta) return row;
      if (row.column_mapping?.type === columnMeta.type) return row;
      return {
        ...row,
        column_mapping: { column, type: columnMeta.type },
      };
    }));
  }, [parameterColumns]);

  const isConfigBuilderMode = sqlMode === 'generated';
  const customRunMessage = sqlMode === 'custom' && customQueryState
    ? customRoleRequirementMessage
    : null;
  const modeDescription = isConfigBuilderMode
    ? 'Choose a source table, map fields directly from the left panel, and keep chart setup visible on the same screen. Generated queries can preview up to 10,000 rows.'
    : 'Write SQL once on the left, run it, and Explore will auto-bind chart roles from the SQL output when it can. Custom SQL previews are capped at 5,000 rows to keep runtime responsive.';
  const selectedSourceFieldCount = sqlMode === 'custom'
    ? (customQueryState?.columns?.length ?? 0)
    : previewColumns.length;

  // Show loading skeleton while fetching existing chart
  if (!isNew && isChartLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-surface-2">
        <div className="text-center">
          <div className="inline-block w-8 h-8 border-4 border-brand border-t-transparent rounded-full animate-spin mb-3" />
          <p className="text-sm text-text-secondary">{t('explore.editor.loadingChart')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col bg-surface-2 ${embedded ? 'h-full min-h-0' : 'h-screen'}`}>
      {!isNew && !resPerms.canEdit && resPerms.canView && (
        <div className="shrink-0 border-b border-warning/30 bg-warning/10 px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-warning">
            <Eye className="h-3.5 w-3.5 shrink-0" />
            <span className="font-medium">{t('explore.editor.viewOnly')}</span>
            <span className="text-warning">- {t('explore.editor.viewOnlyDescription')}</span>
          </div>
        </div>
      )}
      <div className="shrink-0 border-b border-[rgb(var(--border-line))] bg-surface-1 px-4 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {/* Left: back + name */}
          <div className="flex min-w-0 items-center gap-2">
            <button
              onClick={handleExit}
              className="flex shrink-0 items-center gap-1 text-xs text-text-quaternary hover:text-text-secondary"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {resolvedBackLabel}
            </button>
            <span className="text-text-secondary">/</span>
            {isEditingName ? (
              <div className="flex items-center gap-1.5">
                <input
                  autoFocus
                  type="text"
                  value={chartNameInput}
                  onChange={(e) => setChartNameInput(e.target.value)}
                  onBlur={() => {
                    setIsEditingName(false);
                    if (chartId && chartNameInput.trim()) {
                      updateChart.mutate({ id: chartId, data: { name: chartNameInput.trim() } });
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') { setChartNameInput(chart?.name ?? ''); setIsEditingName(false); }
                  }}
                  placeholder={t('explore.editor.chartNamePlaceholder')}
                  className="min-w-[10rem] border-b border-brand/50 bg-transparent px-0.5 text-sm font-semibold text-text-primary outline-none"
                />
                <Check className="h-3.5 w-3.5 text-brand" />
              </div>
            ) : (
              <div className="flex items-center gap-1.5 group/name">
                {/* Click the NAME TEXT itself to rename — not just the
                    hover-revealed pencil. DA-Test (OBS-02): testers clicked the
                    chart title expecting an input and nothing happened because
                    only the (opacity-0) pencil was clickable. */}
                <span
                  className={`max-w-[14rem] truncate text-sm font-semibold text-text-primary ${resPerms.canEdit ? 'cursor-pointer hover:text-brand' : ''}`}
                  onClick={resPerms.canEdit ? () => setIsEditingName(true) : undefined}
                  title={resPerms.canEdit ? t('explore.editor.clickToRename') : undefined}
                >
                  {chartNameInput || (chartId ? t('explore.editor.chartFallback') : t('explore.editor.newChartFallback'))}
                </span>
                {resPerms.canEdit && (
                  <button
                    type="button"
                    onClick={() => setIsEditingName(true)}
                    aria-label={t('explore.editor.renameChart')}
                    className="rounded-md p-1 text-text-quaternary opacity-0 transition-opacity hover:bg-surface-2 hover:text-text-secondary group-hover/name:opacity-100"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="hidden h-5 w-px bg-[rgb(var(--border-line))] md:block" />

          {/* Middle: mode + source compact */}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            {!isDashboardModal && (
              <>
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">{t('explore.editor.mode')}</span>
                <div className="inline-flex rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-0.5">
                  <button
                    onClick={handleUseGeneratedQuery}
                    disabled={!resPerms.canEdit}
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      isConfigBuilderMode
                        ? 'bg-surface-1 text-brand shadow-linear-sm'
                        : 'text-text-secondary hover:bg-surface-1'
                    }`}
                  >
                    <Database className="h-3 w-3" />
                    {t('explore.editor.builder')}
                  </button>
                  <span className="group/csql relative inline-flex">
                    <button
                      disabled
                      className="inline-flex cursor-not-allowed items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-text-quaternary opacity-50"
                    >
                      <Code2 className="h-3 w-3" />
                      {t('explore.editor.sql')}
                    </button>
                    <span className="pointer-events-none absolute left-0 top-full z-50 mt-1.5 hidden w-52 rounded-md bg-surface-inverse px-2.5 py-2 text-[11px] text-white shadow-lg group-hover/csql:block">
                      {t('explore.editor.sqlUnavailable')}
                    </span>
                  </span>
                </div>
                <div className="hidden h-5 w-px bg-[rgb(var(--border-line))] lg:block" />
              </>
            )}
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">{t('explore.editor.dataset')}</span>
            <div className="min-w-[14rem] max-w-[22rem] flex-1">
              <ExploreSourceSelector
                selectedDatasetId={selectedDatasetId}
                selectedTableId={selectedTableId}
                onDatasetChange={setSelectedDatasetId}
                onTableChange={setSelectedTableId}
                disabled={!resPerms.canEdit}
                lockDataset={lockDatasetSelection}
                variant="compact"
                hideTable
              />
            </div>
            {/* Phase-15.10: base + relationship chip.
                Replaces the old "X tables joined" chip and surfaces what the
                old "Source" dropdown used to anchor. When no field has been
                picked yet (selectedSemanticView null), nothing renders —
                pick a field below and the base auto-derives from its view.
                Once derived, the chip stays informative even for single-
                table charts ("Base: Meetings") and grows to show JOIN count
                or joinable potential when relationships exist. */}
            {selectedSemanticView && (() => {
              // Data-source chip (Phase-15.10 redesign): DAs found "Base: X ·
              // 🔌 +N joinable" confusing — "base view" + the actual/potential
              // (joined vs joinable) distinction is semantic-layer jargon. Show
              // only what they recognise: a table icon + the table name. The
              // "+N" appears ONLY when the chart ACTUALLY combines other tables
              // (a meaningful, actionable state) — join *potential* moves to the
              // tooltip so it stops cluttering. Icons replace the emojis to
              // match the lucide system; the face is language-agnostic.
              const baseLabel = getSemanticViewDisplayName(selectedSemanticView);
              const crossUsed = activeRelationshipSummary.crossTableInUse;
              const joinedCount = activeRelationshipSummary.crossTableViews?.length ?? 0;
              const joinableCount = Math.max(0, activeRelationshipSummary.activeViewCount - 1);
              const hasJoined = crossUsed && joinedCount > 0;
              const hasJoinable = !crossUsed && joinableCount > 0;
              const tone = hasJoined
                ? 'border-success/40 bg-success/10 text-success'
                : 'border-[rgb(var(--border-line))] bg-surface-2 text-text-tertiary';
              const tip = hasJoined
                ? t(joinedCount === 1 ? 'explore.editor.relatedTablesJoinedTitleOne' : 'explore.editor.relatedTablesJoinedTitleMany', {
                    count: joinedCount,
                    tables: (activeRelationshipSummary.crossTableViews ?? []).join(', '),
                  })
                : hasJoinable
                  ? t(joinableCount === 1 ? 'explore.editor.relatedTablesJoinableTitleOne' : 'explore.editor.relatedTablesJoinableTitleMany', {
                      base: baseLabel,
                      count: joinableCount,
                    })
                  : t('explore.editor.dataBaseTitle', { base: baseLabel });
              return (
                <BaseTablePicker
                  tables={dataset?.tables ?? []}
                  selectedTableId={selectedTableId}
                  recommendedTableId={recommendedBaseTableId}
                  onChange={setSelectedTableId}
                  baseLabel={baseLabel}
                  joinedCount={joinedCount}
                  tone={tone}
                  hasJoined={hasJoined}
                  tip={tip}
                  disabled={!resPerms.canEdit}
                />
              );
            })()}
          </div>

          {/* Right: status + limit + run + save (+ desc note) */}
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {isQueryDirty && (
              <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
                {t('explore.editor.runToRefresh')}
              </span>
            )}
            {activeQueryState && (
              <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-[11px] text-text-tertiary">
                {t(activeQueryState.rows.length === 1 ? 'explore.editor.rowCountOne' : 'explore.editor.rowCountMany', { count: activeQueryState.rows.length })}
                {activeQueryState.executionTimeMs != null ? ` · ${activeQueryState.executionTimeMs}ms` : ''}
              </span>
            )}
            {/* Phase-15.83 — DA dropped per-query row cap; Limit dropdown
                removed. Run button below sends the BE query without any
                client-imposed cap. */}
            <button
              onClick={() => void handleRunQuery()}
              disabled={!selectedTableId || isRunningQuery || (isConfigBuilderMode && isPreviewLoading)}
              className="inline-flex items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRunningQuery
                ? <div className="h-3 w-3 animate-spin rounded-full border-2 border-text-secondary border-t-transparent" />
                : <Play className="h-3 w-3" />}
              {isRunningQuery ? t('explore.editor.running') : t('explore.editor.run')}
            </button>
            {!isDashboardModal && (
              isEditingDesc ? (
                <input
                  autoFocus
                  type="text"
                  value={chartDescInput}
                  onChange={(e) => setChartDescInput(e.target.value)}
                  onBlur={() => {
                    setIsEditingDesc(false);
                    if (chartId) updateChart.mutate({ id: chartId, data: { description: chartDescInput.trim() || null } });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') { setChartDescInput(chart?.description ?? ''); setIsEditingDesc(false); }
                  }}
                  placeholder={t('explore.editor.addNote')}
                  className="w-44 border-b border-brand/50 bg-transparent px-0.5 text-xs text-text-secondary outline-none"
                />
              ) : resPerms.canEdit ? (
                <button
                  type="button"
                  onClick={() => setIsEditingDesc(true)}
                  className="group/desc flex max-w-[12rem] cursor-text items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-quaternary hover:bg-surface-2 hover:text-text-secondary"
                >
                  <span className="truncate">{chartDescInput || <span className="italic">{t('explore.editor.addNote')}</span>}</span>
                  <Pencil className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/desc:opacity-100" />
                </button>
              ) : chartDescInput ? (
                <span className="text-[11px] text-text-quaternary">{chartDescInput}</span>
              ) : null
            )}
            {resPerms.canEdit && (
              <button
                onClick={handleSaveLook}
                disabled={!selectedTableId || dryRunCreateChart.isPending || createChart.isPending || updateChart.isPending}
                className="flex items-center gap-1.5 rounded-md border border-brand bg-brand px-3 py-1 text-xs font-medium text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Save className="h-3.5 w-3.5" />
                {dryRunCreateChart.isPending || createChart.isPending || updateChart.isPending
                  ? t('explore.editor.saving')
                  : (saveButtonLabel ?? (chartId ? t('explore.editor.update') : t('explore.editor.save')))}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full flex-col gap-4 p-4 lg:flex-row">
          <div className="flex min-h-[24rem] min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm lg:min-h-0">
            <div className={`flex items-center justify-between gap-3 border-b border-[rgb(var(--border-line))] px-4 py-2.5 ${
              sqlMode === 'custom' ? 'bg-warning/10' : 'bg-surface-2'
            }`}>
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">{t('explore.editor.configure')}</span>
                {selectedDatasetId && (
                  <>
                    <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-0.5 text-[11px] text-text-secondary">{chartType}</span>
                    {hasActiveTransforms && (
                      <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] text-warning">{t('explore.editor.transforms')}</span>
                    )}
                    {filters.length > 0 && (
                      <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] text-warning">
                        {t(filters.length === 1 ? 'explore.editor.filterCountOne' : 'explore.editor.filterCountMany', { count: filters.length })}
                      </span>
                    )}
                  </>
                )}
              </div>
              {mappingSummary.length > 0 && (
                <div className="flex max-w-[20rem] flex-wrap justify-end gap-1.5">
                  {mappingSummary.slice(0, 4).map((item) => (
                    <span
                      key={`setup-${item.label}-${item.value}`}
                      className="rounded-full border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-0.5 text-[10px] text-text-secondary"
                      title={item.value}
                    >
                      <span className="font-semibold">{item.label}:</span> {item.displayValue}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {/* Phase-15.12: was gated on selectedTableId — chicken-and-egg
                  after Hướng A. Base table auto-derives from the FIRST field
                  the user picks; that field gets picked inside ExploreChartConfig
                  below; ExploreChartConfig was hidden until base table existed.
                  Now we gate on selectedDatasetId so the picker is visible the
                  moment a Dataset is chosen, and auto-derive can complete the
                  flow once the user picks anything. */}
              {selectedDatasetId ? (
                <>
                  {sqlMode === 'custom' && (
                    <div className="border-b border-[rgb(var(--border-line))]">
                      <div className="flex items-center justify-between px-5 py-3">
                        <div className="flex items-center gap-1.5">
                          <p className="text-sm font-medium text-text-secondary">{t('explore.editor.customSql')}</p>
                          <HelpTooltip text={t('explore.editor.customSqlHelp')} />
                        </div>
                        {resPerms.canEdit && (
                          <button
                            onClick={handleResetCustomSqlDraft}
                            className="inline-flex items-center gap-1 rounded-lg border border-[rgb(var(--border-line))] px-2 py-1 text-xs text-text-secondary hover:bg-surface-2"
                          >
                            <RotateCcw className="h-3 w-3" />
                            {t('explore.editor.reset')}
                          </button>
                        )}
                      </div>

                      <div className="border-t border-[rgb(var(--border-line))] p-5">
                        <textarea
                          value={customSqlDraft}
                          onChange={(e) => setCustomSqlDraft(e.target.value)}
                          readOnly={!resPerms.canEdit}
                          spellCheck={false}
                          className={`h-56 w-full resize-none rounded-2xl border border-[rgb(var(--border-line))] bg-surface-inverse px-3 py-3 font-mono text-xs text-text-secondary outline-none transition focus:border-warning/40 focus:ring-2 focus:ring-warning${!resPerms.canEdit ? ' opacity-60 cursor-not-allowed' : ''}`}
                        />

                        <div className="mt-4 rounded-2xl border border-[rgb(var(--border-line))] bg-surface-2 p-4">
                          <p className="text-sm font-medium text-text-primary">{t('explore.editor.outputColumns')}</p>
                          <p className="mt-1 text-xs text-text-tertiary">
                            {t('explore.editor.outputColumnsHelp')}
                          </p>
                        </div>

                        <div className="mt-3 space-y-2">
                          {customQueryState?.columns?.length ? (
                            customQueryState.columns.map((column) => (
                              <div
                                key={column.name}
                                className="flex items-center justify-between rounded-2xl border border-[rgb(var(--border-line))] bg-surface-2 px-3 py-2"
                              >
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium text-text-secondary">{column.name}</p>
                                  <p className="text-xs text-text-quaternary">{column.type}</p>
                                </div>
                                <span className="rounded-full bg-surface-1 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
                                  SQL
                                </span>
                              </div>
                            ))
                          ) : (
                            <div className="rounded-2xl border border-dashed border-[rgb(var(--border-line))] bg-surface-2 px-4 py-6 text-center">
                              <Code2 className="mx-auto mb-3 h-8 w-8 text-warning" />
                              <p className="text-sm font-medium text-text-secondary">{t('explore.editor.runSqlLoadOutputColumns')}</p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  <ExploreChartConfig
                    chartType={chartType}
                    roleConfig={activeRoleConfig}
                    styleConfig={chartStyleConfig}
                    availableColumns={configColumns}
                    sortLimitColumns={sortLimitColumns}
                    tableDisplayColumns={tableDisplayColumns}
                    queryMode={sqlMode}
                    validationMessage={activeValidationMessage}
                    readOnly={!resPerms.canEdit}
                    availableSeriesKeys={previewSeriesKeys}
                    chartResultColumns={
                      // Phase-15.88 — feed actual BE-returned column names
                      // to ExploreChartConfig so Tooltip extra fields chip
                      // list only offers columns that exist in the result
                      // (instead of the whole dataset catalogue that mostly
                      // wouldn't render in tooltips).
                      displayedQueryState?.chartRows?.[0]
                        ? Object.keys(displayedQueryState.chartRows[0])
                        : []
                    }
                    dimChildrenMap={dimHierarchy.childrenOf}
                    declaredMeasureRefs={declaredMeasureRefs}
                    baseViewName={selectedSemanticView?.name ?? null}
                    joinKeyRefs={joinKeyRefs}
                    onChartTypeChange={handleChartTypeChange}
                    onRoleConfigChange={sqlMode === 'custom' ? setCustomRoleConfig : setGeneratedRoleConfig}
                    onStyleConfigChange={setChartStyleConfig}
                  />

                  <div className="border-t">
                    <button
                      onClick={() => setIsFiltersOpen((open) => !open)}
                      className="flex w-full items-center justify-between px-4 py-2.5 transition-colors hover:bg-surface-2"
                    >
                      <div className="flex items-center gap-2">
                        <Settings2 className="h-3.5 w-3.5 text-text-quaternary" />
                        <span className="text-xs font-semibold text-text-secondary">{t('explore.editor.chartFilters')}</span>
                        {filters.length > 0 && (
                          <span className="rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">
                            {filters.length}
                          </span>
                        )}
                      </div>
                      {isFiltersOpen
                        ? <ChevronDown className="h-3.5 w-3.5 text-text-quaternary" />
                        : <ChevronRight className="h-3.5 w-3.5 text-text-quaternary" />}
                    </button>
                    {isFiltersOpen && (
                      <div className="px-4 pb-4">
                        <p className="mb-2 text-[11px] text-text-tertiary">
                          {t('explore.editor.chartFiltersPersistHelp')}
                        </p>
                        <p className="mb-3 text-[10px] text-text-quaternary">
                          {sqlMode === 'custom'
                            ? t('explore.editor.chartFiltersCustomHelp')
                            : t('explore.editor.chartFiltersDashboardHelp')}
                        </p>
                        {sqlMode === 'custom' && filterColumns.length === 0 ? (
                          <p className="text-xs text-text-quaternary">
                            {t('explore.editor.runCustomSqlForFilters')}
                          </p>
                        ) : (
                          <FilterBuilder
                            filters={filters}
                            onChange={setFilters}
                            columns={filterColumns}
                            dataRows={filterRows}
                            datasetId={selectedDatasetId}
                            bridgeOnlyViewNames={bridgeOnlyViewNames}
                            readOnly={!resPerms.canEdit}
                          />
                        )}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex h-full min-h-[28rem] items-center justify-center p-8">
                  <div className="max-w-md text-center">
                    <Settings2 className="mx-auto mb-3 h-10 w-10 text-text-quaternary" />
                    <p className="text-sm font-medium text-text-secondary">{t('explore.editor.chooseDatasetUnlockConfigure')}</p>
                    <p className="mt-1 text-xs text-text-quaternary">
                      {t('explore.editor.chooseDatasetUnlockConfigureHelp')}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex min-h-[24rem] min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm lg:min-h-0">
            <div className="flex items-center justify-between gap-3 border-b border-[rgb(var(--border-line))] px-4 py-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">{t('explore.editor.preview')}</span>
                <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-[11px] text-text-tertiary">
                  {displayedQueryState
                    ? t(displayedQueryState.rows.length === 1 ? 'explore.editor.rowCountOne' : 'explore.editor.rowCountMany', { count: displayedQueryState.rows.length })
                    : t('explore.editor.noRunYet')}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {/* Phase-15.20: PowerBI-style drill controls live HERE in the
                    chart preview header, not in the Configure panel. The
                    config panel only carries the on/off toggle. */}
                {drillDateField && drillGrain && previewPanelTab !== 'query' && (
                  <ChartDrillControls
                    fieldDisplayLabel={drillFieldDisplayLabel}
                    grain={drillGrain}
                    disabled={!resPerms.canEdit || isRunningQuery}
                    onChange={handleDrillChange}
                  />
                )}
                <div className="inline-flex rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-0.5">
                  {[
                    { key: 'chart', label: t('explore.editor.tabChart') },
                    { key: 'table', label: t('explore.editor.tabTable') },
                    // Phase-15.9: "Query" tab — shows SQL + routing + warnings
                    // so DA can debug pipeline issues without server logs.
                    { key: 'query', label: t('explore.editor.tabQuery') },
                  ].map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setPreviewPanelTab(tab.key as 'chart' | 'table' | 'query')}
                      className={`rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${
                        previewPanelTab === tab.key
                          ? 'bg-surface-1 text-text-primary shadow-linear-sm'
                          : 'text-text-secondary hover:bg-surface-1'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {queryError && (
              <div className="border-b border-danger/30 bg-danger/10 px-5 py-2 text-xs text-danger">
                {queryError}
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-hidden p-5">
              {!selectedTableId ? (
                <div className="flex h-full items-center justify-center">
                  <div className="max-w-sm text-center">
                    <Search className="mx-auto mb-3 h-12 w-12 text-text-quaternary" />
                    <p className="text-sm font-medium text-text-secondary">
                      {selectedDatasetId ? t('explore.editor.pickFieldToStart') : t('explore.editor.chooseDatasetToStart')}
                    </p>
                    <p className="mt-1 text-xs text-text-quaternary">
                      {selectedDatasetId
                        ? t('explore.editor.pickFieldToStartHelp')
                        : t('explore.editor.chooseDatasetToStartHelp')}
                    </p>
                  </div>
                </div>
              ) : !displayedQueryState ? (
                <div className="flex h-full items-center justify-center">
                  <div className="max-w-sm text-center">
                    {isConfigBuilderMode
                      ? <Database className="mx-auto mb-3 h-10 w-10 text-text-quaternary" />
                      : <Code2 className="mx-auto mb-3 h-10 w-10 text-warning" />}
                    <p className="text-sm font-medium text-text-secondary">{t('explore.editor.runOncePreview')}</p>
                    <p className="mt-1 text-xs text-text-quaternary">
                      {t('explore.editor.runOncePreviewHelp')}
                    </p>
                  </div>
                </div>
              ) : customRunMessage ? (
                <div className="flex h-full items-center justify-center">
                  <div className="max-w-sm text-center">
                    <Settings2 className="mx-auto mb-3 h-10 w-10 text-warning" />
                    <p className="text-sm font-medium text-text-secondary">{t('explore.editor.finishRolesConfigure')}</p>
                    <p className="mt-1 text-xs text-text-quaternary">{customRunMessage}</p>
                  </div>
                </div>
              ) : previewPanelTab === 'chart' ? (
                <div className="h-full overflow-hidden rounded-2xl border border-[rgb(var(--border-line))] bg-surface-2 p-3">
                  <div className="flex h-full flex-col overflow-hidden rounded-[20px] bg-surface-1 p-3">
                    {/* Phase-3b: surface semantic engine warnings (ambiguous
                        join paths, etc.) so the user knows when results may
                        depend on which join path the resolver picked. */}
                    {displayedQueryState.warnings && displayedQueryState.warnings.length > 0 && (
                      <div className="mb-2 rounded-md border border-warning/40 bg-warning/5 px-2.5 py-1.5 text-[11px] leading-snug text-warning">
                        {displayedQueryState.warnings.map((w, i) => (
                          <div key={i}>⚠ {w}</div>
                        ))}
                      </div>
                    )}
                    {/* Phase-15.78 — keyed wrapper + bi-fade-in so the
                        chart softly cross-fades on chart-type change
                        instead of hard-cutting between Recharts
                        primitives. Most chart-type swaps happen here in
                        Explore preview; ChartTile uses the same pattern
                        for dashboard tiles. */}
                    <div key={chartType} className="flex-1 overflow-hidden bi-fade-in">
                      {/* A chart renderer must never crash the whole Explore
                          page. The dashboard already wraps tiles in this
                          boundary; the Explore preview was the one unguarded
                          render path (a chart throwing — e.g. a transient
                          hooks/recharts error while a ran result is briefly
                          stale across a chart-type switch — took down the
                          entire editor). `resetKey={displayedQueryState}`
                          auto-recovers once the fresh result arrives. */}
                      <ChartErrorBoundary chartId={chartId ?? 0} resetKey={displayedQueryState}>
                        <ExploreChart
                          type={chartType}
                          data={displayedQueryState.chartRows}
                          roleConfig={normalizedRoleConfig}
                          styleConfig={chartStyleConfig}
                          onStyleConfigChange={setChartStyleConfig}
                          preAggregated={displayedQueryState.chartPreAggregated}
                          labelMap={semanticLabelMap}
                          formatMap={semanticFormatMap}
                        />
                      </ChartErrorBoundary>
                    </div>
                  </div>
                </div>
              ) : previewPanelTab === 'table' ? (
                <div className="h-full overflow-hidden rounded-2xl border border-[rgb(var(--border-line))] bg-surface-2">
                  <DatasetTableGrid columns={displayedQueryState.columns} rows={displayedQueryState.rows} />
                </div>
              ) : (
                <QueryInspector state={displayedQueryState} chartType={chartType} />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* AI Description drawer — opened from MODE bar */}
      {!isNew && chartId && (
        <ChartDescriptionDrawer
          chartId={chartId}
          canEdit={resPerms.canEdit}
          open={isDescDrawerOpen}
          onClose={() => setIsDescDrawerOpen(false)}
        />
      )}

    </div>
  );
}
