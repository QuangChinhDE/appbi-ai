import type { Filter } from '@/components/explore/FilterBuilder';
import {
  metricKey,
  normalizeMetricConfig,
  normalizeRoleConfig,
  TABLE_PIVOT_COLUMN_LIMIT,
  type ChartRoleConfig,
  type ExploreChartType,
  type MetricConfig,
} from '@/components/explore/ExploreChartConfig';
import type {
  ColumnMetadata,
  DatasetTable,
  ExecuteQueryRequest,
  ExecuteQueryResponse,
  FilterCondition as ExecuteFilterCondition,
} from '@/hooks/use-datasets';

type QuerySource = 'generated' | 'custom';

interface ParsedSqlMetric {
  agg: MetricConfig['agg'];
  sourceField: string | null;
  outputField: string;
}

interface ParsedSqlDimension {
  sourceField: string | null;
  outputField: string;
}

interface ParsedSqlSelectItem {
  isAggregate: boolean;
  metric?: ParsedSqlMetric;
  dimension?: ParsedSqlDimension;
}

interface CustomSqlRoleInference {
  customRoleConfig?: ChartRoleConfig;
  generatedRoleConfig?: ChartRoleConfig;
}

const TRAILING_ROW_LIMIT_PATTERN = /(?:\blimit\s+\d+\s*(?:offset\s+\d+\s*)?|\boffset\s+\d+\s+limit\s+\d+\s*|\bfetch\s+first\s+\d+\s+rows?\s+only)\s*$/i;
const AGGREGATED_CHART_TYPES = new Set<ExploreChartType>([
  'BAR',
  'HORIZONTAL_BAR',
  'GROUPED_BAR',
  'STACKED_BAR',
  'LINE',
  'AREA',
  'TIME_SERIES',
  'BAR_LINE',
  'PIE',
  'DONUT',
  'RADAR',
  'POLAR_AREA',
  'FUNNEL',
  'GAUGE',
  'TREEMAP',
  'WATERFALL',
  'BUBBLE',
  'HEATMAP',
  'MAP_POINT',
  'MAP_REGION',
  'BULLET',
  'SANKEY',
  'SUNBURST',
  'RIBBON',
  'TIMELINE',
  'WORD_CLOUD',
  'KPI',
  'PODIUM',
]);

const TABLE_LIKE_CHART_TYPES = new Set<ExploreChartType>(['TABLE', 'MATRIX']);
const SCATTER_LIKE_CHART_TYPES = new Set<ExploreChartType>(['SCATTER', 'BUBBLE', 'MAP_POINT']);
const RAW_DISTRIBUTION_CHART_TYPES = new Set<ExploreChartType>(['BOXPLOT']);
const BREAKDOWN_REQUIRED_CHART_TYPES = new Set<ExploreChartType>([
  'GROUPED_BAR',
  'STACKED_BAR',
  'HEATMAP',
  'SANKEY',
  'SUNBURST',
  'RIBBON',
]);

function datasetMetricAlias(metric: MetricConfig): string {
  return `${metric.field}_${metric.agg}`;
}

function metricOutputKeys(metric: MetricConfig): string[] {
  const keys = new Set<string>([
    datasetMetricAlias(metric),
    metricKey(metric),
    `${metric.agg}_${metric.field}`,
    `${metric.agg}__${metric.field}`,
    `${metric.field}__${metric.agg}`,
  ]);
  if (metric.outputField) {
    keys.add(metric.outputField);
  }
  return Array.from(keys).filter(Boolean);
}

function resolveSqlDimensionOutputField(
  outputColumns: string[],
  parsedDimensions: ParsedSqlDimension[],
  currentField: string | undefined,
): string | undefined {
  if (!currentField) return undefined;
  if (outputColumns.includes(currentField)) {
    return currentField;
  }

  const parsedMatch = parsedDimensions.find((dimension) => (
    dimension.sourceField === currentField || dimension.outputField === currentField
  ));
  return parsedMatch?.outputField;
}

function resolveSqlMetricConfig(
  outputColumns: string[],
  parsedMetrics: ParsedSqlMetric[],
  metric: MetricConfig | null | undefined,
): MetricConfig | undefined {
  if (!metric) return undefined;

  const parsedMatch = parsedMetrics.find((parsedMetric) => (
    parsedMetric.agg === metric.agg
      && (
        parsedMetric.sourceField === metric.field
        || parsedMetric.outputField === metric.outputField
        || parsedMetric.outputField === metric.field
      )
  ));
  const matchingOutputField = metricOutputKeys({
    ...metric,
    ...(parsedMatch?.outputField ? { outputField: parsedMatch.outputField } : {}),
  }).find((key) => outputColumns.includes(key));

  if (!parsedMatch && !matchingOutputField) {
    return undefined;
  }

  return {
    ...metric,
    outputField: parsedMatch?.outputField ?? matchingOutputField ?? metric.outputField,
  };
}

function dedupeMetrics(metrics: MetricConfig[]): MetricConfig[] {
  const seen = new Set<string>();
  const deduped: MetricConfig[] = [];
  for (const metric of metrics) {
    const key = metricKey(metric);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(metric);
  }
  return deduped;
}

function parsedMetricToConfig(metric: ParsedSqlMetric): MetricConfig {
  return {
    field: metric.sourceField ?? metric.outputField,
    agg: metric.agg,
    outputField: metric.outputField,
  };
}

function inferNumericOutputMetrics(columns: ColumnMetadata[]): MetricConfig[] {
  return columns
    .filter((column) => column.type === 'number')
    .map((column) => ({
      field: column.name,
      agg: 'sum' as const,
      outputField: column.name,
    }));
}

function resolveCurrentSqlMetric(
  columns: ColumnMetadata[],
  parsedMetrics: ParsedSqlMetric[],
  metric: MetricConfig | null | undefined,
): MetricConfig | undefined {
  const normalizedMetric = normalizeMetricConfig(metric);
  if (!normalizedMetric) {
    return undefined;
  }

  const outputColumns = columns.map((column) => column.name);
  const resolvedMetric = resolveSqlMetricConfig(outputColumns, parsedMetrics, normalizedMetric);
  if (resolvedMetric) {
    return resolvedMetric;
  }

  const numericOutputNames = new Set(
    columns
      .filter((column) => column.type === 'number')
      .map((column) => column.name),
  );
  const directOutputMatch = metricOutputKeys(normalizedMetric)
    .find((key) => numericOutputNames.has(key));

  if (!directOutputMatch) {
    return undefined;
  }

  return {
    ...normalizedMetric,
    outputField: directOutputMatch,
  };
}

function pickFirstUnusedMetric(
  candidates: MetricConfig[],
  usedMetricKeys: Set<string>,
): MetricConfig | undefined {
  const match = candidates.find((candidate) => !usedMetricKeys.has(metricKey(candidate)));
  if (!match) {
    return undefined;
  }
  usedMetricKeys.add(metricKey(match));
  return match;
}

function buildChartQueryMetrics(
  chartType: ExploreChartType,
  roleConfig: ChartRoleConfig,
): MetricConfig[] {
  const normalized = normalizeRoleConfig(chartType, roleConfig);
  if (chartType === 'KPI' || chartType === 'GAUGE' || chartType === 'BULLET') {
    const primaryMetric = normalized.metrics[0] ? [normalized.metrics[0]] : [];
    return dedupeMetrics(
      normalized.benchmarkMetric
        ? [...primaryMetric, normalized.benchmarkMetric]
        : primaryMetric,
    );
  }

  return dedupeMetrics(
    chartType === 'BAR_LINE' && normalized.lineMetric
      ? [...normalized.metrics, ...(normalized.lineMetric ? [normalized.lineMetric] : []), ...(normalized.benchmarkMetric ? [normalized.benchmarkMetric] : [])]
      : [...normalized.metrics],
  );
}

function isTablePivotConfig(roleConfig: ChartRoleConfig | null | undefined): boolean {
  return roleConfig?.tableMode === 'pivot'
    && Boolean(roleConfig.tableRowDimension)
    && Boolean(roleConfig.tableColumnDimension)
    && Boolean(roleConfig.tablePivotMetric);
}

function buildTablePivotQueryLimit(limit: number): number {
  return Math.min(10_000, Math.max(limit * TABLE_PIVOT_COLUMN_LIMIT, 1_000));
}

function normalizeFilterValue(filter: Filter): any {
  if (filter.operator === 'is_null' || filter.operator === 'is_not_null') {
    return null;
  }
  if (filter.operator === 'between') {
    return Array.isArray(filter.value) ? filter.value.slice(0, 2) : ['', ''];
  }
  if (filter.operator === 'in' || filter.operator === 'not_in') {
    if (Array.isArray(filter.value)) return filter.value;
    if (typeof filter.value === 'string') {
      return filter.value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    }
    return [];
  }
  return filter.value ?? '';
}

function quoteSqlValue(value: any): string {
  if (value === null || value === undefined || value === '') return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function formatSqlFilter(filter: Filter): string | null {
  const field = filter.field?.trim();
  if (!field) return null;
  const value = normalizeFilterValue(filter);

  switch (filter.operator) {
    case 'eq':
      return `${field} = ${quoteSqlValue(value)}`;
    case 'neq':
      return `${field} != ${quoteSqlValue(value)}`;
    case 'gt':
      return `${field} > ${quoteSqlValue(value)}`;
    case 'gte':
      return `${field} >= ${quoteSqlValue(value)}`;
    case 'lt':
      return `${field} < ${quoteSqlValue(value)}`;
    case 'lte':
      return `${field} <= ${quoteSqlValue(value)}`;
    case 'between': {
      const [start, end] = Array.isArray(value) ? value : ['', ''];
      const hasStart = start !== null && start !== undefined && start !== '';
      const hasEnd = end !== null && end !== undefined && end !== '';
      if (hasStart && hasEnd) return `${field} BETWEEN ${quoteSqlValue(start)} AND ${quoteSqlValue(end)}`;
      if (hasStart) return `${field} >= ${quoteSqlValue(start)}`;
      if (hasEnd) return `${field} <= ${quoteSqlValue(end)}`;
      return null;
    }
    case 'in':
    case 'not_in': {
      const values = Array.isArray(value) ? value.filter((item) => item !== '') : [];
      if (values.length === 0) return null;
      const comparator = filter.operator === 'not_in' ? 'NOT IN' : 'IN';
      return `${field} ${comparator} (${values.map(quoteSqlValue).join(', ')})`;
    }
    case 'contains': {
      const esc = String(value ?? '').replace(/'/g, "''").replace(/%/g, '\\%').replace(/_/g, '\\_');
      return `${field} LIKE '%${esc}%' ESCAPE '\\'`;
    }
    case 'not_contains': {
      const esc = String(value ?? '').replace(/'/g, "''").replace(/%/g, '\\%').replace(/_/g, '\\_');
      return `${field} NOT LIKE '%${esc}%' ESCAPE '\\'`;
    }
    case 'starts_with': {
      const esc = String(value ?? '').replace(/'/g, "''").replace(/%/g, '\\%').replace(/_/g, '\\_');
      return `${field} LIKE '${esc}%' ESCAPE '\\'`;
    }
    case 'is_null':
      return `${field} IS NULL`;
    case 'is_not_null':
      return `${field} IS NOT NULL`;
    default:
      return null;
  }
}

function normalizeSqlForLimitDetection(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '').trim();
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ');
}

function findTopLevelKeyword(sql: string, keyword: string, start = 0): number {
  const lowerSql = sql.toLowerCase();
  const lowerKeyword = keyword.toLowerCase();
  let depth = 0;
  let quote: "'" | '"' | '`' | null = null;

  for (let index = start; index <= lowerSql.length - lowerKeyword.length; index += 1) {
    const char = sql[index];
    if (quote) {
      if (char === quote && sql[index - 1] !== '\\') {
        quote = null;
      }
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char as "'" | '"' | '`';
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;
    if (lowerSql.slice(index, index + lowerKeyword.length) !== lowerKeyword) continue;

    const before = lowerSql[index - 1] ?? ' ';
    const after = lowerSql[index + lowerKeyword.length] ?? ' ';
    const beforeOk = !/[a-z0-9_]/.test(before);
    const afterOk = !/[a-z0-9_]/.test(after);
    if (beforeOk && afterOk) {
      return index;
    }
  }

  return -1;
}

function splitTopLevelCommaList(sql: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: "'" | '"' | '`' | null = null;
  let start = 0;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (quote) {
      if (char === quote && sql[index - 1] !== '\\') {
        quote = null;
      }
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char as "'" | '"' | '`';
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === ',' && depth === 0) {
      parts.push(sql.slice(start, index).trim());
      start = index + 1;
    }
  }

  const tail = sql.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function normalizeSqlIdentifier(identifier: string): string | null {
  const raw = identifier.trim();
  if (!raw) return null;

  const segments = raw.split('.').map((segment) => segment.trim()).filter(Boolean);
  const lastSegment = segments[segments.length - 1] ?? raw;
  const cleaned = lastSegment
    .replace(/^"(.*)"$/s, '$1')
    .replace(/^`(.*)`$/s, '$1')
    .replace(/^\[(.*)\]$/s, '$1');

  return /^[A-Za-z_][\w$]*$/.test(cleaned) ? cleaned : null;
}

function extractSelectAlias(expression: string, fallbackOutputField: string): { rawExpression: string; outputField: string } {
  const explicitAlias = expression.match(/^(.*?)(?:\s+AS\s+)([`"\[]?[A-Za-z_][\w$]*[`"\]]?)\s*$/i);
  if (explicitAlias) {
    return {
      rawExpression: explicitAlias[1].trim(),
      outputField: normalizeSqlIdentifier(explicitAlias[2]) ?? fallbackOutputField,
    };
  }

  return {
    rawExpression: expression.trim(),
    outputField: fallbackOutputField,
  };
}

function parseAggregateMetric(expression: string, outputField: string): ParsedSqlMetric | null {
  const normalized = expression.trim();
  const patterns: Array<[RegExp, MetricConfig['agg']]> = [
    [/^count\s*\(\s*distinct\s+(.+)\s*\)$/i, 'count_distinct'],
    [/^count\s*\(\s*(.+)\s*\)$/i, 'count'],
    [/^sum\s*\(\s*(.+)\s*\)$/i, 'sum'],
    [/^avg\s*\(\s*(.+)\s*\)$/i, 'avg'],
    [/^min\s*\(\s*(.+)\s*\)$/i, 'min'],
    [/^max\s*\(\s*(.+)\s*\)$/i, 'max'],
  ];

  for (const [pattern, agg] of patterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const inner = match[1]?.trim() ?? '';
    return {
      agg,
      sourceField: inner === '*' ? null : normalizeSqlIdentifier(inner),
      outputField,
    };
  }

  return null;
}

function parseSelectItem(
  expression: string,
  fallbackOutputField: string,
): ParsedSqlSelectItem | null {
  const { rawExpression, outputField } = extractSelectAlias(expression, fallbackOutputField);
  const metric = parseAggregateMetric(rawExpression, outputField);
  if (metric) {
    return { isAggregate: true, metric };
  }

  const sourceField = normalizeSqlIdentifier(rawExpression);
  if (!sourceField && !outputField) {
    return null;
  }

  return {
    isAggregate: false,
    dimension: {
      sourceField,
      outputField,
    },
  };
}

function parseCustomSqlSelect(sql: string, outputColumns: string[]): ParsedSqlSelectItem[] {
  const cleanedSql = normalizeSqlForLimitDetection(stripSqlComments(sql));
  const selectIndex = findTopLevelKeyword(cleanedSql, 'select');
  const fromIndex = findTopLevelKeyword(cleanedSql, 'from', selectIndex + 6);
  if (selectIndex === -1 || fromIndex === -1 || fromIndex <= selectIndex) {
    return [];
  }

  const selectClause = cleanedSql.slice(selectIndex + 6, fromIndex).trim();
  if (!selectClause) return [];

  return splitTopLevelCommaList(selectClause)
    .map((item, index) => parseSelectItem(item, outputColumns[index] ?? `col_${index + 1}`))
    .filter((item): item is ParsedSqlSelectItem => Boolean(item));
}

export function inferRoleConfigFromCustomSql(args: {
  sql: string;
  chartType: ExploreChartType;
  columns: ColumnMetadata[];
  currentRoleConfig?: ChartRoleConfig;
}): CustomSqlRoleInference {
  const { sql, chartType, columns, currentRoleConfig } = args;
  const outputColumns = columns.map((column) => column.name);
  const normalizedCurrent = normalizeRoleConfig(chartType, currentRoleConfig);
  const parsedItems = parseCustomSqlSelect(sql, outputColumns);
  if (parsedItems.length === 0) {
    return {};
  }

  const parsedMetrics = parsedItems
    .map((item) => item.metric)
    .filter((item): item is ParsedSqlMetric => Boolean(item));
  const parsedDimensions = parsedItems
    .map((item) => item.dimension)
    .filter((item): item is ParsedSqlDimension => Boolean(item));

  if (TABLE_LIKE_CHART_TYPES.has(chartType)) {
    if (isTablePivotConfig(normalizedCurrent)) {
      const pivotMetric = resolveSqlMetricConfig(
        outputColumns,
        parsedMetrics,
        normalizedCurrent.tablePivotMetric,
      );

      return {
        customRoleConfig: {
          ...normalizedCurrent,
          selectedColumns: outputColumns,
          tableRowDimension: resolveSqlDimensionOutputField(
            outputColumns,
            parsedDimensions,
            normalizedCurrent.tableRowDimension,
          ),
          tableColumnDimension: resolveSqlDimensionOutputField(
            outputColumns,
            parsedDimensions,
            normalizedCurrent.tableColumnDimension,
          ),
          tablePivotMetric: pivotMetric,
        },
      };
    }

    const customRoleConfig: ChartRoleConfig = {
      metrics: [],
      selectedColumns: outputColumns,
    };
    const generatedColumns = parsedDimensions.every((dimension) => Boolean(dimension.sourceField))
      ? parsedDimensions.map((dimension) => dimension.sourceField as string)
      : null;

    return {
      customRoleConfig,
      ...(generatedColumns
        ? { generatedRoleConfig: { metrics: [], selectedColumns: generatedColumns } }
        : {}),
    };
  }

  if (parsedMetrics.length === 0) {
    return {};
  }

  if (chartType === 'KPI' || chartType === 'GAUGE' || chartType === 'BULLET') {
    const resolvedCurrentMetric = resolveCurrentSqlMetric(
      columns,
      parsedMetrics,
      normalizedCurrent.metrics[0],
    );
    const resolvedCurrentBenchmarkMetric = resolveCurrentSqlMetric(
      columns,
      parsedMetrics,
      normalizedCurrent.benchmarkMetric,
    );
    const metricCandidates = dedupeMetrics([
      ...parsedMetrics.map(parsedMetricToConfig),
      ...inferNumericOutputMetrics(columns),
    ]);
    const usedMetricKeys = new Set<string>();
    const primaryMetric = resolvedCurrentMetric ?? pickFirstUnusedMetric(metricCandidates, usedMetricKeys);

    if (!primaryMetric) {
      return {};
    }

    usedMetricKeys.add(metricKey(primaryMetric));
    const benchmarkMetric = resolvedCurrentBenchmarkMetric
      ?? pickFirstUnusedMetric(metricCandidates, usedMetricKeys);
    const customRoleConfig: ChartRoleConfig = {
      metrics: [primaryMetric],
      ...(benchmarkMetric
        ? { benchmarkMetric }
        : {}),
    };

    const primaryParsedMetric = parsedMetrics.find((metric) => (
      metric.agg === primaryMetric.agg
        && (
          metric.outputField === primaryMetric.outputField
          || metric.outputField === primaryMetric.field
          || metric.sourceField === primaryMetric.field
        )
    ));
    const benchmarkParsedMetric = benchmarkMetric
      ? parsedMetrics.find((metric) => (
          metric.agg === benchmarkMetric.agg
            && (
              metric.outputField === benchmarkMetric.outputField
              || metric.outputField === benchmarkMetric.field
              || metric.sourceField === benchmarkMetric.field
            )
        ))
      : undefined;

    const canSyncGenerated = Boolean(primaryParsedMetric?.sourceField)
      && (!benchmarkParsedMetric || Boolean(benchmarkParsedMetric.sourceField));

    return {
      customRoleConfig,
      ...(canSyncGenerated
        ? {
            generatedRoleConfig: {
              metrics: [{
                field: primaryParsedMetric?.sourceField as string,
                agg: primaryMetric.agg,
              }],
              ...(benchmarkParsedMetric
                ? {
                    benchmarkMetric: {
                      field: benchmarkParsedMetric.sourceField as string,
                      agg: benchmarkMetric?.agg ?? 'sum',
                    },
                  }
                : {}),
            },
          }
        : {}),
    };
  }

  const primaryDimension = parsedDimensions[0];
  const secondaryDimension = parsedDimensions.find((dimension) => (
    dimension.outputField !== primaryDimension?.outputField
  ));
  const inferredBreakdown = BREAKDOWN_REQUIRED_CHART_TYPES.has(chartType)
    ? secondaryDimension
    : undefined;
  const inferredDisplayDimension = chartType === 'TIMELINE'
    ? (secondaryDimension ?? primaryDimension)
    : primaryDimension;
  const resolvedCurrentDimension = resolveSqlDimensionOutputField(
    outputColumns,
    parsedDimensions,
    normalizedCurrent.dimension,
  );
  const resolvedCurrentBreakdown = resolveSqlDimensionOutputField(
    outputColumns,
    parsedDimensions,
    normalizedCurrent.breakdown,
  );
  const resolvedCurrentTimeField = resolveSqlDimensionOutputField(
    outputColumns,
    parsedDimensions,
    normalizedCurrent.timeField,
  );
  const resolvedCurrentMetrics = dedupeMetrics(
    normalizedCurrent.metrics
      .map((metric) => resolveCurrentSqlMetric(columns, parsedMetrics, metric))
      .filter((metric): metric is MetricConfig => Boolean(metric)),
  );
  const resolvedCurrentLineMetric = resolveCurrentSqlMetric(
    columns,
    parsedMetrics,
    normalizedCurrent.lineMetric,
  );
  const resolvedCurrentBenchmarkMetric = resolveCurrentSqlMetric(
    columns,
    parsedMetrics,
    normalizedCurrent.benchmarkMetric,
  );
  const inferredTimeField = (chartType === 'TIME_SERIES' || chartType === 'TIMELINE' || chartType === 'RIBBON')
    ? (resolvedCurrentTimeField ?? primaryDimension?.outputField)
    : undefined;
  const inferredDimension = resolvedCurrentDimension ?? inferredDisplayDimension?.outputField;
  const inferredBreakdownField = resolvedCurrentBreakdown ?? inferredBreakdown?.outputField;
  const customRoleConfig: ChartRoleConfig = {
    ...(inferredDimension
      ? { dimension: inferredDimension }
      : {}),
    ...(inferredBreakdownField ? { breakdown: inferredBreakdownField } : {}),
    ...(inferredTimeField
      ? { timeField: inferredTimeField }
      : {}),
    ...(normalizedCurrent.scatterX && outputColumns.includes(normalizedCurrent.scatterX)
      ? { scatterX: normalizedCurrent.scatterX }
      : {}),
    ...(normalizedCurrent.scatterY && outputColumns.includes(normalizedCurrent.scatterY)
      ? { scatterY: normalizedCurrent.scatterY }
      : {}),
    ...(resolvedCurrentLineMetric ? { lineMetric: resolvedCurrentLineMetric } : {}),
    ...(resolvedCurrentBenchmarkMetric ? { benchmarkMetric: resolvedCurrentBenchmarkMetric } : {}),
    metrics: resolvedCurrentMetrics.length > 0
      ? resolvedCurrentMetrics
      : parsedMetrics.map(parsedMetricToConfig),
  };

  const canSyncGenerated = parsedMetrics.every((metric) => Boolean(metric.sourceField))
    && (!primaryDimension || Boolean(primaryDimension.sourceField))
    && (!inferredBreakdown || Boolean(inferredBreakdown.sourceField))
    && (!(chartType === 'TIMELINE' && secondaryDimension) || Boolean(secondaryDimension.sourceField));
  const generatedDimension = chartType === 'TIMELINE' && secondaryDimension
    ? secondaryDimension.sourceField
    : primaryDimension?.sourceField;
  const generatedBreakdown = inferredBreakdown?.sourceField;

  return {
    customRoleConfig,
    ...(canSyncGenerated
      ? {
          generatedRoleConfig: {
            ...(generatedDimension ? { dimension: generatedDimension as string } : {}),
            ...((chartType === 'TIME_SERIES' || chartType === 'TIMELINE' || chartType === 'RIBBON') && primaryDimension
              ? { timeField: primaryDimension.sourceField as string }
              : {}),
            ...(generatedBreakdown ? { breakdown: generatedBreakdown as string } : {}),
            metrics: parsedMetrics.map((metric) => ({
              field: metric.sourceField as string,
              agg: metric.agg,
            })),
          },
        }
      : {}),
  };
}

export function sqlHasExplicitRowLimit(sql: string): boolean {
  return TRAILING_ROW_LIMIT_PATTERN.test(normalizeSqlForLimitDetection(sql));
}

export function stripTrailingSqlLimit(sql: string): string {
  const normalized = normalizeSqlForLimitDetection(sql);
  return normalized.replace(TRAILING_ROW_LIMIT_PATTERN, '').trimEnd();
}

function inferColumnType(name: string, rows: Record<string, any>[], fallback = 'string'): string {
  const sample = rows
    .slice(0, 20)
    .map((row) => row?.[name])
    .filter((value) => value !== null && value !== undefined && value !== '');

  if (sample.length === 0) return fallback;

  if (sample.every((value) => typeof value === 'boolean')) return 'boolean';
  if (sample.every((value) => typeof value === 'number')) return 'number';

  const values = sample.map((value) => String(value).trim());
  if (values.every((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))) return 'date';
  if (values.every((value) => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value))) return 'datetime';
  return fallback;
}

export function buildExploreExecuteRequest(args: {
  chartType: ExploreChartType;
  roleConfig: ChartRoleConfig;
  filters: Filter[];
  limit: number;
}): ExecuteQueryRequest {
  const { chartType, roleConfig, filters, limit } = args;
  const normalized = normalizeRoleConfig(chartType, roleConfig);
  const xField = chartType === 'TIME_SERIES' || chartType === 'RIBBON'
    ? (normalized.timeField || normalized.dimension)
    : normalized.dimension;

  const request: ExecuteQueryRequest = {
    limit,
  };

  const filterPayload = filters
    .filter((filter) => filter.field?.trim())
    .map((filter) => ({
      field: filter.field,
      operator: filter.operator as ExecuteFilterCondition['operator'],
      value: normalizeFilterValue(filter),
    }));
  if (filterPayload.length > 0) {
    request.filters = filterPayload;
  }

  if (TABLE_LIKE_CHART_TYPES.has(chartType)) {
    if (isTablePivotConfig(normalized)) {
      const rowDimension = normalized.tableRowDimension as string;
      const columnDimension = normalized.tableColumnDimension as string;
      const pivotMetric = normalized.tablePivotMetric as MetricConfig;

      request.limit = buildTablePivotQueryLimit(limit);
      request.dimensions = Array.from(new Set([rowDimension, columnDimension]));
      request.measures = [{
        field: pivotMetric.field,
        function: pivotMetric.agg,
      }];
      request.order_by = [
        { field: rowDimension, direction: 'ASC' },
        ...(columnDimension !== rowDimension
          ? [{ field: columnDimension, direction: 'ASC' as const }]
          : []),
      ];
      return request;
    }

    const queryMetrics = buildChartQueryMetrics(chartType, normalized);
    const selectedMetricFields = new Set(queryMetrics.map((metric) => metric.field));

    if (normalized.selectedColumns && normalized.selectedColumns.length > 0) {
      const selectedColumnSet = new Set(normalized.selectedColumns);
      const tableDimensions = normalized.selectedColumns.filter((field) => !selectedMetricFields.has(field));
      const tableMeasures = queryMetrics.filter((metric) => selectedColumnSet.has(metric.field));

      if (tableDimensions.length > 0) {
        request.dimensions = tableDimensions;
      }
      if (tableMeasures.length > 0) {
        request.measures = tableMeasures.map((metric) => ({
          field: metric.field,
          function: metric.agg,
        }));
      }
    } else if (queryMetrics.length > 0) {
      request.measures = queryMetrics.map((metric) => ({
        field: metric.field,
        function: metric.agg,
      }));
    }
    return request;
  }

  if (SCATTER_LIKE_CHART_TYPES.has(chartType)) {
    request.dimensions = [normalized.scatterX, normalized.scatterY, normalized.dimension].filter(
      (field): field is string => Boolean(field),
    );
    const queryMetrics = buildChartQueryMetrics(chartType, normalized);
    if (queryMetrics.length > 0) {
      request.measures = queryMetrics.map((metric) => ({
        field: metric.field,
        function: metric.agg,
      }));
    }
    return request;
  }

  if (RAW_DISTRIBUTION_CHART_TYPES.has(chartType)) {
    const metricField = normalized.metrics[0]?.field;
    request.dimensions = [normalized.dimension, metricField].filter((field): field is string => Boolean(field));
    return request;
  }

  if (chartType === 'KPI' || chartType === 'GAUGE' || chartType === 'BULLET') {
    request.measures = buildChartQueryMetrics(chartType, normalized).map((metric) => ({
      field: metric.field,
      function: metric.agg,
    }));
    return request;
  }

  if (chartType === 'PODIUM') {
    if (normalized.dimension) {
      request.dimensions = [normalized.dimension];
    }
    request.measures = buildChartQueryMetrics(chartType, normalized).map((metric) => ({
      field: metric.field,
      function: metric.agg,
    }));
    return request;
  }

  if (chartType === 'TIMELINE') {
    request.dimensions = [normalized.timeField, normalized.dimension].filter(
      (field): field is string => Boolean(field),
    );
    const queryMetrics = buildChartQueryMetrics(chartType, normalized);
    if (queryMetrics.length > 0) {
      request.measures = queryMetrics.map((metric) => ({
        field: metric.field,
        function: metric.agg,
      }));
    }
    return request;
  }

  const dimensions = [xField];
  if (normalized.breakdown && chartType !== 'BAR_LINE') {
    dimensions.push(normalized.breakdown);
  }
  const uniqueDimensions = Array.from(new Set(dimensions.filter((field): field is string => Boolean(field))));
  if (uniqueDimensions.length > 0) {
    request.dimensions = uniqueDimensions;
  }

  const queryMetrics = buildChartQueryMetrics(chartType, normalized);
  if (queryMetrics.length > 0) {
    request.measures = queryMetrics.map((metric) => ({
      field: metric.field,
      function: metric.agg,
    }));
  }

  return request;
}

export function buildExploreSqlPreview(args: {
  table: DatasetTable | null | undefined;
  chartType: ExploreChartType;
  roleConfig: ChartRoleConfig;
  filters: Filter[];
  limit: number;
}): string {
  const { table, chartType, roleConfig, filters, limit } = args;
  if (!table) {
    return '-- Select a table to see SQL';
  }

  const request = buildExploreExecuteRequest({ chartType, roleConfig, filters, limit });
  const normalizedRoleConfig = normalizeRoleConfig(chartType, roleConfig);
  const sourceSql = (table.source_kind === 'sql_query' || table.source_kind === 'derived_table') && table.source_query
    ? `(\n${table.source_query.trim()}\n) AS source_table`
    : (table.source_table_name || table.display_name || 'table');

  const selectParts: string[] = [];
  for (const dimension of request.dimensions ?? []) {
    selectParts.push(`  ${dimension}`);
  }
  for (const measure of request.measures ?? []) {
    const agg = measure.function === 'count_distinct'
      ? `COUNT(DISTINCT ${measure.field})`
      : `${measure.function.toUpperCase()}(${measure.field})`;
    selectParts.push(`  ${agg} AS ${datasetMetricAlias({ field: measure.field, agg: measure.function as MetricConfig['agg'] })}`);
  }

  if (selectParts.length === 0) {
    selectParts.push('  *');
  }

  const whereParts = filters
    .map(formatSqlFilter)
    .filter((value): value is string => Boolean(value));

  const sqlLines = [
    `-- Explore query for "${table.display_name || table.source_table_name || 'table'}"`,
    ...(TABLE_LIKE_CHART_TYPES.has(chartType) && isTablePivotConfig(normalizedRoleConfig)
      ? [`-- Pivot mode fetches grouped cells for up to ${TABLE_PIVOT_COLUMN_LIMIT} dynamic columns.`]
      : []),
    `SELECT\n${selectParts.join(',\n')}`,
    `FROM ${sourceSql}`,
  ];

  if (whereParts.length > 0) {
    sqlLines.push(`WHERE ${whereParts.join('\n  AND ')}`);
  }
  if ((request.dimensions?.length ?? 0) > 0 && (request.measures?.length ?? 0) > 0) {
    sqlLines.push(`GROUP BY ${(request.dimensions ?? []).join(', ')}`);
  }
  if (request.order_by && request.order_by.length > 0) {
    sqlLines.push(
      `ORDER BY ${request.order_by.map((item) => `${item.field} ${item.direction}`).join(', ')}`,
    );
  }
  sqlLines.push(`LIMIT ${request.limit ?? limit}`);

  return sqlLines.join('\n');
}

export function inferQueryColumns(
  columns: Array<string | ColumnMetadata>,
  rows: Record<string, any>[],
): ColumnMetadata[] {
  return columns.map((column) => {
    if (typeof column === 'string') {
      return {
        name: column,
        type: inferColumnType(column, rows),
        nullable: true,
      };
    }
    return {
      ...column,
      type: column.type || inferColumnType(column.name, rows),
    };
  });
}

export function buildExploreChartResult(args: {
  rows: Record<string, any>[];
  columns: ColumnMetadata[];
  chartType: ExploreChartType;
  roleConfig: ChartRoleConfig;
  source: QuerySource;
}): {
  rows: Record<string, any>[];
  columns: ColumnMetadata[];
  preAggregated: boolean;
} {
  const { rows, columns, chartType, roleConfig, source } = args;
  const normalized = normalizeRoleConfig(chartType, roleConfig);

  if (TABLE_LIKE_CHART_TYPES.has(chartType) && isTablePivotConfig(normalized) && normalized.tablePivotMetric) {
    const pivotMetric = normalized.tablePivotMetric;
    const aliasMap = new Map<string, string>();
    for (const sourceKey of metricOutputKeys(pivotMetric)) {
      aliasMap.set(sourceKey, metricKey(pivotMetric));
    }

    const chartRows = rows.map((row) => {
      const nextRow = { ...row };
      for (const [sourceKey, targetKey] of aliasMap.entries()) {
        if (sourceKey in nextRow && targetKey !== sourceKey) {
          nextRow[targetKey] = nextRow[sourceKey];
        }
      }
      return nextRow;
    });

    const chartColumns = columns.map((column) => {
      const normalizedName = aliasMap.get(column.name);
      if (!normalizedName) return column;
      return {
        ...column,
        name: normalizedName,
        type: 'number',
      };
    });

    const rowKeys = new Set(Object.keys(chartRows[0] ?? {}));
    return {
      rows: chartRows,
      columns: chartColumns,
      preAggregated: source === 'generated' || rowKeys.has(metricKey(pivotMetric)),
    };
  }

  if (TABLE_LIKE_CHART_TYPES.has(chartType)) {
    const selectedColumns = normalized.selectedColumns ?? [];
    const metrics = buildChartQueryMetrics(chartType, normalized);
    const aliasMap = new Map<string, string>();

    for (const metric of metrics) {
      for (const sourceKey of metricOutputKeys(metric)) {
        aliasMap.set(sourceKey, metric.field);
      }
    }
    for (const column of selectedColumns) {
      if (!column.includes('.')) continue;
      const [, rawColumn] = column.split('.', 2);
      if (rawColumn) {
        aliasMap.set(rawColumn, column);
      }
    }

    if (aliasMap.size === 0) {
      return { rows, columns, preAggregated: false };
    }

    const chartRows = rows.map((row) => {
      const nextRow = { ...row };
      for (const [sourceKey, targetKey] of aliasMap.entries()) {
        if (sourceKey in nextRow && !(targetKey in nextRow)) {
          nextRow[targetKey] = nextRow[sourceKey];
        }
      }
      return nextRow;
    });

    const chartColumns = columns.map((column) => {
      const normalizedName = aliasMap.get(column.name);
      if (!normalizedName || columns.some((item) => item.name === normalizedName)) return column;
      return {
        ...column,
        name: normalizedName,
        type: metrics.some((metric) => metric.field === normalizedName) ? 'number' : column.type,
      };
    });

    return {
      rows: chartRows,
      columns: chartColumns,
      preAggregated: source === 'generated' && metrics.length > 0,
    };
  }

  if (!AGGREGATED_CHART_TYPES.has(chartType)) {
    return { rows, columns, preAggregated: false };
  }

  const metrics = buildChartQueryMetrics(chartType, normalized);
  if (metrics.length === 0) {
    return { rows, columns, preAggregated: false };
  }

  const aliasMap = new Map<string, string>();
  for (const metric of metrics) {
    for (const sourceKey of metricOutputKeys(metric)) {
      aliasMap.set(sourceKey, metricKey(metric));
    }
  }

  const chartRows = rows.map((row) => {
    const nextRow = { ...row };
    for (const [sourceKey, targetKey] of aliasMap.entries()) {
      if (sourceKey in nextRow && targetKey !== sourceKey) {
        nextRow[targetKey] = nextRow[sourceKey];
      }
    }
    return nextRow;
  });

  const chartColumns = columns.map((column) => {
    const normalizedName = aliasMap.get(column.name);
    if (!normalizedName) return column;
    return {
      ...column,
      name: normalizedName,
      type: 'number',
    };
  });

  if (source === 'generated') {
    return {
      rows: chartRows,
      columns: chartColumns,
      preAggregated: true,
    };
  }

  const rowKeys = new Set(Object.keys(chartRows[0] ?? {}));
  const hasMetricAliases = metrics.some((metric) => rowKeys.has(metricKey(metric)));

  return {
    rows: chartRows,
    columns: chartColumns,
    preAggregated: hasMetricAliases,
  };
}

export function buildQuerySignature(args: {
  datasetId: number | null;
  tableId: number | null;
  limit: number;
  sqlMode: QuerySource;
  chartType: ExploreChartType;
  roleConfig: ChartRoleConfig;
  filters: Filter[];
  request: ExecuteQueryRequest;
  customSql: string;
}): string {
  const { datasetId, tableId, limit, sqlMode, chartType, roleConfig, filters, request, customSql } = args;
  const normalizedRoleConfig = normalizeRoleConfig(chartType, roleConfig);
  const normalizedFilters = filters
    .filter((filter) => filter.field?.trim())
    .map((filter) => ({
      field: filter.field?.trim() ?? '',
      operator: filter.operator,
      value: normalizeFilterValue(filter),
    }));

  return JSON.stringify({
    datasetId,
    tableId,
    sqlMode,
    chartType,
    limit,
    request: sqlMode === 'generated' ? request : null,
    roleConfig: sqlMode === 'custom' ? normalizedRoleConfig : null,
    filters: sqlMode === 'custom' ? normalizedFilters : null,
    customSql: sqlMode === 'custom' ? customSql.trim() : '',
  });
}

export function normalizeExecuteResponseColumns(response: ExecuteQueryResponse): ColumnMetadata[] {
  return inferQueryColumns(response.columns, response.rows);
}
