import type { Filter } from '@/components/explore/FilterBuilder';
import {
  metricKey,
  normalizeRoleConfig,
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
  OrderBySpec,
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
  'KPI',
]);

const TRAILING_ROW_LIMIT_PATTERN = /(?:\blimit\s+\d+\s*(?:offset\s+\d+\s*)?|\boffset\s+\d+\s+limit\s+\d+\s*|\bfetch\s+first\s+\d+\s+rows?\s+only)\s*$/i;

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

function buildOrderBy(
  chartType: ExploreChartType,
  dimensionField: string | undefined,
  metrics: MetricConfig[],
): OrderBySpec[] {
  if (chartType === 'TIME_SERIES' && dimensionField) {
    return [{ field: dimensionField, direction: 'ASC' }];
  }
  if (AGGREGATED_CHART_TYPES.has(chartType) && metrics.length > 0) {
    return [{ field: datasetMetricAlias(metrics[0]), direction: 'DESC' }];
  }
  return [];
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
      if (start && end) return `${field} BETWEEN ${quoteSqlValue(start)} AND ${quoteSqlValue(end)}`;
      if (start) return `${field} >= ${quoteSqlValue(start)}`;
      if (end) return `${field} <= ${quoteSqlValue(end)}`;
      return null;
    }
    case 'in':
    case 'not_in': {
      const values = Array.isArray(value) ? value.filter((item) => item !== '') : [];
      if (values.length === 0) return null;
      const comparator = filter.operator === 'not_in' ? 'NOT IN' : 'IN';
      return `${field} ${comparator} (${values.map(quoteSqlValue).join(', ')})`;
    }
    case 'contains':
      return `${field} LIKE '%${String(value ?? '').replace(/'/g, "''")}%'`;
    case 'not_contains':
      return `${field} NOT LIKE '%${String(value ?? '').replace(/'/g, "''")}%'`;
    case 'starts_with':
      return `${field} LIKE '${String(value ?? '').replace(/'/g, "''")}%'`;
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
}): CustomSqlRoleInference {
  const { sql, chartType, columns } = args;
  const outputColumns = columns.map((column) => column.name);
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

  if (chartType === 'TABLE') {
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

  const primaryDimension = parsedDimensions[0];
  const customRoleConfig: ChartRoleConfig = {
    ...(primaryDimension ? { dimension: primaryDimension.outputField } : {}),
    ...(chartType === 'TIME_SERIES' && primaryDimension ? { timeField: primaryDimension.outputField } : {}),
    metrics: parsedMetrics.map((metric) => ({
      field: metric.sourceField ?? metric.outputField,
      agg: metric.agg,
      outputField: metric.outputField,
    })),
  };

  const canSyncGenerated = parsedMetrics.every((metric) => Boolean(metric.sourceField))
    && (!primaryDimension || Boolean(primaryDimension.sourceField));

  return {
    customRoleConfig,
    ...(canSyncGenerated
      ? {
          generatedRoleConfig: {
            ...(primaryDimension ? { dimension: primaryDimension.sourceField as string } : {}),
            ...(chartType === 'TIME_SERIES' && primaryDimension
              ? { timeField: primaryDimension.sourceField as string }
              : {}),
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
  const xField = chartType === 'TIME_SERIES'
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

  if (chartType === 'TABLE') {
    if (normalized.selectedColumns && normalized.selectedColumns.length > 0) {
      request.dimensions = normalized.selectedColumns;
    }
    return request;
  }

  if (chartType === 'SCATTER') {
    request.dimensions = [normalized.scatterX, normalized.scatterY, normalized.dimension].filter(
      (field): field is string => Boolean(field),
    );
    return request;
  }

  if (chartType === 'KPI') {
    request.measures = normalized.metrics.slice(0, 1).map((metric) => ({
      field: metric.field,
      function: metric.agg,
    }));
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

  const queryMetrics = dedupeMetrics(
    chartType === 'BAR_LINE' && normalized.lineMetric
      ? [...normalized.metrics, normalized.lineMetric]
      : [...normalized.metrics],
  );
  if (queryMetrics.length > 0) {
    request.measures = queryMetrics.map((metric) => ({
      field: metric.field,
      function: metric.agg,
    }));
  }

  const orderBy = buildOrderBy(chartType, xField, queryMetrics);
  if (orderBy.length > 0) {
    request.order_by = orderBy;
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
  const sourceSql = table.source_kind === 'sql_query' && table.source_query
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
  sqlLines.push(`LIMIT ${limit}`);

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

  if (!AGGREGATED_CHART_TYPES.has(chartType)) {
    return { rows, columns, preAggregated: false };
  }

  const metrics = dedupeMetrics(
    chartType === 'BAR_LINE' && normalized.lineMetric
      ? [...normalized.metrics, normalized.lineMetric]
      : [...normalized.metrics],
  );
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
  request: ExecuteQueryRequest;
  customSql: string;
}): string {
  const { datasetId, tableId, limit, sqlMode, request, customSql } = args;
  return JSON.stringify({
    datasetId,
    tableId,
    limit,
    sqlMode,
    request: sqlMode === 'generated' ? request : null,
    customSql: sqlMode === 'custom' ? customSql.trim() : '',
  });
}

export function normalizeExecuteResponseColumns(response: ExecuteQueryResponse): ColumnMetadata[] {
  return inferQueryColumns(response.columns, response.rows);
}
