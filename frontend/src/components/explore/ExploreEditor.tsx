/**
 * Explore editor - reusable chart builder used by Explore and dashboard flows.
 */
'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Save, ArrowLeft, ChevronDown, ChevronRight, Pencil, Check, Search, Settings2, Play, RotateCcw, Database, Code2, Eye } from 'lucide-react';
import { HelpTooltip } from '@/components/ui/HelpTooltip';
import { useDataset, useTablePreview, useExecuteDatasetTableQueryMutation, type ColumnMetadata } from '@/hooks/use-datasets';
import { ExploreSourceSelector } from '@/components/explore/ExploreSourceSelector';
import { DatasetTableGrid } from '@/components/datasets/DatasetTableGrid';
import { ExploreChart } from '@/components/explore/ExploreChart';
import { buildExploreChartModel } from '@/components/explore/chartDataAdapter';
import { FilterBuilder, type Filter } from '@/components/explore/FilterBuilder';
import {
  useChart,
  useCreateChart,
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
  normalizeChartStyleConfig,
  normalizeRoleConfig,
} from '@/components/explore/ExploreChartConfig';
import { toast } from '@/lib/toast';
import { extractApiError } from '@/lib/api-errors';
import { getResourcePermissions } from '@/hooks/use-resource-permission';
import { ChartDescriptionDrawer, ChartDescriptionTrigger } from '@/components/explore/ChartDescriptionDrawer';
import {
  buildExploreChartResult,
  buildExploreExecuteRequest,
  buildExploreSqlPreview,
  buildQuerySignature,
  inferRoleConfigFromCustomSql,
  inferQueryColumns,
  normalizeExecuteResponseColumns,
  stripTrailingSqlLimit,
} from '@/lib/explore-query';
import type { ChartMetadataUpsert, ChartParameterCreate } from '@/types/api';
import { useDatasetModel, type DatasetModelView } from '@/hooks/use-dataset-model';
import { getReachableViews } from '@/lib/dataset-model-graph';

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
    ? 'Semantic engine (multi-hop JOIN)'
    : routing === 'live_query'
      ? 'Live query (single table)'
      : routing === 'preview'
        ? 'FE preview (chưa run BE)'
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
                ? 'BE route qua SemanticQueryEngine — handle JOIN, time macros, window aggregate.'
                : routing === 'live_query'
                  ? 'BE route qua live_query (single-table SQL build). KHÔNG handle JOIN — nếu chart cần JOIN, kéo qualified field "view.field" để upgrade.'
                  : 'Route chưa xác định — BE chưa surface debug info.'
            }
          >
            {routingLabel}
          </span>
          <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-text-tertiary">
            Dialect: <code className="font-mono">{dialect}</code>
          </span>
          {execMs != null && (
            <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-text-tertiary">
              Exec: <code className="font-mono">{execMs.toFixed(1)} ms</code>
            </span>
          )}
          <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-text-tertiary">
            Rows: <code className="font-mono">{rowCount}</code>
          </span>
          <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-text-tertiary">
            Chart: <code className="font-mono">{chartType}</code>
          </span>
          <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-text-tertiary">
            Pre-agg: <code className="font-mono">{String(state.chartPreAggregated)}</code>
          </span>
        </div>

        {/* ── Warnings ──────────────────────────────────────────── */}
        {warnings.length > 0 && (
          <div className="rounded-md border border-warning/40 bg-warning/5 p-2 text-[11px] leading-snug text-warning">
            <div className="mb-1 font-emphasis">Engine warnings ({warnings.length})</div>
            {warnings.map((w, i) => (
              <div key={i}>⚠ {w}</div>
            ))}
          </div>
        )}

        {/* ── SQL block ─────────────────────────────────────────── */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-emphasis uppercase tracking-wide text-text-tertiary">
              SQL — {sqlSource === 'backend' ? 'emit từ BE' : 'preview build FE'}
            </div>
            {sql && (
              <button
                onClick={onCopy}
                className="rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-[10px] text-text-secondary hover:bg-surface-1"
              >
                {copied ? '✓ Đã copy' : 'Copy SQL'}
              </button>
            )}
          </div>
          {sql ? (
            <pre className="overflow-auto rounded-md border border-[rgb(var(--border-line))] bg-surface-2 p-3 text-[11px] font-mono leading-relaxed text-text-secondary">
              {sql}
            </pre>
          ) : (
            <div className="rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-2 p-3 text-[11px] italic text-text-quaternary">
              Chưa có SQL — chạy chart trước (nút Run).
            </div>
          )}
        </div>

        {/* ── Hints ─────────────────────────────────────────────── */}
        <div className="mt-1 rounded-md border border-dashed border-[rgb(var(--border-line))] bg-surface-2 p-2 text-[10px] leading-snug text-text-quaternary">
          <div className="mb-1 font-emphasis uppercase tracking-wide text-text-tertiary">Debug tips</div>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>
              <strong>Chart trống mà Table OK</strong>: check <code>Routing</code> — nếu là <em>live_query</em>
              khi đang dùng measure đa bảng, qualify field thành <code>view.field</code> để upgrade sang semantic engine.
            </li>
            <li>
              <strong>Số lệch giữa preview và saved chart</strong>: copy SQL trên + chạy thẳng trên DB
              của bác — kết quả phải khớp. Nếu khớp, vấn đề ở FE adapter (mở DevTools console xem warning).
            </li>
            <li>
              <strong>Engine warning</strong>: thường là ambiguous join path. Mark 1 relationship inactive
              ở tab Data Model để chốt đường engine sẽ dùng.
            </li>
            <li>
              <strong>Dialect sai</strong>: nếu thấy dialect không match với datasource (vd dataset là
              BigQuery nhưng dialect = postgresql), báo dev — đây là Phase 12.6 bug.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}


type QueryMode = 'generated' | 'custom';

const GENERATED_QUERY_LIMIT_OPTIONS = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
const CUSTOM_QUERY_LIMIT_OPTIONS = [50, 100, 250, 500, 1000, 2500, 5000];
const TABLE_LIKE_CHART_TYPES = new Set<ChartType>(['TABLE', 'MATRIX']);
const SCATTER_LIKE_CHART_TYPES = new Set<ChartType>(['SCATTER', 'BUBBLE', 'MAP_POINT']);
const NO_DIMENSION_METRIC_CHART_TYPES = new Set<ChartType>(['KPI', 'GAUGE', 'BULLET']);
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
function getMaxQueryLimit(mode: QueryMode): number {
  return mode === 'custom' ? 5000 : 10000;
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
  debug?: {
    sql_emitted?: string;
    dialect?: string;
    routing?: string;
    execution_time_ms?: number;
    row_count?: number;
    warnings?: string[];
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
  };
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
    TABLE_LIKE_CHART_TYPES.has(chartType) ||
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
): ChartRoleConfig {
  const normalized = normalizeRoleConfig(chartType, roleConfig);
  if (!columns.length) return normalized;

  const columnNames = new Set(columns.map((column) => column.name));
  const numericColumns = columns.filter((column) => column.type === 'number');
  const metricCandidateColumns = numericColumns.filter((column) => !isIdentifierLikeField(column.name));
  const categoricalColumns = columns.filter((column) => column.type !== 'number');
  const timeColumns = columns.filter((column) => column.type === 'date' || column.type === 'datetime');
  const fallbackDimension = categoricalColumns[0]?.name ?? columns[0]?.name;
  const fallbackMetric = metricCandidateColumns.find((column) => column.name !== fallbackDimension)?.name
    ?? numericColumns.find((column) => column.name !== fallbackDimension)?.name
    ?? numericColumns[0]?.name;
  const pickDimensionOtherThan = (...excluded: Array<string | undefined>) => (
    categoricalColumns.find((column) => !excluded.includes(column.name))?.name
      ?? columns.find((column) => !excluded.includes(column.name))?.name
  );
  const pickMetricOtherThan = (...excluded: Array<string | undefined>) => (
    metricCandidateColumns.find((column) => !excluded.includes(column.name))?.name
      ?? numericColumns.find((column) => !excluded.includes(column.name))?.name
      ?? fallbackMetric
  );

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
  };

  if (next.selectedColumns && next.selectedColumns.length === 0) {
    next.selectedColumns = undefined;
  }

  if (TABLE_LIKE_CHART_TYPES.has(chartType)) {
    if (chartType === 'MATRIX') {
      next.tableMode = 'pivot';
    }
    if (next.tableMode === 'pivot') {
      const rowDimensionFallback = categoricalColumns[0]?.name ?? fallbackDimension;
      const columnDimensionFallback = categoricalColumns.find((column) => column.name !== rowDimensionFallback)?.name
        ?? columns.find((column) => column.name !== rowDimensionFallback)?.name;
      const pivotMetricFallback = numericColumns.find((column) => (
        column.name !== rowDimensionFallback && column.name !== columnDimensionFallback
      ))?.name ?? fallbackMetric;

      if (!next.tableRowDimension) {
        next.tableRowDimension = rowDimensionFallback;
      }
      if (!next.tableColumnDimension || next.tableColumnDimension === next.tableRowDimension) {
        next.tableColumnDimension = columnDimensionFallback;
      }
      if (!next.tablePivotMetric && pivotMetricFallback) {
        next.tablePivotMetric = { field: pivotMetricFallback, agg: 'sum' };
      }
    }
    return next;
  }

  if (SCATTER_LIKE_CHART_TYPES.has(chartType)) {
    if (!next.scatterX) next.scatterX = numericColumns[0]?.name;
    if (!next.scatterY) next.scatterY = numericColumns[1]?.name ?? numericColumns[0]?.name;
    if (!next.dimension && categoricalColumns.length > 0) {
      next.dimension = categoricalColumns[0]?.name;
    }
    if ((chartType === 'BUBBLE' || chartType === 'MAP_POINT') && next.metrics.length === 0) {
      const sizeMetric = pickMetricOtherThan(next.scatterX, next.scatterY);
      if (sizeMetric) {
        next.metrics = [{ field: sizeMetric, agg: 'sum' }];
      }
    }
    return next;
  }

  if (NO_DIMENSION_METRIC_CHART_TYPES.has(chartType)) {
    next.dimension = undefined;
    next.breakdown = undefined;
    next.timeField = undefined;
    if (next.metrics.length === 0 && fallbackMetric) {
      next.metrics = [{ field: fallbackMetric, agg: 'sum' }];
    }
    if (next.metrics.length > 1) {
      next.metrics = [next.metrics[0]];
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
    next.metrics = [{ field: fallbackMetric, agg: 'sum' }];
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
      next.lineMetric = { field: lineMetricCandidate.name, agg: 'sum' };
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
  };

  if (next.selectedColumns && next.selectedColumns.length === 0) {
    next.selectedColumns = undefined;
  }

  return next;
}

function isSourceTimeColumn(column: ColumnMetadata): boolean {
  const loweredType = String(column.type ?? '').toLowerCase();
  const loweredName = String(column.name ?? '').toLowerCase();
  return (
    ['date', 'datetime', 'timestamp', 'time'].includes(loweredType) ||
    /(date|time|_at|created|updated|day|month|year|start|end|deadline)/.test(loweredName)
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
  const [queryLimit, setQueryLimit] = useState(100);
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
  const upsertMetadata = useUpsertChartMetadata();
  const replaceParams = useReplaceChartParameters();
  const executeDatasetQuery = useExecuteDatasetTableQueryMutation();
  const previewChartData = usePreviewChartData();

  const { data: chart, isLoading: isChartLoading } = useChart(isEphemeral ? 0 : (chartId ?? 0));
  const { data: dataset } = useDataset(selectedDatasetId);
  const { data: datasetModel } = useDatasetModel(selectedDatasetId);
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
  const semanticLabelMap = useMemo(() => {
    if (!datasetModel?.views) return undefined;
    const map = new Map<string, string>();
    for (const view of datasetModel.views) {
      for (const dim of view.dimensions ?? []) {
        const label = (dim.label || '').trim();
        if (!label) continue;
        map.set(`${view.name}.${dim.name}`, label);
        // Bare key as fallback for queries that strip the view qualifier
        if (!map.has(dim.name)) map.set(dim.name, label);
      }
      for (const measure of view.measures ?? []) {
        const label = (measure.label || '').trim();
        if (!label) continue;
        map.set(`${view.name}.${measure.name}`, label);
        if (!map.has(measure.name)) map.set(measure.name, label);
      }
    }
    return map;
  }, [datasetModel]);
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
      for (const measure of view.measures ?? []) {
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
  const executeRequest = useMemo(
    () => buildExploreExecuteRequest({
      chartType,
      roleConfig: normalizedGeneratedRoleConfig,
      styleConfig: chartStyleConfig,
      filters,
      limit: effectiveQueryLimit,
    }),
    [chartType, normalizedGeneratedRoleConfig, chartStyleConfig, filters, effectiveQueryLimit],
  );
  const generatedSql = useMemo(
    () => buildExploreSqlPreview({
      table: selectedTable,
      chartType,
      roleConfig: normalizedGeneratedRoleConfig,
      styleConfig: chartStyleConfig,
      filters,
      limit: effectiveQueryLimit,
    }),
    [selectedTable, chartType, normalizedGeneratedRoleConfig, chartStyleConfig, filters, effectiveQueryLimit],
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
  const isRunningQuery = executeDatasetQuery.isPending || previewChartData.isPending;
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
  const filterColumns = sqlMode === 'custom'
    ? (customConfigColumns ?? [])
    : [...dedupedPreviewColumns, ...semanticColumns.filter((column) => column.type !== 'number')];
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
    if (chartType === 'BAR_LINE') {
      return [...(model.comboBarSeries ?? []), ...(model.comboLineSeries ?? [])].map((s) => ({
        key: s.key,
        label: s.label,
      }));
    }
    if (PIE_LIKE_CHART_TYPES.has(chartType)) {
      return (model.pieData ?? []).slice(0, 12).map((p: any) => ({
        key: String(p?.name ?? ''),
        label: String(p?.name ?? ''),
      }));
    }
    return (model.categoricalSeries ?? []).map((s) => ({ key: s.key, label: s.label }));
  }, [chartType, displayedQueryState?.chartRows, displayedQueryState?.chartPreAggregated, normalizedRoleConfig]);

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

    setChartType(nextType);

    if (!TABLE_LIKE_CHART_TYPES.has(nextType) || TABLE_LIKE_CHART_TYPES.has(chartType)) {
      return;
    }

    const nextTableMode = nextType === 'MATRIX' ? 'pivot' : 'standard';
    setGeneratedRoleConfig((prev) => createDefaultTableRoleConfig(prev, nextTableMode));
    setCustomRoleConfig((prev) => createDefaultTableRoleConfig(prev, nextTableMode));
    setChartStyleConfig((prev) => createDefaultTableStyleConfig(prev));
    setGeneratedQueryState(null);
    setCustomQueryState(null);
    setGeneratedLastRunSignature('');
    setCustomLastRunSignature('');
    setQueryError(null);
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
    const view = datasetModel.views?.find((v) => v.name === firstView);
    if (!view?.dataset_table_id) return;
    // Suppress the reset-on-table-change effect below — this is the FIRST
    // base set, not a user-initiated table swap, so filters / role-config
    // should NOT be wiped.
    skipNextSourceResetRef.current = true;
    setSelectedTableId(view.dataset_table_id);
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
      const synced = syncRoleConfigWithColumns(chartType, prev, availableGeneratedColumns);
      return upgradeRoleConfigToQualified(synced, qualifiedByBare);
    });
  }, [chartType, previewColumns, semanticColumns, semanticReady, qualifiedByBare]);

  useEffect(() => {
    const maxLimit = getMaxQueryLimit(sqlMode);
    if (queryLimit > maxLimit) {
      setQueryLimit(maxLimit);
    }
  }, [queryLimit, sqlMode]);

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
      toast.error('Please select a dataset table first');
      return;
    }

    setQueryError(null);

    try {
      if (sqlMode === 'custom') {
        const sql = customSqlDraft.trim();
        if (!sql) {
          toast.error('Custom SQL cannot be empty');
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
            ? syncRoleConfigWithColumns(chartType, inferredConfigs.generatedRoleConfig, previewColumns)
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
        });
        setCustomLastRunSignature(nextCustomSignature);
      } else {
        if (generatedRoleRequirementMessage) {
          setQueryError(generatedRoleRequirementMessage);
          toast.error(generatedRoleRequirementMessage);
          return;
        }

        const response = await executeDatasetQuery.mutateAsync({
          datasetId: selectedDatasetId,
          tableId: selectedTableId,
          request: executeRequest,
        });
        const columns = normalizeExecuteResponseColumns(response);
        const chartResult = buildExploreChartResult({
          rows: response.rows,
          columns,
          chartType,
          roleConfig: normalizedGeneratedRoleConfig,
          source: 'generated',
        });

        setGeneratedQueryState({
          source: 'generated',
          sql: generatedSql,
          columns,
          rows: response.rows,
          chartRows: chartResult.rows,
          chartColumns: chartResult.columns,
          chartPreAggregated: chartResult.preAggregated,
          warnings: (response as any).warnings,
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
    didAutoRunRef.current = true;
    void handleRunQuery();
  }, [isNew, isChartLoaded, selectedDatasetId, selectedTableId, selectedTable, currentQuerySignature]);

  const handleSaveLook = async () => {
    if (!selectedTableId) {
      toast.error('Please select a dataset table first');
      return;
    }
    const trimmedCustomSql = customSqlDraft.trim();
    if (sqlMode === 'custom') {
      if (!trimmedCustomSql) {
        toast.error('Custom SQL cannot be empty');
        return;
      }
      if (customRoleRequirementMessage) {
        toast.error(customRoleRequirementMessage);
        return;
      }
      if (!customQueryState || currentQuerySignature !== customLastRunSignature) {
        toast.error('Run the custom SQL before saving so the chart uses the latest output columns');
        return;
      }
    } else if (generatedRoleRequirementMessage) {
      toast.error(generatedRoleRequirementMessage);
      return;
    }

    const activeSavedRoleConfig = sqlMode === 'custom' ? customRoleConfig : generatedRoleConfig;
    const tableConditionalFormatting = chartStyleConfig.tableConditionalFormatting;
    const exploreConfig = {
      dataset_id: selectedDatasetId,
      filters,
      baseFilters: filters,
      chartType,
      queryMode: sqlMode,
      roleConfig: activeSavedRoleConfig,
      generatedRoleConfig,
      customRoleConfig,
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
      if (chartId !== null) {
        await updateChart.mutateAsync({
          id: chartId,
          data: {
            name: chartNameInput.trim() || undefined,
            description: chartDescInput.trim() || null,
            chart_type: chartType as any,
            dataset_table_id: selectedTableId,
            config: exploreConfig as unknown as import('@/types/api').ChartConfig,
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
          config: exploreConfig as unknown as import('@/types/api').ChartConfig,
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
          <p className="text-sm text-text-secondary">Loading chart...</p>
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
            <span className="font-medium">View only</span>
            <span className="text-warning">— You can preview this chart but cannot modify its configuration.</span>
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
                  placeholder="Chart name..."
                  className="min-w-[10rem] border-b border-brand/50 bg-transparent px-0.5 text-sm font-semibold text-text-primary outline-none"
                />
                <Check className="h-3.5 w-3.5 text-brand" />
              </div>
            ) : (
              <div className="flex items-center gap-1.5 group/name">
                <span className="max-w-[14rem] truncate text-sm font-semibold text-text-primary">
                  {chartNameInput || (chartId ? 'Chart' : 'New Chart')}
                </span>
                {resPerms.canEdit && (
                  <button
                    type="button"
                    onClick={() => setIsEditingName(true)}
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
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">Mode</span>
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
                    Builder
                  </button>
                  <span className="group/csql relative inline-flex">
                    <button
                      disabled
                      className="inline-flex cursor-not-allowed items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-text-quaternary opacity-50"
                    >
                      <Code2 className="h-3 w-3" />
                      SQL
                    </button>
                    <span className="pointer-events-none absolute left-0 top-full z-50 mt-1.5 hidden w-52 rounded-md bg-surface-inverse px-2.5 py-2 text-[11px] text-white shadow-lg group-hover/csql:block">
                      Temporarily unavailable — will be re-enabled in a future update.
                    </span>
                  </span>
                </div>
                <div className="hidden h-5 w-px bg-[rgb(var(--border-line))] lg:block" />
              </>
            )}
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">Dataset</span>
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
              const baseLabel = getSemanticViewDisplayName(selectedSemanticView);
              const crossUsed = activeRelationshipSummary.crossTableInUse;
              const joinedCount = activeRelationshipSummary.crossTableViews?.length ?? 0;
              const joinableCount = Math.max(0, activeRelationshipSummary.activeViewCount - 1);
              const hasJoined = crossUsed && joinedCount > 0;
              const hasJoinable = !crossUsed && joinableCount > 0;
              const tone = hasJoined
                ? 'border-success/40 bg-success/10 text-success'
                : 'border-[rgb(var(--border-line))] bg-surface-2 text-text-tertiary';
              const suffix = hasJoined
                ? ` · 🔗 +${joinedCount} joined`
                : hasJoinable
                  ? ` · 🔌 +${joinableCount} joinable`
                  : '';
              const tip = hasJoined
                ? `Bảng gốc: ${baseLabel}. Chart đang JOIN ${joinedCount} bảng khác qua relationship: ${(activeRelationshipSummary.crossTableViews ?? []).join(', ')}.`
                : hasJoinable
                  ? `Bảng gốc: ${baseLabel} (auto-derive từ field đầu tiên). ${joinableCount} bảng đang reachable qua relationship — pick field từ chúng để JOIN.`
                  : `Bảng gốc: ${baseLabel}. Auto-derive từ field đầu tiên user pick. Đổi bằng cách clear hết field và pick lại.`;
              return (
                <span
                  className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${tone}`}
                  title={tip}
                >
                  Base: {baseLabel}{suffix}
                </span>
              );
            })()}
          </div>

          {/* Right: status + limit + run + save (+ desc note) */}
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {isQueryDirty && (
              <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
                Run to refresh
              </span>
            )}
            {activeQueryState && (
              <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-[11px] text-text-tertiary">
                {activeQueryState.rows.length} row{activeQueryState.rows.length === 1 ? '' : 's'}
                {activeQueryState.executionTimeMs != null ? ` · ${activeQueryState.executionTimeMs}ms` : ''}
              </span>
            )}
            <label className="flex items-center gap-1 text-[11px] text-text-tertiary">
              Limit
              <select
                value={effectiveQueryLimit}
                onChange={(e) => setQueryLimit(Number(e.target.value))}
                disabled={!resPerms.canEdit}
                className="rounded border border-[rgb(var(--border-line))] bg-surface-1 px-1.5 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {queryLimitOptions.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <button
              onClick={() => void handleRunQuery()}
              disabled={!selectedTableId || isRunningQuery || (isConfigBuilderMode && isPreviewLoading)}
              className="inline-flex items-center gap-1.5 rounded-md border border-[rgb(var(--border-line))] bg-surface-2 px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isRunningQuery
                ? <div className="h-3 w-3 animate-spin rounded-full border-2 border-text-secondary border-t-transparent" />
                : <Play className="h-3 w-3" />}
              {isRunningQuery ? 'Running...' : 'Run'}
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
                  placeholder="Add note..."
                  className="w-44 border-b border-brand/50 bg-transparent px-0.5 text-xs text-text-secondary outline-none"
                />
              ) : resPerms.canEdit ? (
                <button
                  type="button"
                  onClick={() => setIsEditingDesc(true)}
                  className="group/desc flex max-w-[12rem] cursor-text items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-quaternary hover:bg-surface-2 hover:text-text-secondary"
                >
                  <span className="truncate">{chartDescInput || <span className="italic">Add note...</span>}</span>
                  <Pencil className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/desc:opacity-100" />
                </button>
              ) : chartDescInput ? (
                <span className="text-[11px] text-text-quaternary">{chartDescInput}</span>
              ) : null
            )}
            {resPerms.canEdit && (
              <button
                onClick={handleSaveLook}
                disabled={!selectedTableId}
                className="flex items-center gap-1.5 rounded-md border border-brand bg-brand px-3 py-1 text-xs font-medium text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Save className="h-3.5 w-3.5" />
                {saveButtonLabel ?? (chartId ? 'Update' : 'Save')}
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
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">Configure</span>
                {selectedDatasetId && (
                  <>
                    <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-1 px-2 py-0.5 text-[11px] text-text-secondary">{chartType}</span>
                    {hasActiveTransforms && (
                      <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] text-warning">transforms</span>
                    )}
                    {filters.length > 0 && (
                      <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] text-warning">{filters.length} filter{filters.length === 1 ? '' : 's'}</span>
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
                          <p className="text-sm font-medium text-text-secondary">Custom SQL</p>
                          <HelpTooltip text="Run SQL to refresh the output columns used by Chart Setup." />
                        </div>
                        {resPerms.canEdit && (
                          <button
                            onClick={handleResetCustomSqlDraft}
                            className="inline-flex items-center gap-1 rounded-lg border border-[rgb(var(--border-line))] px-2 py-1 text-xs text-text-secondary hover:bg-surface-2"
                          >
                            <RotateCcw className="h-3 w-3" />
                            Reset
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
                          <p className="text-sm font-medium text-text-primary">Output columns</p>
                          <p className="mt-1 text-xs text-text-tertiary">
                            These columns only exist after the SQL runs. Chart Setup binds directly to them.
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
                              <p className="text-sm font-medium text-text-secondary">Run SQL to load output columns</p>
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
                        <span className="text-xs font-semibold text-text-secondary">Chart Filters</span>
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
                          Saved with this chart and still applied after you add it to a dashboard.
                        </p>
                        <p className="mb-3 text-[10px] text-text-quaternary">
                          {sqlMode === 'custom'
                            ? 'These filters run against the columns returned by the custom SQL output.'
                            : 'These filters run before dashboard-level filters.'}
                        </p>
                        {sqlMode === 'custom' && filterColumns.length === 0 ? (
                          <p className="text-xs text-text-quaternary">
                            Run the custom SQL once to load output columns for chart filters.
                          </p>
                        ) : (
                          <FilterBuilder
                            filters={filters}
                            onChange={setFilters}
                            columns={filterColumns}
                            dataRows={filterRows}
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
                    <p className="text-sm font-medium text-text-secondary">Choose a dataset to unlock Configure</p>
                    <p className="mt-1 text-xs text-text-quaternary">
                      Pick the dataset in the header. Base table auto-derives from the first field you pick.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex min-h-[24rem] min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] border border-[rgb(var(--border-line))] bg-surface-1 shadow-linear-sm lg:min-h-0">
            <div className="flex items-center justify-between gap-3 border-b border-[rgb(var(--border-line))] px-4 py-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-quaternary">Preview</span>
                <span className="rounded-full border border-[rgb(var(--border-line))] bg-surface-2 px-2 py-0.5 text-[11px] text-text-tertiary">
                  {displayedQueryState
                    ? `${displayedQueryState.rows.length} row${displayedQueryState.rows.length === 1 ? '' : 's'}`
                    : 'No run yet'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="inline-flex rounded-lg border border-[rgb(var(--border-line))] bg-surface-2 p-0.5">
                  {[
                    { key: 'chart', label: 'Chart' },
                    { key: 'table', label: 'Table' },
                    // Phase-15.9: "Query" tab — shows SQL + routing + warnings
                    // so DA can debug pipeline issues without server logs.
                    { key: 'query', label: 'Query' },
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
                      {selectedDatasetId ? 'Pick a field below to start' : 'Choose a dataset to start'}
                    </p>
                    <p className="mt-1 text-xs text-text-quaternary">
                      {selectedDatasetId
                        ? 'Base table sẽ auto-derive từ field đầu tiên user pick. Field từ bảng khác sẽ auto-JOIN qua relationship.'
                        : 'Pick dataset in the header, then drag fields from the column panel.'}
                    </p>
                  </div>
                </div>
              ) : !displayedQueryState ? (
                <div className="flex h-full items-center justify-center">
                  <div className="max-w-sm text-center">
                    {isConfigBuilderMode
                      ? <Database className="mx-auto mb-3 h-10 w-10 text-text-quaternary" />
                      : <Code2 className="mx-auto mb-3 h-10 w-10 text-warning" />}
                    <p className="text-sm font-medium text-text-secondary">Run once to generate the preview</p>
                    <p className="mt-1 text-xs text-text-quaternary">
                      Configure the chart on the left, then run to see both the visual and table result here.
                    </p>
                  </div>
                </div>
              ) : customRunMessage ? (
                <div className="flex h-full items-center justify-center">
                  <div className="max-w-sm text-center">
                    <Settings2 className="mx-auto mb-3 h-10 w-10 text-warning" />
                    <p className="text-sm font-medium text-text-secondary">Finish the chart roles in Configure</p>
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
                    <div className="flex-1 overflow-hidden">
                      <ExploreChart
                        type={chartType}
                        data={displayedQueryState.chartRows}
                        roleConfig={normalizedRoleConfig}
                        styleConfig={chartStyleConfig}
                        onStyleConfigChange={setChartStyleConfig}
                        preAggregated={displayedQueryState.chartPreAggregated}
                        labelMap={semanticLabelMap}
                      />
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
